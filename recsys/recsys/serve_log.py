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

SCOPE, stated plainly and CORRECTED 2026-08-05 (punch list #7 — the previous
version of this paragraph described a seam that does not exist and a behaviour
the service does not have):

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

`merge()` exists so a caller CAN persist and restore; wiring that up is
unstarted work, not a shipped capability.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping


class ExplorationServeLog:
    """Thread-safe count of exploration slots already served, per author.

    Deliberately tiny. It answers one question — "how many times has this author
    been given the reserved slot?" — and the only reason it is a class rather
    than a dict is that `rank_feed` may be called concurrently by the threaded
    HTTP server, and a lost increment is a free extra slot for whoever races.
    """

    def __init__(self, counts: Mapping[str, int] | None = None) -> None:
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
        """
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
        count."""
        with self._lock:
            self._counts.pop(author, None)
            self._seen.pop(author, None)
            self._window_start.pop(author, None)

    def __len__(self) -> int:
        with self._lock:
            return len(self._counts)


__all__ = ["ExplorationServeLog"]
