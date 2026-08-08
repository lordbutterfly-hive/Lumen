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

from collections.abc import Mapping
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
    OON_INTEREST = "oon_interest"  # tag/category discovery, established viewer — gated
    OON_ALS = "oon_als"
    #: ★★★ THE ACROSS-HIVE POPULARITY LANE (2026-08-08, owner: "we need across
    #: Hive popularity lane"). Chain-wide top posts, sourced for EVERY viewer
    #: on every request — not only a starved one.
    #:
    #: WHY IT IS A LANE AND NOT ``POPULAR_FALLBACK``. The gap it closes is a
    #: SOURCING gap, not a ranking one: a genuinely huge post outside the
    #: viewer's follows and outside their tags never entered the candidate pool
    #: at all, so no weight, penalty or quota could ever reach it.
    #: ``POPULAR_FALLBACK`` is padding — ``_fallback_filler`` only runs when the
    #: realised pool is under ``FallbackConfig.min_feed_size`` — so for a
    #: healthy feed it is structurally absent. The two are kept as separate
    #: members deliberately: ``POPULAR_FALLBACK``'s gate exemptions are
    #: justified by "the viewer it serves has no follow graph for the gate to
    #: use", and that justification does NOT extend to an always-on lane served
    #: to established viewers. This one is gated like every other general
    #: discovery lane (see :attr:`requires_author_floor`).
    #:
    #: SELECTION IS CREDITED BREADTH, NOT VOTE COUNT — see
    #: :func:`recsys.core.popular.select_popular`. Raw vote counts are farmable
    #: and largely trail-driven; the SQL is a recall PREFILTER only and the
    #: lane's actual membership is decided by the same
    #: ``VoterTrust``-budgeted, §8.4-excluded breadth the organic term scores.
    OON_POPULAR = "oon_popular"
    # Cold-start exploration lane the viewer explicitly picked at signup (rev 2.2)
    # — exempt from the gate, since they have no follow graph for it to use.
    INTEREST_TAG = "interest_tag"
    #: ★ The reserved new-author lane (cold-start spec §4.3, item B12). An
    #: explicit, budgeted, DEFENDED bypass of the second-degree vouch — a
    #: brand-new post has no vouch by definition, so the gate can only ever
    #: exclude it. It is exempt from the author floor too, deliberately: a new
    #: author is below every floor by construction, which is the point. Its
    #: defences are the per-author budget, ring exclusion, interest targeting
    #: and self-deal exclusion instead. (Graduation used to be listed here as a
    #: fifth; it is positional as of 2026-08-04 and is no longer a Sybil
    #: defence — core/exploration.py says why it never had to be.)
    EXPLORATION = "exploration"
    #: Last-resort global-popularity padding for a viewer whose pool would
    #: otherwise be empty (§13.5b). Emitted by :func:`coldstart.popular_fallback`.
    #: It used to be emitted AS ``INTEREST_TAG``, which made the interest lane's
    #: own coverage metric unfalsifiable — globally-popular posts the viewer
    #: never asked for were indistinguishable from genuine interest matches.
    #: Gate-exempt for the same reason the cold lane is: the viewer it serves has
    #: no follow graph for the gate to use.
    POPULAR_FALLBACK = "popular_fallback"

    @property
    def is_in_network(self) -> bool:
        return self is CandidateSource.IN_NETWORK

    @property
    def is_viewer_chosen(self) -> bool:
        """Whether the viewer explicitly ASKED for this lane (2026-08-03).

        Followed an author, or picked an interest tag at signup — both
        deliberate acts. The rest are inferences the system made
        on their behalf: a post a friend happened to engage
        (``OON_ENGAGED``), a CF neighbour's author (``OON_ALS``), or global
        popularity padding (``POPULAR_FALLBACK``).

        WHY THIS EXISTS. Measured 2026-08-03: at 20 same-topic follows,
        ``OON_ENGAGED`` supplied 33% of the candidate pool and took **75% of
        the top 20**, while ``IN_NETWORK`` supplied 67% and took 25% — and the
        served feed's on-topic share fell from 85% at one follow to 25% at
        twenty, so following MORE people made the feed WORSE. The cause is
        selection bias, not volume: ``engaged_oon_posts`` selects posts
        *because somebody already engaged them*, so the lane is an
        engagement-selected sample by construction, while ``in_network_posts``
        takes a followed author's posts regardless of engagement. Scored on an
        ~80% engagement-derived, viewer-blind organic term, the selected sample
        outscores the unselected one systematically — measured mean organic
        +0.04 to +0.22 across seeds 7/11/23/42, every seed.

        Capping the lane's VOLUME cannot fix that (the survivors still
        outscore in-network content); what needs bounding is the share of the
        FEED an unchosen lane may occupy. See ``DiversityConfig`` and
        ``recsys.core.rerank.diversity_rerank``."""
        return self in (
            CandidateSource.IN_NETWORK,
            CandidateSource.OON_INTEREST,
            CandidateSource.INTEREST_TAG,
        )

    @property
    def requires_second_degree(self) -> bool:
        """Whether this source must clear the second-degree vouch gate (§8.1)
        and graph-cred floor (§8.3). Exempt: the viewer's own network
        (``IN_NETWORK``) and the cold-start exploration lane they explicitly
        picked at signup (``INTEREST_*``, rev 2.2). Every general out-of-network
        discovery source is gated, so a stranger cannot self-inject into
        anyone's feed."""
        return self not in (
            CandidateSource.IN_NETWORK,
            CandidateSource.INTEREST_TAG,
            CandidateSource.POPULAR_FALLBACK,
            # ★ OON_INTEREST is exempt from the VOUCH COUNT but not from the
            # author floor (see requires_author_floor). Measured 2026-08-01: with
            # the vouch requirement, 60 interest candidates were gathered for a
            # viewer with one follow and 0 of 20 feed slots were on-interest.
            # That is structural, not a fixture artifact — the gate passes a post
            # only if one of the viewer's follows already engaged it, which is
            # exactly the predicate OON_ENGAGED selects on and which brand-new
            # interest content can never satisfy. Requiring it made the lane
            # empty-after-eligibility by construction.
            CandidateSource.OON_INTEREST,
            # ★ EXPLORATION: a new post has no vouch BY DEFINITION, so requiring
            # one would make this lane structurally empty — the same defect that
            # made OON_INTEREST/OON_ALS deliver nothing.
            CandidateSource.EXPLORATION,
            # ★ THE SIBLING LANE with the identical defect, found by the review
            # council after OON_INTEREST was fixed alone (2026-08-01). The
            # reasoning above is not specific to interests — it applies to any
            # lane whose job is to surface content the viewer's network has NOT
            # already seen, which is every discovery lane there is:
            #
            #   OON_ALS — the CF discovery producer. Measured byte-identical
            #     feeds at every `als_source_authors` setting including the whole
            #     author universe: everything it sourced either failed the vouch
            #     gate or was relabelled to a higher-priority lane that then
            #     failed it.
            #
            # (A second sibling, OON_COMMUNITY — a subscribed community, measured
            # 90 candidates -> 0 eligible -> 0 feed slots the same way — carried
            # the identical exemption until communities were retired as a lane
            # 2026-08-04, R1/R3.)
            #
            # It keeps `requires_author_floor`, so a self-dealer or ring member
            # still cannot ride it in, and it remains subject to the per-author
            # flooding cap (see core/flooding.py, which keys on that property).
            CandidateSource.OON_ALS,
            # ★ OON_POPULAR — the same defect, for the same structural reason.
            # A chain-wide popular post is by definition popular OUTSIDE the
            # viewer's network; requiring that one of the viewer's own follows
            # already engaged it makes the lane empty for exactly the viewers it
            # exists to serve (the whole point is reach beyond your graph). It
            # keeps `requires_author_floor`, so a proven self-dealer still
            # cannot ride it in, and it keeps the per-author flooding cap.
            CandidateSource.OON_POPULAR,
        )

    @property
    def requires_author_floor(self) -> bool:
        """Whether the AUTHOR must clear the graph-cred floor (§8.3).

        Split out from :attr:`requires_second_degree` (2026-08-01) so a source
        can be exempt from the second-degree VOUCH COUNT — "someone you follow
        already engaged this" — while still refusing self-dealers and ring
        members. Those are different questions: the first asks whether the
        viewer's own network has seen it, the second whether the author is
        credible at all. Bundling them meant any discovery lane either demanded
        prior in-network engagement (impossible for new content) or accepted
        anyone (an injection vector).

        The viewer's OWN network stays exempt from both — they chose those
        authors by name.

        ★ THE COLD-START LANE NO LONGER DOES (2026-08-04, cold-start spec item
        B4). `INTEREST_TAG` was exempt from this floor as well as from the
        vouch count, which inverted the protection: measured, an author scored
        **0.0 — the band reserved for PROVEN self-dealing** — was ADMITTED into
        a brand-new viewer's cold-start feed via the lane, while the same
        author was correctly blocked on `OON_INTEREST`. The audience with no
        follow graph to defend them got the least protection of anyone.
        Declaring an interest is a statement about TOPIC, not a statement that
        the viewer vouches for whoever posts into it, so exemption from the
        vouch COUNT was right and exemption from the credibility floor was not.

        This cannot block a genuine newcomer: an author absent from
        `graph_creds` passes (`filter_eligible` treats missing cred as
        permissive), and an unknown/never-engaged account scores
        `min_vouched_score` = 0.10, comfortably above `graph_cred_floor` = 0.05.
        Only the explicit 0.0 self-dealing band is refused.

        `POPULAR_FALLBACK` stays exempt here because `_fallback_filler` already
        drops the 0.0 band itself before padding (see `pipeline.py`), and
        `EXPLORATION` is exempt too — a brand-new author is below every floor by
        construction, which is the whole point of that lane; its defence is a
        per-author budget plus ring and self-deal exclusion instead. (That lane
        shipped 2026-08-04; this paragraph called it "future" until then.)
        """
        return self not in (
            CandidateSource.IN_NETWORK,
            CandidateSource.POPULAR_FALLBACK,
            # A brand-new author is below every floor by construction; gating
            # this lane on the floor would make it a lane that can never fire.
            CandidateSource.EXPLORATION,
        )

    @property
    def counts_toward_flooding_cap(self) -> bool:
        """Whether one author may be capped to `max_oon_posts_per_author`
        candidates from this lane (§8.8).

        ★ ITS OWN PREDICATE AS OF 2026-08-04, and the reason is a repeat
        offence. `flooding.cap_oon_flooding` keyed on `requires_author_floor`,
        having previously keyed on `requires_second_degree` — and its own
        comment records what happened last time: the moment `OON_INTEREST` was
        exempted from the vouch count for an unrelated reason, it silently left
        the flooding cap too and one account took 60 of 103 slots in a real
        viewer's feed. Extending the author floor to the cold-start lanes (B4)
        would have done the same thing again in the opposite direction — quietly
        subjecting `INTEREST_*` to a per-author cap as a side effect of a
        security fix nobody connected to flooding.

        So the two questions are now named separately. This one preserves the
        behaviour the flooding tests already pin; whether a cold-start interest
        feed SHOULD also be flood-capped is a real question, but it is a
        deliberate product decision, not something to change by accident while
        editing a different property.
        """
        return self not in (
            CandidateSource.IN_NETWORK,
            CandidateSource.INTEREST_TAG,
            CandidateSource.POPULAR_FALLBACK,
            # already bounded by its own per-author epoch budget
            CandidateSource.EXPLORATION,
        )


@dataclass(frozen=True)
class Vote:
    """A single vote. ``rshares`` is signed; the vote signal (§4) keeps positive
    rshares only (rev 2.1 — downvotes never affect ranking)."""

    voter: str
    rshares: int
    timestamp: datetime
    #: ★★★ L2 (2026-08-05) — this vote came from a Lumen Lite account and never
    #: touched a chain (`lumen_vote`, the app's own Postgres). It therefore has
    #: NO rshares to speak of, and the two scoring terms must treat it
    #: differently, which is the entire reason this flag exists rather than a
    #: synthetic rshares value:
    #:
    #: * **BREADTH — counted.** A lite voter is a distinct person expressing a
    #:   preference, which is what the breadth term measures. They enter as an
    #:   UNKNOWN identity, so `VoterTrust.credited_breadth`'s existing
    #:   `unknown_free` budget applies. ★★ PRECISELY: the bound is
    #:   `unknown_free + unknown_per_vouched * (vouched engagers)`, NOT a flat
    #:   1.0. With no vouched engager, 50 lite accounts buy one unit and the
    #:   shipped test pins that; with vouched engagers present it GROWS —
    #:   measured at 31.0 (10 vouched) and 300.0 (with a follow graph). The
    #:   unconditional phrasing was disproved in round 3 and propagated anyway.
    #:   The defence is the one that already
    #:   exists; no new one was invented for this.
    #: * **STAKE MAGNITUDE — excluded, always.** A lite vote costs nothing: no
    #:   RC, no stake, no chain record. Letting it sum into the rshares term
    #:   would let free accounts move the stake-weighted signal, which is the
    #:   one thing this project's whole thesis says money should not buy either.
    #:
    #: The rejected alternative was a synthetic rshares just above
    #: `_ORGANIC_VOTER_MIN_RSHARES`. Arithmetically its pollution is negligible
    #: against real whale votes — and it would record something FALSE in the
    #: data model, which is how nearly every bug in this project's history
    #: started: true-ish in one layer, wrong in the next.
    #:
    #: Lite votes never enter `engagement_edges`, so they can never build
    #: graph-cred or confer vouch. A lite user gains trust only from chain
    #: engagement they RECEIVE (L1), which is expensive — so there is no loop
    #: where free votes mint the trust that would make free votes count more.
    lite: bool = False


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
    #: A12 (2026-08-04): the identity votes/comments/reblogs/suppression
    #: reports are actually recorded against ON CHAIN, when it differs from
    #: ``author``. Set only for a Lumen Lite post: ``author`` there is the
    #: writer's ``lumen_user_id`` (the RANKED identity, substituted at
    #: hydration — ``recsys.io.hafsql._build_post``), while every on-chain row
    #: (votes, comments, reblogs, a §8.7 suppression report) is against the
    #: shared publisher account this field carries. ``None`` means "same as
    #: ``author``" (every ordinary Hive post), so every existing construction
    #: of ``Post`` stays valid. ``key`` (below) deliberately keeps using
    #: ``author``, not this field — the ranked identity is the whole point of
    #: the lite substitution; ONLY the two chain-identity lookups
    #: (``HafsqlGateway.second_degree_engagers`` / ``.suppressed_keys``, via
    #: ``recsys.io.hafsql.chain_author_map``) read this field.
    chain_author: str | None = None

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
    interest_tags: frozenset[str] = frozenset()
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
    #: WHO engaged this account from outside its own ring/lineage. ``outside_engaged``
    #: is the boolean summary; this is the evidence behind it, needed because a
    #: DIRECTED sock cycle (S0->S1->S2->S0) produces no reciprocal pair, so
    #: ``ring_members`` is empty, so every sock counts as another sock's "outside"
    #: engager and the whole cycle vouches itself. Seed-anchored propagation
    #: (:func:`recsys.pipeline._voter_trust_from_creds`) walks these sets from
    #: ``trusted_seeds`` instead of trusting the boolean. Defaults empty so every
    #: existing construction stays valid.
    outside_engagers: frozenset[str] = frozenset()


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
    """The composite score and its normalized components, all in ``[0, 1]``.

    ``vote_norm``/``rep_norm``/``organic`` are the three EARNED signals — what
    this post and this author actually did — combined at the §0 outer split::

        earned = 0.10*vote_norm + 0.10*rep_norm + 0.80*organic

    ``final`` is that earned score blended with the viewer's DECLARED-interest
    percentile (:data:`recsys.config.ScoreWeights.interest_match`)::

        final = (1 - W)*earned + W*interest_pct,  W = organic_weight * interest_match

    and ``interest_bonus`` records the additive part that blend contributed,
    ``W * interest_pct`` — i.e. ``final - interest_bonus`` is the earned score
    after dilution, and ``interest_bonus`` is 0.0 whenever the channel is off
    or the viewer supplied no interest signal for this candidate (which is what
    makes ``interest_match = 0.0`` byte-identical to the pre-B02 score).

    ★ WHY ``interest_bonus`` IS CARRIED RATHER THAN RECOMPUTED (2026-08-05).
    The re-ranker's AUTHOR-repeat and UNCHOSEN-lane penalties are MULTIPLICATIVE
    and must be applied to the earned part only — see
    :func:`recsys.core.rerank._effective_score` for the measurement that forced
    this. The re-ranker cannot recompute the split (it holds no weights and no
    viewer), so the scorer hands it over. It is a decomposition of ``final``,
    never a separate signal: nothing may rank on it.
    """

    vote_norm: float
    rep_norm: float
    organic: float
    final: float
    interest_bonus: float = 0.0


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

    def tag_posts(
        self, tags: frozenset[str], since: datetime, limit: int
    ) -> list[Post]: ...

    def window_posts(self, since: datetime, limit: int) -> list[Post]:
        """A5: ALL (top-level + lite) posts created since ``since``, ordered by
        RECENCY ONLY — never by engagement. The source
        ``build_window_norm``/:class:`NormContext` draws its percentile sample
        from. ``popular_posts`` is ``ORDER BY engagement DESC``; reusing it here
        would bias the sample upward and push every real score toward the
        bottom of the percentile range — see the module note in
        ``recsys.io.hafsql`` for the live sizing that makes returning the whole
        window (rather than sampling) the right call."""
        ...

    def engagement_edges(self, since: datetime) -> list[EngagementEdge]: ...

    # ★ `stake_lineage` REMOVED from this protocol 2026-08-05 (B2) — stake
    # delegation is no longer an input to the algorithm, and dropping it from
    # the gateway contract is what makes that structural rather than a
    # convention. See `recsys.pipeline._lineage_for`.

    def second_degree_engagers(
        self,
        post_keys: frozenset[str],
        follows: frozenset[str],
        *,
        chain_authors: Mapping[str, str] | None = None,
    ) -> dict[str, frozenset[str]]:
        """For each OON post key, which of the viewer's ``follows`` engaged it
        (§8.1). Produces the engager index the second-degree gate consumes —
        so the gate *checks vouches* instead of blocking every OON post.

        A12: ``chain_authors`` (``Post.key -> Post.chain_author``, build with
        ``recsys.io.hafsql.chain_author_map``) resolves a lite post's RANKED
        key to the identity votes/replies/reblogs are actually recorded
        against before querying. The result stays keyed on the ORIGINAL
        (ranked) key regardless — ``filter_eligible``'s
        ``engager_index.get(post.key)`` needs no change. ``None`` (the
        default) is byte-identical to the pre-A12 behaviour, so every existing
        caller is unaffected until it opts in."""
        ...

    def follow_graph(self, accounts: frozenset[str]) -> dict[str, frozenset[str]]:
        """follower -> followees among ``accounts`` (§8.3), for graph-cred."""
        ...

    def author_first_post(
        self, authors: frozenset[str], *, horizon_days: int, now: datetime | None = None
    ) -> dict[str, datetime]:
        """When each of ``authors`` FIRST published — the newness predicate the
        exploration lane gates on (2026-08-08, ``ExplorationConfig.
        max_author_age_days``).

        Keyed on the RANKED identity, like every other author-keyed read here,
        so a Lumen Lite writer resolves to their own first lite post rather than
        to the shared publisher account's history.

        ★ ``horizon_days`` IS PART OF THE CONTRACT, not a hint (2026-08-08). An
        implementation is permitted to answer only for authors NEWER than the
        horizon and omit the rest, because proving an author is OLD can stop at
        the first old post while computing their true first-post date cannot —
        that difference is 311s vs 0.25s on the real mirror. Callers MUST pass
        the same ``max_author_age_days`` they then test against, or the bound
        and the predicate drift apart and the lane silently refuses authors the
        config says are eligible.

        An author ABSENT from the result is therefore "old, or unknown" — either
        way the lane refuses them (fail-closed). Fail-open would treat every
        author the lookup missed as a debut, which is the exact state the
        predicate exists to detect. Because absence is now overloaded, an
        implementation that FAILS must raise rather than return a short dict:
        a silent empty result is indistinguishable from "no newcomers today",
        and that ambiguity is how this lane shipped unreachable once already."""
        ...

    def popular_posts(self, since: datetime, limit: int) -> list[Post]:
        """Community-popular fallback for the fully-cold viewer (§13.5b), ranked
        by our own positive-engagement signals — never payout indexing."""
        ...

    def suppressed_keys(
        self, post_keys: frozenset[str], *, chain_authors: Mapping[str, str] | None = None
    ) -> frozenset[str]:
        """Subset of ``post_keys`` under network suppression (§8.7).

        A12: same ``chain_authors`` resolution as ``second_degree_engagers`` —
        a §8.7 report is filed against the on-chain (author, permlink), which
        for a lite post is the publisher account, not the writer's ranked
        identity. ``None`` (the default) is byte-identical to the pre-A12
        behaviour."""
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
