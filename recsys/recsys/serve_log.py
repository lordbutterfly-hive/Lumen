"""B1 — the exploration SERVING LOG: what the system has already given away.

★ WHY THIS EXISTS. Every bound on the reserved new-author slot was per-author or
per-feed, and the lane's PRIORITY key was "how many distinct engagers has this
author received" — a number the attacker controls **by not acting**. An account
that never engages and is never engaged sits in need-band 0 permanently, and
band 0 is the exclusive top band. Measured before this landed
(`measurement-harness/attacks/exploration_capture.py`): 20 sock accounts that
each posted once and did nothing else took **100% of every served exploration
slot** on three seeds, while honest newcomers took 0%.

The fix is not another threshold on attacker-supplied data. It is to count the
one thing in this lane the attacker cannot write, decline or fake: **that the
system already served them**. A serve is an observation, not an input.

That turns a free permanent position into a consumable — an identity is worth
`ExplorationConfig.max_serves_per_author` slots and no more, so holding the lane
costs a fresh account per few slots instead of costing nothing. It also makes
the lane self-limiting for honest authors, which is the same mechanism read
kindly: three page-one placements that produce no engagement mean this post is
not connecting, and the slot does more good elsewhere.

SCOPE, stated plainly and CORRECTED TWICE. The 2026-08-05 correction (punch
list #7) is kept verbatim below because it is the record of what was true until
today; the 2026-08-15 change is stated first because it is what is true now.

★★★ 2026-08-15 — THIS LOG IS NOW OPTIONALLY DURABLE, AND THE SWITCH IS OFF BY
DEFAULT.

Supply a `store` (or set `RECSYS_EXPLORATION_SERVE_PERSIST=1` with a DSN — see
`recsys.serve_log_store`) and the three maps below are loaded at construction,
written through on every `record()`/`clear()`, and re-read from the shared table
on a timer. A restart no longer forgets counts and two replicas share one
budget. **With no store — the default — every line below behaves exactly as it
did, byte for byte, and not one query is issued.**

Why this had to land before anything else in the new-author build: the standing
feed-balance ruling (2026-08-08 §3/§4/§7) names the in-process log as blocker 2
of 3 and fixes the order — newness predicate, then persist the serve log, then
the seat may move. The newness predicate cleared on 2026-08-08.

What it deliberately does NOT change: a serve is still charged when a feed is
BUILT, not when a page is DELIVERED. See `recsys.serve_log_store`'s header for
why the obvious delivery-truth substitute (`lumen_feed_served` rows with
`source = 'exploration'`) is measurably wrong today, and `pipeline.rank_feed`'s
`served_depth` / `record_serves` parameters for the two bounds that narrow the
gap.

(2026-08-05, still true whenever no store is configured:)

* This is an IN-PROCESS counter. `counts()` reads it and `merge()` folds a
  persisted map back in — there is no `snapshot()` method, and nothing in the
  service persists this log at all. Both halves of the old claim were false.
* A restart therefore forgets every count. That fails OPEN (authors become
  eligible again), which is the correct direction for a discovery lane, but it
  is an amnesty rather than a design.
* **Two instances behind a load balancer do not share it**, so the effective
  budget is `max_serves_per_author * replicas` — 3 per author becomes 6 on two
  pods. Stated here because an operator scaling out will not otherwise know
  that scaling changes a ranking bound.

`merge()` exists so a caller CAN persist and restore. ★ It is NOT what the
durable store uses, and the reason is worth stating where the promise was made:
`merge()` carries COUNTS ONLY, so a restore through it reloads every author with
`_seen = 0` and no `_window_start` — which re-creates design #1 in
:meth:`ExplorationServeLog.graduated` (graduation firing for anyone who has any
engagement at all; measured at one author taking 288 of 300 slots) and pins
every reloaded author inside a budget window that never elapses. Durability
needs all three maps, so the store round-trips all three. `merge()` is kept,
unchanged, as the public "fold in a count map" seam.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Mapping
from typing import Any

from recsys.serve_log_store import ServeLogStore, store_from_env

logger = logging.getLogger(__name__)

#: ★ Sentinel default for the `store` keyword, so that an EXPLICIT `store=None`
#: still means "no durability, ever" (every unit test, every measurement panel,
#: every harness attack) while the un-passed default can resolve the deployed
#: configuration. Without the sentinel those two states are indistinguishable
#: and a test would silently start writing to whatever DSN the environment
#: happens to carry.
_FROM_ENV: Any = object()


class ExplorationServeLog:
    """Thread-safe count of exploration slots already served, per author.

    Deliberately tiny. It answers one question — "how many times has this author
    been given the reserved slot?" — and the only reason it is a class rather
    than a dict is that `rank_feed` may be called concurrently by the threaded
    HTTP server, and a lost increment is a free extra slot for whoever races.
    """

    def __init__(
        self,
        counts: Mapping[str, int] | None = None,
        *,
        store: ServeLogStore | None | Any = _FROM_ENV,
        reload_interval_s: float = 60.0,
    ) -> None:
        self._lock = threading.Lock()
        self._counts: dict[str, int] = dict(counts or {})
        #: Epoch seconds at which each author's CURRENT budget window opened.
        #: Absent = no window recorded yet (an author restored from a persisted
        #: count, or one that has never been served under a windowed config);
        #: such an author is treated as being inside their window, which fails
        #: SHUT for the budget and is the safe direction.
        self._window_start: dict[str, float] = {}
        #: Engager count observed for an author at their LAST serve. The basis
        #: for graduation (see :meth:`graduated`), and the reason this class
        #: needed state beyond a counter — see that method for the three failed
        #: attempts that led here.
        self._seen: dict[str, int] = {}
        #: ★ THE DURABLE STORE, or None for the historic in-process behaviour.
        self._store: ServeLogStore | None = (
            store_from_env() if store is _FROM_ENV else store
        )
        self._reload_interval_s = reload_interval_s
        self._last_reload = 0.0
        #: Authors whose write-through FAILED. A reload must not silently lower
        #: their count back to whatever the store last managed to persist — that
        #: would hand a free extra slot to whoever was being served while the
        #: store was down, i.e. it would fail OPEN on exactly the counter whose
        #: whole job is to fail SHUT. They are carried at the higher of the two
        #: values until a write succeeds.
        self._unsynced: set[str] = set()
        #: One-shot guard for the retention/window consistency check below.
        self._window_checked = False
        if self._store is not None:
            # Load BEFORE the first request. Failure here is not fatal: `_reload`
            # keeps whatever is in memory (nothing, at construction) and logs,
            # which reproduces exactly the pre-2026-08-15 amnesty for as long as
            # the store is unreachable.
            self._reload(force=True)
            # ★ A reload REPLACES the three maps with durable truth, so any
            # counts handed to the constructor would be silently discarded.
            # Folded back in with `merge`'s rule — MAX, never lower — because a
            # caller who seeded a count meant it. Deliberately NOT written
            # through: seeding is a test/harness convenience, and persisting it
            # would mass-charge authors nobody served.
            if counts:
                self.merge(counts)
            logger.info(
                "exploration serve log: DURABLE store attached — loaded %d "
                "author budget(s). A restart no longer resets this counter and "
                "replicas share one budget.",
                len(self._counts),
            )

    # -- durability ---------------------------------------------------------

    def _reload(self, *, force: bool = False) -> None:
        """Re-read the shared table, if one is configured and it is time.

        ★ NEVER holds `self._lock` across the query. The store has its own lock
        and its own statement timeout; holding the log's lock across a network
        round trip would serialise every concurrent `rank_feed` behind the
        slowest replica of the database, on the ranking path.
        """
        store = self._store
        if store is None:
            return
        clock = time.monotonic()
        if not force and clock - self._last_reload < self._reload_interval_s:
            return
        rows = store.load()
        self._last_reload = time.monotonic()
        if rows is None:
            # Unreachable. Keep memory — a `None` answer must never be allowed
            # to erase counts (see `ServeLogStore.load`'s own note on the
            # difference between `None` and `{}`).
            return
        with self._lock:
            counts = {author: row.count for author, row in rows.items()}
            window = {
                author: row.window_start
                for author, row in rows.items()
                if row.window_start is not None
            }
            seen = {author: row.seen for author, row in rows.items()}
            for author in self._unsynced:
                local = self._counts.get(author)
                if local is None:
                    continue
                counts[author] = max(counts.get(author, 0), local)
                if author in self._window_start:
                    window.setdefault(author, self._window_start[author])
                seen.setdefault(author, self._seen.get(author, 0))
            self._counts = counts
            self._window_start = window
            self._seen = seen

    def _check_window_covers(self, window_s: float) -> None:
        """A retention shorter than the budget window is a SILENT AMNESTY.

        The store prunes rows older than its retention; the budget forgives an
        author once their window elapses. If retention < window, a row is
        deleted while the author is still supposed to be spent, and the budget
        resets early — which looks exactly like the in-process amnesty this
        whole change exists to end, except now it looks configured. Checked once
        and logged at ERROR rather than raised, because refusing to start over a
        retention setting would take the feed down for a durability problem.
        """
        if self._window_checked or self._store is None:
            return
        self._window_checked = True
        if window_s > 0 and window_s > self._store.retention_s:
            logger.error(
                "exploration serve log: RETENTION (%.1f days) IS SHORTER THAN "
                "THE BUDGET WINDOW (%.1f days) — rows are pruned while the "
                "authors they retire are still supposed to be spent, so the "
                "budget refills early and the durability is cosmetic. Raise "
                "RECSYS_SERVE_LOG_RETENTION_DAYS above "
                "ExplorationConfig.serve_window_days.",
                self._store.retention_s / 86400.0,
                window_s / 86400.0,
            )

    def record(
        self,
        authors: object,
        engagers: Mapping[str, int] | None = None,
        *,
        now: float | None = None,
        window_s: float = 0.0,
    ) -> None:
        """Count one served exploration slot for each author in ``authors``.

        Called with the authors actually SPLICED into a served feed — never with
        the candidates that merely qualified. The distinction is the whole point:
        a log of who was *eligible* would be as attacker-controllable as the
        need bands it replaces, because eligibility is a function of the
        attacker's own posting. Only placement is an observation.
        """
        names = list(authors)  # type: ignore[call-overload]
        if not names:
            return
        observed = dict(engagers or {})
        self._check_window_covers(window_s)
        with self._lock:
            for author in names:
                # ★★★ THE REFILL. With `window_s > 0` a budget is spent within a
                # ROLLING WINDOW rather than for the lifetime of the process: an
                # author whose window has elapsed starts a fresh one at 1 rather
                # than accumulating forever. `window_s = 0` keeps the lifetime
                # behaviour byte-for-byte, so this is opt-in and reversible.
                if window_s > 0 and now is not None:
                    started = self._window_start.get(author)
                    if started is None or now - started >= window_s:
                        self._counts[author] = 1
                        self._window_start[author] = now
                        self._seen[author] = observed.get(author, 0)
                        continue
                self._counts[author] = self._counts.get(author, 0) + 1
                # Baseline for graduation: what this author had WHEN the slot
                # was spent. Without it, "has engagement" and "earned something
                # since we last helped them" are indistinguishable.
                self._seen[author] = observed.get(author, 0)
        # ★★★ WRITE-THROUGH, AND THE DATABASE'S ANSWER WINS.
        #
        # The local computation above already ran and is the fallback: if the
        # store is unreachable this method has behaved exactly as it did before
        # durability existed, which is the fail-OPEN direction the lane has
        # always taken. When the store DOES answer, its value replaces the local
        # one, because the refill decision is made in SQL against the row every
        # replica shares — see `serve_log_store.SQL_RECORD`. Computing the new
        # count locally and writing it back would be a lost update across
        # replicas, and a lost update on this counter is a free extra slot for
        # whoever races.
        #
        # Outside the lock deliberately: this is a network round trip and the
        # log's lock is on the ranking path.
        if self._store is not None:
            for author in names:
                row = self._store.record(
                    author,
                    seen=observed.get(author, 0),
                    now=now,
                    window_s=window_s,
                )
                with self._lock:
                    if row is None:
                        self._unsynced.add(author)
                        continue
                    self._unsynced.discard(author)
                    self._counts[author] = row.count
                    if row.window_start is None:
                        self._window_start.pop(author, None)
                    else:
                        self._window_start[author] = row.window_start
                    self._seen[author] = row.seen

    def counts(self, *, now: float | None = None, window_s: float = 0.0) -> dict[str, int]:
        """A stable copy, safe to read while other threads record.

        ★ With a window configured, this reports the EFFECTIVE budget: an author
        whose window has already elapsed reads as 0, because their next serve
        will open a fresh window. The eligibility filter consumes this, so the
        expiry has to be visible HERE — a count that only resets on the next
        `record()` would keep an author retired right up until the moment they
        are served, which is never, because being retired is what stops them
        being served. (That circularity is the same shape as the two catch-22s
        `graduated` documents; it is called out because it is easy to re-create.)

        ★ This is also the ONE read `rank_feed` takes per request, so it is where
        the durable store is re-read (at most once per `reload_interval_s`).
        Putting the refresh anywhere else would either miss the request path or
        add a second round trip to it.
        """
        self._reload()
        with self._lock:
            if window_s <= 0 or now is None:
                return dict(self._counts)
            return {
                author: (
                    0
                    if (start := self._window_start.get(author)) is not None
                    and now - start >= window_s
                    else count
                )
                for author, count in self._counts.items()
            }

    def merge(self, counts: Mapping[str, int]) -> None:
        """Fold persisted counts in, taking the MAXIMUM per author.

        Max rather than sum: a reload must never double-count slots this process
        already recorded, and must never lower a count either. Summing on every
        restart would retire authors that were served once; overwriting would
        discard in-flight counts. Max is the only combination that is safe in
        both directions.
        """
        with self._lock:
            for author, value in counts.items():
                self._counts[author] = max(self._counts.get(author, 0), int(value))

    def graduated(self, engagers_now: Mapping[str, int]) -> list[str]:
        """Authors whose engagement has GROWN since their last served slot.

        ★★★ THE THIRD DESIGN, and the first two are recorded because each looked
        obviously right and each was a regression (round-3 and round-4
        councils):

        1. **Clear on "has engagement", every request.** Not graduation — a
           per-request RESET. An author with one chain vote had their count
           popped before it could reach the cap, so serves tracked REQUESTS
           without bound: one author took 288 of 300 slots, re-creating the
           one-author concentration that `max_serves_per_author = 0` was
           rejected for.
        2. **Clear on "has engagement AND is not in the exploration pool".** An
           author AT THE CAP is filtered out of that pool BY THE CAP, so the
           condition was always true for exactly the population the guard exists
           to hold — budget 3 -> 0 on the very next request, and the lane went
           back to 100% farm capture for one Hive account and twenty comments.

        Both failed the same way: they keyed on the EXISTENCE of engagement.
        What graduation actually means is engagement that is NEW since the
        budget was spent — so the log remembers what the author had at their
        last serve and compares. An author sitting at the cap with static
        engagement stays capped; an author who has genuinely been heard since
        gets their budget back.

        Only authors who have actually spent slots are considered: an author
        with no budget has nothing to graduate from.
        """
        with self._lock:
            return [
                author
                for author, count in engagers_now.items()
                if author in self._counts and count > self._seen.get(author, 0)
            ]

    def clear(self, author: str) -> None:
        """Forget one author — used when they leave the lane by earning
        engagement, so a later dry spell does not start them at their old
        count.

        ★ Write-through too, and it has to be: a graduation that only cleared
        the local dict would be undone by the next reload, silently re-retiring
        an author who had earned their budget back. If the DELETE fails the row
        survives, the next reload restores the count, `graduated()` fires again
        on the same (still-grown) engagement and this retries — self-healing in
        the fail-SHUT direction, which is the right one for a budget.
        """
        with self._lock:
            self._counts.pop(author, None)
            self._seen.pop(author, None)
            self._window_start.pop(author, None)
            self._unsynced.discard(author)
        if self._store is not None:
            self._store.delete(author)

    def __len__(self) -> int:
        with self._lock:
            return len(self._counts)


__all__ = ["ExplorationServeLog"]
