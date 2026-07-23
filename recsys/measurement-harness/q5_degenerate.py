"""Q5 — degeneracy probes: feedback loop, flooding, tiny community, dead follows,
whale-votes-everything, empty-feed states."""
from __future__ import annotations
import sys
sys.path.insert(0, "/tmp/claude-1004/-home-clauderfly/fa2f34ba-7811-45c8-a634-26cb2cbffb1b/scratchpad/algo")
from simworld import (build_world, SimGateway, build_norm, EPOCH, NOW, TOPICS, COMMUNITY, TAGS,
                      Account, ndcg_at_k, overlap_at_k, topic_entropy)
import numpy as np
from datetime import timedelta
from collections import Counter
from recsys.contracts import ViewerProfile, Post, Vote, EngagementEdge
from recsys.config import Settings
from recsys.pipeline import TrustPolicy, build_trust_snapshot, rank_feed

# This degenerate-input harness measures PRE-hardening Phase-0 behaviour on
# viewers with NO trust snapshot by design, so its snapshot-less rank_feed calls
# ([C], [D], [F]) explicitly opt into the permissive path. Production defaults to
# TrustPolicy.FAIL_CLOSED (R2) and would refuse a no-snapshot request.
_PERMISSIVE = TrustPolicy.WARN

settings = Settings()

# ---- [A] feedback loop over 5 sessions ----
world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
name = "v-photo-00"
world.follows = dict(world.follows)
engaged_authors: set[str] = set()
added: list[EngagementEdge] = []
prev = None
print("[A] 5 sessions, viewer votes top-5 unengaged posts each session (CF+cred retrain):")
for s in range(5):
    snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)
    v = ViewerProfile(account=name, follows=world.follows[name],
                      subscribed_communities=frozenset({COMMUNITY["photo"]}))
    f = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
    ent = topic_entropy(f, world)
    eng_share = sum(1 for p in f[:20] if p.author in engaged_authors) / 20
    ov = overlap_at_k(prev, f) if prev is not None else None
    nd = ndcg_at_k(f, name, world)
    print(f"    s{s}: topic-entropy@20 {ent:.2f} bits, engaged-author share {eng_share:.2f}, "
          f"overlap w/ prev {ov}, nDCG {nd:.3f}")
    voted = 0
    for p in f:
        if p.author not in engaged_authors or voted < 5:
            pass
        # vote the top-5 posts of this session
    for p in f[:5]:
        added.append(EngagementEdge(src=name, dst=p.author, upvotes=1, last_interaction=NOW))
        engaged_authors.add(p.author)
    world.edges = world.edges + added[-5:]
    prev = f

# ---- [B] flooding ----
world = build_world(seed=7)
FLOOD = "flooder"
world.accounts[FLOOD] = Account(FLOOD, "photo", 0.5, 10.0, 45.0, True)
world.follows = dict(world.follows); world.follows[FLOOD] = frozenset()
flood_posts = []
for i in range(50):
    p = Post(author=FLOOD, permlink=f"flood-{i}", category="photo",
             community=COMMUNITY["photo"], created=NOW - timedelta(minutes=5 + 2*i),
             children=0, reblog_count=0, author_reputation=45.0, tags=TAGS["photo"], votes=())
    flood_posts.append(p); world.posts.append(p)
    world.post_topic[p.key] = "photo"; world.post_engagers[p.key] = set()
gw = SimGateway(world)
norm = build_norm(world)
snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)
# Case A: viewer FOLLOWS the flooder
va = ViewerProfile(account="v-photo-00", follows=world.follows["v-photo-00"] | {FLOOD},
                   subscribed_communities=frozenset({COMMUNITY["photo"]}))
fa = [sc.post for sc in rank_feed(va, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
sh20 = sum(1 for p in fa[:20] if p.author == FLOOD)
sh50 = sum(1 for p in fa[:50] if p.author == FLOOD)
print(f"\n[B] flooder 50 posts/2h: FOLLOWED -> {sh20}/20 and {sh50}/50 of feed "
      f"(IN_NETWORK exempt from cap; diversity floor 0.25)")
# Case B: not followed; a followed account voted on 10 flood posts
for p in flood_posts[:10]:
    world.post_engagers[p.key] = {"a-photo-13"}
gw = SimGateway(world)
vb = ViewerProfile(account="v-photo-01", follows=world.follows["v-photo-01"],
                   subscribed_communities=frozenset({COMMUNITY["photo"]}))
from recsys.pipeline import gather_candidates
cand = gather_candidates(vb, gw, EPOCH, 400, settings)
n_flood_cand = sum(1 for c in cand if c.post.author == FLOOD)
fb = [sc.post for sc in rank_feed(vb, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
n_flood_feed = sum(1 for p in fb if p.author == FLOOD)
print(f"    NOT followed (10 posts vouched): {n_flood_cand} flood candidates after OON cap "
      f"(cap=3), {n_flood_feed} in feed")

# ---- [C] 3-person community, cold viewer ----
world = build_world(seed=7)
TINY = "hive-999"
for i in range(3):
    a = Account(f"tiny-{i}", "photo", 0.6, 5.0, 40.0, True)
    world.accounts[a.name] = a
    world.follows = dict(world.follows); world.follows[a.name] = frozenset()
    for j in range(2):
        p = Post(author=a.name, permlink=f"t{j}", category="tiny", community=TINY,
                 created=NOW - timedelta(hours=10 + i + j), children=0, reblog_count=0,
                 author_reputation=40.0, tags=("tiny",), votes=())
        world.posts.append(p); world.post_topic[p.key] = "photo"
        world.post_engagers[p.key] = set()
gw = SimGateway(world)
norm = build_norm(world)
vt = ViewerProfile(account="tinyfan", is_new=True, interest_communities=frozenset({TINY}))
world.accounts["tinyfan"] = Account("tinyfan", "photo", 0.5, 1.0, 25.0, False)
ft = rank_feed(vt, gw, norm, now=NOW, since=EPOCH, settings=settings, trust_policy=_PERMISSIVE)
print(f"\n[C] cold viewer whose ONLY interest is a 3-person community: feed size {len(ft)} "
      f"(no top-up: popular_fallback fires only on a fully EMPTY eligible set)")

# ---- [D] established viewer, dead follows ----
world = build_world(seed=7)
for i in range(3):
    world.accounts[f"ghost-{i}"] = Account(f"ghost-{i}", "photo", 0.3, 1.0, 25.0, True)
    world.follows = dict(world.follows); world.follows[f"ghost-{i}"] = frozenset()
gw = SimGateway(world)
norm = build_norm(world)
vd = ViewerProfile(account="quiet", follows=frozenset({"ghost-0", "ghost-1", "ghost-2"}))
world.accounts["quiet"] = Account("quiet", "photo", 0.5, 1.0, 25.0, False)
fd = rank_feed(vd, gw, norm, now=NOW, since=EPOCH, settings=settings, trust_policy=_PERMISSIVE)
print(f"\n[D] established viewer (3 follows, all inactive; no communities): feed size {len(fd)} "
      f"-> {'EMPTY, no fallback (is_cold=False blocks popular_fallback)' if not fd else 'ok'}")

# ---- [E] one whale votes on everything ----
world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)
v = ViewerProfile(account="v-photo-00", follows=world.follows["v-photo-00"],
                  subscribed_communities=frozenset({COMMUNITY["photo"]}))
base_feed = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
world.accounts["whale"] = Account("whale", "crypto", 0.5, 50000.0, 70.0, False)
new_posts = []
for p in world.posts:
    wv = Vote(voter="whale", rshares=int(5e13), timestamp=p.created + timedelta(minutes=10))
    new_posts.append(Post(author=p.author, permlink=p.permlink, category=p.category,
                          community=p.community, created=p.created, children=p.children,
                          reblog_count=p.reblog_count, author_reputation=p.author_reputation,
                          tags=p.tags, votes=(*p.votes, wv)))
    world.post_engagers[p.key].add("whale")
world.posts = new_posts
gw = SimGateway(world)
norm2 = build_norm(world)
snap2 = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)
whale_feed = [sc.post for sc in rank_feed(v, gw, norm2, now=NOW, since=EPOCH, settings=settings, snapshot=snap2)]
ov = overlap_at_k(base_feed, whale_feed)
scored = rank_feed(v, gw, norm2, now=NOW, since=EPOCH, settings=settings, snapshot=snap2)
vn = [sc.score.vote_norm for sc in scored]
print(f"\n[E] whale (50k HP) votes on EVERY post: top-20 overlap with baseline {ov}/20; "
      f"vote_norm spread now std {np.std(vn):.3f} (breadth term keeps ordering: "
      f"nDCG {ndcg_at_k(whale_feed, 'v-photo-00', world):.3f} vs baseline "
      f"{ndcg_at_k(base_feed, 'v-photo-00', world):.3f})")

# ---- [F] everyone-follows-nobody population ----
world = build_world(seed=7)
gw = SimGateway(world)
norm = build_norm(world)
nonempty = 0; n = 0
for t in TOPICS:
    for j in range(2):
        nm = f"v-{t}-{j:02d}"
        acct = world.accounts[nm]
        vv = ViewerProfile(account=nm, is_new=False, follows=frozenset(),
                           interest_communities=frozenset({COMMUNITY[t]}),
                           interest_tags=frozenset(TAGS[t]))
        ff = rank_feed(vv, gw, norm, now=NOW, since=EPOCH, settings=settings,
                       trust_policy=_PERMISSIVE)
        n += 1
        nonempty += bool(ff)
print(f"\n[F] all-cold population (nobody follows anyone, interests picked): "
      f"{nonempty}/{n} viewers get a non-empty feed")
