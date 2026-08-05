"""Container healthcheck probe — ``python3 -m recsys.service.healthcheck``.

★★ 2026-08-05 POST-CLOSEOUT COUNCIL (Seat 1 + Seat 3, both verified). This
module exists because the shipped probe could **never** pass, for two
independent reasons, and because even a working version of it would have been
blind to a total outage:

1. The probe was ``wget --no-verbose --tries=1 --spider`` (`Dockerfile`, and
   again in `deploy/compose.recsys.yml`). The image is ``python:3.11-slim`` and
   installs exactly one OS package, ``tini`` — **there is no wget in it.** The
   shape was copied, as the Dockerfile comment concedes, from the frontend's
   image, which is Alpine and gets wget from busybox. Every healthcheck this
   artifact has ever run returned 127.
2. ``--spider`` issues **HEAD**. The service defines only ``do_GET``, so
   `BaseHTTPRequestHandler` answers **501**. Fixing the missing binary alone
   would have swapped one permanent failure for another.
3. ``/health`` returns HTTP **200 unconditionally** — by design, so that a
   stale weekly batch is diagnosable rather than fatal (see `health_payload`).
   A probe that reads only the status line therefore reports a **healthy
   container during a total serving outage**, which is the precise failure mode
   B5 was built to make loud. So this probe reads the BODY.

Exit codes: ``0`` serving, ``1`` reachable but not serving (starting, or trust
snapshot stale/absent — `/feed` would 503), ``2`` unreachable or malformed.
Distinguishing 1 from 2 is deliberate: "up but refusing to serve" and "process
is gone" need different operator responses, and both look identical to a probe
that only checks that something answered.

Python only, no dependency: the interpreter is the one thing guaranteed to be
in this image, which is the whole lesson of the bug above.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

#: Kept below the healthcheck's own `--timeout` so this exits with a verdict
#: rather than being killed without one.
_TIMEOUT_S = 4.0


def probe(url: str, timeout: float = _TIMEOUT_S) -> int:
    """Return the exit code for one probe of ``url``. No side effects."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        # ValueError covers a non-JSON body: something is answering on the port
        # but it is not this service.
        return 2
    if not isinstance(payload, dict):
        return 2
    # `serving` is True only when a real /feed request would succeed — the
    # field `health_payload` documents as the one an orchestrator should gate
    # on. Absent field is treated as NOT serving: a payload this probe does not
    # understand must never read as healthy.
    return 0 if payload.get("serving") is True else 1


def main() -> int:
    port = os.environ.get("RECSYS_SERVICE_PORT", "8000")
    host = os.environ.get("RECSYS_HEALTHCHECK_HOST", "127.0.0.1")
    return probe(f"http://{host}:{port}/health")


if __name__ == "__main__":
    sys.exit(main())
