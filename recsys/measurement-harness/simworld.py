"""Synthetic Hive world with KNOWN ground truth, for measuring recsys behavior.

Builds a population of authors (topic, quality, stake, reputation), viewers
(interest profiles, follows), 7 days of posts/votes/comments/reblogs, an
engagement-edge aggregate, and a follow graph. Provides a SimGateway that
honestly honors query arguments (unlike tests/fakes.FakeGateway, which ignores
them), a NormContext producer, and metric helpers.

Ground truth: rel(viewer, post) = interest_match(viewer, author.topic) * author.quality
"""
from __future__ import annotations

import sys
import math
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

sys.path.insert(0, "/mnt/o/HIVE-BLOG-REBUILD/recsys")

import numpy as np

from recsys.contracts import (
    Candidate, CandidateSource, EngagementEdge, NormContext, Post,
    ViewerProfile, Vote, VoteExclusions,
)
from recsys.core.normalize import build_norm_context
from recsys.core.vote_signal import independent_vote_signal
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


def build_world(seed: int = 7, authors_per_topic: int = 20, viewers_per_topic: int = 10,
                whales: int = 3) -> World:
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
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
                author_reputation=a.reputation, tags=TAGS[a.topic],
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
    final_posts: list[Post] = []
    for post in posts:
        key = post.key
        final_posts.append(Post(
            author=post.author, permlink=post.permlink, category=post.category,
            community=post.community, created=post.created,
            children=sum(per_post_replies[key].values()),
            reblog_count=len(per_post_reblogs[key]),
            author_reputation=post.author_reputation, tags=post.tags,
            votes=tuple(raw_votes[key]),
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
        for rb in per_post_reblogs[key]:
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
    for follower, fset in list(follows.items()):
        for followee in list(fset):
            if rng.random() < 0.15:
                follows[followee].add(follower)

    return World(accounts=accounts, posts=posts, post_topic=post_topic,
                 post_engagers=post_engagers, edges=edges,
                 follows={k: frozenset(v) for k, v in follows.items()},
                 rng=rng, nrng=nrng)


class SimGateway:
    """HafsqlGateway implementation that honestly honors query arguments."""

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

    def community_posts(self, communities: frozenset[str], since: datetime, limit: int) -> list[Post]:
        return self._fresh([p for p in self.w.posts if p.community in communities], since, limit)

    def tag_posts(self, tags: frozenset[str], since: datetime, limit: int) -> list[Post]:
        return self._fresh([p for p in self.w.posts if set(p.tags) & tags], since, limit)

    def engagement_edges(self, since: datetime) -> list[EngagementEdge]:
        return list(self.w.edges)

    def stake_lineage(self, author: str) -> frozenset[str]:
        return self._lineage.get(author, frozenset())

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

    def popular_posts(self, since: datetime, limit: int) -> list[Post]:
        posts = [p for p in self.w.posts if p.created >= since]
        posts.sort(key=lambda p: -(len({v.voter for v in p.votes if v.rshares > 0})
                                   + p.children + p.reblog_count))
        return posts[:limit]

    def suppressed_keys(self, post_keys: frozenset[str]) -> frozenset[str]:
        return frozenset()


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
