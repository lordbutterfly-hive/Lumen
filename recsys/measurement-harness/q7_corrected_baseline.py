"""Q7 — HEAD re-baseline on the CORRECTED instrument (metrics_v2, 2026-07-21).

Re-baselines the shipped config (Settings() defaults, topic_affinity_strength
0.5) on the defect-patched metrics_v2:
  D1  headline graded vs a FIXED GLOBAL reference (censorship-immune);
  D2  headline decomposed into author-penalty / topic-penalty / scoring parts;
  D3  per-stratum picking read at MATCHED depths (m=5/10).

Protocol mirrors q1/q6 exactly (seed=7 world, curated trusted seeds = top-2
reputation authors per topic, 24-viewer panel, k=20). Self-check: the legacy
ndcg / fcq_capture / cap_own / auc_own columns must reproduce the known
0.365 / 0.770 / 0.807 / 0.666 shipped figures — if they don't, the instrument
moved and no number below is comparable to prior rounds.

RE-PINNED 2026-07-22 (post-PRUNED fix-loop): the anti-sybil fix-loop shifted
the composition, moving all four legacy columns. This was an ALGO change (a
legitimate improvement — cap_own/auc_own up, only nDCG down, which we never
optimise), NOT an instrument move. See the self-check block below for the full
provenance and the prior pins.

CALIBRATION CAVEAT: simworld engagement is cleanly topic-structured; real
Hive noise weakens every personalization/CF magnitude. Mechanisms and signs
are reliable; exact figures are directional.
"""
from __future__ import annotations

import sys

sys.path.insert(0, "/mnt/o/HIVE-BLOG-REBUILD/recsys/measurement-harness")

from metrics_v2 import (
    DECOMP_CONFIGS,
    aggregate,
    decomposition_settings,
    penalty_decomposition,
    viewer_metrics,
)
from simworld import COMMUNITY, EPOCH, NOW, TOPICS, SimGateway, build_norm, build_world

from recsys.config import Settings
from recsys.contracts import Post, ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
seeds: set[str] = set()
for t in TOPICS:
    tops = sorted([a for a in world.authors() if a.topic == t], key=lambda a: -a.reputation)[:2]
    seeds.update(a.name for a in tops)
snap = build_trust_snapshot(gw, Settings(), since=EPOCH, now=NOW, trusted_seeds=frozenset(seeds))

PANEL = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
CONFIGS = decomposition_settings()  # base = shipped Settings()


def viewer_for(name: str) -> ViewerProfile:
    acct = world.accounts[name]
    return ViewerProfile(account=name, follows=world.follows[name],
                         subscribed_communities=frozenset({COMMUNITY[acct.topic]}))


print(f"world: {len(world.posts)} posts, {len(world.accounts)} accounts; "
      f"panel {len(PANEL)} viewers; k=20; q1/q6 protocol (curated seeds)")
print("CAVEAT: synthetic engagement is cleanly topic-structured — signs reliable, "
      "figures directional.\n")

# full preference orders for all four decomposition configs, per viewer
orders: dict[str, dict[str, list[Post]]] = {name: {} for name in PANEL}
for cfg_name in DECOMP_CONFIGS:
    s = CONFIGS[cfg_name]
    for name in PANEL:
        full = [sc.post for sc in rank_feed(viewer_for(name), gw, norm, now=NOW,
                                            since=EPOCH, settings=s, snapshot=snap)]
        orders[name][cfg_name] = full

# validity condition for every AUC comparison: pool SET identical across configs
for name in PANEL:
    ref_keys = frozenset(p.key for p in orders[name]["base"])
    for cfg_name in DECOMP_CONFIGS:
        keys = frozenset(p.key for p in orders[name][cfg_name])
        assert keys == ref_keys, f"pool set differs for {name}/{cfg_name}"
print("pool-set invariance across all 4 configs: OK (AUC columns valid)\n")

base_rows = [viewer_metrics(world, name, orders[name]["base"]) for name in PANEL]
base = aggregate(base_rows)
decomp_rows = [penalty_decomposition(world, name, orders[name]) for name in PANEL]
decomp = aggregate(decomp_rows)

print("SELF-CHECK vs prior-round shipped figures (must reproduce):")
# Pins RE-PINNED 2026-07-22 (post-PRUNED fix-loop). Previous pins
# 0.396 / 0.762 / 0.801 / 0.654 were captured mid-day; the subsequent
# anti-sybil PRUNED fix-loop (H02 outside_engaged gate, H05 breadth-budget SQL,
# C1/C2 ALS budget, H01 fail-closed on recsys.core.vote_signal / .scoring /
# .als / .pipeline) shifted the composition these legacy columns are sensitive
# to. This is an ALGO change, NOT an instrument move — and it is a legitimate
# improvement, not a regression: the two decision-adjacent columns rose
# (cap_own 0.801->0.807, auc_own 0.654->0.666) and only ndcg fell
# (0.396->0.365), which is by design (we never optimise nDCG; the standing bar
# is mean_q@20 + own-stratum AUC, both up/flat — the Opus council verified the
# organic-term win survives the forced-composition control). Re-measured 3x
# (PYTHONHASHSEED 0/1/42) — bit-identical every run.
for label, key, known in [("legacy ndcg (global ideal)", "ndcg", 0.365),
                          ("DEPRECATED fcq_capture", "fcq_capture", 0.770),
                          ("own capture (pool ceiling)", "cap_own", 0.807),
                          ("AUC own (served slots)", "auc_own", 0.666)]:
    m, _ = base[key]
    flag = "OK" if abs(m - known) < 0.0015 else "** MISMATCH — instrument moved **"
    print(f"    {label:32s} {m:6.3f}   (known {known:5.3f})  {flag}")
print("    NOTE: the round brief also quotes 'quality 0.630'; mean_q@20 on this"
      "\n    panel reads different (see output below) and no reproducible column"
      "\n    matches 0.630 — treat that one brief figure as unpinned provenance.")

print("\nCORRECTED HEAD BASELINE (shipped config):")
HEAD_ROWS = [
    ("HEADLINE stack capture (global ref)", "stack_capture_g"),
    ("         delivered q @pinned comp", "pinned_q_g"),
    ("         global reference quality", "q_gref"),
    ("QUALITY  mean author q @20 (served)", "mean_q"),
    ("DEPTH-OK own q, first 5 prefs", "q_own_m5"),
    ("         own q, first 10 prefs", "q_own_m10"),
    ("         own capture@5 vs global", "cap_own_m5_g"),
    ("         own capture@10 vs global", "cap_own_m10_g"),
    ("         sec q, first 5 prefs", "q_sec_m5"),
    ("         oth q, first 5 prefs", "q_oth_m5"),
    ("         own AUC, first 5 prefs", "auc_own_m5"),
    ("         own AUC, first 10 prefs", "auc_own_m10"),
    ("RAW(D3!) own-slot q achieved", "q_own"),
    ("         own capture (pool ceiling)", "cap_own"),
    ("         AUC own (served slots)", "auc_own"),
    ("COMPOSN  own-topic share @20", "own_share"),
    ("DIVERSE  topic entropy @20 (bits)", "entropy"),
    ("         distinct authors @20", "authors"),
]
for title, key in HEAD_ROWS:
    m, sd = base[key]
    print(f"    {title:38s} {m:6.3f}  (sd {sd:5.3f})")

print("\nPENALTY DECOMPOSITION of the headline (D2 — permanent report):")
DEC_ROWS = [
    ("stack capture, shipped stack", "capture_base"),
    ("  ... author penalty OFF", "capture_no_author"),
    ("  ... topic penalty OFF", "capture_no_topic"),
    ("  ... ALL diversity OFF", "capture_no_div"),
    ("author-penalty cost (POLICY hold)", "author_pen_cost"),
    ("topic-penalty cost", "topic_pen_cost"),
    ("penalty interaction", "pen_interaction"),
    ("SCORING GAP (organic-term target)", "scoring_gap"),
]
for title, key in DEC_ROWS:
    m, sd = decomp[key]
    print(f"    {title:38s} {m:6.3f}  (sd {sd:5.3f})")

print("\nREAD ME: the headline includes the diversity-penalty costs by design.")
print("A scoring-term change is judged on: scoring_gap (down = better), "
      "mean_q, q_own_m5/m10, cap_own_m*_g, auc_own_m5/m10 (up = better).")
print("Deprecated fcq_* and raw per-stratum/ndcg columns are NOT decision "
      "numbers — see the metrics_v2 module docstring defect ledger.")
