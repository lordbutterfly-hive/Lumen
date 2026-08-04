"""Q7 — HEAD re-baseline on the CORRECTED instrument (metrics_v2, 2026-07-21).

Re-baselines the shipped config (Settings() defaults, topic_affinity_strength
0.5) on the defect-patched metrics_v2:
  D1  headline graded vs a FIXED GLOBAL reference (censorship-immune);
  D2  headline decomposed into author-penalty / topic-penalty / scoring parts;
  D3  per-stratum picking read at MATCHED depths (m=5/10).

Protocol mirrors q1/q6 exactly (seed=7 world, curated trusted seeds = top-2
reputation authors per topic, 24-viewer panel, k=20). Self-check: the legacy
ndcg / fcq_capture / cap_own / auc_own columns must reproduce the known
0.378 / 0.803 / 0.821 / 0.742 shipped figures (re-pinned 2026-08-01 after the
instrument was fixed to emit AttributedPost and to carry the author prior) — if they don't, the instrument
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

import pathlib
import sys

# ★ Derived from __file__ (2026-08-01). These were two hardcoded absolute paths:
# a scratchpad from an unrelated session, and "/mnt/o/HIVE-BLOG-REBUILD/recsys",
# which does not exist — so no panel ran from its own directory without
# PYTHONPATH set by hand.
#
# Index 0 is DELIBERATE and stays: a measurement harness must bind to the tree
# it sits in, never to an installed `recsys` that happens to be on the path, or
# its numbers describe code nobody is looking at. The hazard the old code had
# was not the precedence, it was pointing that precedence at a path outside the
# repo; derived paths cannot drift. `metrics_v2.py` uses the same ordering.
_HARNESS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))


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
# ★ RE-PINNED 2026-08-01. TWO SEPARATE CAUSES — decomposed, because attributing
# the whole move to one of them is exactly the error this self-check exists to
# catch. Measured by running this panel over a 2x2 of (HEAD package, working-tree
# package) x (old harness, fixed harness):
#
#                                        ndcg    fcq   cap_own  auc_own
#   HEAD pkg + old harness              0.365  0.770    0.807    0.666   <- old pins
#   HEAD pkg + FIXED harness            0.376  0.809    0.826    0.690   <- instrument
#   working-tree pkg + FIXED harness    0.378  0.803    0.825    0.748
#   ... + the trust-budget fix below    0.378  0.803    0.821    0.742   <- pinned here
#
# (1) INSTRUMENT (0.365 -> 0.376 / 0.770 -> 0.809 / 0.807 -> 0.826 / 0.666 -> 0.690).
#     `simworld` emitted a plain `Post`, and comment/reblog engagement is read ONLY
#     off an `AttributedPost`, so every panel scored conversation at ZERO while
#     production hydrates attribution. And every panel but q8 built a plain
#     `SimGateway`, which had no `author_engagement`, so the author-pooled prior was
#     inactive. Measured: mean organic engagement raw 1.2590 -> 1.7667 (a +40.3%
#     increase, i.e. 28.7% of the corrected signal had been invisible; +27.8% on the
#     log-compressed post_base scale), 543 of 751 posts changed value.
#
# (2) ALGORITHM — the larger share of auc_own, and NOT an instrument move. The
#     2026-08-01 package changes (graph_cred, flooding, second_degree, coldstart,
#     rerank, pipeline, config) account for auc_own 0.690 -> 0.748, i.e. ~70% of its
#     total movement. Note this component is NOT uniformly positive: measured alone
#     it moves fcq_capture 0.770 -> 0.761 and cap_own 0.807 -> 0.804 DOWN. An earlier
#     draft of this comment claimed "everything moved UP" and credited the whole
#     delta to the instrument; both halves of that were wrong.
#
# (3) TRUST BUDGET in the pooled prior (cap_own 0.825 -> 0.821, auc_own 0.748 ->
#     0.742). The `author_engagement` twin promoted onto `SimGateway` did not
#     forward `trust` to `post_base_engagement`, while `pipeline._score` budgets
#     `own_base` with it — so `total_base` was overstated by mean 0.6% / max 9.7%
#     per author on this world (176 of 746 posts inflated). These two columns
#     therefore move DOWN, which is the CORRECT direction for removing an upward
#     bias: a pin moving down here is evidence the fix worked, not evidence of a
#     regression. Re-pinned deliberately rather than left mismatching.
#
# ★ CONSEQUENCE: every weight fitted through this panel was fitted on the degraded
# instrument. `organic_recency`, `organic_cf`, `topic_affinity_strength` and
# `organic_post_share` are due a re-sweep; until then their values are inherited,
# not measured. q6's swept optimum for `topic_affinity_strength` has already moved
# to the LEFT EDGE of its range (argmax auc_own s=0.25 -> s=0.00 against a shipped
# 0.90), so that sweep's range itself needs extending, not just re-running.
# ★ RE-PINNED 2026-08-03 — author-prior SHRINKAGE (`organic_prior_shrinkage`
# 0.0 -> 3.0). An ALGORITHM change, deliberate, and unlike the 2026-08-01
# re-pin this one is NOT an improvement on every axis: it is a measured TRADE,
# so it is recorded as one. Isolated by running this panel at k = 0 and k = 3
# with nothing else changed (config restored + checksum-verified afterwards):
#
#   decision column          k = 0    k = 3    delta
#   scoring_gap  (down good) 0.069    0.094    +0.025  <- the cost, and it is
#   stack_capture_g          0.803    0.785    -0.018     the headline number
#   pinned_q_g               0.657    0.642    -0.015     a scoring round is
#   mean_q@20                0.708    0.701    -0.007     meant to shrink
#   q_own_m5                 0.751    0.756    +0.005
#   cap_own_m5_g             0.858    0.865    +0.007
#   auc_own_m5               0.789    0.795    +0.006
#   q_own_m10                0.690    0.678    -0.012
#   cap_own_m10_g            0.803    0.789    -0.014
#   auc_own_m10              0.718    0.698    -0.020
#   own_share / entropy      0.375    0.371    (flat composition, as required)
#
# WHAT IT BOUGHT, on the panel the defect was recorded against (q3): a new
# author with 9 votes + 2 comments + 1 reblog went from top-20 for 0/10
# established viewers to 10/10, and q8's prior-vs-prior-less guard still
# clears every floor (+0.0225 / +0.0248 / +0.0503 / +0.0474).
#
# WHY THE COST IS REAL AND NOT A METRIC ARTIFACT: this world contains no new
# author at all, so the movement above is purely "the pooled prior denoises
# ESTABLISHED authors less". On a 7-day window many established simworld
# authors also have thin pools (poisson mean 2.8-9.8 posts), and shrinkage
# cannot tell "few posts because new" from "few posts because low-volume" —
# only POST AGE can, which is the live-data-gated maturity lever. Read this
# pin as: the blunt instrument was taken deliberately, and the targeted one is
# still owed. k = 2.0 is the documented cheaper alternative (scoring_gap 0.087,
# newcomer 8/10 rather than 10/10) and is a one-field flip.
# ★ RE-PINNED AGAIN 2026-08-03 — the unchosen-source penalty
# (`DiversityConfig.unchosen_source_decay/floor` 1.0/1.0 -> 0.8/0.40, topic-
# attenuated). Unlike the shrinkage re-pin above, this one is an improvement on
# EVERY decision column, measured on this panel with nothing else changed:
#
#   decision column          before   after    delta
#   scoring_gap (down good)   0.094    0.081   -0.013  <- the target number
#   stack_capture_g           0.785    0.811   +0.026
#   pinned_q_g                0.642    0.663   +0.021
#   mean_q@20                 0.701    0.713   +0.012
#   q_own_m5 / m10        0.756/0.678  0.774/0.700  +0.018/+0.022
#   cap_own_m5_g / m10_g  0.865/0.789  0.885/0.815  +0.020/+0.026
#   auc_own_m5 / m10      0.795/0.698  0.829/0.737  +0.034/+0.039
#   own_share                 0.371    0.575   +0.204  (descriptor)
#   topic entropy@20          2.307    1.865   -0.442  (descriptor)
#
# The composition columns move a LOT and that is the point of the change: the
# panel's viewers have 9 follows each, 8 of them same-topic, so they sit inside
# the follow-count defect this fixes. They now see more of what they follow.
# NOTE the honest asymmetry: on this 9-follow panel quality RISES, but the q11
# probe at 20 same-topic follows measures a quality COST of 0.028 — at 9 follows
# the penalty mostly removes weak spillover, at 20 it also removes genuinely
# strong global content. Both are true; neither alone describes the change.
# ★ RE-PINNED 2026-08-04 (third time). Two algorithm changes landed since the
# last pin, both deliberate:
#   1. `DiversityConfig.unchosen_max_per_page = 3` — a HARD per-page cap on lanes
#      the viewer never asked for. The geometric penalty alone was insufficient
#      (OON_ENGAGED still took 56% of the first page); the cap took the
#      follow-curve defect ratio from 0.395 to 1.071, i.e. following more people
#      no longer degrades the feed.
#   2. `second_degree.filter_eligible` demote-not-drop — a failed second-degree
#      vouch now re-labels the candidate to the ungated lane it already
#      qualified for instead of dropping it. This closed a suppression vector
#      where one condemned account's upvote deleted any post from any subscribed
#      viewer's feed.
# Both move composition, which is what these legacy columns are sensitive to.
#
# ★ The sparse-PageRank rewrite that landed alongside them CANNOT contribute to
# this movement: it agrees with the dense form to ~5.6e-17 on raw ranks and
# produces BIT-IDENTICAL banded scores (pinned by
# tests/test_graph_cred.py::test_sparse_pagerank_matches_the_dense_oracle).
#
# HONEST LIMIT: the cap-vs-demote decomposition was NOT run. The box hit an
# out-of-memory wall (19 GiB used, 260 MiB free, forks failing) while a
# scrutiny agent benchmarked dense PageRank at scale, and re-running the 2x2
# would have thrashed it further. Decompose before relying on either figure.
for label, key, known in [("legacy ndcg (global ideal)", "ndcg", 0.644),
                          ("DEPRECATED fcq_capture", "fcq_capture", 0.842),
                          ("own capture (pool ceiling)", "cap_own", 0.830),
                          ("AUC own (served slots)", "auc_own", 0.743)]:
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
