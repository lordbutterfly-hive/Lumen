"""Q2 — new-user cold start: what do they get, does the gate strangle them,
does the feed improve with engagement?"""
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

from simworld import (
    COMMUNITY,
    EPOCH,
    NOW,
    TAGS,
    Account,
    SimGateway,
    build_norm,
    build_world,
    mean_rel_at_k,
    ndcg_at_k,
)

from recsys.config import Settings
from recsys.contracts import EngagementEdge, ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
settings = Settings()
snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)

# ground-truth identity for the new user: loves photo
NU = "newuser"
world.accounts[NU] = Account(NU, "photo", 0.5, 3.0, 25.0, False, secondary=None)
world.follows = dict(world.follows); world.follows[NU] = frozenset()

def feed(v, sn=snap):
    return rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=sn)

# ---- stage 0: brand-new, interest picks only ----
v0 = ViewerProfile(account=NU, is_new=True,
                   interest_communities=frozenset({COMMUNITY["photo"]}),
                   interest_tags=frozenset(TAGS["photo"]))
f0 = feed(v0)
posts0 = [sc.post for sc in f0]
src0 = Counter(sc.source.value for sc in f0[:20])
print(f"[A] brand-new user (photo interests): feed size {len(f0)}, top-20 sources {dict(src0)}")
print(f"    nDCG@20 {ndcg_at_k(posts0, NU, world):.3f}, mean-rel@20 {mean_rel_at_k(posts0, NU, world):.3f}")
own0 = sum(1 for p in posts0[:20] if world.accounts[p.author].topic == "photo") / 20
print(f"    own-topic@20 {own0:.2f}   (fallback used: {'popular' in str(src0)})")

# ---- blank user (no picks at all -> popular_fallback path) ----
vb = ViewerProfile(account="blank", is_new=True)
world.accounts["blank"] = Account("blank", "photo", 0.5, 3.0, 25.0, False)
fb = feed(vb)
srcb = Counter(sc.source.value for sc in fb[:20])
print(f"\n[B] zero-pick user: feed size {len(fb)}, top-20 sources {dict(srcb)}, "
      f"nDCG@20 {ndcg_at_k([sc.post for sc in fb], 'blank', world):.3f}")

# ---- gate reachability: what fraction of the post universe can each archetype see? ----
est = "v-photo-00"
vest = ViewerProfile(account=est, follows=world.follows[est],
                     subscribed_communities=frozenset({COMMUNITY["photo"]}))
fest = feed(vest)
photo_posts = [p for p in world.posts if world.accounts[p.author].topic == "photo"]
photo_keys = {p.key for p in photo_posts}
new_keys = {sc.post.key for sc in f0}
est_keys = {sc.post.key for sc in fest}
print(f"\n[C] reachability: photo-topic universe = {len(photo_keys)} posts")
print(f"    new user reaches {len(new_keys & photo_keys)} photo posts "
      f"({len(new_keys & photo_keys)/len(photo_keys):.0%}); established reaches "
      f"{len(est_keys & photo_keys)} ({len(est_keys & photo_keys)/len(photo_keys):.0%})")
# gated-candidate survival for the established viewer
from recsys.core.second_degree import filter_eligible
from recsys.pipeline import gather_candidates

cand = gather_candidates(vest, gw, EPOCH, 400, settings)
gated = [c for c in cand if c.source.requires_second_degree]
gated_keys = frozenset(c.post.key for c in gated)
idx = gw.second_degree_engagers(gated_keys, vest.follows)
elig = filter_eligible(cand, vest, idx, snap.graph_creds, settings.thresholds)
elig_gated = [c for c in elig if c.source.requires_second_degree]
print(f"    established viewer: {len(gated)} gated candidates -> {len(elig_gated)} survive "
      f"({len(elig_gated)/max(len(gated),1):.0%}); new user: 0 gated candidates (interest lane exempt)")

# ---- does the feed improve with engagement? k = 1, 10, 50 interactions ----
# The user upvotes their true-taste posts (highest rel first); edges accrue;
# snapshot+ALS retrain (weekly batch in prod); at k>=10 they follow their
# 2 most-engaged authors, at k>=50 six.
by_rel = sorted(world.posts, key=lambda p: -world.rel(NU, p))
results = []
for k in [1, 10, 50]:
    liked = by_rel[:k]
    eng: dict[str, int] = {}
    for p in liked:
        eng[p.author] = eng.get(p.author, 0) + 1
    new_edges = [EngagementEdge(src=NU, dst=a, upvotes=n, last_interaction=NOW)
                 for a, n in eng.items()]
    world2_edges = world.edges + new_edges
    gw2 = SimGateway(world)
    gw2.w = world  # same posts
    world.edges = world2_edges  # extend in place for the gateway
    follows = frozenset()
    if k >= 50:
        follows = frozenset(sorted(eng, key=lambda a: -eng[a])[:6])
    elif k >= 10:
        follows = frozenset(sorted(eng, key=lambda a: -eng[a])[:2])
    world.follows[NU] = follows
    snap_k = build_trust_snapshot(gw2, settings, since=EPOCH, now=NOW)
    vk = ViewerProfile(account=NU, is_new=True, follows=follows,
                       interest_communities=frozenset({COMMUNITY["photo"]}),
                       interest_tags=frozenset(TAGS["photo"]))
    fk = feed(vk, sn=snap_k)
    pk = [sc.post for sc in fk]
    nd = ndcg_at_k(pk, NU, world); mr = mean_rel_at_k(pk, NU, world)
    own = sum(1 for p in pk[:20] if world.accounts[p.author].topic == "photo") / 20
    src = Counter(sc.source.value for sc in fk[:20])
    aff = snap_k.als.affinity(NU, "a-photo-05") if snap_k.als else 0.0
    results.append((k, len(follows), nd, mr, own, dict(src)))
    world.edges = [e for e in world.edges if e.src != NU]  # reset for next k
print("\n[D] engagement growth (is_new=True kept; snapshot retrained each stage):")
print(f"    k=0  follows=0: nDCG {ndcg_at_k(posts0, NU, world):.3f} own-topic {own0:.2f}")
for k, nf, nd, mr, own, src in results:
    print(f"    k={k:<3d} follows={nf}: nDCG {nd:.3f} mean-rel {mr:.3f} own-topic {own:.2f} sources {src}")
