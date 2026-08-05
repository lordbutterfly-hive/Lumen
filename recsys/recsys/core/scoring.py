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
from collections.abc import Callable, Iterable, Mapping
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
from recsys.core.viewer_affinity import blend as viewer_blend
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
    weights: ScoreWeights | None = None,
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
            post,
            excluded,
            trust=trust,
            require_attribution=require_attribution,
            weights=weights,
        )
    )


def declared_interest_raw(post: Post, interest_tags: frozenset[str]) -> float:
    """★ B-02 (2026-08-04). Share of the post's own tags the viewer explicitly
    declared as an interest at signup — the raw the declared-interest term
    (:data:`recsys.config.ScoreWeights.interest_match`) is built from.

    ``0.0`` when the viewer declared nothing, or the post carries no tags —
    never ``None``, never a made-up constant: an absence of signal is an
    honest zero here, and the caller (:func:`score_candidate`, via the
    percentile step) treats it as such rather than inventing one.

    ★ VIEWER-OWN, not cross-viewer: only the viewer's own ``interest_tags``
    choice moves this, so unlike CF no stranger can move it by engaging
    anything.

    ★★ THE CEILING, STATED HONESTLY. ``post.tags`` is attacker-controlled free
    text — any author may tag a post with every popular interest. The
    ``len(post.tags)`` denominator is the only bound: spreading N genuinely
    matching tags across M total tags caps the achievable share at N/M, so
    padding with MORE tags than truly apply can only shrink the share, never
    lift it above 1.0 — but a post with FEW tags, all of them popular, still
    farms this cheaply. This is exactly why the gate-EXEMPT exploration lane
    (``core/exploration.py::_interest_match``, BUILD-ADJUDICATION R3)
    restricts itself to the post's PRIMARY tag only: that lane bypasses the
    vouch gate and the author floor, so it needs the strict form. This
    function backs a term that does NOT bypass those gates — it only
    re-ranks candidates that already cleared ``filter_eligible`` — so the
    full-intersection form here matches what R3 already permits for the
    equivalent gated case (``second_degree._ungated_lane_for``).
    """
    if not interest_tags or not post.tags:
        return 0.0
    return len(set(post.tags) & interest_tags) / len(post.tags)


def recency_bonus(post: Post, now: datetime, half_life_hours: float) -> float:
    """Additive freshness bonus in ``(0, 1]`` — never a multiplicative decay
    (§6), so age discounts a post, it does not erase it."""
    age_hours = max((now - post.created).total_seconds() / 3600.0, 0.0)
    return 0.5 ** (age_hours / half_life_hours)


def pooled_author_base(
    own_base: float,
    prior: AuthorEngagement | None,
    post_share: float,
    shrinkage: float = 0.0,
) -> float:
    """Blend a post's own log-engagement with a LEAVE-ONE-OUT mean over the
    author's other window posts, SHRUNK toward the post's own signal by how
    little evidence the mean is estimated from.

    ★ SHRINKAGE (2026-08-03). The blend used to be a FIXED ``post_share`` /
    ``1 - post_share`` split the moment an author had two window posts, which
    made the estimator say the same thing about a mean over 1 other post as
    about a mean over 40. Two measured consequences, both real:

    * **A new author is buried by their own newness.** For a newcomer the
      "other posts" are unengaged BECAUSE they are new, so the estimator
      conflates *not yet discovered* with *low quality*: 1 good post + 2
      unengaged took the pooled base from 1.0000 to 0.3333 (-67%), and
      end-to-end a new author with 9 votes + 2 comments + 1 reblog reached
      top-20 for 0/10 established viewers (q3).
    * **A cliff at the second post.** ``posts <= 1`` returns ``own_base``
      outright — no prior at all — and the very next post jumped straight to
      two thirds prior. Nothing in the data justifies that discontinuity.

    Both come from the same omission: the blend never asked how much evidence
    the mean rests on. It does now. With ``n = posts - 1`` other posts and
    shrinkage constant ``k``::

        prior_weight = (1 - post_share) * n / (n + k)

    ``k = 0`` reproduces the fixed blend BYTE-FOR-BYTE (``n / n == 1``), which
    is why it is the default here — the behaviour change is opt-in through
    ``ScoreWeights.organic_prior_shrinkage``. ``k > 0`` makes the prior earn
    its weight: it approaches ``1 - post_share`` asymptotically, so an
    established author with a deep window is scored as before, while a thin
    pool is discounted toward the prior-less fallback. The ``n = 1`` cliff
    disappears with it — ``prior_weight -> 0`` as ``n -> 0``, which is exactly
    the ``posts <= 1`` branch above, so the estimator is now continuous across
    that boundary instead of stepping.

    It is deliberately SYMMETRIC: thin evidence withholds the prior's HELP as
    well as its harm, so the steady author whose other posts all drew
    engagement is also moved back toward their own post's signal at ``n = 1``.
    This is a statement about the variance of a small-sample mean, not a
    newcomer subsidy — a rule that only ever helped new authors would be a
    thumb on the scale, and would be gamed by staying "new".

    NOT IMPLEMENTED HERE — the other half of the designed fix, excluding posts
    too young to have accumulated engagement, needs a per-post age the grouped
    aggregate does not carry AND an instrument that models engagement arriving
    over time. ``simworld`` does not: it draws every post's engagement
    independently of the post's age (``simworld.build_world``), so a maturity
    horizon tuned on it would be tuned against nothing. That lever is
    LIVE-HAFSQL-GATED; do not add it on synthetic evidence.

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
    Shrinkage does not weaken that: ``prior_weight`` is bounded by
    ``1 - post_share`` from above and 0 from below for every ``n >= 1`` and
    ``k >= 0``, so the blend stays convex and the range guarantee holds for
    any shrinkage setting.
    """
    if prior is None or prior.posts <= 1:
        return own_base
    others = prior.posts - 1
    loo = max((prior.total_base - own_base) / others, 0.0)
    # Written as "the weight shrinkage takes OFF the prior goes back to the
    # post's own signal" rather than `1 - prior_weight`, so that at
    # shrinkage == 0 (evidence == 1.0) these two coefficients collapse to
    # EXACTLY `post_share` and `1 - post_share` — the pre-shrinkage expression,
    # bit for bit. `1 - (1 - post_share)` does not: for post_share = 1/3 it is
    # 0.33333333333333337, and a control column that is only ALMOST the shipped
    # behaviour is not a control.
    evidence = others / (others + shrinkage)
    prior_weight = (1.0 - post_share) * evidence
    own_weight = post_share + (1.0 - post_share) * (1.0 - evidence)
    return own_weight * own_base + prior_weight * loo


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
        post,
        excluded,
        trust=trust,
        require_attribution=require_attribution,
        weights=weights,
    )
    pooled = pooled_author_base(
        own_base,
        prior,
        weights.organic_post_share,
        weights.organic_prior_shrinkage,
    )
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
    interest_percentile: float | None = None,
    viewer_percentile: float | None = None,
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

    ★ B-02 (2026-08-04): ``interest_percentile`` is this candidate's
    declared-interest percentile (:func:`declared_interest_raw`, ranked within
    the request's own pool — see :func:`recsys.pipeline._interest_lookup`).
    ``None`` (no declared interests, or the channel off) leaves the score
    exactly as it would be without the channel, same as every other viewer-own
    channel here.

    ★★ WHERE THE DECLARED-INTEREST TERM BLENDS — MOVED FROM THE ORGANIC SLICE
    TO THE COMPOSITE (2026-08-05). It used to blend INSIDE ``organic``, between
    the CF blend and the viewer-own-affinity blend::

        organic = (1 - w)*organic + w*interest_pct        # OLD
        final   = 0.1*vote + 0.1*rep + 0.8*organic

    Its own docstring said that "trades against the quality percentile only —
    the 10/10/80 outer split is untouched". That is true of the arithmetic and
    FALSE OF THE EFFECT, and the difference was measured. The declared-interest
    percentile is very nearly CONSTANT inside a topic (every post the viewer
    declared an interest in scores the same on it), so within the block that
    makes up ~89% of a served feed it supplies no ordering at all — while still
    taking 40% of the organic slice. The composite's DISCRIMINATING weights
    inside that block therefore became ``0.10 vote / 0.10 rep / 0.48 quality``,
    i.e. the vote and reputation terms went from 11%/11% of the deciding mass
    to 17%/17% — a 1.67x amplification nobody chose, paid for entirely by the
    quality percentile. The author-pooled prior lives ONLY in that quality
    percentile, so the prior is what paid.

    So the blend now happens at the composite, against the earned score::

        earned = 0.1*vote + 0.1*rep + 0.8*organic        # organic: CF + viewer-own
        final  = (1 - W)*earned + W*interest_pct
        W      = weights.organic * weights.interest_match

    All three earned signals are scaled by the same ``1 - W``, so the 10/10/80
    balance among them is preserved at EVERY ``interest_match`` value.

    ``W = weights.organic * weights.interest_match`` IS THE SLOPE-PRESERVING
    CHOICE, deliberately: under the old form the term's contribution to
    ``final`` was ``0.8 * interest_match * interest_pct``, and it still is. The
    gap this term opens between an on-interest and an off-interest candidate is
    therefore BYTE-IDENTICAL to the old form — this is a re-basing of what the
    term takes its weight FROM, not a strengthening or weakening of the term.

    ``interest_match = 0.0``, and ``interest_percentile = None`` at any weight,
    both still reproduce the pre-B02 score exactly (``W = 0`` /
    :func:`~recsys.core.viewer_affinity.blend`'s identity), which is what the
    byte-identity invariant in ``tests/test_scoring.py`` pins.

    The viewer-own-affinity blend consequently now runs BEFORE the declared
    -interest blend rather than after. That is a real ordering change and it is
    a no-op at the shipped ``organic_viewer = 0.0``; the two channels answer
    different questions (one is per-author/topic engagement, one is a per-topic
    signup declaration) and the composite-level blend is the right home for the
    one that is constant across a topic.

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
    # ★ VIEWER-OWN AFFINITY (2026-08-01). Trades against the blended quality
    # value only; `organic_cf` and the 10/10/80 outer split are untouched.
    #
    # This is the channel that makes engagement move a feed at all — measured
    # before it existed, 30 rounds of consistent topic engagement shifted a
    # viewer's topic share by 0.0000. It is deliberately NOT the CF term: CF is
    # cross-viewer and poisonable by strangers (hence H06/H07's caps), whereas
    # only the viewer's own outgoing engagement moves this one.
    #
    # `viewer_percentile is None` (no history, or the channel disabled) returns
    # `organic` unchanged, so a viewer with nothing to personalise on is scored
    # exactly as before rather than being blended toward zero.
    organic = viewer_blend(organic, viewer_percentile, weights.organic_viewer)
    # The EARNED score: what this post and this author actually did, at the §0
    # outer split. Every term in it is something someone else can observe about
    # the candidate — nothing here is a statement the viewer made about
    # themselves.
    earned = weights.vote * vote_norm + weights.reputation * rep_norm + weights.organic * organic
    # ★ DECLARED INTEREST (B-02 2026-08-04; re-based to the composite
    # 2026-08-05 — see this function's docstring for the measurement). It
    # blends against the EARNED score, so vote, reputation and quality are all
    # scaled by the same `1 - interest_weight` and their 10/10/80 balance
    # survives every `interest_match` value. `interest_weight` is
    # `organic * interest_match`, which keeps this term's contribution to
    # `final` byte-identical to the pre-2026-08-05 form.
    interest_weight = weights.organic * weights.interest_match
    final = viewer_blend(earned, interest_percentile, interest_weight)
    interest_bonus = (
        0.0
        if interest_percentile is None or interest_weight <= 0.0
        else interest_weight * interest_percentile
    )
    return ScoredCandidate(
        post=candidate.post,
        source=candidate.source,
        score=ScoreBreakdown(
            vote_norm=vote_norm,
            rep_norm=rep_norm,
            organic=organic,
            final=final,
            interest_bonus=interest_bonus,
        ),
    )


def score_candidates(
    items: Iterable[tuple[Candidate, float, float]],
    norm: NormContext,
    weights: ScoreWeights,
    cf_percentiles: Mapping[str, float] | None = None,
    *,
    cf_suppressed_sources: frozenset[CandidateSource] = frozenset(),
    interest_percentiles: Callable[[Candidate], float | None] | None = None,
    viewer_percentiles: Callable[[Candidate], float | None] | None = None,
) -> list[ScoredCandidate]:
    """Score each ``(candidate, vote_signal_raw, organic_raw)`` triple
    independently (§3.3).

    ``cf_percentiles`` is keyed by AUTHOR, not by post — CF affinity is a
    viewer x author quantity (§6.1), so every post by the same author shares
    one value, and passing it as a mapping keeps per-candidate scoring free of
    cross-item state. ``None`` (the default) drops the CF slice for the whole
    batch.

    ``interest_percentiles`` (B-02, 2026-08-04) is a per-CANDIDATE lookup, like
    ``viewer_percentiles`` below (declared interest is scored per POST — a
    tag-intersection share — not per author). ``None`` means "this viewer
    declared no interests, or the channel is off" and leaves every score
    untouched.

    ``cf_suppressed_sources`` (H07/C1, 2026-07-22) forces
    ``cf_percentile=None`` for any candidate whose ``source`` is in the set,
    regardless of what ``cf_percentiles`` holds for its author — the
    CF-suppression half of the followless-established interest-lane gap (see
    :func:`recsys.core.coldstart.is_established_followless`). The gate-exempt
    interest lane (``INTEREST_TAG``) applies NO graph-cred floor at all, so
    for a viewer who is routed there for the
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
            interest_percentile=(
                None if interest_percentiles is None else interest_percentiles(candidate)
            ),
            # Viewer-own affinity is a per-CANDIDATE lookup (author OR topic), not
            # an author-keyed mapping like CF, so it arrives as a callable. None
            # means "this viewer has no opinion" and leaves the score untouched.
            viewer_percentile=(
                None if viewer_percentiles is None else viewer_percentiles(candidate)
            ),
        )
        for candidate, vote_signal_raw, organic_raw in items
    ]


__all__ = [
    "AuthorEngagement",
    "AuthorPriorGateway",
    "declared_interest_raw",
    "organic_quality_raw",
    "pooled_author_base",
    "post_base_engagement",
    "recency_bonus",
    "score_candidate",
    "score_candidates",
]
