"""Q5 — degeneracy probes: feedback loop, flooding, tiny community, dead follows,
whale-votes-everything, empty-feed states."""
from __future__ import annotations

import pathlib
import sys
from dataclasses import replace

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

import numpy as np
from simworld import (
    COMMUNITY,
    EPOCH,
    NOW,
    TAGS,
    TOPICS,
    Account,
    SimGateway,
    build_norm,
    build_world,
    harness_settings,
    ndcg_at_k,
    overlap_at_k,
    topic_entropy,
)

from recsys.config import Settings
from recsys.contracts import EngagementEdge, Post, ViewerProfile, Vote
from recsys.pipeline import TrustPolicy, build_trust_snapshot, rank_feed

# This degenerate-input harness measures PRE-hardening Phase-0 behaviour on
# viewers with NO trust snapshot by design, so its snapshot-less rank_feed calls
# ([C], [D], [F]) explicitly opt into the permissive path. Production defaults to
# TrustPolicy.FAIL_CLOSED (R2) and would refuse a no-snapshot request.
_PERMISSIVE = TrustPolicy.WARN

# SEED is an argument (matches q9's convention): the project's established
# multi-seed calibration set is 7/11/23/42. Default unchanged (7).
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 7
# ★ B-07 (2026-08-04): routed through harness_settings() (mutate_panels.py).
settings = harness_settings()

# ---- [A] feedback loop over 5 sessions ----
world = build_world(seed=SEED)
gw = SimGateway(world)
norm = build_norm(world)
name = "v-photo-00"
world.follows = dict(world.follows)
engaged_authors: set[str] = set()
added: list[EngagementEdge] = []
prev = None
print("[A] 5 sessions, viewer votes top-5 unengaged posts each session (CF+cred retrain):")
for s in range(5):
    snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)  # C5/R2: synthetic world, no real seed lands
    v = ViewerProfile(account=name, follows=world.follows[name],
                      interest_tags=frozenset(TAGS["photo"]))
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
world = build_world(seed=SEED)
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
snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)  # C5/R2: synthetic world, no real seed lands
# Case A: viewer FOLLOWS the flooder
va = ViewerProfile(account="v-photo-00", follows=world.follows["v-photo-00"] | {FLOOD},
                   interest_tags=frozenset(TAGS["photo"]))
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
                   interest_tags=frozenset(TAGS["photo"]))
from recsys.pipeline import gather_candidates

cand = gather_candidates(vb, gw, EPOCH, 400, settings)
n_flood_cand = sum(1 for c in cand if c.post.author == FLOOD)
fb = [sc.post for sc in rank_feed(vb, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
n_flood_feed = sum(1 for p in fb if p.author == FLOOD)
print(f"    NOT followed (10 posts vouched): {n_flood_cand} flood candidates after OON cap "
      f"(cap=3), {n_flood_feed} in feed")

# ---- [C] 3-person tag cluster, cold viewer ----
# ★ Previously a 3-person COMMUNITY (`interest_communities`); communities were
# retired as a viewer-facing lane 2026-08-04 (R1/R3), so the same degenerate
# shape — a cold viewer's ONLY interest is a tiny cluster of authors — is now
# reached via a tag nobody else uses. `Post.community` still gets set (R1
# keeps the field as an internal topic-grouping key); it is no longer what
# routes the viewer to these posts.
world = build_world(seed=SEED)
TINY_TAG = "tiny"
for i in range(3):
    a = Account(f"tiny-{i}", "photo", 0.6, 5.0, 40.0, True)
    world.accounts[a.name] = a
    world.follows = dict(world.follows); world.follows[a.name] = frozenset()
    for j in range(2):
        p = Post(author=a.name, permlink=f"t{j}", category="tiny", community="hive-999",
                 created=NOW - timedelta(hours=10 + i + j), children=0, reblog_count=0,
                 author_reputation=40.0, tags=(TINY_TAG,), votes=())
        world.posts.append(p); world.post_topic[p.key] = "photo"
        world.post_engagers[p.key] = set()
gw = SimGateway(world)
norm = build_norm(world)
vt = ViewerProfile(account="tinyfan", is_new=True, interest_tags=frozenset({TINY_TAG}))
world.accounts["tinyfan"] = Account("tinyfan", "photo", 0.5, 1.0, 25.0, False)
ft = rank_feed(vt, gw, norm, now=NOW, since=EPOCH, settings=settings, trust_policy=_PERMISSIVE)
print(f"\n[C] cold viewer whose ONLY interest is a 3-person tag cluster: feed size {len(ft)} "
      f"(no top-up: popular_fallback fires only on a fully EMPTY eligible set)")

# ---- [D] established viewer, dead follows ----
world = build_world(seed=SEED)
for i in range(3):
    world.accounts[f"ghost-{i}"] = Account(f"ghost-{i}", "photo", 0.3, 1.0, 25.0, True)
    world.follows = dict(world.follows); world.follows[f"ghost-{i}"] = frozenset()
gw = SimGateway(world)
norm = build_norm(world)
vd = ViewerProfile(account="quiet", follows=frozenset({"ghost-0", "ghost-1", "ghost-2"}))
world.accounts["quiet"] = Account("quiet", "photo", 0.5, 1.0, 25.0, False)
fd = rank_feed(vd, gw, norm, now=NOW, since=EPOCH, settings=settings, trust_policy=_PERMISSIVE)
print(f"\n[D] established viewer (3 follows, all inactive; no interest tags): feed size {len(fd)} "
      f"-> {'EMPTY, no fallback (is_cold=False blocks popular_fallback)' if not fd else 'ok'}")

# ---- [E] one whale votes on everything ----
world = build_world(seed=SEED)
gw = SimGateway(world)
norm = build_norm(world)
snap = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)  # C5/R2: synthetic world, no real seed lands
v = ViewerProfile(account="v-photo-00", follows=world.follows["v-photo-00"],
                  interest_tags=frozenset(TAGS["photo"]))
base_feed = [sc.post for sc in rank_feed(v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap)]
world.accounts["whale"] = Account("whale", "crypto", 0.5, 50000.0, 70.0, False)
new_posts = []
for p in world.posts:
    wv = Vote(voter="whale", rshares=int(5e13), timestamp=p.created + timedelta(minutes=10))
    # ★ `replace`, not a fresh `Post` (2026-08-01). Rebuilding as a plain `Post`
    # silently DROPPED comment/reblog attribution from every post in the world,
    # so `base_feed` above had it and `whale_feed` below did not — the panel was
    # varying two things at once and calling the result "the whale's effect".
    # `dataclasses.replace` preserves the concrete class and every other field.
    new_posts.append(replace(p, votes=(*p.votes, wv)))
    world.post_engagers[p.key].add("whale")
world.posts = new_posts
gw = SimGateway(world)
norm2 = build_norm(world)
snap2 = build_trust_snapshot(
    gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
)  # C5/R2: synthetic world, no real seed lands
whale_feed = [sc.post for sc in rank_feed(v, gw, norm2, now=NOW, since=EPOCH, settings=settings, snapshot=snap2)]
ov = overlap_at_k(base_feed, whale_feed)
scored = rank_feed(v, gw, norm2, now=NOW, since=EPOCH, settings=settings, snapshot=snap2)
vn = [sc.score.vote_norm for sc in scored]
print(f"\n[E] whale (50k HP) votes on EVERY post: top-20 overlap with baseline {ov}/20; "
      f"vote_norm spread now std {np.std(vn):.3f} (breadth term keeps ordering: "
      f"nDCG {ndcg_at_k(whale_feed, 'v-photo-00', world):.3f} vs baseline "
      f"{ndcg_at_k(base_feed, 'v-photo-00', world):.3f})")

# ---- [F] everyone-follows-nobody population ----
world = build_world(seed=SEED)
gw = SimGateway(world)
norm = build_norm(world)
nonempty = 0; n = 0
for t in TOPICS:
    for j in range(2):
        nm = f"v-{t}-{j:02d}"
        acct = world.accounts[nm]
        vv = ViewerProfile(account=nm, is_new=False, follows=frozenset(),
                           interest_tags=frozenset(TAGS[t]))
        ff = rank_feed(vv, gw, norm, now=NOW, since=EPOCH, settings=settings,
                       trust_policy=_PERMISSIVE)
        n += 1
        nonempty += bool(ff)
print(f"\n[F] all-cold population (nobody follows anyone, interests picked): "
      f"{nonempty}/{n} viewers get a non-empty feed")

# ===========================================================================
# SELF-CHECK (B-07) — two of this panel's six degenerate probes have a real,
# mutation-verified mechanism to gate on: [B]'s OON flood cap, and [F]'s
# cold-population reach. Verified by mutation (LUMEN_SETTINGS_MUTANT) across
# seeds 7/11/23/42 before the floors below were chosen.
#
# [A], [C], [D], [E] are NOT asserted on below, and that is a deliberate,
# argued decision, not an oversight:
#   [A] the 5-session feedback loop is a DOCUMENTED, already-known finding
#       (feeds freeze once the diversity re-ranker has nothing left to
#       shuffle -- this is the motivating measurement for
#       `DiversityConfig.explore_slots` existing at all, per that field's own
#       docstring: "a returning viewer's top-20 was identical across 77-79 of
#       every 79 consecutive sessions"). There is no target floor/ceiling for
#       topic-entropy or engaged-author-share this project has committed to;
#       asserting a number here would either codify the KNOWN freeze as
#       "correct" or invent an arbitrary bar. Left as a diagnostic printout.
#   [C], [D] both hinge on an empty-vs-nonempty transition for a hand-built
#       fixture; no Settings mutation was found in this session that moves
#       either result while staying faithful to what the print string claims
#       (`[C]`'s own comment: "popular_fallback fires only on a fully EMPTY
#       eligible set" -- yet the measured feed size is 20, meaning some OTHER
#       lane already fills it, and time did not allow tracing which one
#       before committing to a floor). Left unasserted rather than guessed.
#   [E] whale/breadth resistance: tried `weights.organic_voter_breadth=0.0`
#       (the term the print string's own "(breadth term keeps ordering...)"
#       comment names) and `norm.rshares_floor=1.0` (the log-compression
#       floor a whale's raw rshares would otherwise swamp) -- NEITHER moved
#       top-20 overlap on any of seeds 7/11/23/42. Further, `simworld.
#       build_norm()` (the function that builds the `norm` object every
#       rank_feed call in this file uses) takes NO `Settings` argument at
#       all, so `NormConfig` fields are structurally unreachable from this
#       harness regardless of which mutation is tried -- confirmed by
#       reading `simworld.py`, not assumed. No config-level mutant was found
#       that breaks this property; diagnostic only.
# ===========================================================================
print("\nSELF-CHECK — the two degenerate-input probes with a real config-level mechanism:")

# [1] [B] NOT-followed flood: the OON per-author flood cap
# (`FloodingConfig.max_oon_posts_per_author`) must keep a 50-post/2h flooder
# down near its shipped cap, not let it flood the feed. MEASURED baseline
# `n_flood_feed`, seeds 7/11/23/42: EXACTLY 3 every seed (== the shipped cap
# itself). Mutating `flooding.max_oon_posts_per_author` to 50 (effectively
# uncapped, matching the flooder's own post count) lets every flood post
# through on every one of the same 4 seeds: `n_flood_feed` jumps to EXACTLY
# 50. 10 sits with wide margin between the two.
FLOOD_CEILING = 10
ok1 = n_flood_feed < FLOOD_CEILING
print(f"    [1] [B] NOT-followed flood posts in feed = {n_flood_feed}   (must be < {FLOOD_CEILING})   "
      f"{'OK' if ok1 else '** FAIL **'}")

# [2] [F] an all-cold population (nobody follows anyone, interests picked)
# must still get served -- the interest lane must reach essentially
# everyone. MEASURED baseline, seeds 7/11/23/42: 12/12 every seed, no
# exceptions. Mutating `diversity.top_k` to 0 (the post-eligibility
# truncation this project's own review already flagged as the REAL guard,
# ahead of the `min_feed_size` bail the pipeline docstring used to claim --
# see `FallbackConfig.max_share_of_feed`'s docstring) collapses this to
# EXACTLY 0/12 on every one of the same 4 seeds. 8 sits comfortably between
# the two.
NONEMPTY_FLOOR = 8
ok2 = nonempty > NONEMPTY_FLOOR
print(f"    [2] [F] all-cold population non-empty = {nonempty}/{n}   (must be > {NONEMPTY_FLOOR})   "
      f"{'OK' if ok2 else '** FAIL **'}")

assert ok1, (
    f"[B] NOT-followed flood posts in feed = {n_flood_feed} did not clear {FLOOD_CEILING} -- the "
    "OON flood cap (FloodingConfig.max_oon_posts_per_author) may be dead"
)
assert ok2, (
    f"[F] all-cold population non-empty = {nonempty}/{n} did not clear {NONEMPTY_FLOOR} -- the "
    "cold-start interest lane may be strangled for a whole population, not just one viewer "
    "(check diversity.top_k)"
)
print("\nALL SELF-CHECKS PASSED — the OON flood cap is holding and the cold-start interest lane "
      "reaches the whole all-cold population.")
