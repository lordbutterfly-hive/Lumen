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

★★★ THE RESULT — AND THE FIRST VERSION OF THIS NOTE WAS WRONG.

**Corrected 2026-08-06 after the round-5 council (Seat 1) refuted it.** What
stood here said the refill was byte-identical to the lifetime cap, blamed the
seat rotation, and told the reader "do not quote a refill benefit from this
file". All three were wrong, and the last one was actively harmful — it was a
doc-lie of exactly the class this diff fixed for `serve_log`.

THE BUG WAS IN THIS SCRIPT, NOT IN THE MECHANISM. `exploration_capture._add_post`
stamps every post at absolute `NOW`, while this script advances the clock; the
lane cuts candidates at `now - max_age_days` (7 days). So epochs 1, 2 and 3
served **ZERO** slots — every post had aged out. The arms agreed because three
of four epochs measured nothing at all, which is also why the identical table
looked so clean.

Measured properly (world translated WITH the clock, 4 epochs 8 days apart, one
shared log), distinct honest authors reached per epoch:

    lifetime cap   11.3,  0.0,  0.0,  0.0   -> union 11.3
    7-day refill   11.3, 10.7, 13.7,  9.3   -> union 19.3

**+71% newcomer reach (+75% under farm pressure).** The lifetime cap does not
merely ration the lane — it KILLS it after one epoch, which is what four
councils were objecting to without being able to name.

THE COST IS REAL AND WAS PREDICTED: the farm's budget refills too, so farm share
goes from ~0% (post-exhaustion) to ~26-30% in later epochs. A refilling budget is
strictly more generous to an attacker than a lifetime cap. That trade was
accepted deliberately — see `ExplorationConfig.serve_window_days`.

THREE WRONG VERSIONS OF THIS MEASUREMENT, all worth knowing about:
  1. the arms advanced the clock by DIFFERENT amounts (`window_days * epoch`, so
     0 for the lifetime arm) — four panels at one instant against four a week
     apart, varying two things at once;
  2. one panel per epoch, where the budget never binds and both arms agree for a
     reason unrelated to the window;
  3. posts stamped at a fixed `NOW` while the clock moved, so every epoch after
     the first was empty — and the resulting identical table was reported as a
     finding, with a confident and incorrect causal story attached.

The lesson is not "measure more". It is that **an identical result is a claim
that something did not happen, and needs the same proof as a positive** — in
this case, one line checking that later epochs served any slots at all.
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
