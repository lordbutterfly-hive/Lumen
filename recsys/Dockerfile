# recsys — Hive discovery/ranking backend (Phase 0).
#
# A10 deploy artifact. Builds ONE image that serves two distinct roles by
# CMD override, matching how `recsys/jobs/__init__.py` already distinguishes
# them in code ("batch entry points — code that runs on a schedule" vs.
# "serving entry points — code that runs continuously"):
#
#   * the HTTP feed service (A10, `recsys.service.app`) — the default CMD,
#     meant to run continuously behind the frontend's own reverse proxy;
#   * the weekly trust-batch job (A7, `recsys.jobs.trust_batch`) — override
#     CMD at `docker run`/compose-service level (see
#     `deploy/compose.recsys.yml`'s commented-out example). WHO/WHAT
#     schedules that override (cron, a compose `profiles`-gated one-shot
#     service, a k8s CronJob, ...) is explicitly an operator decision per
#     BUILDMAP-A A7/A10's own "not a Sonnet unit end-to-end" flag — this
#     image only makes both entry points runnable, it does not pick a
#     scheduler.
#
# No web framework dependency: `recsys.service.app` is stdlib `http.server`
# (see that module's own docstring for why), so this image installs nothing
# beyond the package's own `io` extra (numpy + psycopg[binary]).

FROM python:3.11-slim AS base

# libpq is NOT needed at runtime: `psycopg[binary]` ships its own bundled
# libpq via wheels, and psycopg itself is imported LAZILY throughout this
# package (`recsys.io.hafsql`, `recsys.db.store` — see their own module
# docstrings) so the pure scoring core stays importable even without it.
# `tini` is the only OS package this image needs, as a correct PID 1 for
# signal handling (SIGTERM -> graceful shutdown, see `service.app.main`'s
# own `finally: server.shutdown(); state.close()`).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `pyproject.toml`'s build backend (setuptools, local `packages = [...]`
# list) needs the full source tree present just to resolve metadata — a
# `pyproject.toml`-first layer-cache split (copy deps, then source) was
# tried and fails at `pip install`'s "Getting requirements to build wheel"
# step with `package directory 'recsys/core' does not exist`. So this copies
# the whole package before installing; the tradeoff is a source change also
# re-runs dependency resolution, which is fine at this project's size (one
# `numpy`+`psycopg[binary]` dependency pair).
COPY pyproject.toml README.md ./
COPY recsys/ recsys/

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir ".[io]"

# Non-root, matching the frontend image's own convention
# (`frontend/Dockerfile`: `addgroup --system ... adduser --system ...`).
RUN addgroup --system --gid 1001 recsys \
    && adduser --system --uid 1001 --gid 1001 recsys \
    && chown -R recsys:recsys /app
USER recsys

ENV PYTHONUNBUFFERED=1 \
    RECSYS_SERVICE_HOST=0.0.0.0 \
    RECSYS_SERVICE_PORT=8000

EXPOSE 8000

# ★★ 2026-08-05 POST-CLOSEOUT COUNCIL. This WAS `wget --no-verbose --tries=1
# --spider`, copied from the frontend image — which is Alpine and has busybox
# wget. THIS image is `python:3.11-slim` and installs only `tini`, so the probe
# returned 127 on every run this artifact has ever made; and `--spider` sends
# HEAD, which a GET-only handler answers with 501. See
# `recsys/service/healthcheck.py` for the full autopsy.
#
# It also now reads `serving` from the BODY rather than the status line.
# `/health` deliberately returns 200 even when the trust snapshot is stale, so
# that state stays diagnosable instead of killing the container — but that
# means a status-line probe reports HEALTHY during a total serving outage.
# Reading the body is what makes the outage visible without changing the
# endpoint's contract.
#
# `start_period` is 1800s. ★ RE-MEASURED 2026-08-06 by actually cold-starting
# the service: 1242s (20.7 min). The previous 300s came from the ~232s
# NormContext warm alone and missed the real cost — the AUTHOR-PRIOR warm (2,237
# authors, chunked `author_engagement` against the shared mirror) runs BEFORE the
# port opens. At 300s Docker marks the container unhealthy ~4x before it can
# serve, and a restart policy then loops it forever: it never finishes warming,
# so it never becomes healthy.
#
# Keep in step with deploy/compose.recsys.yml — two probes that disagree are
# worse than one. `tests/test_deploy_artifact.py` enforces that mechanically.
HEALTHCHECK --interval=15s --timeout=5s --start-period=1800s --retries=3 \
    CMD python3 -m recsys.service.healthcheck

ENTRYPOINT ["tini", "--"]

# Default role: the HTTP feed service (A10). Override at `docker run`/
# compose-service level for the trust-batch role (A7), e.g.:
#   docker run ... recsys:latest python -m recsys.jobs.trust_batch --since-days 7
CMD ["python", "-m", "recsys.service.app"]
