"""B1-P — DURABLE, CROSS-REPLICA PERSISTENCE FOR THE EXPLORATION SERVE LOG.

★★★ WHY THIS EXISTS, AND WHY IT IS A BLOCKER RATHER THAN A NICETY.

`recsys.serve_log.ExplorationServeLog` is the ONLY bound on the reserved
new-author seat that is keyed on something an attacker cannot write, decline or
fake — "the system already served you". It was an in-process dict, so in
practice it read:

  * **a restart is a total amnesty** — every serve count in the system returns
    to zero on deploy, and the deployed lane is the LEAST-gated source in the
    package (`requires_second_degree` False AND `requires_author_floor` False);
  * **replicas do not share it** — the effective budget is
    `max_serves_per_author * replicas`, so scaling out silently changes a
    ranking bound;
  * `merge()` existed "so a caller CAN persist and restore" and **nothing ever
    called it** (`serve_log.py`'s own scope note: "wiring that up is unstarted
    work, not a shipped capability").

That is blocker 2 of the standing feed-balance ruling
(`/mnt/o/LUMEN-DOCS/FEED-BALANCE-RULING-2026-08-08.md` §3/§4/§7 — *"no newcomer
increase until the serve log is persisted"*, upheld), and the ruling fixes the
ORDER of work: newness predicate -> persist the serve log -> only then may the
seat move. The newness predicate landed 2026-08-08
(`ExplorationConfig.max_author_age_days`). This module is the second step.

WHERE IT PERSISTS, AND WHY THERE. The lite Postgres — the datastore recsys
already holds a configured DSN for (`LUMEN_LITE_DATABASE_URL`, read by
`LiteConfig.from_env`, used by `recsys.io.lite_engagement`). No new credential,
no new host, no new failure domain. `RECSYS_SERVE_LOG_DSN` overrides it for an
operator who would rather keep this next to the trust snapshot in the `recsys`
database; the SQL is portable between them because the table is created here
rather than in either schema file.

★★★ WHAT THIS IS **NOT**, STATED UP FRONT SO NOBODY READS MORE INTO IT.

This makes the EXISTING counter durable. It does **not** move the counter to
serve time. recsys charges a serve when a feed is BUILT
(`pipeline.rank_feed`); the reader-facing truth is the frontend's
`lumen_feed_served`, which is written on DELIVERY and whose own header explains
why that is the only correct choice. Those are different events and this module
does not reconcile them — see `pipeline.rank_feed`'s `served_depth` /
`record_serves` parameters for the two bounds that narrow the gap, and the
residual recorded there.

And the obvious-looking shortcut — "just count `lumen_feed_served` rows with
`source = 'exploration'` per author" — is WRONG TODAY, measured, not
theorised. That table is an IMPRESSION log driven by the client's silent
3-minute poll: read-only on 2026-08-15 it holds 78 exploration rows for
`bungadahlia` from **2 viewers and 2 posts**, and one post/viewer pair at 66
impressions in exactly 24 hours. Charging a 3-per-7-days author budget off that
counter retires every newcomer in about nine minutes of an idle browser tab.
The poll must stop recording serves first (that fix lives in the frontend); only
then is delivery-truth a safe input to this budget.

DEGRADE. Every method here fails SOFT and says so at WARNING: an unreachable
store costs durability, never a feed request. That direction is deliberate and
matches what the log did before this module existed — an amnesty rather than a
refusal — and it is the same posture `recsys.io.lite_engagement` and A15
network-suppression take for their own optional connections.

`psycopg` is imported lazily inside `_connect`, matching `recsys.io.hafsql` and
`recsys.io.lite_engagement`, so importing this module never requires the `io`
extra.
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: ★ The flag. OFF by default, and the whole module is inert while it is off:
#: `store_from_env()` returns None, `ExplorationServeLog` keeps exactly the
#: in-process behaviour it had, and not one query is issued. Turning it on is a
#: deploy-time decision, which is where a change to a ranking bound belongs.
ENABLE_ENV = "RECSYS_EXPLORATION_SERVE_PERSIST"
#: Optional override. Absent, the lite DSN below is used.
DSN_ENV = "RECSYS_SERVE_LOG_DSN"
#: The DSN recsys is already configured with (`.env.local`, `LiteConfig.from_env`).
LITE_DSN_ENV = "LUMEN_LITE_DATABASE_URL"

#: ★ Same shape and the same reasoning as `lite_engagement`'s: a secondary
#: signal store must never be able to spend a feed request's whole budget, and
#: `statement_timeout = 0` means NO LIMIT in PostgreSQL, so a zero is refused
#: rather than silently disabling the protection.
_STATEMENT_TIMEOUT_MS = int(os.environ.get("RECSYS_SERVE_LOG_STATEMENT_TIMEOUT_MS", "2000"))
_CONNECT_TIMEOUT_S = int(os.environ.get("RECSYS_SERVE_LOG_CONNECT_TIMEOUT_S", "3"))
#: How often a process re-reads the shared table. This is the cross-replica
#: convergence time: replica A's serve is invisible to replica B for at most
#: this long. 60s against a 7-day budget window is noise, and it costs one
#: indexed full-table read per minute per process on a table with roughly one
#: row per newcomer ever served.
_RELOAD_INTERVAL_S = float(os.environ.get("RECSYS_SERVE_LOG_RELOAD_S", "60"))
#: Rows older than this are dead weight and are pruned. MUST exceed
#: `ExplorationConfig.serve_window_days` — a retention shorter than the budget
#: window is a silent amnesty, which is the exact defect this module exists to
#: close, so `ExplorationServeLog` checks the two against each other at its
#: first `record()` and logs an ERROR if they disagree.
_RETENTION_DAYS = float(os.environ.get("RECSYS_SERVE_LOG_RETENTION_DAYS", "30"))
_PRUNE_INTERVAL_S = 3600.0

#: Consecutive failures before the breaker opens, and how long it stays open.
#: Small and short for the same reason `lite_engagement` gives: this degrades to
#: "no durability", which is a real cost, so it should retry soon — but not on
#: every request while the store is down.
_BREAKER_THRESHOLD = 3
_BREAKER_COOLDOWN_S = 30.0


@dataclass(frozen=True)
class ServeRow:
    """One author's durable budget state.

    All THREE fields are persisted, not just the count, and that is not
    incidental. `ExplorationServeLog` keeps three maps and every one of them is
    load-bearing:

    * ``count`` — the budget itself;
    * ``window_start`` — the REFILL (`ExplorationConfig.serve_window_days`);
      without it a reloaded author is treated as being inside a window that
      never elapses, which fails SHUT and exiles them;
    * ``seen`` — the engager count observed at the author's LAST serve, which is
      the entire basis of `ExplorationServeLog.graduated`. Persisting only the
      count (which is all `merge()` can carry) would reload every author with
      ``seen = 0``, and graduation would then fire for anyone with a single
      engager — re-creating design #1 in `graduated`'s own docstring, the one
      that measured **one author taking 288 of 300 slots**.

    So `merge()` is NOT sufficient for this job even though it was built for it.
    It is kept, unchanged, as the public "fold in a count map" seam.
    """

    author: str
    count: int
    window_start: float | None
    seen: int


class ServeLogStore(Protocol):
    """The seam `ExplorationServeLog` writes through to.

    Deliberately four methods and no transactions: every mutation this log makes
    is a single-row upsert or delete that is already atomic on its own, so the
    store needs no notion of a unit of work. `tests/test_serve_log_store.py`
    implements this Protocol in memory to prove the restart contract without a
    database, and `PostgresServeLogStore` is the shipped implementation.
    """

    @property
    def retention_s(self) -> float:
        """How far back `load` will look. Compared against the budget window."""

    def load(self) -> dict[str, ServeRow] | None:
        """Every live row, or ``None`` when the store is unreachable.

        ``None`` and ``{}`` mean different things and callers rely on it:
        ``{}`` is "durable state says nobody has been served", ``None`` is "no
        answer" — which must never be allowed to erase in-memory counts.
        """

    def record(
        self, author: str, *, seen: int, now: float | None, window_s: float
    ) -> ServeRow | None:
        """Charge one serve, applying the refill rule INSIDE the store.

        The decision (start a fresh window at 1, or increment) is made in SQL
        rather than in Python precisely because two replicas may charge the same
        author at the same moment: computing the new value locally and writing
        it back is a lost update, and a lost update on this counter is a free
        extra slot for whoever races — the same hazard the in-process log's own
        `threading.Lock` exists for, one level up.
        """

    def delete(self, author: str) -> None:
        """Forget one author — graduation (`ExplorationServeLog.clear`)."""


def store_from_env() -> ServeLogStore | None:
    """Resolve the durable store from the environment, or ``None``.

    ★ WHY THE ENVIRONMENT AND NOT A CONSTRUCTOR ARGUMENT. The one production
    `ExplorationServeLog` is built by
    ``ServiceState.serve_log: ExplorationServeLog = field(default_factory=ExplorationServeLog)``
    in ``recsys/service/app.py`` — a file this change does not own. A store that
    can only arrive by dependency injection would therefore be BUILT AND
    UNREACHABLE in the deployed service, which is the single most-repeated
    defect in this package's history (`from_env` itself "was built and tested,
    and for a while NOTHING CALLED IT", `service/app.py`'s own note; the lineage
    cap "built and inert"; `emerging_per_page` "measured identical at every
    value"; L2 "silently inert in production with a green test suite"). Reading
    the flag here makes the capability reachable with no edit outside this
    change's ownership.

    ★ THE ONE-LINE ALTERNATIVE, for whoever owns ``service/app.py``: replace the
    ``default_factory`` above with
    ``lambda: ExplorationServeLog(store=store_from_env())`` and drop the env
    resolution from `ExplorationServeLog.__init__`. That is strictly cleaner and
    this module supports it unchanged — `store_from_env` is public for exactly
    that reason.

    Misconfiguration is LOUD. A flag that is on with no DSN behind it returns
    ``None`` at ERROR rather than degrading quietly, because "persistence is on"
    and "persistence is silently off" produce identical feeds and only one of
    them is what the operator asked for.
    """
    raw = os.environ.get(ENABLE_ENV, "").strip().lower()
    if raw not in {"1", "true", "yes", "on"}:
        return None
    dsn = os.environ.get(DSN_ENV) or os.environ.get(LITE_DSN_ENV)
    if not dsn:
        logger.error(
            "exploration serve log: %s is ON but neither %s nor %s is set, so "
            "serve counts stay IN-PROCESS — a restart is still a total amnesty "
            "and replicas still do not share the budget. Set a DSN or unset the "
            "flag; this is not a state to run in.",
            ENABLE_ENV,
            DSN_ENV,
            LITE_DSN_ENV,
        )
        return None
    if _STATEMENT_TIMEOUT_MS <= 0:
        # Refuse at resolution rather than discover it under load — PostgreSQL
        # treats 0 as NO LIMIT, so a typo here removes the protection while
        # reading like a configured value. Same rule, same wording, as
        # `lite_engagement`'s own guard.
        raise ValueError(
            "RECSYS_SERVE_LOG_STATEMENT_TIMEOUT_MS must be > 0 — PostgreSQL "
            "treats 0 as NO LIMIT, which disables the protection entirely. Got "
            f"{_STATEMENT_TIMEOUT_MS}."
        )
    return PostgresServeLogStore(dsn)


# ---------------------------------------------------------------------------
# The shipped SQL.
#
# ★★★ THESE CONSTANTS ARE THE ONES THE STORE EXECUTES — never a copy. This
# package has shipped SQL that had never touched a database FOUR separate times
# (`lite_engagement`'s own header records the fourth), every time because the
# tests monkeypatched the connection. `tests/test_serve_log_store.py::
# test_the_shipped_sql_executes_against_a_real_postgres` runs THESE NAMES
# against a real server and skips when one is not configured.
#
# ★ EXECUTED 2026-08-15 against PostgreSQL 16 (`lumen-b12-pg`, database `lite`)
# with the table created as a SESSION-TEMP one, so nothing durable was created
# and no existing row was touched (`lumen_feed_served` verified unchanged at
# 8,508 rows afterwards). All six refill scenarios returned the values the
# Python reference returns, including the two that carry the type-inference
# risk: a NULL clock, and lifetime mode leaving `window_start` NULL. What that
# run did NOT cover is the connection path below — the permanent
# `CREATE TABLE IF NOT EXISTS`, the statement timeout, the breaker — which is
# what `RECSYS_SERVE_LOG_TEST_DSN` is for.
# ---------------------------------------------------------------------------

#: Created by the store itself rather than by a migration, deliberately: the
#: table lives in a database owned by the frontend's migration chain
#: (`lumen_feed_served` is migration 0027 there), and recsys must not write into
#: someone else's migration sequence. `IF NOT EXISTS` makes startup idempotent
#: and lets the same code run against the `recsys` database instead if an
#: operator points `RECSYS_SERVE_LOG_DSN` there.
SQL_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS recsys_exploration_serve (
    author        text             PRIMARY KEY,
    serve_count   integer          NOT NULL,
    window_start  double precision,
    seen_engagers integer          NOT NULL,
    updated_at    timestamptz      NOT NULL DEFAULT now()
)
"""

#: Prune reads this index; so does nothing else. One row per newcomer ever
#: served (~14.5 true debuts/day chain-measured), so the table is small — the
#: index is here so the prune below never degrades into a seq scan as it grows.
SQL_CREATE_INDEX = """
CREATE INDEX IF NOT EXISTS recsys_exploration_serve_updated_at
    ON recsys_exploration_serve (updated_at)
"""

#: ★ EVERY PLACEHOLDER CARRIES AN EXPLICIT CAST, HERE AND BELOW. psycopg sends
#: parameters with an unspecified type OID and lets PostgreSQL infer, and the
#: inference has nowhere to look for `%(now)s IS NOT NULL` or for a `NULL` in a
#: `CASE ... ELSE` — the failure mode is `could not determine data type of
#: parameter $n` at BIND time, which this package's broad `except` handlers turn
#: into a WARNING on every request forever (exactly how L2 shipped silently
#: inert with a green suite). Casting removes the inference question entirely.
SQL_LOAD = """
SELECT author, serve_count, window_start, seen_engagers
FROM recsys_exploration_serve
WHERE updated_at >= now() - make_interval(secs => %(retention_s)s::double precision)
"""

#: ★★★ THE REFILL RULE, TRANSCRIBED FROM `ExplorationServeLog.record` LINE FOR
#: LINE. The Python is:
#:
#:     if window_s > 0 and now is not None:
#:         started = self._window_start.get(author)
#:         if started is None or now - started >= window_s:
#:             count = 1; window_start = now; seen = observed; continue
#:     count += 1; seen = observed
#:
#: so the SQL must reproduce all three conditions — `window_s > 0`, `now IS NOT
#: NULL`, and `started IS NULL OR now - started >= window_s` — and must leave
#: `window_start` NULL on a lifetime-mode insert. That last detail is not
#: cosmetic: the in-process log never records a window start while
#: `serve_window_days = 0`, so writing `now` there would make a later config
#: change to a windowed budget read an author as being INSIDE a window that
#: began in the lifetime era, incrementing where the in-process log would have
#: reset to 1.
#:
#: RETURNING is what makes this cross-replica-correct: the caller adopts the
#: value the DATABASE decided, so a serve charged by another replica between
#: this process's last reload and now is picked up immediately instead of being
#: overwritten with a stale local increment.
SQL_RECORD = """
INSERT INTO recsys_exploration_serve
    (author, serve_count, window_start, seen_engagers, updated_at)
VALUES (
    %(author)s::text,
    1,
    CASE
        WHEN %(window_s)s::double precision > 0 AND %(now)s::double precision IS NOT NULL
        THEN %(now)s::double precision
        ELSE NULL::double precision
    END,
    %(seen)s::integer,
    now()
)
ON CONFLICT (author) DO UPDATE SET
    serve_count = CASE
        WHEN %(window_s)s::double precision > 0
             AND %(now)s::double precision IS NOT NULL
             AND (recsys_exploration_serve.window_start IS NULL
                  OR %(now)s::double precision - recsys_exploration_serve.window_start
                     >= %(window_s)s::double precision)
        THEN 1
        ELSE recsys_exploration_serve.serve_count + 1
    END,
    window_start = CASE
        WHEN %(window_s)s::double precision > 0
             AND %(now)s::double precision IS NOT NULL
             AND (recsys_exploration_serve.window_start IS NULL
                  OR %(now)s::double precision - recsys_exploration_serve.window_start
                     >= %(window_s)s::double precision)
        THEN %(now)s::double precision
        ELSE recsys_exploration_serve.window_start
    END,
    seen_engagers = %(seen)s::integer,
    updated_at = now()
RETURNING serve_count, window_start, seen_engagers
"""

SQL_DELETE = "DELETE FROM recsys_exploration_serve WHERE author = %(author)s::text"

SQL_PRUNE = """
DELETE FROM recsys_exploration_serve
WHERE updated_at < now() - make_interval(secs => %(retention_s)s::double precision)
"""


class PostgresServeLogStore:
    """One long-lived connection, one lock, a breaker, and four statements.

    ★ WHY A HELD CONNECTION AND NOT ONE PER CALL. `lite_engagement` opens a
    fresh connection per call and its own punch-list note (#5, 2026-08-05)
    records what that cost: ~6s added per request when the store is slow. This
    one sits on the ranking path too — `record` runs inside `rank_feed` — so it
    holds a single autocommit connection behind a lock and reconnects only after
    a failure. Concurrency is not a concern: the whole per-request workload is
    at most three single-row upserts, and `rank_feed` already serialises them
    behind `ExplorationServeLog`'s own lock.
    """

    def __init__(
        self,
        dsn: str,
        *,
        retention_days: float = _RETENTION_DAYS,
        statement_timeout_ms: int = _STATEMENT_TIMEOUT_MS,
        connect_timeout_s: int = _CONNECT_TIMEOUT_S,
    ) -> None:
        if retention_days <= 0:
            raise ValueError(
                f"serve-log retention_days must be > 0, got {retention_days}. A "
                "non-positive retention prunes every row on the first load, "
                "which is the amnesty this store exists to end."
            )
        self._dsn = dsn
        self._retention_s = retention_days * 86400.0
        self._statement_timeout_ms = statement_timeout_ms
        self._connect_timeout_s = connect_timeout_s
        self._lock = threading.Lock()
        self._conn: Any | None = None
        self._failures = 0
        self._opened_at = 0.0
        self._last_prune = 0.0

    @property
    def retention_s(self) -> float:
        return self._retention_s

    # -- connection ---------------------------------------------------------

    def _connect(self) -> Any:
        import psycopg

        conn = psycopg.connect(
            self._dsn, connect_timeout=self._connect_timeout_s, autocommit=True
        )
        with conn.cursor() as cur:
            # A connect timeout says nothing about a query that hangs after
            # connecting; the statement timeout is the bound that matters.
            cur.execute(f"SET statement_timeout = {self._statement_timeout_ms}")
            cur.execute(SQL_CREATE_TABLE)
            cur.execute(SQL_CREATE_INDEX)
        return conn

    def _breaker_is_open(self, now: float) -> bool:
        if self._failures < _BREAKER_THRESHOLD:
            return False
        return now - self._opened_at < _BREAKER_COOLDOWN_S

    def _drop_connection(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            # Closing an already-broken socket can itself raise, and the caller
            # is already in a failure path — there is nothing useful to do with
            # a second exception here.
            with contextlib.suppress(Exception):
                conn.close()

    def _run(self, sql: str, params: dict[str, Any], *, fetch: str) -> Any:
        """Execute one statement. Returns ``None`` on any failure, never raises.

        ``fetch`` is ``"all"``, ``"one"`` or ``"none"``. A failure closes the
        connection so the next call reconnects rather than reusing a socket in
        an unknown state, and trips the breaker so a store that is genuinely
        down is not retried on every feed request.
        """
        clock = time.monotonic()
        with self._lock:
            if self._breaker_is_open(clock):
                return None
            try:
                if self._conn is None:
                    self._conn = self._connect()
                with self._conn.cursor() as cur:
                    cur.execute(sql, params)
                    if fetch == "all":
                        result = cur.fetchall()
                    elif fetch == "one":
                        result = cur.fetchone()
                    else:
                        result = True
            except Exception as exc:  # a feed request must not die for this
                self._drop_connection()
                self._failures += 1
                if self._failures >= _BREAKER_THRESHOLD:
                    self._opened_at = clock
                logger.warning(
                    "exploration serve log: store unavailable (%s: %s) — serve "
                    "counts fall back to IN-PROCESS for now, which fails OPEN "
                    "(authors become eligible again) rather than shut. "
                    "consecutive failures: %d",
                    type(exc).__name__,
                    exc,
                    self._failures,
                )
                return None
            self._failures = 0
            return result

    # -- ServeLogStore ------------------------------------------------------

    def load(self) -> dict[str, ServeRow] | None:
        self._maybe_prune()
        rows = self._run(SQL_LOAD, {"retention_s": self._retention_s}, fetch="all")
        if rows is None:
            return None
        return {
            str(author): ServeRow(
                author=str(author),
                count=int(count),
                window_start=None if window_start is None else float(window_start),
                seen=int(seen),
            )
            for author, count, window_start, seen in rows
        }

    def record(
        self, author: str, *, seen: int, now: float | None, window_s: float
    ) -> ServeRow | None:
        row = self._run(
            SQL_RECORD,
            {"author": author, "seen": int(seen), "now": now, "window_s": float(window_s)},
            fetch="one",
        )
        if row is None:
            return None
        count, window_start, seen_out = row
        return ServeRow(
            author=author,
            count=int(count),
            window_start=None if window_start is None else float(window_start),
            seen=int(seen_out),
        )

    def delete(self, author: str) -> None:
        self._run(SQL_DELETE, {"author": author}, fetch="none")

    def _maybe_prune(self) -> None:
        clock = time.monotonic()
        if clock - self._last_prune < _PRUNE_INTERVAL_S:
            return
        self._last_prune = clock
        self._run(SQL_PRUNE, {"retention_s": self._retention_s}, fetch="none")

    def close(self) -> None:
        with self._lock:
            self._drop_connection()


__all__ = [
    "DSN_ENV",
    "ENABLE_ENV",
    "LITE_DSN_ENV",
    "SQL_CREATE_INDEX",
    "SQL_CREATE_TABLE",
    "SQL_DELETE",
    "SQL_LOAD",
    "SQL_PRUNE",
    "SQL_RECORD",
    "PostgresServeLogStore",
    "ServeLogStore",
    "ServeRow",
    "store_from_env",
]
