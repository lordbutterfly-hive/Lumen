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

# Matches the frontend image's own healthcheck shape (`wget --spider`,
# `frontend/stack/compose.*.yml`) so both services are diagnosed the same
# way in the stack. `/health` never requires a fresh trust snapshot to
# return 200 — it reports staleness/absence as DATA (A10.3), not as a
# healthcheck failure, so a container is not killed for a stale weekly
# batch; that failure mode belongs in `/health`'s own body and in
# monitoring, not in whether the process is considered alive.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider \
        http://127.0.0.1:${RECSYS_SERVICE_PORT}/health || exit 1

ENTRYPOINT ["tini", "--"]

# Default role: the HTTP feed service (A10). Override at `docker run`/
# compose-service level for the trust-batch role (A7), e.g.:
#   docker run ... recsys:latest python -m recsys.jobs.trust_batch --since-days 7
CMD ["python", "-m", "recsys.service.app"]
