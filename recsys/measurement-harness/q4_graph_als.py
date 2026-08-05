"""Q4 — is graph_cred a real trust signal? Does ALS separate anything at this sparsity?"""
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
    TOPICS,
    Account,
    SimGateway,
    build_world,
    harness_settings,
    spearman,
)

from recsys.config import Settings
from recsys.contracts import EngagementEdge
from recsys.core.ring import detect_rings, ring_member_set
from recsys.pipeline import build_trust_snapshot

# SEED is an argument (matches q9's convention): the project's established
# multi-seed calibration set is 7/11/23/42. Default unchanged (7).
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7
world = build_world(seed=SEED)
gw = SimGateway(world)
# ★ B-07 (2026-08-04): routed through harness_settings() (mutate_panels.py).
settings = harness_settings()
# production=False, trusted_seeds=frozenset() EXPLICIT (C5/R2): synthetic
# simworld accounts, no real curated seed lands in this graph.
snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)

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
c_results: dict[str, tuple[int, float]] = {}  # label -> (n_flagged, max(ring_creds))
for label, seed_set in [("unseeded", frozenset()), ("seeded", seeds)]:
    # production=False: the "unseeded" arm needs the F-R2 guard to NOT fire so
    # this panel can still compare against the pre-anchoring local rule (C5).
    s2 = build_trust_snapshot(
        gw2, settings, since=EPOCH, now=NOW, trusted_seeds=seed_set, production=False
    )
    ring_creds = [s2.graph_creds[s].score for s in RING]
    n_flagged = len(s2.ring_members & set(RING))
    c_results[label] = (n_flagged, float(np.max(ring_creds)))
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
print("\n[D] ALS affinity (cf_weight x this lands on organic_raw whose global sample "
      "spread is ~[0, 2.2]):")
print(f"    engaged pairs        : mean {eng.mean():.3f} std {eng.std():.3f} (n={len(eng)})")
print(f"    same-topic unengaged : mean {same_uneng.mean():.4f} std {same_uneng.std():.4f} (n={len(same_uneng)})")
print(f"    cross-topic unengaged: mean {cross_uneng.mean():.4f} std {cross_uneng.std():.4f} (n={len(cross_uneng)})")
auc_engaged = auc(eng, np.concatenate([same_uneng, cross_uneng]))
auc_discovery = auc(same_uneng, cross_uneng)
print(f"    AUC engaged vs unengaged          : {auc_engaged:.3f}")
print(f"    AUC same-topic vs cross-topic (DISCOVERY signal): {auc_discovery:.3f}")

# ===========================================================================
# SELF-CHECK (B-07) — q4's two headline claims: (1) the ring/sybil defense
# actually flags a coordinated ring AND zeroes its members' graph-cred, not
# just prints a number; (2) ALS actually separates engaged from unengaged
# pairs, and same-topic from cross-topic unengaged pairs (the discovery
# signal), at this sparsity. Verified by mutation (LUMEN_SETTINGS_MUTANT)
# across seeds 7/11/23/42 before the floors below were chosen.
# ===========================================================================
print("\nSELF-CHECK — the sybil defense and the ALS signal must both be real, not printed noise:")

# [1] the 20-account ring must be FLAGGED and ZEROED in both the unseeded and
# seeded arms. MEASURED baseline, seeds 7/11/23/42: n_flagged EXACTLY 20/20
# and max(ring_creds) EXACTLY 0.000, in BOTH arms, every seed -- no
# exceptions. Mutating `thresholds.ring_discount_threshold` to 1.5 (above the
# ring score's own [0,1] range, so nothing can ever clear it) collapses this
# completely on every one of the same 4 seeds: n_flagged drops to EXACTLY
# 0/20 and sybil cred jumps to 0.596-0.684 -- ALL 20 sybils now PASS the
# 0.05 author/vouch floor entirely. 10 (flagged count) and 0.05 (cred, the
# floor value itself) sit with maximum margin between baseline and mutant.
NFLAG_FLOOR = 10
RING_CRED_CEILING = 0.05
ok1 = all(n > NFLAG_FLOOR and maxcred < RING_CRED_CEILING for n, maxcred in c_results.values())
for label, (n, maxcred) in c_results.items():
    print(f"    [1:{label}] flagged={n}/20 (must be > {NFLAG_FLOOR}), max sybil cred={maxcred:.3f} "
          f"(must be < {RING_CRED_CEILING})   "
          f"{'OK' if (n > NFLAG_FLOOR and maxcred < RING_CRED_CEILING) else '** FAIL **'}")

# [2] ALS must separate engaged from unengaged pairs, AND same-topic from
# cross-topic unengaged pairs (the discovery signal q4 exists to grade).
# MEASURED baseline, seeds 7/11/23/42: AUC engaged-vs-unengaged 0.999-1.000
# (min 0.999); AUC discovery 0.759-0.787 (min 0.759). Mutating `als.factors`
# to 1 (a degenerate rank-1 factorization) collapses both on every one of the
# same 4 seeds: AUC engaged-vs-unengaged to 0.667-0.691 (max 0.691, barely
# above coin-flip); AUC discovery to 0.373-0.408 (max 0.408, WORSE than
# random). 0.90 and 0.60 each sit with a wide, seed-stable margin between
# baseline and mutant.
AUC_ENGAGED_FLOOR = 0.90
AUC_DISCOVERY_FLOOR = 0.60
ok2 = auc_engaged > AUC_ENGAGED_FLOOR
ok3 = auc_discovery > AUC_DISCOVERY_FLOOR
print(f"    [2] AUC engaged-vs-unengaged = {auc_engaged:.3f}   (must be > {AUC_ENGAGED_FLOOR:.2f})   "
      f"{'OK' if ok2 else '** FAIL **'}")
print(f"    [3] AUC discovery (same-vs-cross-topic) = {auc_discovery:.3f}   "
      f"(must be > {AUC_DISCOVERY_FLOOR:.2f})   {'OK' if ok3 else '** FAIL **'}")

assert ok1, (
    f"ring/sybil defense failed on at least one arm: {c_results} -- "
    "thresholds.ring_discount_threshold and/or the ring detector may no longer be "
    "flagging and zeroing a coordinated ring"
)
assert ok2, (
    f"AUC engaged-vs-unengaged = {auc_engaged:.3f} did not clear {AUC_ENGAGED_FLOOR:.2f} -- "
    "ALS (als.factors/iterations/alpha/regularization) may no longer be separating engaged "
    "from unengaged pairs"
)
assert ok3, (
    f"AUC discovery = {auc_discovery:.3f} did not clear {AUC_DISCOVERY_FLOOR:.2f} -- ALS may no "
    "longer carry a same-topic-vs-cross-topic discovery signal"
)
print("\nALL SELF-CHECKS PASSED — the sybil ring is flagged and zeroed in both arms, and ALS "
      "measurably separates both engaged-vs-unengaged and same-vs-cross-topic pairs.")
