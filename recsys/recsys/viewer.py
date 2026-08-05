"""A9 — build a real :class:`~recsys.contracts.ViewerProfile` for a real Hive
account.

WHY THIS FILE EXISTS. Nothing outside tests and the measurement harness ever
constructed a ``ViewerProfile`` — there was no bridge from "a Hive account
name" to the object ``rank_feed`` actually consumes.

WHAT THIS BUILDS, per BUILD-ADJUDICATION-2026-08-04 / BUILDMAP-A A9:

* ``follows`` (A9.1) — ``hafsql.follows``, ``follower_name = account``.
  ``HafsqlGateway.follow_graph`` is NOT this: it returns the sub-graph
  induced by an account SET, for graph-cred, not one viewer's own list.
* ``mutes`` (A9.2) — see :func:`mutes_of`'s own docstring for the live
  schema verification this required.
* ``interest_tags`` (A9.3 / R12 part 2) — the sole interest substrate since
  communities were retired as a lane (R1/R3). For a RETURNING user this is
  DERIVED from their own posting + voting history (cold-start spec Lever
  B/D10) rather than demanded of them — see :func:`derive_interest_tags`.

WHY RAW SQL IN THIS MODULE INSTEAD OF NEW ``HafsqlGateway`` METHODS. This
builder does not own ``recsys/io/hafsql.py`` (another workstream is actively
editing it this phase). Per the build brief: "write the query in your own
module against the same connection [...] or report precisely what method is
needed." An earlier scaffold of this file took the second option — a
``ViewerGateway``/``ViewerStore`` ``Protocol`` pair whose methods
(``follows_of``, ``mutes_of``, ``authored_and_voted_tags_of``,
``declared_interest_tags``) nothing in the tree implements, so
``build_viewer_profile`` could never actually run. That is a real, reasonable
reading of the brief, but it leaves A9 — and therefore A10, which depends on
it — non-functional, and R8's acceptance bar requires an ACTUAL live request
to succeed. This version takes the first option instead: every query below
runs directly against ``HafsqlClient._fetch`` (verified live 2026-08-04, see
the SQL comments), which already gives it A4's pooling, retry/breaker and
``statement_timeout`` for free — "the same connection" the brief asks for,
not a second ad hoc one. ``_fetch`` is name-mangled private by convention,
not by enforcement; :class:`_FetchCapable` below is a narrow structural
``Protocol`` so this module depends on exactly the one method it needs and
stays testable against a plain fake with no real client at all.

R12 — THE TAGLESS-VIEWER RULING, restated for this module's part in it (see
``pipeline.gather_candidates``'s own comment for the other two-thirds):

  1. New signups: at least one interest tag mandatory at signup — a
     signup-API change OUTSIDE ``recsys/``, not built here.
  2. Returning Hive users: derive tags from history — THIS module,
     :func:`derive_interest_tags`.
  3. Defensive floor: a viewer who still arrives with no tags gets the
     popular fallback + a WARNING, never an empty feed or a crash — already
     live in ``pipeline.gather_candidates`` (do not regress it). This
     module's :func:`build_viewer_profile` adds a companion WARNING at the
     PROFILE-BUILD boundary so an operator sees *why* before the
     ranking-time symptom. ``tests/test_viewer.py`` proves a tagless
     ``ViewerProfile`` built here still reaches a non-empty feed through
     that path.

``store``/signup-time explicit picks (``recsys/db/schema.sql``'s
``viewer_profile.top_categories``): DECIDED, per A9.3's "decide and
document" instruction — nothing in ``recsys/db/store.py`` reads or writes
that table today (grep confirms no INSERT/UPDATE/SELECT anywhere in the
package), and R12 part 1 explicitly places signup-time tag capture outside
``recsys/`` (a frontend/signup-API concern). Building a read path against an
always-empty table would be dead code. Instead, :func:`build_viewer_profile`
accepts an optional ``explicit_interest_tags`` override: a caller that DOES
have a signup-time pick (from Lumen's own Postgres, however it gets there)
passes it straight through and derivation is skipped. Absent, tags are
derived from history for a returning user, or left empty for a declared new
one (R12 part 1's mandatory-tag signup gate is what should prevent that case
in steady state; part 3 is what protects the viewer if it happens anyway).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any, Protocol

from recsys.config import DEFAULT_SETTINGS, Settings
from recsys.contracts import ViewerProfile

logger = logging.getLogger("recsys.viewer")


class _FetchCapable(Protocol):
    """The one method this module needs from a gateway: a pooled, parameterized
    fetch. ``recsys.io.hafsql.HafsqlClient._fetch`` satisfies this structurally
    (Python does not enforce name-mangled privacy), and so does any test fake
    that defines the same method — no dependency on the concrete client type."""

    def _fetch(self, sql: str, params: dict[str, Any]) -> list[tuple[Any, ...]]: ...


# ---------------------------------------------------------------------------
# SQL. Every query is parameterized (`%(name)s`) — no f-string values, no
# injection surface — matching the convention `recsys/io/hafsql.py` documents
# and enforces throughout.
# ---------------------------------------------------------------------------

# A9.1. `hafsql.follows` columns verified live 2026-08-04:
# (follower_id, following_id, block_num, follower_name, following_name) — no
# state/follow_type column, so this table alone cannot distinguish a mute
# (see `_SQL_MUTES_OF` below for where that distinction actually lives).
_SQL_FOLLOWS_OF = """
SELECT following_name
FROM hafsql.follows
WHERE follower_name = %(account)s
"""

# A9.2. `hafsql.mutes` verified live 2026-08-04: a DEDICATED table
# (muter_id, muted_id, block_num, muter_name, muted_name), confirmed non-empty
# on real accounts (acidyo: 210 rows, live). This is the correct source —
# `hafsql.follows` carries no mute/ignore state at all, so a query that tried
# to derive mutes from it (e.g. by an assumed `follow_type` column) would
# either error on a nonexistent column or silently return nothing forever.
_SQL_MUTES_OF = """
SELECT muted_name
FROM hafsql.mutes
WHERE muter_name = %(account)s
"""

# A9.3, own posts half. `tags` is jsonb (comments break #3's lesson — no `&&`
# array operator), `category` is the primary tag. `parent_author = ''` scopes
# to top-level posts only (a comment's "category" is inherited from its root
# and is not a deliberate topic choice by this account).
_SQL_OWN_POST_TAGS = """
SELECT tags, category
FROM hafsql.comments
WHERE author = %(account)s
  AND parent_author = ''
  AND deleted = false
ORDER BY created DESC
LIMIT %(limit)s
"""

# A9.3, voting-history half. Two queries, not one join: live-verified
# 2026-08-04, a direct join from `operation_effective_comment_vote_view` to
# `hafsql.comments` filtered only on `voter` timed out at the 15s statement
# timeout (the planner drives it from a `blocks`-scan nested loop). Filtering
# votes to a small, indexed, `voter`+`timestamp`-ordered page FIRST (measured
# ~1.3-1.9s live) and then looking up just those (author, permlink) pairs by
# an `unnest`-joined VALUES list (measured ~0.04s live) is the same two-step
# shape `HafsqlClient._hydrate` already uses for votes/comments/rebloggers —
# not a novel pattern, the same fix applied to a query this module owns.
_SQL_RECENT_VOTES_BY = """
SELECT author, permlink
FROM hafsql.operation_effective_comment_vote_view
WHERE voter = %(account)s
  AND "timestamp" >= %(since)s
ORDER BY "timestamp" DESC
LIMIT %(limit)s
"""

# Fast pre-check, live-measured 2026-08-04: a plain `WHERE voter = X LIMIT 1`
# with NO `ORDER BY`/`timestamp` bound resolves in ~0.03-0.05s REGARDLESS of
# whether the account has ever voted (tested repeatedly on a nonexistent
# voter and on real accounts) — the planner takes a different, cheap path
# once there is no ordering to satisfy. This is NOT the same query as
# `_SQL_RECENT_VOTES_BY` with the `ORDER BY`/`since` stripped; that shape was
# also trialled and still timed out (see the 14.9s outlier above). Used to
# skip the expensive windowed query entirely for an account that has never
# cast a single vote — live-verified: without this guard, exactly that case
# (a real never-voted account name) hit the FULL 15s statement timeout on
# `_SQL_RECENT_VOTES_BY` before falling back. A brand-new or vote-only-silent
# account is common, not an edge case, so paying up to 15s for a query
# guaranteed to return nothing is a real reliability problem this guard
# closes for the price of one cheap extra round trip on the accounts that DO
# have vote history.
_SQL_HAS_EVER_VOTED = """
SELECT 1
FROM hafsql.operation_effective_comment_vote_view
WHERE voter = %(account)s
LIMIT 1
"""

_SQL_TAGS_FOR_POST_PAIRS = """
SELECT c.tags, c.category
FROM hafsql.comments c
JOIN unnest(%(authors)s::text[], %(permlinks)s::text[]) AS w(author, permlink)
  ON c.author = w.author AND c.permlink = w.permlink
"""

DEFAULT_OWN_POST_LIMIT = 30
#: Live-measured 2026-08-04: `_SQL_RECENT_VOTES_BY` has no usable index on
#: `voter` alone (`EXPLAIN` shows a backward scan of `blocks` by `created_at`
#: with a per-block jsonb filter for the voter — see that query's own
#: comment) — cost scales with how far back in the window a match is found,
#: not with the account's activity. Trialled live: an active account (60-row
#: page) is consistently ~0.7s; a quieter one (`gtg`) ~4.0s; one outlier at
#: LIMIT=150 with no `since` bound hit 14.9s, a hair under the 15s statement
#: timeout. 60 was chosen as the largest LIMIT that stayed comfortably clear
#: of the timeout in every trial, including the quiet-account case — this is
#: a real operational constraint, not a magic number; see
#: `derive_interest_tags`'s own try/except for the defense-in-depth backstop
#: for whatever this measurement did not catch.
DEFAULT_VOTE_HISTORY_LIMIT = 60
DEFAULT_MAX_INTEREST_TAGS = 6

# An account's own posts are a much stronger interest signal than any single
# vote (writing about a topic vs. liking one post about it once); weighted
# accordingly rather than counted 1:1.
_OWN_POST_TAG_WEIGHT = 3.0
_VOTE_TAG_WEIGHT = 1.0


def follows_of(gateway: _FetchCapable, account: str) -> frozenset[str]:
    """A9.1 — the accounts ``account`` itself follows (not the sub-graph
    ``HafsqlGateway.follow_graph`` returns, which is induced by a *set* of
    accounts and built for graph-cred, not for one viewer's own list)."""
    rows = gateway._fetch(_SQL_FOLLOWS_OF, {"account": account})
    return frozenset(row[0] for row in rows)


def mutes_of(gateway: _FetchCapable, account: str) -> frozenset[str]:
    """A9.2 — accounts ``account`` has muted. See the module-level SQL
    comment on ``_SQL_MUTES_OF`` for the live schema verification this
    required (the build brief explicitly warned not to assume)."""
    rows = gateway._fetch(_SQL_MUTES_OF, {"account": account})
    return frozenset(row[0] for row in rows)


def _extract_tags(tags_json: Sequence[str] | None, category: str | None) -> set[str]:
    out: set[str] = set()
    if tags_json:
        out.update(tag for tag in tags_json if tag)
    if category:
        out.add(category)
    return out


def derive_interest_tags(
    gateway: _FetchCapable,
    account: str,
    *,
    now: datetime,
    settings: Settings = DEFAULT_SETTINGS,
    own_post_limit: int = DEFAULT_OWN_POST_LIMIT,
    vote_history_limit: int = DEFAULT_VOTE_HISTORY_LIMIT,
    max_tags: int = DEFAULT_MAX_INTEREST_TAGS,
) -> frozenset[str]:
    """A9.3 / R12 part 2 — derive interest tags for a RETURNING Hive user
    from their own posting + voting history (cold-start spec Lever B/D10),
    instead of demanding them again at every login.

    Aggregates tag/category frequency across the account's recent top-level
    posts (weight :data:`_OWN_POST_TAG_WEIGHT`) and recent votes
    (weight :data:`_VOTE_TAG_WEIGHT`, windowed to
    ``settings.history.quality_prior_days`` — the same "enough events to beat
    Bernoulli noise" horizon the author-quality prior already uses, not a new
    tuning constant), and returns the top ``max_tags`` by weighted count.

    Returns an EMPTY frozenset for an account with no posting or voting
    history in the window (a genuinely fresh account, or one that has never
    interacted) — this is a real, expected state, not an error. The caller
    (:func:`build_viewer_profile`) logs it; R12 part 3's fallback (already
    live in ``pipeline.gather_candidates``) is what keeps the resulting feed
    non-empty.
    """
    since = now - timedelta(days=settings.history.quality_prior_days)
    scores: dict[str, float] = {}

    own_rows = gateway._fetch(
        _SQL_OWN_POST_TAGS, {"account": account, "limit": own_post_limit}
    )
    for tags_json, category in own_rows:
        for tag in _extract_tags(tags_json, category):
            scores[tag] = scores.get(tag, 0.0) + _OWN_POST_TAG_WEIGHT

    # BEST-EFFORT, NOT LOAD-BEARING. `_SQL_RECENT_VOTES_BY` has no usable
    # index on `voter` alone (see `DEFAULT_VOTE_HISTORY_LIMIT`'s comment) and
    # live-measured latency ranges ~0.7s-4s for an account with real vote
    # history, up to the full 15s statement timeout for one that has never
    # voted at all. `_SQL_HAS_EVER_VOTED` (see its own comment) is a cheap
    # (~0.03-0.05s live) pre-check that skips the expensive query entirely
    # for that common case. This half of derivation must never be able to
    # fail the whole viewer-profile build regardless: on ANY exception here
    # (timeout, transient connection loss, ...) fall back to own-posts-only
    # tags, which are index-backed and reliably fast, and log loudly so an
    # operator can see the degrade rather than a silently thinner result.
    vote_rows: list[tuple[Any, ...]] = []
    try:
        has_voted = bool(gateway._fetch(_SQL_HAS_EVER_VOTED, {"account": account}))
        if has_voted:
            vote_rows = gateway._fetch(
                _SQL_RECENT_VOTES_BY,
                {"account": account, "since": since, "limit": vote_history_limit},
            )
    except Exception:
        logger.warning(
            "derive_interest_tags: %s's voting-history query failed/timed out — "
            "falling back to own-posts-only tag derivation for this build.",
            account,
            exc_info=True,
        )
        vote_rows = []

    if vote_rows:
        authors = [row[0] for row in vote_rows]
        permlinks = [row[1] for row in vote_rows]
        try:
            tag_rows = gateway._fetch(
                _SQL_TAGS_FOR_POST_PAIRS, {"authors": authors, "permlinks": permlinks}
            )
        except Exception:
            logger.warning(
                "derive_interest_tags: %s's voted-post tag lookup failed — "
                "falling back to own-posts-only tag derivation for this build.",
                account,
                exc_info=True,
            )
            tag_rows = []
        for tags_json, category in tag_rows:
            for tag in _extract_tags(tags_json, category):
                scores[tag] = scores.get(tag, 0.0) + _VOTE_TAG_WEIGHT

    if not scores:
        return frozenset()

    # Stable, deterministic tie-break (weight desc, then tag name asc) so two
    # runs over unchanged data always pick the same top-N — important for the
    # A10 "served order is IDENTICAL to a direct rank_feed() call" proof,
    # which depends on `interest_tags` (and therefore this function) being
    # reproducible, not just non-empty.
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    return frozenset(tag for tag, _ in ranked[:max_tags])


def build_viewer_profile(
    account: str,
    gateway: _FetchCapable,
    *,
    now: datetime,
    settings: Settings = DEFAULT_SETTINGS,
    is_new: bool = False,
    explicit_interest_tags: frozenset[str] | None = None,
    explicit_follows: frozenset[str] | None = None,
    explicit_mutes: frozenset[str] | None = None,
) -> ViewerProfile:
    """A9.4 — build a real ``ViewerProfile`` for ``account`` from live Hive
    data (plus, optionally, a signup-time explicit pick — see the module
    docstring's ``explicit_interest_tags`` note).

    ★ B3 (2026-08-05) — ``explicit_follows`` / ``explicit_mutes`` exist for
    LUMEN LITE VIEWERS, who have no Hive account and therefore no chain-side
    follow or mute list at all. Their graph lives in Lumen's own store, so the
    CALLER supplies it. This deliberately follows ``LiteConfig``'s stated
    architecture ("the fix is ON-CHAIN, not cross-database — no join against
    Lumen's Postgres, no ingestion job"): recsys does not reach into another
    service's database, it accepts the state its caller already holds.

    ★★ ``None`` MEANS "ASK THE CHAIN"; ``frozenset()`` MEANS "SUPPLIED, AND
    GENUINELY EMPTY". Do not collapse these with a falsy check. A lite user who
    follows nobody is a real, common state (it is the state every lite user is
    in at signup), and it must NOT silently fall back to querying HAFSQL for an
    account name that does not exist on chain. This mirrors the convention
    ``explicit_interest_tags`` already established directly above.

    Note the asymmetry with ``interest_tags``: there is no derivation fallback
    for follows/mutes. A Hive viewer's follows come from the chain and a lite
    viewer's come from the caller — there is no third source to infer from.

    ``is_new`` is passed straight through to the ``ViewerProfile`` field of
    the same name and otherwise UNUSED for gating here, mirroring
    ``ViewerProfile.is_new``'s own contract: it is client-supplied and
    deliberately un-load-bearing (``pipeline.gather_candidates`` routes the
    gate-exempt interest lane on the unspoofable ``not viewer.follows``, not
    on this flag — see that function's own comment for why, and do not
    reintroduce a dependency on it here). It is used ONLY to decide whether
    this function bothers deriving tags at all: a caller who already knows
    the account is brand-new can skip two live queries that would return
    nothing anyway. Passing ``is_new=True`` for an account that turns out to
    have history is harmless (it just skips derivation), never unsafe.
    """
    follows = follows_of(gateway, account) if explicit_follows is None else explicit_follows
    mutes = mutes_of(gateway, account) if explicit_mutes is None else explicit_mutes

    if explicit_interest_tags is not None:
        interest_tags = explicit_interest_tags
    elif is_new:
        interest_tags = frozenset()
    else:
        interest_tags = derive_interest_tags(gateway, account, now=now, settings=settings)

    if not interest_tags:
        # Companion to the WARNING `pipeline.gather_candidates` already logs
        # at ranking time (R12 part 3) — this one fires at the PROFILE-BUILD
        # boundary, so an operator sees "derivation found nothing for this
        # account" as a distinct, earlier signal from "the interest lane
        # sourced nothing this request", rather than only the latter.
        logger.warning(
            "build_viewer_profile: %s has no interest_tags (is_new=%s, "
            "explicit_override=%s) — will rely on the popular-fallback path "
            "in gather_candidates (R12) rather than the interest lane.",
            account,
            is_new,
            explicit_interest_tags is not None,
        )

    return ViewerProfile(
        account=account,
        follows=follows,
        mutes=mutes,
        interest_tags=interest_tags,
        is_new=is_new,
    )


__all__ = [
    "DEFAULT_MAX_INTEREST_TAGS",
    "DEFAULT_OWN_POST_LIMIT",
    "DEFAULT_VOTE_HISTORY_LIMIT",
    "build_viewer_profile",
    "derive_interest_tags",
    "follows_of",
    "mutes_of",
]
