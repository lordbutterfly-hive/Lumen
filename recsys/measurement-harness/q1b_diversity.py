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
from simworld import COMMUNITY, EPOCH, NOW, TOPICS, SimGateway, build_norm, build_world, ndcg_at_k

from recsys.config import DiversityConfig, Settings
from recsys.contracts import ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
settings = Settings()
snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)

def viewer_for(name):
    acct = world.accounts[name]
    return ViewerProfile(account=name, follows=world.follows[name],
                         subscribed_communities=frozenset({COMMUNITY[acct.topic]}))

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
