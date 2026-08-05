"""Q3 — new-author discovery: can a fresh author with no graph/rep/votes surface?"""
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

from datetime import timedelta

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

from recsys.contracts import EngagementEdge, Post, ViewerProfile, Vote
from recsys.core.vote_signal import AttributedPost
from recsys.pipeline import TrustPolicy, build_trust_snapshot, rank_feed

# SEED is an argument (matches q9's convention): the project's established
# multi-seed calibration set is 7/11/23/42. Default unchanged (7).
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7
world = build_world(seed=SEED)
# ★ B-07 (2026-08-04): routed through harness_settings() so this panel's
# `Settings()` construction can be mutation-tested by mutate_panels.py
# (LUMEN_SETTINGS_MUTANT). Absent that env var this is byte-identical to
# `Settings()`.
settings = harness_settings()

NEWBIE = "newbie-author"
world.accounts[NEWBIE] = Account(NEWBIE, "photo", 0.9, 1.0, 25.0, True)
world.follows = dict(world.follows); world.follows[NEWBIE] = frozenset()
newbie_posts = []
for i in range(3):
    p = Post(author=NEWBIE, permlink=f"debut-{i}", category="photo",
             community=COMMUNITY["photo"], created=NOW - timedelta(hours=6 + 3*i),
             children=0, reblog_count=0, author_reputation=25.0,
             tags=TAGS["photo"], votes=())
    newbie_posts.append(p)
    world.posts.append(p)
    world.post_topic[p.key] = "photo"
    world.post_engagers[p.key] = set()

gw = SimGateway(world)
norm = build_norm(world)          # refreshed window includes the new posts
# production=False (C5/R2, 2026-08-04 fixture migration): synthetic
# simworld accounts, no real curated seed lands in this graph.
snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)

def positions(feed_posts, keys):
    return [i for i, p in enumerate(feed_posts) if p.key in keys]

nk = {p.key for p in newbie_posts}

# (a) cold viewer with photo interests
vc = ViewerProfile(account="cold1", is_new=True,
                   interest_tags=frozenset(TAGS["photo"]))
world.accounts["cold1"] = Account("cold1", "photo", 0.5, 1.0, 25.0, False)
fc = [sc.post for sc in rank_feed(vc, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
pos_c = positions(fc, nk)
a_top20_hit = any(i < 20 for i in pos_c)
print(f"[A] cold photo viewer: feed {len(fc)}; newbie positions {pos_c} "
      f"(top-20 hit: {any(i < 20 for i in pos_c)})")

# (b) established photo viewers: visible at all?
est_hits = 0; est_n = 0
for j in range(10):
    name = f"v-photo-{j:02d}"
    v = ViewerProfile(account=name, follows=world.follows[name],
                      interest_tags=frozenset(TAGS["photo"]))
    f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
    est_n += 1
    if positions(f, nk):
        est_hits += 1
print(f"[B] established photo viewers seeing newbie ANYWHERE in feed: {est_hits}/{est_n} "
      f"(0 votes -> no vouch -> gated)")

# (c) one vouch vote: pick the photo author FOLLOWED BY THE MOST photo viewers
from collections import Counter

fcount = Counter()
for j in range(10):
    for a in world.follows[f"v-photo-{j:02d}"]:
        fcount[a] += 1
voucher = max((a for a in fcount if world.accounts[a].topic == "photo"), key=lambda a: fcount[a])
print(f"\nvoucher {voucher} is followed by {fcount[voucher]}/10 established photo viewers")
p0 = newbie_posts[0]
vote = Vote(voter=voucher, rshares=int(world.accounts[voucher].stake * 1e9), timestamp=p0.created + timedelta(minutes=30))
idx0 = world.posts.index(p0)
# ★ AttributedPost (2026-08-01). Rebuilt as a plain `Post`, the newbie's post was
# the ONE post in the world carrying no attribution — so while every other post
# gained comment/reblog signal, the new author was measured with that channel
# forced to zero. The panel's whole question is whether a new author can break
# through, and it was answering it with the new author handicapped.
p0v = AttributedPost(author=p0.author, permlink=p0.permlink, category=p0.category,
           community=p0.community,
           created=p0.created, children=0, reblog_count=0, author_reputation=25.0,
           tags=p0.tags, votes=(vote,), commenters=(), rebloggers=())
world.posts[idx0] = p0v
world.post_engagers[p0.key] = {voucher}
world.edges.append(EngagementEdge(src=voucher, dst=NEWBIE, upvotes=1, last_interaction=vote.timestamp))
gw = SimGateway(world)
norm = build_norm(world)
snap1 = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)
cred_newbie = snap1.graph_creds.get(NEWBIE)
below = [a for a, c in snap1.graph_creds.items() if c.score < settings.thresholds.graph_cred_floor]
print(f"\n[C] after ONE vouch vote (voucher {voucher}):")
print(f"    newbie now IN snapshot: cred={cred_newbie.score if cred_newbie else None}")
print(f"    accounts below OON graph-cred floor 0.05: {len(below)}/{len(snap1.graph_creds)} "
      f"({len(below)/len(snap1.graph_creds):.1%}) -> sample {sorted(below)[:6]}")
seen = 0; best_pos = []
for j in range(10):
    name = f"v-photo-{j:02d}"
    v = ViewerProfile(account=name, follows=world.follows[name],
                      interest_tags=frozenset(TAGS["photo"]))
    f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap1)]
    pos = positions(f, {p0v.key})
    if pos:
        seen += 1; best_pos.append(pos[0])
print(f"    established photo viewers seeing vouched debut-0: {seen}/10, positions {sorted(best_pos)}")
if cred_newbie is not None and cred_newbie.score < settings.thresholds.graph_cred_floor:
    print("    !! newbie IS in snapshot with cred < floor -> author-floor now BLOCKS them "
          "(fail-open only while absent)")

# same check WITHOUT any snapshot: this harness measures PRE-hardening Phase-0
# behaviour by design, so it explicitly opts into the permissive path
# (trust_policy=WARN). Production defaults to FAIL_CLOSED and would refuse here.
seen0 = 0
for j in range(10):
    name = f"v-photo-{j:02d}"
    v = ViewerProfile(account=name, follows=world.follows[name],
                      interest_tags=frozenset(TAGS["photo"]))
    f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings,
                                     snapshot=None, trust_policy=TrustPolicy.WARN)]
    if positions(f, {p0v.key}):
        seen0 += 1
print(f"    (snapshot=None: {seen0}/10 established viewers see it)")

# (d) how many votes until top-20 for established viewers?
#
# ★ B-09 (2026-08-04). This used to hardcode three commenter/reblogger names
# at index 20, 21, 22 in the a-photo-NN series — `authors_per_topic=20` means
# the world only holds a-photo-00..19, so those three names are ABSENT from
# `world.accounts`. They therefore carried no graph-cred, no ALS row, and
# landed in the unknown trust tier by construction — exactly the condition
# `ALGO-EXPLORATION-LANE` §2 then blames for the residual. Circular: the
# fixture manufactured its own "unknown engager" result rather than measuring
# one. Fixed by running the rung twice against REAL accounts — an established
# audience (existing a-photo authors that carry their own footprint from
# `build_world`) and a fresh/unvouched audience (accounts added with zero
# other footprint, same mechanism as NEWBIE/cold1 above) — so the panel shows
# the distinction Council B already found for the vouch-vote case (10/10 vs
# 0/10, `ALGO-COUNCIL-2026-08-03.md`) instead of accidentally picking one.
ESTABLISHED_COMMENTERS = ("a-photo-09", "a-photo-10")  # real authors, distinct
ESTABLISHED_REBLOGGERS = ("a-photo-11",)               # from `voters` (01..08)
FRESH_COMMENTERS = ("fresh-commenter-1", "fresh-commenter-2")
FRESH_REBLOGGERS = ("fresh-reblogger-1",)
for _name in FRESH_COMMENTERS + FRESH_REBLOGGERS:
    world.accounts.setdefault(_name, Account(_name, "photo", 0.5, 1.0, 25.0, False))

d_results: dict[tuple[str, int], tuple[int, int]] = {}  # (audience, extra) -> (in20, in50)
for audience_label, commenters, rebloggers in (
    ("established audience", ESTABLISHED_COMMENTERS, ESTABLISHED_REBLOGGERS),
    ("fresh audience", FRESH_COMMENTERS, FRESH_REBLOGGERS),
):
    for extra in [3, 8]:
        voters = [f"a-photo-{j:02d}" for j in range(1, 1 + extra)]
        votes = tuple([vote] + [Vote(voter=w, rshares=int(world.accounts[w].stake * 1e9),
                                     timestamp=p0.created + timedelta(hours=1 + i))
                                for i, w in enumerate(voters)])
        # The 2 comments and 1 reblog need IDENTITIES or they score nothing at all —
        # `children`/`reblog_count` are display counters the scorer ignores. Named
        # commenters/rebloggers distinct from the author and from each other, which
        # is what "2 comments + 1 reblog" was always meant to represent.
        p0x = AttributedPost(author=p0.author, permlink=p0.permlink, category=p0.category,
                   community=p0.community,
                   created=p0.created, children=2, reblog_count=1, author_reputation=25.0,
                   tags=p0.tags, votes=votes,
                   commenters=commenters, rebloggers=rebloggers)
        world.posts[idx0] = p0x
        world.post_engagers[p0.key] = {voucher, *voters, *commenters, *rebloggers}
        gw = SimGateway(world)
        norm = build_norm(world)
        snapx = build_trust_snapshot(
            gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
        )
        in20 = in50 = 0
        for j in range(10):
            name = f"v-photo-{j:02d}"
            v = ViewerProfile(account=name, follows=world.follows[name],
                              interest_tags=frozenset(TAGS["photo"]))
            f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH,
                                             settings=settings, snapshot=snapx)]
            pos = positions(f, {p0x.key})
            if pos and pos[0] < 20:
                in20 += 1
            if pos and pos[0] < 50:
                in50 += 1
        cred = snapx.graph_creds.get(NEWBIE)
        d_results[(audience_label, extra)] = (in20, in50)
        print(f"\n[D {audience_label}] {1+extra} votes + 2 comments + 1 reblog: "
              f"newbie cred={cred.score:.3f}; "
              f"top-20 for {in20}/10, top-50 for {in50}/10 established photo viewers")

# ===========================================================================
# SELF-CHECK (B-07) — q3's own headline finding (BUILDMAP-B-QUALITY-2026-08-04
# §mutate_panels.py docstring): `exploration.slots_per_page=0` and
# `weights.organic_prior_shrinkage=0.0` were BOTH proven to be MISSED by this
# panel -- it printed the collapse and exited 0 anyway. These two checks
# close exactly that gap. Verified by mutation (LUMEN_SETTINGS_MUTANT) across
# seeds 7/11/23/42 before the floors below were chosen.
# ===========================================================================
print("\nSELF-CHECK — the two discovery mechanisms this panel exists to measure must both fire:")

# [1] the reserved EXPLORATION slot must actually reach a ZERO-engagement
# debut post into a cold viewer's top-20 ([A], before any vote/vouch exists
# at all). MEASURED baseline, seeds 7/11/23/42: top-20 hit True, True, True,
# True (every seed). Mutating `exploration.slots_per_page` to 0 flips this to
# False on every one of the same 4 seeds -- a clean, exact boolean split, no
# floor tuning needed.
ok1 = a_top20_hit is True
print(f"    [1] [A] exploration reaches a 0-engagement debut into top-20 = {a_top20_hit}   "
      f"(must be True)   {'OK' if ok1 else '** FAIL **'}")

# [2] the author-pooled prior must actually un-bury a newcomer at q3's
# hardest loadout: established audience, 9 votes + 2 comments + 1 reblog
# ([D], the round's own stated hard case). top-20 alone is too seed-noisy to
# gate on (measured 9/10, 10/10, 7/10, 0/10 across the 4 seeds -- a real
# range, not just measurement jitter, since the established-viewer follow
# graph differs per seed). top-50 is the stable read: MEASURED baseline,
# seeds 7/11/23/42: 10/10 every seed, no exceptions. Mutating
# `weights.organic_prior_shrinkage` to 0.0 (the pre-shrinkage fixed blend --
# see that field's own docstring) collapses this to EXACTLY 0/10 on every
# one of the same 4 seeds. 5 sits exactly between the two, with maximum
# margin on both sides.
established_in50 = d_results[("established audience", 8)][1]
IN50_FLOOR = 5
ok2 = established_in50 > IN50_FLOOR
print(f"    [2] [D established, 9 votes] top-50 = {established_in50}/10   (must be > {IN50_FLOOR})   "
      f"{'OK' if ok2 else '** FAIL **'}")

assert ok1, (
    f"[A] exploration-lane top-20 hit = {a_top20_hit} -- the reserved exploration slot "
    "(ExplorationConfig.slots_per_page) may no longer be reaching a 0-engagement debut post"
)
assert ok2, (
    f"[D established, 9 votes] top-50 = {established_in50}/10 did not clear {IN50_FLOOR} -- the "
    "author-pooled prior (ScoreWeights.organic_prior_shrinkage) may no longer be un-burying a "
    "newcomer discoverable by an established audience"
)
print("\nALL SELF-CHECKS PASSED — both new-author discovery mechanisms (the exploration slot "
      "for a 0-engagement debut, and the shrunk author-pooled prior for an engaged one) are "
      "measurably doing their job.")
