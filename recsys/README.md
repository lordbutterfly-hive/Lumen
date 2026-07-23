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
ruff check .        # style/lint
mypy recsys         # types
pytest -q           # 75 tests, pure — no DB needed
```

Public API: `recsys.pipeline.rank_feed(viewer, gateway, norm, now=..., since=...)`.

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
