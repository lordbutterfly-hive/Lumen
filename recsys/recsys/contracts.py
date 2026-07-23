"""Shared, immutable data contracts for the Phase-0 discovery pipeline.

Every module in :mod:`recsys.core` and :mod:`recsys.io` speaks in terms of
these types. This module is **pure stdlib** (no third-party imports) so the
scoring core stays importable and unit-testable without a database or numpy.

Design rules:
  * Value objects are ``@dataclass(frozen=True)`` — immutable, hashable, cheap
    to compare in tests.
  * Collections that live on frozen dataclasses are ``tuple`` / ``frozenset``
    so instances stay hashable and can't be mutated behind a caller's back.
  * The scoring core never talks to a database directly; it depends on the
    :class:`HafsqlGateway` *protocol*, and the concrete client in
    ``recsys.io.hafsql`` implements it (dependency inversion).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Protocol


class CandidateSource(StrEnum):
    """Where a candidate post entered the pool (§3.1). Drives eligibility:
    only out-of-network (``OON_*``) sources pass through the second-degree
    gate (§8.1) and the graph-cred floor; ``IN_NETWORK`` is exempt."""

    IN_NETWORK = "in_network"
    OON_ENGAGED = "oon_engaged"
    OON_COMMUNITY = "oon_community"  # subscribed community, established viewer — gated
    OON_INTEREST = "oon_interest"  # tag/category discovery, established viewer — gated
    OON_ALS = "oon_als"
    # Cold-start exploration lane the viewer explicitly picked at signup (rev 2.2)
    # — exempt from the gate, since they have no follow graph for it to use.
    INTEREST_COMMUNITY = "interest_community"
    INTEREST_TAG = "interest_tag"

    @property
    def is_in_network(self) -> bool:
        return self is CandidateSource.IN_NETWORK

    @property
    def requires_second_degree(self) -> bool:
        """Whether this source must clear the second-degree vouch gate (§8.1)
        and graph-cred floor (§8.3). Exempt: the viewer's own network
        (``IN_NETWORK``) and the cold-start exploration lane they explicitly
        picked at signup (``INTEREST_*``, rev 2.2). Every general out-of-network
        discovery source — including a *subscribed* community for an established
        viewer — is gated, so a stranger cannot self-inject into anyone's feed."""
        return self not in (
            CandidateSource.IN_NETWORK,
            CandidateSource.INTEREST_COMMUNITY,
            CandidateSource.INTEREST_TAG,
        )


@dataclass(frozen=True)
class Vote:
    """A single on-chain vote. ``rshares`` is signed; the vote signal (§4)
    keeps positive rshares only (rev 2.1 — downvotes never affect ranking)."""

    voter: str
    rshares: int
    timestamp: datetime


@dataclass(frozen=True)
class Post:
    """A rankable top-level post (short- or long-form — type-blind per §3.0)."""

    author: str
    permlink: str
    category: str
    community: str | None
    created: datetime
    children: int          # comment count
    reblog_count: int
    author_reputation: float   # display reputation, feeds the 10% rep term
    tags: tuple[str, ...]
    votes: tuple[Vote, ...]
    is_short_form: bool = False
    is_nsfw: bool = False

    @property
    def key(self) -> str:
        return f"@{self.author}/{self.permlink}"


@dataclass(frozen=True)
class ViewerProfile:
    """The person we're ranking *for*. ``interest_*`` fields are the
    Medium-style cold-start seed (rev 2.2), set at signup before any follow
    graph or history exists; ``is_new`` routes them to the interest lane."""

    account: str
    follows: frozenset[str] = frozenset()
    mutes: frozenset[str] = frozenset()
    subscribed_communities: frozenset[str] = frozenset()
    interest_tags: frozenset[str] = frozenset()
    interest_communities: frozenset[str] = frozenset()
    interest_vec: tuple[float, ...] | None = None
    is_new: bool = False


@dataclass(frozen=True)
class EngagementEdge:
    """Directed, per-pair engagement summary — the RealGraph feature vector
    (rev 2.2). ``src`` engaged ``dst``. Feeds graph-cred edge weights (§8.3)
    and CF affinity (§6). ``reply_backs`` is the reciprocity signal (did
    ``dst`` reply back to ``src``); ``revisits``/``dwell_seconds`` are the
    net-new client-side telemetry (Phase 1)."""

    src: str
    dst: str
    replies: int = 0
    reply_backs: int = 0
    upvotes: int = 0
    reblogs: int = 0
    mentions: int = 0
    profile_visits: int = 0
    post_opens: int = 0
    revisits: int = 0
    dwell_seconds: float = 0.0
    last_interaction: datetime | None = None


@dataclass(frozen=True)
class GraphCred:
    """Sybil-resistant distribution-trust score (§8.3): engagement-weighted
    follow-graph PageRank, normalized to ``[0, 1]``.

    ``outside_engaged`` (H02, funded-pair hardening 2026-07-22) records whether
    this account received ANY engagement from OUTSIDE its own detected ring /
    stake lineage — a structural fact the scalar ``score`` cannot express. A
    ring-flagged-but-below-scale reciprocal pair (the newcomer carve-out, see
    ``graph_cred`` §8.3) is deliberately NOT zeroed and lands in the engaged
    band, so ``score`` alone cannot tell "engaged from outside" apart from
    "engaged only by my own pair". The vouched tier
    (:func:`recsys.pipeline._voter_trust`) gates on THIS field, not on the
    score: a laundered reciprocal pair therefore stays UNKNOWN-tier (breadth
    budgeted, NOT blocked), and flips to vouched the instant either account
    receives one genuine outside upvote/comment/reblog. Defaults ``False`` so
    every existing construction stays valid and an account with no received
    outside engagement is un-vouched until proven otherwise."""

    account: str
    score: float
    follow_follower_ratio: float
    outside_engaged: bool = False


@dataclass(frozen=True)
class RingSignal:
    """Soft vote-ring membership (§8.5) — never a hard ban."""

    account: str
    ring_score: float
    ring_id: int | None = None


@dataclass(frozen=True)
class VoteExclusions:
    """Voters whose votes must NOT count toward the independent vote signal
    (§4, §8.4): the author (self-vote), stake-lineage siblings, and ring
    co-members. What remains is 'distinct independent stakeholders'."""

    author: str
    lineage: frozenset[str] = frozenset()
    ring_members: frozenset[str] = frozenset()

    def excluded(self) -> frozenset[str]:
        return self.lineage | self.ring_members | {self.author}


@dataclass(frozen=True)
class NormContext:
    """Pre-sorted 7-day global rolling samples for percentile ranking (§4).
    Cacheable and shared across requests — not per-request pools. Each tuple
    MUST be sorted ascending; percentile = bisect position / len."""

    vote_signal_samples: tuple[float, ...]
    reputation_samples: tuple[float, ...]
    organic_samples: tuple[float, ...]


@dataclass(frozen=True)
class ScoreBreakdown:
    """The composite score and its three normalized components, all in
    ``[0, 1]`` (§0: ``0.10*vote + 0.10*rep + 0.80*organic``)."""

    vote_norm: float
    rep_norm: float
    organic: float
    final: float


@dataclass(frozen=True)
class Candidate:
    """A post plus the source that surfaced it, pre-scoring."""

    post: Post
    source: CandidateSource


@dataclass(frozen=True)
class ScoredCandidate:
    """A candidate after scoring; what the re-ranker orders."""

    post: Post
    source: CandidateSource
    score: ScoreBreakdown


class HafsqlGateway(Protocol):
    """Read-only data access the pipeline depends on. The concrete
    implementation (``recsys.io.hafsql``) talks to HAFSQL/Postgres; tests
    provide an in-memory fake. Kept a Protocol so the pure core never imports
    a database driver."""

    def in_network_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Post]: ...

    def engaged_oon_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Candidate]: ...

    def community_posts(
        self, communities: frozenset[str], since: datetime, limit: int
    ) -> list[Post]: ...

    def tag_posts(
        self, tags: frozenset[str], since: datetime, limit: int
    ) -> list[Post]: ...

    def engagement_edges(self, since: datetime) -> list[EngagementEdge]: ...

    def stake_lineage(self, author: str) -> frozenset[str]: ...

    def second_degree_engagers(
        self, post_keys: frozenset[str], follows: frozenset[str]
    ) -> dict[str, frozenset[str]]:
        """For each OON post key, which of the viewer's ``follows`` engaged it
        (§8.1). Produces the engager index the second-degree gate consumes —
        so the gate *checks vouches* instead of blocking every OON post."""
        ...

    def follow_graph(self, accounts: frozenset[str]) -> dict[str, frozenset[str]]:
        """follower -> followees among ``accounts`` (§8.3), for graph-cred."""
        ...

    def popular_posts(self, since: datetime, limit: int) -> list[Post]:
        """Community-popular fallback for the fully-cold viewer (§13.5b), ranked
        by our own positive-engagement signals — never payout indexing."""
        ...

    def suppressed_keys(self, post_keys: frozenset[str]) -> frozenset[str]:
        """Subset of ``post_keys`` under network suppression (§8.7)."""
        ...


__all__ = [
    "Candidate",
    "CandidateSource",
    "EngagementEdge",
    "GraphCred",
    "HafsqlGateway",
    "NormContext",
    "Post",
    "RingSignal",
    "ScoreBreakdown",
    "ScoredCandidate",
    "ViewerProfile",
    "Vote",
    "VoteExclusions",
]
