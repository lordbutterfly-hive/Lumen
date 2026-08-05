"""MEASUREMENT — what does the REFILLING budget actually buy, and cost?

★ WHY A SEPARATE SCRIPT. `exploration_capture.py` runs one panel at one instant,
so a budget that refills on a 7-day window is INVISIBLE to it: the window never
elapses inside a single run, and every number it prints is identical with the
refill on or off. Reporting "the refill helps newcomers" from that harness would
be a claim with no evidence behind it — the exact failure four councils have now
charged this project with.

This drives the SAME panel across several epochs against ONE serve log with an
advancing clock, which is the only arrangement where a rolling window has any
effect at all.

Run: `python3 measurement-harness/attacks/refill_epochs.py`
Prints a table; does not gate. It exists to make a trade VISIBLE, not to pass.

★★★ THE RESULT, RECORDED BECAUSE IT IS A NEGATIVE AND NEGATIVES GET LOST.

Measured 2026-08-05, 4 epochs x 8 panels x seeds (7, 11, 23), the ONLY variable
being `serve_window_days`:

    window        socks    farm share   distinct honest reached
    lifetime          0         0.0%                      11.3
    lifetime         20         7.4%                      10.7
    7d refill         0         0.0%                      11.3
    7d refill        20         7.4%                      10.7

**Byte-identical.** The refilling budget is verified to work at the mechanism
level (`tests/test_exploration.py::test_the_serve_budget_refills_on_a_rolling_window`
— 3 serves, window elapses, budget returns) and has NO measurable effect on
served outcomes here.

The reason is that the SEAT ROTATION, not the budget, decides who occupies this
lane: the occupant is `f(clock bucket, author)` within a need tier, so advancing
the clock a week changes the occupant regardless of anyone's budget, and the cap
is second-order. Which means one of two things, and this harness cannot tell
them apart:

  * the refill is genuinely inert at these volumes, or
  * this instrument cannot see it — 10 viewers per panel is ~10 slots against
    20 candidates, so a 3-serve budget rarely binds even repeated 32 times.

Two earlier versions of THIS script produced a confident-looking table that was
wrong, and both are worth knowing about:
  1. the arms advanced the clock by DIFFERENT amounts (`window_days * epoch`, so
     0 for the lifetime arm) — four panels at one instant compared against four
     a week apart, varying two things at once;
  2. one panel per epoch, where the budget never binds at all and both arms are
     identical for a reason that has nothing to do with the window.

Do not quote a refill benefit from this file. Measuring it needs an instrument
where the budget is the binding constraint — which is the multi-epoch harness
the adjudicated design asks for BEFORE the mechanism, and which this is only a
first step toward.
"""
from __future__ import annotations

import contextlib
import importlib.util
import pathlib
import sys
from dataclasses import replace
from datetime import timedelta

_HERE = pathlib.Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))
sys.path.insert(0, str(_HERE.parent.parent.parent))

_spec = importlib.util.spec_from_file_location("_ec", _HERE.parent / "exploration_capture.py")
_ec = importlib.util.module_from_spec(_spec)
with contextlib.suppress(AssertionError):
    # The capture harness gates RED by design at import; we only want its helpers.
    _spec.loader.exec_module(_ec)

from recsys.serve_log import ExplorationServeLog

EPOCHS = 4
#: Days between panels. Must be independent of the window under test, or the
#: arms differ in more than the thing being measured.
EPOCH_GAP_DAYS = 7
#: Panel repeats WITHIN one epoch. ★ Without this the measurement is vacuous:
#: one panel is 10 viewers ≈ 10 exploration slots spread over 20 candidate
#: newcomers, so a 3-serve budget NEVER BINDS and the refill arm is
#: byte-identical to the lifetime arm. Measured that way first, and the
#: identical table was the tell. A budget that never binds cannot be refilled.
PANELS_PER_EPOCH = 8
SEEDS = (7, 11, 23)


def sweep(window_days: int, n_socks: int) -> tuple[float, float]:
    """Mean farm share and mean DISTINCT honest authors reached, accumulated
    across `EPOCHS` panels one window apart, against a single shared log."""
    farm, reached = [], []
    for seed in SEEDS:
        log = ExplorationServeLog()
        seen: set[str] = set()
        shares = []
        for epoch in range(EPOCHS):
            # ★ THE CLOCK ADVANCES IDENTICALLY IN BOTH ARMS. The first version
            # advanced by `window_days * epoch`, which is 0 for the lifetime arm
            # — so that arm ran four panels at ONE instant while the refill arm
            # ran four a week apart, and the comparison varied TWO things. The
            # only variable between arms must be `serve_window_days`.
            at = _ec.NOW + timedelta(days=EPOCH_GAP_DAYS * epoch)
            settings = _ec.harness_settings()
            settings = replace(
                settings,
                exploration=replace(settings.exploration, serve_window_days=window_days),
            )
            for _ in range(PANELS_PER_EPOCH):
                r = _ec.run(seed, n_socks=n_socks, n_honest=20, griefer=False,
                            log=log, now=at, settings_override=settings)
                shares.append(r["farm_share"])
                seen |= set(r["honest_authors"])
        farm.append(sum(shares) / len(shares))
        reached.append(len(seen))
    return sum(farm) / len(farm), sum(reached) / len(reached)


if __name__ == "__main__":
    print(f"REFILLING BUDGET — {EPOCHS} epochs, seeds {SEEDS}, one shared serve log\n")
    print(f"{'window':<12}{'socks':>7}{'farm share':>14}{'distinct honest reached':>26}")
    print("-" * 60)
    for window in (0, 7):
        for socks in (0, 20):
            f, r = sweep(window, socks)
            label = "lifetime" if window == 0 else f"{window}d refill"
            print(f"{label:<12}{socks:>7}{f:>13.1%}{r:>26.1f}")
