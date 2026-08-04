"""HAFSQL/Postgres gateway (§S7, Appendix B) — the only module that talks to a
database. Importing this module must never require ``psycopg``; the driver is
imported lazily inside :meth:`HafsqlClient._connect` so the pure scoring core
stays importable without the ``io`` extra installed. Live queries run against
the public mirror ``hafsql-sql.mahdiyari.info`` and are exercised later.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Any

from recsys.config import HafsqlConfig, LiteConfig
from recsys.contracts import Candidate, CandidateSource, EngagementEdge, Post, Vote
from recsys.core.scoring import AuthorEngagement
from recsys.core.vote_signal import AttributedPost, VoterTrust

if TYPE_CHECKING:
    import psycopg

# Reputation display formula (Appendix B: "the reputation-int->display constant
# 9*log10(raw)-56"; CombFlow documents a past bug from getting this wrong).
# Equivalent to hivemind's `(max(log10(|raw|) - 9, 0)) * 9 + 25`, signed.
_REP_LOG_FLOOR = 9.0
_REP_SCALE = 9.0
_REP_BASE = 25.0

# author, permlink, category, created, tags, lite_author
# ``lite_author`` is `json_metadata->>'lumen_user_id'` and is NULL for every
# ordinary Hive post. It is trusted only because the SQL that selects it also
# requires the chain author to be a configured Lumen publisher — see
# `_LITE_POST` and `LiteConfig`.
_PostRow = tuple[str, str, str, datetime, "list[str] | None", "str | None"]

# A Lumen Lite post: a depth-1 comment published by a configured publisher
# account under its own container, carrying the writer's id in json_metadata.
# Both the author AND the parent must be publishers — json_metadata is
# attacker-controlled, so the claim is only honoured inside our own containers.
# With `lite_publishers` empty, `= ANY('{}')` is false and lite sourcing is off.
_LITE_POST = """(
    {t}author = ANY(%(lite_publishers)s)
    AND {t}parent_author = ANY(%(lite_publishers)s)
    AND {t}json_metadata->>'app' = %(lite_app)s
    AND {t}json_metadata->>'lumen_user_id' IS NOT NULL
)"""


def _top_level_or_lite(alias: str = "") -> str:
    """`parent_author = ''` widened to also admit our own lite posts."""
    t = f"{alias}." if alias else ""
    return f"({t}parent_author = '' OR {_LITE_POST.format(t=t)})"


def _identity(alias: str = "") -> str:
    """The author identity RANKING uses: the lite writer where present, else the
    chain author. Hydration still keys on the chain author (votes and comments
    are recorded against it); only the ranked identity is substituted."""
    t = f"{alias}." if alias else ""
    return f"COALESCE({t}json_metadata->>'lumen_user_id', {t}author)"

# H05: with no trust snapshot, the breadth budget in _SQL_AUTHOR_ENGAGEMENT
# must never bind — an effectively-infinite unknown_free reproduces the
# pre-H05 raw-distinct-count query for the honest Phase-0 no-snapshot default.
_UNBUDGETED_UNKNOWN_FREE = 1e18

# ---------------------------------------------------------------------------
# SQL — post listings (hafsql.comments; parent_author == '' is a top-level
# post, §3.0; community == category for community-filed posts, on-chain).
# ---------------------------------------------------------------------------

_SQL_IN_NETWORK_POSTS = f"""
SELECT author, permlink, category, created, tags,
       json_metadata->>'lumen_user_id'
FROM hafsql.comments
WHERE {_top_level_or_lite()}
  AND deleted = false
  AND {_identity()} = ANY(%(authors)s)
  AND created >= %(since)s
ORDER BY created DESC
LIMIT %(limit)s
"""

# NOT widened for lite: a comment inherits its category from the container
# root, so every lite post sits in category `lumen` and can never match a
# `hive-*` community. Lite reaches readers via the tag, in-network and engaged
# lanes instead. Property of the container model, not an oversight.
_SQL_COMMUNITY_POSTS = """
SELECT author, permlink, category, created, tags, NULL::text
FROM hafsql.comments
WHERE parent_author = ''
  AND deleted = false
  AND category = ANY(%(communities)s)
  AND created >= %(since)s
ORDER BY created DESC
LIMIT %(limit)s
"""

_SQL_TAG_POSTS = f"""
SELECT author, permlink, category, created, tags,
       json_metadata->>'lumen_user_id'
FROM hafsql.comments
WHERE {_top_level_or_lite()}
  AND deleted = false
  AND tags && %(tags)s
  AND created >= %(since)s
ORDER BY created DESC
LIMIT %(limit)s
"""

# Out-of-network posts an in-network account engaged with (vote, reblog, or
# reply) — the raw pool for the second-degree gate (§8.1).
_SQL_ENGAGED_OON_POSTS = f"""
SELECT DISTINCT c.author, c.permlink, c.category, c.created, c.tags,
       c.json_metadata->>'lumen_user_id'
FROM hafsql.comments c
WHERE {_top_level_or_lite("c")}
  AND c.deleted = false
  AND {_identity("c")} <> ALL(%(follows)s)
  AND c.created >= %(since)s
  AND (
    EXISTS (
        SELECT 1 FROM hafsql.operation_effective_comment_vote_view v
        WHERE v.author = c.author AND v.permlink = c.permlink
          AND v.voter = ANY(%(follows)s)
          AND v.rshares > 0  -- a DOWNVOTE must not vouch an OON post into the feed
    )
    OR EXISTS (
        SELECT 1 FROM hafsql.reblogs r
        WHERE r.author = c.author AND r.permlink = c.permlink
          AND r.account_name = ANY(%(follows)s)
    )
    OR EXISTS (
        SELECT 1 FROM hafsql.operation_comment_view rc
        WHERE rc.parent_author = c.author AND rc.parent_permlink = c.permlink
          AND rc.author = ANY(%(follows)s)
    )
  )
ORDER BY c.created DESC
LIMIT %(limit)s
"""

# ---------------------------------------------------------------------------
# SQL — per-post hydration, batched over a page of (author, permlink) keys via
# a parallel-array unnest join (no per-row round trips, no f-string values).
# ---------------------------------------------------------------------------

_SQL_VOTES_FOR_POSTS = """
SELECT v.author, v.permlink, v.voter, v.rshares, v.timestamp
FROM hafsql.operation_effective_comment_vote_view v
WHERE (v.author, v.permlink) IN (
    SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
)
"""

# Per-commenter attribution (§6): WHO commented and how many times — not a
# bare count. ``rc.author`` is the identity the organic term filters through
# the same exclusion set as votes; summing the per-commenter counts recovers
# the display comment total, so one grouped query serves both.
_SQL_COMMENTS_FOR_POSTS = """
SELECT rc.parent_author, rc.parent_permlink, rc.author, COUNT(*)
FROM hafsql.operation_comment_view rc
WHERE rc.parent_author <> ''
  -- ★ A lite post is a POST that happens to be stored as a comment. Counting it
  -- here credited every lite writer's work to the container's owner, inflating
  -- the publisher account's organic score with the whole Lite tier's output.
  -- COALESCE is load-bearing: `json_metadata` is NULL on plenty of ordinary
  -- comments, `NULL->>'app'` is NULL, and `NOT NULL` is NULL — which Postgres
  -- treats as not-true and FILTERS THE ROW OUT. Without it, enabling lite would
  -- silently drop a publisher's own metadata-less comments from every comment
  -- count. Three-valued logic, failing toward data loss.
  AND NOT COALESCE(
    rc.author = ANY(%(lite_publishers)s)
    AND rc.parent_author = ANY(%(lite_publishers)s)
    AND rc.json_metadata->>'app' = %(lite_app)s
  , false)
  AND (rc.parent_author, rc.parent_permlink) IN (
    SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
  )
GROUP BY rc.parent_author, rc.parent_permlink, rc.author
"""

# Per-reblogger attribution (§6): DISTINCT identities, same rationale.
_SQL_REBLOGGERS_FOR_POSTS = """
SELECT DISTINCT r.author, r.permlink, r.account_name
FROM hafsql.reblogs r
WHERE (r.author, r.permlink) IN (
    SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
)
"""

_SQL_REPUTATIONS_FOR_AUTHORS = """
SELECT account_name, reputation
FROM hafsql.reputations
WHERE account_name = ANY(%(authors)s)
"""

# ---------------------------------------------------------------------------
# SQL — RealGraph engagement edges (§8.3). Mentions and client-side telemetry
# (profile visits, post opens, revisits, dwell) are Phase-1 signals with no
# HAFSQL source and are left at their zero defaults here.
# ---------------------------------------------------------------------------

_SQL_REPLY_EDGES = """
SELECT author, parent_author, COUNT(*), MAX(created)
FROM hafsql.operation_comment_view
WHERE parent_author <> ''
  AND author <> parent_author
  AND created >= %(since)s
GROUP BY author, parent_author
"""

_SQL_UPVOTE_EDGES = """
SELECT voter, author, COUNT(*), MAX(timestamp)
FROM hafsql.operation_effective_comment_vote_view
WHERE rshares > 0
  AND voter <> author
  AND timestamp >= %(since)s
GROUP BY voter, author
"""

_SQL_REBLOG_EDGES = """
SELECT account_name, author, COUNT(*), MAX(created_at)
FROM hafsql.reblogs
WHERE account_name <> author
  AND created_at >= %(since)s
GROUP BY account_name, author
"""

# Stake-lineage (§8.4): accounts directly delegation-tied to `author`, plus
# "common funding source" siblings — other accounts delegated-to by the same
# delegators that fund `author` (catches one-whale-many-puppets).
_SQL_STAKE_LINEAGE = """
WITH direct_delegators AS (
    SELECT delegator FROM hafsql.delegations WHERE delegatee = %(author)s
)
SELECT delegator AS account FROM direct_delegators
UNION
SELECT delegatee AS account FROM hafsql.delegations WHERE delegator = %(author)s
UNION
SELECT delegatee AS account
FROM hafsql.delegations
WHERE delegator IN (SELECT delegator FROM direct_delegators)
  AND delegatee <> %(author)s
"""

# ---------------------------------------------------------------------------
# SQL — second-degree engager index (§8.1): which of the viewer's `follows`
# voted, replied to, or reblogged each OON post key. Batched over a page of
# (author, permlink) keys via the same parallel-array unnest join as the
# hydration queries above.
# ---------------------------------------------------------------------------

_SQL_SECOND_DEGREE_ENGAGERS = """
SELECT author, permlink, engager FROM (
    SELECT v.author, v.permlink, v.voter AS engager
    FROM hafsql.operation_effective_comment_vote_view v
    WHERE (v.author, v.permlink) IN (
        SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
    )
      AND v.voter = ANY(%(follows)s)
      AND v.rshares > 0  -- a followed account's DOWNVOTE is not a second-degree vouch
    UNION
    SELECT rc.parent_author AS author, rc.parent_permlink AS permlink, rc.author AS engager
    FROM hafsql.operation_comment_view rc
    WHERE (rc.parent_author, rc.parent_permlink) IN (
        SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
    )
      AND rc.author = ANY(%(follows)s)
    UNION
    SELECT r.author, r.permlink, r.account_name AS engager
    FROM hafsql.reblogs r
    WHERE (r.author, r.permlink) IN (
        SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
    )
      AND r.account_name = ANY(%(follows)s)
) engagements
"""

# Follow graph (§8.3): follower -> followee edges, restricted to the given
# account set (graph-cred only needs the sub-graph induced by the accounts
# already involved in the engagement edges it's scoring).
_SQL_FOLLOW_GRAPH = """
SELECT follower_name, following_name
FROM hafsql.follows
WHERE follower_name = ANY(%(accounts)s)
  AND following_name = ANY(%(accounts)s)
"""

# Popular-posts fallback (§13.5b): recent top-level posts ranked by the same
# ATTRIBUTED distinct-identity signal the organic term scores (§6) — distinct
# non-self voters above the chain-dust floor (1e7 rshares, mirroring
# recsys.core.vote_signal._ORGANIC_VOTER_MIN_RSHARES), distinct non-self
# commenters, and distinct non-self rebloggers, weighted 0.5/0.3/0.5 to match
# the organic weights. Deliberately NOT payout/net_rshares (so the fallback
# isn't "trending" reimplemented) and NEVER the raw self-farmable counters
# (total comment count, total reblog count, self-votes included) that the
# attribution fix declares untrustworthy — the fallback pool must not be
# orderable by the very signals scoring refuses to trust.
#
# This ORDER BY is a COARSE PRE-FETCH ONLY. Stake-lineage and ring exclusion
# need the weekly trust snapshot, which this query cannot see, so a
# lineage/ring farm can still inflate this self-excluded distinct count. That
# is why the authoritative exclusion is applied downstream, NOT here: the
# pipeline re-orders the fetched pool by the FULL §8.4 exclusion set
# (recsys.pipeline._order_by_full_exclusion) before selecting padding, and
# re-scores the selected padding under the same exclusions. What SQL enforces
# cheaply — self-exclusion, distinctness, the chain-dust floor — bounds which
# posts are fetched; the snapshot-dependent lineage/ring exclusion decides
# which survive. Both layers use identical weights and thresholds so the
# pre-fetch never contradicts the authoritative pass, only widens it.
_SQL_POPULAR_POSTS = f"""
SELECT c.author, c.permlink, c.category, c.created, c.tags,
       c.json_metadata->>'lumen_user_id'
FROM hafsql.comments c
WHERE {_top_level_or_lite("c")}
  AND c.deleted = false
  AND c.created >= %(since)s
ORDER BY (
    0.5 * (SELECT COUNT(DISTINCT v.voter)
           FROM hafsql.operation_effective_comment_vote_view v
           WHERE v.author = c.author AND v.permlink = c.permlink
             AND v.rshares > 10000000 AND v.voter <> c.author)
    + 0.3 * (SELECT COUNT(DISTINCT rc.author)
             FROM hafsql.operation_comment_view rc
             WHERE rc.parent_author = c.author AND rc.parent_permlink = c.permlink
               AND rc.author <> c.author)
    + 0.5 * (SELECT COUNT(DISTINCT r.account_name)
             FROM hafsql.reblogs r
             WHERE r.author = c.author AND r.permlink = c.permlink
               AND r.account_name <> c.author)
) DESC, c.created DESC
LIMIT %(limit)s
"""

# Author-pooled engagement prior (§6): one grouped aggregate per candidate
# author over the window. For each of an author's top-level window posts, the
# same ATTRIBUTED distinct-identity signal the organic term scores —
# 0.5*distinct voters above the chain-dust floor + 0.3*distinct commenters +
# 0.5*distinct rebloggers (weights/threshold mirror
# recsys.core.vote_signal._ORGANIC_*_WEIGHT and _ORGANIC_VOTER_MIN_RSHARES) —
# log-compressed exactly as post_base_engagement does, then SUMmed:
# AuthorEngagement.total_base is that sum, posts the count.
#
# Every engager is filtered through the FULL §8.4 exclusion set, so an author
# cannot farm their own pooled prior with self-engagement, delegation-tied
# alts or a reciprocal ring (the input the earlier self-exclusion-ONLY
# aggregate left unguarded). Self-exclusion is the static `<> c.author`
# predicate. Stake-lineage and ring identities are snapshot-dependent and
# invisible to SQL, so — exactly as the vote signal derives them per request
# and hands them to independent_organic_engagement — the caller passes them in
# as parallel (author, excluded_account) arrays and each per-post distinct
# count anti-joins its own author's excluded set. Empty arrays (no snapshot)
# degrade to self-exclusion only.
#
# H05 (2026-07-22): exclusion alone still left the breadth term un-budgeted —
# an author's OTHER window posts could be farmed by unknown-tier sock upvotes
# that pass every §8.4 exclusion (a funded alt is not the author, not lineage,
# not a reciprocal ring), inflating total_base and, through the leave-one-out
# mean, the pooled organic prior (organic 0->1.0, proven). Each channel's
# distinct-identity count is now split into vouched (`vn`, full credit) and
# unknown (`un`, budgeted) via `FILTER`, and credited exactly as
# recsys.core.vote_signal.VoterTrust.credited_breadth does:
# `vn + LEAST(un, unknown_free + unknown_per_vouched * vn)`. `%(vouched)s` is
# the same vouched-account set the pipeline derives from graph-cred
# (`recsys.pipeline._voter_trust`); `%(unknown_free)s` / `%(unknown_per_vouched)s`
# are `VoteSignalConfig.unknown_free` / `.unknown_per_vouched`. With no trust
# snapshot the caller passes `vouched=[]`, `unknown_free=1e18`,
# `unknown_per_vouched=0` — the budget never binds and the query collapses
# to the pre-H05 raw distinct count, so ONE query serves both cases (see
# `HafsqlClient.author_engagement`).
#
# Also new in H05: an eligibility/flooding join. A post already suppressed
# by network_suppression (§8.7) never feeds the prior — flooding an author's
# window with empty/suppressed posts cannot dilute or pad the aggregate.
# FLOODING with genuinely engaged posts is bounded structurally elsewhere: the
# per-post budget above caps credit WITHIN a post, and the leave-one-out MEAN
# (pooled_author_base, dividing by posts - 1) averages across posts, so
# padding with low/no-engagement posts dilutes toward the noise floor rather
# than accumulating.
#
# own_base (the scorer, per candidate) and total_base (here) now carry the
# SAME two guards — §8.4 exclusion and the VoterTrust breadth budget — so they
# are consistent; pooled_author_base's leave-one-out clamp is pure
# defense-in-depth (aggregate/hydration skew), not the primary budget-residual
# absorber it was before this fix — see recsys.core.scoring.AuthorPriorGateway.
_SQL_AUTHOR_ENGAGEMENT = """
SELECT c.author,
       COUNT(*) AS posts,
       SUM(LOG(10, 1 + (
           0.5 * (
               SELECT vn + LEAST(un, %(unknown_free)s + %(unknown_per_vouched)s * vn)
               FROM (
                   SELECT
                       COUNT(DISTINCT v.voter)
                           FILTER (WHERE v.voter = ANY(%(vouched)s)) AS vn,
                       COUNT(DISTINCT v.voter)
                           FILTER (WHERE NOT (v.voter = ANY(%(vouched)s))) AS un
                   FROM hafsql.operation_effective_comment_vote_view v
                   WHERE v.author = c.author AND v.permlink = c.permlink
                     AND v.rshares > 10000000 AND v.voter <> c.author
                     AND NOT EXISTS (
                         SELECT 1 FROM unnest(%(excl_authors)s::text[],
                                              %(excl_accounts)s::text[]) AS e(author, account)
                         WHERE e.author = c.author AND e.account = v.voter)
               ) credited_voters
           )
         + 0.3 * (
               SELECT vn + LEAST(un, %(unknown_free)s + %(unknown_per_vouched)s * vn)
               FROM (
                   SELECT
                       COUNT(DISTINCT rc.author)
                           FILTER (WHERE rc.author = ANY(%(vouched)s)) AS vn,
                       COUNT(DISTINCT rc.author)
                           FILTER (WHERE NOT (rc.author = ANY(%(vouched)s))) AS un
                   FROM hafsql.operation_comment_view rc
                   WHERE rc.parent_author = c.author AND rc.parent_permlink = c.permlink
                     AND rc.author <> c.author
                     AND NOT EXISTS (
                         SELECT 1 FROM unnest(%(excl_authors)s::text[],
                                              %(excl_accounts)s::text[]) AS e(author, account)
                         WHERE e.author = c.author AND e.account = rc.author)
               ) credited_commenters
           )
         + 0.5 * (
               SELECT vn + LEAST(un, %(unknown_free)s + %(unknown_per_vouched)s * vn)
               FROM (
                   SELECT
                       COUNT(DISTINCT r.account_name)
                           FILTER (WHERE r.account_name = ANY(%(vouched)s)) AS vn,
                       COUNT(DISTINCT r.account_name)
                           FILTER (WHERE NOT (r.account_name = ANY(%(vouched)s))) AS un
                   FROM hafsql.reblogs r
                   WHERE r.author = c.author AND r.permlink = c.permlink
                     AND r.account_name <> c.author
                     AND NOT EXISTS (
                         SELECT 1 FROM unnest(%(excl_authors)s::text[],
                                              %(excl_accounts)s::text[]) AS e(author, account)
                         WHERE e.author = c.author AND e.account = r.account_name)
               ) credited_rebloggers
           )
       ))) AS total_base
FROM hafsql.comments c
WHERE c.parent_author = ''
  AND c.deleted = false
  AND c.author = ANY(%(authors)s)
  AND c.created >= %(since)s
  AND NOT EXISTS (
      SELECT 1 FROM network_suppression ns
      WHERE ns.author = c.author AND ns.permlink = c.permlink AND ns.suppressed
  )
GROUP BY c.author
"""

# Network suppression (§8.7) — recsys's own report-processing table
# (``recsys/db/schema.sql``), not a HAFSQL view: which of a page of post keys
# have crossed the weighted-flag threshold.
_SQL_SUPPRESSED_KEYS = """
SELECT author, permlink
FROM network_suppression
WHERE suppressed = true
  AND (author, permlink) IN (
    SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
  )
"""


def _reputation_display(raw: int) -> float:
    """hivemind-equivalent raw→display reputation (Appendix B constant)."""
    if raw == 0:
        return _REP_BASE
    sign = 1.0 if raw > 0 else -1.0
    magnitude = max(math.log10(abs(raw)) - _REP_LOG_FLOOR, 0.0)
    return sign * (magnitude * _REP_SCALE + _REP_BASE)


def _latest(*timestamps: datetime | None) -> datetime | None:
    """The most recent of several optional timestamps, or ``None``."""
    present = [t for t in timestamps if t is not None]
    return max(present) if present else None


def _split_keys(post_keys: frozenset[str]) -> tuple[list[str], list[str]]:
    """Parse ``Post.key`` strings (``"@author/permlink"``) into parallel
    author/permlink arrays for a batched ``unnest`` join."""
    authors: list[str] = []
    permlinks: list[str] = []
    for key in post_keys:
        author, _, permlink = key.removeprefix("@").partition("/")
        authors.append(author)
        permlinks.append(permlink)
    return authors, permlinks


def _build_post(
    row: _PostRow,
    votes_by_key: dict[tuple[str, str], list[Vote]],
    comments_by_key: dict[tuple[str, str], dict[str, int]],
    rebloggers_by_key: dict[tuple[str, str], tuple[str, ...]],
    reputation_by_author: dict[str, int],
) -> Post:
    """Map one ``hafsql.comments`` row plus its hydrated side-tables to an
    :class:`AttributedPost`. ``children``/``reblog_count`` are DERIVED from the
    attribution maps (total comments, distinct rebloggers), so the display
    counters and the scored identities can never disagree."""
    author, permlink, category, created, tags, lite_author = row
    # Hydration keys on the CHAIN identity — votes, comments and reblogs are all
    # recorded against the publisher account + permlink on chain. Only the
    # ranked identity is substituted.
    key = (author, permlink)
    community = category if category.startswith("hive-") else None
    tag_tuple = tuple(tags or ())
    comment_counts = comments_by_key.get(key, {})
    rebloggers = rebloggers_by_key.get(key, ())
    # ★ A lite writer has no Hive account and therefore no reputation. Taking
    # the publisher's would be wrong in both directions: every lite user would
    # free-ride on a shared score they did not earn, and one bad lite post would
    # drag down every other lite user at once. They get the same neutral display
    # reputation Hive gives a brand-new account, which is what they are.
    reputation_raw = 0 if lite_author else reputation_by_author.get(author, 0)
    return AttributedPost(
        author=lite_author or author,
        permlink=permlink,
        category=category,
        community=community,
        created=created,
        children=sum(comment_counts.values()),
        reblog_count=len(rebloggers),
        author_reputation=_reputation_display(reputation_raw),
        tags=tag_tuple,
        votes=tuple(votes_by_key.get(key, ())),
        is_nsfw=any(tag.lower() == "nsfw" for tag in tag_tuple),
        commenters=tuple(sorted(comment_counts)),
        rebloggers=rebloggers,
    )


class HafsqlClient:
    """Concrete ``HafsqlGateway`` backed by the public HAFSQL Postgres mirror."""

    def __init__(self, config: HafsqlConfig, lite: LiteConfig | None = None) -> None:
        self._config = config
        # Lumen Lite reachability. Defaults to OFF (no publisher accounts), so
        # every lite predicate evaluates false and the SQL behaves exactly as it
        # did before lite existed. See `LiteConfig` for the trust boundary.
        self._lite = lite if lite is not None else LiteConfig()

    def _connect(self) -> psycopg.Connection[Any]:
        """Open a HAFSQL connection. ``psycopg`` is imported lazily so this
        module is importable without the driver installed."""
        import psycopg

        return psycopg.connect(
            host=self._config.host,
            port=self._config.port,
            dbname=self._config.dbname,
            user=self._config.user,
            password=self._config.password,
            connect_timeout=self._config.connect_timeout,
        )

    def _lite_params(self) -> dict[str, Any]:
        """Bound into EVERY query, including the ones that do not source lite
        content — `_SQL_COMMENTS_FOR_POSTS` needs them to EXCLUDE lite posts
        from a container's comment count, and psycopg raises on an unbound
        placeholder rather than ignoring it."""
        return {
            "lite_publishers": sorted(self._lite.publisher_accounts),
            "lite_app": self._lite.app_id,
        }

    def _fetch_lite(self, sql: str, params: dict[str, Any]) -> list[tuple[Any, ...]]:
        return self._fetch(sql, {**params, **self._lite_params()})

    def _fetch(self, sql: str, params: dict[str, Any]) -> list[tuple[Any, ...]]:
        """Execute one parameterized, read-only query and return all rows."""
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def _votes_for_posts(
        self, authors: list[str], permlinks: list[str]
    ) -> dict[tuple[str, str], list[Vote]]:
        rows = self._fetch_lite(_SQL_VOTES_FOR_POSTS, {"authors": authors, "permlinks": permlinks})
        grouped: dict[tuple[str, str], list[Vote]] = {}
        for author, permlink, voter, rshares, timestamp in rows:
            grouped.setdefault((author, permlink), []).append(
                Vote(voter=voter, rshares=rshares, timestamp=timestamp)
            )
        return grouped

    def _comments_for_posts(
        self, authors: list[str], permlinks: list[str]
    ) -> dict[tuple[str, str], dict[str, int]]:
        """Per-post commenter attribution: ``{key: {commenter: comment_count}}``."""
        rows = self._fetch_lite(
            _SQL_COMMENTS_FOR_POSTS, {"authors": authors, "permlinks": permlinks}
        )
        grouped: dict[tuple[str, str], dict[str, int]] = {}
        for author, permlink, commenter, count in rows:
            grouped.setdefault((author, permlink), {})[commenter] = count
        return grouped

    def _rebloggers_for_posts(
        self, authors: list[str], permlinks: list[str]
    ) -> dict[tuple[str, str], tuple[str, ...]]:
        """Per-post reblogger attribution: ``{key: (distinct account names)}``."""
        rows = self._fetch_lite(
            _SQL_REBLOGGERS_FOR_POSTS, {"authors": authors, "permlinks": permlinks}
        )
        grouped: dict[tuple[str, str], set[str]] = {}
        for author, permlink, account in rows:
            grouped.setdefault((author, permlink), set()).add(account)
        return {key: tuple(sorted(accounts)) for key, accounts in grouped.items()}

    def _reputations_for_authors(self, authors: list[str]) -> dict[str, int]:
        rows = self._fetch_lite(_SQL_REPUTATIONS_FOR_AUTHORS, {"authors": authors})
        return dict(rows)

    def _hydrate(self, rows: list[tuple[Any, ...]]) -> list[Post]:
        """Batch-fetch votes/commenters/rebloggers/reputation for a page of
        posts — comment and reblog identity included, so every hydrated post is
        an :class:`AttributedPost` the organic term can exclusion-filter."""
        if not rows:
            return []
        authors = [row[0] for row in rows]
        permlinks = [row[1] for row in rows]
        votes = self._votes_for_posts(authors, permlinks)
        comments = self._comments_for_posts(authors, permlinks)
        rebloggers = self._rebloggers_for_posts(authors, permlinks)
        reputations = self._reputations_for_authors(list(dict.fromkeys(authors)))
        return [_build_post(row, votes, comments, rebloggers, reputations) for row in rows]

    def in_network_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Post]:
        """Recent top-level posts by followed accounts (§7)."""
        if not follows:
            return []
        rows = self._fetch(
            _SQL_IN_NETWORK_POSTS, {"authors": list(follows), "since": since, "limit": limit}
        )
        return self._hydrate(rows)

    def engaged_oon_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Candidate]:
        """Out-of-network posts an in-network account voted, reblogged, or replied
        to — the second-degree engagement pool (§8.1)."""
        if not follows:
            return []
        rows = self._fetch(
            _SQL_ENGAGED_OON_POSTS, {"follows": list(follows), "since": since, "limit": limit}
        )
        return [
            Candidate(post=post, source=CandidateSource.OON_ENGAGED)
            for post in self._hydrate(rows)
        ]

    def community_posts(
        self, communities: frozenset[str], since: datetime, limit: int
    ) -> list[Post]:
        """Recent posts filed under the given communities (§13.1)."""
        if not communities:
            return []
        rows = self._fetch(
            _SQL_COMMUNITY_POSTS,
            {"communities": list(communities), "since": since, "limit": limit},
        )
        return self._hydrate(rows)

    def tag_posts(self, tags: frozenset[str], since: datetime, limit: int) -> list[Post]:
        """Recent posts carrying any of the given tags (§13.1)."""
        if not tags:
            return []
        rows = self._fetch_lite(
            _SQL_TAG_POSTS, {"tags": list(tags), "since": since, "limit": limit}
        )
        return self._hydrate(rows)

    def engagement_edges(self, since: datetime) -> list[EngagementEdge]:
        """Directed RealGraph engagement summary since ``since`` (§8.3)."""
        replies = self._edge_counts(_SQL_REPLY_EDGES, since)
        upvotes = self._edge_counts(_SQL_UPVOTE_EDGES, since)
        reblogs = self._edge_counts(_SQL_REBLOG_EDGES, since)
        keys = sorted(set(replies) | set(upvotes) | set(reblogs))
        edges = []
        for src, dst in keys:
            r_count, r_ts = replies.get((src, dst), (0, None))
            u_count, u_ts = upvotes.get((src, dst), (0, None))
            b_count, b_ts = reblogs.get((src, dst), (0, None))
            # The reverse pair's own timestamp — dst's reply BACK to src — must
            # feed last_interaction too, or a fresh reply-back gets decayed on
            # the stale forward reply's date (§8.3 recency bug).
            rb_count, rb_ts = replies.get((dst, src), (0, None))
            edges.append(
                EngagementEdge(
                    src=src,
                    dst=dst,
                    replies=r_count,
                    reply_backs=rb_count,
                    upvotes=u_count,
                    reblogs=b_count,
                    last_interaction=_latest(r_ts, u_ts, b_ts, rb_ts),
                )
            )
        return edges

    def _edge_counts(
        self, sql: str, since: datetime
    ) -> dict[tuple[str, str], tuple[int, datetime | None]]:
        rows = self._fetch(sql, {"since": since})
        return {(src, dst): (count, last_ts) for src, dst, count, last_ts in rows}

    def stake_lineage(self, author: str) -> frozenset[str]:
        """Delegation-tied accounts sharing stake lineage with ``author`` (§8.4)."""
        rows = self._fetch_lite(_SQL_STAKE_LINEAGE, {"author": author})
        return frozenset(row[0] for row in rows) - {author}

    def second_degree_engagers(
        self, post_keys: frozenset[str], follows: frozenset[str]
    ) -> dict[str, frozenset[str]]:
        """For each OON post key, which of the viewer's ``follows`` voted,
        replied to, or reblogged it (§8.1) — the engager index the
        second-degree gate checks vouches against."""
        if not post_keys or not follows:
            return {}
        authors, permlinks = _split_keys(post_keys)
        rows = self._fetch(
            _SQL_SECOND_DEGREE_ENGAGERS,
            {"authors": authors, "permlinks": permlinks, "follows": list(follows)},
        )
        grouped: dict[str, set[str]] = {}
        for author, permlink, engager in rows:
            grouped.setdefault(f"@{author}/{permlink}", set()).add(engager)
        return {key: frozenset(engagers) for key, engagers in grouped.items()}

    def follow_graph(self, accounts: frozenset[str]) -> dict[str, frozenset[str]]:
        """follower -> followees among ``accounts`` (§8.3), for graph-cred."""
        if not accounts:
            return {}
        rows = self._fetch_lite(_SQL_FOLLOW_GRAPH, {"accounts": list(accounts)})
        grouped: dict[str, set[str]] = {}
        for follower, following in rows:
            grouped.setdefault(follower, set()).add(following)
        return {follower: frozenset(followees) for follower, followees in grouped.items()}

    def popular_posts(self, since: datetime, limit: int) -> list[Post]:
        """Community-popular fallback for the fully-cold viewer (§13.5b), ranked
        by our own positive-engagement signals — never payout indexing."""
        rows = self._fetch_lite(_SQL_POPULAR_POSTS, {"since": since, "limit": limit})
        return self._hydrate(rows)

    def author_engagement(
        self,
        authors: frozenset[str],
        since: datetime,
        excluded: Mapping[str, frozenset[str]] | None = None,
        *,
        trust: VoterTrust | None = None,
    ) -> dict[str, AuthorEngagement]:
        """Author-pooled window aggregate (§6), §8.4-exclusion-filtered AND
        (H05) breadth-budgeted (``_SQL_AUTHOR_ENGAGEMENT``).

        ``excluded`` maps each author to the identities (stake lineage + ring +
        self) whose engagement must NOT count toward that author's pooled prior;
        the query anti-joins each author's voters/commenters/rebloggers against
        their own set, so no author can inflate ``total_base`` with the same
        alts/ring the vote signal already discounts on ``own_base``. ``None`` (or
        an author absent from it) applies self-exclusion only. Authors with no
        window post are simply absent from the result, which the caller reads as
        "no prior".

        ``trust`` (H05) is the SAME :class:`~recsys.core.vote_signal.VoterTrust`
        the scorer builds per request (``recsys.pipeline._voter_trust``); its
        ``vouched``/``unknown_free``/``unknown_per_vouched`` are passed to the
        query so each window post's surviving voters/commenters/rebloggers are
        credited ``vouched + budgeted(unknown)`` — exactly
        :meth:`~recsys.core.vote_signal.VoterTrust.credited_breadth` — BEFORE
        being summed into ``total_base``. Without exclusion alone, an author's
        OTHER window posts could still be farmed by unknown-tier sock upvotes
        that pass every §8.4 exclusion; this closes that. ``trust=None`` (no
        trust snapshot) sends ``vouched=[]``, an effectively-infinite
        ``unknown_free`` and ``unknown_per_vouched=0`` so the budget clause
        never binds and the query collapses to the raw distinct count — the
        same one query serves both the trusted and no-snapshot cases. See
        :class:`recsys.core.scoring.AuthorPriorGateway`."""
        if not authors:
            return {}
        excl_authors: list[str] = []
        excl_accounts: list[str] = []
        for author, accounts in (excluded or {}).items():
            for account in accounts:
                if account == author:
                    continue  # self is already excluded by the `<> c.author` predicate
                excl_authors.append(author)
                excl_accounts.append(account)
        if trust is None:
            vouched: list[str] = []
            unknown_free: float = _UNBUDGETED_UNKNOWN_FREE
            unknown_per_vouched: float = 0.0
        else:
            vouched = list(trust.vouched)
            unknown_free = trust.unknown_free
            unknown_per_vouched = trust.unknown_per_vouched
        rows = self._fetch(
            _SQL_AUTHOR_ENGAGEMENT,
            {
                "authors": list(authors),
                "since": since,
                "excl_authors": excl_authors,
                "excl_accounts": excl_accounts,
                "vouched": vouched,
                "unknown_free": unknown_free,
                "unknown_per_vouched": unknown_per_vouched,
            },
        )
        return {
            author: AuthorEngagement(posts=int(posts), total_base=float(total_base or 0.0))
            for author, posts, total_base in rows
        }

    def suppressed_keys(self, post_keys: frozenset[str]) -> frozenset[str]:
        """Subset of ``post_keys`` under network suppression (§8.7)."""
        if not post_keys:
            return frozenset()
        authors, permlinks = _split_keys(post_keys)
        rows = self._fetch_lite(_SQL_SUPPRESSED_KEYS, {"authors": authors, "permlinks": permlinks})
        return frozenset(f"@{author}/{permlink}" for author, permlink in rows)
