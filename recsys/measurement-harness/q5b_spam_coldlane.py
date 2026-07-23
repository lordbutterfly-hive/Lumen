"""Q5b — the spam vector the gate can't see: sybil author + comment-count farming
into the gate-EXEMPT cold-start interest lane."""
from __future__ import annotations
import sys
sys.path.insert(0, "/tmp/claude-1004/-home-clauderfly/fa2f34ba-7811-45c8-a634-26cb2cbffb1b/scratchpad/algo")
from simworld import build_world, SimGateway, build_norm, EPOCH, NOW, COMMUNITY, TAGS, Account
from datetime import timedelta
from recsys.contracts import ViewerProfile, Post
from recsys.config import Settings
from recsys.pipeline import rank_feed, build_trust_snapshot

world = build_world(seed=7)
settings = Settings()

SPAM = "spammer"
world.accounts[SPAM] = Account(SPAM, "photo", 0.1, 1.0, 25.0, True)
world.follows = dict(world.follows); world.follows[SPAM] = frozenset()
# 3 spam posts, each with 60 self-comments + 20 self-reblogs (children/reblog_count
# carry no attribution -> cannot be excluded), zero votes.
spam_posts = []
for i in range(3):
    p = Post(author=SPAM, permlink=f"spam-{i}", category="photo",
             community=COMMUNITY["photo"], created=NOW - timedelta(hours=2 + i),
             children=60, reblog_count=20, author_reputation=25.0,
             tags=TAGS["photo"], votes=())
    spam_posts.append(p); world.posts.append(p)
    world.post_topic[p.key] = "photo"; world.post_engagers[p.key] = set()
gw = SimGateway(world)
norm = build_norm(world)
snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)

vc = ViewerProfile(account="cold1", is_new=True,
                   interest_communities=frozenset({COMMUNITY["photo"]}),
                   interest_tags=frozenset(TAGS["photo"]))
world.accounts["cold1"] = Account("cold1", "photo", 0.5, 1.0, 25.0, False)
fc = rank_feed(vc, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)
pos = [i for i, sc in enumerate(fc) if sc.post.author == SPAM]
top = [(i, fc[i].score.organic, fc[i].score.final) for i in pos]
print(f"cold-viewer feed size {len(fc)}; spam positions {pos}")
for i, org, fin in top:
    print(f"    pos {i}: organic_pct {org:.3f} final {fin:.3f}")
# established viewer for contrast
ve = ViewerProfile(account="v-photo-00", follows=world.follows["v-photo-00"],
                   subscribed_communities=frozenset({COMMUNITY["photo"]}))
fe = rank_feed(ve, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)
pos_e = [i for i, sc in enumerate(fe) if sc.post.author == SPAM]
print(f"established-viewer feed: spam positions {pos_e} (gate blocks: {not pos_e})")
