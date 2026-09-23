"""The serving path reads ONE viewer's edges on demand (2026-09-23).

The service used to hold every snapshot edge (355,156 on production, 133 MB of
the snapshot's 187 MB) and each feed build scanned all of them to keep the
requesting viewer's rows. It now leaves ``TrustSnapshot.edges`` empty and reads
the viewer's rows through ``TrustSnapshot.edges_for`` (the service's
``_ViewerEdgeSource``, backed by ``recsys.db.store.load_viewer_edges``).

What must hold:
- the viewer's affinity scores are IDENTICAL to the in-memory path;
- no other viewer's rows can reach this viewer's ranking, even from a faulty source;
- a failed read costs only this build's personalisation, never the feed;
- the per-viewer cache is keyed per viewer, bounded, and never caches a failure.
"""

from __future__ import annotations

import random
from datetime import timedelta

import pytest

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import Candidate, CandidateSource, EngagementEdge
from recsys.pipeline import TrustSnapshot, _viewer_affinity_lookup
from recsys.service import app as service_app
from tests.fakes import EPOCH, make_post, make_viewer

AUTHORS = tuple(f"author{i}" for i in range(12))
VIEWERS = ("me", "you", "them", "nobody")


def _random_edges(seed: int) -> tuple[EngagementEdge, ...]:
    rng = random.Random(seed)
    edges = []
    for src in VIEWERS[:3] + AUTHORS[:4]:
        for dst in rng.sample(AUTHORS + VIEWERS[:3], k=rng.randint(0, 9)):
            if dst == src:
                continue
            edges.append(
                EngagementEdge(
                    src=src,
                    dst=dst,
                    upvotes=rng.randint(0, 30),
                    replies=rng.randint(0, 6),
                    reblogs=rng.randint(0, 2),
                    last_interaction=EPOCH - timedelta(days=rng.randint(0, 300)),
                )
            )
    return tuple(edges)


def _scores(viewer: str, snap: TrustSnapshot) -> dict[str, float | None] | None:
    cands = [
        Candidate(post=make_post(a, f"p-{a}", tags=(f"t{i % 3}",)), source=CandidateSource.OON_INTEREST)
        for i, a in enumerate(AUTHORS)
    ]
    fn = _viewer_affinity_lookup(make_viewer(viewer), snap, DEFAULT_SETTINGS, EPOCH, cands)
    if fn is None:
        return None
    return {c.post.author: fn(c) for c in cands}


def _honest_source(edges: tuple[EngagementEdge, ...]):
    return lambda v: tuple(e for e in edges if e.src == v)


@pytest.mark.parametrize("seed", range(25))
def test_on_demand_scores_are_identical_to_the_in_memory_path(seed: int) -> None:
    edges = _random_edges(seed)
    in_memory = TrustSnapshot(edges=edges)
    on_demand = TrustSnapshot(edges_for=_honest_source(edges))
    for viewer in VIEWERS:
        assert _scores(viewer, on_demand) == _scores(viewer, in_memory), (seed, viewer)


def test_the_equivalence_check_compares_real_scores_not_empty_ones() -> None:
    # Guards the test above against passing on None == None: 70 of its 100
    # comparisons carry real per-author scores (measured when it was written).
    real = sum(
        1
        for seed in range(25)
        for viewer in VIEWERS
        if (r := _scores(viewer, TrustSnapshot(edges=_random_edges(seed)))) is not None
        and any(x is not None for x in r.values())
    )
    assert real >= 60


def test_rows_of_another_viewer_from_a_faulty_source_never_reach_this_viewer() -> None:
    edges = _random_edges(7)
    honest = _scores("me", TrustSnapshot(edges_for=_honest_source(edges)))
    # A broken source that returns EVERY viewer's rows for any request.
    leaky = _scores("me", TrustSnapshot(edges_for=lambda v: edges))
    assert leaky == honest
    # And one that returns only someone else's rows gives "me" no affinity at all.
    others_only = TrustSnapshot(edges_for=lambda v: tuple(e for e in edges if e.src == "you"))
    assert _scores("me", others_only) is None


def test_the_source_is_asked_for_the_requesting_viewer_only() -> None:
    asked: list[str] = []
    edges = _random_edges(3)

    def source(v: str) -> tuple[EngagementEdge, ...]:
        asked.append(v)
        return _honest_source(edges)(v)

    _scores("you", TrustSnapshot(edges_for=source))
    assert asked == ["you"]


def test_a_failing_source_costs_personalisation_not_the_feed(caplog: pytest.LogCaptureFixture) -> None:
    def broken(v: str) -> tuple[EngagementEdge, ...]:
        raise TimeoutError("lock timeout while a batch rewrites the table")

    assert _scores("me", TrustSnapshot(edges_for=broken)) is None
    assert any("could not read me's own edges" in r.getMessage() for r in caplog.records)


def test_the_disabled_channel_never_asks_the_source() -> None:
    from dataclasses import replace

    off = replace(DEFAULT_SETTINGS, weights=replace(DEFAULT_SETTINGS.weights, organic_viewer=0.0))

    def must_not_be_called(v: str) -> tuple[EngagementEdge, ...]:
        raise AssertionError("source read with the channel off")

    cands = [Candidate(post=make_post("author1", "p"), source=CandidateSource.OON_INTEREST)]
    snap = TrustSnapshot(edges_for=must_not_be_called)
    assert _viewer_affinity_lookup(make_viewer("me"), snap, off, EPOCH, cands) is None


# ── the service's per-viewer cache ──────────────────────────────────────────────


class _Store:
    def __init__(self, edges: tuple[EngagementEdge, ...]) -> None:
        self.edges = edges
        self.reads: list[str] = []
        self.fail_next = False

    def load_viewer_edges(self, dsn: str | None, viewer: str) -> tuple[EngagementEdge, ...]:
        self.reads.append(viewer)
        if self.fail_next:
            self.fail_next = False
            raise TimeoutError("statement timeout")
        return tuple(e for e in self.edges if e.src == viewer)


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> _Store:
    s = _Store(
        tuple(
            EngagementEdge(src=src, dst=dst, upvotes=3, last_interaction=EPOCH)
            for src in ("me", "you", "them")
            for dst in AUTHORS[:3]
        )
    )
    monkeypatch.setattr(service_app.recsys_store, "load_viewer_edges", s.load_viewer_edges)
    return s


def test_each_viewer_gets_only_their_own_rows_and_is_read_once(store: _Store) -> None:
    source = service_app._ViewerEdgeSource("postgresql://unused")
    for _ in range(3):
        for v in ("me", "you"):
            rows = source(v)
            assert rows and all(e.src == v for e in rows)
    assert store.reads == ["me", "you"]


def test_a_failed_read_is_not_cached(store: _Store) -> None:
    source = service_app._ViewerEdgeSource("postgresql://unused")
    store.fail_next = True
    with pytest.raises(TimeoutError):
        source("me")
    assert source("me")
    assert store.reads == ["me", "me"]


def test_the_cache_is_bounded(store: _Store) -> None:
    source = service_app._ViewerEdgeSource("postgresql://unused", max_entries=2)
    for v in ("me", "you", "them", "me"):
        source(v)
    assert len(source._entries) == 2
    assert store.reads == ["me", "you", "them", "me"]
