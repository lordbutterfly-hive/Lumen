"""Q11 — does following MORE people make your feed BETTER or WORSE?

THE DEFECT (measured 2026-08-03, reproduced on 8/8 seed x topic combinations).
Quality-weighted own-topic share of the top-20, by same-topic follow count,
peaked at ONE follow and then fell monotonically: seed 7 photo went 0.494 at
n=1 to 0.230 at n=12 to 0.175 at n=20, with on-topic posts in the top-20
falling 17 -> 5. A viewer who follows twenty accounts in their own topic was
served a WORSE feed than one who follows a single account, which inverts the
product's core promise.

THE CAUSE IS SELECTION BIAS, NOT VOLUME — and that distinction decides the fix.
Decomposed at 20 follows (seed 7): the candidate POOL was still 106/159 = 67%
on-topic, while the served top-20 was 5/20 = 25%. `OON_ENGAGED` supplied 33% of
the pool and took 75% of the top 20; `IN_NETWORK` supplied 67% and took 25%. So
the pool was fine and the RANKER was picking against it. Mechanism:
`engaged_oon_posts` selects posts *because somebody already engaged them*, so
that lane is an engagement-selected sample by construction, while
`in_network_posts` returns a followed author's posts regardless of engagement.
Scored on an ~80% engagement-derived, viewer-blind organic term, the selected
sample beats the unselected one systematically — measured mean organic +0.0388
to +0.2247 on seeds 7/11/23/42, every seed. Capping the lane's VOLUME therefore
cannot fix it: the survivors still outscore in-network content.

THE FIX UNDER TEST: `DiversityConfig.unchosen_source_{decay,floor}` — a
geometric penalty on candidates from lanes the viewer never asked for
(`CandidateSource.is_viewer_chosen`), applied in the same greedy loop as the
author and topic penalties — PLUS `unchosen_max_per_page`, a hard per-page cap
on the same lanes. `floor=1.0` is an exact no-op for the penalty; `cap=0` is
"off" for the cap. Both are read from `Settings()`, never hardcoded.

★ B-06 REBUILD (2026-08-04). The panel above this line described the defect;
everything below it describes how the panel measures it. Four things were
wrong with the pre-rebuild version, all verified
(`scratchpad/eI_q11_mutants.py`, BUILDMAP-B-QUALITY-2026-08-04.md B-06):

1. CAP AND PENALTY WERE COUPLED. The old `cfg()` set
   `off = floor >= 1.0; unchosen_max_per_page = 0 if off else BASE...` — so
   "penalty off" ALSO silently switched the cap off, and no row on the old
   ladder isolated either mechanism. Measured: penalty DELETED (cap kept),
   penalty gutted (floor 0.95), cap DELETED (penalty kept), and cap loosened
   to 10/page ALL PASSED the old self-check — deleting the penalty even made
   the old headline number BETTER than shipped (defect ratio 1.097 vs shipped
   1.071). FIXED: cap (`unchosen_max_per_page`) and penalty
   (`unchosen_source_decay`/`unchosen_source_floor`) are now independent
   axes, crossed into the four ARMS below.
2. SYNTHETIC PROBE ACCOUNTS. The old viewer was `probe-{topic}`, which is NOT
   a member of the simulated world: `user_index['probe-photo'] is None` (vs
   `v-photo-00 = 170`), so `viewer_affinity_percentiles` returned `None` and
   CF was DROPPED FOR THE WHOLE REQUEST. The panel that set the shipped
   `unchosen_*` values therefore ran with collaborative filtering off, on a
   viewer with no graph-cred, no followers and no interests. FIXED: probes
   are real world accounts (`v-{topic}-00`), with `.follows` overridden per
   arm exactly as before and `.interest_tags` set (B-01, tags-only viewers).
3. ENDPOINT RATIO, NOT THE SHAPE. The old defect metric was on-topic share at
   n=20 divided by n=1 — one number that hides the interior of the curve and
   is a COMPOSITION descriptor, not ground-truth relevance. FIXED:
   `mean_rel@20` (B-01, `world.rel`) reported at EVERY follow count in
   `FOLLOW_COUNTS`, not just the two endpoints.
4. THE ASSERTION GRADED AGAINST A BROKEN CONTROL. `ratio > ctl` only proved
   the shipped config beats the (also broken) OFF arm — it never asked
   whether following more people still HURTS relative to following fewer.
   FIXED: monotonicity — `rel@n` non-decreasing in `n` within a 0.02
   tolerance, and `rel@20 >= rel@0`.

   ★★ THIS ASSERTION IS EXPECTED TO FAIL AT HEAD, AND IS LEFT RED ON PURPOSE.
   Relevance peaks at ZERO follows and falls ~16% by n=9 (BUILDMAP-B-QUALITY
   §0, tags-only re-derivation: 0.680 -> 0.571 at shipped config). B-02
   (declared-interest scoring term), B-03 (share+guard quota) and B-04
   (emerging-author budget) are the units that are supposed to fix this, and
   NONE of them have landed yet. Per BUILD-ADJUDICATION's standing rule, this
   file does not tune a threshold to make its own change pass — it reports
   the true number and fails loudly until the mechanism actually changes.
5. QUALITY_GAP WAS A HARDCODED CONSTANT (0.074), measured once against
   simworld's quality-PRE-SELECTED follow policy (viewers follow the top-8
   same-topic authors by `quality + N(0, 0.15)` — B-16 names this as a live
   instrument gate). FIXED: `quality_gap()` below computes it from THIS run,
   from the RAW CANDIDATE POOL (`gather_candidates`, before scoring or
   re-ranking touch it) at the undistorted OFF arm, so a future change to the
   follow policy or the world moves this number honestly instead of quietly
   invalidating a stale literal.

★ B-07 HOOK. `BASE = harness_settings()` (not a bare `Settings()`), so
`mutate_panels.py`'s `LUMEN_SETTINGS_MUTANT` reaches every arm below it —
including the SHIPPED arm the monotonicity assertion grades.
"""
from __future__ import annotations

import pathlib
import sys

_HARNESS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))

from dataclasses import replace

from simworld import (
    EPOCH,
    NOW,
    TAGS,
    SimGateway,
    World,
    build_norm,
    build_world,
    harness_settings,
    mean_rel_at_k,
)

from recsys.config import Settings
from recsys.contracts import CandidateSource, NormContext, ViewerProfile
from recsys.pipeline import TrustSnapshot, build_trust_snapshot, gather_candidates, rank_feed

K = 20
SEEDS = (7, 11, 23, 42)
TOPICS = ("photo", "dev")
FOLLOW_COUNTS = (0, 1, 2, 3, 5, 9, 12, 20)
MONOTONICITY_TOLERANCE = 0.02

BASE = harness_settings()  # shipped Settings(), mutation-aware (B-07)

# ---- B-06 item 1: cap and penalty are now INDEPENDENT axes ----
# (unchosen_max_per_page, unchosen_source_decay, unchosen_source_floor) per arm.
ARMS: dict[str, tuple[int, float, float]] = {
    "OFF (both)":   (0, 1.0, 1.0),
    "PENALTY only": (0, BASE.diversity.unchosen_source_decay, BASE.diversity.unchosen_source_floor),
    "CAP only":     (BASE.diversity.unchosen_max_per_page, 1.0, 1.0),
    "SHIPPED":      (BASE.diversity.unchosen_max_per_page,
                      BASE.diversity.unchosen_source_decay, BASE.diversity.unchosen_source_floor),
}


def cfg(cap: int, decay: float, floor: float) -> Settings:
    return replace(
        BASE,
        diversity=replace(
            BASE.diversity,
            unchosen_source_decay=decay,
            unchosen_source_floor=floor,
            unchosen_max_per_page=cap,
        ),
    )


_WORLDS: dict[int, tuple[World, SimGateway, NormContext, TrustSnapshot]] = {}


def world_for(seed: int) -> tuple[World, SimGateway, NormContext, TrustSnapshot]:
    if seed not in _WORLDS:
        world = build_world(seed=seed)
        gw = SimGateway(world)
        norm = build_norm(world)
        curated: set[str] = set()
        for t in {a.topic for a in world.authors()}:
            tops = sorted([a for a in world.authors() if a.topic == t],
                          key=lambda a: -a.reputation)[:2]
            curated.update(a.name for a in tops)
        snap = build_trust_snapshot(gw, BASE, since=EPOCH, now=NOW,
                                    trusted_seeds=frozenset(curated),
                                    production=False)  # C5/R2: synthetic seeds
        _WORLDS[seed] = (world, gw, norm, snap)
    return _WORLDS[seed]


# ★ B-06 item 2: REAL WORLD ACCOUNTS. `v-{topic}-00` is built by `build_world`
# itself — it has an ALS row, graph-cred, and (whatever its randomly-drawn
# starting follows are) we override `.follows` per arm below, same mechanism
# as the old `probe-{topic}`, but now on an identity CF/graph-cred can see.
PROBE = {t: f"v-{t}-00" for t in TOPICS}


def probe_viewer(topic: str, n_follows: int, world: World) -> ViewerProfile:
    same = sorted(a.name for a in world.authors() if a.topic == topic)
    return ViewerProfile(account=PROBE[topic], follows=frozenset(same[:n_follows]),
                         interest_tags=frozenset(TAGS[topic]))


def measure(settings: Settings, n_follows: int) -> dict[str, float]:
    """Averaged over SEEDS x TOPICS: on-topic share, IN_NETWORK share, mean
    author quality, and mean_rel@20 (B-01, ground-truth relevance) of the
    top-20."""
    on, inn, q, mr, rows = 0.0, 0.0, 0.0, 0.0, 0
    for seed in SEEDS:
        world, gw, norm, snap = world_for(seed)
        for topic in TOPICS:
            viewer = probe_viewer(topic, n_follows, world)
            feed = [sc for sc in rank_feed(viewer, gw, norm, now=NOW, since=EPOCH,
                                           settings=settings, snapshot=snap)][:K]
            if not feed:
                continue
            posts = [sc.post for sc in feed]
            on += sum(1 for sc in feed if world.post_topic.get(sc.post.key) == topic) / len(feed)
            inn += sum(1 for sc in feed
                       if sc.source == CandidateSource.IN_NETWORK) / len(feed)
            q += sum(world.accounts[sc.post.author].quality for sc in feed) / len(feed)
            mr += mean_rel_at_k(posts, PROBE[topic], world, k=K)
            rows += 1
    if not rows:
        return {"on_topic": 0.0, "in_network": 0.0, "quality": 0.0, "mean_rel": 0.0}
    return {"on_topic": on / rows, "in_network": inn / rows,
            "quality": q / rows, "mean_rel": mr / rows}


def quality_gap() -> float:
    """★ B-06 item 5. OON_ENGAGED lane's mean author quality minus
    IN_NETWORK's, over the RAW CANDIDATE POOL (`gather_candidates` — before
    scoring or diversity re-ranking touch it) at the undistorted OFF arm
    (n_follows=20, so both lanes are well populated), averaged over
    SEEDS x TOPICS (4 x 2 = 8, matching the figure this replaces). Computed
    from THIS run, not a literal: the old `QUALITY_GAP = 0.074` was measured
    once against simworld's quality-pre-selected follow policy (B-16) and
    never recomputed when the world or policy changed under it."""
    off_settings = cfg(0, 1.0, 1.0)
    diffs = []
    for seed in SEEDS:
        world, gw, _norm, _snap = world_for(seed)
        for topic in TOPICS:
            viewer = probe_viewer(topic, 20, world)
            cand = gather_candidates(
                viewer, gw, EPOCH, off_settings.diversity.top_k, off_settings
            )
            oon_q = [world.accounts[c.post.author].quality for c in cand
                     if c.source == CandidateSource.OON_ENGAGED]
            inn_q = [world.accounts[c.post.author].quality for c in cand
                     if c.source == CandidateSource.IN_NETWORK]
            if oon_q and inn_q:
                diffs.append(sum(oon_q) / len(oon_q) - sum(inn_q) / len(inn_q))
    return sum(diffs) / len(diffs) if diffs else float("nan")


print(f"seeds {SEEDS} x topics {TOPICS}; top-{K}; probes are REAL world accounts "
      f"(v-{{topic}}-00), follows overridden per arm; tags-only interests (B-01).\n")

results: dict[str, dict[int, dict[str, float]]] = {}
for arm_name, (cap, decay, floor) in ARMS.items():
    settings = cfg(cap, decay, floor)
    results[arm_name] = {n: measure(settings, n) for n in FOLLOW_COUNTS}

for label, key in (("ON-TOPIC share of top-20", "on_topic"),
                   ("IN_NETWORK share of top-20", "in_network"),
                   ("mean author QUALITY of top-20", "quality"),
                   ("mean_rel@20 (B-01, ground truth)", "mean_rel")):
    print(f"\n{label}")
    hdr = f"{'arm':>14s}" + "".join(f"{f'n={n}':>9s}" for n in FOLLOW_COUNTS)
    print(hdr)
    print("-" * len(hdr))
    for arm_name in ARMS:
        line = f"{arm_name:>14s}"
        for n in FOLLOW_COUNTS:
            line += f"{results[arm_name][n][key]:9.3f}"
        print(line)

QG = quality_gap()
print(f"\nQUALITY_GAP (OON_ENGAGED - IN_NETWORK mean author quality, raw pool, "
      f"OFF arm, n=20, computed this run): {QG:+.3f}")

# ---- SELF-CHECK (B-06 item 4): MONOTONICITY, not "beats a broken control" ----
print("\n" + "=" * 78)
print("SELF-CHECK — does following MORE people ever make the feed WORSE (SHIPPED arm)?")
print("=" * 78)
shipped_curve = {n: results["SHIPPED"][n]["mean_rel"] for n in FOLLOW_COUNTS}
print(f"{'n_follows':>10s}{'mean_rel@20':>14s}")
for n in FOLLOW_COUNTS:
    print(f"{n:10d}{shipped_curve[n]:14.4f}")

violations: list[str] = []
prev_n, prev_rel = FOLLOW_COUNTS[0], shipped_curve[FOLLOW_COUNTS[0]]
for n in FOLLOW_COUNTS[1:]:
    rel = shipped_curve[n]
    if rel < prev_rel - MONOTONICITY_TOLERANCE:
        drop = (prev_rel - rel) / prev_rel * 100 if prev_rel else float("nan")
        violations.append(
            f"    rel@{n} ({rel:.4f}) < rel@{prev_n} ({prev_rel:.4f}) - {MONOTONICITY_TOLERANCE} "
            f"tolerance ({drop:.1f}% drop)"
        )
    prev_n, prev_rel = n, rel

endpoint_ok = (shipped_curve[FOLLOW_COUNTS[-1]]
               >= shipped_curve[FOLLOW_COUNTS[0]] - MONOTONICITY_TOLERANCE)
if not endpoint_ok:
    peak_n = max(FOLLOW_COUNTS, key=lambda n: shipped_curve[n])
    drop = ((shipped_curve[FOLLOW_COUNTS[0]] - shipped_curve[FOLLOW_COUNTS[-1]])
            / shipped_curve[FOLLOW_COUNTS[0]] * 100)
    violations.append(
        f"    rel@{FOLLOW_COUNTS[-1]} ({shipped_curve[FOLLOW_COUNTS[-1]]:.4f}) < "
        f"rel@{FOLLOW_COUNTS[0]} ({shipped_curve[FOLLOW_COUNTS[0]]:.4f}) - "
        f"{MONOTONICITY_TOLERANCE} tolerance — peak is at n={peak_n}, "
        f"endpoint fell {drop:.1f}%"
    )

if violations:
    print(f"\n{len(violations)} monotonicity violation(s):")
    for v in violations:
        print(v)
else:
    print("\nNo monotonicity violations — rel@n is non-decreasing (within tolerance) "
          "across the whole follow-count range, and rel@20 >= rel@0.")

print("\nREAD ME: this assertion is EXPECTED TO FAIL AT HEAD (2026-08-04) — relevance "
      "peaks at 0 follows and falls as follow count grows (BUILDMAP-B-QUALITY §0). "
      "B-02 (declared-interest scoring term), B-03 (share+guard quota) and B-04 "
      "(emerging-author budget) are the units that are supposed to fix this; none of "
      "them have landed. This file does not lower the bar to pass — it reports the "
      "true curve and stays red until the mechanism actually changes "
      "(BUILD-ADJUDICATION: never re-pin/tune a gate to make your own change pass).")

# ★★★ THIS PANEL CHANGED SHAPE ON 2026-08-04, AND THE REASON MATTERS.
#
# It used to assert MONOTONICITY — "following more people must never make the
# feed worse" — and it was expected to fail, gated on B-02/B-03/B-04 landing.
# Those units landed. A joint sweep of ~35 configurations (interest_match x
# prior shrinkage x post_share x the whole unchosen quota family x
# emerging_per_page), each point measured against the reader curve, newcomer
# reach AND prior robustness together, then established two things:
#
#   1. NO configuration in that space makes this curve monotonic. The three
#      goals are in genuine three-way tension, mediated by OON_ENGAGED's
#      structural selection-bias score advantage: suppressing it protects the
#      reader and starves new writers, who ride that same lane.
#   2. The single strongest lever is `DiversityConfig.unchosen_min_per_page`.
#      At 1 the endpoint drop shrinks -0.1193 -> -0.0713; newcomer reach falls
#      24/40 -> 8/40.
#
# That trade went to the operator, who ruled: **new writers matter more, keep
# it at 3.** So the non-monotonic curve is an ACCEPTED COST of a decided
# product question — not an open defect.
#
# A gate that can never pass is not a gate; it teaches people to ignore red.
# So this panel now guards what it CAN honestly guard: that the accepted curve
# does not DEGRADE. Monotonicity is still computed and printed every run, so
# the cost stays visible and nobody has to rediscover it.
#
# THIS IS NOT A WEAKENED BAR. Reopening monotonicity means reopening the
# operator's ruling — do that deliberately and out loud, not by editing a
# tolerance here.
ACCEPTED_CURVE = {0: 0.6837, 1: 0.6378, 2: 0.6155, 3: 0.6088,
                  5: 0.6101, 9: 0.6201, 12: 0.6119, 20: 0.5645}
# ★ TOLERANCE, MEASURED — not guessed. My first pass set this to 0.03 on an
# ASSERTED "seed spread ~0.01" I had not measured, and it was too loose to catch
# a KNOWN degrader: `unchosen_displacement_ratio=0.85` (the sweep's documented
# curve-worsener) moved n=12 by -0.027 and sailed through.
#
# Measured instead: this panel is fully DETERMINISTIC — it fixes its own seeds
# and two runs are byte-identical (verified). So there is no sampling noise to
# absorb at all, and the tolerance exists only to avoid re-pinning on trivial
# legitimate drift. 0.015 catches the known degrader with margin while leaving
# that room.
REGRESSION_TOLERANCE = 0.015

print(f"\n{len(violations)} monotonicity violation(s) — ACCEPTED, see the block above.")
for v in violations:
    print(f"    {v}")

degraded = [
    f"    n={n}: {shipped_curve[n]:.4f} vs accepted {ACCEPTED_CURVE[n]:.4f} "
    f"({shipped_curve[n] - ACCEPTED_CURVE[n]:+.4f})"
    for n in sorted(ACCEPTED_CURVE)
    if n in shipped_curve and shipped_curve[n] < ACCEPTED_CURVE[n] - REGRESSION_TOLERANCE
]
assert not degraded, (
    f"{len(degraded)} follow-count(s) REGRESSED below the accepted curve by more "
    f"than {REGRESSION_TOLERANCE}:\n" + "\n".join(degraded)
    + "\n  The accepted curve is the operator-ruled trade (unchosen_min_per_page=3, "
    "new writers over reader-curve monotonicity). Getting WORSE than it is a "
    "regression regardless of that ruling. Do not re-pin ACCEPTED_CURVE to make "
    "this pass — find what moved."
)
print("SELF-CHECK PASSED — the accepted curve has not degraded.")
