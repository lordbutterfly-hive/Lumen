# stack/systemd

Verbatim copies of the live units and scripts on the Lumen production box
(169.58.251.194), taken 2026-09-05. They are a record, not a deploy source:
nothing reads this directory, so editing a file here changes nothing on the box.

| file | live path |
| --- | --- |
| `lumen-publisher.service` | `/etc/systemd/system/lumen-publisher.service` |
| `lumen.service.d/publisher.conf` | `/etc/systemd/system/lumen.service.d/publisher.conf` |
| `lumen-watchdog.sh` | `/usr/local/bin/lumen-watchdog.sh` |
| `publisher-drain.json` | `/opt/lumen/publisher-drain.json` |
| `lumen-mem.logrotate` | `/etc/logrotate.d/lumen-mem` |

`lumen.service` itself is unchanged and is not copied here; the drop-in above is
the only edit made to it.

## Why these changed on 2026-09-05

`lumen-publisher.service` used to carry `Requires=lumen.service`. `Requires=`
propagates a STOP but never a START, so when `lumen.service` was stopped on
2026-08-30 00:00:57 CEST and started again two seconds later as a separate
command, the publisher stayed dead. It stayed dead for six days. Lite posts kept
being accepted and queued in Postgres, their authors saw them on the site, and
the only signal was 652 unread ALERT lines in `/var/log/lumen-watchdog.log`.

Three changes, so that one stop can no longer do this:

1. `PartOf=lumen.service` in the publisher unit: propagates stop and restart.
2. `Wants=lumen-publisher.service` in the lumen drop-in: any start of lumen,
   including a no-op start of an already running lumen, pulls the publisher up.
3. The watchdog now starts the publisher itself when lumen is up and the
   publisher is not, and logs `self-healed lumen-publisher`.

Backups of the pre-change files are on the box beside each original, suffixed
`.bak-2026-09-05`.

## The drain body bug, fixed 2026-09-05

The publisher's `ExecStart` used to send `-d "{\"max\":25}"`. That literal passed
through two unescapers: systemd turned `\"` into `"`, then bash removed the quotes,
so curl posted `{max:25}`, which is not valid JSON. The drain route parses the body
with `.catch(() => ({}))` and fell back to `max = 1`, so each 60 second tick
published one post instead of up to 25, silently. The backlog drained on
2026-09-05 shows it: three separate ticks of `processed:1` rather than one tick
of three.

The body is now a file, `/opt/lumen/publisher-drain.json`, passed as
`-d @/opt/lumen/publisher-drain.json`. A path argument has nothing left for either
parser to unescape. Verified at the wire: the new form posts `{"max":25}` and
parses to `max=25`, the old form posts `{max:25}` and does not parse.

## Memory guard added 2026-09-06

Workers were seen growing to 1.3-1.5GB each within an hour (separate code fix in
flight), on a box where swapping freezes for 10s at a time (7.9GB RAM, 4 cores,
plus a 2.75GB-capped `recsys-feed` container). Added a `# 8. MEMORY` section to
`lumen-watchdog.sh`, appended after the existing 7 checks, nothing else in the
script touched:

1. **Every run** appends one CSV line to `/var/log/lumen-mem.log`:
   `timestamp,mem_available_mb,swap_used_mb,worker_rss_mb,recsys_mem_mb,lumen_uptime_s`
   (`worker_rss_mb` is `;`-separated per PID from `pgrep -f "^next-server"`, so it
   stays one CSV column regardless of `LUMEN_WORKERS`). Header is written once, on
   first create. Rotation is `/etc/logrotate.d/lumen-mem` (weekly, rotate 8,
   compress) — not the truncate-to-5000-lines alternative.
2. **Restart guard**: `systemctl restart lumen` (PartOf= carries the publisher
   with it) fires if `MemAvailable` is below `WATCHDOG_MEM_MIN_MB` (default 450)
   on two consecutive runs, OR swap used exceeds `WATCHDOG_SWAP_MAX_MB` (default
   400) while `MemAvailable` is under 900MB. Guarded by a `WATCHDOG_RESTART_COOLDOWN_S`
   (default 3600s) since-last-restart check and a hard floor of 600s on lumen's
   own uptime, so the guard never fights a restart that just happened for another
   reason and can't restart-loop. Consecutive-low counter and last-restart
   timestamp persist in `/var/lib/lumen-watchdog/`. All three thresholds are
   overridable from `/opt/lumen/watchdog.env` (not present yet on the box;
   defaults apply).
3. `--dry-run` (or `WATCHDOG_DRY_RUN=1`) evaluates and logs the decision
   (`ALERT memory guard would restart lumen ... [dry-run, ...]`) without ever
   calling `systemctl restart`.

Tested on the box 2026-09-06: `--dry-run` at default thresholds took no action;
`WATCHDOG_MEM_MIN_MB=99999 --dry-run` run twice produced the "would restart"
alert only on the second (consecutive) run, with `lumen`'s `ActiveEnterTimestamp`
unchanged throughout, proving no real restart fired; the low-count counter was
then reset to 0. A normal (non-dry-run) run confirmed the CSV line shape and
exit 0. `bash -n` clean before and after.
