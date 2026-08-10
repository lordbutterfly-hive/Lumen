"""Q1 — does the feed personalize? Baselines, CF ablation, rep-term decomposition."""
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
from simworld import (
    EPOCH,
    NOW,
    TAGS,
    TOPICS,
    SimGateway,
    build_norm,
    build_world,
    harness_settings,
    mean_rel_at_k,
    ndcg_at_k,
    overlap_at_k,
    spearman,
)

from recsys.config import ALSConfig, ScoreWeights, Settings
from recsys.contracts import ViewerProfile
from recsys.pipeline import TrustPolicy, build_trust_snapshot, rank_feed

# SEED is an argument (matches q9's convention), not a constant: the project's
# established multi-seed calibration set for this codebase is 7/11/23/42 (see
# e.g. ScoreWeights.organic_prior_shrinkage's docstring). Default unchanged
# (7), so a bare `python3 q1_personalization.py` reproduces byte-for-byte.
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7
world = build_world(seed=SEED)
gw = SimGateway(world)
norm = build_norm(world)
# ★ B-07 (2026-08-04): routed through harness_settings() (mutate_panels.py /
# LUMEN_SETTINGS_MUTANT) so this panel's assertions can be verified by
# mutation. Byte-identical to Settings() when the env var is unset.
settings = harness_settings()

# curated seeds: top-2 reputation authors per topic (a plausible deploy list)
seeds = set()
for t in TOPICS:
    tops = sorted([a for a in world.authors() if a.topic == t], key=lambda a: -a.reputation)[:2]
    seeds.update(a.name for a in tops)
snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(seeds), production=False
)  # C5/R2: synthetic seeds ("top-2 reputation per topic"), not the real curated list
print(f"world: {len(world.posts)} posts, {len(world.accounts)} accounts, "
      f"{len(world.edges)} edges, snapshot creds={len(snap.graph_creds)} rings={len(snap.ring_members)}")

def viewer_for(name: str) -> ViewerProfile:
    acct = world.accounts[name]
    return ViewerProfile(account=name, follows=world.follows[name],
                         interest_tags=frozenset(TAGS[acct.topic]))

def feed(v: ViewerProfile, s=settings, sn=snap):
    # trust_policy=WARN: this OFFLINE harness measures pre-hardening Phase-0 behaviour, incl.
    # the deliberate snapshot=None section [D]. Production defaults to FAIL_CLOSED and would
    # refuse a no-snapshot call. WARN serves a byte-identical feed to the pre-R2 default in
    # every case (with a snapshot it is unused; without one it serves the same permissive feed),
    # so no q1 measurement drifts. Matches the q3/q5 migration.
    return [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=s,
                                        snapshot=sn, trust_policy=TrustPolicy.WARN)]

# ---- opposite-interest pair ----
va_name, vb_name = "v-photo-00", "v-crypto-00"
va, vb = viewer_for(va_name), viewer_for(vb_name)
fa, fb = feed(va), feed(vb)
print(f"\n[A] opposite-interest overlap top-20: {overlap_at_k(fa, fb)} / 20  "
      f"(feed sizes {len(fa)}, {len(fb)})")
def topic_share(f, topic):
    top = f[:20]
    return sum(1 for p in top if world.accounts[p.author].topic == topic) / max(len(top),1)
print(f"    {va_name}: own-topic share of top-20 = {topic_share(fa,'photo'):.2f}; "
      f"{vb_name}: {topic_share(fb,'crypto'):.2f}")

# ---- all-viewer nDCG vs baselines ----
pop_stake = sorted(world.posts, key=lambda p: -sum(v.rshares for v in p.votes if v.rshares > 0))
pop_count = sorted(world.posts, key=lambda p: -(len({v.voter for v in p.votes if v.rshares>0})
                                                + p.children + p.reblog_count))
rng = np.random.default_rng(1)
algo_nd, pops_nd, popc_nd, rand_nd, algo_mr, pops_mr = [], [], [], [], [], []
sample_viewers = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
for name in sample_viewers:
    v = viewer_for(name)
    f = feed(v)
    algo_nd.append(ndcg_at_k(f, name, world))
    algo_mr.append(mean_rel_at_k(f, name, world))
    pops_nd.append(ndcg_at_k(pop_stake, name, world))
    pops_mr.append(mean_rel_at_k(pop_stake, name, world))
    popc_nd.append(ndcg_at_k(pop_count, name, world))
    rnd = []
    for _ in range(60):
        idx = rng.permutation(len(world.posts))[:20]
        rnd.append(ndcg_at_k([world.posts[i] for i in idx], name, world))
    rand_nd.append(float(np.mean(rnd)))
print(f"\n[B] nDCG@20 over {len(sample_viewers)} viewers (global ideal=1.0):")
print(f"    algorithm        : {np.mean(algo_nd):.3f} +/- {np.std(algo_nd):.3f}")
print(f"    stake-trending   : {np.mean(pops_nd):.3f} +/- {np.std(pops_nd):.3f}   <- incumbent")
print(f"    engagement-pop   : {np.mean(popc_nd):.3f} +/- {np.std(popc_nd):.3f}")
print(f"    random           : {np.mean(rand_nd):.3f} +/- {np.std(rand_nd):.3f}")
print(f"    mean ground-truth rel@20: algo {np.mean(algo_mr):.3f} vs stake-trending {np.mean(pops_mr):.3f}")

# ---- CF/ALS ablation: same snapshot, cf_weight=0 ----
s_nocf = Settings(als=ALSConfig(cf_weight=0.0))
diffs, taus, nd_on, nd_off = [], [], [], []
for name in sample_viewers:
    v = viewer_for(name)
    f_on, f_off = feed(v), feed(v, s=s_nocf)
    diffs.append(20 - overlap_at_k(f_on, f_off))
    common = [p.key for p in f_on if p.key in {q.key for q in f_off}]
    pos_on = {p.key: i for i, p in enumerate(f_on)}
    pos_off = {p.key: i for i, p in enumerate(f_off)}
    taus.append(spearman([pos_on[k] for k in common], [pos_off[k] for k in common]))
    nd_on.append(ndcg_at_k(f_on, name, world))
    nd_off.append(ndcg_at_k(f_off, name, world))
print(f"\n[C] ALS-CF ablation (cf_weight 1.5 -> 0): top-20 changed posts "
      f"mean {np.mean(diffs):.1f}/20; full-list Spearman {np.nanmean(taus):.3f}; "
      f"nDCG on {np.mean(nd_on):.3f} vs off {np.mean(nd_off):.3f}")

# ---- no-snapshot mode (the honest Phase-0 default: snapshot=None) ----
nd_nosnap, sizes_ns, sizes_s = [], [], []
for name in sample_viewers:
    v = viewer_for(name)
    f_ns = feed(v, sn=None)
    nd_nosnap.append(ndcg_at_k(f_ns, name, world))
    sizes_ns.append(len(f_ns))
    sizes_s.append(len(feed(v)))
print(f"\n[D] snapshot=None (Phase-0 default): nDCG {np.mean(nd_nosnap):.3f} "
      f"(with snapshot {np.mean(algo_nd):.3f}); feed size {np.mean(sizes_ns):.0f} vs {np.mean(sizes_s):.0f}")

# ---- personalization vs global: same-topic viewers, and score-term decomposition ----
fa2 = feed(viewer_for("v-photo-01"))
print(f"\n[E] same-topic pair (v-photo-00 vs v-photo-01) top-20 overlap: {overlap_at_k(fa, fa2)}/20")

# vote vs rep correlation + rep marginal
scored = rank_feed(va, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)
vn = [sc.score.vote_norm for sc in scored]
rn = [sc.score.rep_norm for sc in scored]
on = [sc.score.organic for sc in scored]
print(f"\n[F] corr over {len(scored)} scored candidates (viewer {va_name}):")
print(f"    Pearson(vote_norm, rep_norm) = {np.corrcoef(vn, rn)[0,1]:.3f}")
print(f"    Pearson(vote_norm, organic)  = {np.corrcoef(vn, on)[0,1]:.3f}")
w_norep = ScoreWeights(vote=1/9, reputation=0.0, organic=8/9)
s_norep = Settings(weights=w_norep)
ch, tau2 = [], []
for name in sample_viewers[:8]:
    v = viewer_for(name)
    f1, f2 = feed(v), feed(v, s=s_norep)
    ch.append(20 - overlap_at_k(f1, f2))
    common = [p.key for p in f1 if p.key in {q.key for q in f2}]
    p1 = {p.key: i for i, p in enumerate(f1)}
    p2 = {p.key: i for i, p in enumerate(f2)}
    tau2.append(spearman([p1[k] for k in common], [p2[k] for k in common]))
print(f"    rep-term removed (0.111/0/0.889): top-20 changed mean {np.mean(ch):.1f}/20, "
      f"Spearman {np.nanmean(tau2):.3f}")

# how much of top-20 is explained by pure global popularity ordering?
gpop20 = {p.key for p in pop_count[:20]}
shares = [len({p.key for p in feed(viewer_for(n))[:20]} & gpop20) for n in sample_viewers[:8]]
print(f"\n[G] top-20 posts also in GLOBAL engagement-pop top-20: mean {np.mean(shares):.1f}/20")

# ===========================================================================
# SELF-CHECK (B-07) — this panel exists to prove the feed is personalized,
# not to print numbers nobody gates on. Three checks below, each verified by
# mutation (`LUMEN_SETTINGS_MUTANT`, see mutate_panels.py's technique) across
# seeds 7/11/23/42 before its floor was chosen. Floors sit well inside the
# measured baseline range and well outside what the corresponding mutant
# produces -- see each check's own comment for the exact numbers.
# ===========================================================================
print("\nSELF-CHECK — the feed must be measurably personalized, not merely printed:")

# [1] HEADLINE ([B]): algorithm nDCG@20 must clearly beat a flat/incumbent
# ranking. MEASURED baseline mean, seeds 7/11/23/42: 0.740, 0.742, 0.742,
# 0.754 (min 0.740). Two independent mutations that gut personalization both
# collapse this well below the baseline range on every one of the same 4
# seeds: `weights.interest_match=0.0` (disable the declared-interest term)
# -> 0.619-0.631; `weights.vote_share_of_final=1.0, reputation=0.0,
# organic=0.0` (collapse
# to a raw per-pool-vote-count ranking, organic term OFF entirely) ->
# 0.589-0.606. 0.70 sits ~0.04 below the baseline min and >=0.08 above the
# higher of the two mutant maxima -- comfortable margin on both sides.
algo_ndcg_mean = float(np.mean(algo_nd))
NDCG_FLOOR = 0.70
ok1 = algo_ndcg_mean > NDCG_FLOOR
print(f"    [1] algo nDCG@20 = {algo_ndcg_mean:.3f}   (must be > {NDCG_FLOOR:.2f})   "
      f"{'OK' if ok1 else '** FAIL **'}")

# [2] the CF ablation in [C] must show CF actually MOVES the ranking -- a
# panel whose own "on vs off" comparison silently became "off vs off" is
# exactly the defect this self-check exists to catch. MEASURED baseline
# top-20-changed mean, seeds 7/11/23/42: 0.5, 0.8, 0.6, 0.9 (min 0.5).
# Mutating the shipped `als.cf_weight` to 0.0 makes this section's "on" feed
# (which now also carries cf_weight=0) byte-identical to the internal
# `s_nocf` control on every one of the same 4 seeds: diffs collapse to
# EXACTLY 0.0/20 and full-list Spearman to EXACTLY 1.000. 0.2 sits
# comfortably between the two.
cf_diff_mean = float(np.mean(diffs))
CF_DIFF_FLOOR = 0.2
ok2 = cf_diff_mean > CF_DIFF_FLOOR
print(f"    [2] CF ablation [C] top-20-changed = {cf_diff_mean:.2f}/20   "
      f"(must be > {CF_DIFF_FLOOR:.2f})   {'OK' if ok2 else '** FAIL **'}")

# [3] the reputation-term ablation in [F] must show the rep term actually
# MOVES the ranking. MEASURED baseline top-20-changed mean, seeds
# 7/11/23/42: 2.9, 3.1, 2.1, 2.5 (min 2.1). Mutating the shipped weights to
# EXACTLY the ablation's own values (vote=1/9, reputation=0, organic=8/9)
# collapses this section's `f1` (shipped) onto `f2` (the ablation) on every
# one of the same 4 seeds: diffs EXACTLY 0.0/20, Spearman EXACTLY 1.000. 0.5
# sits comfortably between the two.
rep_diff_mean = float(np.mean(ch))
REP_DIFF_FLOOR = 0.5
ok3 = rep_diff_mean > REP_DIFF_FLOOR
print(f"    [3] rep-term-removed [F] top-20-changed = {rep_diff_mean:.2f}/20   "
      f"(must be > {REP_DIFF_FLOOR:.2f})   {'OK' if ok3 else '** FAIL **'}")

assert ok1, (
    f"algo nDCG@20 = {algo_ndcg_mean:.3f} did not clear {NDCG_FLOOR:.2f} -- personalization "
    "(the interest-match term and/or the vote/reputation/organic split) may be broken"
)
assert ok2, (
    f"CF ablation [C] top-20-changed = {cf_diff_mean:.2f}/20 did not clear {CF_DIFF_FLOOR:.2f} "
    "-- the CF term may no longer be reaching the ranking (check als.cf_weight)"
)
assert ok3, (
    f"rep-term-removed [F] top-20-changed = {rep_diff_mean:.2f}/20 did not clear "
    f"{REP_DIFF_FLOOR:.2f} -- the reputation term may no longer be reaching the ranking"
)
print("\nALL SELF-CHECKS PASSED — the feed is measurably personalized: interest/vote/organic "
      "split, CF, and the reputation term each demonstrably move the ranking.")
