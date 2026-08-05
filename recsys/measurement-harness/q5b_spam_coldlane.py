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

from recsys.contracts import ViewerProfile
from recsys.core.vote_signal import AttributedPost
from recsys.pipeline import build_trust_snapshot, rank_feed

# SEED is an argument (matches q9's convention): the project's established
# multi-seed calibration set is 7/11/23/42. Default unchanged (7).
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7
world = build_world(seed=SEED)
# ★ B-07 (2026-08-04): routed through harness_settings() (mutate_panels.py).
settings = harness_settings()

SPAM = "spammer"
world.accounts[SPAM] = Account(SPAM, "photo", 0.1, 1.0, 25.0, True)
world.follows = dict(world.follows)
world.follows[SPAM] = frozenset()
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
    spam_posts.append(p)
    world.posts.append(p)
    world.post_topic[p.key] = "photo"
    world.post_engagers[p.key] = set()
gw = SimGateway(world)
norm = build_norm(world)
snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)  # C5/R2

vc = ViewerProfile(account="cold1", is_new=True,
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
                   interest_tags=frozenset(TAGS["photo"]))
fe = rank_feed(ve, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)
pos_e = [i for i, sc in enumerate(fe) if sc.post.author == SPAM]
print(f"established-viewer feed: spam positions {pos_e} (gate blocks: {not pos_e})")

# ===========================================================================
# SELF-CHECK (B-07) — this panel's whole point is: the interest lane cannot
# BLOCK a self-engagement-farmed spam post (it is gate-exempt, by design),
# so the defense has to be that SCORING keeps it buried and low-credit. Two
# checks below, both verified by mutation (LUMEN_SETTINGS_MUTANT) across
# seeds 7/11/23/42 before the floors were chosen.
#
# NOTE ON THE PRE-DECLARED MUTANT: `mutate_panels.py` lists
# `exploration.slots_per_page=0` for this panel. Tested directly (all 4
# seeds): it moves every spam position printed above by AT MOST 1 slot (the
# exploration lane's own single insertion shifting indices by one) and does
# not move organic_pct at all -- it is simply not connected to the mechanism
# this panel measures (self-engagement exclusion, not the exploration
# lane). The two checks below instead target a mutation that DOES move this
# panel's actual claim: `weights.organic_recency`.
# ===========================================================================
max_spam_organic_pct = max(org for _, org, _ in top) if top else 0.0
min_pos_established = min(pos_e) if pos_e else 10**9

print("\nSELF-CHECK — self-engagement exclusion must keep a farmed spam post low-credit and buried:")

# [1] spam's own organic_pct (percentile within the window) must stay near
# the bottom, not climb toward the top of the distribution. MEASURED
# baseline max across the 3 spam posts, seeds 7/11/23/42: 0.042, 0.033,
# 0.035, 0.036 (max 0.042). Mutating `weights.organic_recency` from 0.10 to
# 2.0 (the freshness bonus large enough to swamp the near-zero engagement
# base) sends this to EXACTLY 1.000 -- the top of the window -- on every one
# of the same 4 seeds, because the spam posts are only 2-4 hours old and
# freshness alone now dominates. 0.20 sits with wide margin between the two.
ORGANIC_PCT_CEILING = 0.20
ok1 = max_spam_organic_pct < ORGANIC_PCT_CEILING
print(f"    [1] max spam organic_pct = {max_spam_organic_pct:.3f}   (must be < "
      f"{ORGANIC_PCT_CEILING:.2f})   {'OK' if ok1 else '** FAIL **'}")

# [2] spam must not reach the established viewer's visible top-20, even
# though the interest lane structurally cannot block it outright. MEASURED
# baseline best (minimum) position, seeds 7/11/23/42: 32, 36, 37, 34 (min
# 32). Under the same `organic_recency=2.0` mutation the best position falls
# to 20, 19, 19, 18 across the same 4 seeds -- INSIDE or right at the top-20
# boundary on every one of them. 25 sits strictly between the two, clearing
# the mutant's 18-20 on every seed while leaving the baseline's 32-37 a
# comfortable margin above it.
MIN_POS_FLOOR = 25
ok2 = min_pos_established > MIN_POS_FLOOR
print(f"    [2] established-viewer best spam position = {min_pos_established}   (must be > "
      f"{MIN_POS_FLOOR})   {'OK' if ok2 else '** FAIL **'}")

assert ok1, (
    f"max spam organic_pct = {max_spam_organic_pct:.3f} did not clear {ORGANIC_PCT_CEILING:.2f} "
    "-- self-engagement exclusion (§8.4) may no longer be keeping a farmed post's organic "
    "percentile near the bottom of the window"
)
assert ok2, (
    f"established-viewer best spam position = {min_pos_established} did not clear "
    f"{MIN_POS_FLOOR} -- a self-engagement-farmed spam post may now be reaching the visible "
    "top-20 through the gate-exempt interest lane"
)
print("\nALL SELF-CHECKS PASSED — the farmed spam post stays low-percentile and buried well "
      "outside the visible page, even though the interest lane cannot block it outright.")
