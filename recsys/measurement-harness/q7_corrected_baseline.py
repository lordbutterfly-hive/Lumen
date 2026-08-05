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

import datetime as _dt
import json
import os
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

# ★ B-08 (2026-08-04). The self-check below used to print
# `** MISMATCH — instrument moved **` on a drifted row and exit 0 regardless —
# a red instrument reporting green. Pins now live in a checked-in JSON file
# (not the drifted-values-in-code this replaces) and a mismatch is a real
# assertion failure. `--update-pins` is the ONLY sanctioned way to move them:
# it rewrites the JSON from THIS run's measurements and prints the before/after
# diff to paste into the commit message, so a re-pin is always accompanied by
# a recorded reason. This unit does not call it — re-deriving the pins is
# B-05's job; this unit only makes the gate real.
PINS_PATH = _HARNESS / "pins" / "q7.json"
UPDATE_PINS = "--update-pins" in sys.argv
with open(PINS_PATH) as _f:
    PINS: dict[str, dict[str, object]] = json.load(_f)


from metrics_v2 import (
    DECOMP_CONFIGS,
    aggregate,
    decomposition_settings,
    penalty_decomposition,
    viewer_metrics,
)
from simworld import EPOCH, NOW, TAGS, TOPICS, SimGateway, build_norm, build_world, harness_settings

from recsys.contracts import Post, ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
seeds: set[str] = set()
for t in TOPICS:
    tops = sorted([a for a in world.authors() if a.topic == t], key=lambda a: -a.reputation)[:2]
    seeds.update(a.name for a in tops)
# ★ B-07 (2026-08-04): the shipped base is routed through harness_settings()
# so mutate_panels.py's LUMEN_SETTINGS_MUTANT reaches both the trust snapshot
# and the decomposition configs below. Byte-identical to Settings() when unset.
SHIPPED = harness_settings()
snap = build_trust_snapshot(
    gw, SHIPPED, since=EPOCH, now=NOW, trusted_seeds=frozenset(seeds), production=False
)  # C5/R2: synthetic seeds, not the real curated list

PANEL = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
CONFIGS = decomposition_settings(SHIPPED)  # base = shipped Settings() (mutation-aware)


def viewer_for(name: str) -> ViewerProfile:
    acct = world.accounts[name]
    return ViewerProfile(account=name, follows=world.follows[name],
                         interest_tags=frozenset(TAGS[acct.topic]))


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
#
# ★ RE-PINNED 2026-08-04 (B-05, fourth time). Old pins 0.644 / 0.842 / 0.830 /
# 0.743 (the "third re-pin" above). FIVE things landed on top of that pin in
# this session: `ScoreWeights.interest_match` 0.0->0.4 (B-02), an
# emerging-author budget `DiversityConfig.emerging_per_page` 0->1 (B-04), a
# popular-fallback cap `FallbackConfig.max_share_of_feed` 1.0->0.25 (C6),
# exploration picks no longer silently dropped by `_score`'s internal
# truncation (C3), and communities retired as a candidate-sourcing lane
# (R1/R3). Decomposed on this exact world/panel/snapshot by constructing each
# mutant directly (`dataclasses.replace` on `Settings()`, not the mutant env
# var, so every combination could be checked including the 2-/4-way
# interaction) — scratch harness, not committed:
#
#                                    ndcg    fcq_c  cap_own  auc_own   mean_q  own_share
#   shipped (today, full)           0.740   0.767   0.769    0.619    0.651     0.885
#   interest_match=0.0              0.631   0.818   0.804    0.682    0.685     0.792
#   emerging_per_page=0             0.740   0.767   0.769    0.619    0.651     0.885   <- EXACT no-op
#   max_share_of_feed=1.0 (off)     0.740   0.766   0.768    0.638    0.651     0.885
#   exploration off                 0.752   0.779   0.787    0.644    0.664     0.885
#   ALL FOUR OFF ("yesterday")      0.644   0.837   0.829    0.740    0.704     0.785
#   old pin (pre-session)           0.644   0.842   0.830    0.743      -         -
#
# "ALL FOUR OFF" reproduces the old pin to within 0.0004 / 0.0053 / 0.0009 /
# 0.0034 — i.e. these four causes account for essentially the WHOLE move; no
# fifth unexplained mechanism is needed (residuals are inside this panel's own
# 24-viewer noise floor, std(auc_own) ~0.07 -> SEM ~0.015).
#
# `emerging_per_page` is a MEASURED, EXACT, byte-identical no-op on this
# panel (every column 0.0000 delta) — this world's authors never fall into
# the graph-cred band `_is_emerging` tests for (q7's curated seeds are all
# established, high-reputation authors), so the budget never has anything to
# spend on here. `max_share_of_feed` barely moves ndcg/fcq/cap_own (<=0.001)
# but DOES move auc_own (+0.019 when the cap is off): capping the
# popular-fallback padding SHRINKS the "out of feed" pool auc_own compares
# served posts against (mean pool size 164 capped vs 444 uncapped on this
# world) — a measurement-denominator effect of the new cap, not a picking
# change (confirmed: depth-controlled auc_own_m5 barely moves, +0.001-0.017,
# vs raw auc_own's +0.018-0.124 swing). Communities-lane removal is a
# STRUCTURAL NO-OP here by construction, not merely measured-zero: this
# panel's `viewer_for()` never set `interest_communities` (the field no
# longer even exists on `ViewerProfile`), so the removed lane always received
# an empty set and `community_posts(frozenset(), ...)` always returned `[]`,
# before or after — nothing for the removal to have changed for THIS panel.
#
# VERDICT, per number. All four pinned columns are the DEPRECATED/legacy/raw
# columns metrics_v2's own docstring says to "never chase" (D1-D3: pool-
# ceiling-relative, penalty-dominated, or depth-channel-confounded) — their
# purpose here is drift detection, not a quality judgment, and this decomp
# shows their movement is mechanical: `interest_match` shifts composition
# toward the viewer's own topic (own_share 0.79->0.89), which the
# depth-CONFOUNDED raw cap_own/auc_own/ndcg mechanically reward/punish
# regardless of picking skill (metrics_v2 D3) — confirmed by the
# depth-controlled variants moving 5-10x less than the raw ones
# (cap_own_m5_g +0.007 vs raw cap_own +0.035; auc_own_m10 +0.018 vs raw
# auc_own +0.063, both for interest_match alone). NEUTRAL / explained
# provenance, not itself a quality signal.
#
# The one DECISION-grade, composition-immune column this decomp touches is
# `mean_q`, which is NOT pinned but IS printed below: shipped 0.651 vs
# "yesterday" 0.704, DOWN 0.053, with own_share UP 0.10 in the same
# comparison — the "own-share-up + mean_q-down" pattern this codebase's own
# `organic_viewer` docstring names as its regression signature. Decomposed:
# `interest_match` alone costs 0.034 of that, exploration's now-working C3
# fix costs another 0.013 (residual ~0.006, likely the two compounding).
# Read plainly: this is a REAL, measured quality cost on q7's specific
# panel — but BOTH causes are already-shipped, already-justified product
# decisions made by their own units on OTHER grounds (`interest_match`
# validated on q3's newcomer-reach + q11's monotonicity frontier;
# exploration's cost is the pre-approved, cited YouTube-analog trade dated
# 2026-08-01, not new today — C3 only made the existing, budgeted lane
# actually reach the feed as designed). Not a new algorithmic defect;
# recorded here because q7 is the first panel to price it since they landed.
TOLERANCE = 0.0015
_mismatches: list[tuple[str, str, float, float]] = []
for key, spec in PINS.items():
    # Keys starting with "_" are FILE METADATA, not pins (E4, 2026-08-05):
    # `_provenance` records the previous values, the cause of the last re-pin,
    # and when it happened relative to the code change it followed — the record
    # an auditor needs to tell a verified improvement from a silent re-bless,
    # and which nothing on disk held while this directory was untracked.
    if key.startswith("_"):
        continue
    label, known = str(spec["label"]), float(spec["known"])
    m, _ = base[key]
    ok = abs(m - known) < TOLERANCE
    flag = "OK" if ok else "** MISMATCH — instrument moved **"
    print(f"    {label:32s} {m:6.3f}   (known {known:5.3f})  {flag}")
    if not ok:
        _mismatches.append((key, label, m, known))
print("    NOTE: the round brief also quotes 'quality 0.630'; mean_q@20 on this"
      "\n    panel reads different (see output below) and no reproducible column"
      "\n    matches 0.630 — treat that one brief figure as unpinned provenance.")

if UPDATE_PINS:
    print(f"\n--update-pins: rewriting {PINS_PATH}")
    print("Paste this diff into the commit message:")
    # ★ E4 (2026-08-05) — RE-PINNING NOW RECORDS ITS OWN PROVENANCE.
    #
    # This used to write `{label, known}` and nothing else, so every re-pin
    # destroyed the only copy of the value it replaced. Combined with the pins
    # directory being UNTRACKED in git, that made `--update-pins` completely
    # unauditable: the 2026-08-04 re-pin was in fact a verified improvement
    # (six of seven directions better, checked before updating), but nothing on
    # disk could distinguish it from someone quietly re-blessing a red panel,
    # and the previous values were only recovered from a session transcript
    # that very nearly went with /tmp. Carrying `previous`/`moved` forward means
    # the next auditor reads the delta out of the file itself.
    new_pins: dict[str, object] = {}
    for key, spec in PINS.items():
        if key.startswith("_"):
            continue  # metadata, rebuilt below
        old_known = float(spec["known"])
        new_known = round(base[key][0], 3)
        print(f"    {key:14s} {old_known:.3f} -> {new_known:.3f}"
              f"  (delta {new_known - old_known:+.3f})")
        new_pins[key] = {
            "label": spec["label"],
            "known": new_known,
            "previous": old_known,
            "moved": round(new_known - old_known, 4),
        }
    prior = PINS.get("_provenance", {})
    new_pins["_provenance"] = {
        "repinned_at": _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds"),
        "cause": os.environ.get(
            "RECSYS_REPIN_CAUSE",
            "NOT RECORDED — set RECSYS_REPIN_CAUSE to describe why these moved. "
            "q7's own assert message requires re-pinning to be a deliberate act "
            "with the cause recorded; an unexplained re-pin is the thing this "
            "field exists to make visible.",
        ),
        "supersedes": prior.get("repinned_at") if isinstance(prior, dict) else None,
    }
    with open(PINS_PATH, "w") as _f:
        json.dump(new_pins, _f, indent=2)
        _f.write("\n")

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

# ★ B-08 gate, checked LAST so the full diagnostic report above always prints
# (the "must not regress" requirement) — a pin mismatch is a real failure, but
# it must not swallow the numbers a human needs to diagnose WHY it mismatched.
if not UPDATE_PINS and _mismatches:
    detail = "\n".join(
        f"      {key:14s} measured {m:.3f} vs pinned {known:.3f} (delta {m - known:+.3f})"
        for key, label, m, known in _mismatches
    )
    raise AssertionError(
        f"{len(_mismatches)} of {len(PINS)} q7 pins drifted from {PINS_PATH}:\n{detail}\n"
        "The instrument moved (or the algorithm did) and nothing above is comparable "
        "to prior rounds until re-pinned. Re-pinning is a separate, deliberate act "
        "(B-05) with the cause recorded — it is not this assert's job. To accept a "
        "legitimate move, record why it moved, then regenerate with:\n"
        "    python3 measurement-harness/q7_corrected_baseline.py --update-pins"
    )
