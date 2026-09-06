"""L2 — Lumen Lite engagement: votes and reblogs cast by lite accounts.

★★★ WHY THIS EXISTS. A lite user (Gmail/BTC/EVM signup, no Hive keys) cannot
vote on chain: a Hive vote is attributed to the SIGNING account, so proxying one
through the frontend account would collapse every lite user into a single voter.
The app therefore records their engagement in its own Postgres —
``lumen_vote`` / ``lumen_reblog`` (`0009_engagement.sql`), whose own comment
states the intent: *"feeds the recsys/feed"*. That seam was built and never
consumed, so until now a lite user's likes changed nothing at all.

WHAT THIS IS ALLOWED TO DO, and the boundary that makes it safe:

* It feeds **post hydration only**. Lite engagement never reaches
  ``engagement_edges``, so it can never build graph-cred, never propagate vouch,
  never influence ring detection. Edges are chain-only, and chain actions cost
  RC and stake. A free identity writing into the trust graph is the "free vouch
  printer" this design exists to avoid.
* A lite vote enters as :attr:`recsys.contracts.Vote.lite`, which counts for
  ORGANIC BREADTH (a distinct person) and is excluded from the §4 STAKE signal
  entirely. See that field's own docstring for why, and
  ``core/vote_signal.py`` for both halves.
* Lite voters are unknown identities, so ``VoterTrust.credited_breadth``'s
  existing ``unknown_free`` budget bounds them — CONDITIONALLY, and the
  condition matters: the bound is ``unknown_free + unknown_per_vouched *
  (vouched engagers)``, so "50 lite accounts buy one unit" holds only with NO
  vouched engager on the post. With vouched engagers it grows (measured 31.0 at
  10 vouched, 300.0 with a follow graph). No new defence was invented for this; the
  one that already bounds funded alts does the work.

RETRACTION IS PART OF THE CONTRACT, not a later refinement. Both tables
soft-delete (``active = false``) and bump ``seq``. A vote that cannot be
withdrawn is a griefing tool, so every query here filters on ``active``.

DEGRADE. ``LiteConfig.engagement_dsn`` is optional. Absent, this module returns
nothing and says so once at WARNING — the same posture A15 network-suppression
takes for its own optional connection. It never raises into a feed request: a
lite datastore being unreachable must cost engagement signal, not the page.

``psycopg`` is imported lazily inside the functions that connect, matching
``recsys.io.hafsql``'s discipline, so importing this module never requires the
``io`` extra.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from typing import Any

from recsys.config import LiteConfig
from recsys.contracts import Vote
from recsys.io.hafsql import HafsqlUnavailableError, PoolExhaustedError, _ConnPool

logger = logging.getLogger(__name__)

PostKey = tuple[str, str]

#: Only positive weight counts. Hive convention is -10000..10000 and this
#: project's rule is unambiguous (`Vote`'s own docstring, rev 2.1): downvotes
#: never affect ranking. A lite downvote is recorded by the app for the user's
#: own feed hygiene; it is not a ranking input.
_MIN_WEIGHT = 0

# ★★★ THE KEY PREDICATE, and it is written this way because the obvious form is
# DEAD. `(target_author, target_permlink) = ANY(%(keys)s)` with a list of tuples
# raises, at bind time, against a real PostgreSQL:
#
#     FeatureNotSupported: input of anonymous composite types is not implemented
#
# It was shipped, and every test in `tests/test_lite_engagement.py` monkeypatched
# `_connect`, so the SQL had never touched a database — the EXACT defect this
# project has now hit four separate times ("the I/O layer had never executed
# once"), reproduced by the author of the fix for it. Worse, the broad `except`
# below would have swallowed it into a WARNING on every request, forever: L2
# would have been silently inert in production with a green test suite.
#
# `unnest` over two PARALLEL TEXT ARRAYS is the supported construct — psycopg
# binds `text[]` natively, so there is no anonymous composite anywhere. Verified
# by execution against a real PostgreSQL, and pinned by
# `test_the_shipped_sql_executes_against_a_real_postgres`, which runs THESE
# CONSTANTS rather than a copy.
_SQL_LITE_VOTES = """
SELECT target_author, target_permlink, voter_user_id, updated_at
FROM lumen_vote
WHERE active = true
  AND weight > %(min_weight)s
  AND (target_author, target_permlink) IN (
      SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[]))
"""

_SQL_LITE_REBLOGS = """
SELECT target_author, target_permlink, reblogger_user_id
FROM lumen_reblog
WHERE active = true
  AND (target_author, target_permlink) IN (
      SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[]))
"""


def _key_params(keys: list[PostKey]) -> dict[str, list[str]]:
    """Split `(author, permlink)` pairs into the two parallel arrays the SQL
    binds. Order is load-bearing — `unnest(a, b)` pairs them positionally — so
    both lists are built in ONE pass over the same sequence."""
    return {
        "authors": [author for author, _ in keys],
        "permlinks": [permlink for _, permlink in keys],
    }


#: ★★★ PUNCH LIST #5 (2026-08-05) — the lite datastore is a THIRD database and
#: had none of the protections the HAFSQL client grew: no statement timeout, no
#: breaker, and a fresh connection per call (twice per hydrate, five call sites).
#: Measured by a council at ~6s added per request when it is slow. A secondary
#: signal source must never be able to spend a feed request's whole budget.
_STATEMENT_TIMEOUT_MS = int(os.environ.get("LUMEN_LITE_STATEMENT_TIMEOUT_MS", "2000"))
if _STATEMENT_TIMEOUT_MS <= 0:
    # ★ ROUND-5 COUNCIL (Seat 2): in PostgreSQL `statement_timeout = 0` means NO
    # LIMIT, so a zero here silently removes the protection while reading like a
    # configured value — the same "a typo must never look like a policy" class
    # this project fixed for `max_serves_per_author` and then re-introduced
    # here. Refuse it at import rather than discover it under load.
    raise ValueError(
        f"LUMEN_LITE_STATEMENT_TIMEOUT_MS must be > 0 — PostgreSQL treats 0 as "
        f"NO LIMIT, which disables the protection entirely. Got "
        f"{_STATEMENT_TIMEOUT_MS}."
    )
_CONNECT_TIMEOUT_S = int(os.environ.get("LUMEN_LITE_CONNECT_TIMEOUT_S", "3"))
#: Consecutive failures before the breaker opens, and how long it stays open.
#: Deliberately small and short: this degrades to "no lite engagement", which is
#: a real cost, so it should retry soon — but not on every request while the
#: store is down.
_BREAKER_THRESHOLD = 3
_BREAKER_COOLDOWN_S = 30.0

_breaker_lock = threading.Lock()
#: ★★★ ROUND-5 COUNCIL (Seat 3) — KEYED PER QUERY, not one global counter.
#: A single counter that ANY success resets can be held CLOSED indefinitely: if
#: the votes query fails and the reblogs query succeeds, the success zeroes the
#: count and the breaker never opens, so a slow table costs +2s on every request
#: forever. Measured by the council over 12 requests. Each query gets its own
#: state, so a persistently failing one trips on its own.
_failures: dict[str, int] = {}
_opened: dict[str, float] = {}


def _breaker_is_open(key: str, now: float) -> bool:
    with _breaker_lock:
        if _failures.get(key, 0) < _BREAKER_THRESHOLD:
            return False
        return now - _opened.get(key, 0.0) < _BREAKER_COOLDOWN_S


def _record_outcome(key: str, *, ok: bool, now: float) -> None:
    with _breaker_lock:
        if ok:
            _failures[key] = 0
            return
        _failures[key] = _failures.get(key, 0) + 1
        if _failures[key] >= _BREAKER_THRESHOLD:
            _opened[key] = now


def reset_breaker() -> None:
    """Test seam. Module-level breaker state would otherwise leak between
    tests, which is its own class of flake."""
    with _breaker_lock:
        _failures.clear()
        _opened.clear()


def _connect(dsn: str):  # type: ignore[no-untyped-def]
    import psycopg

    conn = psycopg.connect(dsn, connect_timeout=_CONNECT_TIMEOUT_S, autocommit=True)
    # A statement timeout is the bound that actually matters: a connect timeout
    # says nothing about a query that hangs after connecting.
    with conn.cursor() as cur:
        cur.execute(f"SET statement_timeout = {_STATEMENT_TIMEOUT_MS}")
    return conn


# ---------------------------------------------------------------------------
# ★★★ L1 (RECSYS-LATENCY-BUILD-MAP-2026-09-06) — POOL THE LOOPBACK CONNECTION.
#
# Every fetch above opened a fresh `_connect(dsn)` — a full TLS handshake
# (`ssl=on` on the host, psycopg's default `sslmode=prefer`) plus SCRAM, for a
# connection to Lumen's OWN Postgres on 127.0.0.1. Measured live 2026-09-06:
# 7 to 9 such connections per `/feed` request across this module and
# `seen_log`, 0.05 to 2.5s each, 0.8 to 4.0s per request — plus 9/day
# `ConnectionTimeout` failures on the LOCAL database when the box is busy.
# Loopback traffic inside the same host needs no transport encryption, and a
# connection this cheap to open is exactly the case a small pool amortises.
#
# `_connect` stays the ONE place that opens a physical connection (same
# monkeypatch seam every test in this module already uses) — the pool's own
# "open" callable is `_pool_connect`, which folds `sslmode=disable` into the
# DSN and THEN calls `_connect`, so the TLS choice is scoped to connections
# THE POOL opens and never touches a direct `_connect(dsn)` call (the flag-off
# path below, and `test_the_lite_connection_actually_enforces_a_statement_
# timeout`'s live call against an arbitrary — possibly non-loopback — dsn).
#
# ★★★ REVIEW FIX (2026-09-06) — sslmode=disable is now CONDITIONAL. It was
# forced onto every pooled connection unconditionally, which (a) silently
# overrode an operator-set `sslmode` already present in the DSN and (b) would
# have disabled TLS against a NON-loopback Postgres if `LUMEN_LITE_DATABASE_URL`
# ever pointed at one — a real credential-in-cleartext regression, not a
# hypothetical. It is now applied ONLY when BOTH hold: the DSN's host is
# loopback (`127.0.0.1`, `::1`, `localhost`) AND the DSN does not already set
# `sslmode` explicitly. Otherwise the DSN passes through unchanged. Verified
# live 2026-09-06 (`docker inspect`): production runs this container with
# `--network host`, and `RECSYS_DATABASE_URL`/(by the same deploy)
# `LUMEN_LITE_DATABASE_URL` point at `127.0.0.1` — the loopback branch is what
# actually fires today. `deploy/compose.recsys.yml`'s bridge-network shape is
# not what runs on the box.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def _int_env_or_default(name: str, default: int) -> int:
    """Defensive parse for a module-import-time env read. A bare `int(os.
    environ.get(...))` here would raise `ValueError` at IMPORT time on a
    non-numeric value — crashing the whole process before it ever serves a
    health check — for what is a tuning knob, not a boot-critical setting.
    Falls back to the default and logs once, rather than refusing to start."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            "%s=%r is not a valid integer — using the default %d instead", name, raw, default
        )
        return default


_LOCAL_POOL_MIN = _int_env_or_default("RECSYS_LOCAL_POOL_MIN", 2)
#: ★ REVIEW FIX (2026-09-06): was 3, then 16, now 6 (SECOND REVIEW FIX,
#: 2026-09-06). The 3 -> 16 change matched `ServiceConfig.
#: max_concurrent_requests`'s ceiling (default 16) to remove a SELF-INFLICTED
#: exhaustion (reproduced: 12 concurrent callers against a max of 3 exhausted
#: the pool). But `_ConnPool` never reaped an idle connection (fixed
#: alongside this, see `hafsql._DEFAULT_POOL_IDLE_MAX_AGE_S`), so 16 here PLUS
#: `seen_log`'s own 16 could pin up to 32 permanent backends on Lumen's OWN
#: Postgres, forever, while any one request thread holds at most ONE
#: connection from this pool at a time — a self-inflicted problem of the
#: opposite kind. 6 is a middle ground: comfortably above the steady-state
#: concurrent-borrower count this pool actually sees, small enough that even
#: fully idle-reaped-away-and-reopened churn is not a real backend-count
#: concern, and no longer a correctness risk for BURSTS above 6 now that
#: `_fetch_rows`'s exhaustion fallback (below) answers that call with one
#: direct, unpooled connection instead of losing signal — the same safety net
#: the max=16 change was originally trying to buy by raising the ceiling
#: instead.
_LOCAL_POOL_MAX = _int_env_or_default("RECSYS_LOCAL_POOL_MAX", 6)

_pools_lock = threading.Lock()
_pools: dict[str, _ConnPool] = {}


def _local_pool_enabled() -> bool:
    """``RECSYS_LOCAL_POOL`` — build map L1. Defaults ON. ``0``/``false``/
    ``no``/``off`` is the kill switch back to a fresh connection (with its
    original, unmodified DSN — no forced ``sslmode``) on every call, same
    default-on/opt-out polarity as Q1/Q2's flags above."""
    raw = os.environ.get("RECSYS_LOCAL_POOL", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _sslmode_disable_dsn_if_loopback(dsn: str) -> str:
    """Fold `sslmode=disable` into `dsn` ONLY when its host is loopback and it
    does not already declare `sslmode` — see this section's own comment for
    why. Returns `dsn` unchanged in every other case, including when the DSN
    cannot be parsed at all (fail safe: never guess at a stranger's DSN)."""
    import psycopg
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    try:
        parsed = conninfo_to_dict(dsn)
    except psycopg.ProgrammingError:
        return dsn
    if parsed.get("sslmode"):
        return dsn
    if parsed.get("host") not in _LOOPBACK_HOSTS:
        return dsn
    return make_conninfo(dsn, sslmode="disable")


def _pool_connect(dsn: str):  # type: ignore[no-untyped-def]
    """The pool's own "open a physical connection" callable. Drops TLS only
    on a loopback DSN with no explicit `sslmode` of its own — never applied
    to a direct `_connect(dsn)` call (see this section's own comment)."""
    return _connect(_sslmode_disable_dsn_if_loopback(dsn))


def _get_pool(dsn: str) -> _ConnPool:
    with _pools_lock:
        pool = _pools.get(dsn)
        if pool is None:
            pool = _ConnPool(
                lambda: _pool_connect(dsn),
                min_size=_LOCAL_POOL_MIN,
                max_size=_LOCAL_POOL_MAX,
                max_retries=2,
                retry_backoff_s=0.2,
                breaker_threshold=_BREAKER_THRESHOLD,
                breaker_cooldown_s=_BREAKER_COOLDOWN_S,
                acquire_timeout_s=5.0,
            )
            _pools[dsn] = pool
        return pool


def reset_local_pool() -> None:
    """Test seam — same reasoning as `reset_breaker`: module-level pool state
    (one physical connection cached per dsn) would otherwise leak between
    tests that all use the same placeholder dsn string."""
    with _pools_lock:
        pools = list(_pools.values())
        _pools.clear()
    for pool in pools:
        pool.closeall()


# REVIEW FIX (2026-09-06). Throttle the exhaustion-fallback WARNING below to
# at most once per `_BREAKER_COOLDOWN_S` (reusing this module's own breaker
# window rather than inventing a second interval) instead of once per call —
# a SUSTAINED exhaustion (the local Postgres genuinely can't keep up) would
# otherwise write one WARNING per request for as long as it lasted, on top
# of whatever else is already going wrong.
_pool_exhaustion_log_lock = threading.Lock()
_pool_exhaustion_last_logged: dict[str, float] = {}


def _reset_pool_exhaustion_log_for_tests() -> None:
    """Test seam — see `_pool_exhaustion_last_logged`'s own comment."""
    with _pool_exhaustion_log_lock:
        _pool_exhaustion_last_logged.clear()


def _log_pool_exhaustion_fallback(dsn: str) -> None:
    now = time.monotonic()
    with _pool_exhaustion_log_lock:
        last = _pool_exhaustion_last_logged.get(dsn, 0.0)
        if now - last < _BREAKER_COOLDOWN_S:
            return
        _pool_exhaustion_last_logged[dsn] = now
    logger.warning(
        "L1 pool exhausted for %s — falling back to a direct connection for "
        "this call (further occurrences suppressed for %.0fs)",
        dsn.split("@")[-1] if "@" in dsn else dsn,
        _BREAKER_COOLDOWN_S,
    )


def _fetch_rows(dsn: str, sql: str, params: dict[str, Any]) -> list[tuple[Any, ...]]:
    """L1: run one query against Lumen's own Postgres, pooled by default.

    Flag off (`RECSYS_LOCAL_POOL` set to a kill value): today's exact
    behaviour — a fresh `_connect(dsn)` per call, closed on exit.

    Flag on (default): borrow a pooled connection opened via `_pool_connect`
    (loopback, TLS off) and release it back rather than closing it. Marks the
    connection unhealthy on ANY exception (simpler and more conservative than
    `HafsqlClient._fetch_via`'s OperationalError-only distinction — this pool
    is small and local, so discarding a connection after any failure costs
    little and never risks reusing a session left in a bad state)."""
    if not _local_pool_enabled():
        with _connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    pool = _get_pool(dsn)
    try:
        conn = pool.borrow()
    except PoolExhaustedError:
        # ★ REVIEW FIX (2026-09-06), NARROWED (2026-09-06 second pass). Pool
        # exhausted — every slot in use past `acquire_timeout_s` — with the
        # underlying database presumably still healthy. Before this, that
        # propagated up to the caller's own `except Exception`, which
        # degrades to "no lite engagement"/"no suppression" — losing real
        # signal for a condition that a single fresh connection can usually
        # still answer. Falls back to exactly the pre-L1 behaviour for this
        # one call: a direct, unpooled connection.
        _log_pool_exhaustion_fallback(dsn)
        with _connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    except HafsqlUnavailableError:
        # SECOND REVIEW FIX (2026-09-06). This is the BREAKER being open, not
        # exhaustion (`PoolExhaustedError`, caught above, is a subclass and
        # is matched first). The breaker opened because the last
        # `breaker_threshold` connect attempts failed — falling back to a
        # direct connect here would just retry against a database already
        # proven down, one call at a time, defeating the entire point of the
        # breaker. Fast-fail instead, exactly as the pre-L1 code's own
        # equivalent failure did: propagate to the caller's `except
        # Exception`, which degrades to "no lite engagement" for this call.
        raise
    healthy = True
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    except Exception:
        healthy = False
        raise
    finally:
        pool.release(conn, healthy=healthy)


def fetch_lite_votes(
    lite: LiteConfig, keys: Iterable[PostKey]
) -> Mapping[PostKey, list[Vote]]:
    """Lite votes for a page of posts, keyed by ``(author, permlink)``.

    The keys are CHAIN coordinates, which is what ``lumen_vote`` stores, so this
    works for a lite user voting an ordinary Hive author's post exactly as it
    does for one lite user voting another's. Returns ``{}`` — never raises —
    when the DSN is absent or the datastore is unreachable.
    """
    wanted = list(keys)
    if not wanted:
        return {}
    if not lite.engagement_enabled:
        logger.warning(
            "lite engagement: LiteConfig.engagement_dsn is unset — lite votes and "
            "reblogs are NOT being read, so lite users' engagement contributes "
            "nothing to ranking. Set LUMEN_LITE_DATABASE_URL to enable it."
        )
        return {}
    assert lite.engagement_dsn is not None
    now = time.monotonic()
    if _breaker_is_open("votes", now):
        logger.warning(
            "lite engagement: breaker OPEN after %d consecutive failures — "
            "skipping for up to %.0fs; ranking continues WITHOUT lite engagement",
            _BREAKER_THRESHOLD,
            _BREAKER_COOLDOWN_S,
        )
        return {}
    out: dict[PostKey, list[Vote]] = {}
    try:
        rows = _fetch_rows(
            lite.engagement_dsn,
            _SQL_LITE_VOTES,
            {**_key_params(wanted), "min_weight": _MIN_WEIGHT},
        )
        for author, permlink, voter, updated_at in rows:
            out.setdefault((author, permlink), []).append(
                Vote(
                    voter=voter,
                    # Zero, never synthetic. A lite vote has no stake, and
                    # `Vote.lite` — not a fabricated magnitude — is what
                    # makes it count for breadth.
                    rshares=0,
                    timestamp=_as_aware(updated_at),
                    lite=True,
                )
            )
    except Exception as exc:  # a feed request must not die for this
        _record_outcome("votes", ok=False, now=now)
        logger.warning(
            "lite engagement: votes unavailable (%s: %s) — ranking continues "
            "WITHOUT lite engagement for this request",
            type(exc).__name__,
            exc,
        )
        return {}
    _record_outcome("votes", ok=True, now=now)
    return out


def fetch_lite_rebloggers(
    lite: LiteConfig, keys: Iterable[PostKey]
) -> Mapping[PostKey, frozenset[str]]:
    """Lite rebloggers for a page of posts. Same degrade posture as votes."""
    wanted = list(keys)
    if not wanted or not lite.engagement_enabled:
        return {}
    assert lite.engagement_dsn is not None
    now = time.monotonic()
    if _breaker_is_open("reblogs", now):
        logger.warning(
            "lite engagement: reblogs breaker OPEN after %d consecutive failures "
            "— skipping for up to %.0fs; ranking continues WITHOUT lite reblogs",
            _BREAKER_THRESHOLD,
            _BREAKER_COOLDOWN_S,
        )
        return {}
    collected: dict[PostKey, set[str]] = {}
    try:
        rows = _fetch_rows(lite.engagement_dsn, _SQL_LITE_REBLOGS, _key_params(wanted))
        for author, permlink, reblogger in rows:
            collected.setdefault((author, permlink), set()).add(reblogger)
    except Exception as exc:
        _record_outcome("reblogs", ok=False, now=now)
        logger.warning(
            "lite engagement: reblogs unavailable (%s: %s) — ranking continues "
            "WITHOUT lite reblogs for this request",
            type(exc).__name__,
            exc,
        )
        return {}
    _record_outcome("reblogs", ok=True, now=now)
    return {key: frozenset(names) for key, names in collected.items()}


def _as_aware(value: datetime) -> datetime:
    """`lumen_vote.updated_at` is `timestamptz`, but a driver or a future
    migration could hand back a naive value, and a naive/aware subtraction
    raises `TypeError` deep in the decay maths — the exact break (#8) that once
    killed the whole weekly trust batch from the HAFSQL side."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


__all__ = ["fetch_lite_rebloggers", "fetch_lite_votes"]
