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
    dockerfile = [
        line for line in (_ROOT / "Dockerfile").read_text().splitlines()
        if "start-period" in line and not line.lstrip().startswith("#")
    ]
    assert dockerfile and "--start-period=300s" in dockerfile[0], dockerfile
    compose = [
        line for line in (_ROOT / "deploy" / "compose.recsys.yml").read_text().splitlines()
        if line.strip().startswith("start_period:")
    ]
    assert compose and compose[0].split(":", 1)[1].strip().startswith("300s"), compose
