"""End-to-end pipeline integration tests (§3) against the in-memory gateway."""

from __future__ import annotations

import dataclasses
import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta

import pytest

from recsys.config import (
    DEFAULT_SETTINGS,
    ALSConfig,
    GraphCredConfig,
    Settings,
    VoteSignalConfig,
)
from recsys.contracts import (
    Candidate,
    CandidateSource,
    EngagementEdge,
    GraphCred,
    NormContext,
    Post,
)
from recsys.core.als import train_als
from recsys.core.coldstart import is_cold
from recsys.core.normalize import build_norm_context
from recsys.core.scoring import AuthorEngagement, post_base_engagement
from recsys.core.vote_signal import AttributedPost, AttributionMissingError, VoterTrust
from recsys.pipeline import (
    ALS_DRIFT_REJECTIONS,
    TRUST_DEGRADATION,
    MissingTrustError,
    TrustPolicy,
    TrustSnapshot,
    _organic_signal,
    _ring_exclusion,
    _voter_trust,
    build_trust_snapshot,
    gather_candidates,
    rank_feed,
)
from tests.fakes import EPOCH, FakeGateway, make_post, make_viewer, make_vote

NOW = EPOCH + timedelta(hours=1)

# R2 (H01 fail-open-by-default fix): production now DEFAULTS to
# TrustPolicy.FAIL_CLOSED — a caller who provides no fresh TrustSnapshot is
# REFUSED (MissingTrustError), not silently served a full-breadth fail-open
# feed (see test_h01_default_policy_is_fail_closed). The many unit tests below
# that exercise NON-trust behaviour (candidate gather, eligibility, scoring,
# fallback, diversity, ring/prior wiring) with no snapshot are legitimate
# permissive callers — the same deliberate opt-in the offline measurement
# harness uses — so each one passes ``trust_policy=_PERMISSIVE`` explicitly.
# The rationale lives here once; the opt-in is named at every call site.
_PERMISSIVE = TrustPolicy.WARN


def _norm() -> NormContext:
    # >= NormConfig.min_samples (50) so the scorer's guard admits it.
    samples = [float(i) for i in range(50)]
    return build_norm_context(samples, samples, samples)


def test_in_network_feed_end_to_end() -> None:
    p1 = make_post(
        "alice", "a1", author_reputation=70.0, children=3,
        votes=[make_vote("bob", 5_000_000), make_vote("carol", 5_000_000)],
    )
    p2 = make_post("dave", "d1", author_reputation=30.0, votes=[make_vote("erin", 1_000_000)])
    gateway = FakeGateway(in_network=[p1, p2])
    viewer = make_viewer("me", follows=frozenset({"alice", "dave"}))

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    assert {sc.post.key for sc in feed} == {"@alice/a1", "@dave/d1"}
    assert all(0.0 <= sc.score.final <= 1.0 for sc in feed)


def test_muted_author_is_filtered() -> None:
    gateway = FakeGateway(in_network=[make_post("alice", "a1"), make_post("spammer", "s1")])
    viewer = make_viewer(
        "me", follows=frozenset({"alice", "spammer"}), mutes=frozenset({"spammer"})
    )

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    assert {sc.post.author for sc in feed} == {"alice"}


def test_cold_viewer_served_interest_lane() -> None:
    # A brand-new viewer with no follows must still get a feed from the
    # community/interest lane (rev 2.2) — those sources bypass the gate.
    community_post = make_post("author1", "c1", community="hive-1")
    tag_post = make_post("author2", "t1", tags=("art",))
    gateway = FakeGateway(community=[community_post], tag=[tag_post])
    viewer = make_viewer(
        "newbie",
        is_new=True,
        interest_communities=frozenset({"hive-1"}),
        interest_tags=frozenset({"art"}),
    )

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    assert {sc.post.author for sc in feed} == {"author1", "author2"}


def test_unrequested_oon_still_needs_second_degree_vouch() -> None:
    oon_post = make_post("stranger", "x1")
    viewer = make_viewer("me", follows=frozenset({"alice"}))

    # No in-network engager (gateway produces an empty index) -> dropped.
    bare = FakeGateway(oon=[Candidate(post=oon_post, source=CandidateSource.OON_ENGAGED)])
    assert rank_feed(viewer, bare, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE) == []

    # A followed account has engaged it -> the gateway vouches -> admitted.
    vouched = FakeGateway(
        oon=[Candidate(post=oon_post, source=CandidateSource.OON_ENGAGED)],
        engagers={"@stranger/x1": frozenset({"alice"})},
    )
    admitted = rank_feed(viewer, vouched, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
    assert {sc.post.key for sc in admitted} == {"@stranger/x1"}


def test_gather_dedups_in_network_over_community() -> None:
    shared = make_post("alice", "a1", community="hive-1")
    gateway = FakeGateway(in_network=[shared], community=[shared])
    viewer = make_viewer(
        "me", follows=frozenset({"alice"}), subscribed_communities=frozenset({"hive-1"})
    )

    candidates = gather_candidates(viewer, gateway, EPOCH, 400, DEFAULT_SETTINGS)

    assert len(candidates) == 1
    assert candidates[0].source is CandidateSource.IN_NETWORK


def test_interest_lane_not_appended_for_followed_viewer_claiming_new() -> None:
    # F-R5 #3: the gate-exempt interest lane is routed on the UNSPOOFABLE
    # `not viewer.follows`, never the client-set `is_new` flag. A viewer WITH
    # follows must NOT be able to force the exempt lane onto their feed by
    # claiming is_new=True (the spoofable-flag shape hardened elsewhere).
    interest_sources = {CandidateSource.INTEREST_COMMUNITY, CandidateSource.INTEREST_TAG}
    community_post = make_post("author1", "c1", community="hive-1")
    tag_post = make_post("author2", "t1", tags=("art",))
    in_net = make_post("alice", "a1")
    gateway = FakeGateway(in_network=[in_net], community=[community_post], tag=[tag_post])

    followed_new = make_viewer(
        "me",
        follows=frozenset({"alice"}),
        is_new=True,  # spoofable client flag — must NOT open the interest lane
        interest_communities=frozenset({"hive-1"}),
        interest_tags=frozenset({"art"}),
    )
    followed_cands = gather_candidates(followed_new, gateway, EPOCH, 400, DEFAULT_SETTINGS)
    assert interest_sources.isdisjoint({c.source for c in followed_cands})

    # Control: a genuinely followless viewer still gets the lane (is_new=False).
    followless = make_viewer(
        "newbie",
        is_new=False,
        interest_communities=frozenset({"hive-1"}),
        interest_tags=frozenset({"art"}),
    )
    cold_sources = {
        c.source for c in gather_candidates(followless, gateway, EPOCH, 400, DEFAULT_SETTINGS)
    }
    assert interest_sources & cold_sources


def test_empty_norm_is_refused_not_silently_flat() -> None:
    gateway = FakeGateway(in_network=[make_post()])
    viewer = make_viewer("me", follows=frozenset({"alice"}))
    empty_norm = build_norm_context([], [], [])
    with pytest.raises(ValueError, match="fewer than"):
        rank_feed(viewer, gateway, empty_norm, now=NOW, since=EPOCH)


def test_organic_proxy_zero_engagement_is_age_sensitive_not_pinned_to_zero() -> None:
    # The old bug: log10(1+0)*decay == 0 for every un-engaged post regardless of
    # age. Now recency is additive, so a fresh zero-engagement post is non-zero
    # and outscores an old one.
    post = make_post("a", "1", created_min=0)
    viewer = make_viewer("me")
    fresh = _organic_signal(post, viewer, EPOCH + timedelta(hours=1), frozenset(), None, 0.0)
    old = _organic_signal(post, viewer, EPOCH + timedelta(hours=240), frozenset(), None, 0.0)
    assert fresh > 0.0
    assert fresh > old


def _cf_edges() -> list[EngagementEdge]:
    # "me" and "peer" both heavily engage author "liked"; ALS learns me->liked
    # affinity. "other" is engaged once, "stranger" never.
    return [
        EngagementEdge(src="me", dst="liked", upvotes=10, replies=10),
        EngagementEdge(src="peer", dst="liked", upvotes=10, replies=10),
        EngagementEdge(src="me", dst="other", upvotes=1),
    ]


def test_organic_raw_is_viewer_independent_after_the_cf_rebuild() -> None:
    # RULED BEHAVIOUR CHANGED 2026-07-21. This test previously asserted
    # _organic_signal(...) == base + cf_weight * affinity — the additive raw CF
    # bump. That bump was measured to push 68 of 113 pool posts past the §4
    # sample's max, clipping them all to organic percentile 1.0 and turning the
    # 80% organic term into a constant across 12.8 of the top-20 slots. CF is
    # now blended AFTER normalization as a per-viewer percentile, so the raw
    # this function produces — which is exactly what the rolling norm sample is
    # built from — must be viewer-independent. Same invariant, honest version:
    # the norm sample and the values ranked against it come from one function.
    als = train_als(_cf_edges(), ALSConfig())
    liked_post = make_post("liked", "p1", created_min=0)
    without_cf = _organic_signal(liked_post, make_viewer("me"), NOW, frozenset(), None, 1.5)
    with_cf = _organic_signal(liked_post, make_viewer("me"), NOW, frozenset(), als, 1.5)
    other_viewer = _organic_signal(liked_post, make_viewer("peer"), NOW, frozenset(), als, 1.5)
    assert with_cf == pytest.approx(without_cf)
    assert with_cf == pytest.approx(other_viewer)
    # the learned affinity itself is unchanged and still discriminates
    assert als.affinity("me", "liked") > als.affinity("me", "stranger")


def test_als_cf_affinity_reaches_the_final_score_without_saturating() -> None:
    # The integration is wired, not decorative: the viewer's CF affinity moves
    # the organic component of the FINAL score — and, unlike the retired
    # additive bump, it cannot clip, because it is a percentile blended into a
    # percentile (both bounded, weights summing to 1).
    als = train_als(_cf_edges(), ALSConfig())
    posts = [make_post("liked", "p1"), make_post("other", "p2"), make_post("stranger", "p3")]
    gateway = FakeGateway(in_network=posts)
    viewer = make_viewer("me", follows=frozenset({"liked", "other", "stranger"}))
    snap = TrustSnapshot(als=als)

    # als-only snapshot (no graph_creds) is not "fresh" post-H01-fix — it still
    # has the breadth budget off — so this CF-only test opts into WARN explicitly.
    with_cf = {sc.post.author: sc.score for sc in
               rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap,
                         trust_policy=_PERMISSIVE)}
    no_cf = {sc.post.author: sc.score for sc in
             rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)}

    # every post here has identical (zero) engagement, so the quality
    # percentile is a constant: any ordering among them is the CF slice alone.
    assert with_cf["liked"].organic > with_cf["stranger"].organic
    assert with_cf["liked"].final > with_cf["stranger"].final
    assert with_cf["liked"].organic != no_cf["liked"].organic
    # an author the model never saw ("stranger" is in no edge) ranks neutral,
    # not bottom — unknown is not the same state as bad (§8.3 doctrine).
    assert with_cf["stranger"].organic == pytest.approx(with_cf["other"].organic)
    # THE SATURATION REGRESSION GUARD. The retired additive bump put this
    # viewer's top CF author at organic percentile 1.0 (raw 0.5 + 1.5*affinity
    # against a sample topping out at 49). A percentile blended into a
    # percentile cannot reach the ceiling unless BOTH halves do.
    assert all(0.0 <= s.organic <= 1.0 for s in with_cf.values())
    assert max(s.organic for s in with_cf.values()) < 1.0


def test_cf_weight_zero_ablates_the_cf_slice_entirely() -> None:
    als = train_als(_cf_edges(), ALSConfig())
    gateway = FakeGateway(in_network=[make_post("liked", "p1")])
    viewer = make_viewer("me", follows=frozenset({"liked"}))
    ablated = dataclasses.replace(
        DEFAULT_SETTINGS, als=dataclasses.replace(DEFAULT_SETTINGS.als, cf_weight=0.0)
    )
    with_cf = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=TrustSnapshot(als=als),
        trust_policy=_PERMISSIVE,
    )
    off = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        snapshot=TrustSnapshot(als=als), settings=ablated, trust_policy=_PERMISSIVE,
    )
    none_at_all = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE
    )
    assert off[0].score.organic == pytest.approx(none_at_all[0].score.organic)
    assert off[0].score.organic != pytest.approx(with_cf[0].score.organic)


class _PriorGateway(FakeGateway):
    """FakeGateway that also serves the author-pooled window aggregate, and
    records the exclusion set AND trust budget the pipeline hands it so wiring
    can be asserted."""

    def __init__(
        self,
        priors: dict[str, AuthorEngagement],
        *,
        in_network: Sequence[Post] = (),
        lineage: dict[str, frozenset[str]] | None = None,
    ) -> None:
        super().__init__(in_network=in_network, lineage=lineage)
        self._priors = priors
        self.last_excluded: dict[str, frozenset[str]] | None = None
        self.last_trust: VoterTrust | None = None

    def author_engagement(
        self,
        authors: frozenset[str],
        since: datetime,
        excluded: Mapping[str, frozenset[str]] | None = None,
        *,
        trust: VoterTrust | None = None,
    ) -> dict[str, AuthorEngagement]:
        self.last_excluded = dict(excluded) if excluded is not None else None
        self.last_trust = trust
        return {a: p for a, p in self._priors.items() if a in authors}


class _HonoringPriorGateway(FakeGateway):
    """``author_engagement`` HONORS the excluded arg AND (H05) the ``trust``
    breadth budget — the in-memory twin of ``_SQL_AUTHOR_ENGAGEMENT``: it sums
    ``post_base_engagement`` over an author's window posts, applying that
    author's §8.4 exclusion set AND the same ``VoterTrust`` credit
    (``vouched + budgeted(unknown)``) each post's OWN engagement already gets,
    exactly as the live grouped query does. ``honor=False`` reproduces the
    pre-fix, self-exclusion-only aggregate (trust dropped too, since the
    breadth budget did not exist before either fix) so a before/after A/B runs
    the same world."""

    def __init__(
        self,
        window: Sequence[Post],
        *,
        in_network: Sequence[Post] = (),
        lineage: dict[str, frozenset[str]] | None = None,
        honor: bool = True,
    ) -> None:
        super().__init__(in_network=in_network, lineage=lineage)
        self._window = list(window)
        self._honor = honor

    def author_engagement(
        self,
        authors: frozenset[str],
        since: datetime,
        excluded: Mapping[str, frozenset[str]] | None = None,
        *,
        trust: VoterTrust | None = None,
    ) -> dict[str, AuthorEngagement]:
        ex = excluded or {}
        applied_trust = trust if self._honor else None
        out: dict[str, AuthorEngagement] = {}
        for author in authors:
            posts = [p for p in self._window if p.author == author]
            if not posts:
                continue
            extra = frozenset(ex.get(author, frozenset())) if self._honor else frozenset()
            exset = extra | {author}
            total = sum(post_base_engagement(p, exset, trust=applied_trust) for p in posts)
            out[author] = AuthorEngagement(posts=len(posts), total_base=total)
        return out


def test_author_prior_is_fed_the_full_exclusion_set() -> None:
    # The pooled prior's input must be filtered by the SAME §8.4 set the scorer
    # applies to own_base: self + stake lineage + per-author ring. Without this
    # the aggregate is self-excluded only and an author farms their own prior.
    post = make_post("farm", "p1", votes=[make_vote("h1", 50_000_000)])
    priors = {"farm": AuthorEngagement(posts=2, total_base=0.6)}
    gateway = _PriorGateway(priors, in_network=[post], lineage={"farm": frozenset({"alt1"})})
    viewer = make_viewer("me", follows=frozenset({"farm"}))
    snap = TrustSnapshot(ring_members=frozenset({"farm", "ringmate"}))

    # ring_members but no graph_creds -> not "fresh" post-H01-fix (breadth budget
    # still off), and this test deliberately asserts that None-trust state, so it
    # opts into WARN rather than supplying a graph-cred it is not testing.
    rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap,
              trust_policy=_PERMISSIVE)

    assert gateway.last_excluded == {"farm": frozenset({"alt1", "ringmate", "farm"})}
    # No graph-cred in this snapshot -> _voter_trust is honestly None -> the
    # gateway must be handed None too, not a default/empty VoterTrust that
    # would silently zero every unknown-tier identity's breadth.
    assert gateway.last_trust is None


def test_author_prior_is_fed_the_same_trust_budget_the_scorer_uses() -> None:
    # H05 wiring: once a graph-cred snapshot exists, _author_priors must pass
    # the SAME VoterTrust _score builds for own_base -- not None, and not a
    # gateway-local reconstruction that could drift from the scorer's budget.
    post = make_post("farm", "p1", votes=[make_vote("h1", 50_000_000)])
    priors = {"farm": AuthorEngagement(posts=2, total_base=0.6)}
    gateway = _PriorGateway(priors, in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"farm"}))
    # outside_engaged=True (H02): a bare score does not vouch on its own since
    # the H02 fix -- vouching requires received engagement from OUTSIDE the
    # account's own ring/lineage, which this hand-built cred asserts directly.
    snap = TrustSnapshot(
        graph_creds={"h1": GraphCred(account="h1", score=0.8, follow_follower_ratio=1.0,
                                      outside_engaged=True)}
    )

    rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap)

    expected = _voter_trust(snap, DEFAULT_SETTINGS)
    assert gateway.last_trust == expected
    assert gateway.last_trust is not None
    assert gateway.last_trust.vouched == frozenset({"h1"})
    assert gateway.last_excluded == {"farm": frozenset({"farm"})}


def test_pooled_prior_no_longer_lifts_an_alt_farmed_author() -> None:
    # farm farms its OTHER window posts with six delegation-tied alts; honest
    # has the same own-post engagement but genuine independent engagement on its
    # other posts. Self-exclusion-only (pre-fix) counts the alts and lifts farm
    # ABOVE honest; the §8.4-filtered aggregate strips them and farm falls back.
    farm_p0 = make_post(
        "farm", "p0", votes=[make_vote("h1", 50_000_000), make_vote("h2", 50_000_000)]
    )
    honest_q0 = make_post(
        "honest", "q0", votes=[make_vote("h3", 50_000_000), make_vote("h4", 50_000_000)]
    )
    alt_votes = [make_vote(f"alt{i}", 50_000_000) for i in range(6)]
    farm_others = [make_post("farm", f"p{i}", votes=alt_votes) for i in range(1, 5)]
    honest_others = [
        make_post(
            "honest", f"q{i}",
            votes=[make_vote("h5", 50_000_000), make_vote("h6", 50_000_000)],
        )
        for i in range(1, 5)
    ]
    window = [farm_p0, honest_q0, *farm_others, *honest_others]
    lineage = {"farm": frozenset(f"alt{i}" for i in range(6))}

    # a norm fine enough on the organic axis to resolve the two nearby raws
    fine = [i / 50.0 for i in range(50)]
    coarse = [float(i) for i in range(50)]
    norm = build_norm_context(coarse, coarse, fine)
    viewer = make_viewer("me", follows=frozenset({"farm", "honest"}))

    def served(honor: bool) -> list[str]:
        gw = _HonoringPriorGateway(
            window, in_network=[farm_p0, honest_q0], lineage=lineage, honor=honor
        )
        feed = rank_feed(viewer, gw, norm, now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
        return [sc.post.author for sc in feed]

    # pre-fix: the alt farm lifts farm above honest.
    assert served(honor=False) == ["farm", "honest"]
    # after the fix: alts stripped from the prior -> farm loses the rented lift
    # and honest (genuine engagement) is served first.
    assert served(honor=True) == ["honest", "farm"]


def test_pooled_prior_sock_swarm_is_breadth_budgeted_not_farmed() -> None:
    # H05: self/lineage/ring exclusion (the test above) does nothing about
    # BREADTH. A swarm of unknown-tier socks -- not the author, not lineage,
    # not a reciprocal ring, so they pass every §8.4 exclusion untouched --
    # farming an author's OTHER window posts must be capped at the SAME
    # VoterTrust budget own_base already applies, not counted one-for-one.
    own_votes = [make_vote("h1", 50_000_000), make_vote("h2", 50_000_000)]
    farm_p0 = make_post("farm", "p0", votes=own_votes)
    honest_q0 = make_post("honest", "q0", votes=own_votes)

    # farm's other 4 window posts: 20 distinct UNKNOWN-tier sock voters each.
    # None are lineage-tied or ring-flagged -- pre-H05 exclusion alone lets
    # every one of them count in full.
    sock_votes = [make_vote(f"sock{i}", 50_000_000) for i in range(20)]
    farm_others = [make_post("farm", f"p{i}", votes=sock_votes) for i in range(1, 5)]
    # honest's other 4 posts: 2 genuinely VOUCHED voters each -- modest, real.
    honest_votes = [make_vote("h3", 50_000_000), make_vote("h4", 50_000_000)]
    honest_others = [make_post("honest", f"q{i}", votes=honest_votes) for i in range(1, 5)]
    window = [farm_p0, honest_q0, *farm_others, *honest_others]

    creds = {f"sock{i}": _cred(0.10) for i in range(20)}  # AT the floor -> unknown band
    # outside_engaged=True (H02): vouching requires received engagement from
    # OUTSIDE the account's own ring/lineage, not merely a high score -- these
    # four are hand-built as genuinely, independently engaged accounts.
    creds.update(
        {
            name: GraphCred(account=name, score=0.8, follow_follower_ratio=1.0,
                             outside_engaged=True)
            for name in ("h1", "h2", "h3", "h4")
        }
    )
    trusted_snap = TrustSnapshot(graph_creds=creds)

    viewer = make_viewer("me", follows=frozenset({"farm", "honest"}))
    fine = [i / 50.0 for i in range(50)]
    coarse = [float(i) for i in range(50)]
    norm = build_norm_context(coarse, coarse, fine)

    def served(snap: TrustSnapshot) -> list[str]:
        gw = _HonoringPriorGateway(window, in_network=[farm_p0, honest_q0])
        # _PERMISSIVE (WARN): the empty-snapshot leg below deliberately measures
        # the pre-H05 degraded/fail-open behaviour, which post-H01-fix requires
        # the explicit opt-in (an empty TrustSnapshot() is no longer "fresh").
        # A populated snapshot is fresh, so the policy is a no-op for it.
        feed = rank_feed(
            viewer, gw, norm, now=NOW, since=EPOCH, snapshot=snap,
            trust_policy=_PERMISSIVE,
        )
        return [sc.post.author for sc in feed]

    # Before H05 (no trust snapshot -> the prior's breadth is un-budgeted):
    # the 20-sock swarm inflates farm's pooled prior past honest's modest,
    # genuine engagement -- exactly the "organic 0 -> 1.0" farming H05 fixes.
    assert served(TrustSnapshot()) == ["farm", "honest"]
    # After H05 (trust snapshot -> the gateway budgets the swarm's breadth at
    # unknown_free=1.0, the same cap own_base's voters would get): the swarm
    # buys almost nothing, honest's smaller-but-vouched engagement wins, and
    # farm's organic sits near its own_base rather than saturating toward the
    # sample's max.
    assert served(trusted_snap) == ["honest", "farm"]


def test_author_pooled_prior_outranks_one_lucky_post() -> None:
    # Two posts with IDENTICAL per-post engagement (2 independent voters each).
    # "steady" has 4 other window posts that also drew engagement; "lucky" has
    # 4 other window posts that drew none. Per-post counts cannot tell them
    # apart (that is the ~5-voter Bernoulli problem); the author-pooled prior
    # can, and must rank the steady author higher.
    votes = [make_vote("v1", 50_000_000), make_vote("v2", 50_000_000)]
    steady = make_post("steady", "p1", votes=votes)
    lucky = make_post("lucky", "p1", votes=votes)
    own_base = post_base_engagement(steady, frozenset({"steady"}))
    priors = {
        "steady": AuthorEngagement(posts=5, total_base=own_base * 5),
        "lucky": AuthorEngagement(posts=5, total_base=own_base),
    }
    viewer = make_viewer("me", follows=frozenset({"steady", "lucky"}))
    # a norm sample fine enough to resolve two nearby organic raws (the default
    # 0..49 integer sample ranks every realistic organic value at one bucket)
    fine = [i / 50.0 for i in range(50)]
    coarse = [float(i) for i in range(50)]
    norm = build_norm_context(coarse, coarse, fine)

    pooled = rank_feed(
        viewer, _PriorGateway(priors, in_network=[steady, lucky]), norm,
        now=NOW, since=EPOCH, trust_policy=_PERMISSIVE,
    )
    assert [sc.post.author for sc in pooled] == ["steady", "lucky"]
    assert pooled[0].score.organic > pooled[1].score.organic

    # Same world through a gateway with no author aggregate: the prior-less
    # fallback is exactly the old per-post signal, so the two tie.
    unpooled = rank_feed(
        viewer, FakeGateway(in_network=[steady, lucky]), norm, now=NOW, since=EPOCH,
        trust_policy=_PERMISSIVE,
    )
    assert unpooled[0].score.organic == pytest.approx(unpooled[1].score.organic)


def test_build_trust_snapshot_produces_graph_cred() -> None:
    edges = [
        EngagementEdge(src="a", dst="b", upvotes=5),
        EngagementEdge(src="b", dst="a", upvotes=5),
    ]
    gateway = FakeGateway(
        edges=edges, follow_graph={"a": frozenset({"b"}), "b": frozenset({"a"})}
    )
    snap = build_trust_snapshot(gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH)
    assert {"a", "b"} <= set(snap.graph_creds)
    assert isinstance(snap.ring_members, frozenset)


def test_build_trust_snapshot_refuses_empty_seeds_in_production() -> None:
    # F-R2: in production an empty trusted_seeds set makes TrustRank's seed
    # teleport mass revert to uniform, letting a Sybil clique mint free rank
    # with nothing raising. The production guard refuses it, mirroring the
    # fail-closed posture rank_feed already takes for a missing snapshot.
    edges = [
        EngagementEdge(src="a", dst="b", upvotes=5),
        EngagementEdge(src="b", dst="a", upvotes=5),
    ]
    gateway = FakeGateway(
        edges=edges, follow_graph={"a": frozenset({"b"}), "b": frozenset({"a"})}
    )
    with pytest.raises(ValueError, match="trusted_seeds"):
        build_trust_snapshot(
            gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH, production=True
        )
    # With seeds supplied, the production build succeeds.
    snap = build_trust_snapshot(
        gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
        trusted_seeds=frozenset({"a"}), production=True,
    )
    assert {"a", "b"} <= set(snap.graph_creds)
    # The offline/harness default (production=False) still allows empty seeds.
    offline = build_trust_snapshot(gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH)
    assert {"a", "b"} <= set(offline.graph_creds)


def _popular(n: int = 30) -> list:
    return [make_post(f"pop{i}", f"p{i}", author_reputation=60.0) for i in range(n)]


def test_established_viewer_with_dead_follows_is_never_served_an_empty_feed() -> None:
    # Regression: the returning user with a stale graph. They HAVE follows, so
    # is_cold() is False and the old cold-only guard never fired; every follow
    # is inactive so the realised pool is empty -> the feed was silently empty.
    # The top-up now triggers on the realised candidate count, not on identity.
    viewer = make_viewer("returning", follows=frozenset({"ghost1", "ghost2", "ghost3"}))
    gateway = FakeGateway(in_network=[], popular=_popular())
    assert is_cold(viewer) is False
    assert gather_candidates(viewer, gateway, EPOCH, 400, DEFAULT_SETTINGS) == []

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    # No personalized pool at all -> the popular lane IS the feed, at full depth
    # (unchanged §13.5b behavior, now reached by every viewer state).
    assert len(feed) == 30


def test_near_empty_feed_is_topped_up_without_losing_the_viewers_own_posts() -> None:
    # 3 candidates when the feed wants 20 is nearly as broken as 0. Top up to at
    # least min_feed_size, and keep all three genuine posts.
    own = [make_post("live", f"l{i}") for i in range(3)]
    gateway = FakeGateway(in_network=own, popular=_popular())
    viewer = make_viewer("quiet", follows=frozenset({"live"}))

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    assert len(feed) >= DEFAULT_SETTINGS.fallback.min_feed_size == 20
    assert {p.key for p in own} <= {sc.post.key for sc in feed}


def test_feed_length_is_monotonic_in_the_follow_graph() -> None:
    """★ More follows must never produce a SHORTER feed.

    ★ REPLACES an "exactly the shortfall" assertion (2026-08-01). That property
    was the cause of a worse cliff than the one it prevented: padding depth was
    the FULL admissible pool for a viewer with zero eligible posts and exactly
    one screen for a viewer with one, so a new user's first follow took their
    feed from ~200 posts to 20 and held it there until roughly their sixth
    active follow. Measured, 480-post window: 0 follows -> 200 served, 1 -> 20,
    5 -> 20, 6 -> 24, 50 -> 200.

    What still matters, and is asserted here, is that padding is a FALLBACK: it
    stops completely the moment the viewer's own network can fill a screen, and
    it never displaces their content (see the neighbouring test). Depth below
    that threshold is now continuous in the pool rather than a step.
    """
    popular = _popular()
    lengths = []
    for own_count in (0, 1, 4, 5, 6, 20, 25, 40):
        gateway = FakeGateway(
            in_network=[make_post("live", f"l{i}") for i in range(own_count)], popular=popular
        )
        viewer = make_viewer(
            "quiet", follows=frozenset({"live"}) if own_count else frozenset()
        )
        feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
        own_in_feed = [sc for sc in feed if sc.post.author == "live"]
        assert len(own_in_feed) == own_count, "the viewer lost their own posts"
        assert feed[:own_count] == own_in_feed, "padding displaced the viewer's own posts"
        lengths.append(len(feed))
    assert lengths == sorted(lengths), (
        f"feed length is not monotonic in the follow graph: {lengths} — more "
        "follows must never produce a shorter feed"
    )


def test_the_first_follow_does_not_truncate_the_feed() -> None:
    """★ THE CLIFF ITSELF, asserted on served feed length.

    A viewer with no follows and a viewer with one follow must get feeds of
    comparable depth. Before this fix the ratio was 10x.
    """
    popular = _popular()
    followless = rank_feed(
        make_viewer("new", follows=frozenset()),
        FakeGateway(popular=popular), _norm(), now=NOW, since=EPOCH,
        trust_policy=_PERMISSIVE,
    )
    one_follow = rank_feed(
        make_viewer("new", follows=frozenset({"live"})),
        FakeGateway(in_network=[make_post("live", "l0")], popular=popular),
        _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE,
    )
    assert len(followless) > 20, "fixture too small to show the cliff"
    assert len(one_follow) >= len(followless), (
        f"one follow cut the feed from {len(followless)} to {len(one_follow)} posts"
    )


def test_padding_never_outranks_the_viewers_own_posts() -> None:
    # The padding is a strict tail extension, so a high-scoring popular post
    # cannot displace the viewer's own low-engagement posts. Measured before
    # this rule: a 6-post interest pool landed at feed positions 14-19.
    own = [make_post("live", f"l{i}", created_min=-600) for i in range(3)]  # old, no votes
    loud = [
        make_post(
            f"pop{i}", f"p{i}", author_reputation=95.0, children=50, reblog_count=50,
            votes=[make_vote(f"v{j}", 9_000_000_000) for j in range(20)],
        )
        for i in range(30)
    ]
    gateway = FakeGateway(in_network=own, popular=loud)
    viewer = make_viewer("quiet", follows=frozenset({"live"}))

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    # The three own posts are identical apart from permlink, so they TIE on
    # score. Their relative order is therefore decided by the tie-break, which
    # is per-viewer as of 2026-08-01 (was global-alphabetical, which handed a
    # permanent advantage to whoever sorts first). Assert the invariant this
    # test is actually named for — padding never displaces the viewer's own
    # posts — rather than the incidental ordering among tied items.
    assert {sc.post.key for sc in feed[:3]} == {p.key for p in own}
    assert all(sc.post.author.startswith("pop") for sc in feed[3:])


def test_a_healthy_feed_is_never_DILUTED_by_the_fallback() -> None:
    """Padding may EXTEND a feed; it must never enter or reorder the real one.

    ★ WEAKENED DELIBERATELY FROM "untouched" TO "undiluted" (2026-08-01). The
    old assertion was that a healthy viewer's feed is byte-identical whether or
    not popular posts exist — i.e. padding runs only below one screen. That
    threshold is what made served feed length non-monotonic in the follow graph
    (4 follows -> 200 posts, 5 follows -> 20 and dead-ends), because pad-or-not
    was decided at one screen while how-deep was decided at the whole pool.

    Aligning the two means a healthy viewer's feed now has a popular TAIL. The
    property that actually protects them is unchanged and is what is asserted
    here: every post from their own network comes first, in the same order, and
    no padding appears among them. Dilution would be padding interleaved into or
    displacing the real pool — that is what must never happen.
    """
    own = [make_post("live", f"l{i}") for i in range(40)]
    viewer = make_viewer("busy", follows=frozenset({"live"}))
    without = rank_feed(
        viewer, FakeGateway(in_network=own), _norm(), now=NOW, since=EPOCH,
        trust_policy=_PERMISSIVE,
    )
    with_popular = rank_feed(
        viewer, FakeGateway(in_network=own, popular=_popular()), _norm(), now=NOW,
        since=EPOCH, trust_policy=_PERMISSIVE,
    )

    assert len(without) == 40
    assert with_popular[:40] == without, "the viewer's own feed was reordered or displaced"
    assert not any(sc.post.author.startswith("pop") for sc in with_popular[:40]), (
        "padding was interleaved into the viewer's own posts"
    )
    assert len(with_popular) > 40, "the feed should extend rather than dead-end"


def test_topped_up_fallback_still_respects_mutes_suppression_and_nsfw() -> None:
    # Padding goes through filter_eligible exactly like the real pool, so a
    # muted / suppressed / NSFW author cannot re-enter a feed via the top-up.
    popular = [
        make_post("muted", "m1"),
        make_post("suppressed", "s1"),
        make_post("adult", "n1", is_nsfw=True),
        make_post("clean", "c1"),
    ]
    gateway = FakeGateway(
        in_network=[], popular=popular, suppressed=frozenset({"@suppressed/s1"})
    )
    viewer = make_viewer(
        "returning", follows=frozenset({"ghost"}), mutes=frozenset({"muted"})
    )

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    assert {sc.post.author for sc in feed} == {"clean"}


def test_starved_feed_stays_short_when_the_network_has_nothing_to_offer() -> None:
    # Honest degradation: the top-up never invents posts. An empty network
    # yields an empty feed rather than fabricated filler.
    gateway = FakeGateway(in_network=[], popular=[])
    viewer = make_viewer("returning", follows=frozenset({"ghost"}))
    assert rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE) == []


def test_established_viewer_subscribed_community_admits_clean_strangers_only() -> None:
    """A subscribed community admits a stranger — but only a CREDIBLE one.

    ★ DELIBERATE CHANGE OF THE §8.1 RULE (2026-08-01). This used to assert that a
    stranger posting into a community the viewer subscribed to was admitted ONLY
    after a followed account engaged it. That rule was written when the
    second-degree vouch gate was the only protection available, and measured end
    to end it did not gate the lane, it DELETED it: 90 candidates -> 0 eligible ->
    0 feed slots, and a new author posting into a community reached 0 of 40 of its
    subscribers. The gate asks "has someone I follow already engaged this", which
    is the predicate OON_ENGAGED selects on and which no new post can satisfy, so
    a subscription delivered nothing a viewer was not already getting.

    The PURPOSE of the rule — a stranger must not be able to self-inject into
    anyone's feed — is preserved by two protections that did not exist when it
    was written, and this test now asserts both:
      1. the author graph-cred floor, so self-dealers and ring members are
         refused (`requires_author_floor` stays True for OON_COMMUNITY);
      2. the per-author OON flooding cap, so nobody can flood a community feed.

    What is deliberately given up: an unknown but credible author can now reach a
    viewer who explicitly subscribed to their community. That is what subscribing
    means, and it is the only route by which a community can introduce anyone new.
    """
    stranger_post = make_post("stranger", "s1", community="hive-1")
    gateway = FakeGateway(community=[stranger_post])
    viewer = make_viewer(
        "me", follows=frozenset({"alice"}), subscribed_communities=frozenset({"hive-1"})
    )

    admitted = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
    assert {sc.post.key for sc in admitted} == {"@stranger/s1"}, (
        "subscribing to a community must actually deliver its posts"
    )

    # ...but a stranger caught self-dealing is still refused.
    snapshot = TrustSnapshot(
        graph_creds={"stranger": _cred(0.0)}, trusted_seeds=frozenset({"alice"})
    )
    gated = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        snapshot=snapshot, trust_policy=_PERMISSIVE,
    )
    assert gated == [], "a floored author must not ride a community subscription in"


def test_a_single_author_cannot_flood_a_subscribed_community_feed() -> None:
    """★ The second protection standing in for the removed vouch gate.

    Without this the community lane is an unbounded megaphone for one account:
    the flooding cap is what keeps "a stranger may reach you" from becoming "a
    stranger may BE your feed".
    """
    posts = [make_post("stranger", f"s{i}", community="hive-1") for i in range(30)]
    viewer = make_viewer(
        "me", follows=frozenset({"alice"}), subscribed_communities=frozenset({"hive-1"})
    )
    feed = rank_feed(
        viewer, FakeGateway(community=posts), _norm(), now=NOW, since=EPOCH,
        trust_policy=_PERMISSIVE,
    )
    assert len(feed) <= DEFAULT_SETTINGS.flooding.max_oon_posts_per_author, (
        f"one author placed {len(feed)} posts in a subscribed-community feed"
    )


def _cred(score: float, *, outside_engaged: bool | None = None) -> GraphCred:
    # H02: a hand-built cred is "vouched" only when it is outside-engaged. The
    # default mirrors real graph-cred output — an account whose score clears the
    # engaged/unknown boundary got there by receiving engagement, which for the
    # ordinary (non-laundered) case is outside-ring engagement — so a high-score
    # fixture stays vouched by intent and the ~5 existing vouched-voter pipeline
    # tests are unchanged. A ring-only / laundered fixture sets it False
    # explicitly to assert the unknown-tier semantics.
    if outside_engaged is None:
        outside_engaged = score > GraphCredConfig().min_vouched_score
    return GraphCred(
        account="_",
        score=score,
        follow_follower_ratio=1.0,
        outside_engaged=outside_engaged,
    )


def test_ring_exclusion_is_scoped_per_author_not_global() -> None:
    # THE global-ring defect: a flagged account's votes were stripped off EVERY
    # author's post. Ring self-dealing exists only between two flagged members
    # (the both-endpoints-flagged rule graph-cred already uses), so:
    snap = TrustSnapshot(ring_members=frozenset({"m1", "m2"}))
    # a flagged author's post excludes the ring co-members ...
    assert _ring_exclusion("m1", snap) == frozenset({"m1", "m2"})
    # ... but an UN-flagged author's post excludes nobody on ring grounds:
    # a ring member voting on an honest stranger's post is not self-dealing.
    assert _ring_exclusion("honest", snap) == frozenset()


def test_flagged_voter_counts_on_unflagged_authors_post() -> None:
    # End-to-end: "ringer" is ring-flagged. Its vote on unflagged "alice" must
    # now COUNT (per-author scoping); pre-fix the global set zeroed it, the sole
    # honest false-positive channel.
    alice_post = make_post(
        "alice", "a1", votes=[make_vote("ringer", 5_000_000_000)], created_min=0
    )
    gateway = FakeGateway(in_network=[alice_post])
    viewer = make_viewer("me", follows=frozenset({"alice"}))
    snap = TrustSnapshot(
        graph_creds={"ringer": _cred(0.6), "alice": _cred(0.5)},
        ring_members=frozenset({"ringer"}),
    )
    scored = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap)
    # ringer is vouched (score 0.6 > floor 0.1 AND outside_engaged — H02: the
    # _cred default treats a high-score fixture as outside-engaged) and is NOT
    # excluded from alice's post, so alice's vote signal is non-zero.
    assert scored[0].score.vote_norm > 0.0


def test_funded_alt_organic_does_not_scale_with_alt_count() -> None:
    # THE funded-alt fix, through the pipeline: a spam post voted+commented+
    # reblogged by N bare 0.5 HP alts (all unknown-band) scores the SAME organic
    # for N=3 and N=15 — the attacker gains nothing from more alts. Pre-fix the
    # organic grew linearly in N.
    def spam_and_snap(n: int) -> tuple[AttributedPost, TrustSnapshot]:
        alts = tuple(f"alt{i}" for i in range(n))
        post = AttributedPost(
            author="spammer", permlink="s1", category="hive", community=None,
            created=EPOCH, children=n, reblog_count=n, author_reputation=25.0,
            tags=("hive",), commenters=alts, rebloggers=alts,
            votes=tuple(make_vote(voter=a, rshares=500_000_000) for a in alts),
        )
        # alts are unknown (at the floor); a real vouched author exists so the
        # snapshot is non-empty and trust activates.
        creds = {a: _cred(0.10) for a in alts}
        creds["real"] = _cred(0.8)
        return post, TrustSnapshot(graph_creds=creds, ring_members=frozenset())

    p3, snap3 = spam_and_snap(3)
    p15, snap15 = spam_and_snap(15)
    g3 = FakeGateway(in_network=[p3])
    g15 = FakeGateway(in_network=[p15])
    v = make_viewer("me", follows=frozenset({"spammer"}))
    o3 = rank_feed(v, g3, _norm(), now=NOW, since=EPOCH, snapshot=snap3)[0].score.organic
    o15 = rank_feed(v, g15, _norm(), now=NOW, since=EPOCH, snapshot=snap15)[0].score.organic
    assert o3 == pytest.approx(o15)


def test_no_snapshot_disables_trust_weighting_bit_identically() -> None:
    # Every existing caller that ranks without a snapshot must be byte-identical:
    # no graph-cred -> we cannot tell an alt from a newcomer -> full breadth.
    post = make_post("a", "1", votes=[make_vote(f"v{i}", 1_000_000_000) for i in range(5)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    assert _voter_trust(TrustSnapshot(), DEFAULT_SETTINGS) is None
    default = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
    # Post-H01-fix, an empty-but-present TrustSnapshot() is treated like a missing
    # one, so the byte-identical degraded feed now requires the same explicit
    # WARN opt-in the no-snapshot leg above uses.
    empty_snap = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=TrustSnapshot(),
        trust_policy=_PERMISSIVE,
    )
    assert default == empty_snap


def test_require_attribution_setting_fails_loud_in_pipeline() -> None:
    # With production's require_attribution enabled, a plain Post reaching
    # scoring (a dropped-identity plumbing failure) raises instead of scoring a
    # silent zero. A non-empty snapshot is needed only to reach the scorer.
    plain = make_post("a", "1", children=50, votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[plain])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    strict = dataclasses.replace(
        DEFAULT_SETTINGS, vote_signal=VoteSignalConfig(require_attribution=True)
    )
    snap = TrustSnapshot(graph_creds={"a": _cred(0.5), "v": _cred(0.5)})
    with pytest.raises(AttributionMissingError):
        rank_feed(
            viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=strict, snapshot=snap
        )


def test_organic_signal_self_farmed_post_scores_like_unengaged_post() -> None:
    # q5b regression: a zero-vote post farmed to 60 self-comments + 20
    # self-reblogs must get the SAME organic signal as an identical-age post
    # with no engagement at all — unattributed counts cannot vouch for
    # themselves (recsys.core.vote_signal.independent_organic_engagement).
    viewer = make_viewer("me")
    farmed = make_post("spammer", "farm", children=60, reblog_count=20, created_min=0)
    empty = make_post("spammer", "none", children=0, reblog_count=0, created_min=0)
    now = EPOCH + timedelta(hours=2)
    excluded = frozenset({"spammer"})
    farmed_sig = _organic_signal(farmed, viewer, now, excluded, None, 0.0)
    empty_sig = _organic_signal(empty, viewer, now, excluded, None, 0.0)
    assert farmed_sig == empty_sig
    assert farmed_sig > 0.0  # still age-sensitive, not pinned to zero


# ---------------------------------------------------------------------------
# H02 — the vouched gate, end to end through build_trust_snapshot: a laundered
# reciprocal pair that ring.py scores 1.0 but which is below the self-dealing
# scale bar (the newcomer carve-out) is UNKNOWN-tier, not vouched, not blocked.
# ---------------------------------------------------------------------------


def _laundered_pairs(n_socks: int) -> tuple[list[EngagementEdge], dict[str, frozenset[str]]]:
    """``n_socks`` accounts in ``n_socks / 2`` two-op laundered reciprocal pairs:
    each pair mutually follows and exchanges exactly ONE upvote — the ordinary
    onboarding shape ring.py scores ``ring_score == 1.0`` yet which is NOT proven
    self-dealing at n=1 (the graph-cred newcomer carve-out). Detected as a ring
    (reciprocity 1.0, group size 2), kept OUT of the 0.0 band by the scale gate,
    and — because every one of its edges is intra-ring — accruing ZERO
    outside-ring received engagement."""
    edges: list[EngagementEdge] = []
    follows: dict[str, frozenset[str]] = {}
    for i in range(0, n_socks, 2):
        a, b = f"sock{i}", f"sock{i + 1}"
        edges.append(EngagementEdge(src=a, dst=b, upvotes=1))
        edges.append(EngagementEdge(src=b, dst=a, upvotes=1))
        follows[a] = frozenset({b})
        follows[b] = frozenset({a})
    return edges, follows


def test_h02_laundered_reciprocal_pairs_stay_unknown_and_spam_breadth_is_flat() -> None:
    # THE H02 PoC, closed. 40 socks in 20 two-op reciprocal pairs. Pre-fix each
    # pair landed in the ENGAGED band (score > floor) and _voter_trust marked
    # every sock vouched -> FULL un-budgeted breadth (the laundering door: 2/10/40
    # socks all vouched, breadth = M, spam reaches feed #1). The vouched gate now
    # keys on outside-ring received engagement, which a pair that only ever
    # engages ITSELF has none of.
    edges, follows = _laundered_pairs(40)
    gw_trust = FakeGateway(edges=edges, follow_graph=follows)
    snap = build_trust_snapshot(gw_trust, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH)

    socks = [f"sock{i}" for i in range(40)]
    floor = DEFAULT_SETTINGS.graph_cred.min_vouched_score
    # Every laundered sock IS in the snapshot and in the engaged band -> NOT
    # zeroed, NOT blocked (still clears every eligibility floor) ...
    assert all(snap.graph_creds[s].score > floor for s in socks)
    # ... but NONE received engagement from outside its own pair -> NONE vouched.
    assert all(snap.graph_creds[s].outside_engaged is False for s in socks)
    trust = _voter_trust(snap, DEFAULT_SETTINGS)
    assert trust is not None
    assert trust.vouched == frozenset()

    # Reachable impact: a spam post voted only by these unknown socks earns FLAT
    # organic breadth in sock count (the unknown_free budget, never M) — mirrors
    # test_funded_alt_organic_does_not_scale_with_alt_count, but the unknown-tier
    # verdict here is PRODUCED by build_trust_snapshot, not hand-asserted.
    v = make_viewer("me", follows=frozenset({"spammer"}))

    def spam_organic(k: int) -> float:
        post = make_post(
            "spammer", f"s{k}", created_min=0,
            votes=[make_vote(socks[i], 500_000_000) for i in range(k)],
        )
        gw = FakeGateway(in_network=[post])
        feed = rank_feed(v, gw, _norm(), now=NOW, since=EPOCH, snapshot=snap)
        return feed[0].score.organic

    assert spam_organic(2) == pytest.approx(spam_organic(10))
    assert spam_organic(10) == pytest.approx(spam_organic(40))


def test_h02_genuine_newcomer_pair_is_unknown_but_not_blocked_and_flips_on_outside() -> None:
    # THE NEWCOMER INVARIANT under the H02 gate. A genuine two-new-accounts-
    # mutual-once pair is ring-flagged but below the scale bar, so it is NOT
    # zeroed: engaged band, score above BOTH eligibility floors -> never blocked.
    # It is only UNKNOWN-tier (outside_engaged False -> not vouched), so its first
    # vote still credits via unknown_free -- not zeroed, not vouched.
    edges = [
        EngagementEdge(src="newa", dst="newb", upvotes=1),
        EngagementEdge(src="newb", dst="newa", upvotes=1),
    ]
    follows = {"newa": frozenset({"newb"}), "newb": frozenset({"newa"})}
    snap = build_trust_snapshot(
        FakeGateway(edges=edges, follow_graph=follows), DEFAULT_SETTINGS, since=EPOCH, now=EPOCH
    )
    th = DEFAULT_SETTINGS.thresholds
    for who in ("newa", "newb"):
        gc = snap.graph_creds[who]
        assert gc.score >= th.graph_cred_floor         # not blocked (author floor)
        assert gc.score >= th.vouch_graph_cred_floor   # can still vouch by count
        assert gc.outside_engaged is False             # but unknown-tier, not vouched
    trust = _voter_trust(snap, DEFAULT_SETTINGS)
    assert trust is not None and trust.vouched == frozenset()

    # The instant newa receives ONE genuine OUTSIDE upvote (peer is not in the
    # pair, forms no reciprocal edge -> not ring-flagged), newa flips to vouched
    # -- the newcomer earns real breadth by being engaged from outside.
    edges2 = [*edges, EngagementEdge(src="peer", dst="newa", upvotes=1)]
    follows2 = {**follows, "peer": frozenset({"newa"})}
    snap2 = build_trust_snapshot(
        FakeGateway(edges=edges2, follow_graph=follows2), DEFAULT_SETTINGS, since=EPOCH, now=EPOCH
    )
    assert snap2.graph_creds["newa"].outside_engaged is True
    trust2 = _voter_trust(snap2, DEFAULT_SETTINGS)
    assert trust2 is not None and "newa" in trust2.vouched
    # newb, engaged only by its own pair, is still unknown.
    assert snap2.graph_creds["newb"].outside_engaged is False


# ---------------------------------------------------------------------------
# H01 — no-snapshot must never SILENTLY revert every defense: fail closed in
# production, loud (metric + log) offline. Never a hard default-raise.
# ---------------------------------------------------------------------------


def test_h01_no_snapshot_fails_closed_under_production_policy() -> None:
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    # FAIL_CLOSED refuses rather than silently drop the breadth budget, ring
    # exclusion, graph-cred floor and CF all at once.
    with pytest.raises(MissingTrustError):
        rank_feed(
            viewer, gateway, _norm(), now=NOW, since=EPOCH,
            trust_policy=TrustPolicy.FAIL_CLOSED,
        )


def test_h01_degraded_snapshot_also_fails_closed() -> None:
    # A snapshot the §H11 anomaly gate flagged ``degraded`` is treated exactly
    # like a missing one under FAIL_CLOSED — its CF (and any anomalous trust) is
    # not fresh, so serving it silently would be the same fail-open.
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    degraded = TrustSnapshot(graph_creds={"a": _cred(0.5)}, degraded=True)
    with pytest.raises(MissingTrustError):
        rank_feed(
            viewer, gateway, _norm(), now=NOW, since=EPOCH,
            snapshot=degraded, trust_policy=TrustPolicy.FAIL_CLOSED,
        )


# ---------------------------------------------------------------------------
# H07/C1 (2026-07-22): the gate-exempt INTEREST_* interest lane applies NO
# graph-cred floor at all. is_cold() routes a viewer there both for a TRUE
# cold start (no follows, no history) and for an established-but-followless
# viewer (unfollowed everyone / never followed anyone, but has a trained ALS
# row) -- and only the second state is a poisoning surface, since a real cold
# newcomer has no ALS row and so no CF slice at all (viewer_affinity_
# percentiles already returns None for them).
# ---------------------------------------------------------------------------


def test_h07_followless_established_viewer_gets_no_cf_lift_in_interest_lane() -> None:
    # "me" directly, heavily engages "liked" -- a real (not synthetically
    # poisoned) high CF affinity, standing in for the poisoned-row shape H07
    # closes. "me" has NO follows at all, so is_cold() routes them through the
    # interest lane for the FOLLOWLESS reason, and that lane's ONLY gate is
    # graph-cred/CF, since it never runs the second-degree gate. With
    # organic_cf_oon_scale cranked to 1.0 (CF fully active for gate-exempt
    # sources, the live-data-gated ceiling this config may one day reach) an
    # un-suppressed pipeline would let this affinity lift "liked" above a
    # request with no CF slice at all. It must not: the followless-established
    # gate forces cf_percentile=None for interest-lane candidates.
    als = train_als(_cf_edges(), ALSConfig())
    assert "me" in als.user_index  # established: has a trained row
    assert als.affinity("me", "liked") > als.affinity("me", "other")

    liked_post = make_post("liked", "ic1", community="hive-1")
    gateway = FakeGateway(community=[liked_post])
    viewer = make_viewer("me", follows=frozenset(), interest_communities=frozenset({"hive-1"}))
    cf_on = dataclasses.replace(
        DEFAULT_SETTINGS,
        weights=dataclasses.replace(DEFAULT_SETTINGS.weights, organic_cf_oon_scale=1.0),
    )

    gated = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        # als-only snapshot (no graph_creds) is not "fresh" post-H01-fix; H07 CF
        # suppression reads snap.als directly, so WARN exercises it faithfully.
        snapshot=TrustSnapshot(als=als), settings=cf_on, trust_policy=_PERMISSIVE,
    )
    no_cf_at_all = rank_feed(
        # no snapshot -> permissive opt-in (R2 default is now FAIL_CLOSED); this
        # H07 assertion needs a SERVED feed with no CF slice, not a refusal.
        viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=cf_on,
        trust_policy=_PERMISSIVE,
    )

    assert [sc.post.author for sc in gated] == ["liked"]
    # CF contributes NOTHING to this viewer's interest-lane candidate: their
    # organic score is byte-identical whether or not the trust snapshot even
    # carries a trained model.
    assert gated[0].score.organic == pytest.approx(no_cf_at_all[0].score.organic)


def test_h07_true_cold_newcomer_still_served_ungated_interest_lane() -> None:
    # The other half of the fix: a viewer with NO trained ALS row at all (the
    # genuine cold-start case) must be completely unaffected by the new
    # followless-established gate -- still served BOTH interest-lane posts,
    # fully exempt from the graph-cred floor, even with a trust snapshot
    # present (carrying a model that simply never saw this account) and
    # organic_cf_oon_scale cranked all the way up.
    als = train_als(_cf_edges(), ALSConfig())  # "newbie" never appears in these edges
    assert "newbie" not in als.user_index

    community_post = make_post("author1", "c1", community="hive-1")
    tag_post = make_post("author2", "t1", tags=("art",))
    gateway = FakeGateway(community=[community_post], tag=[tag_post])
    viewer = make_viewer(
        "newbie",
        is_new=True,
        interest_communities=frozenset({"hive-1"}),
        interest_tags=frozenset({"art"}),
    )
    cf_on = dataclasses.replace(
        DEFAULT_SETTINGS,
        weights=dataclasses.replace(DEFAULT_SETTINGS.weights, organic_cf_oon_scale=1.0),
    )

    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        # als-only snapshot (no graph_creds) -> WARN opt-in post-H01-fix; a true
        # cold newbie has no ALS row anyway, so CF is None for them regardless.
        snapshot=TrustSnapshot(als=als), settings=cf_on, trust_policy=_PERMISSIVE,
    )

    assert {sc.post.author for sc in feed} == {"author1", "author2"}


def test_h01_warn_policy_is_loud_not_silent_when_opted_into(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # WARN is no longer the default (R2 flipped it to FAIL_CLOSED) — it is the
    # EXPLICIT permissive opt-in the offline harness + non-trust unit tests use.
    # When requested by name it is LOUD, never silent: a WARNING log AND a metric
    # increment fire, and only then is the degraded feed served, byte-for-byte as
    # before. This is the "harness opt-in still gets permissive" guarantee.
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    before = TRUST_DEGRADATION.count
    with caplog.at_level(logging.WARNING, logger="recsys.pipeline"):
        feed = rank_feed(
            viewer, gateway, _norm(), now=NOW, since=EPOCH,
            trust_policy=TrustPolicy.WARN,  # explicit permissive opt-in
        )
    assert TRUST_DEGRADATION.count == before + 1        # metric fired
    assert "degraded to fail-open" in caplog.text       # log fired
    assert [sc.post.key for sc in feed] == ["@a/1"]     # feed still served


def test_h01_default_policy_is_fail_closed() -> None:
    # THE R2 fix. No snapshot AND no trust_policy argument -> the DEFAULT applies,
    # and the default is now FAIL_CLOSED: rank_feed REFUSES rather than serve the
    # farmable feed. Before the flip this identical call silently served a
    # full-breadth fail-open feed, so a production caller who forgot to wire the
    # weekly TrustSnapshot got the exploitable behaviour by omission. "Do nothing"
    # must now yield the SAFE path, not the farmable one.
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    with pytest.raises(MissingTrustError):
        rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH)  # no policy -> default


def test_h01_empty_but_present_snapshot_also_fails_closed() -> None:
    # THE H01 RESIDUAL (Opus council 2026-07-22). The documented Phase-0 default
    # TrustSnapshot() has graph_creds={} and degraded=False, so the old freshness
    # test ("present and not degraded") passed it as fresh and _voter_trust then
    # returned None on the empty map -> breadth budget + graph-cred floor SILENTLY
    # off: the exact fail-open H01 claims to have eliminated, hiding at the gate's
    # own default value. It must fail closed exactly like a missing snapshot.
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    with pytest.raises(MissingTrustError):
        # empty-but-present snapshot, no policy -> default FAIL_CLOSED
        rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=TrustSnapshot())
    # A snapshot that carries even one scored account IS fresh and ranks normally.
    fresh = TrustSnapshot(graph_creds={"a": _cred(0.5), "v": _cred(0.5)})
    assert rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=fresh)


# ---------------------------------------------------------------------------
# R1 — §H11 between-batch ALS anomaly gate, WIRED into build_trust_snapshot.
# A poisoned week's freshly-trained CF model is caught by comparing it to last
# week's; on a swing beyond settings.als.max_batch_drift the model is disabled
# (als=None) and the snapshot marked degraded (which H01 then fails closed on),
# instead of being frozen live for the whole following week.
# ---------------------------------------------------------------------------


def _h11_honest_edges() -> tuple[list[EngagementEdge], dict[str, frozenset[str]]]:
    """A stable cohort engaging two authors, with cross-engagement so the cohort
    accounts are outside-engaged (vouched) and graph-cred is meaningful — the
    baseline both the poisoned and the honest-growth week extend."""
    edges = [
        EngagementEdge(src="cohort1", dst="author_a", upvotes=20),
        EngagementEdge(src="cohort2", dst="author_a", upvotes=18),
        EngagementEdge(src="cohort3", dst="author_a", upvotes=22),
        EngagementEdge(src="cohort1", dst="author_b", upvotes=15),
        EngagementEdge(src="cohort2", dst="author_b", upvotes=17),
        EngagementEdge(src="cohort3", dst="author_b", upvotes=13),
        EngagementEdge(src="author_a", dst="cohort1", upvotes=5),
        EngagementEdge(src="author_b", dst="cohort2", upvotes=6),
        EngagementEdge(src="cohort2", dst="cohort1", upvotes=4),
        EngagementEdge(src="cohort3", dst="cohort2", upvotes=4),
    ]
    follows = {
        "cohort1": frozenset({"author_a", "author_b"}),
        "cohort2": frozenset({"author_a", "author_b"}),
        "cohort3": frozenset({"author_a", "author_b"}),
        "author_a": frozenset({"cohort1"}),
        "author_b": frozenset({"cohort2"}),
    }
    return edges, follows


def _h11_low_drift_settings() -> Settings:
    # A threshold BETWEEN ordinary week-over-week churn (~0.019 through the full
    # pipeline) and a poisoning campaign (~0.22): a deterministic catch-vs-pass
    # boundary, deliberately decoupled from the conservative production default
    # (0.5) so the wiring is what is tested, not the tuned magnitude.
    return dataclasses.replace(
        DEFAULT_SETTINGS, als=dataclasses.replace(DEFAULT_SETTINGS.als, max_batch_drift=0.10)
    )


def _h11_snap(
    edges: list[EngagementEdge],
    follows: dict[str, frozenset[str]],
    settings: Settings,
    *,
    previous: TrustSnapshot | None = None,
) -> TrustSnapshot:
    gw = FakeGateway(edges=edges, follow_graph=follows)
    return build_trust_snapshot(gw, settings, since=EPOCH, now=EPOCH, previous=previous)


def test_h11_poisoned_batch_degrades_snapshot_and_disables_cf() -> None:
    settings = _h11_low_drift_settings()
    honest_edges, follows = _h11_honest_edges()

    # Last week: an honest, stable batch. Trained normally, not degraded.
    week1 = _h11_snap(honest_edges, follows, settings)
    assert week1.degraded is False
    assert week1.als is not None and week1.als.user_index  # a real trained model

    # This week: a heavy one-directional sock->author co-engagement campaign
    # (C1/C2 shape: no reciprocal edge -> slips ring; funded by transfer ->
    # slips lineage) layered on the SAME shared grid, so the drift is measured
    # on directly-comparable (cohort, author) pairs.
    poison = [
        *honest_edges,
        *[EngagementEdge(src=f"sock{i}", dst="author_a", upvotes=200, reblogs=50)
          for i in range(30)],
        *[EngagementEdge(src=f"sock{i}", dst="author_b", upvotes=200, reblogs=50)
          for i in range(30)],
    ]
    week2 = _h11_snap(poison, follows, settings, previous=week1)

    # The gate fired: CF disabled for the week and the snapshot marked degraded,
    # rather than freezing the poisoned model live.
    assert week2.degraded is True
    assert week2.als is None
    # Graph-cred/ring outputs are still produced — only CF is withheld.
    assert week2.graph_creds

    # End to end: the degraded snapshot fails CLOSED under the R2 default, so the
    # poisoned week is refused rather than served — H11 degrade -> H01 refuse.
    v = make_viewer("me", follows=frozenset({"author_a"}))
    gw = FakeGateway(in_network=[make_post("author_a", "p1")])
    with pytest.raises(MissingTrustError):
        rank_feed(v, gw, _norm(), now=NOW, since=EPOCH, snapshot=week2)


def test_h11_normal_week_is_not_degraded() -> None:
    settings = _h11_low_drift_settings()
    honest_edges, follows = _h11_honest_edges()
    week1 = _h11_snap(honest_edges, follows, settings)

    # Ordinary organic growth: a couple of new genuine votes, same shape. The
    # week-over-week drift stays well under the threshold, so CF is kept live.
    growth = [
        *honest_edges,
        EngagementEdge(src="cohort1", dst="author_a", upvotes=3),
        EngagementEdge(src="cohort4", dst="author_b", upvotes=6),
    ]
    growth_follows = {**follows, "cohort4": frozenset({"author_b"})}
    week2 = _h11_snap(growth, growth_follows, settings, previous=week1)

    assert week2.degraded is False
    assert week2.als is not None and week2.als.user_index


def test_h11_first_batch_or_no_prior_model_never_degrades() -> None:
    # No comparable prior is not an anomaly (the same posture als_batch_drift
    # takes for no shared users/authors): a first-ever batch and a prior whose
    # own model is None both skip the gate, even on the poisoned edges.
    settings = _h11_low_drift_settings()
    honest_edges, follows = _h11_honest_edges()
    poison = [
        *honest_edges,
        *[EngagementEdge(src=f"sock{i}", dst="author_a", upvotes=200, reblogs=50)
          for i in range(30)],
    ]

    # previous=None -> first-ever batch, nothing to compare.
    first = _h11_snap(poison, follows, settings, previous=None)
    assert first.degraded is False and first.als is not None

    # previous carries no model (cold start / itself a degraded week) -> skip.
    against_modelless = _h11_snap(
        poison, follows, settings, previous=TrustSnapshot()
    )
    assert against_modelless.degraded is False and against_modelless.als is not None


def test_h11_drift_gate_fires_metric_and_log(caplog: pytest.LogCaptureFixture) -> None:
    settings = _h11_low_drift_settings()
    honest_edges, follows = _h11_honest_edges()
    week1 = _h11_snap(honest_edges, follows, settings)
    poison = [
        *honest_edges,
        *[EngagementEdge(src=f"sock{i}", dst="author_a", upvotes=200, reblogs=50)
          for i in range(30)],
        *[EngagementEdge(src=f"sock{i}", dst="author_b", upvotes=200, reblogs=50)
          for i in range(30)],
    ]
    before = ALS_DRIFT_REJECTIONS.count
    with caplog.at_level(logging.WARNING, logger="recsys.pipeline"):
        week2 = _h11_snap(poison, follows, settings, previous=week1)
    assert week2.degraded is True
    assert ALS_DRIFT_REJECTIONS.count == before + 1          # metric fired
    assert "drift" in caplog.text and "§H11" in caplog.text  # log fired


def test_h11_default_threshold_is_conservative_backstop() -> None:
    # The measured poison drift (~0.22) is REAL but sits BELOW the conservative
    # production default (0.5): under DEFAULT_SETTINGS this same campaign does
    # NOT degrade the snapshot. That is intentional — H11 is a defense-in-depth
    # backstop that fires only on gross instability, because a false positive
    # takes the feed offline (fail-closed); the C1/C2 in-training breadth budget
    # is the front-line defense (this poison is already budget-capped at train
    # time). Documents the calibration; re-tune max_batch_drift on live data.
    honest_edges, follows = _h11_honest_edges()
    week1 = _h11_snap(honest_edges, follows, DEFAULT_SETTINGS)
    poison = [
        *honest_edges,
        *[EngagementEdge(src=f"sock{i}", dst="author_a", upvotes=200, reblogs=50)
          for i in range(30)],
        *[EngagementEdge(src=f"sock{i}", dst="author_b", upvotes=200, reblogs=50)
          for i in range(30)],
    ]
    week2 = _h11_snap(poison, follows, DEFAULT_SETTINGS, previous=week1)
    assert week2.degraded is False          # 0.22 < default 0.5 -> not tripped
    assert week2.als is not None
