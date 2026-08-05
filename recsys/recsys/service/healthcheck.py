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
import threading
import urllib.error
import urllib.request

#: Kept below the healthcheck's own `--timeout` so this exits with a verdict
#: rather than being killed without one.
_TIMEOUT_S = 4.0

#: A health payload is a few hundred bytes; anything larger is not ours.
_MAX_BODY_BYTES = 64 * 1024


def probe(url: str, timeout: float = _TIMEOUT_S) -> int:
    """Return the exit code for one probe of ``url``. No side effects.

    ★ PUNCH LIST #8: `timeout` on `urlopen` bounds each SOCKET OPERATION, not
    the call. A server that dribbles one byte at a time resets it forever, and
    this probe was measured hanging ~20s against a stated 4s. The read now runs
    under a hard total deadline enforced by a worker thread, so the documented
    guarantee is the real one.
    """
    result: list[int] = []

    def _attempt() -> None:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                # Cap the body too: a health payload is small, and an unbounded
                # read is the other half of the same denial.
                payload = json.loads(response.read(_MAX_BODY_BYTES))
        except (urllib.error.URLError, OSError, ValueError):
            result.append(2)
            return
        result.append(_verdict(payload))

    worker = threading.Thread(target=_attempt, daemon=True)
    worker.start()
    worker.join(timeout)
    if not result:
        # Still running past the deadline: treat as unreachable rather than
        # waiting. The thread is a daemon and dies with the process.
        return 2
    return result[0]


def _verdict(payload: object) -> int:
    """Exit code for a parsed payload. Split out so the deadline wrapper stays
    about timing and this stays about semantics."""
    if not isinstance(payload, dict):
        # Something is answering on the port, but it is not this service.
        return 2
    # `serving` is True only when a real /feed request would succeed — the field
    # `health_payload` documents as the one an orchestrator should gate on. An
    # absent field is treated as NOT serving: a payload this probe does not
    # understand must never read as healthy.
    return 0 if payload.get("serving") is True else 1


def main() -> int:
    port = os.environ.get("RECSYS_SERVICE_PORT", "8000")
    host = os.environ.get("RECSYS_HEALTHCHECK_HOST", "127.0.0.1")
    return probe(f"http://{host}:{port}/health")


if __name__ == "__main__":
    sys.exit(main())
