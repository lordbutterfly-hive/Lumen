"""Read one viewer's IMPRESSION STATE — the input seen-post suppression consumes.

★★★ WHY THIS READS THE FRONTEND'S DATABASE AND NOT RECSYS'S.

The serve event exists only in the Next.js route. recsys never learns that a page
was DELIVERED — it has no serve concept at all beyond an in-process exploration
counter. Putting impression state in the recsys DB would mean inventing a
frontend->recsys ingestion path for a fact the frontend already writes to a table
it already owns, and it would create a SECOND answer to "has this reader seen
this" — the exact failure `pipeline.py` names at its `engagement_counts`
construction ("two computations ... that could disagree is precisely how the
previous two designs broke").

Meanwhile the read costs no new transport: recsys is ALREADY configured with the
lite DSN and already opens it. `LiteConfig.engagement_dsn` <- `LUMEN_LITE_DATABASE_URL`,
consumed by `recsys.io.lite_engagement` for lite votes/reblogs, and the deployed
value points at the same database that holds `lumen_feed_served`. recsys's own DB
is snapshot/batch-shaped — every one of its tables is a batch artefact — so
per-serve writes have no home there anyway.

★★★ CONTRACT C8 — THE IDENTITY, AND THE QUERY THAT PROVED IT.

The served log records the DISPLAY identity, `author/permlink` with no `@`.
recsys's `Post.key` is `@author/permlink`, and for a Lumen-native post `author`
is the writer's `lumen_user_id` ULID. Those are DIFFERENT STRINGS, and a
suppression set built naively from `post_key` matches ZERO lite posts, forever,
with no error.

Proven against real rows on 2026-08-15, not inferred from code::

    -- 46 of 8,508 served rows are Lumen-native. Every one is keyed by handle:
    bravouyuce/lumen-01kzchxgtzzg4ef6v9kyb694de   (3 impressions, 2 viewers, in_network)

    -- and that post's three identities:
    recsys Post.key      @01KZAC6C92G3MJ7QV8BN3B82EA/lumen-01kzchxgtzzg4ef6v9kyb694de
    served post_key      bravouyuce/lumen-01kzchxgtzzg4ef6v9kyb694de
    chain publisher      hbd-temp

    -- and the null result that makes it a defect rather than a nuisance:
    SELECT count(*) FROM lumen_feed_served WHERE post_key LIKE '@%';  -->  0

So the aggregate carries `ranked_key` — captured at serve time by the one place
that holds all three identities at once (`hydrate`'s `postByKey`) — and THAT is
what this module keys on. `Post.key` joins to it exactly, for both tiers, with no
string surgery.

★ THE `COALESCE` FALLBACK IS FOR HIVE POSTS ONLY, AND SAYS SO. A row whose
`ranked_key` is NULL (written before the column, or by a delivery whose lane was
unknown) is repaired as `'@' || post_key`, which is exactly right for an ordinary
Hive post and WRONG-BUT-HARMLESS for a lite one: it yields a key that matches no
candidate, so that post is simply never suppressed. Failing toward SHOWING a post
is the safe direction everywhere in this feature.

★ DEGRADE. Absent DSN, unreachable database, malformed row: this returns an EMPTY
map and says so once at WARNING. An empty map means "suppress nothing", so a
datastore outage costs repetition, never a page — the same posture
`lite_engagement` takes, and the same breaker, because a slow table must not add
seconds to every feed request while it is down.

★ `psycopg` is imported lazily inside `_connect`, matching `recsys.io.hafsql`'s
discipline, so importing this module never requires the ``io`` extra.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

from recsys.config import LiteConfig
from recsys.core.seen import SeenState
from recsys.io.hafsql import HafsqlUnavailableError, PoolExhaustedError, _ConnPool

logger = logging.getLogger(__name__)

_STATEMENT_TIMEOUT_MS = int(os.environ.get("LUMEN_SEEN_STATEMENT_TIMEOUT_MS", "2000"))
_CONNECT_TIMEOUT_S = int(os.environ.get("LUMEN_SEEN_CONNECT_TIMEOUT_S", "3"))

#: Same shape and the same reasoning as `lite_engagement`'s breaker: this
#: degrades to "no suppression", which is a real product cost, so retry soon —
#: but not on every request while the store is down.
_BREAKER_THRESHOLD = 3
_BREAKER_COOLDOWN_S = 30.0

_breaker_lock = threading.Lock()
_failures = 0
_opened = 0.0

# ★★★ THE READ. ONE VIEWER, ONE INDEXED RANGE SCAN.
#
# `lumen_feed_seen_viewer_recent_idx (viewer, last_served_at DESC)` covers it
# exactly. Row count is bounded by DISTINCT POSTS THIS VIEWER SAW IN THE WINDOW —
# measured at 50-66 for the three heaviest readers over six days — which is two
# orders of magnitude below the raw log's 2,000-rows-per-viewer ceiling. That
# bound is the whole reason suppression reads the aggregate and not the log:
# `FEED_SERVED_MAX_ROWS_PER_VIEWER` truncates the log oldest-first and those same
# three viewers are sitting at EXACTLY 2,000 right now, so a filter reading the
# log would resurrect posts by amnesia and call it freshness.
#
# ★ `tainted` IS READ AS "DO NOT SUPPRESS THIS VIEWER". It is set by the write
# side's ratio guard when a viewer's impressions-per-post passes the hard bound,
# i.e. when something that is not a reader is recording. A counter that has
# provably lost its meaning must stop being a ranking input, and the safe degrade
# is repetition, never an empty feed. Filtering the rows OUT here (rather than
# passing a flag up) is what makes that a single-place decision.
#
# ★ THE WINDOW IS PASSED, NEVER DEFAULTED. See `SeenConfig.window_days` for the
# C9 reconciliation (7, not 3) and for the live trap in `countImpressions` that
# forced it to be explicit.
_SQL_SEEN = """
SELECT COALESCE(ranked_key, '@' || post_key) AS ranked_key,
       impressions,
       engagers_at_last_serve,
       EXTRACT(EPOCH FROM last_served_at) AS last_served_epoch
  FROM lumen_feed_seen
 WHERE viewer = %(viewer)s
   AND tainted = false
   AND last_served_at > now() - (%(window_days)s * INTERVAL '1 day')
"""


def _breaker_is_open(now: float) -> bool:
    with _breaker_lock:
        if _failures < _BREAKER_THRESHOLD:
            return False
        return now - _opened < _BREAKER_COOLDOWN_S


def _record_outcome(*, ok: bool, now: float) -> None:
    global _failures, _opened
    with _breaker_lock:
        if ok:
            _failures = 0
            return
        _failures += 1
        if _failures >= _BREAKER_THRESHOLD:
            _opened = now


def reset_breaker() -> None:
    """Test seam — module-level breaker state would otherwise leak between tests,
    which is its own class of flake. Same seam `lite_engagement` exposes."""
    global _failures, _opened
    with _breaker_lock:
        _failures = 0
        _opened = 0.0


def _connect(dsn: str):  # type: ignore[no-untyped-def]
    import psycopg

    conn = psycopg.connect(dsn, connect_timeout=_CONNECT_TIMEOUT_S, autocommit=True)
    # A statement timeout is the bound that actually matters: a connect timeout
    # says nothing about a query that hangs after connecting.
    with conn.cursor() as cur:
        cur.execute(f"SET statement_timeout = {_STATEMENT_TIMEOUT_MS}")
    return conn


# ---------------------------------------------------------------------------
# L1 (RECSYS-LATENCY-BUILD-MAP-2026-09-06) — pool the loopback connection.
# Same design as `recsys.io.lite_engagement`'s own L1 section (see that
# module's comment for the full measured evidence and the reasoning behind
# each choice); duplicated here rather than shared, matching this file's own
# existing duplication of `_STATEMENT_TIMEOUT_MS`/`_CONNECT_TIMEOUT_S`/the
# breaker shape from that module.
# ---------------------------------------------------------------------------
# ★★★ REVIEW FIX (2026-09-06) — sslmode=disable is now CONDITIONAL, and the
# pool defaults changed. See `lite_engagement`'s identical section for the
# full reasoning (forced sslmode overrode an explicit one and risked a TLS
# downgrade off loopback; a pool max below `max_concurrent_requests` is a
# self-inflicted exhaustion, reproduced at 12 concurrent callers on max=3).
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def _int_env_or_default(name: str, default: int) -> int:
    """Defensive parse for a module-import-time env read — see
    `lite_engagement._int_env_or_default`'s identical docstring."""
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
#: ★ REVIEW FIX (2026-09-06), SECOND PASS: was 16, now 6. See
#: `lite_engagement._LOCAL_POOL_MAX`'s own comment for the full reasoning —
#: this pool and that one, both at 16, could pin up to 32 permanent backends
#: on Lumen's own Postgres (which never reaped an idle connection until this
#: same pass — see `hafsql._DEFAULT_POOL_IDLE_MAX_AGE_S`) while any one
#: request thread holds at most ONE connection from this pool at a time. 6
#: is safe against bursts above it now that `_fetch_rows`'s exhaustion
#: fallback (below) answers that call with one direct connection instead of
#: losing signal.
_LOCAL_POOL_MAX = _int_env_or_default("RECSYS_LOCAL_POOL_MAX", 6)

_pools_lock = threading.Lock()
_pools: dict[str, _ConnPool] = {}


def _local_pool_enabled() -> bool:
    """``RECSYS_LOCAL_POOL`` — build map L1. Defaults ON; ``0``/``false``/
    ``no``/``off`` is the kill switch back to a fresh, unmodified-DSN
    connection on every call. Shares the flag NAME with
    `lite_engagement._local_pool_enabled` (one operator switch for both
    local-Postgres readers), but reads the environment independently — no
    shared state between the two modules beyond that name."""
    raw = os.environ.get("RECSYS_LOCAL_POOL", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _sslmode_disable_dsn_if_loopback(dsn: str) -> str:
    """See `lite_engagement._sslmode_disable_dsn_if_loopback`'s identical
    docstring: only a loopback host with no `sslmode` of its own gets one
    forced; everything else, including an unparseable DSN, passes through
    unchanged."""
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
    """The pool's own physical-open callable — folds ``sslmode=disable`` into
    the DSN only when it is safe to (see `_sslmode_disable_dsn_if_loopback`),
    then delegates to `_connect` (the same monkeypatch seam a direct,
    flag-off call uses, untouched by this)."""
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
    """Test seam — same reasoning as `reset_breaker`."""
    with _pools_lock:
        pools = list(_pools.values())
        _pools.clear()
    for pool in pools:
        pool.closeall()


# REVIEW FIX (2026-09-06). See `lite_engagement`'s identical helper's own
# comment: throttles the exhaustion-fallback WARNING below to at most once
# per `_BREAKER_COOLDOWN_S` instead of once per call.
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
    """L1: run one query against the Lumen frontend's Postgres, pooled by
    default. See `lite_engagement._fetch_rows`'s own docstring — identical
    shape, including the any-exception-marks-unhealthy simplification and
    the pool-exhaustion fallback to a direct connect (2026-09-06 review fix),
    narrowed (2026-09-06 second pass) to genuine exhaustion only — a
    breaker-open failure fast-fails instead, see below."""
    if not _local_pool_enabled():
        with _connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    pool = _get_pool(dsn)
    try:
        conn = pool.borrow()
    except PoolExhaustedError:
        # Genuine local exhaustion — every slot in use past
        # `acquire_timeout_s` — with the underlying database presumably
        # still healthy. Falls back to one direct, unpooled connection.
        _log_pool_exhaustion_fallback(dsn)
        with _connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    except HafsqlUnavailableError:
        # The BREAKER is open, not exhaustion (`PoolExhaustedError`, caught
        # above, is a subclass and is matched first). Falling back to a
        # direct connect here would just retry against a database already
        # proven down. Fast-fail: propagate to the caller's `except
        # Exception`, which degrades to "nothing suppressed" for this call.
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


def fetch_seen(
    lite: LiteConfig,
    viewer: str,
    *,
    window_days: int,
) -> dict[str, SeenState]:
    """Impression state for one viewer, keyed by ``Post.key`` (the RANKED identity).

    Returns ``{}`` — never raises — when the viewer is empty, the DSN is unset,
    the breaker is open, or the read fails. ``{}`` means "suppress nothing".
    """
    if not viewer:
        return {}
    if not lite.engagement_enabled:
        logger.warning(
            "seen-suppression: LiteConfig.engagement_dsn is unset, so impression "
            "state cannot be read and NOTHING WILL BE SUPPRESSED. The feed is "
            "byte-identical to the pre-suppression one. Set "
            "LUMEN_LITE_DATABASE_URL to enable it."
        )
        return {}
    assert lite.engagement_dsn is not None
    now = time.monotonic()
    if _breaker_is_open(now):
        logger.warning(
            "seen-suppression: breaker OPEN after %d consecutive failures — "
            "skipping for up to %.0fs; ranking continues WITHOUT suppression",
            _BREAKER_THRESHOLD,
            _BREAKER_COOLDOWN_S,
        )
        return {}

    out: dict[str, SeenState] = {}
    try:
        rows = _fetch_rows(
            lite.engagement_dsn, _SQL_SEEN, {"viewer": viewer, "window_days": window_days}
        )
        for ranked_key, impressions, engagers, last_epoch in rows:
            if not ranked_key:
                continue
            out[str(ranked_key)] = SeenState(
                impressions=int(impressions or 0),
                # ★ NULL STAYS None. Never coerced to 0 — an unknown baseline
                # means resurrection cannot be evaluated, which `core.seen.
                # resurrects` deliberately resolves toward SHOWING the post.
                # Reading it as 0 would silently turn "we could not tell" into
                # "it has never been engaged", which is the strictest possible
                # reading of the least reliable data.
                engagers_at_last_serve=None if engagers is None else int(engagers),
                last_served_at=float(last_epoch or 0.0),
            )
    except Exception as exc:  # a feed request must never die for this
        _record_outcome(ok=False, now=now)
        logger.warning(
            "seen-suppression: impression state unavailable (%s: %s) — ranking "
            "continues WITHOUT suppression for this request (viewer=%s)",
            type(exc).__name__,
            exc,
            viewer,
        )
        return {}
    _record_outcome(ok=True, now=now)
    return out
