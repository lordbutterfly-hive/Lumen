"""Interest-based cold-start seeding (rev 2.2, §13.1).

New accounts have no follow graph and no history to rank against, so Phase 0
seeds them from signup-time interest picks (Medium-style onboarding) instead.
Imports nothing but stdlib + contracts + config; the candidate pool it builds
is deliberately independent of :mod:`recsys.core.candidates`.
"""

from __future__ import annotations

from datetime import datetime

from recsys.config import ColdStartConfig
from recsys.contracts import Candidate, CandidateSource, HafsqlGateway, ViewerProfile


def is_cold(viewer: ViewerProfile) -> bool:
    """Whether ``viewer`` should be routed to the interest lane (§13.1).

    True for brand-new accounts or anyone with an empty follow graph — either
    way there is no in-network signal to rank from.
    """
    return viewer.is_new or not viewer.follows


# The interest lane's two gate-exempt sources (§13.1) — the sources
# :func:`is_established_followless` exists to partially re-gate (H07).
INTEREST_LANE_SOURCES: frozenset[CandidateSource] = frozenset(
    {CandidateSource.INTEREST_COMMUNITY, CandidateSource.INTEREST_TAG}
)


def is_established_followless(viewer: ViewerProfile, has_trained_als_row: bool) -> bool:
    """The H07/C1 gap state (§8.1 residual, 2026-07-22): ``viewer`` is routed
    to the gate-exempt interest lane by :func:`is_cold` for the FOLLOWLESS
    reason (``not viewer.follows``), yet is not actually a true cold start —
    they have a row in the trained CF model (``has_trained_als_row``), i.e.
    enough engagement history for a poisoned co-engagement edge to reach them.

    A TRUE cold newcomer has no ALS row at all (never engaged anyone), so
    ``has_trained_als_row`` is ``False`` for them,
    :func:`recsys.core.als.viewer_affinity_percentiles` already returns
    ``None`` (no CF slice exists for the request), and this function
    correctly returns ``False`` — the lane stays fully exempt, exactly as
    before this fix. Never gate on the absence of history.

    The gap is the OTHER shape of ``is_cold``: an established account that
    unfollowed everyone (or never followed anyone) while still accumulating
    engagement elsewhere. ``is_cold`` is still right to route them to the
    interest lane — they have no follow graph for the §8.1 second-degree gate
    to use — but :func:`recsys.core.second_degree.filter_eligible` applies NO
    graph-cred floor to either interest-lane source
    (``CandidateSource.requires_second_degree`` is ``False`` for both), so
    that lane is this viewer's ENTIRE feed with zero identity-based gating.
    If the CF percentile blend is ever active for gate-exempt sources
    (``ScoreWeights.organic_cf_oon_scale > 0`` — see its docstring: a
    real-Hive A/B may raise it from the current conservative default of
    0.0), a poisoned ALS row can lift a spam author's interest-lane candidate
    with nothing else standing in the way.

    The caller (:func:`recsys.pipeline._score`) uses this to force
    ``cf_percentile=None`` for this viewer's interest-lane candidates only —
    see :data:`INTEREST_LANE_SOURCES` and
    :func:`recsys.core.scoring.score_candidates`'s ``cf_suppressed_sources``.
    Every other candidate (this viewer has none, since a followless viewer's
    gated sources never clear the second-degree gate either — see
    :func:`recsys.core.second_degree.passes_second_degree`) is unaffected.

    ``viewer.is_new`` is deliberately NOT consulted here: the discriminator
    is whether the viewer has a trainable history, not the client-set,
    unverified new-account flag. In practice the two agree — a genuinely new
    account has no engagement history yet, so ``has_trained_als_row`` is
    ``False`` for it regardless of what ``is_new`` claims — but the
    ALS-row test is the one that cannot be spoofed by a stale or incorrect
    flag.
    """
    return not viewer.follows and has_trained_als_row


def interest_candidates(
    viewer: ViewerProfile,
    gateway: HafsqlGateway,
    since: datetime,
    limit: int,
    cfg: ColdStartConfig,
) -> list[Candidate]:
    """Candidate pool for a cold viewer's interest picks (§13.1, rev 2.2).

    Pulls posts from the viewer's interest communities (``INTEREST_COMMUNITY``)
    and interest tags (``INTEREST_TAG``), then dedups by ``post.key`` locally
    — a post surfaced by both keeps its community source. These are the
    gate-exempt exploration-lane sources (a cold viewer has no follow graph for
    the second-degree gate to use), distinct from the *gated* ``OON_COMMUNITY``
    source an established viewer's subscribed communities use. Community-over-tag
    precedence here matches :data:`recsys.core.candidates.SOURCE_PRIORITY`, which
    also ranks ``INTEREST_COMMUNITY`` above ``INTEREST_TAG`` on dedup.
    """
    community_posts = gateway.community_posts(viewer.interest_communities, since, limit)
    tag_posts = gateway.tag_posts(viewer.interest_tags, since, limit)
    merged: dict[str, Candidate] = {
        post.key: Candidate(post=post, source=CandidateSource.INTEREST_COMMUNITY)
        for post in community_posts
    }
    for post in tag_posts:
        merged.setdefault(post.key, Candidate(post=post, source=CandidateSource.INTEREST_TAG))
    return list(merged.values())


def popular_fallback(gateway: HafsqlGateway, since: datetime, limit: int) -> list[Candidate]:
    """Community-popular fallback for a fully-cold viewer (§13.5b).

    Used when the interest-seeded pool would otherwise be empty (e.g. a
    viewer who hasn't picked any interests yet). Wraps
    :meth:`HafsqlGateway.popular_posts` as ``INTEREST_TAG`` candidates — the
    cold-start exploration lane is gate-exempt (§8.1), which is what a blank
    viewer with no follow graph needs.
    """
    return [
        Candidate(post=post, source=CandidateSource.INTEREST_TAG)
        for post in gateway.popular_posts(since, limit)
    ]
