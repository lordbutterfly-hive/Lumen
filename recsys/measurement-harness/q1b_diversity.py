"""Q1b — is the topic-diversity re-ranker diversifying or diluting?"""
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

from collections import Counter

import numpy as np
from simworld import (
    EPOCH,
    NOW,
    TAGS,
    TOPICS,
    SimGateway,
    build_norm,
    build_world,
    harness_settings,
    ndcg_at_k,
)

from recsys.config import DiversityConfig, Settings
from recsys.contracts import ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

# SEED is an argument (matches q9's convention): the project's established
# multi-seed calibration set is 7/11/23/42. Default unchanged (7).
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7
world = build_world(seed=SEED)
gw = SimGateway(world)
norm = build_norm(world)
# ★ B-07 (2026-08-04): routed through harness_settings() (mutate_panels.py).
settings = harness_settings()
# production=False, trusted_seeds=frozenset() EXPLICIT (C5/R2, 2026-08-04
# fixture migration): synthetic simworld accounts, no real curated seed
# lands in this graph — pass empty explicitly rather than defaulting from
# settings.trusted_seeds, which would only add landed-check overhead/log
# noise for the same fallback outcome.
snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)

def viewer_for(name):
    acct = world.accounts[name]
    return ViewerProfile(account=name, follows=world.follows[name],
                         interest_tags=frozenset(TAGS[acct.topic]))

s_notopic = Settings(diversity=DiversityConfig(topic_decay=1.0, topic_floor=1.0))
s_nodiv   = Settings(diversity=DiversityConfig(author_decay=1.0, author_floor=1.0,
                                               topic_decay=1.0, topic_floor=1.0))

sample = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
rows = {"full": [], "noTopic": [], "noDiv": []}
own = {"full": [], "noTopic": [], "noDiv": []}
pool_own = []
for name in sample:
    v = viewer_for(name)
    t = world.accounts[name].topic
    for label, s in [("full", settings), ("noTopic", s_notopic), ("noDiv", s_nodiv)]:
        f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=s, snapshot=snap)]
        rows[label].append(ndcg_at_k(f, name, world))
        own[label].append(sum(1 for p in f[:20] if world.accounts[p.author].topic == t) / 20)
    # candidate-pool composition (post-eligibility): approximate via the noDiv feed's full list
    fall = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=s_nodiv, snapshot=snap)]
    pool_own.append(sum(1 for p in fall if world.accounts[p.author].topic == t) / max(len(fall), 1))

print(f"eligible pool: own-topic share mean {np.mean(pool_own):.2f}")
for label in rows:
    print(f"{label:8s}: nDCG@20 {np.mean(rows[label]):.3f} +/- {np.std(rows[label]):.3f}   "
          f"own-topic@20 {np.mean(own[label]):.2f}")

# where do the off-topic top-20 posts come from (sources)?
v = viewer_for("v-photo-00")
scored = rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)
src = Counter((sc.source.value, world.accounts[sc.post.author].topic == "photo") for sc in scored[:20])
print("\nv-photo-00 top-20 by (source, own-topic):", dict(src))

# ===========================================================================
# SELF-CHECK (B-07) — the diversity re-ranker must be measurably DOING
# something: "full" (shipped) must sit strictly between "noDiv" (both
# penalties off) on both composition and quality, by a real margin, not a
# rounding artifact. Verified by mutation (LUMEN_SETTINGS_MUTANT) across
# seeds 7/11/23/42 before the floors below were chosen.
# ===========================================================================
own_gap = float(np.mean(own["noDiv"])) - float(np.mean(own["full"]))
nd_gap = float(np.mean(rows["noDiv"])) - float(np.mean(rows["full"]))

# [1] composition: noDiv own-topic@20 minus full own-topic@20. MEASURED
# baseline, seeds 7/11/23/42: 0.11, 0.11, 0.15, 0.11 (min 0.11). Mutating the
# shipped `diversity` config to an exact no-op (author_decay=author_floor=
# topic_decay=topic_floor=1.0) makes "full" byte-identical to "noDiv" on
# every one of the same 4 seeds: gap EXACTLY 0.0. A topic-only no-op
# (topic_decay=topic_floor=1.0, author penalty left on) also collapses this
# gap far below baseline (0.02-0.03 measured) because "full" then matches
# "noTopic", which is itself already close to "noDiv" on this axis -- so this
# one floor catches both the full-diversity-off and topic-diversity-off
# mutants. 0.05 sits below every measured baseline value and above both
# mutants' collapsed values.
OWN_GAP_FLOOR = 0.05
ok1 = own_gap > OWN_GAP_FLOOR
print("\nSELF-CHECK — the diversity re-ranker must measurably change the feed:")
print(f"    [1] own-topic@20 gap (noDiv - full) = {own_gap:.3f}   (must be > {OWN_GAP_FLOOR:.2f})   "
      f"{'OK' if ok1 else '** FAIL **'}")

# [2] quality cost: noDiv nDCG@20 minus full nDCG@20 -- diversity re-ranking
# demonstrably trades some ground-truth relevance for composition spread (by
# design: it displaces some top-relevance own-topic posts). MEASURED
# baseline, seeds 7/11/23/42: 0.168, 0.182, 0.186, 0.174 (min 0.168). The
# full-diversity-off mutant above collapses this to EXACTLY 0.0 on every
# seed. 0.08 sits roughly half the baseline min above 0.0.
ND_GAP_FLOOR = 0.08
ok2 = nd_gap > ND_GAP_FLOOR
print(f"    [2] nDCG@20 gap (noDiv - full)       = {nd_gap:.3f}   (must be > {ND_GAP_FLOOR:.2f})   "
      f"{'OK' if ok2 else '** FAIL **'}")

assert ok1, (
    f"own-topic@20 gap (noDiv - full) = {own_gap:.3f} did not clear {OWN_GAP_FLOOR:.2f} -- the "
    "topic/author diversity re-ranker may no longer be changing feed composition "
    "(check DiversityConfig.author_decay/author_floor/topic_decay/topic_floor)"
)
assert ok2, (
    f"nDCG@20 gap (noDiv - full) = {nd_gap:.3f} did not clear {ND_GAP_FLOOR:.2f} -- the "
    "diversity re-ranker may no longer be trading any relevance for composition, i.e. it "
    "may be a no-op"
)
print("\nALL SELF-CHECKS PASSED — the diversity re-ranker measurably changes both feed "
      "composition and delivered relevance versus the no-diversity control.")
