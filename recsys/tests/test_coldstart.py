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


def test_popular_fallback_is_labelled_as_padding_not_as_interest() -> None:
    # ★ 2026-08-01: this padding used to be emitted AS ``INTEREST_TAG``. It is
    # global popularity with no relation to anything the viewer picked, so
    # labelling it as interest content made the interest lane's own coverage
    # unfalsifiable — in the measured follow-cliff case 17 of 20 feed slots were
    # popularity padding that read, in the output, as genuine interest matches.
    popular_post = make_post(author="carol", permlink="pop1")
    gateway = FakeGateway(popular=[popular_post])

    result = popular_fallback(gateway, EPOCH, limit=10)

    assert len(result) == 1
    assert result[0].post.key == popular_post.key
    assert result[0].source == CandidateSource.POPULAR_FALLBACK
    # The property that DID matter is preserved: the viewer this serves has no
    # follow graph, so the padding must stay exempt from the second-degree gate.
    assert result[0].source.requires_second_degree is False


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


def test_every_ungated_non_network_lane_has_cf_suppressed() -> None:
    """★ Derived, not hardcoded — because the hardcoded version failed silently.

    This asserted a literal PAIR. When `POPULAR_FALLBACK` was split out of
    `INTEREST_TAG` (2026-08-01) the padding lane left this set as a side effect
    of a labelling change, quietly removing H07's CF suppression from the single
    most promotable lane served to exactly the viewers H07 is about — and the
    test still passed, because the pair it named was still accurate.

    The real invariant is a DERIVATION, so a new gate-exempt source fails here
    until someone decides where it belongs instead of defaulting to
    unsuppressed.

    ★ RE-DERIVED 2026-08-04. It used to read the invariant off
    `requires_author_floor`, correct while the cold-start lanes applied no
    floor. Spec item B4 gave them one — a PROVEN self-dealer (the 0.0 band) was
    being admitted into a brand-new viewer's feed — so that property no longer
    names this set.

    The invariant itself is unchanged. CF is a CROSS-VIEWER signal, and what
    stops a poisoned one-directional co-engagement edge is the second-degree
    VOUCH COUNT ("someone you follow already engaged this"), not the author
    floor: the floor rejects proven self-dealers, and does nothing about an
    unknown-tier sock poisoning a viewer's ALS row. So the derivation now runs
    off the vouch count, with the out-of-network lanes classified explicitly.
    """
    vouch_exempt = {s for s in CandidateSource if not s.requires_second_degree}
    classified_elsewhere = {
        CandidateSource.IN_NETWORK,     # viewer chose these authors by name
        CandidateSource.OON_COMMUNITY,  # opted-in + floored; CF via oon_scale
        CandidateSource.OON_INTEREST,   # ditto
        CandidateSource.OON_ALS,        # floored; also emits nothing today
                                        # (`als_source_authors = 0`)
    }
    # EXPLORATION is vouch- AND floor-exempt, so it must be IN the suppressed
    # set, not classified away from it.
    assert vouch_exempt - classified_elsewhere == INTEREST_LANE_SOURCES
    # and the property that makes CF poisoning reachable holds for every member
    assert all(not s.requires_second_degree for s in INTEREST_LANE_SOURCES)
    assert CandidateSource.POPULAR_FALLBACK in INTEREST_LANE_SOURCES


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
