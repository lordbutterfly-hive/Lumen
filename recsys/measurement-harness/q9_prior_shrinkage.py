"""Q9 — author-prior SHRINKAGE sweep: does making the pooled prior earn its
weight un-bury a new author, and what does it cost the prior's picking skill?

THE DEFECT THIS MEASURES (found 2026-08-01, once the instrument was fixed).
``organic_post_share = 1/3``, so two thirds of a post's organic quality is a
leave-one-out mean over the author's OTHER window posts — at a FIXED weight,
from the author's second post onward, however few posts that mean rests on.
For a newcomer those other posts are unengaged BECAUSE they are new, so the
estimator conflates "not yet discovered" with "low quality".

THE CHANGE (``ScoreWeights.organic_prior_shrinkage``, k):

    prior_weight = (1 - organic_post_share) * n / (n + k),  n = posts - 1

k = 0 is the shipped pre-shrinkage blend byte-for-byte, so column k=0 below is
also the control. See ``recsys.core.scoring.pooled_author_base``.

TWO SECTIONS, because a change like this has a target AND a cost:

  A. TARGET — q3's new-author panel at its hardest loadout (9 votes + 2
     comments + 1 reblog, the one the round measured at top-20 for 0/10
     established viewers). Plus the mechanism-level pooled base, so the feed
     result can be traced to the estimator rather than asserted.

  B. COST — q8's protocol exactly (24-viewer panel, curated seeds, k=20,
     pool-set invariance asserted). The pooled prior is a MEASURED picking
     lever; shrinkage necessarily gives some of that back, and this is the
     number that says how much. q8's own self-check floors are reproduced here
     so the sweep shows directly which k values would still pass the standing
     panel.

WHAT THIS INSTRUMENT CANNOT SEE — the other half of the designed fix,
excluding posts too young to have accumulated engagement. ``simworld`` draws
every post's engagement independently of the post's age, so post age carries
no information here and a maturity horizon tuned on this world would be tuned
against nothing. That lever is LIVE-HAFSQL-GATED and deliberately NOT swept.

CALIBRATION CAVEAT (as q8): synthetic engagement is cleanly topic-structured.
Mechanisms and signs are reliable; exact magnitudes are directional.
"""
from __future__ import annotations

import pathlib
import sys

# Derived from __file__, index 0 deliberate — bind to the tree this file sits
# in, never an installed `recsys` (same rule as every other panel).
_HARNESS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))

from dataclasses import replace
from datetime import timedelta

from metrics_v2 import (
    DECOMP_CONFIGS,
    aggregate,
    decomposition_settings,
    penalty_decomposition,
    viewer_metrics,
)
from simworld import (
    COMMUNITY,
    EPOCH,
    NOW,
    TAGS,
    TOPICS,
    Account,
    PriorlessSimGateway,
    SimGateway,
    build_norm,
    build_world,
    harness_settings,
)

from recsys.config import Settings
from recsys.contracts import EngagementEdge, Post, ViewerProfile, Vote
from recsys.core.scoring import pooled_author_base, post_base_engagement
from recsys.core.vote_signal import AttributedPost
from recsys.pipeline import build_trust_snapshot, rank_feed

# The sweep. 0.0 first so it reads as the control column it is.
SHRINKAGE = [0.0, 0.5, 1.0, 2.0, 3.0, 5.0, 8.0]
BIG = 100_000  # top_k beyond any pool size -> full preference order

# ★ SEED IS AN ARGUMENT, not a constant (2026-08-03). Picking k on one world
# would be the exact fixture-topology error this round keeps re-teaching — a
# chain hid that vouch reach was exponential; `reply_backs=0` fixtures hid a
# live bug. Run this at several seeds and only trust a k the worlds agree on.
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7
print(f"### world seed = {SEED}\n")


def weighted(base: Settings, k: float) -> Settings:
    """`base` with only the shrinkage constant changed — every other weight,
    threshold and window is the shipped value."""
    return replace(base, weights=replace(base.weights, organic_prior_shrinkage=k))


# ===========================================================================
# SECTION A — TARGET: the new author, q3's protocol at its hardest loadout
# ===========================================================================
print("=" * 78)
print("A. NEW-AUTHOR DISCOVERY (q3 protocol, [D] loadout: 9 votes + 2 comments + 1 reblog)")
print("=" * 78)

world = build_world(seed=SEED)
# ★ B-07 (2026-08-04): routed through harness_settings() (mutate_panels.py).
# Byte-identical to Settings() when LUMEN_SETTINGS_MUTANT is unset.
#
# HONEST LIMIT, checked by grep before writing this comment: this file NEVER
# reads `base_settings.weights.organic_prior_shrinkage` — every use (Section A
# and B's `weighted(base_settings, k)` / `weighted(SETTINGS_B, k)`, and the
# mechanism-print loop's `pooled_author_base(..., k)`) passes `k` from the
# literal `SHRINKAGE` sweep list instead, including `k=0.0` as the explicit
# control. So a `weights.organic_prior_shrinkage` MUTATION HAS ZERO OBSERVABLE
# EFFECT on this file, by construction — not "weakly caught", genuinely
# invisible. `organic_post_share`, which nothing here sweeps, IS affected
# normally.
base_settings = harness_settings()

NEWBIE = "newbie-author"
world.accounts[NEWBIE] = Account(NEWBIE, "photo", 0.9, 1.0, 25.0, True)
world.follows = dict(world.follows)
world.follows[NEWBIE] = frozenset()

# Three debut posts. Only debut-0 draws engagement — debut-1 and debut-2 are the
# "other window posts" whose emptiness the fixed blend reads as low quality.
newbie_posts = []
for i in range(3):
    p = Post(author=NEWBIE, permlink=f"debut-{i}", category="photo",
             community=COMMUNITY["photo"], created=NOW - timedelta(hours=6 + 3 * i),
             children=0, reblog_count=0, author_reputation=25.0,
             tags=TAGS["photo"], votes=())
    newbie_posts.append(p)
    world.posts.append(p)
    world.post_topic[p.key] = "photo"
    world.post_engagers[p.key] = set()

# The voucher is q3's: the photo author followed by the most photo viewers.
from collections import Counter

fcount: Counter[str] = Counter()
for j in range(10):
    for a in world.follows[f"v-photo-{j:02d}"]:
        fcount[a] += 1
voucher = max((a for a in fcount if world.accounts[a].topic == "photo"), key=lambda a: fcount[a])

p0 = newbie_posts[0]
idx0 = world.posts.index(p0)
voters = [f"a-photo-{j:02d}" for j in range(1, 9)]  # 8 more -> 9 votes total
votes = tuple(
    [Vote(voter=voucher, rshares=int(world.accounts[voucher].stake * 1e9),
          timestamp=p0.created + timedelta(minutes=30))]
    + [Vote(voter=w, rshares=int(world.accounts[w].stake * 1e9),
            timestamp=p0.created + timedelta(hours=1 + i))
       for i, w in enumerate(voters)]
)
p0x = AttributedPost(
    author=p0.author, permlink=p0.permlink, category=p0.category,
    community=p0.community, created=p0.created, children=2, reblog_count=1,
    author_reputation=25.0, tags=p0.tags, votes=votes,
    commenters=("a-photo-20", "a-photo-21"), rebloggers=("a-photo-22",),
)
world.posts[idx0] = p0x
world.post_engagers[p0.key] = {voucher, *voters}
world.edges.append(
    EngagementEdge(src=voucher, dst=NEWBIE, upvotes=1, last_interaction=votes[0].timestamp)
)

gw = SimGateway(world)
norm = build_norm(world)
snap = build_trust_snapshot(
    gw, base_settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)  # C5/R2

# --- mechanism: the pooled base itself, before any ranking ---------------
own_base = post_base_engagement(p0x, frozenset({NEWBIE}))
prior = gw.author_engagement(
    frozenset({NEWBIE}), EPOCH, {NEWBIE: frozenset({NEWBIE})}, trust=None
)[NEWBIE]
print(f"\nnewbie window aggregate: posts={prior.posts}, total_base={prior.total_base:.4f}; "
      f"debut-0 own_base={own_base:.4f}")
print("(posts 2 and 3 drew nothing, so the leave-one-out mean over them is 0.0)\n")
print(f"{'k':>6s}{'prior_weight':>14s}{'pooled base':>14s}{'vs own_base':>14s}")
print("-" * 48)
for k in SHRINKAGE:
    pooled = pooled_author_base(own_base, prior, base_settings.weights.organic_post_share, k)
    others = prior.posts - 1
    pw = (1.0 - base_settings.weights.organic_post_share) * (others / (others + k))
    print(f"{k:6.1f}{pw:14.4f}{pooled:14.4f}{pooled / own_base - 1.0:+13.1%}")

# --- feed: do established photo viewers actually see it? -----------------
PHOTO_VIEWERS = [f"v-photo-{j:02d}" for j in range(10)]


def photo_viewer(name: str) -> ViewerProfile:
    return ViewerProfile(account=name, follows=world.follows[name],
                         interest_tags=frozenset(TAGS["photo"]))


print(f"\n{'k':>6s}{'top-20':>10s}{'top-50':>10s}{'best pos':>10s}{'median pos':>12s}")
print("-" * 48)
pool_ref: frozenset[str] | None = None
for k in SHRINKAGE:
    s = weighted(base_settings, k)
    in20 = in50 = 0
    positions: list[int] = []
    for name in PHOTO_VIEWERS:
        full = [sc.post for sc in rank_feed(photo_viewer(name), gw, norm, now=NOW,
                                            since=EPOCH, settings=s, snapshot=snap)]
        if pool_ref is None:
            pool_ref = frozenset(p.key for p in full)
        pos = [i for i, p in enumerate(full) if p.key == p0x.key]
        if pos:
            positions.append(pos[0])
            in20 += pos[0] < 20
            in50 += pos[0] < 50
    best = min(positions) if positions else None
    med = sorted(positions)[len(positions) // 2] if positions else None
    print(f"{k:6.1f}{in20:8d}/10{in50:8d}/10"
          f"{('-' if best is None else str(best)):>10s}{('-' if med is None else str(med)):>12s}")

# ===========================================================================
# SECTION B — COST: q8's panel. Does the prior still beat prior-less?
# ===========================================================================
print()
print("=" * 78)
print("B. PICKING-SKILL COST (q8 protocol: 24-viewer panel, curated seeds, k=20)")
print("=" * 78)

world_b = build_world(seed=SEED)
norm_b = build_norm(world_b)
seeds: set[str] = set()
for t in TOPICS:
    tops = sorted([a for a in world_b.authors() if a.topic == t], key=lambda a: -a.reputation)[:2]
    seeds.update(a.name for a in tops)

gw_no_prior = PriorlessSimGateway(world_b)
gw_with_prior = SimGateway(world_b)
snap_b = build_trust_snapshot(
    gw_no_prior, base_settings, since=EPOCH, now=NOW,
    trusted_seeds=frozenset(seeds), production=False,  # C5/R2: synthetic seeds, not the real list
)
PANEL = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
# `replace(base_settings, ...)`, not a fresh `Settings(diversity=DiversityConfig(...))`
# — the latter would silently reset `weights` to its class default and drop
# any B-07 mutation (same reasoning as q8's SETTINGS).
SETTINGS_B = replace(base_settings, diversity=replace(base_settings.diversity, top_k=BIG))


def panel_viewer(name: str) -> ViewerProfile:
    acct = world_b.accounts[name]
    return ViewerProfile(account=name, follows=world_b.follows[name],
                         interest_tags=frozenset(TAGS[acct.topic]))


def run_panel(gw_, s: Settings) -> tuple[dict[str, tuple[float, float]], list[frozenset[str]]]:
    rows, pools = [], []
    for name in PANEL:
        full = [sc.post for sc in rank_feed(panel_viewer(name), gw_, norm_b, now=NOW,
                                            since=EPOCH, settings=s, snapshot=snap_b)]
        pools.append(frozenset(p.key for p in full))
        rows.append(viewer_metrics(world_b, name, full))
    return aggregate(rows), pools


def scoring_gap_for(gw_, s: Settings) -> float:
    cfgs = decomposition_settings(s)
    orders: dict[str, dict[str, list]] = {name: {} for name in PANEL}
    for cfg_name in DECOMP_CONFIGS:
        cs = cfgs[cfg_name]
        for name in PANEL:
            orders[name][cfg_name] = [
                sc.post for sc in rank_feed(panel_viewer(name), gw_, norm_b, now=NOW,
                                            since=EPOCH, settings=cs, snapshot=snap_b)
            ]
    rows = [penalty_decomposition(world_b, n, orders[n]) for n in PANEL]
    return aggregate(rows)["scoring_gap"][0]


# The control is k-independent: the prior-less gateway never reaches the blend.
ctl, ctl_pools = run_panel(gw_no_prior, SETTINGS_B)
ctl_gap = scoring_gap_for(gw_no_prior, SETTINGS_B)

# q8's standing self-check floors — reproduced so the sweep shows which k pass.
FLOORS = {"mean_q": 0.010, "stack_capture_g": 0.015, "auc_own_m5": 0.020, "gap": 0.025}
#: k -> (passed, deltas). Populated by the sweep below and ASSERTED on after it.
verdicts: dict[float, tuple[bool, dict[str, float]]] = {}
print(f"\ncontrol (prior OFF): mean_q={ctl['mean_q'][0]:.4f}  "
      f"stack_cap={ctl['stack_capture_g'][0]:.4f}  auc5={ctl['auc_own_m5'][0]:.4f}  "
      f"scoring_gap={ctl_gap:.4f}")
print("deltas below are (prior ON at k) - (prior OFF); q8 asserts each clears its floor\n")
hdr = (f"{'k':>6s}{'d mean_q':>11s}{'d stack_cap':>13s}{'d auc5':>10s}"
       f"{'d gap':>10s}{'q8 self-check':>16s}")
print(hdr)
print("-" * len(hdr))
for k in SHRINKAGE:
    s = weighted(SETTINGS_B, k)
    agg, pools = run_panel(gw_with_prior, s)
    assert pools == ctl_pools, (
        f"pool sets differ at k={k}: the prior must change SCORING only, never "
        "candidate gathering — a measured delta would be a gathering artifact"
    )
    gap = scoring_gap_for(gw_with_prior, s)
    d = {
        "mean_q": agg["mean_q"][0] - ctl["mean_q"][0],
        "stack_capture_g": agg["stack_capture_g"][0] - ctl["stack_capture_g"][0],
        "auc_own_m5": agg["auc_own_m5"][0] - ctl["auc_own_m5"][0],
        "gap": ctl_gap - gap,
    }
    passes = all(d[key] > floor for key, floor in FLOORS.items())
    verdicts[k] = (passes, dict(d))
    print(f"{k:6.1f}{d['mean_q']:+11.4f}{d['stack_capture_g']:+13.4f}"
          f"{d['auc_own_m5']:+10.4f}{d['gap']:+10.4f}"
          f"{('PASS' if passes else '** FAIL **'):>16s}")

# ============================================================================
# ★★★ E1 (2026-08-05) — THIS PANEL NOW HAS A GATE.
#
# Until today the per-k verdict above was computed into a local named `passes`
# and used ONLY inside the f-string that prints it. It was never returned,
# compared or raised on: the panel printed `** FAIL **` and exited 0. That is
# the same "prints a verdict, exits 0 anyway" defect this project believes it
# eradicated in 2026-08-04 — still live here, and consistent with the
# independent finding that q9 catches 0 of 14 mechanism mutants.
#
# WHAT IS AND IS NOT GATED, deliberately. This file is a SWEEP: its job is to
# show where the ceiling is, so k=5.0 and k=8.0 failing q8's floors is the
# panel WORKING, not a regression. Asserting "every row passes" would destroy
# the measurement. What must hold is narrower and is the decision this panel
# exists to inform: THE SHIPPED k CLEARS THE FLOORS.
#
# This also closes the mutation blindness documented at the top of this file.
# `k` came from the literal SHRINKAGE list, so a change to
# `ScoreWeights.organic_prior_shrinkage` had zero observable effect here. The
# gate reads the SHIPPED value from settings, so moving it to a k that fails —
# or off the swept grid entirely — now fails this panel instead of passing
# silently.
# ============================================================================
shipped_k = base_settings.weights.organic_prior_shrinkage
if shipped_k not in verdicts:
    raise AssertionError(
        f"the shipped organic_prior_shrinkage={shipped_k} is not in this sweep "
        f"({sorted(verdicts)}), so this panel says NOTHING about the configuration "
        f"actually being served. Add it to SHRINKAGE."
    )
shipped_passed, shipped_deltas = verdicts[shipped_k]
if not shipped_passed:
    failed = {k: v for k, v in shipped_deltas.items() if v <= FLOORS[k]}
    raise AssertionError(
        f"the SHIPPED organic_prior_shrinkage={shipped_k} does not clear q8's "
        f"floors: {failed} (floors {FLOORS}). Either the prior has regressed or "
        f"the shipped k has been moved past the ceiling this sweep measures — "
        f"re-pick k from the table above, deliberately, and record why."
    )
print(f"\nGATE: shipped k={shipped_k} clears every q8 floor.")

print("\npool-set invariance held at every k (asserted): all deltas are scoring-only.")
print("Read A and B together — pick the largest k that still clears q8's floors, "
      "then confirm on the standing panels.")
