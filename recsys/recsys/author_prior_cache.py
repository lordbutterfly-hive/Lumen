"""BUILDMAP-A-LAUNCH follow-up (2026-08-04, this builder) — a warmed,
timer-refreshed cache for the author-pooled engagement prior (§6) that
:func:`recsys.pipeline._author_priors` currently fetches FRESH on every
single request via ``gateway.author_engagement(...)``.

THE PROBLEM THIS CLOSES, measured, not theorized (see
``recsys/io/hafsql.py``'s own ``★★★ PERF`` comment above
``_SQL_AUTHOR_ENGAGEMENT``, and ``tests/test_hafsql_live.py::
test_author_engagement_structural_floor_persists_for_a_busy_candidate_set``):
a realistic 47-follow viewer already pays ~0.9-1.6s of every request on this
one query (post the 2026-08-04 query rewrite); a candidate pool that happens
to include the network's busiest posters — which the real candidate-sourcing
pipeline can and does pull in, via ``POPULAR_FALLBACK``/``OON_ENGAGED``/tag
lanes, not a synthetic worst case — hits the 15s ``statement_timeout`` and
raises ``psycopg.errors.QueryCanceled``, or takes 21-36s uncapped. Neither
number belongs on a request path.

THE ARCHITECTURAL FIX: the author-pooled prior is a per-author WINDOW
aggregate (§6) — it does not depend on who is asking, only on which authors
posted into the rolling window and who engaged them. That makes it
cacheable on exactly the same basis as :class:`~recsys.contracts.NormContext`
(``recsys.norm_builder.build_window_norm`` + ``service.app._TimerCache``) and
``HafsqlClient.popular_posts`` (``HAFSQL_POPULAR_CACHE_TTL_S``): build it
once, on a background timer, and let the request path only ever READ it.
This module is that cache.

MIRRORS ``recsys.pipeline._author_priors`` EXACTLY, ON PURPOSE — the same
discipline, and the same reason, ``recsys/norm_builder.py`` already documents
for importing ``recsys.pipeline._organic_signal``: the excluded/trust inputs
this cache warms with must be the IDENTICAL §8.4 exclusion set (self + stake
lineage + per-author ring) and H05 breadth budget that a live per-request
call to ``_author_priors`` would compute from the SAME shared
:class:`~recsys.pipeline.TrustSnapshot` — otherwise a cache HIT would
silently serve a value computed under different Sybil-hardening assumptions
than a cache MISS (which still falls through to the documented
no-prior-at-all degrade, never to a live call with looser exclusion). So this
module imports :func:`recsys.pipeline._lineage_for`,
:func:`recsys.pipeline._ring_exclusion` and :func:`recsys.pipeline._voter_trust`
(all name-mangled private, all NOT accidentally so — the same "expected to
live in a different file and import it" posture ``norm_builder.py``'s own
docstring states) rather than re-deriving the exclusion/breadth logic a
second, independently-maintained way. If ``_author_priors``'s own exclusion
construction ever changes, this module's warm builder must change with it —
flagged here, not hidden, exactly as ``norm_builder.py`` flags the same
coupling for ``_organic_signal``.

MISS POLICY (the question the build brief poses directly): **cache-only, no
fetch-on-miss.** A viewer's candidate pool WILL contain authors outside the
warm set (a brand-new post from a brand-new author, published minutes ago).
:meth:`AuthorPriorCache.get` returns priors for whatever it has and silently
omits the rest from the returned mapping — which is not a new behaviour
mode, it is the EXISTING, already-documented degrade
(``_author_priors``'s own docstring: "a gateway that does not implement
AuthorPriorGateway returns nothing and every post falls back to its own
engagement — the pre-rebuild behaviour, degraded honestly rather than
faked"). What is NEW is that the miss is never allowed to be silent
end-to-end: every :meth:`~AuthorPriorCache.get` call increments observable
counters (:meth:`~AuthorPriorCache.stats`, wired into
``recsys.service.app.health_payload``) and logs the missed author names
(capped) at WARNING. A bounded, opt-in fetch-on-miss was considered and
REJECTED as the default: the whole point of this cache is that "a small
number of extra authors" is not a safe assumption to make on the request
path — see the module docstring on ``recsys/io/hafsql.py`` for why a
candidate pool's author-count is not bounded by viewer intent, only by what
sourcing pulls in. An operator who wants a bounded live top-up for misses can
still call ``gateway.author_engagement`` directly for the miss set returned
by a caller that tracks it (``AuthorPriorCacheStats`` is public); that
decision is left to the pipeline-side integration, not baked in here as a
silent default.

WARM-SET SCOPE, live-measured 2026-08-04 (this builder) — see the build
report for the full sweep table. Every candidate author must have posted
within ``settings.history.in_network_freshness_days`` (7d default — the
WIDEST candidate-sourcing horizon any lane uses: ``IN_NETWORK`` widens to it,
every other lane stays on the shorter ``sourcing_freshness_days``), so that
recency window bounds the full universe of authors that could ever reach
``_author_priors``. Live-measured 2026-08-04: 2,227 distinct authors posted
in the trailing 7 days on the real network. ``author_engagement`` itself is
NOT called with all 2,227 at once — CHUNKED (``chunk_size``), because a
sweep against the live mirror (busiest-first ordering, i.e. the worst case)
showed cost is driven by AUTHOR COUNT in the batch, not any one author's own
post volume (a single author with 231 posts in 7 days/1,458 in 45 days
answers in ~0.1-0.3s alone):

    authors   elapsed (busiest-first, self-exclusion only)
       10       0.80s
       20       1.90s
       25       2.51-2.53s (x3 consecutive runs)  <- chosen chunk_size
       30       2.80s
       40       4.43-5.78s ... then FAILED 5 CONSECUTIVE TIMES in a row
                on a later run at the SAME size (see below)
       60       7.54s
       80      11.08s
      100      14.28s   <- within 1s of the 15s statement_timeout
      150      TIMEOUT  (psycopg.errors.QueryCanceled)

★★ 40 WAS THE FIRST CHOICE AND WAS REJECTED, live, after it produced
INCONSISTENT results — stated plainly rather than only reporting the number
that looks good. Four separate isolated measurements at ``chunk_size=40``
(busiest-first, both with and without the real §8.4 exclusion set threaded
through) all succeeded in the 4.4-5.8s range. A full end-to-end warm build
at the same size then hit ``psycopg.errors.QueryCanceled`` on FIVE
CONSECUTIVE chunks in a row (chunks 1-5 of 56) before this was caught and
the run was stopped — a >15s runtime on a batch that isolated retests placed
at ~5s, on the SAME shared public mirror ``recsys/io/hafsql.py``'s own PERF
comment already documents as having "real" run-to-run variance. Re-testing
the exact same 40-author batch (with the real exclusion set) immediately
afterward succeeded again at 5.78s — so this is genuinely load-dependent,
not a bug in the exclusion-set construction (a direct comparison, same
batch, same moment: 5.78s WITH the real ``excluded``/``trust`` construction
vs. 4.65s WITHOUT, ruled out exclusion complexity as the cause of the
5-chunk failure run).

**25 was chosen instead of tuning 40 further**, for two reasons: (1) it
tested consistently fast (three consecutive live runs, 2.51-2.53s, near-zero
spread) with real headroom below the point where 40 was observed to become
unreliable; (2) the PER-CHUNK FAILURE ISOLATION below is the real defense
against the residual risk that no fixed chunk size can fully rule out on a
variable-load shared server — 25 buys margin, isolation buys resilience, and
both are needed. The background refresh — not the request path — pays
``ceil(len(warm_authors) / chunk_size)`` sequential round trips.

TOTAL WARM-BUILD TIME, measured end to end at PRODUCTION SCALE (2026-08-04,
this builder, ``build_warm_author_priors`` run against the real mirror with
the shipped defaults — not a projection): **508.48s (8.47 min)** for the
2,227 real distinct authors discovered at measurement time (~62s of
per-author ``stake_lineage`` calls + chunked ``author_engagement`` for the
rest), returning priors for 2,226 of them. This is ~28% of the 1,800s
(30 min) default ``refresh_s`` (``recsys.service.app.ServiceConfig.
author_prior_refresh_s``) — real background cost, stated plainly rather than
rounded down, and still comfortably a BACKGROUND cost: it never lands inside
a request, unlike the 15-36s (or outright timeout) this whole module exists
to keep off the request path.

PER-CHUNK FAILURE ISOLATION (added after the 5-consecutive-timeout finding
above): :func:`build_warm_author_prior_map` catches each chunk's exception
individually rather than letting one failure discard the whole build — see
that function's own docstring for why. This is the primary defense against
residual mirror-load variance; the ``chunk_size`` default is a secondary one.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from recsys.config import HafsqlConfig, LiteConfig, Settings
from recsys.contracts import HafsqlGateway
from recsys.core.scoring import AuthorEngagement, AuthorPriorGateway
from recsys.core.vote_signal import VoterTrust

# ★ See the module docstring's "MIRRORS _author_priors EXACTLY" section for
# why these three private names are imported rather than re-derived. This is
# the one non-public import in the file, kept together so the coupling is
# easy to spot in review — the same convention ``recsys/norm_builder.py``
# already uses for its own import of ``recsys.pipeline._organic_signal``.
from recsys.pipeline import TrustSnapshot, _lineage_for, _ring_exclusion, _voter_trust

logger = logging.getLogger("recsys.author_prior_cache")

#: Live-measured 2026-08-04 (see module docstring's "WARM-SET SCOPE" section
#: for the full sweep, INCLUDING the 40-author size that was tried first and
#: rejected after live instability). 25 tested consistently fast (three
#: consecutive live runs, 2.51-2.53s) with real margin below where 40 was
#: observed to become unreliable under the shared mirror's own load variance.
DEFAULT_CHUNK_SIZE = 25

#: How far back to look for "who could plausibly be a candidate author"
#: (warm-set discovery). Mirrors ``settings.history.in_network_freshness_days``
#: — the widest candidate-sourcing horizon any lane in ``gather_candidates``
#: uses (IN_NETWORK). A caller with a live ``Settings`` should prefer
#: ``settings.history.in_network_freshness_days`` over this constant; it
#: exists so this module has a sane default with no ``Settings`` in hand.
DEFAULT_DISCOVERY_DAYS = 7

#: Hard ceiling on the warm-set size, independent of how many distinct
#: authors the discovery query finds. Live-measured 2026-08-04: 2,227
#: distinct authors posted in the trailing 7 days on the real network — this
#: default leaves real headroom for network growth before it would ever
#: bind. If it DOES bind, discovery falls back to the busiest N authors
#: (``ORDER BY post count DESC LIMIT``) — see ``discover_recent_authors``.
DEFAULT_DISCOVERY_LIMIT = 6000

# Deliberately the base table, not the ``hafsql.comments`` view
# ``_top_level_or_lite`` reads elsewhere in this package — this is a pure
# COUNT/GROUP BY aggregate with no lite-post substitution need (a lite
# author's "who posted recently" identity is resolved downstream, the same
# place ``_SQL_AUTHOR_ENGAGEMENT`` itself resolves it — this query only
# decides WHICH names to ask the warm build about, and a lite writer's
# `lumen_user_id` never appears in `hafsql.comments_table.author` regardless
# of which table this reads, so nothing is lost by using the plain one).
# Live-measured 2026-08-04: 0.27-0.31s for a 3-7 day window — see
# ``tests/test_hafsql_live.py``'s own structural-floor diagnostic, which
# uses this exact table/shape for the same reason (a cheap, sargable,
# single-table aggregate, not the correlated-subquery pattern
# ``_SQL_AUTHOR_ENGAGEMENT``/``_SQL_POPULAR_POSTS`` pay per candidate post).
_SQL_RECENT_AUTHORS = """
SELECT author FROM (
    SELECT author, count(*) AS n
    FROM hafsql.comments_table
    WHERE parent_author = '' AND deleted = false AND created >= %(since)s
    GROUP BY author
    ORDER BY n DESC
    LIMIT %(limit)s
) busiest
"""

# ★★ 2026-08-05 POST-CLOSEOUT COUNCIL. The comment above this pair is CORRECT
# that widening the predicate to `parent_author = '' OR <lite post>` buys
# nothing — a lite post's `author` column holds the PUBLISHER account, never the
# writer — but it drew the wrong conclusion from it ("nothing is lost"). What is
# lost is the writer: a lite identity lives in `json_metadata->>'lumen_user_id'`
# and appears in NO branch of the plain query, so a lite writer never enters the
# warm author universe at all. The cache is deliberately cache-only with no
# fetch-on-miss (see this module's MISS POLICY), so "not discovered" means "no
# pooled quality prior, permanently" — every lite post falls back to its own
# engagement forever, while a Hive author starts earning a prior from their
# second post.
#
# That is backwards for this product: Lumen's OWN signups (Gmail/BTC/EVM) are
# all lite, so the platform's own writers were the ones structurally denied a
# track record.
#
# The downstream prior query already resolves lite identity correctly
# (`io/hafsql.py`'s `_SQL_AUTHOR_ENGAGEMENT` lite branch selects
# `lumen_user_id AS identity` and groups on it) — discovery was the only place
# it was missing. Same provenance check as that branch: BOTH `author` and
# `parent_author` must be a configured publisher, so the trust boundary is
# `LiteConfig.publisher_accounts`, exactly as documented there.
#
# The plain query above is kept and still used verbatim whenever lite sourcing
# is off, so the measured 0.27-0.31s path is untouched for a deploy with no lite
# publishers configured. Only a lite-enabled deploy pays the union.
_SQL_RECENT_AUTHORS_WITH_LITE = """
SELECT author FROM (
    SELECT author, count(*) AS n
    FROM (
        SELECT author
        FROM hafsql.comments_table
        WHERE parent_author = '' AND deleted = false AND created >= %(since)s
        UNION ALL
        SELECT c.json_metadata->>'lumen_user_id' AS author
        FROM hafsql.comments c
        WHERE c.author = ANY(%(lite_publishers)s)
          AND c.parent_author = ANY(%(lite_publishers)s)
          AND c.json_metadata->>'app' = %(lite_app)s
          AND c.json_metadata->>'lumen_user_id' IS NOT NULL
          AND c.deleted = false
          AND c.created >= %(since)s
    ) posts
    GROUP BY author
    ORDER BY n DESC
    LIMIT %(limit)s
) busiest
"""


def discover_recent_authors(
    config: HafsqlConfig,
    since: datetime,
    limit: int = DEFAULT_DISCOVERY_LIMIT,
    *,
    lite: LiteConfig | None = None,
) -> tuple[str, ...]:
    """The warm-set author universe: distinct top-level-post authors since
    ``since``, ordered BUSIEST-FIRST (descending post count) and capped at
    ``limit`` (see :data:`DEFAULT_DISCOVERY_LIMIT` for why the cap is a
    safety rail, not an expected-to-bind value today).

    Returns an ORDERED tuple, not a set — :func:`build_warm_author_prior_map`
    chunks in exactly this order, and the order is load-bearing (see that
    function's own docstring for why chunking any OTHER way — alphabetical
    included — was measured to be a real risk, not a style choice).

    Deliberately bypasses the :class:`~recsys.contracts.HafsqlGateway`
    Protocol — neither ``window_posts`` nor ``popular_posts`` fit this need:
    both FULLY HYDRATE every returned post (votes, comments, rebloggers,
    reputations — see their own docstrings' live-measured hydration costs),
    which this call does not need at all; it only wants author NAMES. A bare
    aggregate query is ~50-100x cheaper than either (0.27-0.31s vs. multiple
    seconds to tens of seconds) for exactly the reason those two docstrings
    already document: hydration cost scales with vote volume, not row count.
    ``tests/test_hafsql_live.py``'s own structural-floor diagnostic already
    establishes this exact pattern (a direct ``psycopg.connect`` using
    ``HafsqlConfig``'s fields) for the identical reason — a lightweight,
    purpose-built read the Protocol has no method for.

    ``psycopg`` is imported lazily inside this function, matching
    ``recsys/io/hafsql.py``'s own module-level discipline ("Importing this
    module must never require psycopg"), so importing
    ``recsys.author_prior_cache`` never requires the ``io`` extra either.
    """
    import psycopg

    with (
        psycopg.connect(
            host=config.host,
            port=config.port,
            dbname=config.dbname,
            user=config.user,
            password=config.password,
            connect_timeout=config.connect_timeout,
            autocommit=True,
        ) as conn,
        conn.cursor() as cur,
    ):
        # ★ Lite writers are only discoverable through the union form (see
        # `_SQL_RECENT_AUTHORS_WITH_LITE`). With no publishers configured the
        # lite branch could only ever match zero rows, so the plain query runs
        # unchanged and keeps its measured plan.
        if lite is not None and lite.enabled:
            cur.execute(
                _SQL_RECENT_AUTHORS_WITH_LITE,
                {
                    "since": since,
                    "limit": limit,
                    "lite_publishers": sorted(lite.publisher_accounts),
                    "lite_app": lite.app_id,
                },
            )
        else:
            cur.execute(_SQL_RECENT_AUTHORS, {"since": since, "limit": limit})
        return tuple(row[0] for row in cur.fetchall())


def build_warm_author_prior_map(
    gateway: AuthorPriorGateway,
    warm_authors: Sequence[str],
    since: datetime,
    excluded: Mapping[str, frozenset[str]] | None,
    trust: VoterTrust | None,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> dict[str, AuthorEngagement]:
    """Fetch :class:`~recsys.core.scoring.AuthorEngagement` for
    ``warm_authors`` via CHUNKED calls to ``gateway.author_engagement`` — see
    the module docstring's cost table for why ``chunk_size`` is bounded well
    under the point where a single call risks the 15s statement timeout.

    ★ CHUNKED IN THE ORDER ``warm_authors`` IS GIVEN — deliberately NOT
    re-sorted here (2026-08-04, corrected after a live measurement caught
    this). The cost sweep this module's docstring cites (10/20/.../100
    authors, busiest-first) was run against the WORST-CASE ordering — every
    prolific author front-loaded into the same chunk — specifically so
    ``chunk_size``'s safety margin holds regardless of which ``chunk_size``
    authors a real chunk contains. An earlier draft of this function SORTED
    ``warm_authors`` ALPHABETICALLY before chunking instead, which is not
    neutral: this network's busiest accounts include a same-prefix cluster
    (``guest06``..``guest10``, several hundred posts each in the 45-day
    window) that alphabetical order packs into ONE chunk — the opposite of
    the diversified worst case the sweep validated, and a live end-to-end
    timing run on the alphabetical version ran far longer than the sweep
    predicted before this was caught and fixed. Busiest-first (what
    :func:`discover_recent_authors` returns) keeps every chunk AT MOST as
    busy as the validated worst case, by construction: chunk 0 is the ``[0,
    chunk_size)`` busiest authors (exactly what was measured), and every
    later chunk is less busy than that, never more.

    ★ PER-CHUNK FAILURE IS ISOLATED, NOT FATAL TO THE WHOLE BUILD (found
    2026-08-04, live, this builder — not theorized; see the module
    docstring's "40 WAS THE FIRST CHOICE AND WAS REJECTED" section for the
    full finding). At ``chunk_size=40`` (the FIRST choice, since lowered to
    the shipped :data:`DEFAULT_CHUNK_SIZE` after this was found), one
    busiest-40 chunk hit ``psycopg.errors.QueryCanceled`` on a run where an
    identical chunk had succeeded comfortably inside the timeout moments
    earlier in an isolated retest — the shared public mirror's own
    documented run-to-run load variance (see ``recsys/io/hafsql.py``'s PERF
    comment), not a sizing error, and not something ANY fixed ``chunk_size``
    can fully rule out on a variable-load shared server. A single
    ``try/except`` around the WHOLE loop would have meant one unlucky chunk
    discards every other chunk's already-fetched priors on every refresh
    cycle — the opposite of resilient. Each chunk is therefore caught
    individually: a failed chunk is logged at WARNING and skipped, its
    authors simply absent from this build's result (the same honest
    no-prior-for-this-author degrade :class:`AuthorPriorCache` already
    documents for a cache miss — a chunk failure just produces misses a
    cycle sooner than "not in the warm set at all" would have), while every
    OTHER chunk's real, successfully-fetched data still lands in the cache.
    """
    if not warm_authors:
        return {}
    result: dict[str, AuthorEngagement] = {}
    n_chunks = (len(warm_authors) + chunk_size - 1) // chunk_size
    failed_chunks = 0
    for chunk_idx, i in enumerate(range(0, len(warm_authors), chunk_size)):
        chunk = frozenset(warm_authors[i : i + chunk_size])
        try:
            result.update(gateway.author_engagement(chunk, since, excluded, trust=trust))
        except Exception:
            failed_chunks += 1
            logger.warning(
                "author_prior warm build: chunk %d/%d (%d authors) failed — "
                "skipping it this cycle; its authors are misses in this "
                "build's result, not a reason to discard whatever other "
                "chunks are fetched successfully.",
                chunk_idx + 1,
                n_chunks,
                len(chunk),
                exc_info=True,
            )
    if failed_chunks:
        logger.warning(
            "author_prior warm build: %d/%d chunks failed this cycle "
            "(%d authors requested, %d priors returned)",
            failed_chunks,
            n_chunks,
            len(warm_authors),
            len(result),
        )
    return result


def build_warm_author_priors(
    gateway: HafsqlGateway,
    hafsql_config: HafsqlConfig,
    settings: Settings,
    snapshot_fn: Callable[[], TrustSnapshot | None],
    *,
    now_fn: Callable[[], datetime] = lambda: datetime.now(UTC),
    discovery_days: int | None = None,
    discovery_limit: int = DEFAULT_DISCOVERY_LIMIT,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> dict[str, AuthorEngagement]:
    """The full warm-build pipeline: discover the candidate-author universe,
    build the SAME §8.4 exclusion set + H05 breadth budget
    ``recsys.pipeline._author_priors`` would build for a live request (from
    whatever :class:`~recsys.pipeline.TrustSnapshot` ``snapshot_fn`` returns
    right now — an empty snapshot, same as a fresh/no-batch-yet
    ``TrustSnapshot()``, degrades to self-exclusion-only + no breadth budget,
    matching ``_author_priors``'s own no-snapshot behaviour exactly), then
    fetch priors over ``settings.history.quality_prior_days`` (the SAME
    window ``rank_feed`` computes ``quality_since`` from — see
    ``recsys.pipeline.rank_feed``'s own comment above its
    ``_author_priors`` call).

    Returns ``{}`` (never raises for this reason) when ``gateway`` does not
    implement :class:`~recsys.core.scoring.AuthorPriorGateway` — the same
    honest-degrade posture ``_author_priors`` itself documents.

    This is the function a caller (``recsys.service.app.ServiceState``)
    wires up as an :class:`AuthorPriorCache`'s ``builder`` — see that
    class's own docstring for the timer/refresh discipline this runs under.
    """
    if not isinstance(gateway, AuthorPriorGateway):
        return {}
    now = now_fn()
    days = discovery_days if discovery_days is not None else DEFAULT_DISCOVERY_DAYS
    since_discovery = now - timedelta(days=days)
    # ★ `settings.lite` threaded 2026-08-05: without it a lite writer is never
    # discovered, so never warmed, so permanently prior-less (see
    # `_SQL_RECENT_AUTHORS_WITH_LITE`). The same `settings` this function
    # already uses for every other window.
    warm_authors = discover_recent_authors(
        hafsql_config, since_discovery, discovery_limit, lite=settings.lite
    )
    if not warm_authors:
        return {}
    snap = snapshot_fn() or TrustSnapshot()
    lineage_cache: dict[str, frozenset[str]] = {}
    lineage = _lineage_for(gateway, warm_authors, lineage_cache)
    excluded = {
        author: lin | _ring_exclusion(author, snap) | {author}
        for author, lin in lineage.items()
    }
    trust = _voter_trust(snap, settings)
    quality_since = now - timedelta(days=settings.history.quality_prior_days)
    return build_warm_author_prior_map(
        gateway, warm_authors, quality_since, excluded, trust, chunk_size=chunk_size
    )


@dataclass(frozen=True)
class AuthorPriorCacheStats:
    """Observability snapshot for :class:`AuthorPriorCache` — wired into
    ``recsys.service.app.health_payload`` so a cache-miss regression (the
    "silent miss that quietly changes 80% of the score" class of defect the
    build brief calls out) is visible on ``/health``, not just in logs."""

    authors_cached: int
    build_count: int
    build_failures: int
    last_built_wall: datetime | None
    age_s: float | None
    refresh_s: float
    #: Cumulative since process start — never reset, so a slow miss-rate
    #: creep is visible across the process lifetime, not just the last call.
    authors_requested: int
    authors_hit: int
    authors_missed: int
    #: ``None`` before the first ``get()`` call (nothing requested yet).
    miss_rate: float | None
    #: A bounded sample of recently-missed author names, for a human
    #: reading ``/health`` to recognize a pattern (e.g. "these are all posts
    #: from the last few minutes" -> expected; "these are established
    #: accounts" -> the warm set/refresh cadence needs attention).
    last_miss_sample: tuple[str, ...]


class AuthorPriorCache:
    """Builds ``dict[str, AuthorEngagement]`` once (blocking, via
    :meth:`warm`), then refreshes it on a background daemon thread every
    ``refresh_s`` seconds — the SAME build-once-refresh-on-a-timer,
    never-inside-a-request discipline as
    ``recsys.service.app._TimerCache`` (this class is deliberately a
    separate, self-contained implementation rather than importing that one:
    ``_TimerCache`` lives in ``recsys.service.app``, which must import THIS
    module to wire the cache into :class:`~recsys.service.app.ServiceState`
    — importing back would be circular. The two classes are kept in lockstep
    by convention, not by sharing code; ``tests/test_service.py``'s
    ``_TimerCache`` tests and this module's own tests both pin the same
    warm/refresh/stop contract.)

    The one thing this cache does that ``_TimerCache`` does not: ``get()``
    is a per-author lookup with observable hit/miss accounting — see the
    module docstring's "MISS POLICY" section for why a miss is silent in
    the RETURNED VALUE (the caller's existing no-prior fallback) but never
    silent in aggregate (every call updates :meth:`stats`, and every call
    with at least one miss logs a WARNING).
    """

    def __init__(
        self,
        name: str,
        builder: Callable[[], dict[str, AuthorEngagement]],
        refresh_s: float,
    ) -> None:
        self._name = name
        self._builder = builder
        self._refresh_s = refresh_s
        self._lock = threading.Lock()
        self._value: dict[str, AuthorEngagement] | None = None
        self._last_built_monotonic: float | None = None
        self._last_built_wall: datetime | None = None
        self.build_count = 0
        self.build_failures = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._authors_requested = 0
        self._authors_hit = 0
        self._authors_missed = 0
        self._last_miss_sample: tuple[str, ...] = ()

    def warm(self, *, guard: bool = True) -> None:
        """Blocking initial build, called before the server accepts any
        connections. ``guard=True`` (the default here — unlike
        ``_TimerCache``'s norm-context default) logs-and-continues (leaving
        ``value`` at ``None``, so every ``get()`` is a documented miss) on
        failure: a cold-start process with no author-prior cache yet is the
        SAME honest degrade ``_author_priors`` already has for a gateway
        that returns nothing — never a reason to refuse to boot, unlike the
        NormContext (a `rank_feed` call is impossible without one at all)."""
        try:
            self._rebuild()
        except Exception:
            self.build_failures += 1
            if guard:
                logger.exception(
                    "%s: initial build failed — starting with an EMPTY warm "
                    "cache; every author is a documented miss (falls back to "
                    "its own post's engagement) until the next successful "
                    "background refresh.",
                    self._name,
                )
                return
            raise

    def start_background_refresh(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._loop, name=f"{self._name}-refresh", daemon=True
        )
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.wait(self._refresh_s):
            try:
                self._rebuild()
            except Exception:
                self.build_failures += 1
                logger.exception(
                    "%s: background refresh failed — keeping the last-known-good "
                    "cached value (age %.0fs); a transient failure must never "
                    "silently discard a good cache.",
                    self._name,
                    self.age_s if self.age_s is not None else -1.0,
                )

    def _rebuild(self) -> None:
        value = self._builder()
        with self._lock:
            self._value = value
            self._last_built_monotonic = time.monotonic()
            self._last_built_wall = datetime.now(UTC)
            self.build_count += 1
        logger.info("%s: warmed %d author priors", self._name, len(value))

    @property
    def value(self) -> dict[str, AuthorEngagement] | None:
        with self._lock:
            return self._value

    @property
    def last_built_wall(self) -> datetime | None:
        with self._lock:
            return self._last_built_wall

    @property
    def age_s(self) -> float | None:
        with self._lock:
            if self._last_built_monotonic is None:
                return None
            return time.monotonic() - self._last_built_monotonic

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def get(self, authors: frozenset[str]) -> dict[str, AuthorEngagement]:
        """Cache-only lookup — NEVER blocks on a live query, NEVER falls
        through to ``gateway.author_engagement``. Returns priors for
        whichever of ``authors`` are in the warm set; the rest are simply
        absent from the returned mapping (the caller's existing
        no-prior-for-this-author fallback applies — see the module
        docstring's MISS POLICY section for why this is a deliberate,
        conservative choice rather than a bounded fetch-on-miss).

        Every call updates the cumulative counters :meth:`stats` reports,
        and logs at WARNING (with a capped sample of the missed author
        names) whenever ``authors`` includes at least one miss — a miss is
        never silent in aggregate, even though it is silent in the single
        returned value (by design: that value IS the documented degrade)."""
        if not authors:
            return {}
        snapshot = self.value or {}
        hits = {a: snapshot[a] for a in authors if a in snapshot}
        misses = authors - snapshot.keys()
        with self._lock:
            self._authors_requested += len(authors)
            self._authors_hit += len(hits)
            self._authors_missed += len(misses)
            if misses:
                self._last_miss_sample = tuple(sorted(misses)[:20])
        if misses:
            sample = sorted(misses)
            logger.warning(
                "%s: %d/%d requested authors missed the warm cache (%s%s) — "
                "those authors fall back to their own post's engagement, not "
                "the pooled prior (the organic term's 80%% composite weight "
                "is computed on less evidence for their posts this request). "
                "See stats() for the cumulative miss rate.",
                self._name,
                len(misses),
                len(authors),
                ", ".join(sample[:10]),
                f", +{len(sample) - 10} more" if len(sample) > 10 else "",
            )
        return hits

    def stats(self) -> AuthorPriorCacheStats:
        with self._lock:
            value_len = len(self._value) if self._value is not None else 0
            requested = self._authors_requested
            hit = self._authors_hit
            missed = self._authors_missed
            miss_sample = self._last_miss_sample
            last_built_wall = self._last_built_wall
            last_built_monotonic = self._last_built_monotonic
            build_count = self.build_count
            build_failures = self.build_failures
        age_s = None if last_built_monotonic is None else time.monotonic() - last_built_monotonic
        miss_rate = (missed / requested) if requested else None
        return AuthorPriorCacheStats(
            authors_cached=value_len,
            build_count=build_count,
            build_failures=build_failures,
            last_built_wall=last_built_wall,
            age_s=age_s,
            refresh_s=self._refresh_s,
            authors_requested=requested,
            authors_hit=hit,
            authors_missed=missed,
            miss_rate=miss_rate,
            last_miss_sample=miss_sample,
        )


__all__ = [
    "DEFAULT_CHUNK_SIZE",
    "DEFAULT_DISCOVERY_DAYS",
    "DEFAULT_DISCOVERY_LIMIT",
    "AuthorPriorCache",
    "AuthorPriorCacheStats",
    "build_warm_author_prior_map",
    "build_warm_author_priors",
    "discover_recent_authors",
]
