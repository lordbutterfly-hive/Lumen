"""Tests for basic vote-ring detection: reciprocity + insularity (§8.5)."""

from __future__ import annotations

from datetime import datetime, timedelta

from recsys.config import RealGraphWeights
from recsys.contracts import EngagementEdge
from recsys.core.ring import detect_rings, ring_member_set
from tests.fakes import EPOCH

WEIGHTS = RealGraphWeights()


def _edge(
    src: str,
    dst: str,
    *,
    upvotes: int = 0,
    replies: int = 0,
    reply_backs: int = 0,
    last: datetime | None = None,
) -> EngagementEdge:
    return EngagementEdge(
        src=src,
        dst=dst,
        upvotes=upvotes,
        replies=replies,
        reply_backs=reply_backs,
        last_interaction=last,
    )


def test_empty_edges_returns_empty() -> None:
    assert detect_rings([], WEIGHTS) == {}


def test_mutual_2_clique_scores_high() -> None:
    # alice & bob only ever engage each other, heavily and reciprocally -> ALL
    # of each account's engagement volume is inside the pair -> ring_score 1.0.
    edges = [
        _edge("alice", "bob", upvotes=10, reply_backs=5),
        _edge("bob", "alice", upvotes=10, reply_backs=5),
    ]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["alice"].ring_score == 1.0
    assert signals["bob"].ring_score == 1.0
    assert signals["alice"].ring_id is not None
    assert signals["alice"].ring_id == signals["bob"].ring_id


def test_one_directional_superfan_scores_zero() -> None:
    # superfan only ever upvotes celeb; celeb never engages back -> no mutual
    # edge exists at all, so superfan never joins a ring (absent, not 0.0).
    edges = [_edge("superfan", "celeb", upvotes=50)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals == {}
    assert "superfan" not in signals
    assert ring_member_set(signals, 0.0) == frozenset()


def test_honest_hub_with_purely_one_way_inbound_scores_zero() -> None:
    # Many distinct fans each engage a popular hub one-way; the hub never
    # engages any of them back -> no reciprocal edges at all -> no ring.
    edges = [_edge(f"fan{i}", "hub", upvotes=5) for i in range(10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals == {}


def test_honest_hub_with_one_reciprocal_edge_still_scores_low() -> None:
    # hub reciprocates fan0 perfectly, but that pair is a tiny slice of hub's
    # total footprint once 9 other one-way fans are added -> low insularity
    # -> low ring_score for hub, even though a real ring edge exists. fan0,
    # whose entire footprint IS the reciprocal edge, scores high in contrast.
    edges = [_edge("fan0", "hub", upvotes=5), _edge("hub", "fan0", upvotes=5)]
    edges += [_edge(f"fan{i}", "hub", upvotes=50) for i in range(1, 10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["fan0"].ring_score == 1.0
    assert signals["hub"].ring_score < 0.1
    assert all(f"fan{i}" not in signals for i in range(1, 10))


def test_insular_pair_outscores_pair_diluted_by_outside_engagement() -> None:
    # a1/b1 reciprocate and have NO other engagement -> fully insular. a2/b2
    # reciprocate identically, but a2 also has heavy one-way outbound
    # engagement to unrelated strangers -> same reciprocity, lower insularity.
    insular = [_edge("a1", "b1", upvotes=10), _edge("b1", "a1", upvotes=10)]
    diluted = [
        _edge("a2", "b2", upvotes=10),
        _edge("b2", "a2", upvotes=10),
        _edge("a2", "stranger1", upvotes=100),
        _edge("a2", "stranger2", upvotes=100),
    ]
    signals = detect_rings(insular + diluted, WEIGHTS, now=EPOCH)
    assert signals["a1"].ring_score == 1.0
    assert 0.0 < signals["a2"].ring_score < signals["a1"].ring_score
    assert "stranger1" not in signals
    assert "stranger2" not in signals


def test_unbalanced_reciprocity_below_min_is_not_a_ring() -> None:
    # bob engages alice 10x harder than she engages him back -> ratio 0.1,
    # under the default reciprocity_min=0.5 -> no ring edge forms.
    edges = [_edge("alice", "bob", upvotes=1), _edge("bob", "alice", upvotes=10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals == {}


def test_reciprocity_min_is_configurable() -> None:
    # the same 0.1-ratio pair DOES form a ring once the threshold is lowered
    # to admit it.
    edges = [_edge("alice", "bob", upvotes=1), _edge("bob", "alice", upvotes=10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH, reciprocity_min=0.05)
    assert signals["alice"].ring_score > 0.0
    assert signals["bob"].ring_score > 0.0


def test_min_group_filters_out_small_components() -> None:
    edges = [_edge("alice", "bob", upvotes=10), _edge("bob", "alice", upvotes=10)]
    assert detect_rings(edges, WEIGHTS, now=EPOCH, min_group=3) == {}
    assert detect_rings(edges, WEIGHTS, now=EPOCH, min_group=2) != {}


def test_three_way_ring_shares_a_ring_id() -> None:
    edges = [
        _edge("a", "b", upvotes=10),
        _edge("b", "a", upvotes=10),
        _edge("b", "c", upvotes=10),
        _edge("c", "b", upvotes=10),
        _edge("a", "c", upvotes=10),
        _edge("c", "a", upvotes=10),
    ]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["a"].ring_id == signals["b"].ring_id == signals["c"].ring_id
    assert signals["a"].ring_score == 1.0
    assert signals["b"].ring_score == 1.0
    assert signals["c"].ring_score == 1.0


def test_stale_edge_decays_below_reciprocity_threshold() -> None:
    # alice's side of the pair is ancient (20 half-lives old) and decays
    # toward zero; bob's reply-back is fresh -> the ratio collapses well
    # under reciprocity_min even though the raw (undecayed) counts matched.
    now = EPOCH + timedelta(days=600)
    edges = [
        _edge("alice", "bob", upvotes=10, last=EPOCH),
        _edge("bob", "alice", upvotes=10, last=now),
    ]
    assert detect_rings(edges, WEIGHTS, now=now) == {}


def test_ring_member_set_thresholds_correctly() -> None:
    edges = [
        _edge("alice", "bob", upvotes=10),
        _edge("bob", "alice", upvotes=10),
        _edge("alice", "stranger", upvotes=100),  # dilutes alice's insularity only
    ]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["bob"].ring_score == 1.0
    assert 0.0 < signals["alice"].ring_score < signals["bob"].ring_score

    assert ring_member_set(signals, 0.5) == frozenset({"bob"})
    assert ring_member_set(signals, signals["alice"].ring_score) == frozenset({"alice", "bob"})
    assert ring_member_set(signals, 1.01) == frozenset()


def test_ring_member_set_empty_signals_is_empty() -> None:
    assert ring_member_set({}, 0.0) == frozenset()


def test_deterministic_across_runs() -> None:
    edges = [
        _edge("alice", "bob", upvotes=10),
        _edge("bob", "alice", upvotes=10),
        _edge("carol", "dave", upvotes=5),
        _edge("dave", "carol", upvotes=5),
    ]
    first = detect_rings(edges, WEIGHTS, now=EPOCH)
    second = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert first == second
