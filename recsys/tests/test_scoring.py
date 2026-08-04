"""Tests for recsys.core.scoring — composite score blending (§0, §3.3)."""

from __future__ import annotations

import pytest

from recsys.config import ScoreWeights
from recsys.contracts import CandidateSource, NormContext
from recsys.core.scoring import (
    AuthorEngagement,
    pooled_author_base,
    score_candidate,
    score_candidates,
)
from tests.fakes import make_candidate, make_post

NORM = NormContext(
    vote_signal_samples=(0.0, 1.0, 2.0, 3.0, 4.0),
    reputation_samples=(10.0, 20.0, 30.0, 40.0, 50.0),
    organic_samples=(0.0, 0.25, 0.5, 0.75, 1.0),
)
WEIGHTS = ScoreWeights()  # 0.10 / 0.10 / 0.80


def test_final_in_unit_interval() -> None:
    candidate = make_candidate(post=make_post(author_reputation=30.0))
    result = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM, weights=WEIGHTS
    )
    assert 0.0 <= result.score.vote_norm <= 1.0
    assert 0.0 <= result.score.rep_norm <= 1.0
    assert 0.0 <= result.score.organic <= 1.0
    assert 0.0 <= result.score.final <= 1.0


def test_vote_component_monotonic() -> None:
    candidate = make_candidate(post=make_post(author_reputation=30.0))
    low = score_candidate(
        candidate, vote_signal_raw=1.0, organic_raw=0.5, norm=NORM, weights=WEIGHTS
    )
    high = score_candidate(
        candidate, vote_signal_raw=3.0, organic_raw=0.5, norm=NORM, weights=WEIGHTS
    )
    assert high.score.vote_norm > low.score.vote_norm
    assert high.score.final > low.score.final


def test_reputation_component_monotonic() -> None:
    low_candidate = make_candidate(post=make_post(author_reputation=15.0))
    high_candidate = make_candidate(post=make_post(author_reputation=45.0))
    low = score_candidate(
        low_candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM, weights=WEIGHTS
    )
    high = score_candidate(
        high_candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM, weights=WEIGHTS
    )
    assert high.score.rep_norm > low.score.rep_norm
    assert high.score.final > low.score.final


def test_organic_component_monotonic() -> None:
    candidate = make_candidate(post=make_post(author_reputation=30.0))
    low = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.1, norm=NORM, weights=WEIGHTS
    )
    high = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.9, norm=NORM, weights=WEIGHTS
    )
    assert high.score.organic > low.score.organic
    assert high.score.final > low.score.final


def test_all_organic_weight_final_equals_organic() -> None:
    candidate = make_candidate(post=make_post(author_reputation=30.0))
    organic_only = ScoreWeights(vote=0.0, reputation=0.0, organic=1.0)
    result = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM, weights=organic_only
    )
    assert result.score.final == result.score.organic


def test_all_vote_weight_final_equals_vote_norm() -> None:
    candidate = make_candidate(post=make_post(author_reputation=30.0))
    vote_only = ScoreWeights(vote=1.0, reputation=0.0, organic=0.0)
    result = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM, weights=vote_only
    )
    assert result.score.final == result.score.vote_norm


def test_score_preserves_post_and_source() -> None:
    post = make_post(author="bob")
    candidate = make_candidate(post=post, source=CandidateSource.OON_ENGAGED)
    result = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM, weights=WEIGHTS
    )
    assert result.post is post
    assert result.source is CandidateSource.OON_ENGAGED


def test_score_candidates_matches_per_item_scoring() -> None:
    candidates = [
        make_candidate(post=make_post(author="alice", author_reputation=15.0)),
        make_candidate(post=make_post(author="bob", author_reputation=45.0)),
    ]
    items = [(candidates[0], 1.0, 0.25), (candidates[1], 3.0, 0.75)]

    batch = score_candidates(items, NORM, WEIGHTS)
    individual = [
        score_candidate(c, vote_signal_raw=v, organic_raw=o, norm=NORM, weights=WEIGHTS)
        for c, v, o in items
    ]
    assert batch == individual


def test_score_candidates_isolation() -> None:
    # Scoring one candidate must not be affected by another candidate's raw
    # values in the same batch — candidate isolation (§3.3).
    candidate = make_candidate(post=make_post(author_reputation=30.0))
    solo = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM, weights=WEIGHTS
    )
    other = make_candidate(post=make_post(author="zoe", author_reputation=10.0))
    batch = score_candidates([(other, 4.0, 1.0), (candidate, 2.0, 0.5)], NORM, WEIGHTS)
    assert batch[1] == solo


def test_score_candidates_empty() -> None:
    assert score_candidates([], NORM, WEIGHTS) == []


# ---------------------------------------------------------------------------
# H06 (PRUNED audit 2026-07-22): CF blend is source-discounted.
# organic_cf_oon_scale scales weights.organic_cf DOWN for every non-
# IN_NETWORK source; IN_NETWORK is always scaled by exactly 1.0.
# ---------------------------------------------------------------------------


def test_cf_blend_in_network_matches_pre_h06_formula() -> None:
    # WEIGHTS is the default (organic_cf_oon_scale=0.0), but IN_NETWORK must
    # be completely unaffected by that default: cf_w == weights.organic_cf
    # regardless of the OON scale.
    candidate = make_candidate(
        post=make_post(author_reputation=30.0), source=CandidateSource.IN_NETWORK
    )
    result = score_candidate(
        candidate,
        vote_signal_raw=2.0,
        organic_raw=0.5,
        norm=NORM,
        weights=WEIGHTS,
        cf_percentile=0.9,
    )
    # organic_raw=0.5 is itself a sample point; percentile_rank counts <=
    # (bisect_right), so 0.0/0.25/0.5 all count -> 3/5 = 0.6.
    quality = 0.6
    expected_organic = WEIGHTS.organic_quality * quality + WEIGHTS.organic_cf * 0.9
    assert result.score.organic == pytest.approx(expected_organic)


def test_cf_blend_default_scale_drops_cf_entirely_for_oon_sources() -> None:
    # Default organic_cf_oon_scale=0.0: a gate-exempt/OON candidate's organic
    # score must be UNAFFECTED by cf_percentile -- as if no CF slice existed
    # at all for that candidate, even though the request has one.
    for source in (
        CandidateSource.INTEREST_TAG,
        CandidateSource.INTEREST_COMMUNITY,
        CandidateSource.OON_ENGAGED,
        CandidateSource.OON_COMMUNITY,
        CandidateSource.OON_INTEREST,
        CandidateSource.OON_ALS,
    ):
        candidate = make_candidate(post=make_post(author_reputation=30.0), source=source)
        with_cf = score_candidate(
            candidate,
            vote_signal_raw=2.0,
            organic_raw=0.5,
            norm=NORM,
            weights=WEIGHTS,
            cf_percentile=0.9,
        )
        no_cf = score_candidate(
            candidate,
            vote_signal_raw=2.0,
            organic_raw=0.5,
            norm=NORM,
            weights=WEIGHTS,
            cf_percentile=None,
        )
        assert with_cf.score.organic == pytest.approx(no_cf.score.organic), source
        # And a wildly different cf_percentile still changes nothing.
        with_other_cf = score_candidate(
            candidate,
            vote_signal_raw=2.0,
            organic_raw=0.5,
            norm=NORM,
            weights=WEIGHTS,
            cf_percentile=0.05,
        )
        assert with_other_cf.score.organic == pytest.approx(no_cf.score.organic), source


def test_cf_blend_partial_oon_scale_is_a_convex_discount() -> None:
    discounted = ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=0.5)
    candidate = make_candidate(
        post=make_post(author_reputation=30.0), source=CandidateSource.OON_ENGAGED
    )
    result = score_candidate(
        candidate,
        vote_signal_raw=2.0,
        organic_raw=0.5,
        norm=NORM,
        weights=discounted,
        cf_percentile=0.9,
    )
    quality = 0.6  # see the bisect_right note in the in-network test above
    cf_w = discounted.organic_cf * discounted.organic_cf_oon_scale  # 0.1 * 0.5 = 0.05
    expected = (1.0 - cf_w) * quality + cf_w * 0.9
    assert result.score.organic == pytest.approx(expected)
    # Strictly between the fully-dropped and fully-in-network readings.
    dropped = ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=0.0)
    full = ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=1.0)
    dropped_organic = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM,
        weights=dropped, cf_percentile=0.9,
    ).score.organic
    full_organic = score_candidate(
        candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM,
        weights=full, cf_percentile=0.9,
    ).score.organic
    assert dropped_organic < result.score.organic < full_organic


def test_cf_blend_oon_scale_one_matches_in_network_formula() -> None:
    # At organic_cf_oon_scale=1.0 an OON candidate's blend is byte-identical
    # to what an IN_NETWORK candidate gets under the same weights.
    full_scale = ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=1.0)
    oon_candidate = make_candidate(
        post=make_post(author_reputation=30.0), source=CandidateSource.OON_ENGAGED
    )
    in_network_candidate = make_candidate(
        post=make_post(author_reputation=30.0), source=CandidateSource.IN_NETWORK
    )
    oon_result = score_candidate(
        oon_candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM,
        weights=full_scale, cf_percentile=0.9,
    )
    in_network_result = score_candidate(
        in_network_candidate, vote_signal_raw=2.0, organic_raw=0.5, norm=NORM,
        weights=full_scale, cf_percentile=0.9,
    )
    assert oon_result.score.organic == pytest.approx(in_network_result.score.organic)


def test_cf_blend_organic_stays_in_unit_interval_for_oon() -> None:
    weights = ScoreWeights(organic_quality=0.7, organic_cf=0.3, organic_cf_oon_scale=0.5)
    candidate = make_candidate(
        post=make_post(author_reputation=30.0), source=CandidateSource.INTEREST_TAG
    )
    for organic_raw, cf_percentile in ((0.0, 1.0), (1.0, 0.0), (0.5, 0.5), (0.9, 0.1)):
        result = score_candidate(
            candidate, vote_signal_raw=2.0, organic_raw=organic_raw, norm=NORM,
            weights=weights, cf_percentile=cf_percentile,
        )
        assert 0.0 <= result.score.organic <= 1.0


def test_organic_cf_oon_scale_rejects_out_of_range() -> None:
    with pytest.raises(ValueError, match="organic_cf_oon_scale"):
        ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=1.5)
    with pytest.raises(ValueError, match="organic_cf_oon_scale"):
        ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=-0.1)


# ---------------------------------------------------------------------------
# H07/C1 (2026-07-22): score_candidates' cf_suppressed_sources forces
# cf_percentile=None per-source, independent of organic_cf_oon_scale -- the
# CF-suppression half of the followless-established interest-lane gap.
# ---------------------------------------------------------------------------


def test_cf_suppressed_sources_forces_no_cf_regardless_of_percentile() -> None:
    full_scale = ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=1.0)
    candidate = make_candidate(
        post=make_post(author="spam", author_reputation=30.0),
        source=CandidateSource.INTEREST_TAG,
    )
    items = [(candidate, 2.0, 0.5)]

    suppressed = score_candidates(
        items,
        NORM,
        full_scale,
        cf_percentiles={"spam": 0.95},
        cf_suppressed_sources=frozenset({CandidateSource.INTEREST_TAG}),
    )
    no_cf_at_all = score_candidates(items, NORM, full_scale, cf_percentiles=None)

    assert suppressed[0].score.organic == pytest.approx(no_cf_at_all[0].score.organic)


def test_cf_suppressed_sources_only_affects_the_named_sources() -> None:
    full_scale = ScoreWeights(organic_quality=0.9, organic_cf=0.1, organic_cf_oon_scale=1.0)
    interest_candidate = make_candidate(
        post=make_post(author="spam", author_reputation=30.0),
        source=CandidateSource.INTEREST_TAG,
    )
    in_network_candidate = make_candidate(
        post=make_post(author="liked", author_reputation=30.0),
        source=CandidateSource.IN_NETWORK,
    )
    items = [(interest_candidate, 2.0, 0.5), (in_network_candidate, 2.0, 0.5)]
    cf_percentiles = {"spam": 0.95, "liked": 0.95}

    scored = score_candidates(
        items,
        NORM,
        full_scale,
        cf_percentiles=cf_percentiles,
        cf_suppressed_sources=frozenset({CandidateSource.INTEREST_TAG}),
    )
    unsuppressed_in_network = score_candidate(
        in_network_candidate,
        vote_signal_raw=2.0,
        organic_raw=0.5,
        norm=NORM,
        weights=full_scale,
        cf_percentile=0.95,
    )
    # IN_NETWORK is not in the suppressed set -> the CF lift still applies.
    assert scored[1].score.organic == pytest.approx(unsuppressed_in_network.score.organic)
    # INTEREST_TAG IS in the suppressed set -> no CF lift despite a high
    # cf_percentile being present in the mapping for its author.
    quality_only = score_candidate(
        interest_candidate,
        vote_signal_raw=2.0,
        organic_raw=0.5,
        norm=NORM,
        weights=full_scale,
        cf_percentile=None,
    )
    assert scored[0].score.organic == pytest.approx(quality_only.score.organic)


def test_cf_suppressed_sources_default_is_a_no_op() -> None:
    candidate = make_candidate(
        post=make_post(author="liked", author_reputation=30.0),
        source=CandidateSource.IN_NETWORK,
    )
    items = [(candidate, 2.0, 0.5)]
    default_call = score_candidates(items, NORM, WEIGHTS, cf_percentiles={"liked": 0.8})
    explicit_empty = score_candidates(
        items, NORM, WEIGHTS, cf_percentiles={"liked": 0.8}, cf_suppressed_sources=frozenset()
    )
    assert default_call == explicit_empty


# ---------------------------------------------------------------------------
# Author-pooled prior aggregation (§6): leave-one-out blend + the residual
# clamp. total_base is now §8.4-exclusion-filtered upstream (see
# AuthorPriorGateway / _SQL_AUTHOR_ENGAGEMENT); the clamp only guards the
# graph-cred breadth-budget residual and any aggregate/hydration skew.
# ---------------------------------------------------------------------------


def test_pooled_base_leave_one_out_averages_the_other_posts() -> None:
    # own_base 0.3; 5 posts, total_base 2.7 -> the OTHER four average
    # (2.7 - 0.3) / 4 = 0.6. post_share 1/3 blends: 1/3*0.3 + 2/3*0.6 = 0.5.
    prior = AuthorEngagement(posts=5, total_base=2.7)
    assert pooled_author_base(0.3, prior, 1.0 / 3.0) == pytest.approx(0.5)


def test_pooled_base_single_post_prior_collapses_to_own_base() -> None:
    # n == 1: no OTHER posts, so no prior — never invent one for a new author.
    prior = AuthorEngagement(posts=1, total_base=9.9)
    assert pooled_author_base(0.3, prior, 1.0 / 3.0) == 0.3
    assert pooled_author_base(0.3, None, 1.0 / 3.0) == 0.3


def test_pooled_base_clamps_the_residual_mismatch_to_never_mint_a_bonus() -> None:
    # own_base (breadth-budgeted / skewed) LARGER than its share of a
    # smaller total_base: the leave-one-out term would go negative and hand the
    # author a bonus. It is clamped at 0, so the pooled value can never exceed
    # own_base out of the exclusion/budget mismatch — a ring-flagged author
    # cannot rent a lift from the gap.
    prior = AuthorEngagement(posts=3, total_base=0.5)
    pooled = pooled_author_base(1.0, prior, 1.0 / 3.0)
    assert pooled == pytest.approx(1.0 / 3.0)  # 1/3*own + 2/3*max(neg, 0)
    assert pooled <= 1.0  # never above own_base: no bonus minted


# ---------------------------------------------------------------------------
# Shrinkage (2026-08-03): the leave-one-out mean earns its weight with the
# number of posts it is estimated from. See pooled_author_base's docstring and
# the four-seed sweep in measurement-harness/q9_prior_shrinkage.py.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("posts", [2, 3, 5, 12, 40])
@pytest.mark.parametrize("own", [0.0, 0.3, 0.8195, 2.0])
@pytest.mark.parametrize("share", [0.0, 1.0 / 3.0, 0.5, 1.0])
def test_shrinkage_zero_is_byte_identical_to_the_fixed_blend(
    posts: int, own: float, share: float
) -> None:
    # k = 0 must be an EXACT identity, not merely close: it is the control
    # column every sweep is read against, and the shipped behaviour before
    # this field existed. n / (n + 0) == 1 for every n, so the arithmetic is
    # the same expression -- assert equality, not approx.
    prior = AuthorEngagement(posts=posts, total_base=own * posts * 0.6)
    legacy = share * own + (1.0 - share) * max(
        (prior.total_base - own) / (posts - 1), 0.0
    )
    assert pooled_author_base(own, prior, share, 0.0) == legacy


def test_shrinkage_prior_weight_rises_with_the_evidence_behind_it() -> None:
    # The whole point: a mean over 1 other post must not speak as loudly as a
    # mean over 40. loo is pinned at 0 (unengaged others), so a HIGHER pooled
    # value means LESS prior weight.
    own = 1.0
    pooled = [
        pooled_author_base(own, AuthorEngagement(posts=n + 1, total_base=own), 1.0 / 3.0, 3.0)
        for n in (1, 2, 4, 10, 40, 1000)
    ]
    assert pooled == sorted(pooled, reverse=True), "prior weight must RISE with n"
    # and it converges ON the unshrunk blend from above, never past it: a deep
    # pool is scored as it is today, so this is not a global de-weighting of
    # the prior -- it is a thin-pool discount that vanishes with evidence.
    unshrunk = 1.0 / 3.0 * own
    assert all(p > unshrunk for p in pooled)
    assert pooled[-1] == pytest.approx(unshrunk, abs=0.005)


def test_shrinkage_removes_the_cliff_at_the_authors_second_post() -> None:
    # posts <= 1 returns own_base outright. Unshrunk, posts == 2 jumped
    # straight to two-thirds prior -- a discontinuity nothing in the data
    # justifies. Shrunk, the estimator is continuous across that boundary.
    own = 1.0
    one_post = pooled_author_base(own, AuthorEngagement(posts=1, total_base=own), 1.0 / 3.0, 3.0)
    two_posts = pooled_author_base(own, AuthorEngagement(posts=2, total_base=own), 1.0 / 3.0, 3.0)
    unshrunk_two = pooled_author_base(own, AuthorEngagement(posts=2, total_base=own), 1.0 / 3.0)
    assert one_post == own
    assert unshrunk_two == pytest.approx(own / 3.0)          # the cliff
    assert two_posts == pytest.approx(own * (1.0 - 2.0 / 3.0 * 0.25))
    assert abs(two_posts - one_post) < abs(unshrunk_two - one_post)


def test_shrinkage_lifts_the_thin_pool_author_and_leaves_the_deep_one_alone() -> None:
    # The two rows of the measured table. New author: 1 engaged post + 2
    # unengaged -> the LOO mean is 0 purely because the other posts are new.
    own = 1.0
    new_author = AuthorEngagement(posts=3, total_base=own)
    # -66.7% of the signal this post actually earned, purely for having two
    # newer siblings; shrinkage at the shipped k = 3 makes it -26.7%. These are
    # the same two ratios the q9 sweep prints for the harness newcomer
    # (own_base 0.8195 -> 0.2732 unshrunk, -> 0.6010 at k = 3).
    assert pooled_author_base(own, new_author, 1.0 / 3.0) == pytest.approx(1.0 / 3.0)
    assert pooled_author_base(own, new_author, 1.0 / 3.0, 3.0) == pytest.approx(11.0 / 15.0)
    # Established author whose other posts did just as well: loo == own, so
    # the blend returns own_base at EVERY shrinkage -- shrinkage cannot move
    # an author whose prior already agrees with the post in front of it.
    deep = AuthorEngagement(posts=6, total_base=own * 6)
    for k in (0.0, 1.0, 3.0, 8.0):
        assert pooled_author_base(own, deep, 1.0 / 3.0, k) == pytest.approx(own)


def test_shrinkage_is_symmetric_and_withholds_help_too() -> None:
    # Not a newcomer subsidy. When the author's OTHER posts did BETTER than
    # this one, thin evidence must withhold that lift on the same terms --
    # otherwise the rule is a thumb on the scale and is farmed by staying new.
    own, loo = 0.2, 1.0
    thin = AuthorEngagement(posts=2, total_base=own + loo)          # n = 1
    deep = AuthorEngagement(posts=401, total_base=own + loo * 400)  # n = 400
    assert pooled_author_base(own, thin, 1.0 / 3.0, 3.0) < pooled_author_base(own, thin, 1.0 / 3.0)
    # the deep pool keeps essentially all of the lift it earned
    assert pooled_author_base(own, deep, 1.0 / 3.0, 3.0) == pytest.approx(
        pooled_author_base(own, deep, 1.0 / 3.0), abs=0.01
    )


@pytest.mark.parametrize("k", [0.0, 0.5, 3.0, 8.0, 1e6])
def test_shrinkage_keeps_the_blend_convex_at_every_setting(k: float) -> None:
    # The range guarantee the §4 norm sample depends on: the result can never
    # leave [min(own, loo), max(own, loo)], so it cannot exceed the sample it
    # will be ranked against however the constant is set.
    own = 0.7
    for total in (0.0, 0.5, 2.1, 9.9):
        prior = AuthorEngagement(posts=4, total_base=total)
        loo = max((total - own) / 3, 0.0)
        pooled = pooled_author_base(own, prior, 1.0 / 3.0, k)
        assert min(own, loo) - 1e-12 <= pooled <= max(own, loo) + 1e-12


@pytest.mark.parametrize("k", [0.0, 0.5, 3.0, 8.0])
def test_shrinkage_still_cannot_mint_a_bonus_from_the_residual(k: float) -> None:
    # The clamp is the defense-in-depth against an aggregate/hydration skew
    # renting a NEGATIVE loo -- i.e. a lift -- out of the gap. Shrinkage
    # changes the weight on loo, so re-assert the guard at every setting.
    prior = AuthorEngagement(posts=3, total_base=0.5)
    assert pooled_author_base(1.0, prior, 1.0 / 3.0, k) <= 1.0


def test_shrinkage_is_wired_from_ScoreWeights_into_the_scorer() -> None:
    # The field existing is not the same as the field being READ. This is the
    # exact failure the half-finished edit had: the parameter was on the
    # signature and nothing passed it, so the estimator was unchanged while
    # the code looked fixed.
    from dataclasses import replace
    from datetime import timedelta

    from recsys.core.scoring import organic_quality_raw
    from tests.fakes import EPOCH, make_vote

    post = make_post(
        author="newcomer",
        votes=[make_vote(f"v{i}", 50_000_000, minutes=i) for i in range(9)],
    )
    now = EPOCH + timedelta(hours=1)
    prior = AuthorEngagement(posts=3, total_base=0.8195)  # 2 unengaged others
    excluded = frozenset({"newcomer"})
    unshrunk = organic_quality_raw(
        post, now, excluded, prior=prior,
        weights=replace(ScoreWeights(), organic_prior_shrinkage=0.0),
    )
    shrunk = organic_quality_raw(
        post, now, excluded, prior=prior,
        weights=replace(ScoreWeights(), organic_prior_shrinkage=3.0),
    )
    assert shrunk > unshrunk, "ScoreWeights.organic_prior_shrinkage must reach the estimator"


def test_negative_shrinkage_is_refused() -> None:
    from dataclasses import replace

    with pytest.raises(ValueError, match="organic_prior_shrinkage must be >= 0"):
        replace(ScoreWeights(), organic_prior_shrinkage=-1.0)
