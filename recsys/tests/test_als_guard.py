"""Tests for the between-batch ALS anomaly gate (§H11).

:func:`als_batch_drift` is exercised two ways: directly-constructed
:class:`ALSModel` fixtures for full control over the factor arrays (the
first block below), and real :func:`train_als` runs on synthetic engagement
edges to prove the primitive behaves sensibly on an actual trained model,
including the poisoning scenario the gate exists to catch (the second
block).
"""

from __future__ import annotations

import numpy as np
import pytest

from recsys.config import ALSConfig
from recsys.contracts import EngagementEdge
from recsys.core.als import ALSModel, train_als
from recsys.core.als_guard import als_batch_drift

CONFIG = ALSConfig(factors=4, iterations=25, regularization=0.05, alpha=40.0, seed=0)


def _model(
    user_index: dict[str, int],
    item_index: dict[str, int],
    user_factors: np.ndarray,
    item_factors: np.ndarray,
) -> ALSModel:
    return ALSModel(
        user_factors=user_factors,
        item_factors=item_factors,
        user_index=user_index,
        item_index=item_index,
    )


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


# ---------------------------------------------------------------------------
# Directly-constructed ALSModel fixtures — full control over factor arrays.
# ---------------------------------------------------------------------------


def test_identical_models_zero_drift() -> None:
    rng = np.random.default_rng(1)
    users = {"u1": 0, "u2": 1}
    items = {"a1": 0, "a2": 1}
    user_factors = rng.normal(size=(2, 3))
    item_factors = rng.normal(size=(2, 3))
    model = _model(users, items, user_factors, item_factors)
    assert als_batch_drift(model, model) == 0.0


def test_no_shared_users_returns_zero() -> None:
    rng = np.random.default_rng(2)
    items = {"a1": 0}
    current = _model({"u1": 0}, items, rng.normal(size=(1, 2)), rng.normal(size=(1, 2)))
    previous = _model({"u2": 0}, items, rng.normal(size=(1, 2)), rng.normal(size=(1, 2)))
    assert als_batch_drift(current, previous) == 0.0


def test_no_shared_items_returns_zero() -> None:
    rng = np.random.default_rng(3)
    users = {"u1": 0}
    current = _model(users, {"a1": 0}, rng.normal(size=(1, 2)), rng.normal(size=(1, 2)))
    previous = _model(users, {"a2": 0}, rng.normal(size=(1, 2)), rng.normal(size=(1, 2)))
    assert als_batch_drift(current, previous) == 0.0


def test_empty_previous_model_returns_zero() -> None:
    # previous == the empty-edges ALSModel shape (train_als's own convention
    # for "nothing trained") — no index entries at all, so no overlap.
    rng = np.random.default_rng(4)
    current = _model(
        {"u1": 0}, {"a1": 0}, rng.normal(size=(1, 2)), rng.normal(size=(1, 2))
    )
    previous = _model({}, {}, np.zeros((0, 2)), np.zeros((0, 2)))
    assert als_batch_drift(current, previous) == 0.0


def test_zero_previous_rms_returns_zero() -> None:
    # Shared grid exists but previous predicts exactly 0.0 affinity
    # everywhere on it (degenerate/all-zero prior factors) -- nothing to
    # normalize against, so the gate must not divide by zero or fabricate a
    # maximal reading.
    users = {"u1": 0}
    items = {"a1": 0}
    current = _model(users, items, np.array([[1.0, 1.0]]), np.array([[1.0, 1.0]]))
    previous = _model(users, items, np.zeros((1, 2)), np.array([[5.0, 5.0]]))
    assert als_batch_drift(current, previous) == 0.0


def test_only_shared_pairs_considered() -> None:
    # current has an extra brand-new user/author this week that previous
    # never trained; adding factors for them (even wildly different ones)
    # must not move the drift figure computed on the shared grid.
    users = {"u1": 0}
    items = {"a1": 0}
    user_factors = np.array([[1.0, 0.0]])
    item_factors = np.array([[1.0, 0.0]])
    previous = _model(users, items, user_factors, item_factors)
    current_shared_only = _model(
        users, items, user_factors + 0.1, item_factors
    )
    baseline_drift = als_batch_drift(current_shared_only, previous)

    current_with_extra = _model(
        {"u1": 0, "u2": 1},
        {"a1": 0, "a2": 1},
        np.vstack([user_factors + 0.1, [[999.0, -999.0]]]),
        np.vstack([item_factors, [[-999.0, 999.0]]]),
    )
    assert als_batch_drift(current_with_extra, previous) == pytest.approx(baseline_drift)


def test_perturbation_increases_drift_monotonically() -> None:
    users = {"u1": 0, "u2": 1}
    items = {"a1": 0, "a2": 1}
    base_user = np.array([[1.0, 0.5], [0.3, 1.2]])
    base_item = np.array([[0.8, 0.2], [0.4, 0.9]])
    previous = _model(users, items, base_user, base_item)

    small = _model(users, items, base_user + 0.01, base_item)
    large = _model(users, items, base_user + 0.5, base_item)

    drift_small = als_batch_drift(small, previous)
    drift_large = als_batch_drift(large, previous)
    assert drift_small == 0.0 or drift_small > 0.0  # sanity: never negative
    assert drift_large > drift_small


def test_uniform_rescale_of_both_models_leaves_drift_unchanged() -> None:
    # A global config change (e.g. regularization) that uniformly rescales
    # every factor in BOTH weeks' models must not, by itself, move the drift
    # reading -- it is not the signal this gate exists to catch. Scaling
    # user_factors and item_factors each by sqrt(k) scales every predicted
    # affinity (a dot product) by exactly k.
    users = {"u1": 0, "u2": 1}
    items = {"a1": 0, "a2": 1}
    rng = np.random.default_rng(5)
    prev_user = rng.normal(size=(2, 3))
    prev_item = rng.normal(size=(2, 3))
    cur_user = prev_user + rng.normal(scale=0.3, size=(2, 3))
    cur_item = prev_item + rng.normal(scale=0.3, size=(2, 3))

    previous = _model(users, items, prev_user, prev_item)
    current = _model(users, items, cur_user, cur_item)
    baseline = als_batch_drift(current, previous)

    k = 7.0
    scale = np.sqrt(k)
    previous_scaled = _model(users, items, prev_user * scale, prev_item * scale)
    current_scaled = _model(users, items, cur_user * scale, cur_item * scale)
    rescaled = als_batch_drift(current_scaled, previous_scaled)

    assert rescaled == pytest.approx(baseline, rel=1e-9)


def test_drift_is_never_negative() -> None:
    rng = np.random.default_rng(6)
    users = {f"u{i}": i for i in range(5)}
    items = {f"a{i}": i for i in range(5)}
    previous = _model(users, items, rng.normal(size=(5, 3)), rng.normal(size=(5, 3)))
    current = _model(users, items, rng.normal(size=(5, 3)), rng.normal(size=(5, 3)))
    assert als_batch_drift(current, previous) >= 0.0


# ---------------------------------------------------------------------------
# Real train_als runs — proves the primitive behaves on an actually-trained
# model, including the H11 poisoning scenario itself.
# ---------------------------------------------------------------------------


def test_retraining_on_identical_edges_is_zero_drift() -> None:
    edges = [
        _edge("u1", "author_a", upvotes=10, replies=2),
        _edge("u2", "author_a", upvotes=5),
        _edge("u2", "author_b", upvotes=8),
    ]
    week1 = train_als(edges, CONFIG)
    week2 = train_als(edges, CONFIG)  # same edges, same seed -> deterministic
    assert als_batch_drift(week2, week1) == 0.0


def test_poisoned_batch_produces_positive_drift() -> None:
    # Baseline week: an honest, stable engagement pattern.
    honest_edges = [
        _edge("cohort1", "author_a", upvotes=20),
        _edge("cohort2", "author_a", upvotes=18),
        _edge("cohort3", "author_a", upvotes=22),
        _edge("cohort1", "author_b", upvotes=15),
        _edge("cohort2", "author_b", upvotes=17),
    ]
    week1 = train_als(honest_edges, CONFIG)

    # Poisoning week: a heavy, one-directional sock -> author co-engagement
    # campaign (mirrors C1/C2 -- no reciprocal edge, so it would slip ring
    # detection) layered on top of the SAME honest edges, so the shared
    # (cohort, author) grid the gate measures on is directly comparable.
    poisoned_edges = [
        *honest_edges,
        *[_edge(f"sock{i}", "author_a", upvotes=200, reblogs=50) for i in range(30)],
        *[_edge(f"sock{i}", "author_b", upvotes=200, reblogs=50) for i in range(30)],
    ]
    week2_poisoned = train_als(poisoned_edges, CONFIG)

    drift = als_batch_drift(week2_poisoned, week1)
    assert drift > 0.0

    # A second, HONEST week (organic growth, no injected campaign) should
    # drift far less than the poisoned week from the same baseline -- the
    # gate should not be equally trigger-happy on ordinary week-to-week
    # change.
    honest_growth_edges = [
        *honest_edges,
        _edge("cohort1", "author_a", upvotes=3),
        _edge("cohort4", "author_b", upvotes=6),
    ]
    week2_honest = train_als(honest_growth_edges, CONFIG)
    honest_drift = als_batch_drift(week2_honest, week1)

    assert drift > honest_drift


def test_empty_edges_model_has_zero_drift_against_anything() -> None:
    edges = [_edge("u1", "author_a", upvotes=5)]
    trained = train_als(edges, CONFIG)
    empty = train_als([], CONFIG)
    assert als_batch_drift(trained, empty) == 0.0
    assert als_batch_drift(empty, trained) == 0.0
    assert als_batch_drift(empty, empty) == 0.0
