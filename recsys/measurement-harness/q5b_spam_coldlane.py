"""Q5b — the spam vector the gate can't see: sybil author + comment-count farming
into the gate-EXEMPT cold-start interest lane."""
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

from simworld import COMMUNITY, EPOCH, NOW, TAGS, Account, SimGateway, build_norm, build_world

from recsys.config import Settings
from recsys.contracts import ViewerProfile
from recsys.core.vote_signal import AttributedPost
from recsys.pipeline import build_trust_snapshot, rank_feed

world = build_world(seed=7)
settings = Settings()

SPAM = "spammer"
world.accounts[SPAM] = Account(SPAM, "photo", 0.1, 1.0, 25.0, True)
world.follows = dict(world.follows); world.follows[SPAM] = frozenset()
# 3 spam posts, each with 60 self-comments + 20 self-reblogs, zero votes.
#
# ★ ATTRIBUTED (2026-08-01). These were plain `Post`s carrying bare counters,
# and once the world started emitting `AttributedPost` the scorer read the
# spammer's engagement as EXACTLY ZERO — so this panel passed trivially, for the
# wrong reason: it was measuring "a post with no attribution scores nothing",
# not "self-engagement is excluded". Its spam `organic_pct` fell 0.122 -> 0.042
# purely because the rest of the world gained signal while the spam post stayed
# at zero. Naming the spammer as its own commenter/reblogger is what actually
# exercises the §8.4 self-exclusion this panel exists to test.
spam_posts = []
for i in range(3):
    p = AttributedPost(author=SPAM, permlink=f"spam-{i}", category="photo",
             community=COMMUNITY["photo"], created=NOW - timedelta(hours=2 + i),
             children=60, reblog_count=20, author_reputation=25.0,
             tags=TAGS["photo"], votes=(),
             commenters=(SPAM,), rebloggers=(SPAM,))
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
