"""A7 — the weekly trust-snapshot batch: build one, persist it, refuse loudly
on anything degraded or empty.

``build_trust_snapshot`` (``recsys/pipeline.py``) could not run at all before
A2 landed — its first call, ``gateway.engagement_edges(since)``, crashed on a
non-existent column. This module is the callable entry point BUILDMAP-A A7
asks for: connect, build, persist, log what happened, and never let a bad
week's output silently replace a good one.

DEPLOYMENT — NOT DECIDED HERE. ``recsys/`` has no scheduler config and no
deploy artifact (no Dockerfile/compose/k8s manifest anywhere in this
package); choosing cron vs. a Compose service vs. a k8s CronJob is a deploy
decision the buildmap explicitly flags as not a Sonnet-solo unit. What this
module offers instead is a clean, idempotent, argv-driven entry point
(``main()`` / ``python -m recsys.jobs.trust_batch``) that any of those can
shell out to, following the conventions read from
``/mnt/o/Lumen/frontend/stack/compose.*.yml`` (the Lumen frontend's own
Compose stack, NOT edited by this builder): plain environment-variable
configuration (``RECSYS_DATABASE_URL``, ``HAFSQL_*`` — same pattern as
``REACT_APP_*`` there), a non-zero exit code on failure for a healthcheck /
restart policy to key on, and no in-process state that would stop a fresh
container from just running this and exiting.

FAIL LOUD, REFUSE TO PERSIST DEGRADED OR EMPTY (A7's own requirement). Two
independent layers enforce this, deliberately redundant:

1. ``run_batch`` checks ``snapshot.degraded`` / ``not snapshot.graph_creds``
   immediately after building and raises :class:`~recsys.db.store.
   DegradedSnapshotError` with a batch-flavored message (elapsed time,
   what was attempted) BEFORE ever calling ``save_snapshot`` — so even a
   ``persist=False`` dry run reports what WOULD have been refused.
2. ``save_snapshot`` itself (``recsys/db/store.py``) repeats the same two
   checks as the actual write-time guard, so any OTHER caller of the store
   gets the same protection without going through this module.

``build_trust_snapshot``'s own F-R2 guard (empty ``trusted_seeds`` under
``production=True``) raises ``ValueError`` before ever returning a
``TrustSnapshot`` at all; ``main()`` catches it separately and exits non-zero
(A7.3) rather than letting it propagate as an unhandled traceback.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from recsys.config import DEFAULT_SETTINGS, HafsqlConfig, LiteConfig, Settings
from recsys.contracts import HafsqlGateway
from recsys.db.store import DegradedSnapshotError, ensure_schema, load_snapshot, save_snapshot
from recsys.pipeline import TrustSnapshot, build_trust_snapshot

logger = logging.getLogger("recsys.jobs.trust_batch")

# A8.1: the operator-curated seed list (recsys/data/trusted_seeds.txt, see its
# own header for what the two numbers it feeds — seed teleport share and
# vouch anchoring — actually do). Overridable so a test or an alternate
# deploy layout doesn't have to write to the real data file.
_SEEDS_PATH_ENV = "RECSYS_TRUSTED_SEEDS_PATH"
_DEFAULT_SEEDS_PATH = Path(__file__).resolve().parent.parent / "data" / "trusted_seeds.txt"


def load_trusted_seeds(path: Path | None = None) -> frozenset[str]:
    """Parse the operator seed list. Blank lines and ``#`` comments (full-line
    or trailing) are ignored, one account per line, no ``@``. Returns an empty
    set — never raises — when the file is absent, so a misconfigured path
    surfaces as ``build_trust_snapshot``'s own F-R2 empty-seeds refusal under
    ``production=True`` rather than a confusing file-not-found here."""
    default_path = str(_DEFAULT_SEEDS_PATH)
    resolved = path if path is not None else Path(os.environ.get(_SEEDS_PATH_ENV, default_path))
    if not resolved.exists():
        logger.warning(
            "load_trusted_seeds: %s does not exist — returning an empty seed set", resolved
        )
        return frozenset()
    seeds: set[str] = set()
    for raw_line in resolved.read_text().splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if line:
            seeds.add(line)
    return frozenset(seeds)


def run_batch(
    gateway: HafsqlGateway,
    settings: Settings = DEFAULT_SETTINGS,
    *,
    trusted_seeds: frozenset[str] | None = None,
    now: datetime | None = None,
    dsn: str | None = None,
    production: bool = True,
    persist: bool = True,
) -> TrustSnapshot:
    """Build one trust snapshot and, unless ``persist=False`` (dry run),
    persist it. Always raises :class:`DegradedSnapshotError` — never
    silently returns — when the built snapshot is degraded or empty, dry run
    or not: a dry run exists to answer "would this have been accepted",
    which requires running the same refusal logic a real run would.

    ``persist=True`` (the default, and what a real weekly run must use)
    threads last run's snapshot in as ``previous=`` — REQUIRED for the §H11
    between-batch ALS-drift gate inside ``build_trust_snapshot`` to compare
    against anything; omitting it (``persist=False``, or the very first batch
    ever) means that gate cannot fire this run, which is expected on a first
    run and logged as such, not silently skipped.
    """
    resolved_now = now or datetime.now(UTC)
    seeds = trusted_seeds if trusted_seeds is not None else load_trusted_seeds()
    logger.info(
        "trust_batch: starting (production=%s, persist=%s, trusted_seeds=%d, now=%s)",
        production,
        persist,
        len(seeds),
        resolved_now.isoformat(),
    )

    previous: TrustSnapshot | None = None
    if persist:
        previous_persisted = load_snapshot(dsn)
        if previous_persisted is not None:
            previous = previous_persisted.snapshot
            logger.info(
                "trust_batch: loaded previous snapshot (built_at=%s, %d graph_creds, "
                "als=%s) for the §H11 drift comparison",
                previous_persisted.built_at.isoformat(),
                len(previous.graph_creds),
                "trained" if previous.als is not None else "none",
            )
        else:
            logger.warning(
                "trust_batch: no previous snapshot in the store — first-ever batch "
                "(or the store was never initialized). The §H11 drift gate has "
                "nothing to compare this run's ALS model against."
            )
    else:
        logger.info(
            "trust_batch: persist=False (dry run) — skipping the previous-snapshot "
            "load and the eventual save; §H11 cannot compare against a prior model."
        )

    start = time.monotonic()
    snapshot = build_trust_snapshot(
        gateway,
        settings,
        now=resolved_now,
        trusted_seeds=seeds,
        previous=previous,
        production=production,
    )
    elapsed = time.monotonic() - start

    if snapshot.degraded:
        logger.error(
            "trust_batch: REFUSING to persist — build_trust_snapshot returned "
            "degraded=True (§H11 ALS-drift gate rejected this week's model as an "
            "anomaly). The previously-persisted snapshot, if any, stays live. "
            "Elapsed %.1fs.",
            elapsed,
        )
        raise DegradedSnapshotError(
            "trust_batch: this run's snapshot is degraded (§H11 drift gate) — not persisted"
        )
    if not snapshot.graph_creds:
        logger.error(
            "trust_batch: REFUSING to persist — build_trust_snapshot returned an "
            "EMPTY graph_creds (no accounts scored this run). Elapsed %.1fs.",
            elapsed,
        )
        raise DegradedSnapshotError(
            "trust_batch: this run's snapshot has empty graph_creds — not persisted"
        )

    landed_seeds = len(seeds & set(snapshot.graph_creds))
    logger.info(
        "trust_batch: built snapshot — %d accounts scored, %d ring members flagged, "
        "%d engagement edges, als=%s, %d/%d trusted seeds landed in graph_creds, %.1fs elapsed",
        len(snapshot.graph_creds),
        len(snapshot.ring_members),
        len(snapshot.edges),
        "trained" if snapshot.als is not None else "none",
        landed_seeds,
        len(seeds),
        elapsed,
    )

    if persist:
        save_snapshot(snapshot, built_at=resolved_now, dsn=dsn)
        logger.info("trust_batch: persisted.")
    else:
        logger.info("trust_batch: persist=False (dry run) — snapshot built but NOT persisted.")

    return snapshot


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    parser = argparse.ArgumentParser(
        description="recsys weekly trust-snapshot batch (A7) — build_trust_snapshot + persist"
    )
    parser.add_argument(
        "--since-days",
        type=int,
        default=None,
        help="override settings.history.trust_days (the long trust window; default 365)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="build and log the snapshot but do not persist or require a DSN",
    )
    args = parser.parse_args(argv)

    dsn = os.environ.get("RECSYS_DATABASE_URL")
    if not dsn and not args.dry_run:
        logger.error(
            "RECSYS_DATABASE_URL is not set — refusing to run a real (non-dry-run) "
            "batch with nowhere to persist the result. Set it, or pass --dry-run."
        )
        return 2

    if dsn:
        ensure_schema(dsn)

    try:
        import psycopg  # noqa: F401  fail fast with a clear message, not deep inside HafsqlClient
    except ImportError:
        logger.error(
            "psycopg is not installed — install the 'io' extra: pip install '.[io]'"
        )
        return 2

    from recsys.io.hafsql import HafsqlClient

    hafsql_config = HafsqlConfig.from_env()
    # A13 (lite publisher-account wiring) is a separate, gated build unit;
    # this batch runs with lite off by construction (LiteConfig()'s default
    # empty publisher_accounts) until that lands.
    lite = LiteConfig()
    gateway = HafsqlClient(hafsql_config, lite, recsys_dsn=dsn)

    # ★★ ENV SETTINGS, NOT `DEFAULT_SETTINGS` (2026-08-04). The batch does not
    # rank, so it never resolves a seat secret — but it DOES need
    # `Settings.trusted_seeds`, and running the weekly trust build on defaults
    # is exactly how the seed list ends up "wired" everywhere except the one
    # process that actually builds the snapshot. `production` mirrors the
    # existing `--dry-run` semantics so a dry run stays runnable locally.
    settings = Settings.from_env(production=not args.dry_run)
    if args.since_days is not None:
        settings = replace(settings, history=replace(settings.history, trust_days=args.since_days))

    try:
        run_batch(
            gateway,
            settings,
            dsn=dsn,
            production=not args.dry_run,
            persist=not args.dry_run,
        )
    except DegradedSnapshotError as exc:
        logger.error("trust_batch: %s", exc)
        return 1
    except ValueError as exc:
        # build_trust_snapshot's own F-R2 production guard (empty/unlanded
        # trusted_seeds) raises ValueError, not DegradedSnapshotError — A7.3
        # requires this to exit non-zero too, loudly, not as a bare traceback.
        logger.error("trust_batch: build_trust_snapshot refused: %s", exc)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["load_trusted_seeds", "main", "run_batch"]
