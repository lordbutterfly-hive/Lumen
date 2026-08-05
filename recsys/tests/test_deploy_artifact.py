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
