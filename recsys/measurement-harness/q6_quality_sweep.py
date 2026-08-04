"""Q6 — quality-vs-composition re-baseline over topic_affinity_strength.

Runs the metrics_v2 vector for the 24-viewer panel (q1's sample) at
``topic_affinity_strength`` in {0, .25, .5, .75, .9, 1.0} + the shipped value, plus the
all-diversity-off reference, then the q5[A] session-feedback loop per config
on a 6-viewer subpanel. Prints the verdict the last round couldn't answer:
on the quality axis, is the SHIPPED value better than the 0.0 baseline?
(The shipped value is read from `Settings()`, never hardcoded — see STRENGTHS.)

Setup mirrors q1_personalization.py exactly (seed=7 world, curated trusted
seeds = top-2 reputation authors per topic), so the legacy nDCG column must
reproduce its pinned figures at s=0.00 / s=0.90 / noDiv — that reproduction is
the instrument's self-check, and as of 2026-08-03 it is actually RUN (see
NDCG_PINS below) rather than only asserted in this docstring. Note s=0.90 is
NOT the shipped value any more; it is simply the grid point those legacy
figures were captured at. The shipped value is read from ``Settings()``.
This script pins its imports to the harness directory (an instrument should
not silently pick up scratchpad overrides).

REFRESHED 2026-07-22 (previous pins: 0.344 / 0.534 / 0.675 — captured before
a later hardening pass on recsys.core.vote_signal / recsys.core.scoring /
recsys.pipeline shifted the composition this legacy column is sensitive to;
see the round's drift-cause note). Re-measured 3x (fresh process each time,
PYTHONHASHSEED unset and fixed at 0/1/2/42) — bit-identical every run.

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


import numpy as np
from metrics_v2 import aggregate, session_overlap_loop, viewer_metrics
from simworld import COMMUNITY, EPOCH, NOW, TOPICS, SimGateway, build_norm, build_world

from recsys.config import DiversityConfig, Settings
from recsys.contracts import ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

# ★ THE SHIPPED VALUE IS DERIVED, NOT HARDCODED (2026-08-03). This file's
# verdict block compared s=0.00 against a literal "s=0.90 SHIPPED" — and the
# shipped default is now 0.5 (`DiversityConfig.topic_affinity_strength`), so the
# panel was reporting a verdict on a configuration nobody ships, under a heading
# that said it was shipped. Reading it from `Settings()` means it can never go
# stale again, and the assert below refuses to run rather than silently sweeping
# a grid that omits the value actually in production.
SHIPPED_S = Settings().diversity.topic_affinity_strength
STRENGTHS = sorted({0.0, 0.25, 0.5, 0.75, 0.9, 1.0, SHIPPED_S})
BIG = 100_000  # top_k beyond any pool size -> full preference order (prefix-stable)

world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
seeds: set[str] = set()
for t in TOPICS:
    tops = sorted([a for a in world.authors() if a.topic == t], key=lambda a: -a.reputation)[:2]
    seeds.update(a.name for a in tops)
snap = build_trust_snapshot(gw, Settings(), since=EPOCH, now=NOW, trusted_seeds=frozenset(seeds))

PANEL = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
SUBPANEL = [f"v-{t}-00" for t in TOPICS]


def viewer_for(name: str) -> ViewerProfile:
    acct = world.accounts[name]
    return ViewerProfile(account=name, follows=world.follows[name],
                         subscribed_communities=frozenset({COMMUNITY[acct.topic]}))


def cfg(strength: float) -> Settings:
    return Settings(diversity=DiversityConfig(topic_affinity_strength=strength, top_k=BIG))


CONFIGS: list[tuple[str, Settings]] = [(f"s={s:.2f}", cfg(s)) for s in STRENGTHS]
CONFIGS.append(("noDiv", Settings(diversity=DiversityConfig(
    author_decay=1.0, author_floor=1.0, topic_decay=1.0, topic_floor=1.0, top_k=BIG))))

print(f"world: {len(world.posts)} posts, {len(world.accounts)} accounts; "
      f"panel {len(PANEL)} viewers; k=20; snapshot w/ curated seeds (q1 protocol)")
print("CAVEAT: synthetic engagement is cleanly topic-structured; real-Hive noise "
      "weakens every personalization/CF magnitude — signs reliable, figures directional.\n")

results: dict[str, dict[str, tuple[float, float]]] = {}
per_viewer: dict[str, list[dict[str, float]]] = {}
pool_check: dict[str, frozenset[str]] = {}
for label, s in CONFIGS:
    rows = []
    for name in PANEL:
        full = [sc.post for sc in rank_feed(viewer_for(name), gw, norm, now=NOW, since=EPOCH,
                                            settings=s, snapshot=snap)]
        if name == PANEL[0]:
            keys = frozenset(p.key for p in full)
            pool_check.setdefault("ref", keys)
            assert keys == pool_check["ref"], f"pool set differs for {label}"
        rows.append(viewer_metrics(world, name, full))
    per_viewer[label] = rows
    results[label] = aggregate(rows)

ROWS = [
    ("LEGACY  ndcg (global ideal)", "ndcg"),
    ("        ndcg ceiling on pool", "ndcg_ceiling_pool"),
    ("        regret vs pool ceiling", "regret"),
    ("        ndcg @ fixed own comp", "ndcg_fixed_comp"),
    ("QUALITY mean author q @20", "mean_q"),
    ("        q of rel-ideal top-20", "q_rel_ideal"),
    ("        own-slot q achieved", "q_own"),
    ("        own-slot q ceiling", "ceil_q_own"),
    ("        own capture", "cap_own"),
    ("        off-slot q achieved", "q_off"),
    ("        off-slot q ceiling", "ceil_q_off"),
    ("        off capture", "cap_off"),
    ("        AUC own (in vs out)", "auc_own"),
    ("        AUC off (in vs out)", "auc_off"),
    ("FIXED   fcq quality (pinned comp)", "fcq_q"),
    ("COMP    fcq capture  <- headline", "fcq_capture"),
    ("COMPOSN own-topic share @20", "own_share"),
    ("        own slots @20", "n_own"),
    ("DIVERSE topic entropy @20 (bits)", "entropy"),
    ("        distinct authors @20", "authors"),
]

# ★ THE SELF-CHECK IS NOW RUN, NOT JUST CLAIMED (2026-08-03). This file's
# docstring asserted that the legacy ndcg column "must reproduce" three known
# figures and called that "the instrument's self-check" — but no code ever
# compared them, so when they drifted nobody found out. They HAD drifted, on
# both counts below. q7 prints exactly this kind of OK/MISMATCH line; this is
# the same convention, applied to the pins this file already documented.
#
# RE-PINNED 2026-08-03. Old pins 0.355 / 0.439 / 0.630 (s=0.00 / s=0.90 / noDiv),
# captured 2026-07-22. Decomposed by re-running this panel at
# `organic_prior_shrinkage` 0.0 and 3.0 with nothing else changed (config
# restored + checksum-verified afterwards):
#
#                          s=0.00   s=0.90    noDiv
#   old pin (2026-07-22)    0.355    0.439    0.630
#   k=0 today              0.335    0.416    0.616   <- PRE-EXISTING drift
#   k=3 today (shipped)    0.339    0.422    0.581   <- + author-prior shrinkage
#
# So MOST of the drift on s=0.00/s=0.90 is pre-existing: the 2026-08-01
# instrument fix (simworld emitting AttributedPost, the author prior becoming
# active outside q8) moved every panel, and q7 was re-pinned for it while q6
# was not. The 2026-08-03 shrinkage change is the smaller part there (+0.004 /
# +0.006) but dominates the noDiv column (-0.035). nDCG is never optimised in
# this project — it is recorded as legacy provenance, so a fall here is not by
# itself a regression; the decision columns are elsewhere in this table.
# ★ RE-PINNED AGAIN 2026-08-03 for the unchosen-source penalty
# (`DiversityConfig.unchosen_source_*` 1.0/1.0 -> 0.8/0.40). Old pins 0.339 /
# 0.422 / 0.581. nDCG rises sharply here because the penalty shifts composition
# toward the viewer's own topic and this legacy column rewards that — which is
# exactly why this project does NOT optimise nDCG and treats it as provenance
# only. The decision columns for that change are recorded in q7's re-pin note;
# the panel that judges it is q11_follow_curve.
NDCG_PINS = [("s=0.00", 0.459), ("s=0.90", 0.580), ("noDiv", 0.782)]
print("\nSELF-CHECK — legacy ndcg vs recorded pins (see the note above for the "
      "decomposition):")
for key, known in NDCG_PINS:
    got = results[key]["ndcg"][0]
    flag = "OK" if abs(got - known) < 0.0015 else "** MISMATCH — instrument moved **"
    print(f"    ndcg @ {key:8s} {got:6.3f}   (known {known:5.3f})  {flag}")

labels = [label for label, _ in CONFIGS]
hdr = "metric".ljust(34) + "".join(f"{lb:>9s}" for lb in labels)
print(hdr)
print("-" * len(hdr))
for title, key in ROWS:
    line = title.ljust(34)
    for lb in labels:
        m, _ = results[lb][key]
        line += f"{m:9.3f}"
    print(line)
print("\nstd over panel (same rows):")
for title, key in ROWS:
    line = title.ljust(34)
    for lb in labels:
        _, sd = results[lb][key]
        line += f"{sd:9.3f}"
    print(line)

# ---- session-over-session feedback loop (q5[A] protocol, 6-viewer subpanel) ----
print("\n5-session feedback loop (q5[A] protocol; overlap@20 of consecutive sessions;"
      f" {len(SUBPANEL)} viewers x 4 transitions):")
for label, s in CONFIGS:
    div = s.diversity
    loop_s = Settings(diversity=DiversityConfig(
        author_decay=div.author_decay, author_floor=div.author_floor,
        topic_decay=div.topic_decay, topic_floor=div.topic_floor,
        topic_affinity_strength=div.topic_affinity_strength))  # shipped top_k
    all_ov: list[int] = []
    for name in SUBPANEL:
        all_ov.extend(session_overlap_loop(loop_s, name))
    frozen = sum(1 for o in all_ov if o == 20)
    print(f"    {label:8s}: mean overlap {np.mean(all_ov):5.2f}/20, min {min(all_ov):2d}, "
          f"frozen (20/20) {frozen}/{len(all_ov)}")

# ---- the verdict the last round couldn't answer ----
SHIPPED_KEY = f"s={SHIPPED_S:.2f}"
assert SHIPPED_KEY in results, (
    f"the shipped topic_affinity_strength ({SHIPPED_S}) was not swept — "
    f"have {sorted(results)}. Refusing to print a verdict that skips production."
)
a, b = results["s=0.00"], results[SHIPPED_KEY]
print(f"\nVERDICT — shipped {SHIPPED_KEY} vs s=0.00 baseline, on the quality axis:")
for title, key in [("mean author quality @20", "mean_q"), ("own-slot quality", "q_own"),
                   ("own capture", "cap_own"), ("off capture", "cap_off"),
                   ("fcq capture (picking skill, comp-pinned)", "fcq_capture"),
                   ("ndcg @ fixed own comp", "ndcg_fixed_comp"),
                   ("topic entropy @20", "entropy"),
                   ("regret vs pool ceiling", "regret")]:
    m0, m9 = a[key][0], b[key][0]
    arrow = "UP" if m9 > m0 else ("DOWN" if m9 < m0 else "FLAT")
    print(f"    {title:42s}: 0.0 -> {m0:6.3f}   {SHIPPED_S:.2f} -> {m9:6.3f}   ({arrow})")

# per-viewer appendix at the two decision points
print(f"\nper-viewer appendix (s=0.00 | {SHIPPED_KEY}): own_share  mean_q  fcq_capture  entropy")
for i, name in enumerate(PANEL):
    r0, r9 = per_viewer["s=0.00"][i], per_viewer[SHIPPED_KEY][i]
    print(f"    {name:12s} {r0['own_share']:5.2f}|{r9['own_share']:5.2f} "
          f" {r0['mean_q']:5.3f}|{r9['mean_q']:5.3f} "
          f" {r0['fcq_capture']:5.3f}|{r9['fcq_capture']:5.3f} "
          f" {r0['entropy']:5.2f}|{r9['entropy']:5.2f}")
