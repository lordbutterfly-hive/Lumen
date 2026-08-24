"""Tests for graph-cred: engagement-weighted follow-graph PageRank (§8.3)."""

from __future__ import annotations

import pathlib
from datetime import datetime, timedelta

import pytest

from recsys.config import GraphCredConfig, RealGraphWeights
from recsys.contracts import EngagementEdge
from recsys.core.graph_cred import compute_graph_cred, edge_weight
from tests.fakes import EPOCH

WEIGHTS = RealGraphWeights()
CONFIG = GraphCredConfig()


def _edge(
    src: str,
    dst: str,
    *,
    upvotes: int = 0,
    replies: int = 0,
    last: datetime | None = None,
) -> EngagementEdge:
    return EngagementEdge(
        src=src, dst=dst, upvotes=upvotes, replies=replies, last_interaction=last
    )


def test_empty_input_returns_empty() -> None:
    assert compute_graph_cred([], {}, WEIGHTS, config=CONFIG) == {}


def test_follow_graph_with_no_engagement_buys_no_rank() -> None:
    # A raw, unengaged follow must carry no distribution trust: it cannot lift
    # either party out of the unknown band into the engaged band, and it cannot
    # separate the follower from the followee. (This asserted == 0.0 while the
    # bottom band meant "no standing"; the bottom band now means "caught
    # self-dealing" and neither account here has been caught at anything, so
    # the correct score is the unknown band. Nothing about what a free follow
    # buys has changed: still nothing.)
    follows = {"alice": frozenset({"bob"})}
    cred = compute_graph_cred([], follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert cred["bob"].score == CONFIG.min_vouched_score
    assert cred["alice"].score == CONFIG.min_vouched_score


def test_engaged_mutual_follow_pair_outranks_passive_follower() -> None:
    # alice & bob follow AND actively engage each other; carol follows both but
    # engages nobody (and nobody engages carol) -> carol is a passive sink.
    edges = [
        _edge("alice", "bob", replies=3),
        _edge("bob", "alice", replies=3),
    ]
    follows = {
        "alice": frozenset({"bob"}),
        "bob": frozenset({"alice"}),
        "carol": frozenset({"alice", "bob"}),
    }
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert cred["alice"].score > cred["carol"].score
    assert cred["bob"].score > cred["carol"].score


def test_scores_are_in_unit_range() -> None:
    edges = [_edge("a", "b", replies=4), _edge("b", "c", replies=4), _edge("c", "a", replies=4)]
    follows = {"a": frozenset({"b"}), "b": frozenset({"c"}), "c": frozenset({"a"})}
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert all(0.0 <= c.score <= 1.0 for c in cred.values())


def test_deterministic_across_runs() -> None:
    edges = [_edge("a", "b", replies=2), _edge("b", "a", replies=2)]
    follows = {"a": frozenset({"b"}), "b": frozenset({"a"})}
    first = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    second = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert {k: v.score for k, v in first.items()} == {k: v.score for k, v in second.items()}


def test_follow_follower_ratio() -> None:
    # bob is followed by both, follows nobody -> ratio 0; alice follows bob only.
    follows = {"alice": frozenset({"bob"}), "carol": frozenset({"bob"})}
    cred = compute_graph_cred([], follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert cred["bob"].follow_follower_ratio == 0.0
    assert cred["alice"].follow_follower_ratio == 1.0  # follows 1, followed by 0 -> 1/max(0,1)


def test_seeded_teleport_lifts_seed_connected_node_above_isolated_clique() -> None:
    # "seed" <-> "d" mutually follow + engage, and are a trusted seed; "x" <-> "y"
    # are an equally-structured mutual pair with NO path to any seed. Without
    # seeding both pairs would tie by symmetry; seeding must break that tie in
    # favor of the seed-connected node.
    edges = [
        _edge("seed", "d", replies=1),
        _edge("d", "seed", replies=1),
        _edge("x", "y", replies=1),
        _edge("y", "x", replies=1),
    ]
    follows = {
        "seed": frozenset({"d"}),
        "d": frozenset({"seed"}),
        "x": frozenset({"y"}),
        "y": frozenset({"x"}),
    }
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, trusted_seeds=frozenset({"seed"}), now=EPOCH
    )
    assert cred["d"].score > cred["x"].score
    assert cred["d"].score > cred["y"].score


def test_empty_trusted_seeds_is_fully_uniform() -> None:
    # With no trusted seeds, the two symmetric mutual pairs from the seeding
    # test above must tie exactly -- confirms the documented uniform fallback.
    edges = [
        _edge("seed", "d", replies=1),
        _edge("d", "seed", replies=1),
        _edge("x", "y", replies=1),
        _edge("y", "x", replies=1),
    ]
    follows = {
        "seed": frozenset({"d"}),
        "d": frozenset({"seed"}),
        "x": frozenset({"y"}),
        "y": frozenset({"x"}),
    }
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert cred["d"].score == cred["x"].score == cred["y"].score == cred["seed"].score


def test_lineage_edge_contributes_nothing() -> None:
    # a<->b engage heavily but are stake-lineage siblings both ways; p<->q
    # engage identically but are unrelated. The lineage pair must end up with
    # strictly less graph-cred than the real, unexcluded pair.
    edges = [
        _edge("a", "b", replies=3),
        _edge("b", "a", replies=3),
        _edge("p", "q", replies=3),
        _edge("q", "p", replies=3),
    ]
    follows = {
        "a": frozenset({"b"}),
        "b": frozenset({"a"}),
        "p": frozenset({"q"}),
        "q": frozenset({"p"}),
    }
    lineage = {"a": frozenset({"b"}), "b": frozenset({"a"})}
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, lineage=lineage, now=EPOCH
    )
    assert cred["p"].score > cred["a"].score
    assert cred["q"].score > cred["b"].score


def test_intra_ring_edge_contributes_nothing() -> None:
    # Same shape as the lineage test, but the exclusion comes from both
    # endpoints being ring members instead of a lineage relationship.
    edges = [
        _edge("a", "b", replies=3),
        _edge("b", "a", replies=3),
        _edge("p", "q", replies=3),
        _edge("q", "p", replies=3),
    ]
    follows = {
        "a": frozenset({"b"}),
        "b": frozenset({"a"}),
        "p": frozenset({"q"}),
        "q": frozenset({"p"}),
    }
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"a", "b"}), now=EPOCH
    )
    assert cred["p"].score > cred["a"].score
    assert cred["q"].score > cred["b"].score


def test_high_follow_follower_ratio_lowers_score() -> None:
    # "hi" and "lo" sit in structurally identical mutual-engagement pairs; "hi"
    # additionally follows three accounts it never engages, inflating its
    # following count (and thus its ratio) without touching the engagement
    # graph. Only the ratio prior can explain a lower score for "hi".
    edges = [
        _edge("hi", "partner_hi", replies=3),
        _edge("partner_hi", "hi", replies=3),
        _edge("lo", "partner_lo", replies=3),
        _edge("partner_lo", "lo", replies=3),
    ]
    follows = {
        "hi": frozenset({"partner_hi", "junk1", "junk2", "junk3"}),
        "partner_hi": frozenset({"hi"}),
        "lo": frozenset({"partner_lo"}),
        "partner_lo": frozenset({"lo"}),
    }
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert cred["hi"].follow_follower_ratio > cred["lo"].follow_follower_ratio
    assert cred["hi"].score < cred["lo"].score


def test_edge_weight_decays_with_age() -> None:
    now = EPOCH + timedelta(days=60)
    fresh = _edge("a", "b", replies=10, last=EPOCH + timedelta(days=59))
    old = _edge("a", "b", replies=10, last=EPOCH)
    assert edge_weight(fresh, WEIGHTS, now) > edge_weight(old, WEIGHTS, now)


def test_edge_weight_no_timestamp_no_decay() -> None:
    edge = _edge("a", "b", replies=10)
    assert edge_weight(edge, WEIGHTS, EPOCH) == WEIGHTS.reply * 10


# --- the graph-cred bands (§8.3): evidence of self-dealing, absence of evidence,
# and engaged — an absolute bottom band, not a percentile quota ---


def test_never_engaged_account_is_unknown_not_zero() -> None:
    # THE ACTIVE-NEWCOMER RULE. "lurker" engages the pair but nobody has engaged
    # IT yet — a newcomer who upvotes and comments before posting, and equally
    # every ordinary reader. That is the ABSENCE of evidence and must score the
    # unknown band, strictly below every engaged account and above any floor.
    # (This asserted == 0.0, which put the account that participates first below
    # Thresholds.graph_cred_floor: measured on the harness, such a newcomer
    # reached 0/10 established viewers where a passive newcomer reached 9/10,
    # and 35 of 180 accounts were silently disqualified from ever vouching.
    # 0.0 is now reserved for caught self-dealing — see the ring test below.)
    edges = [
        _edge("alice", "bob", replies=3),
        _edge("bob", "alice", replies=3),
        _edge("lurker", "alice", replies=4),
    ]
    follows = {
        "alice": frozenset({"bob"}),
        "bob": frozenset({"alice"}),
        "lurker": frozenset({"alice", "bob"}),
    }
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert cred["lurker"].score == CONFIG.min_vouched_score
    assert cred["alice"].score > CONFIG.min_vouched_score
    assert cred["bob"].score > CONFIG.min_vouched_score


def test_unknown_band_sits_between_self_dealing_and_engaged() -> None:
    # The three bands must be strictly ordered, or the floor cannot separate
    # "caught farming itself" from "we know nothing yet".
    edges = [
        _edge("s1", "s2", replies=3),
        _edge("s2", "s1", replies=3),
        _edge("alice", "bob", replies=3),
        _edge("bob", "alice", replies=3),
        _edge("newbie", "alice", replies=1),
    ]
    follows = {
        "s1": frozenset({"s2"}),
        "s2": frozenset({"s1"}),
        "alice": frozenset({"bob"}),
        "bob": frozenset({"alice"}),
        "newbie": frozenset({"alice"}),
    }
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"s1", "s2"}), now=EPOCH
    )
    assert cred["s1"].score == 0.0 < cred["newbie"].score < cred["alice"].score


def test_engaged_accounts_never_land_in_the_unvouched_band() -> None:
    # Everything that has been engaged at all must clear min_vouched_score, so
    # any floor at or below it is a pure "has standing" test.
    edges = [_edge("a", "b", replies=4), _edge("b", "c", replies=1), _edge("c", "a", replies=9)]
    follows = {"a": frozenset({"b"}), "b": frozenset({"c"}), "c": frozenset({"a"})}
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert all(CONFIG.min_vouched_score <= c.score <= 1.0 for c in cred.values())


def test_floor_is_absolute_not_a_bottom_percentile_quota() -> None:
    # Six accounts in an engagement cycle: every one of them has been engaged by
    # somebody, so NO account may fall below the floor. A percentile-normalized
    # score cannot express this — it always puts someone in the bottom band,
    # which is why the old score could not distinguish "worst here" from "no
    # standing anywhere".
    names = [f"n{i}" for i in range(6)]
    edges = [_edge(names[i], names[(i + 1) % 6], replies=3) for i in range(6)]
    follows = {names[i]: frozenset({names[(i + 1) % 6]}) for i in range(6)}
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert min(c.score for c in cred.values()) >= CONFIG.min_vouched_score


def test_unengaged_accounts_do_not_inflate_the_engaged_band() -> None:
    # The percentile sample is the engaged population only, so bolting 20
    # never-engaged accounts onto the graph must leave every engaged score
    # bit-identical. Under the old whole-population percentile this bottom mass
    # was exactly what pushed everybody above the floor.
    edges = [
        _edge("a", "b", replies=5),
        _edge("b", "a", replies=5),
        _edge("b", "c", replies=2),
        _edge("c", "b", replies=1),
    ]
    follows = {"a": frozenset({"b"}), "b": frozenset({"a", "c"}), "c": frozenset({"b"})}
    before = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    padded = dict(follows) | {f"ghost{i}": frozenset({"a"}) for i in range(20)}
    after = compute_graph_cred(edges, padded, WEIGHTS, config=CONFIG, now=EPOCH)
    # Ghosts land in the unknown band (was 0.0 — see
    # test_never_engaged_account_is_unknown_not_zero); what matters here is
    # unchanged, that they are kept out of the engaged percentile sample.
    assert all(after[f"ghost{i}"].score == CONFIG.min_vouched_score for i in range(20))
    assert {k: v.score for k, v in before.items()} == {
        k: after[k].score for k in before
    }


def test_intra_ring_pair_is_zeroed_not_merely_discounted() -> None:
    # A closed ring whose only engagement is intra-ring receives nothing once
    # the self-dealing discount zeroes those edges -> hard 0.0, below any floor.
    # Previously the percentile floated such a ring back up to mid-distribution
    # (measured 0.57-0.60 for a 20-account Sybil ring) where it cleared the
    # floor and could still vouch for strangers.
    edges = [
        _edge("s1", "s2", replies=3),
        _edge("s2", "s1", replies=3),
        _edge("p", "q", replies=3),
        _edge("q", "p", replies=3),
    ]
    follows = {
        "s1": frozenset({"s2"}),
        "s2": frozenset({"s1"}),
        "p": frozenset({"q"}),
        "q": frozenset({"p"}),
    }
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"s1", "s2"}), now=EPOCH
    )
    assert cred["s1"].score == 0.0
    assert cred["s2"].score == 0.0
    assert cred["p"].score >= CONFIG.min_vouched_score


def test_engagement_from_a_non_follower_still_clears_the_floor() -> None:
    # THE NEW-AUTHOR ON-RAMP. "newbie" is followed by nobody and follows nobody;
    # a well-connected peer upvotes them without following them. Standing is
    # counted from the engagement edges, not from the follow-restricted PageRank
    # topology, so that single upvote lifts the newbie out of the 0.0 band --
    # otherwise the now-live author floor would wall off every author whose
    # audience does not follow them back.
    edges = [
        _edge("peer", "friend", replies=3),
        _edge("friend", "peer", replies=3),
        _edge("peer", "newbie", replies=1),
    ]
    follows = {"peer": frozenset({"friend"}), "friend": frozenset({"peer"})}
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, now=EPOCH)
    assert cred["newbie"].score >= CONFIG.min_vouched_score


def test_min_vouched_score_must_be_a_positive_fraction() -> None:
    # 0.0 would collapse the standing gap the floor lives in.
    for bad in (0.0, -0.1, 1.5):
        try:
            GraphCredConfig(min_vouched_score=bad)
        except ValueError:
            continue
        raise AssertionError(f"min_vouched_score={bad} should have been rejected")


# --- the relocated-newcomer-blackout fix: ring-based self-dealing needs SCALE
# or a REPEATED pattern, not a single reciprocal interaction (§8.3) ---


def test_two_new_accounts_mutual_once_is_not_self_dealing() -> None:
    # THE BUG THIS REVISION FIXES. Two brand-new accounts whose entire history
    # is one mutual upvote (the ordinary onboarding / starter-pack shape) are
    # insular by construction -- ring.py scores them ring_score == 1.0 -- but
    # a single reciprocal interaction is not evidence of self-dealing at n=1.
    # Before this fix both landed in the 0.0 band (reproduced: bit-identical
    # to the caught-ring case below).
    edges = [
        _edge("newa", "newb", replies=1),
        _edge("newb", "newa", replies=1),
    ]
    follows = {"newa": frozenset({"newb"}), "newb": frozenset({"newa"})}
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"newa", "newb"}), now=EPOCH
    )
    assert cred["newa"].score > 0.0
    assert cred["newb"].score > 0.0
    assert cred["newa"].score >= CONFIG.min_vouched_score
    assert cred["newb"].score >= CONFIG.min_vouched_score


def test_heavy_two_account_ring_is_still_self_dealing() -> None:
    # A REPEATED pattern within just a pair is still proof, even with only one
    # partner: this is test_intra_ring_pair_is_zeroed_not_merely_discounted's
    # exact shape, re-asserted here to pin the boundary against the new SCALE
    # gate -- volume alone (no second partner needed) must still catch it.
    edges = [
        _edge("s1", "s2", replies=3),
        _edge("s2", "s1", replies=3),
    ]
    follows = {"s1": frozenset({"s2"}), "s2": frozenset({"s1"})}
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"s1", "s2"}), now=EPOCH
    )
    assert cred["s1"].score == 0.0
    assert cred["s2"].score == 0.0


def test_repeated_reciprocal_exchange_with_one_partner_is_self_dealing() -> None:
    # Strictly more than a single reciprocal interaction with the SAME lone
    # partner -- no second partner, no big per-type weight, just repetition --
    # must still cross into self-dealing once it clears
    # min_ring_self_dealing_events in both directions.
    edges = [
        _edge("r1", "r2", replies=CONFIG.min_ring_self_dealing_events),
        _edge("r2", "r1", replies=CONFIG.min_ring_self_dealing_events),
    ]
    follows = {"r1": frozenset({"r2"}), "r2": frozenset({"r1"})}
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"r1", "r2"}), now=EPOCH
    )
    assert cred["r1"].score == 0.0
    assert cred["r2"].score == 0.0


def test_low_volume_multi_partner_ring_is_still_self_dealing() -> None:
    # SCALE via BREADTH: a 3-way ring where every pairwise edge is a single,
    # minimal reciprocal exchange (the exact per-pair shape the newcomer test
    # above protects) must still be caught once an account has more than one
    # distinct ring-flagged partner -- closes the "split a real ring into many
    # single-upvote pairs" evasion of the new SCALE gate.
    edges = [
        _edge("a", "b", replies=1),
        _edge("b", "a", replies=1),
        _edge("b", "c", replies=1),
        _edge("c", "b", replies=1),
        _edge("a", "c", replies=1),
        _edge("c", "a", replies=1),
    ]
    follows = {
        "a": frozenset({"b", "c"}),
        "b": frozenset({"a", "c"}),
        "c": frozenset({"a", "b"}),
    }
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"a", "b", "c"}), now=EPOCH
    )
    assert cred["a"].score == 0.0
    assert cred["b"].score == 0.0
    assert cred["c"].score == 0.0


def test_lineage_self_dealing_is_not_scale_gated() -> None:
    # Lineage is a verified on-chain fact, not a behavioral inference -- unlike
    # ring membership, a single lineage-sibling engagement still zeroes, no
    # scale or repetition required.
    edges = [_edge("a", "b", replies=1), _edge("b", "a", replies=1)]
    follows = {"a": frozenset({"b"}), "b": frozenset({"a"})}
    lineage = {"a": frozenset({"b"}), "b": frozenset({"a"})}
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, lineage=lineage, now=EPOCH)
    assert cred["a"].score == 0.0
    assert cred["b"].score == 0.0


# --- H02: the outside-ring-engagement discriminator the vouched tier gates on.
# ring-flagged-but-below-scale pair -> engaged band (score unchanged) but
# outside_engaged False; one genuine non-ring engager flips it True. ---


def test_ring_only_reciprocal_pair_is_not_outside_engaged() -> None:
    # Two accounts whose ENTIRE footprint is each other (ring-flagged, below the
    # scale bar -> the newcomer carve-out). They land in the engaged band, so
    # their SCORES are unchanged by H02 (still > floor, not zeroed, not blocked)
    # -- but they received NOTHING from outside their own pair, so the new
    # discriminator is False and the vouched tier will keep them UNKNOWN.
    edges = [_edge("a", "b", replies=1), _edge("b", "a", replies=1)]
    follows = {"a": frozenset({"b"}), "b": frozenset({"a"})}
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"a", "b"}), now=EPOCH
    )
    assert cred["a"].outside_engaged is False
    assert cred["b"].outside_engaged is False
    # scores untouched by the flag: still the engaged band (the existing
    # score-band tests above pin the exact values; the flag never feeds
    # _normalize_scores).
    assert cred["a"].score > CONFIG.min_vouched_score
    assert cred["b"].score > CONFIG.min_vouched_score


def test_one_genuine_outside_upvote_sets_outside_engaged() -> None:
    # The instant "a" receives an upvote from "peer" (NOT in the ring, so the
    # a<->b mutual edges are unchanged and peer forms no reciprocal ring edge),
    # a.outside_engaged flips True. "b", still engaged only by its own pair, does
    # not; "peer", which received nothing, does not. Scores are computed exactly
    # as before -- outside_received feeds only the flag.
    edges = [
        _edge("a", "b", replies=1),
        _edge("b", "a", replies=1),
        _edge("peer", "a", replies=1),
    ]
    follows = {"a": frozenset({"b"}), "b": frozenset({"a"}), "peer": frozenset({"a"})}
    cred = compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset({"a", "b"}), now=EPOCH
    )
    assert cred["a"].outside_engaged is True   # received a genuine non-ring upvote
    assert cred["b"].outside_engaged is False  # only ever engaged by its pair
    assert cred["peer"].outside_engaged is False  # received nothing
    # a is still in the engaged band, not zeroed.
    assert cred["a"].score > CONFIG.min_vouched_score


def test_lineage_engaged_account_is_not_outside_engaged() -> None:
    # A lineage sibling engagement is self-dealt (zeroed) and never reaches the
    # outside-received branch, so a pair engaged ONLY by its own lineage is not
    # outside_engaged -- consistent with it being scored 0.0 (self-dealing).
    edges = [_edge("a", "b", replies=5), _edge("b", "a", replies=5)]
    follows = {"a": frozenset({"b"}), "b": frozenset({"a"})}
    lineage = {"a": frozenset({"b"}), "b": frozenset({"a"})}
    cred = compute_graph_cred(edges, follows, WEIGHTS, config=CONFIG, lineage=lineage, now=EPOCH)
    assert cred["a"].outside_engaged is False
    assert cred["b"].outside_engaged is False
    assert cred["a"].score == 0.0  # self-dealing, unchanged


def test_min_ring_self_dealing_events_must_be_at_least_two() -> None:
    # At 1, every qualifying ring edge already has >=1 event per direction by
    # construction (ring.py requires both directions nonzero), so the gate
    # this field exists for would be a silent no-op.
    for bad in (1, 0, -1):
        try:
            GraphCredConfig(min_ring_self_dealing_events=bad)
        except ValueError:
            continue
        raise AssertionError(
            f"min_ring_self_dealing_events={bad} should have been rejected"
        )


# ---------------------------------------------------------------------------
# Sparse PageRank (2026-08-04). `_weighted_pagerank` was rewritten from a dense
# N x N adjacency to a sparse COO scatter-add. These pin the two properties the
# rewrite could plausibly have broken: agreement with the dense form, and
# reproducibility.
# ---------------------------------------------------------------------------


def _dense_pagerank_oracle(nodes, follows, pair_weight, damping, iterations,
                           trusted_seeds, seed_teleport_share):
    """The pre-2026-08-04 DENSE implementation, kept here as a test oracle only.

    Deliberately in the test file rather than the package: the package must have
    exactly one implementation of this function. Three copies of the edge-weight
    formula already drifted in this codebase (`ring._edge_weight`,
    `viewer_affinity._decayed`, `graph_cred.edge_weight`) and the comment telling
    people to keep them in sync did not prevent it.
    """
    import numpy as np

    from recsys.core.graph_cred import _teleport_vector

    n = len(nodes)
    index = {a: i for i, a in enumerate(nodes)}
    adjacency = np.zeros((n, n), dtype=np.float64)
    for follower, followees in follows.items():
        i = index[follower]
        for followee in followees:
            adjacency[i, index[followee]] = pair_weight.get((follower, followee), 0.0)
    if not adjacency.any():
        return dict.fromkeys(nodes, 0.0)
    out_weight = adjacency.sum(axis=1)
    dangling = out_weight == 0.0
    safe = np.where(dangling, 1.0, out_weight)
    transition = np.where(dangling[:, None], 0.0, adjacency / safe[:, None])
    teleport = _teleport_vector(nodes, trusted_seeds, damping, seed_teleport_share)
    rank = np.full(n, 1.0 / n, dtype=np.float64)
    for _ in range(iterations):
        dangling_mass = damping * rank[dangling].sum() / n
        rank = teleport + dangling_mass + damping * (rank @ transition)
    return dict(zip(nodes, rank.tolist(), strict=True))


def _random_graph(seed: int, n: int, density: float):
    import random

    rng = random.Random(seed)
    nodes = [f"a{i:04d}" for i in range(n)]
    follows: dict[str, frozenset[str]] = {}
    pair_weight: dict[tuple[str, str], float] = {}
    for a in nodes:
        targets = {b for b in nodes if b != a and rng.random() < density}
        follows[a] = frozenset(targets)
        for b in targets:
            pair_weight[(a, b)] = rng.uniform(0.1, 20.0)
    return nodes, follows, pair_weight


@pytest.mark.parametrize("seeded", [False, True])
@pytest.mark.parametrize("n,density", [(1, 0.5), (12, 0.4), (60, 0.08), (150, 0.03)])
def test_sparse_pagerank_matches_the_dense_oracle(n: int, density: float, seeded: bool) -> None:
    from recsys.core.graph_cred import _weighted_pagerank

    nodes, follows, pair_weight = _random_graph(seed=n + int(seeded), n=n, density=density)
    seeds = frozenset(nodes[: max(1, n // 10)]) if seeded else frozenset()
    kwargs = dict(
        damping=0.85, iterations=25, trusted_seeds=seeds, seed_teleport_share=0.5
    )
    got = _weighted_pagerank(nodes, follows, pair_weight, **kwargs)
    want = _dense_pagerank_oracle(nodes, follows, pair_weight, **kwargs)
    assert set(got) == set(want)
    for account in nodes:
        assert got[account] == pytest.approx(want[account], abs=1e-15)


def test_sparse_pagerank_handles_the_degenerate_shapes() -> None:
    """Dangling nodes, zero-weight edges, an all-zero graph, and a follow edge
    with no engagement behind it — each must match the dense oracle exactly."""
    from recsys.core.graph_cred import _weighted_pagerank

    nodes = ["a", "b", "c", "d"]
    follows = {
        "a": frozenset({"b", "c"}),
        "b": frozenset(),               # dangling: follows nobody
        "c": frozenset({"d"}),          # edge with NO pair_weight entry -> 0.0
        "d": frozenset({"a"}),
    }
    pair_weight = {("a", "b"): 3.0, ("a", "c"): 1.0, ("d", "a"): 2.0, ("c", "d"): 0.0}
    kwargs = dict(
        damping=0.85, iterations=30, trusted_seeds=frozenset(), seed_teleport_share=0.5
    )
    got = _weighted_pagerank(nodes, follows, pair_weight, **kwargs)
    want = _dense_pagerank_oracle(nodes, follows, pair_weight, **kwargs)
    for account in nodes:
        assert got[account] == pytest.approx(want[account], abs=1e-15)

    # every weight zero -> everyone 0.0, same short-circuit as dense
    allzero = _weighted_pagerank(
        nodes, follows, {k: 0.0 for k in pair_weight}, **kwargs
    )
    assert allzero == dict.fromkeys(nodes, 0.0)


def test_sparse_pagerank_is_bit_identical_across_hash_seeds() -> None:
    """★ The guarantee the canonical lexsort exists to protect.

    `np.add.at` accumulates in argument order; that order follows Python's
    hash-randomised iteration over `follows.items()`; float addition is not
    associative. Without the sort, raw ranks wobble in the ~15th significant
    digit between processes on byte-identical input — a reproducibility
    guarantee the dense implementation had for free. Asserts BIT equality, not
    approx: approx would pass with the bug present.
    """
    import json
    import subprocess
    import sys

    program = (
        "import json,sys;"
        "sys.path.insert(0, '.');"
        "from recsys.core.graph_cred import _weighted_pagerank as p;"
        "n=[f'a{i:03d}' for i in range(80)];"
        "import random;r=random.Random(7);"
        # NOTE: iterate SORTED targets when assigning weights. Iterating a
        # frozenset here would make the INPUT graph differ across hash seeds and
        # the test would fail for a reason that has nothing to do with pagerank.
        "f={a: frozenset(b for b in n if b!=a and r.random()<0.15) for a in n};"
        "w={(a,b): r.uniform(0.1,9.0) for a in n for b in sorted(f[a])};"
        "print(json.dumps(p(n,f,w,damping=0.85,iterations=20,"
        "trusted_seeds=frozenset(n[:5]),seed_teleport_share=0.5)))"
    )
    outputs = []
    for hash_seed in ("0", "1", "42"):
        proc = subprocess.run(
            [sys.executable, "-c", program],
            capture_output=True, text=True, check=True,
            env={"PYTHONHASHSEED": hash_seed, "PATH": "/usr/bin:/bin"},
            cwd=str(pathlib.Path(__file__).resolve().parent.parent),
        )
        outputs.append(json.loads(proc.stdout))
    for other in outputs[1:]:
        assert other == outputs[0], "pagerank is not reproducible across hash seeds"


def test_the_score_bands_leave_no_room_for_a_percentile_floor() -> None:
    """★ Why cold-start spec item D2/B3 is closed as WON'T-BUILD.

    D2 asked for the eligibility floors to become live percentiles excluding a
    bottom slice. That is unreachable, and this pins the structural reason so
    nobody re-opens it from the failing acceptance test alone: the score has a
    GAP between the self-dealing band (0.0) and the unknown band
    (`min_vouched_score`, 0.10), and the engaged band starts above the unknown
    one. So a floor either sits in the gap — where it means exactly "not a
    proven self-dealer" — or it rises past 0.10 and removes every newcomer
    before it touches a single engaged account.
    """
    config = GraphCredConfig()
    edges = [
        # an engaged cluster
        EngagementEdge(src="a", dst="b", replies=9, last_interaction=EPOCH),
        EngagementEdge(src="b", dst="c", replies=7, last_interaction=EPOCH),
        EngagementEdge(src="c", dst="a", replies=5, last_interaction=EPOCH),
        # a never-engaged account: present in the graph, receives nothing
        EngagementEdge(src="lurker", dst="a", replies=1, last_interaction=EPOCH),
    ]
    follows = {
        "a": frozenset({"b"}), "b": frozenset({"c"}), "c": frozenset({"a"}),
        "lurker": frozenset({"a"}),
    }
    creds = compute_graph_cred(
        edges, follows, RealGraphWeights(), config=config, now=EPOCH
    )
    scores = {a: c.score for a, c in creds.items()}

    # the never-engaged account sits at the unknown band, NOT below it
    assert scores["lurker"] == pytest.approx(config.min_vouched_score)
    # and nothing occupies the gap between "self-dealt" and "unknown"
    assert not [s for s in scores.values() if 0.0 < s < config.min_vouched_score], (
        "a score landed between the self-dealing and unknown bands — the gap "
        "this project's floors rely on has closed; re-read Thresholds' note "
        "before changing any floor"
    )
