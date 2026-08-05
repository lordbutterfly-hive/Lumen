# recsys — Hive blog discovery/ranking backend (Phase 0)

The standalone ranking service behind the denser rebuild's discovery feed.
Implements the **Phase-0** slice of `../DISCOVERY-RANKING-BUILD-PLAN.md`: the
pure on-chain scoring + eligibility + re-rank pipeline, plus a scaffolded
HAFSQL/Postgres I/O layer. Built design-first — see `BUILD-SPEC.md` for the
module contracts.

## What's built (Phase 0)

| Module | Does | Doc |
|---|---|---|
| `contracts.py` | Immutable value types + the `HafsqlGateway` protocol | — |
| `config.py` | Hand-tuned weights/thresholds (`Settings`) | §0, §3.4, §8 |
| `core/normalize.py` | Log-compress + percentile-rank vs a rolling window | §4 |
| `core/vote_signal.py` | Independent-voter-breadth signal; excludes self/lineage/ring | §4, §8.4 |
| `core/scoring.py` | The fixed `0.10·vote + 0.10·rep + 0.80·organic` composite | §0, §3.3 |
| `core/candidates.py` | Merge + dedup candidate sources by priority | §3.1 |
| `core/second_degree.py` | Second-degree vouch gate + graph-cred floor + mutes | §8.1, §8.3 |
| `core/graph_cred.py` | Engagement-weighted **follow-graph** PageRank (RealGraph edges) | §8.3, rev 2.2 |
| `core/coldstart.py` | Interest-selection seeding for new users | §13.1, rev 2.2 |
| `core/rerank.py` | Author-diversity decay + truncate | §3.4 |
| `pipeline.py` | Ties it together (Home-Mixer shape) | §3 |
| `io/hafsql.py` | HAFSQL query recipes (**infra-gated** — needs a live DB) | Appendix B |
| `db/schema.sql` | recsys Postgres + pgvector schema | Appendix C |

The `core` package is pure (no DB driver) and fully unit-tested; the only I/O
is `io/hafsql.py`, whose live queries need a reachable HAFSQL/Postgres and the
`psycopg` driver (imported lazily, so the module imports fine without it).

## Run it

```bash
pip install --user numpy pytest ruff mypy      # (psycopg only for the live io layer)
cd recsys
export PATH="$HOME/.local/bin:$PATH"
ruff check .        # style/lint — REPO-WIDE, harness included (E3)
mypy recsys         # types
pytest -q           # 75 tests, pure — no DB needed
```

Public API: `recsys.pipeline.rank_feed(viewer, gateway, norm, now=..., since=...)`.

### Deploying it (required environment)

`recsys.service.app` and `recsys.jobs.trust_batch` both call
`Settings.from_env(production=True)` unless `RECSYS_PRODUCTION=0`, and that
**refuses to start** without a seat secret. Set it, or the container
crash-loops:

```bash
export LUMEN_EXPLORE_SEAT_SECRET=$(python -c "import secrets; print(secrets.token_hex(32))")
export RECSYS_API_TOKEN=$(python -c "import secrets; print(secrets.token_urlsafe(32))")
docker compose -f deploy/compose.recsys.yml up
```

`RECSYS_API_TOKEN` is equally required in production — `/feed` returns any
account's ranked feed plus its full score decomposition, so an open instance
leaks data *and* amplifies abuse against the shared upstream mirror. Callers
send `Authorization: Bearer <token>`; `/health` stays open so container
healthchecks keep working. Throttles (`RECSYS_RATE_LIMIT_PER_MINUTE`,
`RECSYS_MAX_CONCURRENT_REQUESTS`, `RECSYS_REQUEST_READ_TIMEOUT_S`,
`HAFSQL_POOL_ACQUIRE_TIMEOUT_S`) have working defaults.

That MAC keys the reserved new-author seat so its occupant cannot be chosen by
grinding account names offline (unkeyed, 6 ground names took 85% of the seat
platform-wide). To rotate, set `LUMEN_EXPLORE_SEAT_SECRET_PREVIOUS` to the
outgoing value and `LUMEN_EXPLORE_SEAT_SECRET_ACTIVE_FROM_BUCKET` to a *future*
bucket, so pages in flight do not reroll mid-rotation.

`RECSYS_DATABASE_URL` is required for a real deployment too: absent it the
service still starts (a missing snapshot is a legitimate cold-start state) but
`/feed` refuses every request under FAIL_CLOSED until a trust batch has run.

**You must schedule the weekly trust batch yourself** — the compose file makes
it runnable but deliberately does not pick a scheduler:

```bash
docker compose -f deploy/compose.recsys.yml run --rm recsys-trust-batch
```

If it stops running, the snapshot ages past `max_snapshot_age_days` (14) and
**every** `/feed` request starts failing closed. That is now visible rather than
silent: `/health` reports `status: "degraded"`, `serving: false` and
`trust_snapshot.fresh: false`, and the refusal logs at ERROR. Point readiness
probes at `serving`, not at the process being alive.

## Built since the initial Phase-0 (council fix loop + Phase-0.5)

- **Sybil-hardened graph-cred** (`core/graph_cred.py`): seeded teleport, ring/
  lineage edge exclusion, follow/follower prior, percentile normalization —
  produced by `pipeline.build_trust_snapshot` and consumed by the gate.
- **`core/ring.py`** (reciprocity/insularity ring detection, §8.5) + **`core/
  flooding.py`** (per-author OON cap, §8.8).
- **Vouch-quality, NSFW, and network-suppression** filters (`core/second_degree.py`).
- **`core/als.py`** — implicit-feedback ALS (§6.1); its viewer→author CF affinity
  is blended into the organic signal, replacing the pure-proxy organic bucket.

## Not yet built (later phases, per the plan)

- **Live wiring (infra):** point `HafsqlClient` at a real HAFSQL instance; add
  the cron + Postgres persistence for `build_trust_snapshot`; supply a curated
  `trusted_seeds` list at deploy (else seeded teleport falls back to uniform).
- **Phase 1:** telemetry (dwell/revisit), plagiarism/dup (§8.6), temporal-
  synchrony ring detection, content-affinity embeddings, sparse/igraph graph-cred at scale.
- **Phase 2:** the LightGBM learned ranker (§11).
