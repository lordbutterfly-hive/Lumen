"""Tests for basic vote-ring detection: reciprocity + insularity (§8.5)."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

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


def test_only_engagement_RECEIVED_dilutes_insularity_never_engagement_sent() -> None:
    """★ SEMANTICS CHANGED 2026-08-03, deliberately — this test previously
    asserted the opposite and the old assertion WAS the vulnerability.

    It used to require that heavy one-way OUTBOUND engagement lowered an
    account's ring_score ("same reciprocity, lower insularity"). Measured
    consequence on a dense 4-sock reciprocal ring: ~20 one-way upvotes per sock,
    aimed at one popular honest account, took ring_score 1.0000 -> 0.4737, under
    the 0.6 discount threshold, and graph-cred from 0.0000 (condemned) to
    1.0000. Twenty free upvotes each and the detector was defeated. Sending is
    costless and attacker-chosen, so it cannot be evidence of anything.

    Receiving still dilutes, and must: that is the honest hub above, whose fans
    engage IT (see test_honest_hub_with_one_reciprocal_edge_still_scores_low,
    which is unchanged and still passes — the legitimate case is defined by
    inbound, the exploit by outbound, and that is exactly what separates them).
    """
    insular = [_edge("a1", "b1", upvotes=10), _edge("b1", "a1", upvotes=10)]
    # a2 SPENDS heavily on strangers who never engage back — the attack shape.
    spender = [
        _edge("a2", "b2", upvotes=10),
        _edge("b2", "a2", upvotes=10),
        _edge("a2", "stranger1", upvotes=100),
        _edge("a2", "stranger2", upvotes=100),
    ]
    # a3 RECEIVES from unrelated accounts — genuine evidence of an audience.
    received = [
        _edge("a3", "b3", upvotes=10),
        _edge("b3", "a3", upvotes=10),
        _edge("stranger3", "a3", upvotes=100),
    ]
    signals = detect_rings(insular + spender + received, WEIGHTS, now=EPOCH)

    assert signals["a1"].ring_score == 1.0
    # buying your way out is no longer possible: identical to the undiluted pair
    assert signals["a2"].ring_score == signals["a1"].ring_score
    # being engaged BY outsiders still lowers insularity, as it should
    assert 0.0 < signals["a3"].ring_score < signals["a1"].ring_score
    for name in ("stranger1", "stranger2", "stranger3"):
        assert name not in signals


def test_outbound_spending_cannot_buy_a_ring_out_of_detection() -> None:
    """Regression for the measured bypass: a dense mutual ring must stay
    flagged no matter how much free one-way engagement its members spend."""
    socks = ["s0", "s1", "s2", "s3"]
    ring = [
        _edge(a, b, upvotes=3) for a in socks for b in socks if a != b
    ]
    for noise in (0, 12, 20, 41, 100, 1000):
        edges = list(ring)
        edges += [_edge(a, "popular_hub", upvotes=noise) for a in socks if noise]
        signals = detect_rings(edges, WEIGHTS, now=EPOCH)
        assert signals["s0"].ring_score == 1.0, f"diluted out at noise={noise}"
        assert set(ring_member_set(signals, 0.6)) >= set(socks)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "KNOWN OPEN: a one-way PUPPET dilutes a ring out of detection for one "
        "extra account. Pass 1 can only flag accounts that landed in a "
        "reciprocal group, so an account that sprays engagement in and never "
        "reciprocates is never flagged and its credit is never discounted. "
        "Candidate fix (concentration-weighting outside credit) collides with "
        "test_honest_hub_with_one_reciprocal_edge_still_scores_low, whose fans "
        "are also single-target. If this XPASSes, someone resolved that "
        "tension — remove the marker and record how."
    ),
)
def test_KNOWN_OPEN_one_way_puppet_dilutes_a_ring() -> None:
    """Measured: 13 upvotes from ONE puppet into each of 4 socks takes the whole
    ring from 1.0000 to 0.5806 — under the 0.6 threshold, 0/4 flagged."""
    socks = ["s0", "s1", "s2", "s3"]
    edges = [_edge(a, b, upvotes=3) for a in socks for b in socks if a != b]
    edges += [_edge("puppet", s, upvotes=13) for s in socks]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert "puppet" not in signals  # never joins a group -> never discountable
    assert set(ring_member_set(signals, 0.6)) >= set(socks)


def test_a_sacrificial_second_ring_cannot_launder_the_first() -> None:
    """The residual the received-only denominator left, and the second pass
    closes: engagement received from OUTSIDE is the one remaining way to inflate
    a denominator, and an attacker can supply it themselves.

    Ring B one-way engages ring A. B never reciprocates, so the reciprocal
    adjacency never merges them and A's outside-received grows. Measured before
    the second pass: A was cleaned at just 5 upvotes each (score 1.0 -> 0.4737)
    while B stayed condemned — clean identities at 2x accounts. Credit from an
    already-flagged source is now discarded, so A holds at 1.0.
    """
    a = ["a0", "a1", "a2", "a3"]
    b = ["b0", "b1", "b2", "b3"]
    base = [
        _edge(x, y, upvotes=3) for grp in (a, b) for x in grp for y in grp if x != y
    ]
    for noise in (5, 20, 100, 1000):
        edges = base + [_edge(src, dst, upvotes=noise) for src in b for dst in a]
        signals = detect_rings(edges, WEIGHTS, now=EPOCH)
        assert signals["a0"].ring_score == 1.0, f"laundered at noise={noise}"
        assert set(ring_member_set(signals, 0.6)) >= set(a) | set(b)


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
        # Dilutes alice only. NOTE the direction: stranger -> alice. This was
        # alice -> stranger until 2026-08-03, but engagement an account SENDS no
        # longer dilutes its insularity (that was a free bypass — see
        # test_only_engagement_RECEIVED_dilutes_insularity_never_engagement_sent).
        # Engagement RECEIVED still does, which is what this threshold test needs
        # to produce two accounts with different scores.
        _edge("stranger", "alice", upvotes=100),
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
