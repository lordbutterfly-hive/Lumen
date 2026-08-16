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

## How `frontend/` is maintained

`frontend/` is a **vendored fork**, not a normal subtree, and the history reads
oddly unless you know that:

- Day-to-day development happens in a separate clone of upstream
  [denser](https://github.com/openhive-network/denser) (`~/hive-blog-rebuild`),
  which keeps `git remote` pointed at upstream so fork merges stay possible.
- That tree is copied into `frontend/` by
  [`scripts/sync-frontend.sh`](scripts/sync-frontend.sh) — dry run by default,
  `--go` to apply. It is the only sanctioned bridge; never hand-copy.
- The split exists for two mundane reasons: small-file I/O on the Linux
  filesystem is ~7× faster than the Windows mount, and the repo has to sit on
  `/mnt/o` for GitHub Desktop to see it.

Consequences worth knowing before you go looking:

- **`git log frontend/` is a sync log, not development history**, and `git blame`
  there points at the sync commit rather than the change. The real per-change
  history lives in the dev clone.
- The sync excludes build output, `.env*`, TLS keys and generated assets
  (`public/locales/`, `public/__ENV.js`, …) — see the script's `--exclude` list.
- Upstream denser merges are done in the dev clone and then synced, never
  applied to `frontend/` directly.

## Build

Each component builds independently:

- `frontend/` — `pnpm install && pnpm dev:blog` (see `frontend/README.md`).
- `recsys/` — `pip install -e .` then `pytest -q` (see `recsys/README.md`).
- `creator-tokens/` — `go build ./...` then `go test ./...`.
- `prediction-market/` — `go build ./...` then `go test ./...` (see `prediction-market/README.md`).
