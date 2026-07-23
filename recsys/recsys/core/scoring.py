"""Composite scoring (§0, §3.3): blend independently-normalized signals into
a single ranking score per candidate — and build the 80% organic term itself.

Depends only on the normalization primitives, the engagement primitives and
the shared contracts, so each candidate is scored in isolation — no cross-item
state (the author-pooled prior is a *per-author* aggregate over the rolling
window, fetched once per request, never a function of the candidate pool; see
:class:`AuthorPriorGateway`).

THE ORGANIC REBUILD (2026-07-21). The 80% organic term used to be a single
percentile of ``log10(1+engagement) + 0.5*recency + 1.5*cf_affinity``, ranked
against a rolling sample built viewer-independently at ``cf = 0``. Measured
consequence on the 24-viewer harness panel: the raw CF bump (mean +1.036 for
cf > 0.05) exceeded the whole sample's max (1.133), so **68 of 113 pool posts
clipped at organic percentile = 1.0**, distinct organic values collapsed
113 -> 39, and **12.8 of the top-20 slots were exact ties at organic = 1.0**.
Across those slots the 80% term was a CONSTANT and the real ranking fell to
the 10% vote term (stake-driven), the 10% reputation term and re-ranker
tie-breaks. Concretely: viewer ``v-dev-01`` was served a quality-0.312 post
(organic 0.996) while three quality-0.870 posts sat outside the feed.

The rebuild is two changes, both inside this 80% slice — the 10/10/80 outer
weights are untouched:

1. **Joint normalization.** ``organic`` is now a convex blend of two values
   that are ALREADY percentiles, so neither can push the other off the top of
   a sample:

       organic = weights.organic_quality * qual_pct + weights.organic_cf * cf_pct

   ``cf_pct`` is the CF affinity's rank inside the VIEWER'S OWN affinity
   distribution over every trained author
   (:func:`recsys.core.als.viewer_affinity_percentiles`) — a distribution the
   candidate pool cannot reshape. ``qual_pct`` is the global §4 percentile of
   the quality raw below. Saturation is structurally impossible: a percentile
   of a percentile-bounded blend cannot exceed 1.0, and the quality raw is a
   convex combination of values drawn from the very sample it is ranked
   against (see 2.), so it cannot exceed that sample's max either.

2. **Author-pooled engagement prior.** A single post's independent-engagement
   count is ~5-voter Bernoulli luck: its Spearman correlation with the
   author's true quality is only 0.353 on the harness world. Pooling an
   author's OTHER window posts (leave-one-out, so the post's own luck is never
   double-counted) is a far better estimator of the quality the viewer will
   actually get. One grouped aggregate per author per window supplies it —
   on-chain data (votes/comments/reblogs) we already read.

Both halves degrade honestly: no ALS model, a behaviourally-cold viewer, or
``ALSConfig.cf_weight == 0`` drops the CF slice and the quality percentile
carries the full 80%; a gateway with no author aggregate (or an author with a
single window post) falls back to that post's own engagement, i.e. exactly
the pre-rebuild quality raw.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable

from recsys.config import ScoreWeights
from recsys.contracts import (
    Candidate,
    CandidateSource,
    NormContext,
    Post,
    ScoreBreakdown,
    ScoredCandidate,
)
from recsys.core.normalize import percentile_rank
from recsys.core.vote_signal import VoterTrust, independent_organic_engagement


@dataclass(frozen=True)
class AuthorEngagement:
    """One author's independent-engagement aggregate over the rolling window
    (§4/§6) — the pooled quality prior's only input.

    ``posts`` is the author's top-level post count in the window; ``total_base``
    is the sum, over those posts, of ``log10(1 + independent engagement)`` —
    the SAME per-post scale :func:`post_base_engagement` computes and the same
    scale the §4 ``organic_samples`` are drawn on, which is what keeps the
    pooled estimator inside the norm sample's range.
    """

    posts: int
    total_base: float


@runtime_checkable
class AuthorPriorGateway(Protocol):
    """The one extra read the author-pooled prior needs, kept as its own
    Protocol so a gateway that does not implement it still works (the pipeline
    checks with ``isinstance`` and falls back to per-post engagement).

    Production implementation is one grouped query over the same window the
    §4 norm context is built from — no new data source, no telemetry, and the
    same attributed distinct-identity signal the organic term already scores,
    passed through the SAME §8.4 exclusion set (self-vote + stake lineage +
    ring co-members) that ``own_base`` and the vote signal already apply.

    This is the fix for the pooled prior's one unguarded input. ``total_base``
    is a per-author aggregate an author can influence by farming their OWN
    other window posts. Self-exclusion is a static ``<> c.author`` predicate
    SQL owns outright — but the snapshot-dependent lineage/ring identities are
    invisible to SQL, so an earlier self-exclusion-ONLY aggregate let an author
    inflate their prior with delegation-tied alts and a reciprocal ring: the
    exact engagement the vote signal already refuses to count on ``own_base``.
    Closed the same way the vote signal closes it — the caller derives the
    per-author set ``VoteExclusions.excluded()`` (self + lineage + ring) from
    the weekly trust snapshot and passes it in as ``excluded``; the query
    anti-joins each author's voters/commenters/rebloggers against their own
    excluded set. The authoritative SQL lives on
    ``recsys.io.hafsql.HafsqlClient.author_engagement`` (``_SQL_AUTHOR_ENGAGEMENT``).

    H05 (2026-07-22): the exclusion fix above only closes SELF/lineage/ring —
    it does nothing about un-budgeted BREADTH. An author's window posts can
    still be farmed by bare unknown-tier sock upvotes that pass every §8.4
    exclusion (they are not the author, not lineage, not a reciprocal ring —
    see :class:`~recsys.core.vote_signal.VoterTrust`), inflating ``total_base``
    and, through the leave-one-out mean, the pooled organic prior. ``trust``
    closes that: passed through, the query applies the SAME
    ``vouched + budgeted(unknown)`` credit
    (:meth:`~recsys.core.vote_signal.VoterTrust.credited_breadth`) to each
    window post's distinct voters/commenters/rebloggers BEFORE summing, so
    ``total_base`` is breadth-budgeted on the SAME terms as ``own_base``
    instead of counting raw distinct identities. ``None`` (no trust snapshot)
    degrades to the unbudgeted raw count — byte-identical to the
    pre-H05 query and the pre-hardening §4 norm sample.

    With ``trust`` now threaded, ``own_base`` and ``total_base`` are
    breadth-consistent by construction; the one thing a grouped aggregate
    still cannot see is a candidate's OWN request-time exclusion nuance (e.g.
    hydration ordering skew between the two reads). That residual is what
    :func:`pooled_author_base`'s leave-one-out clamp now exists for — pure
    defense-in-depth against a negative, never the primary budget absorber it
    was before H05.
    """

    def author_engagement(
        self,
        authors: frozenset[str],
        since: datetime,
        excluded: Mapping[str, frozenset[str]] | None = None,
        *,
        trust: VoterTrust | None = None,
    ) -> Mapping[str, AuthorEngagement]:
        """Per-author window aggregate for ``authors`` (absent = no window
        posts recorded, which the caller treats as "no prior").

        ``excluded`` maps each author to the identities whose engagement must
        NOT count toward that author's pooled prior — the §8.4 set the pipeline
        derives per request (``VoteExclusions.excluded()``: self + stake
        lineage + ring co-members). ``None``, or an author absent from it,
        applies self-exclusion only — the honest Phase-0 default for a gateway
        with no trust snapshot, matching the pre-hardening behaviour the §4
        norm sample is built on.

        ``trust`` (H05) graph-cred-weights the BREADTH of each window post's
        surviving (post-exclusion) voters/commenters/rebloggers before they are
        summed into ``total_base`` — the same
        :class:`~recsys.core.vote_signal.VoterTrust` budget ``own_base``
        already applies, so a swarm of unknown-tier sock upvotes on an author's
        OTHER window posts cannot inflate the pooled prior even though each
        sock individually clears self/lineage/ring exclusion. ``None`` (no
        trust snapshot) applies no budget — the raw distinct count, matching
        the pre-H05 query."""
        ...


def post_base_engagement(
    post: Post,
    excluded: frozenset[str],
    *,
    trust: VoterTrust | None = None,
    require_attribution: bool = False,
) -> float:
    """One post's log-compressed independent engagement — the atom every
    other quantity here is built from, and the scale the §4 organic sample is
    drawn on. ``excluded`` is the §8.4 identity filter (author, stake lineage,
    ring). ``trust`` graph-cred-weights the engagement breadth against funded
    alts, and ``require_attribution`` makes a missing-attribution post fail loud
    (both forwarded to
    :func:`recsys.core.vote_signal.independent_organic_engagement`; their
    ``None`` / ``False`` defaults reproduce the pre-hardening value the §4 norm
    sample is built on)."""
    return math.log10(
        1.0
        + independent_organic_engagement(
            post, excluded, trust=trust, require_attribution=require_attribution
        )
    )


def recency_bonus(post: Post, now: datetime, half_life_hours: float) -> float:
    """Additive freshness bonus in ``(0, 1]`` — never a multiplicative decay
    (§6), so age discounts a post, it does not erase it."""
    age_hours = max((now - post.created).total_seconds() / 3600.0, 0.0)
    return 0.5 ** (age_hours / half_life_hours)


def pooled_author_base(
    own_base: float, prior: AuthorEngagement | None, post_share: float
) -> float:
    """Blend a post's own log-engagement with a LEAVE-ONE-OUT mean over the
    author's other window posts.

    Why leave-one-out and not the plain author mean: the post's own draw
    already enters through ``own_base``: letting it into the prior as well
    would re-credit the same ~5-voter coin flip twice and re-introduce exactly
    the per-post luck the pooling exists to average away. With ``n = 1`` there
    are no other posts, so there is no prior and the estimator collapses to
    ``own_base`` (the pre-rebuild behaviour) rather than inventing one — a
    brand-new author is neither boosted nor buried by a pool of one.

    The subtraction is clamped at zero to guard the residual mismatch that
    survives the query-level §8.4 + breadth-budget fixes. ``total_base`` now
    carries the SAME two guards ``own_base`` does — the §8.4 identity exclusion
    (self + stake lineage + ring — see :class:`AuthorPriorGateway`) AND, since
    H05, the same graph-cred breadth BUDGET
    (:class:`~recsys.core.vote_signal.VoterTrust`) applied per window post
    before summing — so neither lineage/ring farming nor un-budgeted sock
    breadth can inflate the pool any more than they could inflate a single
    post's own signal. With both guards aligned, the clamp is no longer the
    primary budget-residual absorber; it stays as pure defense-in-depth against
    an aggregate/hydration skew across the two reads (e.g. the two queries
    observing the trust snapshot or the window a moment apart) that could
    otherwise rent a negative — i.e. a *bonus* — out of the gap: a discounted
    author whose ``own_base`` is stripped harder than the aggregate happened to
    see is floored at the prior-less fallback, never lifted by the gap.

    The result is a convex combination of same-scale log-engagement values, so
    it can never leave the range of the §4 sample it will be ranked against.
    """
    if prior is None or prior.posts <= 1:
        return own_base
    loo = max((prior.total_base - own_base) / (prior.posts - 1), 0.0)
    return post_share * own_base + (1.0 - post_share) * loo


def organic_quality_raw(
    post: Post,
    now: datetime,
    excluded: frozenset[str],
    *,
    prior: AuthorEngagement | None = None,
    weights: ScoreWeights,
    trust: VoterTrust | None = None,
    require_attribution: bool = False,
) -> float:
    """The organic term's QUALITY raw (§6): author-pooled independent
    engagement plus the additive freshness bonus. Viewer-independent by
    construction — everything personalized lives in the CF percentile — which
    is what lets one global §4 sample normalize it for every viewer.

    Recency is applied to the post itself and is deliberately NOT pooled: an
    author's other posts' ages say nothing about how fresh THIS one is.

    ``trust`` graph-cred-weights the post's OWN engagement breadth (funded-alt
    hardening); the author-pooled ``prior`` is a §8.4-excluded, breadth-budgeted
    window aggregate (self + lineage + ring, PLUS the same ``trust`` budget
    applied per post before summing — see :class:`AuthorPriorGateway`, H05), so
    its leave-one-out mean is guarded on the same terms as ``own_base``. The
    caller is responsible for passing the SAME ``trust`` into both the scorer
    (here) and the gateway's ``author_engagement`` call, or the two reads drift
    out of alignment and lean on :func:`pooled_author_base`'s clamp again.
    ``require_attribution`` fails loud on a post that never had its
    comment/reblog identity hydrated. Both default to the pre-hardening
    behaviour the §4 norm sample is built on.
    """
    own_base = post_base_engagement(
        post, excluded, trust=trust, require_attribution=require_attribution
    )
    pooled = pooled_author_base(own_base, prior, weights.organic_post_share)
    if weights.organic_recency == 0.0:
        return pooled
    return pooled + weights.organic_recency * recency_bonus(
        post, now, weights.organic_half_life_hours
    )


def score_candidate(
    candidate: Candidate,
    *,
    vote_signal_raw: float,
    organic_raw: float,
    norm: NormContext,
    weights: ScoreWeights,
    cf_percentile: float | None = None,
) -> ScoredCandidate:
    """Percentile-normalize each raw signal and blend per the ``ScoreWeights``
    (§0, §3.3).

    ``organic_raw`` is the viewer-independent quality raw from
    :func:`organic_quality_raw`; ``cf_percentile`` is this candidate author's
    CF affinity rank within the viewer's own distribution
    (:func:`recsys.core.als.viewer_affinity_percentiles`). ``None`` means the
    request has no CF slice at all — no trained model, a behaviourally-cold
    viewer, or the ``cf_weight`` ablation — and the quality percentile then
    carries the full organic weight instead of being silently blended with a
    made-up constant.

    H06 (PRUNED audit 2026-07-22): the CF weight is source-discounted —
    ``weights.organic_cf`` applies at full strength only to ``IN_NETWORK``
    candidates (the viewer's own follow graph has already vetted that
    author); every other source (the second-degree-gate-EXEMPT
    ``INTEREST_*`` lanes, and any OON source) is scaled by
    ``weights.organic_cf_oon_scale`` first. This is where a one-directional,
    un-reciprocated sock->author co-engagement edge is hardest to catch
    upstream (see C1/C2 — it slips both ring detection, which needs a
    reciprocal edge, and stake-lineage, which needs a transfer record), so
    weighing CF there as heavily as in-network engagement would re-open a
    laundering door one layer up the stack from the breadth-budget fixes.
    The blend stays convex either way: ``cf_w = organic_cf`` (in-network) or
    ``organic_cf * organic_cf_oon_scale`` (everything else), and
    ``(1 - cf_w) * quality + cf_w * cf_percentile`` — since
    ``organic_quality + organic_cf == 1.0`` is enforced by
    :meth:`ScoreWeights.__post_init__`, ``1 - cf_w`` equals
    ``weights.organic_quality`` exactly for ``IN_NETWORK`` candidates, so
    this is byte-identical to the pre-H06 formula for them; for a discounted
    source, the quality percentile absorbs whatever weight CF gave up, so
    ``organic`` never leaves ``[0, 1]``.
    """
    vote_norm = percentile_rank(vote_signal_raw, norm.vote_signal_samples)
    rep_norm = percentile_rank(candidate.post.author_reputation, norm.reputation_samples)
    quality = percentile_rank(organic_raw, norm.organic_samples)
    if cf_percentile is None:
        organic = quality
    else:
        cf_w = (
            weights.organic_cf
            if candidate.source.is_in_network
            else weights.organic_cf * weights.organic_cf_oon_scale
        )
        organic = (1.0 - cf_w) * quality + cf_w * cf_percentile
    final = weights.vote * vote_norm + weights.reputation * rep_norm + weights.organic * organic
    return ScoredCandidate(
        post=candidate.post,
        source=candidate.source,
        score=ScoreBreakdown(vote_norm=vote_norm, rep_norm=rep_norm, organic=organic, final=final),
    )


def score_candidates(
    items: Iterable[tuple[Candidate, float, float]],
    norm: NormContext,
    weights: ScoreWeights,
    cf_percentiles: Mapping[str, float] | None = None,
    *,
    cf_suppressed_sources: frozenset[CandidateSource] = frozenset(),
) -> list[ScoredCandidate]:
    """Score each ``(candidate, vote_signal_raw, organic_raw)`` triple
    independently (§3.3).

    ``cf_percentiles`` is keyed by AUTHOR, not by post — CF affinity is a
    viewer x author quantity (§6.1), so every post by the same author shares
    one value, and passing it as a mapping keeps per-candidate scoring free of
    cross-item state. ``None`` (the default) drops the CF slice for the whole
    batch.

    ``cf_suppressed_sources`` (H07/C1, 2026-07-22) forces
    ``cf_percentile=None`` for any candidate whose ``source`` is in the set,
    regardless of what ``cf_percentiles`` holds for its author — the
    CF-suppression half of the followless-established interest-lane gap (see
    :func:`recsys.core.coldstart.is_established_followless`). The gate-exempt
    interest lane (``INTEREST_COMMUNITY``/``INTEREST_TAG``) applies NO
    graph-cred floor at all, so for a viewer who is routed there for the
    FOLLOWLESS reason but is not actually a true cold start (they have a
    trained ALS row), a poisoned co-engagement edge could otherwise lift a
    spam author's interest-lane candidate through the CF percentile with
    nothing else standing in the way. The default empty set is a no-op —
    every existing caller (including a TRUE cold newcomer, who never reaches
    this set because their viewer has no ALS row in the first place) is
    byte-for-byte unaffected.
    """
    return [
        score_candidate(
            candidate,
            vote_signal_raw=vote_signal_raw,
            organic_raw=organic_raw,
            norm=norm,
            weights=weights,
            cf_percentile=(
                None
                if cf_percentiles is None or candidate.source in cf_suppressed_sources
                else cf_percentiles.get(candidate.post.author, 0.5)
            ),
        )
        for candidate, vote_signal_raw, organic_raw in items
    ]


__all__ = [
    "AuthorEngagement",
    "AuthorPriorGateway",
    "organic_quality_raw",
    "pooled_author_base",
    "post_base_engagement",
    "recency_bonus",
    "score_candidate",
    "score_candidates",
]
