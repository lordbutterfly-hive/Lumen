# Lumen

Monorepo for the Lumen platform — a Hive-based social/blogging application with lite accounts, a discovery/ranking engine, creator tokens, and a prediction market.

## Layout

| Path | Stack | What it is |
|------|-------|------------|
| [`frontend/`](frontend/) | Next.js / TypeScript | The Lumen web app (blog + wallet), Lumen UI/branding, **lite accounts** (Google / Bitcoin-wallet login, proxy posting, no Hive keys required), and the discovery-feed data layer. Fork of Hive [denser](https://gitlab.syncad.com/hive/denser). |
| [`recsys/`](recsys/) | Python 3.12 | Discovery / ranking backend — candidate sourcing, scoring (vote + reputation + organic), engagement-weighted graph-cred sybil resistance, and ALS collaborative filtering. |
| [`creator-tokens/`](creator-tokens/) | Go | Bonding-curve creator-token contract with keeper, indexer, and SDK. |
| [`prediction-market/`](prediction-market/) | Go | Weekly $HIVE parimutuel price market — contract, oracle settlement, scheduler, indexer, and SDK. |

## Working with the repo

- **Secrets** are never committed. Each app reads its own untracked `.env` file — copy from the `.env*.example` templates and fill in real values.
- **Compiled artifacts** (`bin/*.wasm`, `.next/`, `node_modules/`, Python/Go caches) are gitignored and rebuilt from source.
- **Line endings** are normalized to LF via `.gitattributes` (the tree is authored across WSL and a Windows-mounted drive).

## Build

Each component builds independently:

- `frontend/` — `pnpm install && pnpm dev:blog` (see `frontend/README.md`).
- `recsys/` — `pip install -e .` then `pytest -q` (see `recsys/README.md`).
- `creator-tokens/` — `go build ./...` then `go test ./...`.
- `prediction-market/` — `go build ./...` then `go test ./...` (see `prediction-market/README.md`).
