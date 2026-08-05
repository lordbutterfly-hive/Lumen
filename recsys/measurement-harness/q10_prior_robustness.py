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
    EPOCH,
    NOW,
    TAGS,
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
#
# ★★ COVERAGE GAP FOUND AND CLOSED (2026-08-04, Builder A, joint interest_match
# x q10/q11 sweep). This SEEDS list was chosen to cover auc_own_m5's worst case
# (seed 11) but NEVER covered stack_capture_g's — and this file's OWN docstring
# above cites seeds 2/3/5/6/17 as exactly where stack_capture_g went negative in
# the wider 32-world sample. None of those five are in the list that was here.
# Verified directly (shipped config, interest_match=0.4): seeds 2/3/5/6/17 all
# score stack_capture_g NEGATIVE (-0.0045/-0.0007/-0.0005/-0.0001/-0.0034)
# TODAY, while every seed that WAS in this list stayed non-negative on that
# metric. So the panel's own SELF-CHECK could never have tripped on the exact
# failure mode its docstring describes, by construction of which five worlds it
# happened to sample -- a "regression guard" that structurally cannot see the
# regression it documents is not a guard. Added seeds 2 and 17 (the two most
# negative stack_capture_g worlds in the cited sample) so the panel can now
# actually detect this. This is a COVERAGE fix, not a floor change: the floors
# below are UNTOUCHED, and the panel is expected to (correctly) fail loudly on
# the new seeds at the current shipped `interest_match` -- see this file's
# 2026-08-04 addendum lower in this docstring for why that failure is honest
# and was not "fixed" by re-pinning either the seeds or the floors.
SEEDS = [7, 11, 19, 23, 42, 2, 17]

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
#
# ★ RE-MEASURED 2026-08-04 (B-05) — FLOORS LEFT UNCHANGED, PANEL LEFT RED,
# DELIBERATELY. This session landed `ScoreWeights.interest_match` (B-02),
# `emerging_per_page` (B-04), the `max_share_of_feed` popular-fallback cap
# (C6), and the exploration truncation fix (C3) on top of the AFTER column
# above. Per this panel's own instruction, re-measured the full world
# distribution before touching anything — 32 worlds (seeds 0-30 + 42; the
# exact 31 seeds behind the AFTER/BEFORE table above are not recorded
# anywhere in the repo, so this is a fresh same-sized sample, not a bit-exact
# reproduction — it does already include every seed this panel's own SEEDS
# list gates on):
#
#   metric             AFTER penalty (2026-08-03)   TODAY (2026-08-04, 32 worlds)
#   mean_q          min +0.0110  mean +0.0200      min +0.0024  mean +0.0078
#   stack_capture_g min +0.0044  mean +0.0130      min -0.0045  mean +0.0049
#   auc_own_m5      min -0.0069  mean +0.0140      min -0.0109  mean +0.0174  median +0.0191
#
# CAUSE, DECOMPOSED (not assumed) by constructing each mutant directly on
# seeds 7/11/19/2 and toggling `interest_match`, `max_share_of_feed`,
# exploration and `emerging_per_page` one at a time against the shipped
# baseline (scratch harness, not committed — same method as q6/q7's re-pin
# notes). `emerging_per_page` is again an exact no-op. `max_share_of_feed`
# moves auc_own_m5 a little (the AUC out-of-feed pool shrinking, same
# mechanism q6/q7 found) but not mean_q/stack_capture_g. Exploration has a
# small, mixed effect. `interest_match` is the DOMINANT driver on every
# seed tested — e.g. seed 11: d_mean_q shipped +0.0034, with interest_match
# alone reverted +0.0133 (4x bigger); seed 2: d_stack_capture_g shipped
# **-0.0045 (NEGATIVE)**, with interest_match alone reverted +0.0138 (flips
# sign). Mechanism: `interest_match` is a NEW score-blending term
# (`core/scoring.py::score_candidate`, same blend chain the pooled prior's
# own contribution runs through) that moves scores on much of the SAME
# information the prior does (topically-matched, already-favoured authors) —
# so it front-runs a large share of what the prior used to contribute
# uniquely. This is the THIRD time this exact mechanism has fired on this
# panel (see the unchosen-source-penalty CAUSE note above: "two mechanisms
# now share work one used to do alone") — each new composition-shaping
# mechanism that lands squeezes the prior's remaining marginal headroom
# further.
#
# WHY THIS TIME IS NOT THE SAME CALL AS 2026-08-03's re-derivation, even
# though the mechanism is identical in kind. Last time, `mean_q` stayed
# "essentially UNCHANGED... and positive on 31/31 worlds" while the other two
# columns shrank but STAYED POSITIVE (stack_capture_g min +0.0150->+0.0044,
# still solidly positive) — a "prior still helps everywhere, just by less"
# story, and lowering the floor to match was honest. This time `mean_q`'s own
# min AND mean roughly quartered (not "essentially unchanged"), and
# `stack_capture_g` — the headline decision metric — went NEGATIVE on 5 of 32
# sampled worlds (seeds 2/3/5/6/17; worst -0.0045), meaning on ~1-in-6 sampled
# topologies the pooled author-prior now measurably HURTS delivered quality
# capture, not merely helps less. "Roughly a third to a half of the worst
# observed value" applied literally to a NEGATIVE worst value would either
# require a negative floor (accepting the prior may actively hurt some
# worlds) or an ad hoc positive floor chosen to dodge the negative sample —
# both are exactly the "green lie" this file's own error message warns
# against. Per this panel's own instruction ("the honest outcome may be that
# the floor stays and the panel stays RED — that is an acceptable result"):
# the floors below are LEFT AS THEY WERE, this panel is LEFT RED, and the
# correct next step is for whoever owns `ScoreWeights.interest_match` and the
# pooled author-prior to re-sweep them JOINTLY (the same "re-sweep this field
# jointly once B-05 owns both maps at once" posture `interest_match`'s own
# docstring already anticipates for `unchosen_max_share`) rather than for this
# re-pin to paper over a real, measured loss of cross-world robustness.
# ★★★ 2026-08-04 ADDENDUM (Builder A) -- JOINT SWEEP RESULT, FLOORS LEFT
# UNTOUCHED, PANEL LEFT RED. Per the B-05 note above ("re-sweep
# `interest_match` and the pooled prior JOINTLY"), ran that sweep: a scratch
# harness cross-varied `weights.interest_match` (0.0-0.4), `organic_prior_
# shrinkage` (2/3/5), `organic_post_share` (0.25/1/3/0.45), and the full
# `DiversityConfig.unchosen_*`/`emerging_per_page` quota family (share
# 0.0-0.15, min_per_page 0-3, displacement_ratio 0.0-0.85, emerging 0-5),
# always on THIS panel's own SEEDS (now including the two negative-world
# seeds above) plus the q11 follow-curve panel and a q3/q9-style newcomer
# reach check, together, at every point (not one at a time).
#
# RESULT: no point in that space clears this panel's current floors while
# keeping `interest_match` above ~0.05, and none of the other knobs meaningfully
# help. `interest_match` is confirmed the dominant driver by a wide margin: at
# interest_match=0.0 every floor here clears (barely, mean_mean_q +0.0123 vs a
# 0.012 floor) and newcomer reach (q3/q9-style, 4 seeds x 10 established
# viewers) is 0/40; at 0.4 (shipped) newcomer reach is 24/40 (interest-lane
# established rung) and 40/40 on a true zero-engagement debut (see
# `emerging_per_page`'s own note in config.py), but multiple per-seed floors
# here fail. The other knobs move both axes far less than `interest_match` and
# do not resolve the conflict: raising the unchosen quota's displacement_ratio
# (0.5-0.85) improves this panel's numbers (min mean_q up to +0.0124 at
# interest_match=0.2) but ONLY by reproducing the un-quota'd curve on q11 (its
# own docstring already predicted this) -- it does not free up headroom, it
# just lets `interest_match`-independent OON_ENGAGED selection bias back in,
# which is the q11 defect. Shrinkage and post_share move q10's numbers by
# <0.001 across their tested range at fixed interest_match -- an order of
# magnitude below `interest_match`'s effect.
#
# CONCLUSION, stated plainly: newcomer discoverability (this session's B-02)
# and the pooled prior's measured cross-world robustness (this panel) are in
# DIRECT, UNRESOLVED CONFLICT on this instrument, and no combination of the
# knobs available to this builder closes it. The shipped point
# (interest_match=0.4, quota family at its byte-compatible 2026-08-04 values)
# is the ONLY tested point with both zero negative-world stack_capture_g on the
# PRE-addendum seeds and newcomer reach >=20/40 -- i.e. it is already
# Pareto-optimal for that specific trade among everything tried, which is why
# it was NOT changed here. Per this file's own standing rule ("the honest
# outcome may be that the floor stays and the panel stays RED -- that is an
# acceptable result") and the "never re-pin/re-floor to make your own change
# pass" rule: the floors below are UNCHANGED. Whoever revisits this next should
# treat it as a genuine three-way product trade (reader relevance / newcomer
# reach / prior robustness), not a bug still waiting for the right knob value.
#
# ★★★ 2026-08-05 — RESOLVED, AND THE FLOORS BELOW ARE STILL THE ONES SET ON
# 2026-08-03. NOTHING IN THIS FILE WAS RE-TUNED TO ACHIEVE IT: not a floor, not
# a seed, not `interest_match`. The two addenda above were correct that the
# knob space contained no answer, and wrong about the diagnosis. The conflict
# was not the pooled prior and `interest_match` competing for the same
# information — decomposed over 32 worlds it ran ENTIRELY through the
# re-ranker's MULTIPLICATIVE author-repeat penalty:
#
#   * `interest_match` adds a FLAT per-topic offset to `final` (+0.32 for an
#     on-interest post), and ~89% of a served feed is on-interest. Inside that
#     block every score is lifted into a high, narrow band while the
#     quality-driven spread is simultaneously compressed to 0.6x.
#   * The author/topic/unchosen penalties are RATIO operators (`final * pen`).
#     Lifting the floor and compressing the spread roughly DOUBLED the author
#     penalty's displacement threshold — measured in quality-percentile units
#     it went from ~0.33 to ~0.66. Nobody chose that; it is one term's offset
#     leaking into another term's strength.
#   * The prior's whole job is sharpening quality ORDER, so the prior is
#     exactly what the doubled penalty erased. Proof it was masking and not
#     redundancy: with the author penalty off, the prior is worth +0.0196 at
#     `interest_match=0.4` against +0.0200 at 0.0, and `interest_match` costs
#     own-stratum capture 0.9188 -> 0.9191 — nothing at all.
#
# Fixed at the seam, in three places, none of them a threshold:
#   1. `core/rerank.py::_effective_score` — the author and unchosen-lane
#      penalties discount the EARNED score only, never the declared-interest
#      offset (which is a per-TOPIC constant, so discounting it on an AUTHOR
#      repeat made the author penalty double as a topic penalty). The TOPIC
#      penalty still discounts everything, deliberately — it is the brake that
#      bounds the offset, and exempting it there collapses entropy@20 to 0.159.
#   2. `core/rerank.py::_topic_affinities` — infers affinity from earned mass,
#      closing a loop where the declaration inflated its own topic's mass and
#      that inflation was read back as affinity to switch off its own penalty.
#   3. `core/scoring.py::score_candidate` — the declared-interest term blends
#      the COMPOSITE, not the organic slice, so it no longer silently
#      amplifies vote/reputation 1.67x against the quality percentile the
#      prior lives in. Its contribution to `final` is byte-unchanged.
#
# Measured on the SAME 32 worlds this panel's 2026-08-04 addendum used:
#
#   metric             2026-08-04 (RED)              2026-08-05 (this build)
#   mean_q          min +0.0024  mean +0.0078      min +0.0069  mean +0.0128
#   stack_capture_g min -0.0045  mean +0.0049      min +0.0061  mean +0.0137
#   negative-stack_capture_g worlds: 5 of 32       0 of 32
#
# Every floor below now clears on all seven seeds. If a future change makes
# this panel red again, the standing instruction is unchanged and still binds:
# re-measure the distribution and find out WHICH WORLDS MOVED AND WHY. The
# lesson this round adds is that the answer may not be in this panel's own
# knobs at all — check what else touches the score's SCALE before concluding
# the prior has stopped earning its place.
PER_SEED_MEAN_Q = 0.005          # worst observed +0.0110 (2026-08-03 sample)
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
        gw_off, Settings(), since=EPOCH, now=NOW,
        trusted_seeds=frozenset(curated), production=False,  # C5/R2: synthetic seeds
    )
    panel = panel_for(world)

    def run(gw) -> tuple[dict[str, tuple[float, float]], list[frozenset[str]]]:
        rows, pools = [], []
        for name in panel:
            acct = world.accounts[name]
            viewer = ViewerProfile(
                account=name,
                follows=world.follows[name],
                interest_tags=frozenset(TAGS[acct.topic]),
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
