"""A6 — ``TrustSnapshot`` persistence against recsys's own Postgres.

WHY THIS FILE EXISTS. ``recsys.pipeline.TrustSnapshot`` is produced once a
week by ``build_trust_snapshot`` and lives only in the process that built it —
``recsys/db/schema.sql`` had tables shaped for it (``graph_cred``,
``ring_membership``) but ``grep -rniE "insert into|update .* set" recsys/``
returned nothing: nothing anywhere wrote them. So the weekly batch's output
could never reach a serving process. This module is the writer and the
reader.

ROUND-TRIP FIDELITY IS THE WHOLE POINT, NOT A NICE-TO-HAVE. ``schema.sql``
(read it — lines above the tables added for this unit) documents its own
near-miss: a schema that persists ``GraphCred.outside_engaged`` but not the
SET behind it, ``GraphCred.outside_engagers``, round-trips every reloaded
cred's vouch evidence to empty. Seed-anchored vouch propagation
(``recsys.pipeline._voter_trust_from_creds``) walks that set, so on the
180-account harness world the loss collapsed the vouched tier from 145
accounts to exactly the 12 trusted seeds — 133 honest accounts silently
demoted to unknown-tier breadth, 51.5% of served top-20 slots changed, and
NOTHING logged: ``_trust_is_fresh`` only checks present / not-degraded /
non-empty, so a snapshot that lost a field partway through the schema still
reads as fresh. ``tests/test_store.py`` proves this specific trap cannot
recur: it round-trips a snapshot through this module and re-runs the real
``_voter_trust_from_creds`` on both the original and the reloaded
``graph_creds``, asserting the two VOUCHED SETS are identical — not merely
that the reloaded object is "non-empty".

WHAT IS PERSISTED, FIELD BY FIELD (``TrustSnapshot`` has 6 fields):

* ``graph_creds`` — the pre-existing ``graph_cred`` table (schema.sql), all
  5 ``GraphCred`` fields including ``outside_engagers``.
* ``ring_members`` — reuses the pre-existing ``ring_membership`` table's
  ``account`` column. ``TrustSnapshot`` carries only the flagged SET (no
  per-account ``ring_score``/``ring_id``), so those two NOT-NULL columns are
  written with a neutral placeholder (``ring_score = 0.0``, ``ring_id =
  NULL``) and simply ignored on load. Nothing round-trips through them that
  ``TrustSnapshot`` ever had — not a lossy reuse.
* ``als`` — new ``als_model`` table. Persisted IN FULL, deliberately
  disagreeing with the buildmap note that suggested "recompute on load, CF is
  inert until the first batch": ``ALSConfig.cf_weight`` defaults to 1.5 (a
  GATE, not a magnitude — any positive value turns CF on,
  ``pipeline._score``/``viewer_affinity_percentiles``) and is a LIVE input to
  every served request's 80% organic term today. Dropping it on reload would
  silently turn off a currently-active scoring signal for every request
  served from a persisted snapshot — the same silent-degradation shape the
  ``outside_engagers`` trap above describes, just for CF instead of the vouch
  gate. It is also small (factor matrices, not raw edges), so there is no
  operational-cost reason to skip it the way there is for ``edges`` below.
* ``edges`` — new ``trust_snapshot_edge`` table. UNLIKE ``als``, this one
  genuinely IS inert at serving time today: its only consumer,
  ``pipeline._viewer_affinity_lookup``, short-circuits on
  ``settings.weights.organic_viewer <= 0.0``, and that weight defaults to
  ``0.0``. Persisted anyway, in full, because A6's acceptance bar is
  round-trip fidelity of the dataclass, not "whatever happens to be live
  right now" — see the ``trust_snapshot_edge`` table comment in schema.sql
  for the storage-cost caveat this decision creates (a full ``trust_days``
  window can be tens of millions of rows) and the one-line reversal path if
  an operator decides the cost isn't worth it.
* ``degraded`` — ``trust_snapshot_meta.degraded``. Also enforced as a
  write-time REFUSAL below (see ``save_snapshot``) — a degraded snapshot is
  never allowed to overwrite a good one, so in steady state this column
  should never actually read ``true`` on load; it exists so a direct SQL
  inspection can tell the two "missing" states apart (never persisted vs.
  persisted-degraded-because-someone-forced-it, e.g. via manual SQL).
* ``trusted_seeds`` — ``trust_snapshot_meta.trusted_seeds``.

``built_at`` — the field `_trust_is_fresh` needs to refuse a stale snapshot.

★ HISTORY, because the seam matters: this module was written when
``TrustSnapshot`` had NO ``built_at`` field, so it carried the timestamp
alongside in :class:`PersistedSnapshot`. A8.3 added the field to the dataclass
concurrently, and for a window ``load_snapshot`` populated only the wrapper —
so a snapshot read back from the database arrived with ``built_at=None``,
which ``_trust_is_fresh`` treats as fresh, and a months-old snapshot served
silently as current. Both are populated now. Keep it that way: two correct
changes either side of a seam produced the exact defect one of them existed to
prevent. Callers may read either — :attr:`PersistedSnapshot.built_at` is the
authoritative value and existing readers of it are unchanged.

SINGLETON, NOT VERSIONED. Every table this module writes holds only the
LATEST snapshot — the one a serving process should load right now. The
weekly batch (``recsys/jobs/trust_batch.py``) reads the current row(s) as
``previous=`` BEFORE ``save_snapshot`` overwrites them, so the §H11
between-batch ALS-drift gate always has a real prior model to compare
against. ``save_snapshot`` REFUSES (raises :class:`DegradedSnapshotError`)
rather than overwrite a good snapshot with a degraded or empty one — "a bad
snapshot written over a good one is worse than no run" (A7's own framing).

DSN / DRIVER. ``RECSYS_DATABASE_URL`` — the SAME environment variable
``recsys/io/hafsql.py`` already reads for its own (A15) second connection to
this same database, so both modules agree on where "the recsys DB" is
without a shared config object. ``recsys/config.py`` is owned by another
workstream this phase, so there is no ``RecsysDbConfig`` yet (see that
module's own docstring, which records the same deferral); when one lands,
thread its DSN through the ``dsn`` kwarg here rather than changing this
module's env-reading. Importing this module never requires ``psycopg`` —
lazily imported inside the functions that actually connect, mirroring
``recsys.io.hafsql``'s own discipline, so the pure scoring core stays
importable without the ``io`` extra installed.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from recsys.contracts import EngagementEdge, GraphCred
from recsys.core.als import ALSModel
from recsys.pipeline import TrustSnapshot

if TYPE_CHECKING:
    import psycopg

logger = logging.getLogger("recsys.db.store")

# Same env var recsys/io/hafsql.py reads for its own (A15) recsys-DB
# connection — see this module's docstring.
_RECSYS_DSN_ENV = "RECSYS_DATABASE_URL"
_SCHEMA_PATH = Path(__file__).with_name("schema.sql")


class DegradedSnapshotError(RuntimeError):
    """``save_snapshot`` refused to write: the snapshot is ``degraded`` or has
    empty ``graph_creds``. Persisting either would overwrite whatever good
    snapshot is currently live with one that silently fails every Sybil
    defense the instant it is loaded (see ``pipeline._trust_is_fresh``) — "a
    bad snapshot written over a good one is worse than no run"."""


@dataclass(frozen=True)
class PersistedSnapshot:
    """A loaded ``TrustSnapshot`` plus its ``built_at`` timestamp.

    ``TrustSnapshot`` now carries ``built_at`` itself (A8.3) and
    ``load_snapshot`` populates BOTH — see the module docstring for why the
    seam between those two changes briefly reintroduced stale-snapshot
    serving. This wrapper remains the authoritative value."""

    snapshot: TrustSnapshot
    built_at: datetime


def _resolve_dsn(dsn: str | None) -> str:
    resolved = dsn if dsn is not None else os.environ.get(_RECSYS_DSN_ENV)
    if not resolved:
        raise RuntimeError(
            f"recsys.db.store: no DSN — pass dsn= explicitly or set {_RECSYS_DSN_ENV}. "
            "This is the recsys DB (trust snapshots), not the read-only HAFSQL mirror."
        )
    return resolved


def _connect(dsn: str) -> psycopg.Connection[Any]:
    """Open a connection to the recsys DB. ``psycopg`` is imported lazily so
    this module stays importable without the driver installed (mirrors
    ``recsys.io.hafsql._connect``)."""
    import psycopg

    return psycopg.connect(dsn, autocommit=False)


def ensure_schema(dsn: str | None = None) -> None:
    """Apply ``db/schema.sql`` — every statement is ``CREATE ... IF NOT
    EXISTS``, so this is idempotent and safe to call on every batch run.
    Phase-0 has no separate migration tool; this is the sanctioned
    stand-in until one exists."""
    resolved = _resolve_dsn(dsn)
    sql = _SCHEMA_PATH.read_text()
    conn = _connect(resolved)
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def save_snapshot(
    snapshot: TrustSnapshot,
    *,
    built_at: datetime,
    dsn: str | None = None,
) -> None:
    """Persist ``snapshot`` as THE current trust snapshot, replacing whatever
    was there before, in one transaction (all tables commit together or none
    do).

    Refuses — before opening any connection — when ``snapshot.degraded`` or
    ``snapshot.graph_creds`` is empty. Both checks run first specifically so
    this refusal is provable without a database: a caller can assert
    :class:`DegradedSnapshotError` from a bad snapshot with no DSN configured
    at all.
    """
    if snapshot.degraded:
        raise DegradedSnapshotError(
            "save_snapshot: refusing — snapshot.degraded is True (the §H11 "
            "between-batch ALS-drift gate flagged it, or a caller built one "
            "directly). Persisting it would overwrite the last good snapshot "
            "with a known-bad one; investigate before forcing a write."
        )
    if not snapshot.graph_creds:
        raise DegradedSnapshotError(
            "save_snapshot: refusing — snapshot.graph_creds is empty. A "
            "snapshot in this state silently reverts every Sybil defense the "
            "moment it is loaded (pipeline._trust_is_fresh treats it as "
            "fresh-but-empty), so persisting it would overwrite a good "
            "snapshot with an unusable one."
        )

    resolved = _resolve_dsn(dsn)
    conn = _connect(resolved)
    try:
        with conn.cursor() as cur:
            _write_meta(cur, built_at, snapshot.degraded, snapshot.trusted_seeds)
            _write_graph_creds(cur, snapshot.graph_creds)
            _write_ring_members(cur, snapshot.ring_members)
            _write_als(cur, snapshot.als)
            _write_edges(cur, snapshot.edges)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    logger.info(
        "save_snapshot: persisted %d graph_creds, %d ring_members, %d edges, "
        "als=%s, %d trusted_seeds, built_at=%s",
        len(snapshot.graph_creds),
        len(snapshot.ring_members),
        len(snapshot.edges),
        "trained" if snapshot.als is not None else "none",
        len(snapshot.trusted_seeds),
        built_at.isoformat(),
    )


def load_snapshot(dsn: str | None = None) -> PersistedSnapshot | None:
    """Load the current trust snapshot, or ``None`` if nothing has ever been
    persisted (a first-ever deploy, or a store that hasn't seen a batch run
    yet — a real, expected state, not an error)."""
    resolved = _resolve_dsn(dsn)
    conn = _connect(resolved)
    try:
        with conn.cursor() as cur:
            meta = _read_meta(cur)
            if meta is None:
                return None
            built_at, degraded, trusted_seeds = meta
            graph_creds = _read_graph_creds(cur)
            ring_members = _read_ring_members(cur)
            als = _read_als(cur)
            edges = _read_edges(cur)
        conn.commit()
    finally:
        conn.close()

    snapshot = TrustSnapshot(
        graph_creds=graph_creds,
        ring_members=ring_members,
        als=als,
        degraded=degraded,
        edges=edges,
        trusted_seeds=trusted_seeds,
        # ★★ POPULATE IT ON THE DATACLASS TOO (fixed 2026-08-04). This module was
        # written when `TrustSnapshot` had no `built_at` field and deliberately
        # carried the timestamp alongside, in `PersistedSnapshot`. A8.3 then added
        # the field concurrently — and the seam between those two correct pieces
        # of work reintroduced the exact defect A8.3 exists to close.
        #
        # `_trust_is_fresh` treats `built_at=None` as fresh (so that existing
        # fixtures do not regress), so a snapshot loaded from the database
        # arrived with None and **a months-old snapshot served as fresh** —
        # silently, which is the failure mode staleness checking is for. Anyone
        # using the natural `load_snapshot(...).snapshot` got no staleness
        # protection at all.
        #
        # `PersistedSnapshot.built_at` is kept as well: it is the authoritative
        # value, and callers that already read it keep working unchanged.
        built_at=built_at,
    )
    return PersistedSnapshot(snapshot=snapshot, built_at=built_at)


# ---------------------------------------------------------------------------
# Writers — each owns exactly one table, called inside ONE transaction/cursor
# from save_snapshot so a partial failure rolls back everything, never a
# half-updated snapshot.
# ---------------------------------------------------------------------------


def _write_meta(
    cur: psycopg.Cursor[Any],
    built_at: datetime,
    degraded: bool,
    trusted_seeds: frozenset[str],
) -> None:
    cur.execute(
        """
        INSERT INTO trust_snapshot_meta (id, built_at, degraded, trusted_seeds)
        VALUES (1, %(built_at)s, %(degraded)s, %(trusted_seeds)s)
        ON CONFLICT (id) DO UPDATE SET
            built_at = EXCLUDED.built_at,
            degraded = EXCLUDED.degraded,
            trusted_seeds = EXCLUDED.trusted_seeds
        """,
        {
            "built_at": built_at,
            "degraded": degraded,
            "trusted_seeds": sorted(trusted_seeds),
        },
    )


def _write_graph_creds(cur: psycopg.Cursor[Any], graph_creds: Mapping[str, GraphCred]) -> None:
    cur.execute("TRUNCATE graph_cred")
    if not graph_creds:
        return
    with cur.copy(
        "COPY graph_cred (account, score, follow_follower_ratio, outside_engaged, "
        "outside_engagers) FROM STDIN"
    ) as copy:
        for gc in graph_creds.values():
            copy.write_row(
                (
                    gc.account,
                    gc.score,
                    gc.follow_follower_ratio,
                    gc.outside_engaged,
                    sorted(gc.outside_engagers),
                )
            )


def _write_ring_members(cur: psycopg.Cursor[Any], ring_members: frozenset[str]) -> None:
    cur.execute("TRUNCATE ring_membership")
    if not ring_members:
        return
    # ring_score/ring_id: neutral placeholders. TrustSnapshot never carried
    # per-account values for either — see the module docstring.
    with cur.copy("COPY ring_membership (account, ring_score, ring_id) FROM STDIN") as copy:
        for account in sorted(ring_members):
            copy.write_row((account, 0.0, None))


def _write_als(cur: psycopg.Cursor[Any], als: ALSModel | None) -> None:
    import psycopg.types.json

    cur.execute("DELETE FROM als_model")
    if als is None:
        return
    k = int(als.user_factors.shape[1])
    user_bytes = np.ascontiguousarray(als.user_factors, dtype=np.float64).tobytes()
    item_bytes = np.ascontiguousarray(als.item_factors, dtype=np.float64).tobytes()
    cur.execute(
        """
        INSERT INTO als_model (id, factors_k, user_factors, item_factors, user_index, item_index)
        VALUES (1, %(k)s, %(user_factors)s, %(item_factors)s, %(user_index)s, %(item_index)s)
        ON CONFLICT (id) DO UPDATE SET
            factors_k = EXCLUDED.factors_k,
            user_factors = EXCLUDED.user_factors,
            item_factors = EXCLUDED.item_factors,
            user_index = EXCLUDED.user_index,
            item_index = EXCLUDED.item_index
        """,
        {
            "k": k,
            "user_factors": user_bytes,
            "item_factors": item_bytes,
            "user_index": psycopg.types.json.Json(als.user_index),
            "item_index": psycopg.types.json.Json(als.item_index),
        },
    )


def _write_edges(cur: psycopg.Cursor[Any], edges: tuple[EngagementEdge, ...]) -> None:
    cur.execute("TRUNCATE trust_snapshot_edge")
    if not edges:
        return
    # PRIMARY KEY (src, dst): matches the real gateway's own guarantee
    # (recsys.io.hafsql.HafsqlClient.engagement_edges groups by pair before
    # returning). A caller feeding duplicate (src, dst) pairs gets a loud
    # IntegrityError here rather than one silently overwriting the other.
    with cur.copy(
        "COPY trust_snapshot_edge (src, dst, replies, reply_backs, upvotes, reblogs, "
        "mentions, profile_visits, post_opens, revisits, dwell_seconds, last_interaction) "
        "FROM STDIN"
    ) as copy:
        for e in edges:
            copy.write_row(
                (
                    e.src,
                    e.dst,
                    e.replies,
                    e.reply_backs,
                    e.upvotes,
                    e.reblogs,
                    e.mentions,
                    e.profile_visits,
                    e.post_opens,
                    e.revisits,
                    e.dwell_seconds,
                    e.last_interaction,
                )
            )


# ---------------------------------------------------------------------------
# Readers.
# ---------------------------------------------------------------------------


def _read_meta(cur: psycopg.Cursor[Any]) -> tuple[datetime, bool, frozenset[str]] | None:
    cur.execute("SELECT built_at, degraded, trusted_seeds FROM trust_snapshot_meta WHERE id = 1")
    row = cur.fetchone()
    if row is None:
        return None
    built_at, degraded, trusted_seeds = row
    return built_at, degraded, frozenset(trusted_seeds or [])


def _read_graph_creds(cur: psycopg.Cursor[Any]) -> dict[str, GraphCred]:
    cur.execute(
        "SELECT account, score, follow_follower_ratio, outside_engaged, outside_engagers "
        "FROM graph_cred"
    )
    return {
        account: GraphCred(
            account=account,
            score=score,
            follow_follower_ratio=ratio,
            outside_engaged=outside_engaged,
            outside_engagers=frozenset(engagers or []),
        )
        for account, score, ratio, outside_engaged, engagers in cur.fetchall()
    }


def _read_ring_members(cur: psycopg.Cursor[Any]) -> frozenset[str]:
    cur.execute("SELECT account FROM ring_membership")
    return frozenset(row[0] for row in cur.fetchall())


def _read_als(cur: psycopg.Cursor[Any]) -> ALSModel | None:
    cur.execute(
        "SELECT factors_k, user_factors, item_factors, user_index, item_index "
        "FROM als_model WHERE id = 1"
    )
    row = cur.fetchone()
    if row is None:
        return None
    k, user_bytes, item_bytes, user_index_raw, item_index_raw = row
    user_index = {str(a): int(i) for a, i in user_index_raw.items()}
    item_index = {str(a): int(i) for a, i in item_index_raw.items()}
    user_factors = np.frombuffer(user_bytes, dtype=np.float64).reshape(-1, k).copy()
    item_factors = np.frombuffer(item_bytes, dtype=np.float64).reshape(-1, k).copy()
    if user_factors.shape[0] != len(user_index) or item_factors.shape[0] != len(item_index):
        raise ValueError(
            "recsys.db.store: persisted als_model row count does not match its own "
            f"index (users {user_factors.shape[0]} vs {len(user_index)}, items "
            f"{item_factors.shape[0]} vs {len(item_index)}) — refusing to return a "
            "silently corrupt model"
        )
    return ALSModel(
        user_factors=user_factors,
        item_factors=item_factors,
        user_index=user_index,
        item_index=item_index,
    )


def _read_edges(cur: psycopg.Cursor[Any]) -> tuple[EngagementEdge, ...]:
    cur.execute(
        "SELECT src, dst, replies, reply_backs, upvotes, reblogs, mentions, "
        "profile_visits, post_opens, revisits, dwell_seconds, last_interaction "
        "FROM trust_snapshot_edge ORDER BY src, dst"
    )
    return tuple(
        EngagementEdge(
            src=src,
            dst=dst,
            replies=replies,
            reply_backs=reply_backs,
            upvotes=upvotes,
            reblogs=reblogs,
            mentions=mentions,
            profile_visits=profile_visits,
            post_opens=post_opens,
            revisits=revisits,
            dwell_seconds=dwell_seconds,
            last_interaction=last_interaction,
        )
        for (
            src,
            dst,
            replies,
            reply_backs,
            upvotes,
            reblogs,
            mentions,
            profile_visits,
            post_opens,
            revisits,
            dwell_seconds,
            last_interaction,
        ) in cur.fetchall()
    )


__all__ = [
    "DegradedSnapshotError",
    "PersistedSnapshot",
    "ensure_schema",
    "load_snapshot",
    "save_snapshot",
]
