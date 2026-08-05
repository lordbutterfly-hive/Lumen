"""Tests for recsys.core.second_degree (§8.1, §8.3)."""

from __future__ import annotations

from recsys.config import GraphCredConfig, RealGraphWeights, Thresholds
from recsys.contracts import Candidate, CandidateSource, EngagementEdge, GraphCred
from recsys.core.graph_cred import compute_graph_cred
from recsys.core.second_degree import filter_eligible, passes_second_degree, qualifying_engagers
from tests.fakes import EPOCH, make_candidate, make_post, make_viewer

THRESHOLDS = Thresholds()


def test_passes_second_degree_in_network_is_exempt() -> None:
    candidate = make_candidate(source=CandidateSource.IN_NETWORK)
    assert passes_second_degree(candidate, frozenset(), min_engagers=1) is True


def test_passes_second_degree_oon_needs_min_engagers() -> None:
    candidate = make_candidate(source=CandidateSource.OON_ENGAGED)
    assert passes_second_degree(candidate, frozenset(), min_engagers=1) is False
    assert passes_second_degree(candidate, frozenset({"bob"}), min_engagers=1) is True


def test_filter_eligible_drops_muted_author() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.IN_NETWORK)
    viewer = make_viewer(mutes=frozenset({"alice"}))
    assert filter_eligible([candidate], viewer, {}, {}, THRESHOLDS) == []


def test_filter_eligible_drops_oon_with_no_in_network_engager() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"carol"})}  # carol is not followed by viewer
    assert filter_eligible([candidate], viewer, engager_index, {}, THRESHOLDS) == []


def test_filter_eligible_keeps_in_network_exempt_from_gate_and_floor() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.IN_NETWORK)
    viewer = make_viewer()
    graph_creds = {"alice": GraphCred(account="alice", score=0.0, follow_follower_ratio=1.0)}
    assert filter_eligible([candidate], viewer, {}, graph_creds, THRESHOLDS) == [candidate]


def test_filter_eligible_drops_oon_author_below_graph_cred_floor() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"bob"})}
    # bob clears the vouch floor so this isolates the *author's* graph-cred
    # floor (§8.3) from the engager vouch-quality check (§8.2).
    graph_creds = {
        "alice": GraphCred(account="alice", score=0.01, follow_follower_ratio=1.0),
        "bob": GraphCred(account="bob", score=0.5, follow_follower_ratio=1.0),
    }
    assert filter_eligible([candidate], viewer, engager_index, graph_creds, THRESHOLDS) == []


def test_filter_eligible_keeps_oon_author_with_no_graph_cred() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"bob"})}
    assert filter_eligible([candidate], viewer, engager_index, {}, THRESHOLDS) == [candidate]


def test_filter_eligible_drops_suppressed_post() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.IN_NETWORK)
    viewer = make_viewer()
    assert (
        filter_eligible(
            [candidate], viewer, {}, {}, THRESHOLDS, suppressed=frozenset({post.key})
        )
        == []
    )


def test_filter_eligible_keeps_non_suppressed_post() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.IN_NETWORK)
    viewer = make_viewer()
    assert filter_eligible(
        [candidate], viewer, {}, {}, THRESHOLDS, suppressed=frozenset({"@someone/else"})
    ) == [candidate]


def test_filter_eligible_drops_nsfw_by_default() -> None:
    post = make_post(author="alice", is_nsfw=True)
    candidate = make_candidate(post, CandidateSource.IN_NETWORK)
    viewer = make_viewer()
    assert filter_eligible([candidate], viewer, {}, {}, THRESHOLDS) == []


def test_filter_eligible_keeps_nsfw_when_show_nsfw() -> None:
    post = make_post(author="alice", is_nsfw=True)
    candidate = make_candidate(post, CandidateSource.IN_NETWORK)
    viewer = make_viewer()
    assert filter_eligible([candidate], viewer, {}, {}, THRESHOLDS, show_nsfw=True) == [candidate]


def test_qualifying_engagers_count_only_fallback_when_graph_creds_empty() -> None:
    engagers = frozenset({"bob", "carol"})
    assert qualifying_engagers(engagers, {}, THRESHOLDS.vouch_graph_cred_floor) == engagers


def test_qualifying_engagers_drops_below_vouch_floor_when_graph_creds_present() -> None:
    engagers = frozenset({"bob", "carol"})
    graph_creds = {
        "bob": GraphCred(account="bob", score=0.5, follow_follower_ratio=1.0),
        "carol": GraphCred(account="carol", score=0.01, follow_follower_ratio=1.0),
    }
    floor = THRESHOLDS.vouch_graph_cred_floor
    assert qualifying_engagers(engagers, graph_creds, floor) == frozenset({"bob"})


def test_qualifying_engagers_drops_engager_missing_from_graph_creds() -> None:
    engagers = frozenset({"bob"})
    graph_creds = {"carol": GraphCred(account="carol", score=0.5, follow_follower_ratio=1.0)}
    floor = THRESHOLDS.vouch_graph_cred_floor
    assert qualifying_engagers(engagers, graph_creds, floor) == frozenset()


def test_filter_eligible_below_vouch_floor_engager_does_not_vouch() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"bob"})}
    # alice clears the author floor; bob does not clear the vouch floor —
    # isolates the engager vouch-quality check (§8.2) from §8.3.
    graph_creds = {
        "alice": GraphCred(account="alice", score=0.5, follow_follower_ratio=1.0),
        "bob": GraphCred(account="bob", score=0.01, follow_follower_ratio=1.0),
    }
    assert filter_eligible([candidate], viewer, engager_index, graph_creds, THRESHOLDS) == []


def test_filter_eligible_qualifying_engager_vouches() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"bob"})}
    graph_creds = {
        "alice": GraphCred(account="alice", score=0.5, follow_follower_ratio=1.0),
        "bob": GraphCred(account="bob", score=0.5, follow_follower_ratio=1.0),
    }
    result = filter_eligible([candidate], viewer, engager_index, graph_creds, THRESHOLDS)
    assert result == [candidate]


def test_filter_eligible_counts_only_qualifying_engagers_toward_min_engagers() -> None:
    post = make_post(author="alice")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    thresholds = Thresholds(second_degree_min_engagers=2)
    viewer = make_viewer(follows=frozenset({"bob", "carol"}))
    engager_index = {post.key: frozenset({"bob", "carol"})}
    graph_creds = {
        "alice": GraphCred(account="alice", score=0.5, follow_follower_ratio=1.0),
        "bob": GraphCred(account="bob", score=0.5, follow_follower_ratio=1.0),
        "carol": GraphCred(account="carol", score=0.01, follow_follower_ratio=1.0),
    }
    # Only bob qualifies (carol is below the vouch floor) — one qualifying
    # engager can't clear a min_engagers=2 gate.
    assert filter_eligible([candidate], viewer, engager_index, graph_creds, thresholds) == []

    # dave also qualifies, bringing the qualifying count to 2.
    engager_index_two = {post.key: frozenset({"bob", "carol", "dave"})}
    viewer_two = make_viewer(follows=frozenset({"bob", "carol", "dave"}))
    graph_creds_two = {
        **graph_creds,
        "dave": GraphCred(account="dave", score=0.5, follow_follower_ratio=1.0),
    }
    assert filter_eligible(
        [candidate], viewer_two, engager_index_two, graph_creds_two, thresholds
    ) == [candidate]


# --- the gates on REAL graph-cred values, now that the floor is live (§8.2/§8.3) ---


def _real_creds() -> dict[str, GraphCred]:
    """Graph-cred straight out of :func:`compute_graph_cred` rather than
    hand-written scores, so these tests fail if the score distribution ever
    drifts back to a range no floor can bite on.

    "lurker" engages others but has never been engaged (unknown); "sock1" and
    "sock2" are a detected ring whose only engagement is with each other
    (caught self-dealing). Both used to score 0.0 — telling them apart is the
    whole point of the band split (§8.3)."""
    edges = [
        EngagementEdge(src="alice", dst="bob", upvotes=5, replies=3),
        EngagementEdge(src="bob", dst="alice", upvotes=5, replies=3),
        EngagementEdge(src="lurker", dst="alice", upvotes=4),
        EngagementEdge(src="bob", dst="stranger", upvotes=1),
        EngagementEdge(src="sock1", dst="sock2", upvotes=5, replies=3),
        EngagementEdge(src="sock2", dst="sock1", upvotes=5, replies=3),
    ]
    follows = {
        "alice": frozenset({"bob"}),
        "bob": frozenset({"alice"}),
        "lurker": frozenset({"alice", "bob"}),
        "sock1": frozenset({"sock2"}),
        "sock2": frozenset({"sock1"}),
    }
    return compute_graph_cred(
        edges,
        follows,
        RealGraphWeights(),
        config=GraphCredConfig(),
        ring_members=frozenset({"sock1", "sock2"}),
        now=EPOCH,
    )


def test_real_graph_cred_splits_across_the_floor() -> None:
    # The premise of the gates below: a caught self-dealer falls under the
    # floor, and everyone else — engaged OR merely unknown — clears it. Before
    # the band split NO account produced by compute_graph_cred could land under
    # the 0.05 floor; the revision after that put every never-engaged account
    # under it, which is why "lurker" is asserted on the passing side here.
    creds = _real_creds()
    assert creds["sock1"].score < THRESHOLDS.vouch_graph_cred_floor
    assert creds["lurker"].score >= THRESHOLDS.vouch_graph_cred_floor
    assert creds["alice"].score >= THRESHOLDS.vouch_graph_cred_floor
    assert creds["stranger"].score >= THRESHOLDS.graph_cred_floor


def test_vouch_gate_rejects_a_real_self_dealing_engager() -> None:
    creds = _real_creds()
    post = make_post(author="stranger")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"sock1"}))
    engager_index = {post.key: frozenset({"sock1"})}
    # The author clears the author floor; the only in-network engager is an
    # account whose entire footprint is its own ring, so it cannot vouch.
    assert filter_eligible([candidate], viewer, engager_index, creds, THRESHOLDS) == []
    # Same post, vouched by an account with real standing -> eligible.
    viewer_ok = make_viewer(follows=frozenset({"bob"}))
    assert filter_eligible(
        [candidate], viewer_ok, {post.key: frozenset({"bob"})}, creds, THRESHOLDS
    ) == [candidate]


def test_vouch_gate_accepts_a_pure_consumer() -> None:
    # A reader who has never RECEIVED engagement is unknown, not disqualified:
    # on Hive most accounts are pure consumers, and dropping them as vouchers
    # cost 19.4% of the measured population while dropping zero candidates.
    creds = _real_creds()
    post = make_post(author="stranger")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"lurker"}))
    engager_index = {post.key: frozenset({"lurker"})}
    assert filter_eligible([candidate], viewer, engager_index, creds, THRESHOLDS) == [candidate]


def test_author_floor_rejects_a_real_self_dealing_author() -> None:
    creds = _real_creds()
    post = make_post(author="sock1")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"bob"})}
    # bob is a qualifying voucher, so this isolates the author floor: an author
    # whose only engagement is its own ring stays out of OON distribution.
    assert filter_eligible([candidate], viewer, engager_index, creds, THRESHOLDS) == []


def test_author_floor_keeps_a_freshly_onboarded_mutual_pair() -> None:
    # THE RELOCATED-BLACKOUT FIX: two brand-new accounts whose only history is
    # mutually engaging each other ONCE (a starter-pack on-ramp) used to be
    # ring-flagged by insularity alone and land at 0.0 -- indistinguishable
    # from the proven sock1/sock2 ring in _real_creds(). Both must now clear
    # the author floor.
    edges = [
        EngagementEdge(src="alice", dst="bob", upvotes=5, replies=3),
        EngagementEdge(src="bob", dst="alice", upvotes=5, replies=3),
        EngagementEdge(src="lurker", dst="alice", upvotes=4),
        EngagementEdge(src="sock1", dst="sock2", upvotes=5, replies=3),
        EngagementEdge(src="sock2", dst="sock1", upvotes=5, replies=3),
        EngagementEdge(src="newa", dst="newb", upvotes=1),
        EngagementEdge(src="newb", dst="newa", upvotes=1),
    ]
    follows = {
        "alice": frozenset({"bob"}),
        "bob": frozenset({"alice"}),
        "lurker": frozenset({"alice", "bob"}),
        "sock1": frozenset({"sock2"}),
        "sock2": frozenset({"sock1"}),
        "newa": frozenset({"newb"}),
        "newb": frozenset({"newa"}),
    }
    creds = compute_graph_cred(
        edges,
        follows,
        RealGraphWeights(),
        config=GraphCredConfig(),
        ring_members=frozenset({"sock1", "sock2", "newa", "newb"}),
        now=EPOCH,
    )
    # the proven ring is still caught...
    assert creds["sock1"].score < THRESHOLDS.graph_cred_floor
    # ...but the onboarding pair is not.
    assert creds["newa"].score >= THRESHOLDS.graph_cred_floor
    assert creds["newb"].score >= THRESHOLDS.graph_cred_floor

    post = make_post(author="newa")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"bob"})}
    assert filter_eligible([candidate], viewer, engager_index, creds, THRESHOLDS) == [candidate]

    # and newa can now vouch for a stranger too (the §8.2 vouch floor).
    stranger_post = make_post(author="stranger")
    stranger_candidate = make_candidate(stranger_post, CandidateSource.OON_ENGAGED)
    viewer_via_newa = make_viewer(follows=frozenset({"newa"}))
    assert filter_eligible(
        [stranger_candidate],
        viewer_via_newa,
        {stranger_post.key: frozenset({"newa"})},
        creds,
        THRESHOLDS,
    ) == [stranger_candidate]


def test_author_floor_keeps_the_active_newcomer() -> None:
    # THE REGRESSION THIS BAND EXISTS FOR: an author who has engaged others but
    # has not been engaged back is in the snapshot, and must not be filtered
    # out for it. Under the previous revision this returned [] — participating
    # before posting was strictly worse than posting first, because a newcomer
    # absent from the snapshot fails open here while one present at 0.0 does not.
    creds = _real_creds()
    post = make_post(author="lurker")
    candidate = make_candidate(post, CandidateSource.OON_ENGAGED)
    viewer = make_viewer(follows=frozenset({"bob"}))
    engager_index = {post.key: frozenset({"bob"})}
    assert filter_eligible([candidate], viewer, engager_index, creds, THRESHOLDS) == [candidate]


def test_engaging_with_a_post_cannot_delete_it_from_an_interest_feed() -> None:
    """★ Regression for a suppression vector CHEAPER than the known one.

    `merge_candidates` labels a post by its highest-priority source and
    OON_ENGAGED outranks OON_INTEREST, so a post matching a viewer's declared
    interest tag arrives UNGATED and is served — until somebody the viewer
    follows engages it. Then it is re-labelled OON_ENGAGED, becomes gated, fails
    the vouch on the ENGAGER's credibility, and used to be dropped outright:
    engagement itself removed the post.

    One condemned account any viewer follows + one upvote, against ANY author,
    with no ring shape and no zero-audience precondition. The author is never
    flagged — the suppression machinery is the weapon.

    ★ Originally measured through the now-retired OON_COMMUNITY lane (a
    subscribed community); communities were removed as a lane 2026-08-04
    (R1/R3) and the mechanism this pins is identical for its OON_INTEREST
    successor.
    """
    post = make_post("honest_author", "p1", tags=("photo",))
    viewer = make_viewer(
        "reader",
        follows=frozenset({"condemned"}),
        interest_tags=frozenset({"photo"}),
    )
    thresholds = Thresholds()
    creds = {
        "condemned": GraphCred(account="condemned", score=0.0, follow_follower_ratio=1.0),
        "honest_author": GraphCred(
            account="honest_author", score=0.5, follow_follower_ratio=1.0
        ),
    }

    # Nobody engaged it: arrives via the declared interest tag, ungated, served.
    quiet = filter_eligible(
        [Candidate(post=post, source=CandidateSource.OON_INTEREST)],
        viewer, {}, creds, thresholds,
    )
    assert len(quiet) == 1

    # The condemned account upvotes it -> relabelled OON_ENGAGED by the merge.
    # It must still be served, demoted back to the lane it already qualified for.
    attacked = filter_eligible(
        [Candidate(post=post, source=CandidateSource.OON_ENGAGED)],
        viewer,
        {post.key: frozenset({"condemned"})},
        creds,
        thresholds,
    )
    assert len(attacked) == 1, "engagement deleted the post from an interest feed"
    assert attacked[0].source is CandidateSource.OON_INTEREST

    # But the demotion admits nothing new: a viewer who never opted in still
    # does not get it, and a self-dealing AUTHOR is still refused.
    stranger = make_viewer("stranger", follows=frozenset({"condemned"}))
    assert filter_eligible(
        [Candidate(post=post, source=CandidateSource.OON_ENGAGED)],
        stranger, {post.key: frozenset({"condemned"})}, creds, thresholds,
    ) == []
    dealer_post = make_post("dealer", "d1", tags=("photo",))
    dealer_creds = dict(creds)
    dealer_creds["dealer"] = GraphCred(account="dealer", score=0.0, follow_follower_ratio=1.0)
    assert filter_eligible(
        [Candidate(post=dealer_post, source=CandidateSource.OON_ENGAGED)],
        viewer, {dealer_post.key: frozenset({"condemned"})}, dealer_creds, thresholds,
    ) == []


def test_cold_start_lanes_refuse_a_proven_self_dealer_but_not_a_newcomer() -> None:
    """★ Spec item B4. The cold-start lanes were exempt from the author floor as
    well as the vouch count, which inverted the protection: an author in the 0.0
    band — PROVEN self-dealing — was admitted into a brand-new viewer's feed via
    INTEREST_COMMUNITY and INTEREST_TAG, while the same author was refused on
    OON_COMMUNITY and OON_INTEREST. The audience with no follow graph to defend
    them got the least protection of anyone.

    The distinction that makes this safe: 0.0 means caught self-dealing, whereas
    an unknown or never-engaged account scores `min_vouched_score` (0.10) and an
    author absent from the snapshot is treated permissively. Both must still
    pass, or this would close the newcomer on-ramp it is meant to protect.

    ★ INTEREST_COMMUNITY (and OON_COMMUNITY) were retired 2026-08-04 (communities
    removed as a lane, R1/R3) — only INTEREST_TAG remains, but the property this
    pins is unchanged.
    """
    thresholds = Thresholds()
    cold = make_viewer(
        "newbie",
        interest_tags=frozenset({"photo"}),
        is_new=True,
    )
    cold_lanes = (CandidateSource.INTEREST_TAG,)

    dealer = make_post("dealer", "d1", tags=("photo",))
    creds = {"dealer": GraphCred(account="dealer", score=0.0, follow_follower_ratio=1.0)}
    for lane in cold_lanes:
        assert filter_eligible(
            [Candidate(post=dealer, source=lane)], cold, {}, creds, thresholds
        ) == [], f"{lane.name} admitted a proven self-dealer"

    # an UNKNOWN-tier account (0.10) must still reach a cold viewer
    unknown = make_post("unknown", "u1", tags=("photo",))
    creds_unknown = {
        "unknown": GraphCred(account="unknown", score=0.10, follow_follower_ratio=1.0)
    }
    for lane in cold_lanes:
        assert len(filter_eligible(
            [Candidate(post=unknown, source=lane)], cold, {}, creds_unknown, thresholds
        )) == 1, f"{lane.name} blocked an unknown-tier account"

    # and an author absent from the snapshot entirely (a true newcomer) passes
    newcomer = make_post("newcomer", "n1", tags=("photo",))
    for lane in cold_lanes:
        assert len(filter_eligible(
            [Candidate(post=newcomer, source=lane)], cold, {}, creds, thresholds
        )) == 1, f"{lane.name} blocked a brand-new author"
