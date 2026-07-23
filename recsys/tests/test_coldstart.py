"""Tests for interest-based cold-start seeding (§13.1, rev 2.2)."""

from __future__ import annotations

from recsys.config import ColdStartConfig
from recsys.contracts import CandidateSource
from recsys.core.coldstart import (
    INTEREST_LANE_SOURCES,
    interest_candidates,
    is_cold,
    is_established_followless,
    popular_fallback,
)
from tests.fakes import EPOCH, FakeGateway, make_post, make_viewer


def test_is_cold_true_for_new_account() -> None:
    viewer = make_viewer(is_new=True, follows=frozenset({"alice"}))
    assert is_cold(viewer) is True


def test_is_cold_true_for_no_follows() -> None:
    viewer = make_viewer(is_new=False, follows=frozenset())
    assert is_cold(viewer) is True


def test_is_cold_false_for_established_account() -> None:
    viewer = make_viewer(is_new=False, follows=frozenset({"alice"}))
    assert is_cold(viewer) is False


def test_interest_candidates_pulls_from_gateway() -> None:
    viewer = make_viewer(
        interest_communities=frozenset({"hive-167922"}), interest_tags=frozenset({"art"})
    )
    community_post = make_post(author="alice", permlink="c1")
    tag_post = make_post(author="bob", permlink="t1")
    gateway = FakeGateway(community=[community_post], tag=[tag_post])
    cfg = ColdStartConfig()

    result = interest_candidates(viewer, gateway, EPOCH, limit=10, cfg=cfg)

    by_key = {c.post.key: c for c in result}
    assert by_key[community_post.key].source == CandidateSource.INTEREST_COMMUNITY
    assert by_key[tag_post.key].source == CandidateSource.INTEREST_TAG
    assert len(result) == 2


def test_interest_candidates_dedups_keeping_community_source() -> None:
    viewer = make_viewer(
        interest_communities=frozenset({"hive-167922"}), interest_tags=frozenset({"art"})
    )
    shared_post = make_post(author="alice", permlink="shared")
    gateway = FakeGateway(community=[shared_post], tag=[shared_post])
    cfg = ColdStartConfig()

    result = interest_candidates(viewer, gateway, EPOCH, limit=10, cfg=cfg)

    assert len(result) == 1
    assert result[0].post.key == shared_post.key
    assert result[0].source == CandidateSource.INTEREST_COMMUNITY


def test_interest_candidates_empty_gateway_is_empty() -> None:
    viewer = make_viewer()
    gateway = FakeGateway()
    cfg = ColdStartConfig()
    assert interest_candidates(viewer, gateway, EPOCH, limit=10, cfg=cfg) == []


def test_popular_fallback_pulls_from_gateway_and_tags_interest_tag() -> None:
    popular_post = make_post(author="carol", permlink="pop1")
    gateway = FakeGateway(popular=[popular_post])

    result = popular_fallback(gateway, EPOCH, limit=10)

    assert len(result) == 1
    assert result[0].post.key == popular_post.key
    assert result[0].source == CandidateSource.INTEREST_TAG


def test_popular_fallback_empty_gateway_is_empty() -> None:
    gateway = FakeGateway()
    assert popular_fallback(gateway, EPOCH, limit=10) == []


def test_popular_fallback_respects_limit() -> None:
    posts = [make_post(author="carol", permlink=f"pop{i}") for i in range(5)]
    gateway = FakeGateway(popular=posts)

    result = popular_fallback(gateway, EPOCH, limit=2)

    assert len(result) == 2


# ---------------------------------------------------------------------------
# H07/C1 (2026-07-22): the interest lane is gate-exempt by design for a TRUE
# cold start, but is_cold() also routes an established-but-followless viewer
# there — and that lane applies no graph-cred floor at all. is_established_
# followless distinguishes the two so the caller can suppress the CF blend
# ONLY for the established state, never for a genuine newcomer.
# ---------------------------------------------------------------------------


def test_interest_lane_sources_are_exactly_the_gate_exempt_pair() -> None:
    expected = frozenset({CandidateSource.INTEREST_COMMUNITY, CandidateSource.INTEREST_TAG})
    assert expected == INTEREST_LANE_SOURCES


def test_established_followless_true_for_followless_viewer_with_als_row() -> None:
    # The gap state: unfollowed everyone (or never followed anyone) but has
    # enough engagement history to be in the trained CF model.
    viewer = make_viewer(follows=frozenset(), is_new=False)
    assert is_established_followless(viewer, has_trained_als_row=True) is True


def test_established_followless_false_for_true_cold_newcomer() -> None:
    # No ALS row at all -> never gate, regardless of the followless/is_new
    # combination. This is the genuine cold-start state the lane exists for.
    viewer = make_viewer(follows=frozenset(), is_new=True)
    assert is_established_followless(viewer, has_trained_als_row=False) is False

    veteran_but_untrained = make_viewer(follows=frozenset(), is_new=False)
    assert is_established_followless(veteran_but_untrained, has_trained_als_row=False) is False


def test_established_followless_false_when_viewer_has_follows() -> None:
    # Having an ALS row is not enough on its own -- a viewer with a follow
    # graph is not routed to the interest lane for the followless reason (they
    # may still land there via is_new, but that is not this gap: their other
    # candidate sources ARE gated normally, so this function only needs to
    # cover the followless shape of is_cold()).
    viewer = make_viewer(follows=frozenset({"alice"}), is_new=False)
    assert is_established_followless(viewer, has_trained_als_row=True) is False
