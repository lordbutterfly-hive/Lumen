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
