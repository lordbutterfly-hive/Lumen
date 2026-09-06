# The live proxy configuration

`Caddyfile` here is a verbatim copy of `/opt/lumen/caddy/Caddyfile` on the
production box, which is bind-mounted into the `lumen-caddy` container at
`/etc/caddy/Caddyfile`. Nothing deploys it: the box is the source of truth and
this copy exists so a change is reviewable and recoverable.

`frontend/stack/Caddyfile` is an OLDER, unrelated copy that predates the
Cloudflare cutover and the caching work. It does not match production and it is
not what runs. Do not edit that one expecting an effect.

## Changing it

    scp the file to /opt/lumen/caddy/Caddyfile
    docker exec lumen-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    docker exec lumen-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

Validate BEFORE reloading. A reload is seconds and drops no traffic; a bad
config that fails validation simply is not applied. Every change should leave a
timestamped backup beside it, as `Caddyfile.before-<change>-<date>`.

## What it does, in order

1. Refuses crawlers that take without giving (added 2026-09-06, see the comment
   in the file for the measurements and for who is deliberately kept).
2. Normalises the reader's locale into a header so it can be part of the cache
   key without the whole cookie being in it.
3. Bypasses the cache entirely for signed-in readers, router navigations, our
   own checks, and the API.
4. Answers HEAD requests at the edge, because a HEAD used to cost a full render.
5. Caches anonymous HTML in a bounded in-memory store, and refuses to store
   error responses so a thousand made-up names cannot evict the hot set.
