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
