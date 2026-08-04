"""Q10 — is the author-pooled prior's benefit ROBUST ACROSS WORLDS, or is it a
property of seed 7?

WHY THIS EXISTS. q8 asserts the pooled prior beats the prior-less fallback by
fixed margins — on ONE world (seed 7). Measured 2026-08-03 over 31 worlds at
the shipped configuration:

    metric            min      p10    median     mean      max
    auc_own_m5     -0.0176  -0.0040  +0.0253  +0.0210  +0.0503   <- seed 7 IS the max
    mean_q         +0.0104  +0.0138  +0.0214  +0.0211  +0.0310
    stack_capture  +0.0150  +0.0199  +0.0289  +0.0291  +0.0440

**Seed 7 is the single most favourable world in the sample on the auc_own_m5
axis, and q8's 0.020 floor for that axis is cleared by only 16 of 31 worlds.**
On seed 11 the prior is outright NEGATIVE there (-0.0176). q8 is therefore a
regression guard for one world, which is a fine thing to be, but it must not be
read as evidence the prior helps everywhere — and a change that helps seed 7
while hurting the rest would sail straight through it. (That nearly happened:
the 2026-08-03 shrinkage sweep's k=5 candidate passed the seed-7 q8 panel and
failed on seed 42.)

WHAT SURVIVED THE WIDER SAMPLE. The prior's contribution to DELIVERED QUALITY
is robust: `mean_q` and `stack_capture_g` are positive on 31 of 31 worlds. It
is specifically `auc_own_m5` -- depth-controlled within-stratum selection --
that is world-dependent. The prior is not in doubt; that one metric's floor is.

WHAT THIS PANEL ASSERTS, and why these thresholds. Per-seed floors sit at
roughly a third to a half of the WORST observed value, so ordinary re-tuning
cannot trip them and only a real regression can; the distribution checks sit
near the measured median. auc_own_m5 gets a CATASTROPHE floor rather than a
contribution floor, because the 31-world sample says a mildly negative value on
some topology is normal for it, not a defect.

NOT A REPLACEMENT FOR q8 -- q8 keeps its detailed single-world table and its
penalty decomposition. This is the breadth counterpart. Run both.
"""
from __future__ import annotations

import pathlib
import sys

_HARNESS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))

import numpy as np
from metrics_v2 import aggregate, viewer_metrics
from simworld import (
    COMMUNITY,
    EPOCH,
    NOW,
    TOPICS,
    PriorlessSimGateway,
    SimGateway,
    build_norm,
    build_world,
)

from recsys.config import DiversityConfig, Settings
from recsys.contracts import ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

BIG = 100_000
SETTINGS = Settings(diversity=DiversityConfig(top_k=BIG))

# Fixed for determinism. Deliberately includes seed 7 (continuity with q8) AND
# seed 11 (the world where auc_own_m5 goes negative) -- a robustness panel that
# quietly omitted its own worst case would be measuring nothing.
SEEDS = [7, 11, 19, 23, 42]

# ★ FLOORS RE-DERIVED 2026-08-03, and the reason matters more than the numbers.
# They were first set from a 31-world sweep taken BEFORE
# `DiversityConfig.unchosen_source_{decay,floor}` existed. Turning that penalty
# on (0.8/0.40) made this panel fail on seed 19 (stack_cap +0.0047 vs a 0.005
# floor). Per this file's own instruction I re-measured all 31 worlds rather
# than nudging the floor, and the whole distribution had moved:
#
#   metric             BEFORE penalty                AFTER penalty (shipped)
#   mean_q          min +0.0104 mean +0.0211      min +0.0110 mean +0.0200
#   stack_capture_g min +0.0150 mean +0.0291      min +0.0044 mean +0.0130
#   auc_own_m5      min -0.0176 mean +0.0210      min -0.0069 mean +0.0140
#
# CAUSE, and it is not the prior breaking: the unchosen-source penalty decides
# more of the feed's composition STRUCTURALLY, so there is less headroom left
# for the pooled prior to change which posts get served. Its MARGINAL
# contribution shrinks while its absolute job is unaffected — which is exactly
# what the numbers say: `mean_q`, the anti-gaming anchor, is essentially
# UNCHANGED (min +0.0104 -> +0.0110) and positive on 31/31 worlds, while the
# composition-sensitive columns halve. Two mechanisms now share work one used
# to do alone.
#
# Floors below are re-derived from the AFTER column on the same principle as
# before (roughly a third to a half of the worst observed value), so this panel
# still catches a prior that has genuinely stopped contributing.
PER_SEED_MEAN_Q = 0.005          # worst observed +0.0110
PER_SEED_STACK_CAP = 0.002       # worst observed +0.0044 (was +0.0150 pre-penalty)
PER_SEED_AUC_CATASTROPHE = -0.025  # worst observed -0.0069; a floor, not a target
MEDIAN_AUC = 0.007               # measured median +0.0136
MEAN_MEAN_Q = 0.012              # measured mean +0.0200


def panel_for(world) -> list[str]:
    return [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]


def run_seed(seed: int) -> dict[str, float]:
    world = build_world(seed=seed)
    norm = build_norm(world)
    curated: set[str] = set()
    for t in TOPICS:
        tops = sorted([a for a in world.authors() if a.topic == t], key=lambda a: -a.reputation)[:2]
        curated.update(a.name for a in tops)
    gw_off = PriorlessSimGateway(world)
    gw_on = SimGateway(world)
    # One snapshot, shared by both runs: the prior changes SCORING only, so any
    # delta below cannot be a candidate-gathering artifact.
    snap = build_trust_snapshot(
        gw_off, Settings(), since=EPOCH, now=NOW, trusted_seeds=frozenset(curated)
    )
    panel = panel_for(world)

    def run(gw) -> tuple[dict[str, tuple[float, float]], list[frozenset[str]]]:
        rows, pools = [], []
        for name in panel:
            acct = world.accounts[name]
            viewer = ViewerProfile(
                account=name,
                follows=world.follows[name],
                subscribed_communities=frozenset({COMMUNITY[acct.topic]}),
            )
            full = [
                sc.post
                for sc in rank_feed(viewer, gw, norm, now=NOW, since=EPOCH,
                                    settings=SETTINGS, snapshot=snap)
            ]
            pools.append(frozenset(p.key for p in full))
            rows.append(viewer_metrics(world, name, full))
        return aggregate(rows), pools

    off, off_pools = run(gw_off)
    on, on_pools = run(gw_on)
    assert off_pools == on_pools, (
        f"seed {seed}: pool sets differ between prior ON and OFF — the prior must "
        "change scoring only, so a measured delta here would be a gathering artifact"
    )
    return {
        "auc_own_m5": on["auc_own_m5"][0] - off["auc_own_m5"][0],
        "mean_q": on["mean_q"][0] - off["mean_q"][0],
        "stack_capture_g": on["stack_capture_g"][0] - off["stack_capture_g"][0],
        "ctl_auc": off["auc_own_m5"][0],
    }


print(f"world seeds: {SEEDS}   (shipped Settings, k=20 protocol, prior ON vs OFF)")
print("pool-set invariance asserted per seed.\n")
hdr = f"{'seed':>6s}{'d mean_q':>11s}{'d stack_cap':>13s}{'d auc5':>10s}{'ctl auc5':>11s}"
print(hdr)
print("-" * len(hdr))

results: list[dict[str, float]] = []
for seed in SEEDS:
    r = run_seed(seed)
    results.append(r)
    print(f"{seed:6d}{r['mean_q']:+11.4f}{r['stack_capture_g']:+13.4f}"
          f"{r['auc_own_m5']:+10.4f}{r['ctl_auc']:11.4f}")

mq = [r["mean_q"] for r in results]
sc = [r["stack_capture_g"] for r in results]
auc = [r["auc_own_m5"] for r in results]

print(f"\n{'':6s}mean_q: mean {np.mean(mq):+.4f}  min {min(mq):+.4f}")
print(f"{'':6s}stack_cap: mean {np.mean(sc):+.4f}  min {min(sc):+.4f}")
print(f"{'':6s}auc5:   median {np.median(auc):+.4f}  mean {np.mean(auc):+.4f}  min {min(auc):+.4f}")

print("\nSELF-CHECK — the prior's benefit must hold ACROSS worlds, not just on seed 7:")
checks: list[tuple[str, float, float, str]] = []
for seed, r in zip(SEEDS, results, strict=True):
    checks.append((f"seed {seed} mean_q delta", r["mean_q"], PER_SEED_MEAN_Q, "gt"))
    checks.append((f"seed {seed} stack_cap delta", r["stack_capture_g"], PER_SEED_STACK_CAP, "gt"))
    checks.append((f"seed {seed} auc5 not catastrophic", r["auc_own_m5"],
                   PER_SEED_AUC_CATASTROPHE, "gt"))
checks.append(("median auc5 across worlds", float(np.median(auc)), MEDIAN_AUC, "gt"))
checks.append(("mean mean_q across worlds", float(np.mean(mq)), MEAN_MEAN_Q, "gt"))

failed = [c for c in checks if not c[1] > c[2]]
for label, value, floor, _ in checks:
    print(f"    {label:36s} {value:+.4f}  (must be > {floor:+.3f})  "
          f"{'OK' if value > floor else '** FAIL **'}")
for label, value, floor, _ in checks:
    assert value > floor, (
        f"{label} = {value:+.4f} did not clear {floor:+.3f} — the pooled prior's "
        "benefit is no longer robust across worlds. Do NOT relax this by editing the "
        "floor: re-measure the 31-world distribution first (the numbers are in this "
        "file's docstring) and find out which worlds moved and why."
    )
print("\nALL SELF-CHECKS PASSED — the prior's delivered-quality benefit holds on every "
      "world in the panel, and auc_own_m5 stays inside its measured band.")
