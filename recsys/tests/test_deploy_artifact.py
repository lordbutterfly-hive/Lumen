"""B4a (2026-08-05) — the shipped deploy artifact must be able to BOOT.

★ WHY THIS FILE EXISTS. The 2026-08-05 council ran `deploy/compose.recsys.yml`
as committed and it **crash-looped**: `recsys.service.app.main()` calls
`Settings.from_env(production=True)` unless `RECSYS_PRODUCTION=0`, and that
refuses to start without `LUMEN_EXPLORE_SEAT_SECRET` — a variable the compose
file did not mention at all, not even as a blank pass-through. The trust batch
died the same way, on an uncaught `ValueError`. Nothing in the test suite
noticed, because nothing tested the artifact; the whole package could be green
while the thing an operator actually runs could not start.

These are deliberately DUMB text assertions, not a YAML parse: PyYAML is not a
declared dependency (this project hand-rolled a connection pool rather than take
`psycopg_pool`, and a test-only dep to lint a config file is a worse trade). The
check that matters is "is the variable declared for this service", which survives
being done on text.
"""

from __future__ import annotations

import pathlib
import re
import tomllib

_ROOT = pathlib.Path(__file__).resolve().parent.parent
_COMPOSE = _ROOT / "deploy" / "compose.recsys.yml"

#: Every variable whose ABSENCE stops the container from starting, as opposed to
#: merely changing its behaviour. Keep this list to genuine boot blockers — a
#: variable that has a working default does not belong here.
_BOOT_CRITICAL = ("LUMEN_EXPLORE_SEAT_SECRET",)

#: Boot-critical for the long-running SERVICE only. The weekly batch serves no
#: HTTP and does not need an API token, so requiring it there would be cargo
#: cult rather than a check.
_SERVICE_ONLY_BOOT_CRITICAL = ("RECSYS_API_TOKEN",)


def _service_block(text: str, name: str) -> str:
    """The compose text belonging to one service, from its key to the next
    top-level-ish key. Crude on purpose — see the module docstring."""
    start = text.index(f"\n  {name}:")
    rest = text[start + 1 :]
    for marker in ("\n  recsys-", "\nnetworks:"):
        idx = rest.find(marker, 1)
        if idx != -1:
            rest = rest[:idx]
    return rest


def test_compose_declares_every_boot_critical_variable_for_both_services() -> None:
    """★ THE REGRESSION THIS FILE WAS WRITTEN FOR. Both the long-running service
    and the weekly batch call `Settings.from_env(production=...)`, so both die
    without the seat secret. A blank pass-through (`VAR:`) is correct and is what
    this asserts; a DEFAULTED value would be wrong, because a default would
    silently reinstate the publicly-known dev key in production."""
    text = _COMPOSE.read_text()
    for service in ("recsys-feed", "recsys-trust-batch"):
        block = _service_block(text, service)
        for var in _BOOT_CRITICAL:
            assert f"{var}:" in block, (
                f"{service} does not declare {var}; `main()`/`run_batch` call "
                f"Settings.from_env(production=True), which REFUSES to start "
                f"without it — this artifact would crash-loop"
            )
    feed_block = _service_block(text, "recsys-feed")
    for var in _SERVICE_ONLY_BOOT_CRITICAL:
        assert f"{var}:" in feed_block, (
            f"recsys-feed does not declare {var}; `main()` refuses to serve "
            f"unauthenticated in production (B4c)"
        )


def test_the_seat_secret_is_never_given_a_default_value() -> None:
    """A default would be worse than the omission it replaces: the container
    would boot happily on a known key, and the seat MAC exists precisely to stop
    offline name-grinding of the reserved new-author slot."""
    for line in _COMPOSE.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("LUMEN_EXPLORE_SEAT_SECRET"):
            assert stripped.endswith(":"), (
                f"seat secret must be a blank pass-through, got: {stripped!r}"
            )


def test_service_package_is_declared_for_packaging() -> None:
    """`recsys.service` was missing from `[tool.setuptools] packages`. Latent
    only because the Dockerfile copies raw source — an installed wheel would
    have shipped without the HTTP service, so the container's own
    `python -m recsys.service.app` would fail on a real install."""
    data = tomllib.loads((_ROOT / "pyproject.toml").read_text())
    packages = data["tool"]["setuptools"]["packages"]
    for pkg in ("recsys", "recsys.core", "recsys.io", "recsys.db", "recsys.jobs",
                "recsys.service"):
        assert pkg in packages, f"{pkg} missing from [tool.setuptools] packages"


# ---------------------------------------------------------------------------
# 2026-08-05 POST-CLOSEOUT COUNCIL — the healthcheck. This file previously had
# NO healthcheck coverage at all, which is how a probe that could never pass
# shipped inside the very artifact B4a was written to make bootable.
# ---------------------------------------------------------------------------


def _probe_lines(text: str) -> list[str]:
    """Only the lines that actually INVOKE the probe — never the prose around
    it, which necessarily names the broken command it replaced."""
    return [
        line
        for line in text.splitlines()
        if not line.lstrip().startswith("#")
        and ("HEALTHCHECK" in line or "test:" in line or "CMD" in line)
    ]


def test_the_healthcheck_uses_something_the_image_actually_contains() -> None:
    """★★ Seat 1 + Seat 3, both verified, and provable from the files alone.

    The probe was `wget --no-verbose --tries=1 --spider` in BOTH the Dockerfile
    and the compose file. The base image is `python:3.11-slim` and installs
    exactly one OS package, `tini` — **there is no wget in it**, so every
    healthcheck this artifact ever ran returned 127. The shape was copied, as
    the Dockerfile comment conceded, from the frontend's image, which is Alpine
    and gets wget from busybox.

    And even with wget present, `--spider` issues HEAD while the service defines
    only `do_GET`, so `BaseHTTPRequestHandler` answers 501 — fixing the missing
    binary alone would have swapped one permanent failure for another.

    MUTANT: put either `wget` probe back. This fails.
    """
    dockerfile = (_ROOT / "Dockerfile").read_text()
    compose = (_ROOT / "deploy" / "compose.recsys.yml").read_text()

    # The image installs no probe binary, so the probe must be the interpreter.
    assert "python:3.11-slim" in dockerfile, "base image changed — re-check the probe"
    for name, text in (("Dockerfile", dockerfile), ("compose", compose)):
        lines = _probe_lines(text)
        assert lines, f"{name}: no healthcheck invocation found at all"
        assert any("recsys.service.healthcheck" in line for line in lines), (
            f"{name}: healthcheck does not invoke the probe module"
        )
        assert not any("wget" in line for line in lines), (
            f"{name}: healthcheck invokes wget, which is not in python:3.11-slim"
        )


def test_the_healthcheck_start_period_covers_a_real_cold_start() -> None:
    """Warm-up against the real mirror was measured at ~232s. The old
    `start_period: 60s` plus 15s x 5 retries gave a 135s deadline an honest cold
    start could not meet — the container would be declared unhealthy while
    correctly warming."""
    # ★ ROUND-3 COUNCIL (Seat 2): this asserted `"300s" in text`, which passes
    # on the COMMENT describing the fix rather than the directive doing it —
    # a gate that reads its own prose. Parse the actual setting.
    # ★ RE-MEASURED 2026-08-06 by cold-starting the service for real: 1242s
    # (20.7 min), not the ~232s the old 300s was set from. The author-prior warm
    # (2,237 authors) runs BEFORE the port opens and dominates. At 300s Docker
    # marks the container unhealthy ~4x before it can serve, and a restart policy
    # loops it forever. Both probes must clear the MEASURED cold start, and must
    # AGREE with each other — two probes that disagree are worse than one.
    MEASURED_COLD_START_S = 1242

    def _seconds(v: str) -> int:
        v = v.strip().rstrip("s")
        return int(v)

    dockerfile = [
        line for line in (_ROOT / "Dockerfile").read_text().splitlines()
        if "start-period" in line and not line.lstrip().startswith("#")
    ]
    assert dockerfile, "no HEALTHCHECK start-period in the Dockerfile"
    df_val = _seconds(dockerfile[0].split("--start-period=")[1].split()[0])

    compose = [
        line for line in (_ROOT / "deploy" / "compose.recsys.yml").read_text().splitlines()
        if line.strip().startswith("start_period:")
    ]
    assert compose, "no start_period in compose"
    co_val = _seconds(compose[0].split(":", 1)[1])

    assert df_val == co_val, (
        f"the two healthcheck probes disagree: Dockerfile {df_val}s vs compose "
        f"{co_val}s — they must be kept in step"
    )
    assert df_val > MEASURED_COLD_START_S, (
        f"start_period {df_val}s is below the MEASURED cold start "
        f"({MEASURED_COLD_START_S}s). Docker will mark the container unhealthy "
        "before it can finish warming, and a restart policy will loop it forever."
    )


def test_the_artifact_passes_the_proxy_hop_count_to_the_service() -> None:
    """★★★ ROUND-5 COUNCIL (Seat 1 + Seat 3). `RECSYS_TRUSTED_PROXY_HOPS`
    existed in `ServiceConfig`, was read by `from_env`, was covered by four
    tests — and reached NO container. The rate-limit fix it controls was
    therefore unreachable in the shipped artifact.

    This is the IDENTICAL defect the round-4 council found for
    `LUMEN_LITE_DATABASE_URL`, repeated one round later by the same author, in
    the same file. Config that exists in code and not in the artifact is config
    that does not exist.

    MUTANT: remove the variable from compose. This fails.
    """
    compose = (_ROOT / "deploy" / "compose.recsys.yml").read_text()
    feed = compose.split("\n  recsys-trust-batch:", 1)[0]
    assert "RECSYS_TRUSTED_PROXY_HOPS:" in feed, (
        "the feed service cannot be told how many proxies sit in front of it, "
        "so X-Forwarded-For is ignored and one client can 429 every user"
    )


def test_every_env_var_the_service_reads_reaches_the_container() -> None:
    """★★★ 2026-08-06 — THE GENERAL FORM OF A DEFECT THIS PROJECT SHIPPED THREE
    TIMES, and the reason it kept happening.

    `LUMEN_LITE_DATABASE_URL` (round 4), then `RECSYS_TRUSTED_PROXY_HOPS`
    (round 5), then `RECSYS_TRUSTED_PROXY_PEERS` — each found by a human
    noticing ONE variable, and each answered with ONE more assertion naming that
    variable. The round-5 ruling said it plainly: *knowing the rule has not been
    enough; the rules need to be checked mechanically, not remembered.* A gate
    that names a variable can only ever catch the variable somebody already
    thought of.

    So this asks the general question — every `RECSYS_*` name `app.py` reads
    from the environment must appear in the feed service's `environment:` block
    — and asking it for the first time immediately found FIVE more: the four
    author-prior knobs and `RECSYS_VIEWER_CACHE_MAX_ENTRIES`, all unreachable
    since they were written. None was a security control, which is exactly why
    no human ever went looking.

    MUTANT: delete any one variable from compose. This fails and names it.
    """
    app = (_ROOT / "recsys" / "service" / "app.py").read_text()
    feed = (_ROOT / "deploy" / "compose.recsys.yml").read_text().split(
        "\n  recsys-trust-batch:", 1
    )[0]

    read = set(re.findall(r'os\.environ\.get\(\s*"(RECSYS_[A-Z0-9_]+)"', app))
    read |= set(re.findall(r'_csv_env\(\s*\n?\s*"(RECSYS_[A-Z0-9_]+)"', app))
    # Non-empty control: a regex that silently stops matching would make this
    # test pass by measuring nothing — the vacuous-gate failure mode this
    # project has shipped twice.
    assert len(read) >= 15, (
        f"only found {len(read)} RECSYS_* env reads in app.py — the extraction "
        "is broken, so this gate is vacuous. Fix the pattern before trusting it."
    )

    missing = sorted(name for name in read if f"{name}:" not in feed)
    assert not missing, (
        f"{len(missing)} env var(s) are read by the service and reach NO "
        f"container: {', '.join(missing)}. Add them to the feed service's "
        "environment: block in deploy/compose.recsys.yml. Config that exists in "
        "code and not in the artifact is config that does not exist."
    )


def test_the_trust_batch_can_set_its_own_hafsql_statement_timeout() -> None:
    """★★★ 2026-08-06 — FOUND BY RUNNING THE BATCH, NOT BY READING IT.

    `HAFSQL_STATEMENT_TIMEOUT_MS` defaults to 15s, which is right for the
    REQUEST path and fatal for this one. The batch queries `engagement_edges`
    over the 365-day `trust_days` window; against the real public mirror that is
    cancelled outright (`psycopg.errors.QueryCanceled`), the batch dies, no
    trust snapshot is ever written, and `/feed` — being FAIL_CLOSED — refuses
    every request forever. A deployment that can never serve a feed.

    The variable was passed to the feed service and to NEITHER batch, so there
    was no way to fix it from the artifact at all. That is the fourth instance
    of "config exists in code and reaches no container" on this project.

    MUTANT: remove the variable from either batch service. This fails.
    """
    compose = (_ROOT / "deploy" / "compose.recsys.yml").read_text()
    # Slice each batch service's own block, so a variable present only on the
    # feed service cannot satisfy this.
    one_shot = compose.split("\n  recsys-trust-batch:", 1)[1].split(
        "\n  recsys-trust-batch-cron:", 1
    )[0]
    cron = compose.split("\n  recsys-trust-batch-cron:", 1)[1].split("\nnetworks:", 1)[0]

    for name, block in (("recsys-trust-batch", one_shot), ("recsys-trust-batch-cron", cron)):
        assert "HAFSQL_STATEMENT_TIMEOUT_MS:" in block, (
            f"{name} cannot set HAFSQL_STATEMENT_TIMEOUT_MS, so it is stuck with the "
            "15s request-path default and its 365-day engagement_edges query is "
            "cancelled — the batch dies and /feed FAIL_CLOSEs forever"
        )


def test_the_trust_batch_is_rescheduled_faster_than_the_snapshot_expires() -> None:
    """★★★ 2026-08-06 — THE DEPLOYMENT HAD A GUARANTEED EXPIRY DATE.

    `recsys-trust-batch` is a ONE-SHOT that runs once before the service starts.
    Nothing ran it again. `TrustConfig.max_snapshot_age_days = 14` and `/feed` is
    FAIL_CLOSED, so **fourteen days after any deploy every feed request refuses**
    — not degrades, refuses — and the only symptom before that moment is nothing
    at all. The cadence was documented as "an operator decision", which is the
    same shape as every other control this project left optional and nobody set.

    The real invariant is not "a scheduler exists" — it is that the schedule runs
    STRICTLY FASTER THAN THE SNAPSHOT EXPIRES, and that relationship spans two
    files that no human would think to compare (a YAML sleep and a Python
    dataclass default). So this reads both and compares them.

    MUTANT: raise `RECSYS_TRUST_BATCH_INTERVAL_S`'s default past 14 days, or
    lower `max_snapshot_age_days` below the interval, or delete the scheduler.
    Each fails here.
    """
    compose = (_ROOT / "deploy" / "compose.recsys.yml").read_text()

    assert "recsys-trust-batch-cron:" in compose, (
        "no recurring trust-batch scheduler in the artifact — the snapshot ages "
        "out and /feed FAIL_CLOSEs on every request once it does"
    )
    cron = compose.split("\n  recsys-trust-batch-cron:", 1)[1]
    assert "recsys.jobs.trust_batch" in cron, "the scheduler does not run the batch"
    assert "restart: unless-stopped" in cron, (
        "the scheduler has no restart policy, so one crash silently ends all "
        "future trust snapshots"
    )

    match = re.search(r"RECSYS_TRUST_BATCH_INTERVAL_S:-(\d+)", cron)
    assert match, "cannot find the scheduler's default interval to check it"
    interval_s = int(match.group(1))

    from recsys.config import DEFAULT_SETTINGS

    max_age_s = DEFAULT_SETTINGS.trust.max_snapshot_age_days * 86_400
    assert 0 < interval_s < max_age_s, (
        f"the trust batch is scheduled every {interval_s}s "
        f"({interval_s / 86_400:.1f}d) but a snapshot is refused once it is older "
        f"than {max_age_s}s ({max_age_s / 86_400:.1f}d). The feed FAIL_CLOSEs in "
        "the gap. The schedule must be strictly faster than the expiry."
    )
    # And with real headroom: one failed run must not exhaust the budget.
    assert interval_s * 2 <= max_age_s, (
        f"interval {interval_s / 86_400:.1f}d leaves no room for a failed run "
        f"before the {max_age_s / 86_400:.1f}d expiry — one bad week is an outage"
    )


def test_the_two_schedulers_carry_the_same_cadence() -> None:
    """★★★ THE GATE THIS FILE WAS MISSING, AND IT MATTERS MORE THAN THE ONE
    ABOVE (2026-08-15).

    There are TWO copies of the trust-batch schedule and the test above reads
    only one of them:

      * `deploy/compose.recsys.yml` — parsed here, and the number the assertion
        above is actually checking;
      * `deploy/trust-cron-host.sh` — **the one that launched the running
        container.** The deployed box is not compose-managed (`recsys-feed` was
        started with `docker run --network host`; bringing the compose cron up
        would put the batch on the bridge network where `127.0.0.1:55433` is the
        container itself and the recsys Postgres is not there at all).

    So a cadence changed in the compose file alone leaves this suite green while
    the deployed schedule is untouched, and a cadence changed in the host script
    alone leaves the suite pinning a number nobody runs. Either way the gate is
    testing fiction. This refuses the split in both directions.

    MUTANT: change `RECSYS_TRUST_BATCH_INTERVAL_S`'s default in one file only.
    This fails.
    """
    host = (_ROOT / "deploy" / "trust-cron-host.sh").read_text()
    compose = _COMPOSE.read_text()

    pattern = r"RECSYS_TRUST_BATCH_INTERVAL_S:-(\d+)"
    host_defaults = {int(m) for m in re.findall(pattern, host)}
    compose_defaults = {int(m) for m in re.findall(pattern, compose)}

    assert host_defaults, "no interval default in deploy/trust-cron-host.sh"
    assert compose_defaults, "no interval default in deploy/compose.recsys.yml"
    # ★ Internal consistency first. The host script names the default in three
    # places (the initial read, and the two `NEXT_SLEEP_S` assignments in the
    # generated loop) and the compose heredoc in two. One of them being missed
    # is the realistic mistake — it would make the FIRST sleep and every LATER
    # sleep different lengths, which is invisible until week two.
    assert len(host_defaults) == 1, (
        f"deploy/trust-cron-host.sh carries mixed interval defaults {host_defaults} "
        "— the first sleep and the post-run sleeps would differ"
    )
    assert len(compose_defaults) == 1, (
        f"deploy/compose.recsys.yml carries mixed interval defaults {compose_defaults}"
    )
    assert host_defaults == compose_defaults, (
        f"the two schedulers disagree: host script {host_defaults}, compose "
        f"{compose_defaults}. The host script is what launched the running "
        "container, so the compose number is the one the suite above is "
        "checking and the host number is the one that runs."
    )

    # And the host script's own refusal guard must still be above the value it
    # ships with, or the script refuses to start at its own default.
    guard = re.search(r'\[ "\$INTERVAL_S" -ge (\d+) \]', host)
    assert guard, "the host script's interval guard has gone missing"
    interval = next(iter(host_defaults))
    assert interval < int(guard.group(1)), (
        f"the shipped default {interval}s is at or above the script's own "
        f"refusal threshold {guard.group(1)}s — it would refuse to start"
    )


def test_a_failed_run_retries_in_retry_s_not_retry_s_plus_interval_s() -> None:
    """★★★ 2026-08-15 — THE RETRY PATH GUARANTEED THE OUTAGE IT EXISTS TO PREVENT.

    The loop was `sleep INTERVAL; run; on failure sleep RETRY` and then looped
    back to the top — which sleeps INTERVAL *again* before the retried attempt.
    So a failure recovers in RETRY + INTERVAL, not RETRY.

    That silently voids the headroom the test above asserts. Measured against the
    shipped defaults (interval 604800s/7d, retry 3600s/1h, max_snapshot_age_days
    14d = 1209600s): a single failure at the day-7 attempt pushes the retried
    attempt to day 14.04 — 3600s AFTER the snapshot has expired and /feed has
    gone FAIL_CLOSED. One bad run, guaranteed outage.

    The fix is to track the NEXT sleep explicitly instead of nesting a second
    sleep inside the loop body.

    MUTANT: restore the old shape — a literal `sleep "${RECSYS_TRUST_BATCH_
    INTERVAL_S:-...}"` as the loop's own first statement plus a nested retry
    sleep. This test fails on it.
    """
    compose = (_ROOT / "deploy" / "compose.recsys.yml").read_text()
    cron = compose.split("\n  recsys-trust-batch-cron:", 1)[1]

    assert "NEXT_SLEEP_S" in cron, (
        "the scheduler does not track its next sleep explicitly, so a failed run "
        "falls back through the interval sleep and recovers in RETRY + INTERVAL"
    )
    # ★ BOTH PATTERNS MUST TOLERATE COMPOSE'S `$$` ESCAPE (fixed 2026-08-23).
    # In a compose file a literal `$` for the container shell is written `$$`, so the
    # artifact correctly reads `sleep "$$NEXT_SLEEP_S"` — the file's own comment at
    # :358 says so. These regexes were written against the UNESCAPED form.
    # Consequences, both real:
    #   * the positive assertion never matched, so this test had been RED since it was
    #     written and was being read as a known-failure rather than a signal;
    #   * the negative assertion never matched either, which is worse — it is the guard
    #     against the actual bug, and against `sleep "$${RECSYS_TRUST_BATCH_INTERVAL_S`
    #     it was INERT. The mutant this docstring describes would have passed.
    assert re.search(r'sleep\s+"\$\$?NEXT_SLEEP_S"', cron), (
        "the loop does not sleep on the tracked variable"
    )
    # The loop must NOT sleep the interval literal as a statement of its own —
    # that is precisely the bug: it re-applies on the retry pass.
    assert not re.search(
        r'^\s*sleep\s+"\$\$?\{RECSYS_TRUST_BATCH_INTERVAL_S', cron, re.MULTILINE
    ), (
        "the interval is slept directly inside the loop, so a retry waits "
        "RETRY + INTERVAL — the exact defect this test exists for"
    )
    # Both outcomes must re-arm the next sleep, or one branch inherits the other's.
    assert cron.count("NEXT_SLEEP_S=") >= 3, (
        "success and failure must each set the next sleep explicitly "
        "(plus the initial value)"
    )


def test_a_cold_deploy_runs_the_trust_batch_before_serving() -> None:
    """★★★ ROUND-5 COUNCIL (Seat 1). `/feed` refuses to serve without a trust
    snapshot and the probe gates on `serving`, while the batch was documented as
    "an operator decision" and left unscheduled — so `docker compose up` on a
    fresh install produced a container that could NEVER pass its own
    healthcheck. Renaming the health JSON's reason, which is what the punch list
    first did, did not change that by one bit.

    MUTANT: drop the `depends_on`. This fails.
    """
    compose = (_ROOT / "deploy" / "compose.recsys.yml").read_text()
    feed = compose.split("\n  recsys-trust-batch:", 1)[0]
    assert "depends_on:" in feed and "service_completed_successfully" in feed, (
        "a cold deploy never gets a first trust snapshot, so it can never "
        "report healthy"
    )
