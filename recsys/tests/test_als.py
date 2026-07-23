"""Tests for implicit-feedback ALS: the CF slice of the organic bucket (§6.1)."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from recsys.config import ALSConfig
from recsys.contracts import EngagementEdge
from recsys.core.als import train_als
from recsys.core.vote_signal import VoterTrust

# Small factor count + enough alternations to converge on the tiny synthetic
# graphs below; deterministic via the fixed seed.
CONFIG = ALSConfig(factors=4, iterations=25, regularization=0.05, alpha=40.0, seed=0)


def _edge(
    src: str,
    dst: str,
    *,
    replies: int = 0,
    reply_backs: int = 0,
    reblogs: int = 0,
    upvotes: int = 0,
) -> EngagementEdge:
    return EngagementEdge(
        src=src, dst=dst, replies=replies, reply_backs=reply_backs,
        reblogs=reblogs, upvotes=upvotes,
    )


def test_heavy_engagement_beats_never_engaged_author() -> None:
    # "viewer" only ever engages author_a. author_b is a separate connected
    # component (other1/other2 only) with no path back to viewer or author_a,
    # so it carries no learned relationship to viewer's engagement.
    edges = [
        _edge("viewer", "author_a", upvotes=20, replies=5),
        _edge("other1", "author_b", upvotes=10),
        _edge("other2", "author_b", upvotes=10),
    ]
    model = train_als(edges, CONFIG)
    assert model.affinity("viewer", "author_a") > model.affinity("viewer", "author_b")


def test_identical_engagement_patterns_get_similar_affinity() -> None:
    # user1 and user2 have byte-for-byte identical ratings against author_a,
    # so their per-row ridge solves consume the same (fixed, items,
    # confidences) inputs at every alternation and must land on the same
    # factor vector.
    edges = [
        _edge("user1", "author_a", upvotes=15, replies=3),
        _edge("user2", "author_a", upvotes=15, replies=3),
        _edge("filler", "author_a", upvotes=5),
    ]
    model = train_als(edges, CONFIG)
    a1 = model.affinity("user1", "author_a")
    a2 = model.affinity("user2", "author_a")
    assert math.isclose(a1, a2, abs_tol=1e-9)


def test_co_engagement_transfers_positive_affinity() -> None:
    # cohort1..3 heavily engage BOTH author_a and author_b -> ALS should pull
    # author_a's and author_b's factors toward a shared direction. "target"
    # only ever engages author_a (no edge to author_b at all), so any
    # affinity it has for author_b must come purely from the learned
    # co-engagement pattern, not from target's own history. author_c sits in
    # a disjoint cluster unrelated to a/b/target, as a negative control.
    edges = [
        _edge("cohort1", "author_a", upvotes=20),
        _edge("cohort1", "author_b", upvotes=20),
        _edge("cohort2", "author_a", upvotes=20),
        _edge("cohort2", "author_b", upvotes=20),
        _edge("cohort3", "author_a", upvotes=20),
        _edge("cohort3", "author_b", upvotes=20),
        _edge("other1", "author_c", upvotes=20),
        _edge("other2", "author_c", upvotes=20),
        _edge("target", "author_a", upvotes=20),
    ]
    model = train_als(edges, CONFIG)
    transfer = model.affinity("target", "author_b")
    assert transfer > 0.0
    assert transfer > model.affinity("target", "author_c")


def test_unknown_user_or_item_is_cold() -> None:
    edges = [_edge("viewer", "author_a", upvotes=5)]
    model = train_als(edges, CONFIG)
    assert model.affinity("nobody", "author_a") == 0.0
    assert model.affinity("viewer", "nobody") == 0.0
    assert model.affinity("nobody", "nobody") == 0.0


def test_deterministic_across_runs() -> None:
    edges = [
        _edge("u1", "author_a", upvotes=10),
        _edge("u2", "author_a", upvotes=5),
        _edge("u2", "author_b", upvotes=8),
    ]
    first = train_als(edges, CONFIG)
    second = train_als(edges, CONFIG)
    assert np.array_equal(first.user_factors, second.user_factors)
    assert np.array_equal(first.item_factors, second.item_factors)
    assert first.affinity("u1", "author_a") == second.affinity("u1", "author_a")


def test_empty_edges_yields_empty_model() -> None:
    model = train_als([], CONFIG)
    assert model.user_factors.shape == (0, CONFIG.factors)
    assert model.item_factors.shape == (0, CONFIG.factors)
    assert model.user_index == {}
    assert model.item_index == {}
    assert model.affinity("anyone", "anything") == 0.0


def test_ring_members_edges_excluded_from_cf() -> None:
    # A collusion ring's mutual engagement must not enter the CF matrix, so it
    # can't launder affinity (§8.4/§8.5) — mirrors graph_cred's exclusion.
    edges = [
        EngagementEdge(src="r1", dst="r2", upvotes=10, replies=10),
        EngagementEdge(src="r2", dst="r1", upvotes=10, replies=10),
        EngagementEdge(src="honest", dst="author", upvotes=5, replies=5),
    ]
    model = train_als(edges, CONFIG, ring_members=frozenset({"r1", "r2"}))
    assert "r1" not in model.item_index
    assert "r2" not in model.item_index
    assert model.affinity("r1", "r2") == 0.0
    assert "author" in model.item_index  # honest engagement survives


def test_lineage_sibling_edges_excluded_from_cf() -> None:
    edges = [EngagementEdge(src="a", dst="b", upvotes=10, replies=10)]
    model = train_als(edges, CONFIG, lineage={"a": frozenset({"b"})})
    assert model.affinity("a", "b") == 0.0  # a->b excluded, b never indexed


def test_als_config_rejects_nonpositive_regularization() -> None:
    with pytest.raises(ValueError, match="regularization"):
        ALSConfig(regularization=0.0)


# ---------------------------------------------------------------------------
# H12 (2026-07-22): _interaction_matrix time-decay. Before this fix r_ui was
# summed with NO decay while graph_cred/ring both apply a 30-day half-life to
# the same RealGraph edges -- a co-engagement pair from a year ago counted
# exactly as much toward CF affinity as one from yesterday.
# ---------------------------------------------------------------------------


def test_stale_edges_decay_toward_zero_relative_to_fresh() -> None:
    # Two viewers with IDENTICAL raw volume toward the same author; only
    # last_interaction age differs. Fresh (1 day old) keeps ~full weight;
    # stale (400 days old, well past the 30-day half-life) is decayed to
    # near-nothing, so it must earn a visibly smaller affinity.
    now = datetime(2026, 6, 1, tzinfo=UTC)
    fresh = EngagementEdge(
        src="viewer_fresh", dst="author_a", upvotes=20,
        last_interaction=now - timedelta(days=1),
    )
    stale = EngagementEdge(
        src="viewer_stale", dst="author_a", upvotes=20,
        last_interaction=now - timedelta(days=400),
    )
    model = train_als([fresh, stale], CONFIG, now=now, half_life_days=30.0)
    assert model.affinity("viewer_fresh", "author_a") > model.affinity(
        "viewer_stale", "author_a"
    )


def test_edges_without_last_interaction_are_decay_inert() -> None:
    # H12 must not force every PRE-EXISTING (last_interaction=None) edge to
    # decay against a resolved wall-clock "now" -- decay only applies once an
    # edge actually carries a timestamp (mirrors graph_cred.edge_weight /
    # ring._edge_weight's own `last_interaction is None -> decay = 1.0`).
    edges = [_edge("viewer", "author_a", upvotes=5)]
    undecayed = train_als(edges, CONFIG)
    decayed_call = train_als(
        edges, CONFIG, now=datetime(2030, 1, 1, tzinfo=UTC), half_life_days=1.0
    )
    assert np.array_equal(undecayed.item_factors, decayed_call.item_factors)
    assert np.array_equal(undecayed.user_factors, decayed_call.user_factors)


def test_shorter_half_life_decays_a_stale_edge_faster() -> None:
    # Same edge, same age, only half_life_days differs: a shorter half-life
    # must decay the (already-60-day-old) edge harder, so the resulting
    # affinity magnitude must be smaller.
    now = datetime(2026, 6, 1, tzinfo=UTC)
    edges = [
        EngagementEdge(
            src="v", dst="a", upvotes=20, last_interaction=now - timedelta(days=60)
        )
    ]
    short_half_life = train_als(edges, CONFIG, now=now, half_life_days=10.0)
    long_half_life = train_als(edges, CONFIG, now=now, half_life_days=365.0)
    assert abs(short_half_life.affinity("v", "a")) < abs(long_half_life.affinity("v", "a"))


def test_future_last_interaction_clamps_to_zero_age_not_negative_decay() -> None:
    # A clock-skew edge whose last_interaction is AFTER "now" must not decay
    # to > 1.0 (that would mean stronger-than-full weight) -- age clamps at 0.
    now = datetime(2026, 6, 1, tzinfo=UTC)
    edges = [
        EngagementEdge(
            src="v", dst="a", upvotes=20, last_interaction=now + timedelta(days=30)
        )
    ]
    future = train_als(edges, CONFIG, now=now, half_life_days=30.0)
    baseline = train_als(
        [EngagementEdge(src="v", dst="a", upvotes=20, last_interaction=now)],
        CONFIG, now=now, half_life_days=30.0,
    )
    assert future.affinity("v", "a") == pytest.approx(baseline.affinity("v", "a"))


# ---------------------------------------------------------------------------
# C1/C2 — the CF trust budget. A one-directional sock -> author star slips ring
# (no reciprocal edge) and lineage (no delegation row), so an un-budgeted CF
# matrix lets a swarm inflate a shill author's item factor and poison a targeted
# viewer's affinity. Threading the SAME VoterTrust breadth budget into training
# caps the unknown-tier engagers per author, defusing the poison.
# ---------------------------------------------------------------------------


def test_trust_budget_defuses_one_directional_shill_cf_poisoning() -> None:
    # "viewer" (and a vouched cohort) genuinely engage the popular author "pop".
    # A swarm of 12 unknown socks one-directionally engage BOTH "pop" (to bridge
    # to viewer's taste) and the shill "shill" (to inflate its factor). With no
    # trust, ALS learns viewer -> shill affinity through that sock bridge; with
    # the budget, "shill" is rated by unknown socks only, so its unknown budget
    # is exactly unknown_free=1 and the swarm buys almost no item-factor mass.
    socks = [f"sock{i}" for i in range(12)]
    edges = [
        _edge("viewer", "pop", upvotes=20),
        _edge("cohort1", "pop", upvotes=20),
        _edge("cohort2", "pop", upvotes=20),
    ]
    for s in socks:
        edges.append(_edge(s, "pop", upvotes=20))     # bridge to viewer's taste
        edges.append(_edge(s, "shill", upvotes=20))   # inflate the shill's factor

    poisoned = train_als(edges, CONFIG)
    trust = VoterTrust(
        vouched=frozenset({"viewer", "cohort1", "cohort2"}),
        unknown_free=1.0,
        unknown_per_vouched=2.0,
    )
    defended = train_als(edges, CONFIG, trust=trust)

    # Without the budget the poison lands: viewer -> shill affinity is elevated.
    assert poisoned.affinity("viewer", "shill") > 0.0
    # With the budget it is defused: the shill's affinity drops sharply (the
    # swarm's 12 sock ratings collapse to the unknown_free budget of 1) ...
    assert defended.affinity("viewer", "shill") < poisoned.affinity("viewer", "shill")
    # ... to a small fraction of the GENUINE viewer -> pop affinity, which the
    # budget leaves intact (pop is rated by vouched viewer + cohort in full).
    assert defended.affinity("viewer", "shill") < 0.5 * defended.affinity("viewer", "pop")


def test_trust_none_leaves_the_cf_matrix_unbudgeted() -> None:
    # The norm-sample / no-snapshot path (trust=None) must train on the raw
    # decayed ratings exactly as before -- byte-identical factors.
    edges = [
        _edge("u1", "author_a", upvotes=10),
        _edge("u2", "author_a", upvotes=5),
        _edge("u2", "author_b", upvotes=8),
    ]
    without = train_als(edges, CONFIG)
    explicit_none = train_als(edges, CONFIG, trust=None)
    assert np.array_equal(without.user_factors, explicit_none.user_factors)
    assert np.array_equal(without.item_factors, explicit_none.item_factors)
