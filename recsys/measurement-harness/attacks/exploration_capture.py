"""ATTACK — how much of the new-author exploration lane can an account-count
farm take, and what does one griefer add?

★ WHY THIS FILE EXISTS (2026-08-05). The 2026-08-05 council measured that 21
Hive accounts — 20 root posts and 20 comments, zero votes, zero delegations,
no ring — took 96-100% of every exploration slot, driving honest newcomers from
60/60 reach to 0/60. That measurement was made in scratch scripts under /tmp
(`atk1_farm.py`, `atk3b_band0_clear.py`) which were DESTROYED when the session
died. The numbers survived only in prose.

A number nobody can re-run is not evidence. This file re-materialises the
attack under version control so the claim can be re-tested — in particular
AFTER the fixes that followed it, which is the whole point: the same script has
to be runnable before and after B1's serving log to say whether it worked.

TWO ATTACKS, both keyed on the same fact — `DEFAULT_NEED_BANDS = (0, 1, 3, 8,
20)` makes "zero distinct engagers" an EXCLUSIVE TOP BAND, and an account with
no engagement is a permanent, unassailable member of it:

  A. FARM — N sock authors post once each and do nothing else. Every other
     defence on this lane is per-AUTHOR or per-FEED (`max_posts_per_author_epoch`,
     `max_slots_per_feed`, `_interest_match`, `_is_self_dealt`, `detect_rings`),
     and an account-count farm with zero engagement is invisible to all of them.

  B. GRIEFER — ONE extra account leaves ONE comment on each honest newcomer.
     That is `_need_tier`'s own documented residual ("a single identity CAN
     still move an untouched rival out of that zero-only band") applied to the
     whole honest population: it evicts every honest author from band 0 and
     leaves the farm alone at the top.

Run: `python3 measurement-harness/attacks/exploration_capture.py`
Exits non-zero if the farm's share exceeds `MAX_TOLERATED_FARM_SHARE` — so once
a mechanism that prices account count lands, this file is the gate that says so.
"""
from __future__ import annotations

import pathlib
import sys
from datetime import timedelta

_HARNESS = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))

from simworld import (
    COMMUNITY,
    EPOCH,
    NOW,
    TAGS,
    Account,
    SimGateway,
    build_norm,
    build_world,
    harness_settings,
)

from recsys.contracts import (
    CandidateSource,
    EngagementEdge,
    Post,
    ViewerProfile,
)
from recsys.pipeline import build_trust_snapshot, rank_feed
from recsys.serve_log import ExplorationServeLog

TOPIC = "photo"
SEEDS = (7, 11, 23)
K = 20
#: The council measured 96-100%. Anything at or near that means the lane serves
#: the attacker rather than new authors. This bound is deliberately generous —
#: it is a "did the defence do ANYTHING" gate, not a tuning target.
#: MEASURED STATE 2026-08-05, not a target: with the B1 serving log the farm
#: takes 70% at 20 socks and 100% at 100 socks. The lane is NOT safe. This gate
#: is pinned just above the measured 20-sock figure so the file exits non-zero —
#: it is SUPPOSED to be red, because the vulnerability is real and open. Tighten
#: it only when a mechanism actually lands; do not relax it to make the run green.
MAX_TOLERATED_FARM_SHARE = 0.50


def _add_author(world, name: str, *, quality: float, is_new: bool) -> None:
    world.accounts[name] = Account(name, TOPIC, quality, 1.0, 25.0, is_new)
    world.follows[name] = frozenset()


def _add_post(world, author: str, permlink: str, *, hours_old: float) -> Post:
    p = Post(
        author=author, permlink=permlink, category=TOPIC, community=COMMUNITY[TOPIC],
        created=NOW - timedelta(hours=hours_old), children=0, reblog_count=0,
        author_reputation=25.0, tags=TAGS[TOPIC], votes=(),
    )
    world.posts.append(p)
    world.post_topic[p.key] = TOPIC
    world.post_engagers[p.key] = set()
    return p


def run(seed: int, *, n_socks: int, n_honest: int, griefer: bool,
        serve_log: bool = True) -> dict[str, float]:
    """One scenario. Returns the farm's and honest cohort's share of the
    exploration slots actually SERVED across the viewer panel."""
    world = build_world(seed=seed)
    world.follows = dict(world.follows)

    honest = [f"honest-new-{i:02d}" for i in range(n_honest)]
    socks = [f"sock-{i:02d}" for i in range(n_socks)]
    for name in honest + socks:
        _add_author(world, name, quality=0.6, is_new=True)
        _add_post(world, name, "debut", hours_old=6)

    if griefer:
        # ONE account, ONE comment each. It never votes and never posts, so it
        # trips no ring, no self-dealing check and no per-author cap. Its only
        # effect is to move every honest newcomer out of the zero-engager band.
        _add_author(world, "griefer", quality=0.5, is_new=False)
        for victim in honest:
            world.edges.append(
                EngagementEdge(src="griefer", dst=victim, replies=1, last_interaction=NOW)
            )
            for post in world.posts:
                if post.author == victim:
                    world.post_engagers[post.key].add("griefer")

    gw = SimGateway(world)
    norm = build_norm(world)
    settings = harness_settings()
    curated: set[str] = set()
    for topic in {a.topic for a in world.authors()}:
        tops = sorted([a for a in world.authors() if a.topic == topic],
                      key=lambda a: -a.reputation)[:2]
        curated.update(a.name for a in tops)
    snap = build_trust_snapshot(
        gw, settings, since=EPOCH, now=NOW,
        trusted_seeds=frozenset(curated), production=False,
    )

    # ★ B1: ONE log across the panel, which is what a real deployment has — the
    # counts accumulate as viewers are served, exactly as they would in
    # production. Passing None reproduces the pre-B1 lane for comparison.
    log = ExplorationServeLog() if serve_log else None
    panel = [f"v-{TOPIC}-{j:02d}" for j in range(10)]
    farm_slots = honest_slots = total_slots = 0
    honest_reached: set[str] = set()
    for name in panel:
        viewer = ViewerProfile(
            account=name, follows=world.follows[name],
            interest_tags=frozenset(TAGS[TOPIC]),
        )
        served = rank_feed(viewer, gw, norm, now=NOW, since=EPOCH,
                           settings=settings, snapshot=snap, serve_log=log)[:K]
        for sc in served:
            if sc.source is not CandidateSource.EXPLORATION:
                continue
            total_slots += 1
            if sc.post.author.startswith("sock-"):
                farm_slots += 1
            elif sc.post.author.startswith("honest-new-"):
                honest_slots += 1
                honest_reached.add(sc.post.author)
    return {
        "farm_share": farm_slots / total_slots if total_slots else 0.0,
        "honest_share": honest_slots / total_slots if total_slots else 0.0,
        "distinct_honest_reached": float(len(honest_reached)),
        "total_slots": float(total_slots),
    }


print(__doc__.split("Run:")[0].strip()[:0] or "", end="")
print("EXPLORATION-LANE CAPTURE — account-count farm vs honest newcomers")
print(f"panel: 10 viewers x {len(SEEDS)} seeds; topic={TOPIC}; k={K}\n")
hdr = (f"{'socks':>6} {'honest':>7} {'griefer':>8} {'servelog':>9} | "
       f"{'farm share':>11} {'honest share':>13} {'distinct honest':>16} {'slots':>6}")
print(hdr)
print("-" * len(hdr))

worst_farm_share = 0.0
for n_socks, griefer, use_log in (
    (0, False, True), (20, False, False), (20, False, True),
    (20, True, False), (20, True, True), (100, True, True),
):
    agg: dict[str, float] = {}
    for seed in SEEDS:
        r = run(seed, n_socks=n_socks, n_honest=20, griefer=griefer, serve_log=use_log)
        for key, value in r.items():
            agg[key] = agg.get(key, 0.0) + value / len(SEEDS)
    if use_log:
        worst_farm_share = max(worst_farm_share, agg["farm_share"])
    print(f"{n_socks:>6} {20:>7} {griefer!s:>8} {use_log!s:>9} | "
          f"{agg['farm_share']:>11.1%} {agg['honest_share']:>13.1%} "
          f"{agg['distinct_honest_reached']:>16.1f} {agg['total_slots']:>6.1f}")

print(
    "\nREAD ME: `farm share` is the fraction of SERVED exploration slots taken by "
    "accounts that did nothing but post once. The griefer column adds ONE account "
    "leaving ONE comment on each honest newcomer — that is enough to evict the "
    "entire honest cohort from need-band 0, which is the band the lane reserves "
    "its slot for."
)

if worst_farm_share > MAX_TOLERATED_FARM_SHARE:
    raise AssertionError(
        f"GATE: an account-count farm took {worst_farm_share:.1%} of the exploration "
        f"budget (bound {MAX_TOLERATED_FARM_SHARE:.0%}). The lane exists to give new "
        f"authors reach; at this share it gives it to whoever creates the most "
        f"accounts. Nothing in the lane prices ACCOUNT COUNT — that is B1's serving "
        f"log, which is now BUILT and measurably does NOT close this: it lifts "
        f"newcomer throughput (1 -> 5 distinct authors reached) and bounds any "
        f"single identity, but a farm with more accounts than the lane has slots "
        f"never reaches a per-author cap. The residual is structural — an honest "
        f"newcomer and a sock are behaviourally identical at first post. The open "
        f"decision is `ExplorationConfig.slots_per_page = 0` (no on-ramp) versus "
        f"accepting a farmable on-ramp."
    )
print(f"\nGATE: worst farm share {worst_farm_share:.1%} <= {MAX_TOLERATED_FARM_SHARE:.0%}.")
