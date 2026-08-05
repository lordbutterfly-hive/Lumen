"""A6 — ``recsys.db.store`` persistence tests.

Two groups, deliberately split by whether they need a real database:

* The write-time REFUSAL checks in ``save_snapshot`` run before any
  connection is opened, so they are provable with no database at all — those
  tests carry no skip marker and run in the default offline ``pytest -q``.
* Everything else needs a real recsys Postgres and is individually decorated
  with ``@_live`` (skipped, not failed, when ``RECSYS_DATABASE_URL`` is
  unset) — the same posture as ``tests/test_hafsql_live.py``, but per-test
  rather than module-wide, precisely so the offline group above stays in the
  default suite instead of being skipped along with everything else.

THE ACCEPTANCE BAR (A6): round-trip fidelity, field by field, not merely
"reloaded object is non-empty". ``test_round_trip_preserves_every_field``
covers every ``TrustSnapshot`` field directly; the trap ``schema.sql``
documents — a schema that drops ``GraphCred.outside_engagers`` collapses the
vouched set from a real snapshot's ~145 accounts to just its ~12 seeds, with
nothing logged (``_trust_is_fresh`` only checks present/not-degraded/
non-empty) — gets its own dedicated proof,
``test_round_trip_preserves_the_vouched_set_after_seed_anchored_propagation``,
which re-runs the REAL pipeline function (``_voter_trust_from_creds``) on the
graph-creds before and after a round trip and asserts the two vouched SETS
are identical, not just that the reloaded dict has entries.
"""

from __future__ import annotations

import os
from dataclasses import replace
from datetime import UTC, datetime

import numpy as np
import pytest

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import EngagementEdge, GraphCred
from recsys.core.als import ALSModel
from recsys.db.store import (
    DegradedSnapshotError,
    ensure_schema,
    load_snapshot,
    save_snapshot,
)
from recsys.pipeline import TrustSnapshot, _voter_trust_from_creds

_DSN = os.environ.get("RECSYS_DATABASE_URL")
_UNREACHABLE_DSN = "postgresql://unreachable-host-does-not-exist.invalid/x"
_live = pytest.mark.skipif(
    not _DSN,
    reason="RECSYS_DATABASE_URL not set — persistence suite opted out (offline by default)",
)


def _rich_snapshot() -> TrustSnapshot:
    """A deliberately non-trivial snapshot: multiple GraphCred rows (with and
    without outside_engagers), a multi-account ring, a real-shaped (non-zero,
    non-symmetric) ALS model, and engagement edges exercising every field
    including a ``None`` and a non-``None`` ``last_interaction``."""
    graph_creds = {
        "seed1": GraphCred(
            account="seed1", score=1.0, follow_follower_ratio=1.0,
            outside_engaged=False, outside_engagers=frozenset(),
        ),
        "seed2": GraphCred(
            account="seed2", score=0.95, follow_follower_ratio=0.8,
            outside_engaged=True, outside_engagers=frozenset({"honest1"}),
        ),
        "honest1": GraphCred(
            account="honest1", score=0.6, follow_follower_ratio=1.2,
            outside_engaged=True, outside_engagers=frozenset({"seed1", "seed2"}),
        ),
        "honest2": GraphCred(
            account="honest2", score=0.3, follow_follower_ratio=2.5,
            outside_engaged=True, outside_engagers=frozenset({"honest1"}),
        ),
        "sockA": GraphCred(
            account="sockA", score=0.1, follow_follower_ratio=1.0,
            outside_engaged=True, outside_engagers=frozenset({"sockB"}),
        ),
        "sockB": GraphCred(
            account="sockB", score=0.1, follow_follower_ratio=1.0,
            outside_engaged=True, outside_engagers=frozenset({"sockA"}),
        ),
        "zeroed": GraphCred(
            account="zeroed", score=0.0, follow_follower_ratio=1.0,
            outside_engaged=False, outside_engagers=frozenset(),
        ),
    }
    als = ALSModel(
        user_factors=np.array(
            [[0.1, -0.2, 0.3, 0.0], [1.5, 2.5, -3.5, 4.5], [-0.001, 0.002, 100.25, -7.75]],
            dtype=np.float64,
        ),
        item_factors=np.array([[0.9, 0.8, 0.7, 0.6], [-1.1, -2.2, -3.3, -4.4]], dtype=np.float64),
        user_index={"seed1": 0, "honest1": 1, "honest2": 2},
        item_index={"authorX": 0, "authorY": 1},
    )
    edges = (
        EngagementEdge(
            src="seed1", dst="honest1", replies=3, reply_backs=1, upvotes=5, reblogs=0,
            mentions=2, profile_visits=7, post_opens=11, revisits=1, dwell_seconds=42.5,
            last_interaction=datetime(2026, 7, 1, 12, 30, tzinfo=UTC),
        ),
        EngagementEdge(
            src="honest1", dst="honest2", replies=0, reply_backs=0, upvotes=1, reblogs=1,
            mentions=0, profile_visits=0, post_opens=0, revisits=0, dwell_seconds=0.0,
            last_interaction=None,
        ),
        EngagementEdge(
            src="sockA", dst="sockB", replies=1, reply_backs=1, upvotes=0, reblogs=0,
            mentions=0, profile_visits=0, post_opens=0, revisits=0, dwell_seconds=3.25,
            last_interaction=datetime(2026, 1, 1, tzinfo=UTC),
        ),
    )
    return TrustSnapshot(
        graph_creds=graph_creds,
        ring_members=frozenset({"sockA", "sockB"}),
        als=als,
        degraded=False,
        edges=edges,
        trusted_seeds=frozenset({"seed1", "seed2"}),
    )


# ---------------------------------------------------------------------------
# Offline: save_snapshot's refusal checks run BEFORE any connection is
# opened, so these are provable with no database, no psycopg call, nothing.
# ---------------------------------------------------------------------------


def test_save_snapshot_refuses_a_degraded_snapshot_before_connecting() -> None:
    snapshot = replace(_rich_snapshot(), degraded=True)
    with pytest.raises(DegradedSnapshotError, match="degraded"):
        save_snapshot(snapshot, built_at=datetime.now(UTC), dsn=_UNREACHABLE_DSN)


def test_save_snapshot_refuses_an_empty_snapshot_before_connecting() -> None:
    snapshot = TrustSnapshot(graph_creds={})
    with pytest.raises(DegradedSnapshotError, match="empty"):
        save_snapshot(snapshot, built_at=datetime.now(UTC), dsn=_UNREACHABLE_DSN)


def test_no_dsn_raises_a_clear_runtime_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECSYS_DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="RECSYS_DATABASE_URL"):
        load_snapshot(dsn=None)


# ---------------------------------------------------------------------------
# Live: everything below needs a real recsys Postgres.
# ---------------------------------------------------------------------------


@pytest.fixture()
def dsn() -> str:
    assert _DSN is not None  # narrows for mypy/type-checkers; @_live already gated the caller
    return _DSN


@pytest.fixture()
def clean_store(dsn: str) -> str:
    """A schema-applied, empty store — isolates each live test from the last."""
    ensure_schema(dsn)
    import psycopg

    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE trust_snapshot_meta, graph_cred, ring_membership, "
            "als_model, trust_snapshot_edge"
        )
    return dsn


@_live
def test_ensure_schema_is_idempotent(dsn: str) -> None:
    ensure_schema(dsn)
    ensure_schema(dsn)


@_live
def test_load_snapshot_returns_none_when_nothing_persisted(clean_store: str) -> None:
    assert load_snapshot(clean_store) is None


@_live
def test_round_trip_preserves_every_field(clean_store: str) -> None:
    original = _rich_snapshot()
    built_at = datetime(2026, 8, 4, 9, 0, 0, tzinfo=UTC)
    save_snapshot(original, built_at=built_at, dsn=clean_store)

    persisted = load_snapshot(clean_store)
    assert persisted is not None
    # ★ built_at must land on the DATACLASS, not only on the wrapper. This
    # module predates `TrustSnapshot.built_at`; A8.3 added it concurrently, and
    # in between, a snapshot loaded from the database arrived with None — which
    # `_trust_is_fresh` treats as FRESH, so a months-old snapshot served
    # silently as current. Asserting only `persisted.built_at` would miss it:
    # the wrapper's copy was never the broken one.
    assert persisted.snapshot.built_at == built_at, (
        "load_snapshot populated the wrapper but not the dataclass — stale "
        "snapshots will be served as fresh"
    )
    assert persisted.built_at == built_at

    reloaded = persisted.snapshot
    assert reloaded.graph_creds == original.graph_creds, (
        "GraphCred round trip must be exact, including outside_engagers SETS "
        "(the field schema.sql documents as the actual trap) — not just "
        "outside_engaged booleans"
    )
    assert reloaded.ring_members == original.ring_members
    assert reloaded.trusted_seeds == original.trusted_seeds
    assert reloaded.degraded == original.degraded

    assert original.als is not None
    assert reloaded.als is not None
    assert reloaded.als.user_index == original.als.user_index
    assert reloaded.als.item_index == original.als.item_index
    assert reloaded.als.user_factors.dtype == np.float64
    assert reloaded.als.item_factors.dtype == np.float64
    assert np.array_equal(reloaded.als.user_factors, original.als.user_factors)
    assert np.array_equal(reloaded.als.item_factors, original.als.item_factors)
    # Byte-identical, not just numerically close: scoring against the
    # reloaded model must match a never-persisted one exactly.
    assert reloaded.als.affinity("seed1", "authorX") == original.als.affinity("seed1", "authorX")

    original_by_pair = {(e.src, e.dst): e for e in original.edges}
    reloaded_by_pair = {(e.src, e.dst): e for e in reloaded.edges}
    assert reloaded_by_pair == original_by_pair, (
        "every EngagementEdge field (incl. dwell_seconds, and last_interaction "
        "both None and non-None) must round-trip exactly"
    )


@_live
def test_round_trip_preserves_als_none(clean_store: str) -> None:
    """``als=None`` means 'no model this batch' (e.g. the §H11 drift gate
    disabled it) — a real, distinct state from a zero-row trained model."""
    snapshot = replace(_rich_snapshot(), als=None)
    save_snapshot(snapshot, built_at=datetime.now(UTC), dsn=clean_store)
    persisted = load_snapshot(clean_store)
    assert persisted is not None
    assert persisted.snapshot.als is None


@_live
def test_round_trip_preserves_a_zero_row_als_model(clean_store: str) -> None:
    empty_als = ALSModel(
        user_factors=np.zeros((0, 32), dtype=np.float64),
        item_factors=np.zeros((0, 32), dtype=np.float64),
        user_index={},
        item_index={},
    )
    snapshot = replace(_rich_snapshot(), als=empty_als)
    save_snapshot(snapshot, built_at=datetime.now(UTC), dsn=clean_store)
    persisted = load_snapshot(clean_store)
    assert persisted is not None
    assert persisted.snapshot.als is not None
    assert persisted.snapshot.als.user_factors.shape == (0, 32)
    assert persisted.snapshot.als.item_factors.shape == (0, 32)
    assert persisted.snapshot.als.user_index == {}
    assert persisted.snapshot.als.item_index == {}


@_live
def test_round_trip_preserves_empty_edges_and_empty_ring_members(clean_store: str) -> None:
    snapshot = replace(_rich_snapshot(), edges=(), ring_members=frozenset())
    save_snapshot(snapshot, built_at=datetime.now(UTC), dsn=clean_store)
    persisted = load_snapshot(clean_store)
    assert persisted is not None
    assert persisted.snapshot.edges == ()
    assert persisted.snapshot.ring_members == frozenset()


@_live
def test_save_snapshot_never_overwrites_a_good_snapshot_with_a_degraded_one(
    clean_store: str,
) -> None:
    good = _rich_snapshot()
    built_at = datetime(2026, 8, 1, tzinfo=UTC)
    save_snapshot(good, built_at=built_at, dsn=clean_store)

    bad = replace(good, degraded=True)
    with pytest.raises(DegradedSnapshotError):
        save_snapshot(bad, built_at=datetime(2026, 8, 8, tzinfo=UTC), dsn=clean_store)

    persisted = load_snapshot(clean_store)
    assert persisted is not None
    assert persisted.built_at == built_at, "a refused write must not touch the stored snapshot"
    assert persisted.snapshot.degraded is False
    assert persisted.snapshot.graph_creds == good.graph_creds


@_live
def test_save_snapshot_never_overwrites_a_good_snapshot_with_an_empty_one(
    clean_store: str,
) -> None:
    good = _rich_snapshot()
    built_at = datetime(2026, 8, 1, tzinfo=UTC)
    save_snapshot(good, built_at=built_at, dsn=clean_store)

    empty = TrustSnapshot(graph_creds={})
    with pytest.raises(DegradedSnapshotError):
        save_snapshot(empty, built_at=datetime(2026, 8, 8, tzinfo=UTC), dsn=clean_store)

    persisted = load_snapshot(clean_store)
    assert persisted is not None
    assert persisted.built_at == built_at
    assert persisted.snapshot.graph_creds == good.graph_creds


@_live
def test_round_trip_preserves_the_vouched_set_after_seed_anchored_propagation(
    clean_store: str,
) -> None:
    """THE trap schema.sql documents, proven with the real pipeline function.

    Builds a seed -> 3-hop chain of honest accounts (vouch_max_rounds default
    is 3, so this genuinely exercises propagation depth, not seed-echoing)
    plus a closed directed sock cycle touching no seed (must stay unvouched).
    Runs ``_voter_trust_from_creds`` on the graph-creds BEFORE persistence and
    AGAIN on the reloaded graph-creds AFTER a round trip, and asserts the two
    VOUCHED SETS are identical. A store that silently dropped
    ``outside_engagers`` would collapse the reloaded vouched set down to just
    the 3 seeds — exactly the 145 -> 12 collapse measured on the harness
    world and documented in schema.sql.
    """
    seeds = [f"seed{i}" for i in range(3)]
    graph_creds: dict[str, GraphCred] = {
        s: GraphCred(
            account=s, score=1.0, follow_follower_ratio=1.0,
            outside_engaged=False, outside_engagers=frozenset(),
        )
        for s in seeds
    }
    honest_accounts: list[str] = []
    for i, seed in enumerate(seeds):
        prev = seed
        for hop in range(3):
            name = f"honest_{i}_{hop}"
            graph_creds[name] = GraphCred(
                account=name, score=0.5, follow_follower_ratio=1.0,
                outside_engaged=True, outside_engagers=frozenset({prev}),
            )
            honest_accounts.append(name)
            prev = name
    # A closed directed cycle reaching no seed — must stay unvouched, before
    # AND after, or the round trip has (re)opened the directed-cycle hole
    # test_vouch_anchoring.py separately guards against.
    for i in range(3):
        graph_creds[f"sockring_{i}"] = GraphCred(
            account=f"sockring_{i}", score=0.4, follow_follower_ratio=1.0,
            outside_engaged=True, outside_engagers=frozenset({f"sockring_{(i - 1) % 3}"}),
        )

    trusted_seeds = frozenset(seeds)
    original = TrustSnapshot(graph_creds=graph_creds, trusted_seeds=trusted_seeds)

    trust_before = _voter_trust_from_creds(original.graph_creds, DEFAULT_SETTINGS, trusted_seeds)
    assert trust_before is not None
    assert set(honest_accounts) <= trust_before.vouched, (
        "fixture is broken: the honest chain was not vouched BEFORE persistence"
    )
    assert not ({"sockring_0", "sockring_1", "sockring_2"} & trust_before.vouched), (
        "fixture is broken: the closed cycle vouched itself BEFORE persistence"
    )

    save_snapshot(original, built_at=datetime.now(UTC), dsn=clean_store)
    persisted = load_snapshot(clean_store)
    assert persisted is not None

    trust_after = _voter_trust_from_creds(
        persisted.snapshot.graph_creds, DEFAULT_SETTINGS, persisted.snapshot.trusted_seeds
    )
    assert trust_after is not None

    assert trust_after.vouched == trust_before.vouched, (
        f"THE TRAP: vouched set changed across a persistence round trip — "
        f"before={sorted(trust_before.vouched)}, after={sorted(trust_after.vouched)}. "
        "This is the 145 -> 12 collapse schema.sql warns about: a reload that "
        "lost GraphCred.outside_engagers vouches only the seeds."
    )
    assert len(trust_after.vouched) > len(trusted_seeds), (
        "vouched set collapsed to exactly the seeds after reload — "
        "outside_engagers did not survive the round trip"
    )
    assert not ({"sockring_0", "sockring_1", "sockring_2"} & trust_after.vouched), (
        "the closed cycle became vouched AFTER the round trip — the "
        "directed-cycle hardening silently reverted"
    )


def test_trust_is_fresh_refuses_a_stale_built_at() -> None:
    """★ REGRESSION PIN for a concurrent-build seam (2026-08-04).

    `store.py` predates `TrustSnapshot.built_at` and carried the timestamp only
    in `PersistedSnapshot`. A8.3 then added the dataclass field. Between the two,
    `load_snapshot(...).snapshot.built_at` was None — and `_trust_is_fresh`
    treats None as fresh, so a months-old snapshot loaded from the database was
    served as current, silently.

    SCOPE, stated because I got this wrong first: this test pins
    `_trust_is_fresh`'s HALF of the contract — that a stale stamp is actually
    refused. It builds the snapshot directly, so it does NOT pin the load path;
    I mutation-checked it by removing `built_at=built_at` from
    `load_snapshot` and it still passed. The load half is pinned inside the
    live round-trip test below, which is the only place a real
    `load_snapshot` runs.
    """
    from datetime import UTC, datetime, timedelta

    from recsys.pipeline import TrustSnapshot, _trust_is_fresh

    now = datetime(2026, 8, 4, tzinfo=UTC)
    creds = {
        "a": GraphCred(
            account="a", score=0.5, follow_follower_ratio=1.0,
            outside_engaged=True, outside_engagers=frozenset({"b"}),
        )
    }

    fresh = TrustSnapshot(graph_creds=creds, built_at=now - timedelta(days=1))
    stale = TrustSnapshot(graph_creds=creds, built_at=now - timedelta(days=90))

    assert _trust_is_fresh(fresh, now=now, max_age_days=14) is True
    assert _trust_is_fresh(stale, now=now, max_age_days=14) is False, (
        "a 90-day-old snapshot was accepted as fresh — the load path is not "
        "carrying built_at onto the dataclass"
    )
