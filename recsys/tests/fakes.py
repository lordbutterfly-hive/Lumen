"""Shared test factories + an in-memory HafsqlGateway fake.

Imported by every module's tests so fixtures stay consistent, and so the
pipeline test and the unit tests exercise the same gateway contract.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from recsys.config import MIN_TRUSTED_SEEDS
from recsys.contracts import (
    Candidate,
    CandidateSource,
    EngagementEdge,
    Post,
    ViewerProfile,
    Vote,
)

EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


def seeds_that_land(
    *named: str, sink: str = "seed-sink"
) -> tuple[frozenset[str], list[EngagementEdge]]:
    """A trusted-seed set that clears ``MIN_TRUSTED_SEEDS`` **and whose members
    actually land in ``graph_cred``** — returned together with the edges a
    fixture must include for that to be true.

    ★★ 2026-08-05 POST-CLOSEOUT COUNCIL. The helper this replaces padded a seed
    list with filler names that existed in NO world, so every test using it
    built a *production* snapshot whose EFFECTIVE trust root was the one named
    account — 25 configured, 1 landed. That is precisely the configuration
    ``build_trust_snapshot`` now refuses (`pipeline.py`, the landed-seeds
    floor), and precisely the state the C4 fix left open one level down: the
    floor was applied to the CONFIGURED list and never to the LANDED set.

    A helper that manufactures a passing seed COUNT without manufacturing the
    engagement that makes those seeds real is a helper that pins the guard's
    absence. Hence this shape: it hands back the edges too, so a fixture cannot
    silently get the count without the substance.

    Each seed sends one upvote to a shared ``sink``. Sent engagement, never
    received, so no seed accrues insularity from this (``ring.py``'s
    denominator counts engagement RECEIVED — see the 2026-08-03 dilution fix),
    and no pair is reciprocal, so the set cannot read as a ring.
    """
    fillers = [f"seed-filler-{i:02d}" for i in range(MIN_TRUSTED_SEEDS)]
    seeds = frozenset(named) | set(fillers)
    edges = [EngagementEdge(src=seed, dst=sink, upvotes=5) for seed in sorted(seeds)]
    return seeds, edges


def make_vote(voter: str = "voter", rshares: int = 1_000_000, minutes: int = 0) -> Vote:
    return Vote(voter=voter, rshares=rshares, timestamp=EPOCH + timedelta(minutes=minutes))


def make_post(
    author: str = "alice",
    permlink: str = "p1",
    *,
    community: str | None = None,
    category: str = "hive",
    created_min: int = 0,
    children: int = 0,
    reblog_count: int = 0,
    author_reputation: float = 50.0,
    tags: Sequence[str] = ("hive",),
    votes: Sequence[Vote] = (),
    is_short_form: bool = False,
    is_nsfw: bool = False,
) -> Post:
    return Post(
        author=author,
        permlink=permlink,
        category=category,
        community=community,
        created=EPOCH + timedelta(minutes=created_min),
        children=children,
        reblog_count=reblog_count,
        author_reputation=author_reputation,
        tags=tuple(tags),
        votes=tuple(votes),
        is_short_form=is_short_form,
        is_nsfw=is_nsfw,
    )


def make_candidate(
    post: Post | None = None,
    source: CandidateSource = CandidateSource.IN_NETWORK,
) -> Candidate:
    return Candidate(post=post if post is not None else make_post(), source=source)


def make_viewer(
    account: str = "viewer",
    *,
    follows: frozenset[str] = frozenset(),
    mutes: frozenset[str] = frozenset(),
    interest_tags: frozenset[str] = frozenset(),
    is_new: bool = False,
) -> ViewerProfile:
    return ViewerProfile(
        account=account,
        follows=follows,
        mutes=mutes,
        interest_tags=interest_tags,
        is_new=is_new,
    )


class FakeGateway:
    """In-memory gateway that structurally implements ``HafsqlGateway``."""

    def __init__(
        self,
        *,
        in_network: Sequence[Post] = (),
        oon: Sequence[Candidate] = (),
        tag: Sequence[Post] = (),
        edges: Sequence[EngagementEdge] = (),
        lineage: dict[str, frozenset[str]] | None = None,
        engagers: dict[str, frozenset[str]] | None = None,
        follow_graph: dict[str, frozenset[str]] | None = None,
        popular: Sequence[Post] = (),
        suppressed: frozenset[str] = frozenset(),
        first_post: dict[str, datetime] | None = None,
    ) -> None:
        self._in_network = list(in_network)
        self._oon = list(oon)
        self._tag = list(tag)
        self._edges = list(edges)
        self._lineage = dict(lineage or {})
        self._engagers = dict(engagers or {})
        self._follow_graph = dict(follow_graph or {})
        self._popular = list(popular)
        self._suppressed = frozenset(suppressed)
        self._first_post = dict(first_post or {})
        #: What the last `author_first_post` call ASKED for — see that method.
        self.last_first_post_call: dict[str, object] | None = None

    def in_network_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Post]:
        return self._in_network[:limit]

    def engaged_oon_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Candidate]:
        return self._oon[:limit]

    def tag_posts(self, tags: frozenset[str], since: datetime, limit: int) -> list[Post]:
        return self._tag[:limit]

    def engagement_edges(self, since: datetime) -> list[EngagementEdge]:
        return list(self._edges)

    # `stake_lineage` removed 2026-08-05 (B2) — the gateway protocol no longer
    # declares it. `_lineage` is retained because subclassed stubs in
    # tests/test_pipeline.py read it directly to model their own behaviour.

    def second_degree_engagers(
        self, post_keys: frozenset[str], follows: frozenset[str]
    ) -> dict[str, frozenset[str]]:
        return {
            key: self._engagers.get(key, frozenset()) & follows
            for key in post_keys
            if self._engagers.get(key, frozenset()) & follows
        }

    def follow_graph(self, accounts: frozenset[str]) -> dict[str, frozenset[str]]:
        return {
            a: self._follow_graph[a] for a in accounts if a in self._follow_graph
        }

    def popular_posts(self, since: datetime, limit: int) -> list[Post]:
        return self._popular[:limit]

    def author_first_post(
        self, authors: frozenset[str], *, horizon_days: int, now: datetime | None = None
    ) -> dict[str, datetime]:
        # ★ 2026-08-08: every author this fixture knows about is a DEBUT unless
        # a test says otherwise (`first_post_overrides`). The newness predicate
        # is fail-closed, so a fake that returned {} would silently empty the
        # exploration lane in every pipeline test that is not about newness.
        #
        # ★ RECORDS WHAT IT WAS ASKED (2026-08-08). `horizon_days` is part of
        # the contract — an implementation may omit authors older than it — so a
        # caller passing the wrong horizon is a real bug that no assertion on
        # the RESULT can see. `last_first_post_call` lets a test assert on the
        # ASK, which is what pins pipeline -> gateway horizon plumbing.
        self.last_first_post_call = {"horizon_days": horizon_days, "now": now}
        if horizon_days <= 0:
            return {}
        out: dict[str, datetime] = {}
        for post in (*self._in_network, *self._tag, *self._popular):
            if post.author in authors:
                out[post.author] = post.created
        for cand in self._oon:
            if cand.post.author in authors:
                out[cand.post.author] = cand.post.created
        out.update({a: t for a, t in self._first_post.items() if a in authors})
        if now is not None:
            floor = now - timedelta(days=horizon_days)
            out = {a: t for a, t in out.items() if t >= floor}
        return out

    def suppressed_keys(self, post_keys: frozenset[str]) -> frozenset[str]:
        return post_keys & self._suppressed
