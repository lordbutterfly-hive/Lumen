"""Shared test factories + an in-memory HafsqlGateway fake.

Imported by every module's tests so fixtures stay consistent, and so the
pipeline test and the unit tests exercise the same gateway contract.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from recsys.contracts import (
    Candidate,
    CandidateSource,
    EngagementEdge,
    Post,
    ViewerProfile,
    Vote,
)

EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


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

    def suppressed_keys(self, post_keys: frozenset[str]) -> frozenset[str]:
        return post_keys & self._suppressed
