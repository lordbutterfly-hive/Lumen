"""Q3 — new-author discovery: can a fresh author with no graph/rep/votes surface?"""
from __future__ import annotations
import sys
sys.path.insert(0, "/tmp/claude-1004/-home-clauderfly/fa2f34ba-7811-45c8-a634-26cb2cbffb1b/scratchpad/algo")
from simworld import (build_world, SimGateway, build_norm, EPOCH, NOW, TOPICS, COMMUNITY, TAGS,
                      Account, DAYS)
import numpy as np
from datetime import timedelta
from recsys.contracts import ViewerProfile, Post, Vote, EngagementEdge
from recsys.config import Settings
from recsys.pipeline import TrustPolicy, build_trust_snapshot, rank_feed

world = build_world(seed=7)
settings = Settings()

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
snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)

def positions(feed_posts, keys):
    return [i for i, p in enumerate(feed_posts) if p.key in keys]

nk = {p.key for p in newbie_posts}

# (a) cold viewer with photo interests
vc = ViewerProfile(account="cold1", is_new=True,
                   interest_communities=frozenset({COMMUNITY["photo"]}),
                   interest_tags=frozenset(TAGS["photo"]))
world.accounts["cold1"] = Account("cold1", "photo", 0.5, 1.0, 25.0, False)
fc = [sc.post for sc in rank_feed(vc, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
pos_c = positions(fc, nk)
print(f"[A] cold photo viewer: feed {len(fc)}; newbie positions {pos_c} "
      f"(top-20 hit: {any(i < 20 for i in pos_c)})")

# (b) established photo viewers: visible at all?
est_hits = 0; est_n = 0
for j in range(10):
    name = f"v-photo-{j:02d}"
    v = ViewerProfile(account=name, follows=world.follows[name],
                      subscribed_communities=frozenset({COMMUNITY["photo"]}))
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
p0v = Post(author=p0.author, permlink=p0.permlink, category=p0.category, community=p0.community,
           created=p0.created, children=0, reblog_count=0, author_reputation=25.0,
           tags=p0.tags, votes=(vote,))
world.posts[idx0] = p0v
world.post_engagers[p0.key] = {voucher}
world.edges.append(EngagementEdge(src=voucher, dst=NEWBIE, upvotes=1, last_interaction=vote.timestamp))
gw = SimGateway(world)
norm = build_norm(world)
snap1 = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)
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
                      subscribed_communities=frozenset({COMMUNITY["photo"]}))
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
                      subscribed_communities=frozenset({COMMUNITY["photo"]}))
    f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings,
                                     snapshot=None, trust_policy=TrustPolicy.WARN)]
    if positions(f, {p0v.key}):
        seen0 += 1
print(f"    (snapshot=None: {seen0}/10 established viewers see it)")

# (d) how many votes until top-20 for established viewers?
for extra in [3, 8]:
    voters = [f"a-photo-{j:02d}" for j in range(1, 1 + extra)]
    votes = tuple([vote] + [Vote(voter=w, rshares=int(world.accounts[w].stake * 1e9),
                                 timestamp=p0.created + timedelta(hours=1 + i))
                            for i, w in enumerate(voters)])
    p0x = Post(author=p0.author, permlink=p0.permlink, category=p0.category, community=p0.community,
               created=p0.created, children=2, reblog_count=1, author_reputation=25.0,
               tags=p0.tags, votes=votes)
    world.posts[idx0] = p0x
    world.post_engagers[p0.key] = {voucher, *voters}
    gw = SimGateway(world)
    norm = build_norm(world)
    snapx = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)
    in20 = in50 = 0
    for j in range(10):
        name = f"v-photo-{j:02d}"
        v = ViewerProfile(account=name, follows=world.follows[name],
                          subscribed_communities=frozenset({COMMUNITY["photo"]}))
        f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snapx)]
        pos = positions(f, {p0x.key})
        if pos and pos[0] < 20: in20 += 1
        if pos and pos[0] < 50: in50 += 1
    cred = snapx.graph_creds.get(NEWBIE)
    print(f"\n[D] {1+extra} votes + 2 comments + 1 reblog: newbie cred={cred.score:.3f}; "
          f"top-20 for {in20}/10, top-50 for {in50}/10 established photo viewers")
