"""Synthetic Hive world with KNOWN ground truth, for measuring recsys behavior.

Builds a population of authors (topic, quality, stake, reputation), viewers
(interest profiles, follows), 7 days of posts/votes/comments/reblogs, an
engagement-edge aggregate, and a follow graph. Provides a SimGateway that
honestly honors query arguments (unlike tests/fakes.FakeGateway, which ignores
them), a NormContext producer, and metric helpers.

Ground truth: rel(viewer, post) = interest_match(viewer, author.topic) * author.quality
"""
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
import dataclasses
import json
import math
import os
import random
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import numpy as np

from recsys.contracts import (
    Candidate,
    CandidateSource,
    EngagementEdge,
    NormContext,
    Post,
    ViewerProfile,
    Vote,
    VoteExclusions,
)
from recsys.core.normalize import build_norm_context
from recsys.core.scoring import AuthorEngagement, post_base_engagement
from recsys.io.hafsql import (
    POPULAR_RECALL_COMMENT_WEIGHT,
    POPULAR_RECALL_REBLOG_WEIGHT,
)
from recsys.core.vote_signal import (
    _ORGANIC_REBLOG_WEIGHT,
    _ORGANIC_REPLY_WEIGHT,
    _ORGANIC_VOTER_MIN_RSHARES,
    _ORGANIC_VOTER_WEIGHT,
    AttributedPost,
    VoterTrust,
    independent_vote_signal,
)
from recsys.pipeline import _organic_signal

EPOCH = datetime(2026, 1, 1, tzinfo=UTC)
DAYS = 7
NOW = EPOCH + timedelta(days=DAYS)

TOPICS = ["photo", "crypto", "gaming", "food", "music", "dev"]
COMMUNITY = {t: f"hive-1{i:02d}" for i, t in enumerate(TOPICS)}
TAGS = {t: (t, f"{t}-life") for t in TOPICS}


@dataclass
class Account:
    name: str
    topic: str
    quality: float          # authors: content quality in [0.2, 0.95]
    stake: float            # HP-like; rshares per vote = stake * 1e9
    reputation: float
    is_author: bool
    secondary: str | None = None  # viewers: secondary interest topic


@dataclass
class World:
    accounts: dict[str, Account]
    posts: list[Post]
    post_topic: dict[str, str]                 # post.key -> topic
    post_engagers: dict[str, set[str]]         # post.key -> voters+commenters+rebloggers
    edges: list[EngagementEdge]
    follows: dict[str, frozenset[str]]         # follower -> followees (global graph)
    rng: random.Random
    nrng: np.random.Generator

    def authors(self) -> list[Account]:
        return [a for a in self.accounts.values() if a.is_author]

    def viewers(self) -> list[Account]:
        return [a for a in self.accounts.values() if not a.is_author]

    def interest_match(self, viewer_name: str, topic: str) -> float:
        v = self.accounts[viewer_name]
        if v.topic == topic:
            return 1.0
        if v.secondary == topic:
            return 0.35
        return 0.05

    def rel(self, viewer_name: str, post: Post) -> float:
        """Ground-truth relevance: interest match x author quality."""
        author = self.accounts[post.author]
        return self.interest_match(viewer_name, author.topic) * author.quality


def _apply_tag_noise(
    true_tags: tuple[str, ...], topic: str, tag_noise: float, tag_rng: random.Random
) -> tuple[str, ...]:
    """B-17 (2026-08-04): simulate an attacker/free-text-controlled first tag.

    WHY THIS EXISTS. Measured at ``tag_noise=0.0`` (the only value that ever
    ran before this unit): **100% of posts** have ``tags[0] == true topic``
    (760/713/751/724 posts across 4 seeds) and every post carries exactly
    ``TAGS[topic] = (topic, f"{topic}-life")`` — two tags, both perfectly
    topic-correlated. After B-00, ``_topic_key`` (``rerank.py``) is
    ``post.tags[0] if post.tags else ""`` with no community fallback, so the
    topic-attenuated unchosen-lane penalty, ``_topic_affinities``,
    ``_attenuate``, the exploration lane's ``_interest_match``, and any
    declared-interest scoring term ALL key off a tag oracle that cannot exist
    on real Hive — there the first tag is attacker-chosen free text.

    DESIGN. Two independent coin flips per post, each at probability
    ``tag_noise``:
      1. tags[0] is REPLACED by a popular tag from a DIFFERENT topic —
         tag-stuffing toward an audience the post has nothing to do with.
      2. the true-topic tag is DROPPED from the tag set entirely — an author
         who never uses the canonical tag (loose/clickbait tagging), rather
         than one actively spraying a foreign tag.
    ``tag_noise=0.0`` never calls ``tag_rng`` (short-circuit) and returns
    ``true_tags`` unchanged, so every existing panel/pin is byte-identical
    unless noise is explicitly requested (§0 of BUILDMAP-B, "must not regress").

    ``tag_rng`` is a caller-supplied, INDEPENDENT random stream (never the
    world's own ``rng``/``nrng``) so that turning noise on or off, or sweeping
    its level, never shifts which random numbers the rest of `build_world`
    consumes — the population, posts, votes, comments and follow graph stay
    byte-identical across ``tag_noise`` values; only tag assignment differs.
    Without this, comparing tag_noise=0.0 against 0.3 would be comparing two
    different random WORLDS, not the same world with noisier tags.
    """
    out = list(true_tags)
    if tag_noise > 0 and tag_rng.random() < tag_noise:
        off_topic = tag_rng.choice([t for t in TOPICS if t != topic])
        out = [off_topic] + [t for t in out if t != off_topic]
    if tag_noise > 0 and tag_rng.random() < tag_noise:
        out = [t for t in out if t != topic] or [f"{topic}-life"]
    return tuple(out)


def build_world(seed: int = 7, authors_per_topic: int = 20, viewers_per_topic: int = 10,
                whales: int = 3, tag_noise: float = 0.0) -> World:
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    # Independent stream — see `_apply_tag_noise` docstring for why tag noise
    # must never consume from `rng`/`nrng`.
    tag_rng = random.Random(f"tag_noise:{seed}")
    accounts: dict[str, Account] = {}

    # --- authors ---
    for t in TOPICS:
        for j in range(authors_per_topic):
            name = f"a-{t}-{j:02d}"
            quality = 0.2 + 0.75 * rng.random()
            stake = 10 ** rng.uniform(0.0, 2.5)          # 1 .. ~316 HP
            # Reputation: correlated with quality (Hive rep accrues from received
            # rshares over a career) + tenure noise.
            rep = 25 + 45 * (0.7 * quality + 0.3 * rng.random()) + rng.gauss(0, 4)
            accounts[name] = Account(name, t, quality, stake, max(25.0, min(80.0, rep)), True)

    # --- viewers (lurker/voter accounts ranked FOR) ---
    for t in TOPICS:
        for j in range(viewers_per_topic):
            name = f"v-{t}-{j:02d}"
            sec = rng.choice([x for x in TOPICS if x != t]) if rng.random() < 0.6 else None
            stake = 10 ** rng.uniform(0.0, 1.8)
            accounts[name] = Account(name, t, 0.5, stake, 45.0, False, secondary=sec)

    # --- whales: crank stake on a few random accounts ---
    whale_names = rng.sample([a.name for a in accounts.values() if a.is_author], whales)
    for w in whale_names:
        accounts[w].stake = 5000.0

    # --- posts ---
    posts: list[Post] = []
    post_topic: dict[str, str] = {}
    raw_votes: dict[str, list[Vote]] = {}
    post_engagers: dict[str, set[str]] = {}
    per_post_replies: dict[str, dict[str, int]] = {}   # key -> commenter -> n
    per_post_reblogs: dict[str, set[str]] = {}

    author_list = [a for a in accounts.values() if a.is_author]
    for a in author_list:
        n_posts = max(1, int(nrng.poisson(rng.uniform(0.4, 1.4) * DAYS)))
        for p in range(n_posts):
            created = EPOCH + timedelta(hours=rng.uniform(0, DAYS * 24))
            in_comm = rng.random() < 0.8
            key_perm = f"post-{p}"
            post_topic[f"@{a.name}/{key_perm}"] = a.topic
            posts.append(Post(
                author=a.name, permlink=key_perm, category=a.topic,
                community=COMMUNITY[a.topic] if in_comm else None,
                created=created, children=0, reblog_count=0,
                author_reputation=a.reputation,
                tags=_apply_tag_noise(TAGS[a.topic], a.topic, tag_noise, tag_rng),
                votes=(),
            ))

    # --- engagement: votes / comments / reblogs, interest x quality driven ---
    def match(acct: Account, topic: str) -> float:
        if acct.topic == topic:
            return 1.0
        if acct.secondary == topic:
            return 0.35
        return 0.05

    everyone = list(accounts.values())
    for post in posts:
        key = post.key
        t = post_topic[key]
        author = accounts[post.author]
        raw_votes[key] = []
        post_engagers[key] = set()
        per_post_replies[key] = {}
        per_post_reblogs[key] = set()
        for acct in everyone:
            if acct.name == post.author:
                continue
            m = match(acct, t)
            base = 0.16 if not acct.is_author else 0.10
            if rng.random() < base * m * author.quality:
                ts = post.created + timedelta(minutes=rng.uniform(5, 600))
                rsh = int(acct.stake * 1e9 * rng.uniform(0.5, 1.0))
                raw_votes[key].append(Vote(voter=acct.name, rshares=rsh, timestamp=ts))
                post_engagers[key].add(acct.name)
            if rng.random() < 0.05 * m * author.quality:
                per_post_replies[key][acct.name] = per_post_replies[key].get(acct.name, 0) + rng.choice([1, 1, 2])
                post_engagers[key].add(acct.name)
            if rng.random() < 0.02 * m * author.quality:
                per_post_reblogs[key].add(acct.name)
                post_engagers[key].add(acct.name)
        # occasional self-vote (exercises the exclusion)
        if rng.random() < 0.3:
            raw_votes[key].append(Vote(voter=post.author,
                                       rshares=int(author.stake * 1e9),
                                       timestamp=post.created + timedelta(minutes=1)))

    # rebuild posts with votes/children/reblog_count attached
    #
    # ★ AttributedPost, NOT Post (2026-08-01). This emitted a plain `Post`, and
    # `independent_organic_engagement` reads `commenters`/`rebloggers` ONLY off an
    # AttributedPost — by design, since a count without identity cannot be
    # exclusion-filtered and must degrade toward silence. Production hydrates
    # AttributedPost (`io/hafsql.py:461`). So **every harness panel scored comments
    # and reblogs at exactly zero**, and the whole organic term was measured on
    # votes alone.
    #
    # Measured on the same world and seed: mean organic engagement raw
    # 1.2590 -> 1.7667. State that carefully — it is a +40.3% INCREASE, i.e.
    # 28.7% of the corrected signal had been invisible (+27.8% on the
    # log-compressed post_base scale). 543 of 751 posts changed value. Every
    # tuning table in config.py was fitted through the degraded instrument.
    #
    # The identity was already here — `per_post_replies[key]` is keyed by commenter
    # and `per_post_reblogs[key]` is a set of accounts. It was being reduced to a
    # count and discarded. Sorted for determinism, mirroring hafsql's
    # `tuple(sorted(comment_counts))`.
    final_posts: list[Post] = []
    for post in posts:
        key = post.key
        final_posts.append(AttributedPost(
            author=post.author, permlink=post.permlink, category=post.category,
            community=post.community, created=post.created,
            children=sum(per_post_replies[key].values()),
            reblog_count=len(per_post_reblogs[key]),
            author_reputation=post.author_reputation, tags=post.tags,
            votes=tuple(raw_votes[key]),
            commenters=tuple(sorted(per_post_replies[key])),
            rebloggers=tuple(sorted(per_post_reblogs[key])),
        ))
    posts = final_posts

    # --- engagement edges (aggregate per ordered pair over the window) ---
    pair: dict[tuple[str, str], dict[str, float]] = {}

    def bump(src: str, dst: str, field_: str, n: float, ts: datetime) -> None:
        d = pair.setdefault((src, dst), {"replies": 0, "reply_backs": 0, "upvotes": 0,
                                         "reblogs": 0, "last": None})
        d[field_] += n
        if d["last"] is None or ts > d["last"]:
            d["last"] = ts

    for post in posts:
        key = post.key
        for v in post.votes:
            if v.voter != post.author:
                bump(v.voter, post.author, "upvotes", 1, v.timestamp)
        for commenter, n in per_post_replies[key].items():
            bump(commenter, post.author, "replies", n, post.created + timedelta(hours=2))
        # sorted(): `per_post_reblogs[key]` is a SET, and iterating it raw made
        # the ORDER of `pair` insertions hash-dependent — see the note at the
        # follow-back loop below for why that is not cosmetic.
        for rb in sorted(per_post_reblogs[key]):
            bump(rb, post.author, "reblogs", 1, post.created + timedelta(hours=3))

    # reply-backs: engaged author replies back to heavy commenters
    for (src, dst), d in list(pair.items()):
        if d["replies"] >= 2 and rng.random() < 0.5 * accounts[dst].quality:
            bump(dst, src, "reply_backs", 1, d["last"] or NOW)
    # organic same-topic author chatter (mutual replies)
    for t in TOPICS:
        t_authors = [a.name for a in author_list if a.topic == t]
        for x in t_authors:
            for y in t_authors:
                if x < y and rng.random() < 0.08:
                    ts = EPOCH + timedelta(hours=rng.uniform(0, DAYS * 24))
                    bump(x, y, "replies", 1 + int(nrng.poisson(1.5)), ts)
                    bump(y, x, "replies", 1 + int(nrng.poisson(1.5)), ts)

    edges = [
        EngagementEdge(src=s, dst=d, replies=int(v["replies"]), reply_backs=int(v["reply_backs"]),
                       upvotes=int(v["upvotes"]), reblogs=int(v["reblogs"]),
                       last_interaction=v["last"])
        for (s, d), v in pair.items()
    ]

    # --- follow graph ---
    follows: dict[str, set[str]] = {a: set() for a in accounts}
    for v in accounts.values():
        if v.is_author:
            same = sorted([a for a in author_list if a.topic == v.topic and a.name != v.name],
                          key=lambda a: -a.quality)
            picks = same[:10]
            if picks:
                for a in rng.sample(picks, min(5, len(picks))):
                    follows[v.name].add(a.name)
        else:
            same = sorted([a for a in author_list if a.topic == v.topic],
                          key=lambda a: -(a.quality + rng.gauss(0, 0.15)))
            for a in same[:8]:
                follows[v.name].add(a.name)
            other = [a for a in author_list if a.topic != v.topic]
            follows[v.name].add(rng.choice(other).name)
    # some follow-backs so viewers aren't all ratio-9 sinks
    # ★ sorted(), NOT list() — DETERMINISM, not style (fixed 2026-08-04).
    #
    # `fset` is a SET of strings, so raw iteration order follows Python's
    # hash randomisation and differs between processes on identical input. That
    # would be harmless if the loop only read, but it draws `rng.random()` per
    # item — so the seeded stream is CONSUMED IN A DIFFERENT ORDER and a
    # different set of follow-backs is created. The generated world itself
    # therefore changed run to run, despite `build_world(seed=...)`.
    #
    # Measured before the fix, q3's newcomer graph-cred: 0.48219 / 0.48836 /
    # 0.49452 at PYTHONHASHSEED 1 / 0 and 42 / 2 — stable within a seed, moving
    # between them. The mechanism is `percentile_rank`, a STEP function: a
    # difference too small to see becomes a full band jump when it straddles a
    # sample point. Aggregate panel metrics absorbed it, which is why every
    # self-check still passed while a single-account readout wandered.
    #
    # PRODUCTION WAS NEVER EXPOSED — `io/hafsql.py` builds its edge list from
    # `keys = sorted(...)`. This was an instrument defect only, and instrument
    # defects here have twice been mistaken for algorithm movement.
    for follower, fset in list(follows.items()):
        for followee in sorted(fset):
            if rng.random() < 0.15:
                follows[followee].add(follower)

    return World(accounts=accounts, posts=posts, post_topic=post_topic,
                 post_engagers=post_engagers, edges=edges,
                 follows={k: frozenset(v) for k, v in follows.items()},
                 rng=rng, nrng=nrng)


# =============================================================================
# B-07 — generic config-mutant support (measurement-harness/mutate_panels.py)
# =============================================================================
#
# "A panel that passes on its own mutant is not a gate" (BUILDMAP-B-QUALITY,
# B-07). Measured on q11 (`scratchpad/eI_q11_mutants.py`): deleting the
# unchosen-source penalty, gutting it toward a no-op floor, deleting the
# per-page cap, or loosening the cap to 10/page ALL passed q11's self-check —
# and deleting the penalty made the headline number BETTER than shipped. This
# module gives every panel a cheap way to be tested against a declared list of
# CONFIG mutants (no code mutation, so it is buildable deterministically):
# `mutate_panels.py` sets `LUMEN_SETTINGS_MUTANT` to a JSON `{"dotted.path":
# value}` object and re-execs the panel as a subprocess; a panel that routes
# its top-level ``Settings()`` construction through `harness_settings()`
# picks the mutation up automatically. Absent the env var, `harness_settings()`
# is byte-identical to calling `Settings()` (or replacing fields on a caller-
# supplied base) directly — adopting it changes no panel's behaviour.

_MUTANT_ENV = "LUMEN_SETTINGS_MUTANT"


class MutantFieldAbsent(Exception):
    """A mutant path names a field that does not exist on the current
    `Settings` tree. Several fields named in B-07's own mutant table
    (`unchosen_max_share`, `emerging_per_page`, `weights.interest_match`) are
    created by units B-02/B-03/B-04, which have not landed — `mutate_panels.py`
    catches this and marks the row N/A rather than crashing."""


def settings_path_exists(base: object, path: str) -> bool:
    """True iff every dotted segment of ``path`` names a real dataclass field,
    starting from ``base`` (typically a `Settings()` instance). Used by
    `mutate_panels.py` to detect not-yet-built config fields UP FRONT, before
    ever spawning a subprocess for that row."""
    obj = base
    for part in path.split("."):
        if not dataclasses.is_dataclass(obj):
            return False
        if part not in {f.name for f in dataclasses.fields(obj)}:
            return False
        obj = getattr(obj, part)
    return True


def apply_settings_mutation(base: object, mutation: Mapping[str, object]) -> object:
    """``base`` (a `Settings` instance) with every ``{"dotted.path": value}``
    pair in ``mutation`` applied — CONFIG mutation only, never code.

    ★ ALL SIBLING CHANGES AT ONE DATACLASS LEVEL ARE APPLIED IN A SINGLE
    ``dataclasses.replace()`` CALL, grouped by their shared parent. This is
    not a style choice — several config dataclasses enforce CROSS-FIELD
    invariants in ``__post_init__`` (e.g. ``ScoreWeights``:
    ``organic_quality + organic_cf == 1.0``), and ``dataclasses.replace()``
    re-runs ``__post_init__`` on every call. An early version of this
    function applied each dotted path with its OWN independent `replace()`
    call: mutating `{"weights.organic_cf": 0.0, "weights.organic_quality":
    1.0}` set `organic_cf` first, and THAT INTERMEDIATE OBJECT (organic_cf=0,
    organic_quality still the 0.9 default) failed validation before the
    paired change ever landed — a real bug caught by actually running
    `mutate_panels.py` against a paired mutant, not by inspection. Grouping
    by parent and recursing means every sibling change at a level reaches
    `replace()` together, so intermediate invalid states never exist.

    Raises `MutantFieldAbsent` if any path segment does not exist; callers
    (`mutate_panels.py`) use that to mark a row N/A instead of crashing."""
    if not dataclasses.is_dataclass(base):
        raise MutantFieldAbsent(
            f"{type(base).__name__} is not a dataclass — cannot apply {mutation!r}"
        )
    field_names = {f.name for f in dataclasses.fields(base)}

    leaves: dict[str, object] = {}
    groups: dict[str, dict[str, object]] = {}
    for path, value in mutation.items():
        head, sep, rest = path.partition(".")
        if sep:
            groups.setdefault(head, {})[rest] = value
        else:
            leaves[head] = value

    changes: dict[str, object] = {}
    for head, value in leaves.items():
        if head not in field_names:
            raise MutantFieldAbsent(f"{head!r} is not a field of {type(base).__name__}")
        changes[head] = value
    for head, sub_mutation in groups.items():
        if head not in field_names:
            raise MutantFieldAbsent(f"{head!r} is not a field of {type(base).__name__}")
        changes[head] = apply_settings_mutation(getattr(base, head), sub_mutation)

    return dataclasses.replace(base, **changes)


def harness_settings(base: object | None = None):
    """``base`` (default: shipped ``Settings()``) with `LUMEN_SETTINGS_MUTANT`
    applied if the env var is set (B-07's mutant harness); otherwise returns
    ``base`` UNCHANGED. Every panel wired for mutation testing builds its
    top-level "shipped" `Settings` object through this function — panel-
    internal ablation configs (e.g. "penalty off", "no diversity") that are
    constructed FRESH rather than via `dataclasses.replace(base, ...)` do NOT
    inherit the mutation on fields they don't explicitly set, by design: they
    are deliberately isolated scenarios, not the shipped path under test."""
    from recsys.config import Settings

    s = base if base is not None else Settings()
    raw = os.environ.get(_MUTANT_ENV)
    if not raw:
        return s
    mutation = json.loads(raw)
    return apply_settings_mutation(s, mutation)


class SimGateway:
    """HafsqlGateway implementation that honestly honors query arguments.

    ★ `author_engagement` lives HERE, not in a subclass (2026-08-01). It used
    to be added by `AuthorPriorSimGateway`, and every panel except q8
    instantiated the plain `SimGateway` — so `_author_priors` saw a gateway
    without the method, returned {}, and the AUTHOR-POOLED PRIOR (the headline
    of the 2026-07-21 organic rebuild) was inactive in every panel that
    produced a tuning table. Opting INTO the production code path is exactly
    backwards: the default instrument must be the shipped algorithm, and
    measuring the prior-less fallback must be the thing you opt into.
    """

    def __init__(self, world: World, lineage: dict[str, frozenset[str]] | None = None):
        self.w = world
        self._lineage = lineage or {}

    def _fresh(self, posts: list[Post], since: datetime, limit: int) -> list[Post]:
        out = [p for p in posts if p.created >= since]
        out.sort(key=lambda p: p.created, reverse=True)
        return out[:limit]

    def in_network_posts(self, follows: frozenset[str], since: datetime, limit: int) -> list[Post]:
        return self._fresh([p for p in self.w.posts if p.author in follows], since, limit)

    def engaged_oon_posts(self, follows: frozenset[str], since: datetime, limit: int) -> list[Candidate]:
        out = []
        for p in self.w.posts:
            if p.author in follows or p.created < since:
                continue
            if self.w.post_engagers[p.key] & follows:
                out.append(p)
        out.sort(key=lambda p: p.created, reverse=True)
        return [Candidate(post=p, source=CandidateSource.OON_ENGAGED) for p in out[:limit]]

    def tag_posts(self, tags: frozenset[str], since: datetime, limit: int) -> list[Post]:
        return self._fresh([p for p in self.w.posts if set(p.tags) & tags], since, limit)

    def engagement_edges(self, since: datetime) -> list[EngagementEdge]:
        return list(self.w.edges)

    # `stake_lineage` removed 2026-08-05 (B2). NOTE FOR THE RECORD: no panel
    # ever constructed this gateway WITH a lineage map, so this method returned
    # an empty set on every harness run ever made — the §8.4 lineage exclusion
    # and the C2c per-farm cap were never exercised by the measurement harness
    # at all. That is why removing the relation moves no panel number.

    def second_degree_engagers(self, post_keys: frozenset[str], follows: frozenset[str]
                               ) -> dict[str, frozenset[str]]:
        out = {}
        for key in post_keys:
            hit = frozenset(self.w.post_engagers.get(key, set())) & follows
            if hit:
                out[key] = hit
        return out

    def follow_graph(self, accounts: frozenset[str]) -> dict[str, frozenset[str]]:
        return {a: self.w.follows[a] for a in accounts if a in self.w.follows}

    def author_first_post(
        self, authors: frozenset[str], *, horizon_days: int, now: datetime | None = None
    ) -> dict[str, datetime]:
        """When each author first published, over the whole world (2026-08-08).

        ★ WITHOUT THIS THE EXPLORATION LANE IS DEAD IN EVERY PANEL. The newness
        predicate (`ExplorationConfig.max_author_age_days`) is FAIL-CLOSED by
        design — an author whose first-post date is unknown is refused the lane
        — so a gateway that cannot answer forfeits the reserved seat on every
        request. Caught by `q12_lane_balance.py` on its first run: exploration
        mean/20 read 0.00 and q3's newcomer reach went red.

        The world has no notion of account creation, so first POST is the only
        honest proxy available here, which is also what the production query
        computes.

        ★ `horizon_days` MIRRORS THE PRODUCTION CONTRACT (2026-08-08): only
        authors newer than the horizon are returned, and older ones are OMITTED
        rather than carrying a real timestamp. The sim world is small enough to
        compute the true minimum either way, but answering a different SHAPE
        than `HafsqlClient` does is how a panel goes green against behaviour the
        service never has — so the omission is reproduced deliberately.
        """
        first: dict[str, datetime] = {}
        for post in self.w.posts:
            if post.author not in authors:
                continue
            current = first.get(post.author)
            if current is None or post.created < current:
                first[post.author] = post.created
        if horizon_days <= 0:
            return {}
        if now is None:
            # No clock, so no horizon can be applied honestly. Return the true
            # minima rather than inventing a reference point — the caller's own
            # predicate still filters them, so this is never fail-OPEN.
            return first
        floor = now - timedelta(days=horizon_days)
        return {a: t for a, t in first.items() if t >= floor}

    def popular_posts(self, since: datetime, limit: int) -> list[Post]:
        """Mirror of production `_SQL_POPULAR_POSTS` recall ordering.

        ★★★ REBUILT 2026-08-09 — AND THIS IS THE SECOND TIME THIS DRIFTED.
        The previous version scored `0.5*voters + 0.3*commenters +
        0.5*rebloggers` under a comment asserting it "mirrors production
        exactly... so the two cannot drift apart silently". Production moved to
        conversation-only recall (voters removed; they were 38% of it) and this
        did not follow, so recall overlap fell to 76/150 and every q11/q12
        number taken on this lane described a pool production never produces.

        The weights are now IMPORTED from `recsys.io.hafsql` rather than
        retyped, and `test_sim_recall_matches_production_weights` fails if this
        function stops reading them — which is what the old comment promised and
        could not deliver.

        Votes are deliberately absent: stake reaches this lane only through
        `PopularConfig.payout_share` in `select_popular`, where it can be
        normalised against the pool. SQL cannot normalise.
        """
        posts = [p for p in self.w.posts if p.created >= since]

        def score(p: Post) -> float:
            commenters = {c for c in getattr(p, "commenters", ()) if c != p.author}
            rebloggers = {r for r in getattr(p, "rebloggers", ()) if r != p.author}
            return (POPULAR_RECALL_COMMENT_WEIGHT * len(commenters)
                    + POPULAR_RECALL_REBLOG_WEIGHT * len(rebloggers))

        # tie-break DESC by created, matching `ORDER BY (...) DESC, c.created DESC`
        posts.sort(key=lambda p: (-score(p), -p.created.timestamp()))
        return posts[:limit]

    def suppressed_keys(self, post_keys: frozenset[str]) -> frozenset[str]:
        return frozenset()

    def author_engagement(
        self,
        authors: frozenset[str],
        since: datetime,
        excluded: Mapping[str, frozenset[str]] | None = None,
        *,
        trust: VoterTrust | None = None,
        weights: object | None = None,
    ) -> dict[str, AuthorEngagement]:
        """Author-pooled window aggregate, matching the PRODUCTION signature.

        ★ 2026-08-01: moved here from ``author_prior_gateway.AuthorPriorSimGateway``.
        ``SimGateway`` never had a stale signature — it had NO SUCH METHOD, and
        because ``AuthorPriorGateway`` is a @runtime_checkable Protocol (whose
        isinstance() checks method NAMES) a gateway lacking it simply fails the
        guard and the pipeline takes its documented prior-less fallback. Every
        panel but q8 used that gateway, so the prior was inactive in every panel
        that produced a tuning table. (q8 was unaffected: it defines its own
        gateway inline. A separate 2026-08-01 fix repaired a genuinely stale
        two-argument signature in the subclass, which is a different defect from
        this one — do not conflate them, as an earlier draft of this docstring
        did.)

        ``excluded`` mirrors the production anti-join: engagement from an
        author's own stake lineage / ring / self must not count toward that
        author's pooled prior, or an author inflates ``total_base`` with exactly
        the identities the vote signal already discounts on ``own_base``.

        ``trust`` is accepted for signature parity. The production query uses it
        to breadth-budget unknown-tier engagers (H05); reproducing that budget
        in-sim would require per-post voter identity accounting that
        ``post_base_engagement`` does not expose, so it is deliberately NOT
        approximated here — a wrong budget would be worse than a documented
        absent one. Simulated priors are therefore an UPPER BOUND on the
        production prior for authors whose engagement is unknown-tier.
        """
        counts: dict[str, int] = {}
        totals: dict[str, float] = {}
        for p in self.w.posts:
            if p.created < since or p.author not in authors:
                continue
            # Self-exclusion always; the caller's per-author exclusion set on top.
            excl = frozenset({p.author}) | (
                (excluded or {}).get(p.author, frozenset())
            )
            counts[p.author] = counts.get(p.author, 0) + 1
            # ★ `trust` and `weights` are FORWARDED (2026-08-01). The copy that
            # was moved here omitted both, while `pipeline._score` computes
            # `own_base` with `trust=_voter_trust(snap, settings)` and
            # `weights=settings.weights`. Measured on the q7 world, where trust
            # is not None (145 vouched of 180 accounts), the unbudgeted version
            # overstates `total_base` by mean 0.6% / max 9.7% per author and
            # inflates pooled organic on 176 of 746 posts. That was a documented
            # "upper bound" while it lived in a q8-only subclass; once this
            # became the instrument for EVERY panel it was simply a bias. q8's
            # own inline gateway already did this correctly — that implementation
            # is the one preserved here.
            totals[p.author] = totals.get(p.author, 0.0) + post_base_engagement(
                p, excl, trust=trust, weights=weights
            )
        return {
            a: AuthorEngagement(posts=counts[a], total_base=totals[a]) for a in counts
        }


class PriorlessSimGateway(SimGateway):
    """``SimGateway`` with the author-pooled prior REMOVED — the explicit control.

    ★ Added 2026-08-01 when `author_engagement` moved onto `SimGateway` itself.
    Before that move the plain gateway was accidentally prior-less and every
    panel but q8 used it, so the shipped algorithm's headline organic feature was
    inactive in every tuning table. Now the default instrument is the shipped
    algorithm and measuring WITHOUT the prior is the deliberate act.

    `AuthorPriorGateway` is a @runtime_checkable Protocol, and those check method
    NAMES — so removing the attribute (rather than raising inside it) is what
    actually makes `isinstance` false and exercises the pipeline's documented
    prior-less fallback.
    """

    author_engagement = None  # type: ignore[assignment]


DUMMY_VIEWER = ViewerProfile(account="__norm__")

def build_norm(world: World, now: datetime = NOW) -> NormContext:
    """A realistic NormContext producer: raw signals of every window post,
    viewer-independent (cf=0), author-only vote exclusion."""
    vote_sig, reps, organics = [], [], []
    for p in world.posts:
        vote_sig.append(independent_vote_signal(p, VoteExclusions(author=p.author)))
        reps.append(p.author_reputation)
        organics.append(_organic_signal(p, DUMMY_VIEWER, now, frozenset({p.author}), None, 0.0))
    return build_norm_context(vote_sig, reps, organics)


# ---------------- metrics ----------------

def dcg(gains: list[float]) -> float:
    return sum(g / math.log2(i + 2) for i, g in enumerate(gains))


def ndcg_at_k(ranked_posts: list[Post], viewer: str, world: World, k: int = 20) -> float:
    """nDCG@k against the GLOBAL universe ideal (punishes bad pools too)."""
    gains = [world.rel(viewer, p) for p in ranked_posts[:k]]
    ideal = sorted((world.rel(viewer, p) for p in world.posts), reverse=True)[:k]
    idcg = dcg(ideal)
    return dcg(gains) / idcg if idcg > 0 else 0.0


def mean_rel_at_k(ranked_posts: list[Post], viewer: str, world: World, k: int = 20) -> float:
    top = ranked_posts[:k]
    return sum(world.rel(viewer, p) for p in top) / max(len(top), 1)


def overlap_at_k(a: list[Post], b: list[Post], k: int = 20) -> int:
    return len({p.key for p in a[:k]} & {p.key for p in b[:k]})


def spearman(x: list[float], y: list[float]) -> float:
    if len(x) < 3:
        return float("nan")
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    if rx.std() == 0 or ry.std() == 0:
        return float("nan")
    return float(np.corrcoef(rx, ry)[0, 1])


def topic_entropy(posts: list[Post], world: World, k: int = 20) -> float:
    from collections import Counter
    c = Counter(world.post_topic.get(p.key, world.accounts[p.author].topic) for p in posts[:k])
    n = sum(c.values())
    if n == 0:
        return 0.0
    return -sum((v / n) * math.log2(v / n) for v in c.values())
