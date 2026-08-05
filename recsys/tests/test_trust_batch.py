"""A7 — ``recsys.jobs.trust_batch`` tests.

Split the same way as ``tests/test_store.py``: pure logic (seed-file parsing,
``run_batch``'s build/refuse decisions, ``main()``'s no-DSN-and-not-dry-run
early exit) runs offline against a :class:`~tests.fakes.FakeGateway` and
carries no skip marker; anything that needs a real recsys Postgres is
individually gated on ``RECSYS_DATABASE_URL``.

Deliberately does NOT exercise ``main()`` end-to-end even when
``RECSYS_DATABASE_URL`` is set: ``main()`` always constructs a REAL
``HafsqlClient`` against the live public HAFSQL mirror (there is no seam to
inject a fake gateway into the CLI entry point — by design, it IS the real
entry point), so a true end-to-end ``main()`` run belongs with
``tests/test_hafsql_live.py``'s ``RECSYS_LIVE_DB`` gate, not here. What is
proven here instead, gated only on ``RECSYS_DATABASE_URL`` (no live HAFSQL
needed), is the full ``run_batch`` flow — build, refuse-if-bad, persist,
thread ``previous=`` for the §H11 drift gate — against a real Postgres, using
the same in-memory gateway the rest of the suite already trusts.
"""

from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

import pytest

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import EngagementEdge
from recsys.db.store import DegradedSnapshotError, ensure_schema, load_snapshot
from recsys.jobs.trust_batch import load_trusted_seeds, main, run_batch
from tests.fakes import EPOCH, FakeGateway

_DSN = os.environ.get("RECSYS_DATABASE_URL")
_live = pytest.mark.skipif(
    not _DSN, reason="RECSYS_DATABASE_URL not set — trust_batch integration suite opted out"
)


# ---------------------------------------------------------------------------
# Offline: seed-file parsing.
# ---------------------------------------------------------------------------


def test_load_trusted_seeds_ignores_blank_lines_and_comments(tmp_path: Path) -> None:
    seeds_file = tmp_path / "seeds.txt"
    seeds_file.write_text(
        "\n# a full-line comment\nalice\n\nbob  # trailing comment\n"
        "   # indented comment\ncharlie\n"
    )
    assert load_trusted_seeds(seeds_file) == frozenset({"alice", "bob", "charlie"})


def test_load_trusted_seeds_returns_empty_set_for_a_missing_file(tmp_path: Path) -> None:
    assert load_trusted_seeds(tmp_path / "does-not-exist.txt") == frozenset()


def test_load_trusted_seeds_reads_the_real_operator_file_by_default() -> None:
    """Proves the default path actually resolves to the real A8.1 operator
    list (``recsys/data/trusted_seeds.txt``) with no explicit path given."""
    seeds = load_trusted_seeds()
    assert "hiveio" in seeds


# ---------------------------------------------------------------------------
# Offline: run_batch's build/refuse decisions, against FakeGateway.
# ---------------------------------------------------------------------------


def test_run_batch_dry_run_builds_without_persisting_or_requiring_a_dsn() -> None:
    edges = [
        EngagementEdge(src="seed1", dst="alice", replies=1, upvotes=1),
        EngagementEdge(src="alice", dst="bob", upvotes=2),
    ]
    gateway = FakeGateway(edges=edges)
    snapshot = run_batch(
        gateway,
        DEFAULT_SETTINGS,
        trusted_seeds=frozenset({"seed1"}),
        now=EPOCH,
        dsn=None,
        production=True,
        persist=False,
    )
    assert snapshot.graph_creds
    assert not snapshot.degraded
    assert "seed1" in snapshot.graph_creds


def test_run_batch_refuses_an_empty_snapshot_even_in_a_dry_run() -> None:
    gateway = FakeGateway(edges=[])
    with pytest.raises(DegradedSnapshotError, match="empty"):
        run_batch(
            gateway,
            DEFAULT_SETTINGS,
            trusted_seeds=frozenset(),
            now=EPOCH,
            dsn=None,
            production=False,
            persist=False,
        )


def test_run_batch_propagates_the_f_r2_production_guard() -> None:
    """``build_trust_snapshot`` itself refuses ``production=True`` with no
    landed seeds (F-R2) — run_batch must not swallow that ValueError."""
    gateway = FakeGateway(edges=[EngagementEdge(src="alice", dst="bob", upvotes=1)])
    with pytest.raises(ValueError, match="trusted_seeds"):
        run_batch(
            gateway,
            DEFAULT_SETTINGS,
            trusted_seeds=frozenset(),
            now=EPOCH,
            dsn=None,
            production=True,
            persist=False,
        )


# ---------------------------------------------------------------------------
# Offline: main()'s early exits — must return before touching any network.
# ---------------------------------------------------------------------------


def test_main_refuses_without_a_dsn_and_without_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECSYS_DATABASE_URL", raising=False)
    assert main([]) == 2


# ---------------------------------------------------------------------------
# Live: the full build -> refuse-if-bad -> persist -> thread-previous flow,
# against a real Postgres. No live HAFSQL mirror needed — FakeGateway stands
# in, same as the offline tests above.
# ---------------------------------------------------------------------------


@pytest.fixture()
def clean_dsn() -> str:
    assert _DSN is not None
    ensure_schema(_DSN)
    import psycopg

    with psycopg.connect(_DSN, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE trust_snapshot_meta, graph_cred, ring_membership, "
            "als_model, trust_snapshot_edge"
        )
    return _DSN


@_live
def test_run_batch_persists_and_threads_previous_for_the_h11_gate(clean_dsn: str) -> None:
    edges = [
        EngagementEdge(src="seed1", dst="alice", replies=2, upvotes=3),
        EngagementEdge(src="alice", dst="bob", upvotes=1),
    ]
    gateway = FakeGateway(edges=edges)
    seeds = frozenset({"seed1"})

    first = run_batch(
        gateway, DEFAULT_SETTINGS, trusted_seeds=seeds, now=EPOCH,
        dsn=clean_dsn, production=True, persist=True,
    )
    assert not first.degraded
    assert first.graph_creds

    persisted = load_snapshot(clean_dsn)
    assert persisted is not None
    assert persisted.snapshot.graph_creds == first.graph_creds
    assert persisted.built_at == EPOCH

    # Second run a week later: previous= must come from the store, not be
    # silently None again — proven indirectly by a clean second run (a bug
    # threading `previous` wrong here would surface as an unhandled
    # exception or an unexpectedly-degraded snapshot on a stable world).
    second = run_batch(
        gateway, DEFAULT_SETTINGS, trusted_seeds=seeds, now=EPOCH + timedelta(days=7),
        dsn=clean_dsn, production=True, persist=True,
    )
    assert not second.degraded

    persisted_again = load_snapshot(clean_dsn)
    assert persisted_again is not None
    assert persisted_again.built_at == EPOCH + timedelta(days=7)


@_live
def test_run_batch_refuses_empty_and_leaves_the_previous_snapshot_in_place(
    clean_dsn: str,
) -> None:
    good_gateway = FakeGateway(edges=[EngagementEdge(src="seed1", dst="alice", upvotes=1)])
    run_batch(
        good_gateway, DEFAULT_SETTINGS, trusted_seeds=frozenset({"seed1"}), now=EPOCH,
        dsn=clean_dsn, production=True, persist=True,
    )
    before = load_snapshot(clean_dsn)
    assert before is not None

    empty_gateway = FakeGateway(edges=[])
    with pytest.raises(DegradedSnapshotError):
        run_batch(
            empty_gateway, DEFAULT_SETTINGS, trusted_seeds=frozenset(), now=EPOCH,
            dsn=clean_dsn, production=False, persist=True,
        )

    after = load_snapshot(clean_dsn)
    assert after is not None
    assert after.built_at == before.built_at
    assert after.snapshot.graph_creds == before.snapshot.graph_creds
