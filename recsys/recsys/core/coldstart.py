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
    {
        CandidateSource.INTEREST_COMMUNITY,
        CandidateSource.INTEREST_TAG,
        # ★ POPULAR_FALLBACK belongs here (added 2026-08-01 with the label, and
        # NOT an extension of H07's scope — a restoration of it). Padding used to
        # be emitted AS `INTEREST_TAG`, so it was inside this set and had CF
        # suppressed for established-followless viewers. Giving padding its own
        # honest label silently moved it OUT, which would have narrowed an
        # anti-poisoning control as a side effect of a labelling change. Padding
        # is served to exactly the viewers H07 is about and is the most
        # promotable lane there is, so it is the last thing that should carry an
        # unsuppressed cross-viewer signal.
        CandidateSource.POPULAR_FALLBACK,
    }
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


def established_interest_candidates(
    viewer: ViewerProfile,
    gateway: HafsqlGateway,
    since: datetime,
    limit: int,
) -> list[Candidate]:
    """The viewer's declared interests, for a viewer who HAS a follow graph.

    ★ THE FOLLOW-CLIFF (2026-08-01). ``gather_candidates`` used to append the
    interest lane only ``if not viewer.follows`` and the in-network lanes only
    ``if viewer.follows`` — mutually exclusive. So the instant a brand-new user
    followed ONE account their declared interests stopped being consulted
    entirely and their pool collapsed to that account's recent posts, padded out
    with global-popularity filler. Measured: pool 60 -> 3, on-interest share of
    the top 20 falling 20/20 -> 0/20. The dead zone runs from the first follow
    until in-network supply alone can fill a feed, which is exactly the window in
    which a new user decides whether to stay.

    The picks do not stop mattering once someone follows a person, so the lane is
    now unconditional — but it changes TRUST CLASS rather than simply staying on.
    A followless viewer keeps the gate-exempt ``INTEREST_*`` sources (they have
    no follow graph for the second-degree gate to use, §13.1). A viewer WITH a
    graph gets ``OON_INTEREST``, which ``requires_author_floor`` — so their
    interest content must still come from an author who clears the graph-cred
    floor, and this does not widen the gate-exempt surface H07 exists to narrow.

    ★ WHAT THIS LANE DELIBERATELY DOES NOT REQUIRE, and why. The first version of
    this fix also made ``OON_INTEREST`` ``requires_second_degree``, which read as
    strictly safer and was in fact a total no-op: that gate admits a post only if
    someone the viewer ALREADY FOLLOWS engaged it, which is the exact predicate
    ``OON_ENGAGED`` selects on, and which brand-new content from outside the
    viewer's network can never satisfy. Measured end to end: 60 candidates
    generated, 0 of 20 feed slots on-interest, 17 of 20 popularity padding — the
    same numbers as the bug. "Is this author credible" and "has my network
    already seen this" are different questions, and a discovery lane can only
    ever ask the first.

    ``OON_INTEREST`` was declared, priority-mapped and gated but never produced
    by anything; this is its first producer.
    """
    community_posts = gateway.community_posts(viewer.interest_communities, since, limit)
    tag_posts = gateway.tag_posts(viewer.interest_tags, since, limit)
    merged: dict[str, Candidate] = {
        post.key: Candidate(post=post, source=CandidateSource.OON_INTEREST)
        for post in community_posts
    }
    for post in tag_posts:
        merged.setdefault(post.key, Candidate(post=post, source=CandidateSource.OON_INTEREST))
    return list(merged.values())


def popular_fallback(gateway: HafsqlGateway, since: datetime, limit: int) -> list[Candidate]:
    """Community-popular fallback for a fully-cold viewer (§13.5b).

    Used when the interest-seeded pool would otherwise be empty (e.g. a
    viewer who hasn't picked any interests yet). Wraps
    :meth:`HafsqlGateway.popular_posts` as ``INTEREST_TAG`` candidates — the
    cold-start exploration lane is gate-exempt (§8.1), which is what a blank
    viewer with no follow graph needs.
    """
    # ★ Labelled POPULAR_FALLBACK, not INTEREST_TAG (2026-08-01). This padding is
    # global popularity with no relation to anything the viewer picked; emitting
    # it as INTEREST_TAG made "interest-lane coverage" unfalsifiable — in the
    # measured follow-cliff case 17 of 20 slots were globally-popular posts
    # indistinguishable, in the output, from genuine interest matches.
    return [
        Candidate(post=post, source=CandidateSource.POPULAR_FALLBACK)
        for post in gateway.popular_posts(since, limit)
    ]
