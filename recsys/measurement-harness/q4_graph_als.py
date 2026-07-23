"""Q4 — is graph_cred a real trust signal? Does ALS separate anything at this sparsity?"""
from __future__ import annotations
import sys
sys.path.insert(0, "/tmp/claude-1004/-home-clauderfly/fa2f34ba-7811-45c8-a634-26cb2cbffb1b/scratchpad/algo")
from simworld import build_world, SimGateway, build_norm, EPOCH, NOW, TOPICS, spearman, Account
import numpy as np
from collections import Counter
from recsys.contracts import EngagementEdge
from recsys.config import Settings, GraphCredConfig
from recsys.pipeline import build_trust_snapshot
from recsys.core.ring import detect_rings, ring_member_set

world = build_world(seed=7)
gw = SimGateway(world)
settings = Settings()
snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)

# ---- [A] what does cred correlate with? ----
authors = [a for a in world.authors() if a.name in snap.graph_creds]
cred = [snap.graph_creds[a.name].score for a in authors]
fcount = Counter()
for fset in world.follows.values():
    for x in fset:
        fcount[x] += 1
followers = [fcount.get(a.name, 0) for a in authors]
stake = [a.stake for a in authors]
quality = [a.quality for a in authors]
recv = Counter()
for e in world.edges:
    recv[e.dst] += e.replies + e.reply_backs + e.upvotes + e.reblogs
received = [recv.get(a.name, 0) for a in authors]
print(f"[A] graph-cred correlations over {len(authors)} authors (Spearman):")
print(f"    cred ~ follower_count      : {spearman(cred, followers):.3f}")
print(f"    cred ~ stake               : {spearman(cred, stake):.3f}")
print(f"    cred ~ TRUE quality        : {spearman(cred, quality):.3f}")
print(f"    cred ~ engagement received : {spearman(cred, received):.3f}")

# ---- [B] cred distribution / tie-band structure ----
allc = np.array([c.score for c in snap.graph_creds.values()])
vals = Counter(np.round(allc, 9).tolist())
biggest = vals.most_common(1)[0]
print(f"\n[B] cred distribution over {len(allc)} accounts: min {allc.min():.3f}, "
      f"median {np.median(allc):.3f}; below floor 0.05: {(allc < 0.05).sum()}")
print(f"    largest exact tie-band: {biggest[1]} accounts at cred {biggest[0]:.3f} "
      f"(tie-band inflation: bisect_right gives the whole band the band-top percentile)")
ring_scores = detect_rings(world.edges, settings.real_graph, now=NOW)
flagged = ring_member_set(ring_scores, settings.thresholds.ring_discount_threshold)
print(f"    honest-world ring detector: {len(ring_scores)} accounts scored, "
      f"{len(flagged)} flagged >= 0.6 (false positives): {sorted(flagged)}")

# ---- [C] Sybil ring attack: 20 fresh accounts + 1 patsy ----
w2 = build_world(seed=7)
RING = [f"sybil-{i:02d}" for i in range(20)]
PATSY = "a-photo-13"
for s in RING:
    w2.accounts[s] = Account(s, "photo", 0.3, 1.0, 25.0, True)
w2.follows = dict(w2.follows)
for s in RING:
    w2.follows[s] = frozenset(set(RING) - {s} | {PATSY})
ring_edges = []
for s in RING:
    for t in RING:
        if s != t:
            ring_edges.append(EngagementEdge(src=s, dst=t, replies=3, reply_backs=3,
                                             upvotes=5, last_interaction=NOW))
    ring_edges.append(EngagementEdge(src=s, dst=PATSY, replies=3, reply_backs=3, upvotes=5,
                                     last_interaction=NOW))
w2.edges = w2.edges + ring_edges
gw2 = SimGateway(w2)

seeds = frozenset({f"a-{t}-{j:02d}" for t in TOPICS for j in range(2)})
base_cred = snap.graph_creds[PATSY].score
for label, seed_set in [("unseeded", frozenset()), ("seeded", seeds)]:
    s2 = build_trust_snapshot(gw2, settings, since=EPOCH, now=NOW, trusted_seeds=seed_set)
    ring_creds = [s2.graph_creds[s].score for s in RING]
    n_flagged = len(s2.ring_members & set(RING))
    print(f"\n[C:{label}] ring detection flagged {n_flagged}/20 sybils "
          f"(+{len(s2.ring_members - set(RING))} others)")
    print(f"    patsy cred: baseline {base_cred:.3f} -> {s2.graph_creds[PATSY].score:.3f}")
    print(f"    sybil cred: mean {np.mean(ring_creds):.3f} min {np.min(ring_creds):.3f} "
          f"-> {'ALL pass' if min(ring_creds) >= 0.05 else 'some blocked by'} the 0.05 author/vouch floor")

# ---- [D] ALS separation at this sparsity ----
als = snap.als
engaged_pairs = {(e.src, e.dst) for e in world.edges}
viewers = [v.name for v in world.viewers()]
auths = [a.name for a in world.authors()]
rng = np.random.default_rng(3)
def aff_sample(pred):
    out = []
    for v in viewers:
        for a in auths:
            if pred(v, a):
                out.append(als.affinity(v, a))
    return np.array(out)
same_t = lambda v, a: world.accounts[v].topic == world.accounts[a].topic
eng = aff_sample(lambda v, a: (v, a) in engaged_pairs)
same_uneng = aff_sample(lambda v, a: (v, a) not in engaged_pairs and same_t(v, a))
cross_uneng = aff_sample(lambda v, a: (v, a) not in engaged_pairs and not same_t(v, a))
def auc(pos, neg, n=4000):
    p = rng.choice(pos, n); q = rng.choice(neg, n)
    return float(np.mean(p > q) + 0.5 * np.mean(p == q))
print(f"\n[D] ALS affinity (cf_weight x this lands on organic_raw whose global sample "
      f"spread is ~[0, 2.2]):")
print(f"    engaged pairs        : mean {eng.mean():.3f} std {eng.std():.3f} (n={len(eng)})")
print(f"    same-topic unengaged : mean {same_uneng.mean():.4f} std {same_uneng.std():.4f} (n={len(same_uneng)})")
print(f"    cross-topic unengaged: mean {cross_uneng.mean():.4f} std {cross_uneng.std():.4f} (n={len(cross_uneng)})")
print(f"    AUC engaged vs unengaged          : {auc(eng, np.concatenate([same_uneng, cross_uneng])):.3f}")
print(f"    AUC same-topic vs cross-topic (DISCOVERY signal): {auc(same_uneng, cross_uneng):.3f}")
