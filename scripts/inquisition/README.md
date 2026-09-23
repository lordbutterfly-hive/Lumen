# Inquisition warm pass (server)

Builds every Inquisition profile record before anyone opens the profile. These files are
the copies of what runs on the production server; install or update them there.

| File | Installed at | What it does |
|---|---|---|
| `warm-inquisition.sh` | `/opt/lumen/warm-inquisition.sh` | Warms the five boards, then every record on the list, two at a time |
| `warm-one-record.sh` | `/opt/lumen/warm-one-record.sh` | Builds one record (called by the script above through `xargs -P`) |
| `warm-accounts.js` | `/opt/lumen/warm-accounts.js` | Writes the account lists from HiveSQL (credentials from `/opt/lumen/.env`) |
| `lumen-inquisition-warm.service` / `.timer` | `/etc/systemd/system/` | Runs the pass daily at 04:00 |

**Which accounts.** Every account on a board, every account that ever held 100k+ HP/SP
(Steem history included; `whale-accounts.txt`), every account that posted or commented in
the last 30 days (`active-accounts.txt`), and every profile already opened.

**How often.** Missing, partial and unfinished records are built on every run. Whole records
are refreshed after 6 days only for board and active accounts; everyone else is refreshed
by the record route when somebody opens the profile.

**Progress.** `https://lumensocial.net/api/inquisition/warm-status` (done, left, percent,
rate, estimated finish).

**Knobs** (environment): `REC_BUDGET` seconds per run (default 21600), `WARM_PARALLEL`
records in flight (default 2), `FRESH_DAYS` (6), `ACTIVE_DAYS` (30), `WHALE_MIN_HP` (100000).
HiveSQL is a shared service: keep `WARM_PARALLEL` low.
