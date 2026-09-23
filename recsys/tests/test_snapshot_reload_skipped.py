"""The trust snapshot must not be rebuilt every refresh when it has not changed.

★ 2026-09-23. `ServiceState`'s snapshot cache called `_load_snapshot_fixed`
every `snapshot_refresh_s` (10 min) and every call rebuilt the whole snapshot
from the recsys DB, although the batch that writes it runs weekly. Measured on
the local recsys DB (354,584 edges, 17,059 graph creds): one load is ~180 MB of
live Python objects. A leak-hunt harness running the real reload loop alongside
feed requests and the other background rebuilds climbed from 560 MB RSS to a
plateau of about 755 MB within about 40 reloads while the live Python heap
stayed at 183-193 MB (pymalloc arenas 399 -> 473 and glibc free lists 159 -> 208
MB: freed snapshot copies that were never returned), and held 397-409 MB over
150 refresh cycles when an unchanged snapshot is kept.

These tests drive the cache exactly as `ServiceState.build` wires it, with the
store faked, over a day of refreshes.

MUTANT: drop `current=snapshot_cache.value` from the builder in
`ServiceState.build` (or the stamp check in `_load_snapshot_fixed`).
`test_a_day_of_unchanged_refreshes_loads_the_snapshot_once` fails with 145 loads.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from recsys.contracts import GraphCred
from recsys.db.store import PersistedSnapshot
from recsys.pipeline import TrustSnapshot
from recsys.service import app as service_app

DSN = "postgresql://offline-test/recsys"  # never connected: the store is faked below
BUILT = datetime(2026, 9, 22, 22, 3, tzinfo=UTC)
SEEDS = frozenset({"seed-a", "seed-b"})


class _FakeStore:
    """Stands in for `recsys.db.store`: a version stamp plus a full load that is
    counted, each producing a NEW snapshot object as the real reader does."""

    def __init__(self) -> None:
        self.stamp: tuple[datetime, bool, frozenset[str]] | None = (BUILT, False, SEEDS)
        self.full_loads = 0
        self.include_edges_seen: list[bool] = []
        self.meta_error: Exception | None = None

    def load_snapshot_meta(self, dsn: str | None = None):  # type: ignore[no-untyped-def]
        if self.meta_error is not None:
            raise self.meta_error
        return self.stamp

    def load_snapshot(
        self, dsn: str | None = None, *, include_edges: bool = True
    ) -> PersistedSnapshot | None:
        self.full_loads += 1
        self.include_edges_seen.append(include_edges)
        if self.stamp is None:
            return None
        built_at, degraded, seeds = self.stamp
        snapshot = TrustSnapshot(
            graph_creds={"alice": GraphCred(account="alice", score=0.5, follow_follower_ratio=1.0)},
            degraded=degraded,
            trusted_seeds=seeds,
            built_at=built_at,
        )
        return PersistedSnapshot(snapshot=snapshot, built_at=built_at)


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> _FakeStore:
    fake = _FakeStore()
    monkeypatch.setattr(service_app.recsys_store, "load_snapshot_meta", fake.load_snapshot_meta)
    monkeypatch.setattr(service_app.recsys_store, "load_snapshot", fake.load_snapshot)
    return fake


def _snapshot_cache() -> service_app._TimerCache[TrustSnapshot | None]:
    """The snapshot cache exactly as production builds it (nothing is warmed or
    connected by `build`; only this cache is exercised)."""
    state = service_app.ServiceState.build(config=service_app.ServiceConfig(), recsys_dsn=DSN)
    return state.snapshot_cache


def test_a_day_of_unchanged_refreshes_loads_the_snapshot_once(store: _FakeStore) -> None:
    cache = _snapshot_cache()
    cache.warm()
    first = cache.value
    assert first is not None and first.built_at == BUILT
    # The service keeps edges in the database and reads them per viewer.
    assert store.include_edges_seen == [False]
    assert first.edges == () and first.edges_for is not None
    for _ in range(144):  # one day of 10-minute refreshes
        cache._rebuild()
    assert store.full_loads == 1, (
        f"the unchanged snapshot was rebuilt {store.full_loads} times in a day of refreshes"
    )
    assert cache.value is first


def test_a_new_batch_is_still_picked_up_on_the_next_refresh(store: _FakeStore) -> None:
    """CONTROL. A new batch (new built_at) is loaded and served."""
    cache = _snapshot_cache()
    cache.warm()
    first = cache.value
    store.stamp = (BUILT + timedelta(days=7), False, SEEDS)
    cache._rebuild()
    assert store.full_loads == 2
    assert cache.value is not first
    assert cache.value is not None and cache.value.built_at == BUILT + timedelta(days=7)


@pytest.mark.parametrize(
    "changed",
    [(BUILT, True, SEEDS), (BUILT, False, SEEDS | {"seed-c"})],
    ids=["degraded-flag", "trusted-seeds"],
)
def test_any_change_to_the_stamp_reloads(
    store: _FakeStore, changed: tuple[datetime, bool, frozenset[str]]
) -> None:
    """CONTROL. The stamp is all three meta fields, not built_at alone."""
    cache = _snapshot_cache()
    cache.warm()
    store.stamp = changed
    cache._rebuild()
    assert store.full_loads == 2
    assert cache.value is not None
    assert (cache.value.built_at, cache.value.degraded, cache.value.trusted_seeds) == changed


def test_a_deleted_snapshot_is_still_noticed(store: _FakeStore) -> None:
    """CONTROL. No stamp means no snapshot: the cache goes to None (FAIL_CLOSED
    then refuses), exactly as a full reload would have reported."""
    cache = _snapshot_cache()
    cache.warm()
    store.stamp = None
    cache._rebuild()
    assert cache.value is None


def test_an_unreachable_db_keeps_the_last_good_snapshot(store: _FakeStore) -> None:
    """CONTROL. A failing stamp read raises like a failing full load did, so
    `_TimerCache` keeps the last known-good value (its `_loop` catches it)."""
    cache = _snapshot_cache()
    cache.warm()
    first = cache.value
    store.meta_error = OSError("recsys DB unreachable")
    with pytest.raises(OSError):
        cache._rebuild()
    assert cache.value is first
