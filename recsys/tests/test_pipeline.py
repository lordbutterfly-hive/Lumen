"""End-to-end pipeline integration tests (§3) against the in-memory gateway."""

from __future__ import annotations

import dataclasses
import hashlib
import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta

import pytest

import recsys.pipeline as pipeline_mod
from recsys.config import (
    DEFAULT_SETTINGS,
    MIN_TRUSTED_SEEDS,
    ALSConfig,
    ExplorationConfig,
    GraphCredConfig,
    PopularConfig,
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
from recsys.core.exploration import eligible_for_exploration
from recsys.core.normalize import build_norm_context
from recsys.core.scoring import AuthorEngagement, post_base_engagement
from recsys.core.vote_signal import AttributedPost, AttributionMissingError, VoterTrust
from recsys.pipeline import (
    ALS_DRIFT_REJECTIONS,
    TRUST_DEGRADATION,
    MissingTrustError,
    TrustPolicy,
    TrustSnapshot,
    _lineage_for,
    _organic_signal,
    _ring_exclusion,
    _voter_trust,
    build_trust_snapshot,
    gather_candidates,
    rank_feed,
)
from recsys.viewer import build_viewer_profile
from tests.fakes import EPOCH, FakeGateway, make_post, make_viewer, make_vote, seeds_that_land

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

# ★★★ 2026-08-08 — SCOPING THE FALLBACK TESTS TO THE FALLBACK.
#
# The across-Hive popularity lane (`PopularConfig`, `CandidateSource.
# OON_POPULAR`) sources chain-wide top posts for EVERY viewer on EVERY request.
# `FakeGateway(popular=...)` therefore now feeds two different mechanisms from
# one fixture list, and the consequence is real rather than cosmetic: a starved
# or tagless viewer's pool is no longer starved, so `_fallback_filler` does not
# fire, and a healthy viewer's page now has genuine competition from the lane.
#
# The tests below are about the FALLBACK — "never an empty feed", "padding never
# interleaves into the viewer's own posts", "served length is monotonic in the
# follow graph". Every one of those invariants still holds and is still worth
# pinning, so they are scoped to the mechanism they name instead of being
# loosened to accommodate a different one. The lane's own behaviour — including
# the fact that it DOES displace, which is the feature — is pinned separately in
# `test_the_popularity_lane_*` below.
_NO_POPULAR_LANE = Settings(popular=PopularConfig(limit=0))
# ★ The across-Hive lane SHIPS OFF (`PopularConfig.limit = 0` — see that
# field for the two measurements that decided it), so every test OF the lane
# must enable it explicitly. A test that relied on the default would silently
# stop testing the lane the moment the default moved, which is how a feature
# becomes untested without anyone deleting a test.
_POPULAR_LANE_ON = Settings(popular=PopularConfig(limit=25))


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
    # interest lane (rev 2.2, tags-only since communities were retired as a
    # lane 2026-08-04, R1/R3) — that source bypasses the gate.
    tag_post = make_post("author2", "t1", tags=("art",))
    gateway = FakeGateway(tag=[tag_post])
    viewer = make_viewer(
        "newbie",
        is_new=True,
        interest_tags=frozenset({"art"}),
    )

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    assert {sc.post.author for sc in feed} == {"author2"}


def test_tagless_viewer_falls_through_to_popular_fallback_with_a_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """★ R12 (2026-08-04): removing communities left `interest_candidates` /
    `established_interest_candidates` with no way to source anything for a
    viewer who declared no `interest_tags` — before, they could still be
    reached via a subscribed/interest community. This must never crash and
    never serve an empty feed: it falls through to the popular lane
    (`_fallback_filler`) and logs loudly, so the state is visible to an
    operator rather than a silently degraded feed. Covers both halves of R12
    part 3 in one call: a followless AND tagless viewer, the strictest case.
    """
    popular = [make_post(f"pop{i}", f"p{i}") for i in range(30)]
    gateway = FakeGateway(popular=popular)
    viewer = make_viewer("blank")  # no follows, no interest_tags: the R12 case

    with caplog.at_level(logging.WARNING, logger="recsys.pipeline"):
        feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH,
                     trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE)

    assert feed, "a tagless viewer must never be served an empty feed"
    assert all(sc.source is CandidateSource.POPULAR_FALLBACK for sc in feed)
    assert "no interest_tags" in caplog.text


def test_a_declared_interest_tag_silences_the_tagless_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The control: a viewer who DID declare a tag must not trip R12's warning,
    even when it happens to source nothing (e.g. an empty gateway) — the log is
    about the viewer's own declaration, not about realised supply."""
    gateway = FakeGateway()
    viewer = make_viewer("has-tags", interest_tags=frozenset({"art"}))

    with caplog.at_level(logging.WARNING, logger="recsys.pipeline"):
        candidates = gather_candidates(viewer, gateway, EPOCH, 400, DEFAULT_SETTINGS)

    assert candidates == []
    assert "no interest_tags" not in caplog.text


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


def test_gather_dedups_in_network_over_interest_tag() -> None:
    shared = make_post("alice", "a1", tags=("art",))
    gateway = FakeGateway(in_network=[shared], tag=[shared])
    viewer = make_viewer(
        "me", follows=frozenset({"alice"}), interest_tags=frozenset({"art"})
    )

    candidates = gather_candidates(viewer, gateway, EPOCH, 400, DEFAULT_SETTINGS)

    assert len(candidates) == 1
    assert candidates[0].source is CandidateSource.IN_NETWORK


def test_interest_lane_not_appended_for_followed_viewer_claiming_new() -> None:
    # F-R5 #3: the gate-exempt interest lane is routed on the UNSPOOFABLE
    # `not viewer.follows`, never the client-set `is_new` flag. A viewer WITH
    # follows must NOT be able to force the exempt lane onto their feed by
    # claiming is_new=True (the spoofable-flag shape hardened elsewhere).
    interest_sources = {CandidateSource.INTEREST_TAG}
    tag_post = make_post("author2", "t1", tags=("art",))
    in_net = make_post("alice", "a1")
    gateway = FakeGateway(in_network=[in_net], tag=[tag_post])

    followed_new = make_viewer(
        "me",
        follows=frozenset({"alice"}),
        is_new=True,  # spoofable client flag — must NOT open the interest lane
        interest_tags=frozenset({"art"}),
    )
    followed_cands = gather_candidates(followed_new, gateway, EPOCH, 400, DEFAULT_SETTINGS)
    assert interest_sources.isdisjoint({c.source for c in followed_cands})

    # Control: a genuinely followless viewer still gets the lane (is_new=False).
    followless = make_viewer(
        "newbie",
        is_new=False,
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
    # applies to own_base. Since B2 (2026-08-05) that set is self + per-author
    # ring; STAKE LINEAGE WAS REMOVED because Hive delegation needs no consent
    # from the delegatee, so a stranger could edit any author's exclusion set
    # (see `pipeline._lineage_for`). The alt-farm case lineage used to cover is
    # now carried by the unknown-tier breadth budget — pinned by
    # `test_alt_farm_is_defeated_by_the_breadth_budget_not_by_lineage` below.
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

    assert gateway.last_excluded == {"farm": frozenset({"ringmate", "farm"})}
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


def test_lineage_is_gone_from_the_prior_exclusion_set_and_H05_still_guards_it() -> None:
    """★ THE B2 SAFETY PROOF (2026-08-05), stated at the level the evidence
    actually supports.

    Stake lineage used to do two opposite things in the author prior: it caught
    an author farming their own pooled prior with alts, AND it was the vector
    that let a stranger poison any author (33 dust delegations -> organic
    percentile 0.79 -> 0.07). B2 removes it, so the question that had to be
    answered before removing was: does the alt-farm case lose its defence?

    It does not. `scoring.py` states `total_base` carries TWO guards, and the
    second is independent of lineage: "since H05, the same graph-cred breadth
    BUDGET (VoterTrust) applied per window post before summing — so neither
    lineage/ring farming NOR UN-BUDGETED SOCK BREADTH can inflate the pool."
    The budget exists precisely because the exclusion set alone was insufficient
    (`test_hafsql.py`: "H05: exclusion alone leaves BREADTH un-budgeted —
    unknown-tier socks"). Six unvouched alts buy `unknown_free` breadth between
    them, not six.

    ★ WHAT THIS TEST DOES NOT DO, deliberately. An earlier draft asserted the
    served ORDER on `_HonoringPriorGateway`, and it failed — because that stub
    models the §8.4 exclusion guard and NOT the H05 budget, so it cannot express
    the defence that now carries the case. Asserting order there would have
    reported a production hole that does not exist. The behavioural proof of the
    budget lives where the budget lives: `test_hafsql.py` (query level) and
    `test_author_prior_cache.py::...passes_voter_trust...`. What is pinned HERE
    is the seam B2 actually changed: lineage is out of the exclusion set, and
    the H05 trust guard is still threaded to the prior.
    """
    post = make_post("farm", "p1", votes=[make_vote("h1", 50_000_000)])
    priors = {"farm": AuthorEngagement(posts=2, total_base=0.6)}
    gateway = _PriorGateway(priors, in_network=[post], lineage={"farm": frozenset({"alt1"})})
    viewer = make_viewer("me", follows=frozenset({"farm"}))
    snap = TrustSnapshot(
        graph_creds={"h1": GraphCred(account="h1", score=0.5, follow_follower_ratio=1.0)},
        ring_members=frozenset({"farm", "ringmate"}),
        trusted_seeds=frozenset({"h1"}),
        built_at=NOW,
    )

    rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap,
              trust_policy=_PERMISSIVE)

    # The gateway still OFFERS a lineage map; the pipeline no longer asks for it.
    assert gateway.last_excluded == {"farm": frozenset({"ringmate", "farm"})}
    assert "alt1" not in gateway.last_excluded["farm"]
    # ...and the guard that replaced it is live for this request.
    assert gateway.last_trust is not None, (
        "the H05 breadth budget is NOT reaching the pooled prior — with lineage "
        "removed it is the only remaining defence against alt-farmed priors, so "
        "this failing means B2 DID cost a real protection"
    )


def test_pooled_prior_sock_swarm_is_breadth_budgeted_not_farmed() -> None:
    # H05: self/lineage/ring exclusion (the test above) does nothing about
    # BREADTH. A swarm of unknown-tier socks -- not the author, not lineage,
    # not a reciprocal ring, so they pass every §8.4 exclusion untouched --
    # farming an author's OTHER window posts must be capped at the SAME
    # VoterTrust budget own_base already applies, not counted one-for-one.
    # ★ 2026-08-08: vote amounts raised above `_ORGANIC_VOTER_MIN_RSHARES`
    # (3.184e9). At the old 5e7 every voter here — honest AND sock — mints
    # zero organic breadth, so this stops being a test of the pooled prior
    # and becomes a test of the floor.
    own_votes = [make_vote("h1", 7_000_000_000), make_vote("h2", 7_000_000_000)]
    farm_p0 = make_post("farm", "p0", votes=own_votes)
    honest_q0 = make_post("honest", "q0", votes=own_votes)

    # farm's other 4 window posts: 20 distinct UNKNOWN-tier sock voters each.
    # None are lineage-tied or ring-flagged -- pre-H05 exclusion alone lets
    # every one of them count in full.
    sock_votes = [make_vote(f"sock{i}", 7_000_000_000) for i in range(20)]
    farm_others = [make_post("farm", f"p{i}", votes=sock_votes) for i in range(1, 5)]
    # honest's other 4 posts: 2 genuinely VOUCHED voters each -- modest, real.
    honest_votes = [make_vote("h3", 7_000_000_000), make_vote("h4", 7_000_000_000)]
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
    # ★ 2026-08-08: vote amounts raised above `_ORGANIC_VOTER_MIN_RSHARES`
    # (3.184e9). At the old 5e7 every voter here — honest AND sock — mints
    # zero organic breadth, so this stops being a test of the pooled prior
    # and becomes a test of the floor.
    votes = [make_vote("v1", 7_000_000_000), make_vote("v2", 7_000_000_000)]
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
    # production=False (C5/R2, 2026-08-04): this synthetic 2-account world has
    # no account named from the real curated seed list, so production=True
    # (now the default) would refuse under F-R2 — explicit opt-out per the
    # fixture-migration ruling, not an invented seed.
    snap = build_trust_snapshot(
        gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH, production=False
    )
    assert {"a", "b"} <= set(snap.graph_creds)
    assert isinstance(snap.ring_members, frozenset)


def test_build_trust_snapshot_refuses_empty_seeds_in_production() -> None:
    # F-R2: in production an empty trusted_seeds set makes TrustRank's seed
    # teleport mass revert to uniform, letting a Sybil clique mint free rank
    # with nothing raising. The production guard refuses it, mirroring the
    # fail-closed posture rank_feed already takes for a missing snapshot.
    #
    # ★ C5/R2 (2026-08-04): `production` now DEFAULTS to True, and an omitted
    # `trusted_seeds` now defaults to `settings.trusted_seeds` (the real,
    # non-empty curated list) rather than empty — see `build_trust_snapshot`'s
    # docstring. So the "empty seeds" case below is exercised with
    # `trusted_seeds=frozenset()` EXPLICITLY, and the "offline" case with
    # `production=False` EXPLICITLY; neither is reachable by omission anymore,
    # which is the entire point of the ruling ("a wiring requirement every
    # caller must remember is the defect, not the fix").
    edges = [
        EngagementEdge(src="a", dst="b", upvotes=5),
        EngagementEdge(src="b", dst="a", upvotes=5),
    ]
    gateway = FakeGateway(
        edges=edges, follow_graph={"a": frozenset({"b"}), "b": frozenset({"a"})}
    )
    with pytest.raises(ValueError, match="trusted_seeds"):
        build_trust_snapshot(
            gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
            trusted_seeds=frozenset(), production=True,
        )
    # A non-empty but entirely UNLANDED seed set (the real curated list,
    # against this synthetic 2-account world) refuses too — F-R2 EXTENDED,
    # and now the reachable-by-omission case: a caller that supplies
    # `settings` and forgets `trusted_seeds` gets this path, not a silent
    # empty-seeds revert.
    with pytest.raises(ValueError, match="trusted_seeds"):
        build_trust_snapshot(gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH)
    # A seed set that LANDS but is shorter than `MIN_TRUSTED_SEEDS` is refused
    # too (C4, 2026-08-05). Concentrating the whole seed teleport mass on one
    # account is strictly worse than the empty case this guard was written for,
    # because it looks configured.
    with pytest.raises(ValueError, match="minimum"):
        build_trust_snapshot(
            gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
            trusted_seeds=frozenset({"a"}), production=True,
        )
    # ★★ 2026-08-05 POST-CLOSEOUT COUNCIL (Seat 2). THIS BLOCK PREVIOUSLY
    # ASSERTED THE BUG. It supplied 26 seeds of which exactly ONE ("a") existed
    # in the world, and asserted that production SUCCEEDS — i.e. it pinned, as
    # correct, a production snapshot whose entire PageRank teleport mass sat on
    # one account. That is the same defect C4 closed for the CONFIGURED list,
    # surviving untouched on the LANDED set 78 lines below it.
    #
    # The contract now: enough seeds must LAND, not merely be configured.
    unlanded = frozenset({"a"}) | {f"never-in-this-world-{i:02d}" for i in range(MIN_TRUSTED_SEEDS)}
    with pytest.raises(ValueError, match="engagement edges in the trust window"):
        build_trust_snapshot(
            gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
            trusted_seeds=unlanded, production=True,
        )
    # ...and with a seed set that genuinely lands, production succeeds.
    seeds, seed_edges = seeds_that_land("a")
    landed_gateway = FakeGateway(
        edges=edges + seed_edges,
        follow_graph={"a": frozenset({"b"}), "b": frozenset({"a"})},
    )
    snap = build_trust_snapshot(
        landed_gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
        trusted_seeds=seeds, production=True,
    )
    assert {"a", "b"} <= set(snap.graph_creds)
    # The guard is about the EFFECTIVE root, so prove the effective root is
    # actually big — not just that the call returned.
    assert len(seeds & set(snap.graph_creds)) >= MIN_TRUSTED_SEEDS
    # The offline/harness path (production=False, EXPLICIT) still allows
    # empty seeds — this is no longer the default, so it must be requested.
    offline = build_trust_snapshot(
        gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
        trusted_seeds=frozenset(), production=False,
    )
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
    # ★ 2026-08-08: the EMPTY-POOL precondition this regression is about only
    # exists without the popularity lane — with it, this viewer's pool is no
    # longer empty at all (which is a strict improvement for them, and is
    # asserted as such in `test_the_popularity_lane_rescues_a_dead_follow_graph`).
    assert gather_candidates(viewer, gateway, EPOCH, 400, _NO_POPULAR_LANE) == []

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH,
                     trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE)

    # ★ C6 (2026-08-04): the popular lane is no longer allowed to BE the whole
    # feed at full pool depth — `FallbackConfig.max_share_of_feed` (default
    # 0.25) bounds padding's share of the RETURNED feed, applied uniformly
    # including at zero eligible posts (see `_fallback_filler`'s comment on
    # why an exemption at eligible==0 would reintroduce a non-monotonic
    # feed-length cliff). What this test actually guards — a dead-follows
    # viewer is NEVER served an empty feed — still holds: `min_feed_size` is
    # a floor the share cap cannot go below.
    assert len(feed) == DEFAULT_SETTINGS.fallback.min_feed_size == 20
    assert all(sc.source is CandidateSource.POPULAR_FALLBACK for sc in feed)


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
        feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH,
                     trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE)
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
    comparable depth. Before the original fix the ratio was 10x.

    ★ C6 (2026-08-04): `FallbackConfig.max_share_of_feed` now bounds both
    cases to exactly `min_feed_size` (20) — the popular lane can no longer
    pad a thin-supply viewer out to the full admissible pool the way it did
    when this test was written (see `test_established_viewer_with_dead_
    follows_is_never_served_an_empty_feed`'s updated comment for why, and
    `_fallback_filler` for the formula). The two feeds are therefore now
    EQUAL in length rather than merely "comparable" — a strictly stronger
    guarantee against the cliff this test exists to catch than the original
    `> 20` / `>=` pair, which assumed an uncapped popular lane and would
    misfire ("fixture too small") under the cap regardless of pool size.
    """
    popular = _popular()
    followless = rank_feed(
        make_viewer("new", follows=frozenset()),
        FakeGateway(popular=popular), _norm(), now=NOW, since=EPOCH,
        trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE,
    )
    one_follow = rank_feed(
        make_viewer("new", follows=frozenset({"live"})),
        FakeGateway(in_network=[make_post("live", "l0")], popular=popular),
        _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE,
    )
    assert len(followless) == DEFAULT_SETTINGS.fallback.min_feed_size
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

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH,
                     trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE)

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
        trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE,
    )
    with_popular = rank_feed(
        viewer, FakeGateway(in_network=own, popular=_popular()), _norm(), now=NOW,
        since=EPOCH, trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE,
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


def test_proven_self_dealer_cannot_reach_a_starved_feed_via_the_fallback() -> None:
    """POPULAR_FALLBACK is exempt from the author floor, and `_order_by_full_
    exclusion` only re-ORDERS the admissible pool — so when the shortfall is big
    enough to admit everything, a condemned farm rode the padding lane in.

    Measured before the fix: a dense 4-account mutual ring at graph-cred 0.0
    reached 10/10 thin-supply viewers on seeds 7/11/23 (0/10 for viewers whose
    own pool was healthy). Thin supply is exactly the early-growth condition
    where the manipulation is cheapest.

    The bar is the SELF-DEALT band (0.0), not ring membership: an unknown or
    newcomer account sits at `min_vouched_score` (0.10) and must still pad.
    """
    popular = [make_post("dealer", "d1"), make_post("newcomer", "n1")]
    gateway = FakeGateway(in_network=[], popular=popular)
    viewer = make_viewer("returning", follows=frozenset({"ghost"}))
    snap = TrustSnapshot(
        graph_creds={
            "dealer": _cred(0.0),       # proven self-dealer
            "newcomer": _cred(0.10),    # unknown tier — must NOT be filtered
        }
    )
    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap,
        trust_policy=_PERMISSIVE,
    )
    authors = {sc.post.author for sc in feed}
    assert "dealer" not in authors
    assert "newcomer" in authors


def test_starved_feed_stays_short_when_the_network_has_nothing_to_offer() -> None:
    # Honest degradation: the top-up never invents posts. An empty network
    # yields an empty feed rather than fabricated filler.
    gateway = FakeGateway(in_network=[], popular=[])
    viewer = make_viewer("returning", follows=frozenset({"ghost"}))
    assert rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE) == []


def test_established_viewer_interest_tag_admits_clean_strangers_only() -> None:
    """A declared interest tag admits a stranger — but only a CREDIBLE one.

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
         refused (`requires_author_floor` stays True for OON_INTEREST);
      2. the per-author OON flooding cap, so nobody can flood an interest feed.

    What is deliberately given up: an unknown but credible author can now reach a
    viewer who explicitly declared that interest tag. That is what declaring an
    interest means, and it is the only route by which a tag can introduce anyone
    new.

    ★ Communities were retired as a lane 2026-08-04 (R1/R3) — this test used to
    exercise OON_COMMUNITY specifically (a subscribed community); the mechanism
    it pins (author floor + flooding cap standing in for the retired vouch gate)
    is identical for OON_INTEREST, the surviving discovery lane.
    """
    stranger_post = make_post("stranger", "s1", tags=("photo",))
    gateway = FakeGateway(tag=[stranger_post])
    viewer = make_viewer(
        "me", follows=frozenset({"alice"}), interest_tags=frozenset({"photo"})
    )

    admitted = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
    assert {sc.post.key for sc in admitted} == {"@stranger/s1"}, (
        "declaring an interest tag must actually deliver its posts"
    )

    # ...but a stranger caught self-dealing is still refused.
    snapshot = TrustSnapshot(
        graph_creds={"stranger": _cred(0.0)}, trusted_seeds=frozenset({"alice"})
    )
    gated = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        snapshot=snapshot, trust_policy=_PERMISSIVE,
    )
    assert gated == [], "a floored author must not ride an interest tag in"


def test_a_single_author_cannot_flood_an_interest_tag_feed() -> None:
    """★ The second protection standing in for the removed vouch gate.

    Without this an interest tag is an unbounded megaphone for one account: the
    flooding cap is what keeps "a stranger may reach you" from becoming "a
    stranger may BE your feed".
    """
    posts = [make_post("stranger", f"s{i}", tags=("photo",)) for i in range(30)]
    viewer = make_viewer(
        "me", follows=frozenset({"alice"}), interest_tags=frozenset({"photo"})
    )
    feed = rank_feed(
        viewer, FakeGateway(tag=posts), _norm(), now=NOW, since=EPOCH,
        trust_policy=_PERMISSIVE,
    )
    assert len(feed) <= DEFAULT_SETTINGS.flooding.max_oon_posts_per_author, (
        f"one author placed {len(feed)} posts in an interest-tag feed"
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
    # production=False (C5/R2): synthetic sock world, no real seed lands.
    snap = build_trust_snapshot(
        gw_trust, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH, production=False
    )

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
    # production=False (C5/R2): synthetic newcomer-pair world, no real seed lands.
    snap = build_trust_snapshot(
        FakeGateway(edges=edges, follow_graph=follows), DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
        production=False,
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
        FakeGateway(edges=edges2, follow_graph=follows2), DEFAULT_SETTINGS, since=EPOCH, now=EPOCH,
        production=False,
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

    liked_post = make_post("liked", "ic1", tags=("photo",))
    gateway = FakeGateway(tag=[liked_post])
    viewer = make_viewer("me", follows=frozenset(), interest_tags=frozenset({"photo"}))
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

    tag_post1 = make_post("author1", "c1", tags=("photo",))
    tag_post2 = make_post("author2", "t1", tags=("art",))
    gateway = FakeGateway(tag=[tag_post1, tag_post2])
    viewer = make_viewer(
        "newbie",
        is_new=True,
        interest_tags=frozenset({"photo", "art"}),
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
    # production=False (C5/R2): synthetic H11 drift-gate world, no real seed lands.
    return build_trust_snapshot(
        gw, settings, since=EPOCH, now=EPOCH, previous=previous, production=False
    )


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


# ---------------------------------------------------------------------------
# Exploration lane, through the SERVED feed (cold-start spec §4.3, item B12).
#
# ★ Added 2026-08-04. Every other test of this lane calls `eligible_for_
# exploration` / `insert_exploration` directly, and this package has already
# been burned four times by fixes that passed their own tests because they were
# verified at the candidate boundary instead of at the feed the viewer actually
# receives. These two go through `rank_feed`.
# ---------------------------------------------------------------------------


def _explore_norm() -> NormContext:
    """A norm whose samples actually BRACKET this fixture's raw values.

    The shared `_norm()` draws its samples from `range(50)`, which is orders of
    magnitude above any real raw here — every post then percentile-ranks below
    sample 0, the whole feed ties at one score, and the tie-break silently
    becomes the ranker. A ranking test built on it measures nothing. Measured
    raws for this fixture: organic 0.40 established vs 0.099 debut, vote signal
    1.41 vs 0.0.
    """
    return build_norm_context(
        [i / 25 for i in range(50)],     # vote signal, spans 0 .. 1.96
        [float(i) for i in range(50)],   # reputation, uniform at 50.0 for all
        [i / 100 for i in range(50)],    # organic quality, spans 0 .. 0.49
    )


def _explore_world() -> tuple[FakeGateway, object, Settings, Settings]:
    """An established viewer, a well-engaged in-network feed, and one brand-new
    author posting under the tag the viewer declared as an interest.

    ★ All posts (established + debut) share one topic key deliberately — they
    used to all carry `community="hive-1"` before communities were retired as a
    lane (2026-08-04, R1/R3); giving every post the same `category`/`tags` here
    reproduces that "one topic bucket" shape exactly, so the diversity re-ranker's
    behaviour (and therefore the positions this test pins) is unchanged.

    ★ THREE distinct voters per established post, not two (fixed 2026-08-04,
    C8 fallout). `_need_tier`'s shipped bands are ``(0, 3, 8, 20)``
    (`core/exploration.py`), so a received-count of 0, 1 OR 2 distinct
    engagers all land in the SAME bottom tier as the newcomer's true zero.
    With only two voters each, every "established" author was actually TIED
    with the newcomer in need-tier 0, so which of the 26 tied accounts won
    the reserved slot depended on the seat-rotation hash instead of on the
    newcomer genuinely being the least-heard — this fixture stopped
    demonstrating what its own name claims. Three voters (>= the tier-1
    boundary) keeps every established author OUT of tier 0, so the newcomer
    is the sole occupant again and the slot is deterministic regardless of
    bucket/secret.
    """
    # 25 DISTINCT established authors, one post each. A handful of authors with
    # many posts each does not work as a fixture: the author-diversity re-ranker
    # decays the repeats hard enough to float the debut to position 3 on its own,
    # and the test would then be measuring rerank rather than the lane.
    # rshares must clear `_ORGANIC_VOTER_MIN_RSHARES` (1e7) or the organic term
    # — 80% of the composite — cannot see the votes at all and the established
    # posts differ from the debut only on the 10% vote channel. `make_vote`'s
    # default (1e6) is dust by that measure.
    in_network = [
        make_post(
            f"est{i:02d}", f"e{i}", category="photo", tags=("photo",),
            created_min=i, children=2,
            votes=[
                make_vote(f"reader{i}", 50_000_000),
                make_vote(f"reader{i + 100}", 40_000_000),
                make_vote(f"reader{i + 200}", 30_000_000),
            ],
        )
        for i in range(25)
    ]
    debut = make_post("newcomer", "debut", category="photo", tags=("photo",), created_min=30)
    gateway = FakeGateway(in_network=in_network, tag=[debut])
    viewer = make_viewer(
        "me",
        follows=frozenset(f"est{i:02d}" for i in range(25)),
        interest_tags=frozenset({"photo"}),
    )
    # ★ PINNED SEAT SECRET (C1a fallout, 2026-08-04). Belt-and-braces on top of
    # the tier fix above: the unconfigured default is a per-process-RANDOM dev
    # key (`ExplorationConfig.seat_secret=None`, `production=False`), which
    # would make this fixture's outcome depend on process-random state rather
    # than only on fixture content. Same rationale and pattern as
    # `tests/test_exploration.py`'s own `seat-stability-fixed-secret-v2`.
    seat_secret = hashlib.sha256(b"test-pipeline-explore-world-fixed-secret").digest()
    on = Settings(exploration=ExplorationConfig(seat_secret=seat_secret))
    off = dataclasses.replace(
        on, exploration=dataclasses.replace(on.exploration, slots_per_page=0)
    )
    return gateway, viewer, on, off


def test_exploration_reaches_the_served_feed_end_to_end() -> None:
    """The acceptance shape of §4.3: a zero-engagement debut that loses on score
    is served at the reserved slot instead of being buried past the first page."""
    gateway, viewer, on, off = _explore_world()

    without = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                        settings=off, trust_policy=_PERMISSIVE)
    with_lane = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                          settings=on, trust_policy=_PERMISSIVE)

    buried = [sc.post.key for sc in without].index("@newcomer/debut")
    served = [sc.post.key for sc in with_lane].index("@newcomer/debut")
    assert buried > on.exploration.position      # it really did lose on score
    assert served == on.exploration.position     # and the lane is what fixed it
    assert with_lane[served].source is CandidateSource.EXPLORATION


def test_the_lane_costs_the_rest_of_the_served_feed_nothing() -> None:
    """★ NON-HARM, measured where the viewer experiences it.

    A reserved slot is only honest if it comes out of unused space. Turning the
    lane on must not admit a post that was ineligible, must not change anyone's
    score, and must not re-order what the viewer's own network earned — the sole
    permitted effect is that everything below the slot shifts down by one.

    Scope, stated: this feed is far short of `top_k`, so nothing is dropped. At
    the truncation boundary the marginal tail item DOES fall outside the cut —
    that is what reserving a slot costs, and `insert_exploration.__doc__` owns
    that case. Here the claim is only that the lane takes nothing else.
    """
    gateway, viewer, on, off = _explore_world()

    without = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                        settings=off, trust_policy=_PERMISSIVE)
    with_lane = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                          settings=on, trust_policy=_PERMISSIVE)

    assert {sc.post.key for sc in with_lane} == {sc.post.key for sc in without}
    promoted = "@newcomer/debut"
    assert [sc.post.key for sc in with_lane if sc.post.key != promoted] == [
        sc.post.key for sc in without if sc.post.key != promoted
    ]
    # The scores are untouched too: the lane pays REACH, never score (§4.3).
    by_key = {sc.post.key: sc.score.final for sc in without}
    assert all(sc.score.final == by_key[sc.post.key] for sc in with_lane)


def _rotating_explore_world() -> tuple[FakeGateway, object, Settings]:
    """Like `_explore_world`, but with SEVERAL equally-unheard debut authors.

    ★ The single-author fixture cannot exercise rotation at all — a tier of one
    has nothing to rotate — which is why the wiring, the time unit and the
    rotation guard all survived mutation testing untested.
    """
    in_network = [
        make_post(
            f"est{i:02d}", f"e{i}", category="photo", tags=("photo",),
            created_min=i, children=2,
            votes=[make_vote(f"reader{i}", 50_000_000), make_vote(f"reader{i + 100}", 40_000_000)],
        )
        for i in range(25)
    ]
    debuts = [
        make_post(f"newcomer{i}", "debut", category="photo", tags=("photo",), created_min=30 + i)
        for i in range(6)
    ]
    gateway = FakeGateway(in_network=in_network, tag=debuts)
    viewer = make_viewer(
        "me",
        follows=frozenset(f"est{i:02d}" for i in range(25)),
        interest_tags=frozenset({"photo"}),
    )
    return gateway, viewer, Settings()


def _seat(gateway, viewer, settings, now) -> str:
    feed = rank_feed(viewer, gateway, _explore_norm(), now=now, since=EPOCH,
                     settings=settings, trust_policy=_PERMISSIVE)
    return feed[settings.exploration.position].post.author


def test_the_reserved_seat_rotates_on_the_clock_through_rank_feed() -> None:
    """★ End-to-end proof that the bucket is actually WIRED. Deleting
    `bucket=explore_bucket` from `rank_feed` passed the entire suite before this
    test existed.

    NOW is deliberately offset from midnight: the measurement harness pins its
    clock to exact midnight, which makes the bucket a multiple of 4 and hid the
    feature from every panel.
    """
    gateway, viewer, on = _rotating_explore_world()
    base = NOW + timedelta(hours=1)

    seats = {_seat(gateway, viewer, on, base + timedelta(hours=6 * k)) for k in range(4)}

    assert len(seats) > 1, "the seat never changed across four 6-hour buckets"


def test_the_bucket_is_measured_in_hours_not_seconds() -> None:
    """★ A mutant that computed the bucket in SECONDS passed all 502 tests. It
    destroys the property the setting exists for — a viewer could re-roll their
    feed by refreshing — so it needs its own pin."""
    gateway, viewer, on = _rotating_explore_world()
    base = NOW + timedelta(hours=1)

    assert _seat(gateway, viewer, on, base) == _seat(
        gateway, viewer, on, base + timedelta(minutes=5)
    )
    assert _seat(gateway, viewer, on, base) == _seat(
        gateway, viewer, on, base + timedelta(seconds=1)
    )


def test_rotation_hours_zero_pins_the_seat_through_rank_feed() -> None:
    """The revert path: if rotation misbehaves live it must be switchable off by
    config alone. A mutant that ignored `rotation_hours` also passed everything."""
    gateway, viewer, on = _rotating_explore_world()
    off = dataclasses.replace(on, exploration=dataclasses.replace(on.exploration,
                                                                 rotation_hours=0))
    base = NOW + timedelta(hours=1)

    seats = {_seat(gateway, viewer, off, base + timedelta(hours=6 * k)) for k in range(4)}

    assert len(seats) == 1, "rotation still ran with rotation_hours = 0"


def test_lineage_is_no_longer_fetched_for_any_author() -> None:
    """Replaces `test_stake_lineage_is_asked_once_per_author_per_request`, which
    pinned a request-scoped memo over `gateway.stake_lineage`. B2 removed that
    query outright, so the property worth pinning is no longer "asked once" but
    "never asked, and empty for everyone" — the memo's redundancy is moot when
    the round trip does not exist."""
    gateway, viewer, on, _ = _explore_world()
    assert not hasattr(gateway, "stake_lineage")
    result = _lineage_for(gateway, frozenset({"a", "b"}), None)
    assert result == {"a": frozenset(), "b": frozenset()}
    rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
              settings=on, trust_policy=_PERMISSIVE)


def _lineage_farm_world(farm_size: int = 5) -> tuple[FakeGateway, object, Settings]:
    """130 established authors, each with real votes, fill `ranked` with
    enough room for all 3 `max_slots_per_feed` pages (page 2's slot sits at
    index 53). They carry `tags=("photo",)` — the SAME declared-interest
    score boost the farm gets, so the farm cannot out-merit them purely on
    the interest-match term — but `category="news"`, which keeps them OUT of
    the exploration pool: `eligible_for_exploration`'s `_interest_match`
    gates on `post.category` only (the primary/filed tag), not the full tag
    set (see that function's own docstring for why), so 'news' vs the
    viewer's declared 'photo' interest excludes them there while still
    scoring them fairly against the farm everywhere else. This isolates the
    exploration pool to exactly the farm without silently favouring it.

    ``farm_size`` sock accounts (`category='photo'`, matching the viewer's
    interest, zero engagement, one post each) share ONE funding lineage —
    the same shape as `test_exploration.py`'s reference fixture
    (`test_c2c_at_most_one_promotion_per_lineage_group_per_feed`), just
    reached through `rank_feed` instead of `insert_exploration` directly.
    Zero engagement against 130 real-voted established authors keeps every
    sock buried on merit (confirmed by hand: all 5 land at the tail,
    positions 130+, before any exploration splice), which is exactly the
    "lost on score" precondition the lane exists for.
    """
    in_network = [
        make_post(
            f"est{i:03d}", f"e{i}", category="news", tags=("photo",),
            created_min=i % 55, children=2,
            votes=[
                make_vote(f"reader{i}", 50_000_000),
                make_vote(f"reader{i + 1000}", 40_000_000),
                make_vote(f"reader{i + 2000}", 30_000_000),
            ],
        )
        for i in range(130)
    ]
    farm = [
        make_post(
            f"sock{i:02d}", "debut", category="photo", tags=("photo",), created_min=40 + i
        )
        for i in range(farm_size)
    ]
    lineage = {
        f"sock{i:02d}": frozenset(
            f"sock{j:02d}" for j in range(farm_size) if j != i
        )
        for i in range(farm_size)
    }
    gateway = FakeGateway(in_network=in_network, tag=farm, lineage=lineage)
    viewer = make_viewer(
        "me",
        follows=frozenset(f"est{i:03d}" for i in range(130)),
        interest_tags=frozenset({"photo"}),
    )
    seat_secret = hashlib.sha256(b"test-pipeline-lineage-farm-fixed-secret-v1").digest()
    settings = Settings(
        exploration=ExplorationConfig(seat_secret=seat_secret, max_slots_per_feed=3)
    )
    return gateway, viewer, settings


def test_c2c_lineage_cap_is_retired_with_the_relation_it_depended_on() -> None:
    """Replaces `test_c2c_lineage_cap_is_wired_end_to_end_through_rank_feed`.

    C2c capped exploration promotions to one per lineage GROUP. It is retired
    with B2 because its input was attacker-writable, and — decisive here — the
    2026-08-05 council measured it INERT against the attack it was built for:
    an account-count farm has no reason to delegate between its own socks
    (100.0% of the exploration budget captured without shared lineage, 41.1%
    with). So this removes a defence that did not defend.

    ★ THE REPLACEMENT IS NOT THIS FILE'S. Account count is priced by the
    SERVING LOG (B11/B1) — "has this author been heard" as a fact the system
    OBSERVED rather than a number the attacker writes. Until that lands, the
    exploration lane has NO account-count pricing, which is the honest state and
    is recorded as such rather than implied by a still-green cap test.
    """
    gateway, viewer, on, _ = _explore_world()
    ranked = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                       settings=on, trust_policy=_PERMISSIVE)
    explore_picks = [sc for sc in ranked if sc.source is CandidateSource.EXPLORATION]
    # The lane still works...
    assert explore_picks, "the exploration lane stopped producing picks entirely"
    # ...and the group input the cap depended on is empty for every author in it,
    # so no promotion can be constrained by a lineage group any more. When B1's
    # serving log lands it will bound this lane by OBSERVED SERVES instead; this
    # assertion is what should fail then, prompting a deliberate update.
    authors = frozenset(sc.post.author for sc in explore_picks)
    assert _lineage_for(gateway, authors, None) == {a: frozenset() for a in authors}

def test_c2c_lineage_cap_wiring_costs_nothing_when_no_farm_is_present() -> None:
    """Control: a single, genuinely unrelated newcomer (no shared lineage with
    anyone) must still take its seat normally -- the wire must not accidentally
    throttle ordinary, non-farmed exploration."""
    gateway, viewer, settings = _lineage_farm_world(farm_size=1)

    ranked = rank_feed(
        viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
        settings=settings, trust_policy=_PERMISSIVE,
    )

    explore_picks = [sc for sc in ranked if sc.source is CandidateSource.EXPLORATION]
    assert [sc.post.author for sc in explore_picks] == ["sock00"]


# ---------------------------------------------------------------------------
# A12 — lite `chain_authors` resolution (2026-08-04). `second_degree_engagers`
# and `suppressed_keys` accept an optional `chain_authors` mapping
# (`recsys.io.hafsql.chain_author_map`), and the real `HafsqlClient`
# implementation resolves through it: a Lumen Lite post's RANKED key
# (`@u_7f3c9a/permlink`) is queried against votes/replies/reblogs and §8.7
# suppression reports filed against the shared PUBLISHER account
# (`Post.chain_author`), not the writer's ranked pseudo-identity. Without the
# map, the query runs under the ranked pseudo-author and matches ZERO rows,
# always — a lite post can never clear the second-degree vouch gate, and
# moderation can never suppress one. `pipeline.py` never built or passed the
# map at either call site.
#
# `tests/fakes.py::FakeGateway` does not implement the `chain_authors`
# parameter at all (an in-memory fake predating A12), and it is shared by
# nearly every test module in this suite — unconditionally passing the
# keyword would raise `TypeError` for every one of them. `_suppressed`/
# `rank_feed` therefore only pass the keyword when `chain_author_map(...)` is
# non-empty (see their own comments), which is byte-for-byte identical to
# omitting it whenever a batch has no lite posts — true for every existing
# fixture — and only takes effect the moment a real `Post.chain_author` is
# present. `_ChainAuthorGateway` below is a small, LOCAL double (this test
# file's own, touching no shared fixture) that accepts the parameter and
# resolves through it exactly the way `HafsqlClient` does, so these tests can
# prove the wiring changes the OBSERVABLE result, not merely that a kwarg
# reaches the call.
# ---------------------------------------------------------------------------


class _ChainAuthorGateway(FakeGateway):
    """Models engagement/suppression records the way the real gateway does:
    filed against the on-chain ``(chain_author, permlink)`` identity, never
    the lite writer's ranked pseudo-author. Records every ``chain_authors``
    argument it actually receives, so a test can also assert the map reached
    the gateway (not just that the output happened to be right)."""

    def __init__(
        self,
        *,
        chain_engagers: Mapping[tuple[str, str], frozenset[str]] | None = None,
        chain_suppressed: frozenset[tuple[str, str]] = frozenset(),
        **kw: object,
    ) -> None:
        super().__init__(**kw)  # type: ignore[arg-type]
        self._chain_engagers = dict(chain_engagers or {})
        self._chain_suppressed = frozenset(chain_suppressed)
        self.second_degree_calls: list[Mapping[str, str] | None] = []
        self.suppressed_calls: list[Mapping[str, str] | None] = []

    @staticmethod
    def _resolve(
        post_keys: frozenset[str], chain_authors: Mapping[str, str] | None
    ) -> dict[str, tuple[str, str]]:
        chain_authors = chain_authors or {}
        out = {}
        for key in post_keys:
            ranked_author, _, permlink = key.removeprefix("@").partition("/")
            out[key] = (chain_authors.get(key, ranked_author), permlink)
        return out

    def second_degree_engagers(
        self,
        post_keys: frozenset[str],
        follows: frozenset[str],
        *,
        chain_authors: Mapping[str, str] | None = None,
    ) -> dict[str, frozenset[str]]:
        self.second_degree_calls.append(chain_authors)
        resolved = self._resolve(post_keys, chain_authors)
        out = {}
        for key, identity in resolved.items():
            hit = self._chain_engagers.get(identity, frozenset()) & follows
            if hit:
                out[key] = hit
        return out

    def suppressed_keys(
        self, post_keys: frozenset[str], *, chain_authors: Mapping[str, str] | None = None
    ) -> frozenset[str]:
        self.suppressed_calls.append(chain_authors)
        resolved = self._resolve(post_keys, chain_authors)
        return frozenset(
            key for key, identity in resolved.items() if identity in self._chain_suppressed
        )


def test_a12_suppression_resolves_a_lite_posts_chain_author() -> None:
    """A §8.7 report filed against the CHAIN identity must suppress the lite
    post it was actually filed against — proven by comparing the SAME post
    served with and without the moderation report present, on the SAME
    gateway/settings, so the only variable is whether the report exists.

    FAILS if `_suppressed` stops building/passing `chain_authors`: the
    gateway would then resolve every key under its own ranked pseudo-author
    (`u_7f3c9a`), never match `("publisher_wallet", "lite-permlink")`, and
    the post would stay in the feed regardless of the report.
    """
    lite = dataclasses.replace(
        make_post("u_7f3c9a", "lite-permlink", created_min=1),
        chain_author="publisher_wallet",
    )
    # A follow is required for `gather_candidates` to source the IN_NETWORK
    # lane at all (see `gather_candidates`: `if viewer.follows: ...`) -- the
    # gateway's `chain_authors` resolution is what is under test, not
    # sourcing, so `FakeGateway.in_network_posts` ignoring its `follows`
    # argument (it always returns the whole `in_network=` list) means any
    # non-empty follow set works.
    viewer = make_viewer("me", follows=frozenset({"u_7f3c9a"}))

    clean_gateway = _ChainAuthorGateway(in_network=[lite])
    reported_gateway = _ChainAuthorGateway(
        in_network=[lite],
        chain_suppressed=frozenset({("publisher_wallet", "lite-permlink")}),
    )

    clean_feed = rank_feed(
        viewer, clean_gateway, _norm(), now=NOW, since=EPOCH,
        settings=DEFAULT_SETTINGS, trust_policy=_PERMISSIVE,
    )
    reported_feed = rank_feed(
        viewer, reported_gateway, _norm(), now=NOW, since=EPOCH,
        settings=DEFAULT_SETTINGS, trust_policy=_PERMISSIVE,
    )

    assert lite.key in {sc.post.key for sc in clean_feed}, (
        "fixture sanity: with no suppression report at all the lite post must "
        "be served normally"
    )
    assert lite.key not in {sc.post.key for sc in reported_feed}, (
        "A12 chain_authors not wired: a §8.7 report filed against the lite "
        "post's real chain identity (publisher_wallet, lite-permlink) failed "
        "to suppress it"
    )
    assert reported_gateway.suppressed_calls, "suppressed_keys was never called"
    assert any(
        m is not None and m.get(lite.key) == "publisher_wallet"
        for m in reported_gateway.suppressed_calls
    ), "suppressed_keys was called without the lite post's chain_authors entry"


def test_a12_second_degree_gate_resolves_a_lite_posts_chain_author() -> None:
    """A lite post sourced OON_ENGAGED (someone the viewer follows engaged it)
    can only clear the second-degree vouch gate if the engagement query
    resolves to the CHAIN identity votes/replies are actually recorded
    against. `viewer.interest_tags` is deliberately empty here so the
    "demote to an ungated lane" fallback (`_ungated_lane_for`, triggered when
    the vouch check fails) has nothing to demote INTO — the only way this
    post can survive is the vouch gate genuinely passing.

    FAILS if `rank_feed` stops building/passing `chain_authors` at the
    `second_degree_engagers` call site: the gateway would resolve the query
    under `u_7f3c9a` instead of `publisher_wallet`, find no engagement, the
    vouch check would fail, and (with no ungated lane to fall back to) the
    post would be dropped entirely.
    """
    lite = dataclasses.replace(
        make_post("u_7f3c9a", "lite-permlink", created_min=1),
        chain_author="publisher_wallet",
    )
    viewer = make_viewer("me", follows=frozenset({"friend1"}))
    gateway = _ChainAuthorGateway(
        oon=[Candidate(post=lite, source=CandidateSource.OON_ENGAGED)],
        chain_engagers={("publisher_wallet", "lite-permlink"): frozenset({"friend1"})},
    )

    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        settings=DEFAULT_SETTINGS, trust_policy=_PERMISSIVE,
    )

    assert lite.key in {sc.post.key for sc in feed}, (
        "A12 chain_authors not wired: friend1's engagement of the lite post's "
        "real chain identity (publisher_wallet, lite-permlink) failed to clear "
        "the second-degree gate, and the post was dropped"
    )
    assert gateway.second_degree_calls, "second_degree_engagers was never called"
    assert any(
        m is not None and m.get(lite.key) == "publisher_wallet"
        for m in gateway.second_degree_calls
    ), "second_degree_engagers was called without the lite post's chain_authors entry"


# ---------------------------------------------------------------------------
# A9 — build_viewer_profile. `recsys/viewer.py` queries a gateway through one
# generic ``_fetch(sql, params) -> list[tuple]`` method (matching
# `HafsqlClient._fetch`'s shape) rather than one method per capability, so the
# test double dispatches on a distinguishing substring of the SQL text —
# mirroring how `tests/fakes.py`'s own doubles work for the rest of the
# package. See `recsys/viewer.py`'s module docstring for why this module talks
# to `_fetch` directly instead of adding methods to `HafsqlGateway` (that
# Protocol, and `recsys/io/hafsql.py`, are owned by a different workstream
# this phase).
# ---------------------------------------------------------------------------


class _ViewerFetchDouble:
    """Dispatches `_fetch` calls by SQL substring to canned rows. `calls`
    records which query kind ran, in order, so a test can assert a query was
    (or was NOT) issued — e.g. that declared/explicit tags skip derivation."""

    def __init__(
        self,
        follows: Sequence[str] = (),
        mutes: Sequence[str] = (),
        own_post_tags: Sequence[tuple[Sequence[str] | None, str | None]] = (),
        votes: Sequence[tuple[str, str]] = (),
        tags_by_pair: Mapping[tuple[str, str], tuple[Sequence[str] | None, str | None]]
        | None = None,
    ) -> None:
        self._follows = list(follows)
        self._mutes = list(mutes)
        self._own_post_tags = list(own_post_tags)
        self._votes = list(votes)
        self._tags_by_pair = dict(tags_by_pair or {})
        self.calls: list[str] = []

    def _fetch(self, sql: str, params: dict) -> list[tuple]:
        if "hafsql.follows" in sql:
            self.calls.append("follows")
            return [(f,) for f in self._follows]
        if "hafsql.mutes" in sql:
            self.calls.append("mutes")
            return [(m,) for m in self._mutes]
        if "hafsql.comments" in sql and "parent_author" in sql:
            self.calls.append("own_posts")
            return list(self._own_post_tags)
        if "operation_effective_comment_vote_view" in sql:
            self.calls.append("votes")
            return list(self._votes)
        if "unnest(%(authors)s" in sql:
            self.calls.append("tag_pairs")
            pairs = zip(params["authors"], params["permlinks"], strict=True)
            return [self._tags_by_pair[p] for p in pairs if p in self._tags_by_pair]
        raise AssertionError(f"unexpected SQL in _ViewerFetchDouble: {sql[:60]!r}")


def test_build_viewer_profile_pulls_follows_and_mutes_from_the_gateway() -> None:
    gateway = _ViewerFetchDouble(
        follows=["blocktrades", "gtg"], mutes=["spammer"],
    )

    profile = build_viewer_profile(
        "acidyo", gateway, now=NOW, explicit_interest_tags=frozenset({"photography"})
    )

    assert profile.account == "acidyo"
    assert profile.follows == frozenset({"blocktrades", "gtg"})
    assert profile.mutes == frozenset({"spammer"})


def test_build_viewer_profile_explicit_tags_win_over_derived() -> None:
    """R12 precedence: a real signup-time pick beats any inference, and
    derivation's own queries are skipped entirely rather than run and
    discarded — see the module docstring's `explicit_interest_tags` note."""
    gateway = _ViewerFetchDouble(
        own_post_tags=[(["food", "travel"], "food")],
    )

    profile = build_viewer_profile(
        "acidyo", gateway, now=NOW, explicit_interest_tags=frozenset({"photography"})
    )

    assert profile.interest_tags == frozenset({"photography"})
    assert gateway.calls == ["follows", "mutes"], (
        "an explicit override was supplied — deriving from history was unnecessary work"
    )


def test_build_viewer_profile_derives_tags_for_a_returning_user_with_none_declared() -> None:
    """R12 part 2: a returning user's OWN posting/voting history fills in for
    a missing declared interest, rather than treating them as tagless."""
    gateway = _ViewerFetchDouble(
        own_post_tags=[(["gaming"], "gaming"), (["music"], "music")],
    )

    profile = build_viewer_profile("returning", gateway, now=NOW, is_new=False)

    assert profile.interest_tags == frozenset({"gaming", "music"})
    assert "own_posts" in gateway.calls


def test_build_viewer_profile_neither_declared_nor_derivable_is_empty_not_a_crash() -> None:
    """R12 part 3's defensive path lives downstream (gather_candidates already
    warns and falls through to the popular fallback — see
    test_tagless_viewer_falls_through_to_popular_fallback_with_a_warning).
    This function's job is only to not invent a crash or a fake tag here."""
    gateway = _ViewerFetchDouble()  # no follows, no mutes, no history at all

    profile = build_viewer_profile("brandnew", gateway, now=NOW, is_new=False)

    assert profile.interest_tags == frozenset()
    assert profile.follows == frozenset()
    assert profile.mutes == frozenset()
    # And the downstream contract R12 part 3 relies on actually holds:
    feed = rank_feed(
        profile, FakeGateway(popular=_popular()), _norm(), now=NOW, since=EPOCH,
        trust_policy=_PERMISSIVE,
    )
    assert feed, "a viewer built with no tags at all must never get an empty feed"


def test_build_viewer_profile_is_new_true_skips_derivation_and_is_still_a_passthrough() -> None:
    """★ MUST NOT CHANGE (A9's own instruction): `is_new` stays client-supplied
    and un-load-bearing FOR GATING — `gather_candidates` must keep routing on
    the unspoofable `not viewer.follows`, never on this flag (untouched by
    this module). Within `build_viewer_profile` itself, `is_new=True` is
    used ONLY as a harmless optimisation (skip a derivation query that would
    return nothing for a genuinely brand-new account) — not as a signal
    fed back into ranking, and not derived FROM `follows` in either direction."""
    gateway = _ViewerFetchDouble(
        follows=["someone"], own_post_tags=[(["photo"], "photo")],
    )

    default = build_viewer_profile("me", gateway, now=NOW)
    assert default.is_new is False  # default, regardless of having follows
    assert "own_posts" in gateway.calls  # derivation ran (is_new defaulted False)

    gateway2 = _ViewerFetchDouble(
        follows=["someone"], own_post_tags=[(["photo"], "photo")],
    )
    flagged = build_viewer_profile("me", gateway2, now=NOW, is_new=True)
    assert flagged.is_new is True  # explicit passthrough honoured
    assert flagged.follows == frozenset({"someone"})  # is_new did not suppress follows
    assert "own_posts" not in gateway2.calls  # derivation skipped for a declared-new account


# ---------------------------------------------------------------------------
# A8.3 — TrustSnapshot.built_at / staleness. `_trust_is_fresh` gained a
# fourth clause; these pin the three shapes: built_at absent, fresh, and
# stale, plus that build_trust_snapshot actually stamps it.
# ---------------------------------------------------------------------------


def test_build_trust_snapshot_stamps_built_at_with_its_own_now() -> None:
    edges = [EngagementEdge(src="a", dst="b", upvotes=5)]
    gateway = FakeGateway(edges=edges, follow_graph={"a": frozenset({"b"})})
    snap = build_trust_snapshot(
        gateway, DEFAULT_SETTINGS, since=EPOCH, now=NOW, production=False
    )
    assert snap.built_at == NOW


def test_a_snapshot_with_no_built_at_stays_fresh_regardless_of_age() -> None:
    """A8.3: `built_at=None` (every fixture/snapshot built before this field
    existed) must not newly fail freshness — only a snapshot that POSITIVELY
    knows its own age and has aged out does."""
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    snap = TrustSnapshot(graph_creds={"a": _cred(0.5)}, built_at=None)
    trust14 = dataclasses.replace(DEFAULT_SETTINGS.trust, max_snapshot_age_days=14)
    settings = dataclasses.replace(DEFAULT_SETTINGS, trust=trust14)
    # Must not raise MissingTrustError under FAIL_CLOSED.
    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap, settings=settings
    )
    assert feed


def test_a_recent_snapshot_stays_fresh() -> None:
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    snap = TrustSnapshot(graph_creds={"a": _cred(0.5)}, built_at=NOW - timedelta(days=1))
    trust14 = dataclasses.replace(DEFAULT_SETTINGS.trust, max_snapshot_age_days=14)
    settings = dataclasses.replace(DEFAULT_SETTINGS, trust=trust14)
    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=snap, settings=settings
    )
    assert feed


def test_a_stale_snapshot_fails_closed() -> None:
    """The real gap A8.3 closes: a snapshot built long ago used to be served
    as fresh forever. Now it is refused under FAIL_CLOSED (the default) —
    consistent with how a missing/degraded snapshot is already refused."""
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    stale = TrustSnapshot(graph_creds={"a": _cred(0.5)}, built_at=NOW - timedelta(days=15))
    trust14 = dataclasses.replace(DEFAULT_SETTINGS.trust, max_snapshot_age_days=14)
    settings = dataclasses.replace(DEFAULT_SETTINGS, trust=trust14)
    with pytest.raises(MissingTrustError):
        rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=stale, settings=settings)
    # And it degrades loudly rather than silently under the permissive policy.
    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=stale, settings=settings,
        trust_policy=_PERMISSIVE,
    )
    assert feed


def test_max_snapshot_age_days_zero_disables_the_staleness_check() -> None:
    """0 = off (matches the codebase's own convention elsewhere), so a
    deployment that has not tuned this yet reproduces pre-A8.3 behaviour."""
    post = make_post("a", "1", votes=[make_vote("v", 1_000_000_000)])
    gateway = FakeGateway(in_network=[post])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    ancient = TrustSnapshot(graph_creds={"a": _cred(0.5)}, built_at=NOW - timedelta(days=3650))
    trust_off = dataclasses.replace(DEFAULT_SETTINGS.trust, max_snapshot_age_days=0)
    settings = dataclasses.replace(DEFAULT_SETTINGS, trust=trust_off)
    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, snapshot=ancient, settings=settings
    )
    assert feed


# ---------------------------------------------------------------------------
# C3 — `_score` must not silently drop exploration picks when the pool
# exceeds `diversity.top_k`. Reproduces `A11_pool_truncation.py`'s shape at
# test scale: enough padding authors to push the exploration pool past 200.
# ---------------------------------------------------------------------------


def test_exploration_pool_larger_than_top_k_loses_no_picks() -> None:
    # 220 established (well-engaged, need-tier >= 1) authors + 1 zero-
    # engagement debut = a 221-candidate exploration pool against the
    # shipped `diversity.top_k` of 200. Before the fix, `_score`'s internal
    # `rerank` truncated to 200 by SCORE, and the debut — the lowest-scoring
    # item in the pool by construction, which is also the #1 NEED pick the
    # lane exists to promote — was exactly the kind of item that fell off.
    in_network = [
        make_post(
            f"est{i:03d}", f"e{i}", category="photo", tags=("photo",),
            created_min=i, children=2,
            votes=[
                make_vote(f"r{i}a", 50_000_000),
                make_vote(f"r{i}b", 40_000_000),
                make_vote(f"r{i}c", 30_000_000),
            ],
        )
        for i in range(220)
    ]
    debut = make_post("newcomer", "debut", category="photo", tags=("photo",), created_min=300)
    gateway = FakeGateway(in_network=in_network, tag=[debut])
    viewer = make_viewer(
        "me",
        follows=frozenset(f"est{i:03d}" for i in range(220)),
        interest_tags=frozenset({"photo"}),
    )
    seat_secret = hashlib.sha256(b"test-pipeline-c3-large-pool-secret").digest()
    settings = Settings(exploration=ExplorationConfig(seat_secret=seat_secret))
    assert settings.diversity.top_k == 200  # the fixture only proves the point if pool > top_k

    feed = rank_feed(
        viewer, gateway, _explore_norm(), now=NOW, since=EPOCH, settings=settings,
        trust_policy=_PERMISSIVE,
    )
    authors = [sc.post.author for sc in feed]
    assert "newcomer" in authors, (
        "the #1 NEED pick was dropped by top_k truncation inside _score — the "
        "exact C3 defect"
    )
    assert authors[settings.exploration.position] == "newcomer"


def test_score_top_k_override_is_an_exact_noop_when_none() -> None:
    """`_score`'s new `top_k` parameter must not change ordinary (eligible
    pool) scoring by omission — this is the same pinned end-to-end shape as
    `test_exploration_reaches_the_served_feed_end_to_end`, just asserting the
    no-override path stays byte-identical."""
    gateway, viewer, _on, off = _explore_world()
    feed = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                     settings=off, trust_policy=_PERMISSIVE)
    assert len(feed) == 26  # 25 established + 1 debut, well under top_k=200


# ---------------------------------------------------------------------------
# C6 — POPULAR_FALLBACK's share of the returned feed is bounded by
# `FallbackConfig.max_share_of_feed`.
# ---------------------------------------------------------------------------


def test_popular_fallback_share_is_bounded_when_the_pool_is_thin_but_nonzero() -> None:
    # 20 real eligible posts (a viewer who is not fully cold) against a huge
    # popular pool that would, uncapped, pad the feed out to `top_k`.
    own = [make_post("live", f"l{i}") for i in range(20)]
    popular = [make_post(f"pop{i}", f"p{i}", author_reputation=60.0) for i in range(300)]
    gateway = FakeGateway(in_network=own, popular=popular)
    viewer = make_viewer("v", follows=frozenset({"live"}))

    feed = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH,
                     trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE)

    fallback_count = sum(1 for sc in feed if sc.source is CandidateSource.POPULAR_FALLBACK)
    share = fallback_count / len(feed)
    assert share <= DEFAULT_SETTINGS.fallback.max_share_of_feed + 1e-9, (
        f"padding was {share:.1%} of a {len(feed)}-post feed, over the "
        f"{DEFAULT_SETTINGS.fallback.max_share_of_feed:.0%} cap"
    )
    # The 20 real posts are never displaced by the cap — they still lead (as
    # a SET; they are identical apart from permlink so they tie on score and
    # the per-viewer tie-break, not insertion order, decides among them —
    # same shape as test_padding_never_outranks_the_viewers_own_posts).
    assert {sc.post.key for sc in feed[:20]} == {p.key for p in own}
    assert all(sc.post.author == "live" for sc in feed[:20])


def test_max_share_of_feed_one_point_zero_is_an_exact_noop() -> None:
    """1.0 disables the cap — byte-identical to pre-C6 behaviour."""
    own = [make_post("live", f"l{i}") for i in range(3)]
    popular = [make_post(f"pop{i}", f"p{i}", author_reputation=60.0) for i in range(60)]
    gateway = FakeGateway(in_network=own, popular=popular)
    viewer = make_viewer("v", follows=frozenset({"live"}))
    fallback_uncapped = dataclasses.replace(DEFAULT_SETTINGS.fallback, max_share_of_feed=1.0)
    settings = dataclasses.replace(DEFAULT_SETTINGS, fallback=fallback_uncapped)

    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=settings, trust_policy=_PERMISSIVE
    )
    # Uncapped: target = max(20, min(3+60, 200)) = 63 -> all 60 popular admitted.
    assert len(feed) == 63


# ---------------------------------------------------------------------------
# B-02 (2026-08-04): declared-interest scoring, end to end through rank_feed.
# ---------------------------------------------------------------------------


def test_declared_interest_end_to_end_prefers_the_matching_post() -> None:
    """With `interest_match` ON, two out-of-network candidates with otherwise
    IDENTICAL engagement must rank by tag overlap with the viewer's declared
    interests — the exact channel that was entirely absent before B-02
    (measured: two accounts with identical follows got the identical top-20
    set 33/48 of the time, because nothing read `viewer.interest_tags` at
    scoring time at all).

    Both candidates get real second-degree engagement from a follow (so
    neither is dropped, or silently RELABELLED to the ungated interest lane
    -- `second_degree._ungated_lane_for` -- purely because it happens to
    match a tag; that would prove the wrong mechanism)."""
    same_votes = [make_vote(f"v{i}", 2_000_000, minutes=i) for i in range(5)]
    matching = make_post("author-match", "m1", tags=("photo", "art"), votes=same_votes)
    other = make_post("author-other", "o1", tags=("cooking", "food"), votes=same_votes)
    gateway = FakeGateway(
        oon=[
            Candidate(post=matching, source=CandidateSource.OON_ENGAGED),
            Candidate(post=other, source=CandidateSource.OON_ENGAGED),
        ],
        engagers={matching.key: frozenset({"someone"}), other.key: frozenset({"someone"})},
    )
    viewer = make_viewer(
        "me", follows=frozenset({"someone"}), interest_tags=frozenset({"photo"})
    )
    weighted = dataclasses.replace(
        DEFAULT_SETTINGS,
        weights=dataclasses.replace(DEFAULT_SETTINGS.weights, interest_match=0.5),
    )

    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=weighted, trust_policy=_PERMISSIVE
    )
    authors = [sc.post.author for sc in feed]
    assert set(authors) == {"author-match", "author-other"}
    assert authors.index("author-match") < authors.index("author-other")


def test_declared_interest_end_to_end_is_a_no_op_at_the_default_off_weight() -> None:
    """Byte-identity through the full pipeline (not just score_candidate in
    isolation): a viewer with declared interests, scored under
    `interest_match=0.0`, must reproduce EXACTLY what an identical viewer with
    NO declared interests gets, all else equal."""
    same_votes = [make_vote(f"v{i}", 2_000_000, minutes=i) for i in range(5)]
    a = make_post("author-a", "a1", tags=("photo",), votes=same_votes)
    b = make_post("author-b", "b1", tags=("cooking",), votes=same_votes)
    gateway = FakeGateway(
        oon=[
            Candidate(post=a, source=CandidateSource.OON_ENGAGED),
            Candidate(post=b, source=CandidateSource.OON_ENGAGED),
        ],
        engagers={a.key: frozenset({"someone"}), b.key: frozenset({"someone"})},
    )
    off_settings = dataclasses.replace(
        DEFAULT_SETTINGS,
        weights=dataclasses.replace(DEFAULT_SETTINGS.weights, interest_match=0.0),
    )
    with_interests = make_viewer(
        "me", follows=frozenset({"someone"}), interest_tags=frozenset({"photo"})
    )
    without_interests = make_viewer("me", follows=frozenset({"someone"}))

    feed_with = rank_feed(
        with_interests, gateway, _norm(), now=NOW, since=EPOCH,
        settings=off_settings, trust_policy=_PERMISSIVE,
    )
    feed_without = rank_feed(
        without_interests, gateway, _norm(), now=NOW, since=EPOCH,
        settings=off_settings, trust_policy=_PERMISSIVE,
    )
    assert feed_with == feed_without


# ---------------------------------------------------------------------------
# B-04 (2026-08-04): the emerging-author budget, end to end through
# rank_feed — `_score` builds `emerging_authors` from `snap.graph_creds` and
# threads it into `rerank()`.
# ---------------------------------------------------------------------------


def test_emerging_author_budget_end_to_end_lets_an_unknown_author_through() -> None:
    """An author ABSENT from graph_creds entirely (never engaged, the
    structural newcomer state `requires_author_floor` already treats
    permissively) must be able to win a slot the ordinary unchosen quota has
    fully closed, via the SEPARATE emerging budget — while an author who IS
    in graph_creds at a normal/high standing does not get this exemption and
    is bound by the ordinary quota."""
    own_votes = [make_vote(f"vv{i}", 5_000_000, minutes=i) for i in range(9)]
    followed = [make_post("me-follow", f"f{i}") for i in range(3)]
    emerging_post = make_post(
        "emerging-author", "deb1", tags=("hive",), votes=own_votes,
    )
    established_spillover = make_post(
        "established-spillover", "sp1", tags=("hive",), votes=own_votes,
    )
    gateway = FakeGateway(
        in_network=followed,
        oon=[
            Candidate(post=emerging_post, source=CandidateSource.OON_ENGAGED),
            Candidate(post=established_spillover, source=CandidateSource.OON_ENGAGED),
        ],
        engagers={
            emerging_post.key: frozenset({"me-follow"}),
            established_spillover.key: frozenset({"me-follow"}),
        },
    )
    viewer = make_viewer("me", follows=frozenset({"me-follow"}))
    # Quota fully closed (share=0, min=0, ratio=0) but the toggle is ON, and
    # emerging_per_page gives exactly one bypass slot.
    tight = dataclasses.replace(
        DEFAULT_SETTINGS,
        diversity=dataclasses.replace(
            DEFAULT_SETTINGS.diversity,
            unchosen_max_per_page=1,
            unchosen_max_share=0.0,
            unchosen_min_per_page=0,
            unchosen_displacement_ratio=0.0,
            emerging_per_page=1,
        ),
    )
    # "established-spillover" IS in graph_creds, well above min_vouched_score
    # -- an ordinary engaged author, NOT emerging. "emerging-author" is
    # entirely absent from graph_creds. "me-follow" (the engager/voucher for
    # BOTH OON candidates) also needs a real entry once `graph_creds` is
    # non-empty: `second_degree.qualifying_engagers` only falls back to
    # count-only vouching when the WHOLE map is empty (Phase-0); with real
    # entries present, an engager absent from the map fails the vouch-quality
    # floor and both candidates would be silently dropped before scoring ever
    # runs -- not the mechanism this test is about.
    snap = TrustSnapshot(
        graph_creds={
            "established-spillover": GraphCred(
                account="established-spillover", score=0.9, follow_follower_ratio=1.0,
            ),
            "me-follow": GraphCred(account="me-follow", score=0.5, follow_follower_ratio=1.0),
        },
    )

    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=tight,
        snapshot=snap, trust_policy=_PERMISSIVE,
    )
    authors = [sc.post.author for sc in feed]
    assert "emerging-author" in authors
    # The ordinary engaged author has no exemption and queues behind it
    # relative to the emerging pick (both are unchosen, only one bypasses).
    assert authors.index("emerging-author") < authors.index("established-spillover")


def test_emerging_author_budget_end_to_end_zero_disables_it() -> None:
    """The control: `emerging_per_page=0` must leave a graph-cred-absent
    author with no exemption at all -- purely an ordinary unchosen candidate
    bound by the (here, fully closed) quota."""
    own_votes = [make_vote(f"vv{i}", 5_000_000, minutes=i) for i in range(9)]
    followed = [make_post("me-follow", f"f{i}") for i in range(3)]
    emerging_post = make_post("emerging-author", "deb1", tags=("hive",), votes=own_votes)
    gateway = FakeGateway(
        in_network=followed,
        oon=[Candidate(post=emerging_post, source=CandidateSource.OON_ENGAGED)],
        engagers={emerging_post.key: frozenset({"me-follow"})},
    )
    viewer = make_viewer("me", follows=frozenset({"me-follow"}))
    no_budget = dataclasses.replace(
        DEFAULT_SETTINGS,
        diversity=dataclasses.replace(
            DEFAULT_SETTINGS.diversity,
            unchosen_max_per_page=1,
            unchosen_max_share=0.0,
            unchosen_min_per_page=0,
            unchosen_displacement_ratio=0.0,
            emerging_per_page=0,
        ),
    )
    snap = TrustSnapshot(graph_creds={})

    feed = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=no_budget,
        snapshot=snap, trust_policy=_PERMISSIVE,
    )
    authors = [sc.post.author for sc in feed]
    # The 3 followed posts (chosen, exempt from the quota) still lead;
    # the emerging-but-unbudgeted author is pushed behind all of them.
    assert authors.index("emerging-author") >= 3


# ---------------------------------------------------------------------------
# P1 (2026-08-05) — a viewer never sees their OWN post in discovery.
#
# Live-proven on the real mirror by the 2026-08-05 council: `acidyo`'s own post
# ranked #1 in `acidyo`'s own discovery feed. Structural, not a fluke —
# `derive_interest_tags` reads your own posting history, so your tags are the
# tags you publish under, the interest lane sources by tag, and that lane is
# viewer-opted-in and therefore gate-exempt.
# ---------------------------------------------------------------------------


def test_a_viewer_never_sees_their_own_post_through_rank_feed() -> None:
    """★ END-TO-END, at the served feed — not at the candidate boundary. Two
    guards were needed (`filter_eligible` AND `eligible_for_exploration`),
    and only a whole-feed assertion proves BOTH."""
    mine = make_post("me", "mine", category="photo")
    theirs = make_post("other", "theirs", category="photo")
    gateway = FakeGateway(in_network=[mine, theirs], tag=[mine, theirs], popular=[mine, theirs])
    viewer = make_viewer("me", follows=frozenset({"other"}), interest_tags=frozenset({"photo"}))
    served = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
    authors = [sc.post.author for sc in served]
    assert "me" not in authors, f"the viewer was served their own post: {authors}"
    assert "other" in authors, "control: the other author must still be served"


def test_the_exploration_seat_cannot_be_taken_by_the_viewers_own_post() -> None:
    """★ THE SECOND PATH. `eligible_for_exploration` sources from the RAW pool
    and bypasses `filter_eligible` by design, so a guard added only there leaves
    a viewer's own post able to take position 13 — the most prominent slot on
    the page. Mutation-checked: removing the check in `exploration.py` (while
    keeping the one in `second_degree.py`) makes this fail."""
    mine = make_post("me", "mine", category="photo")
    viewer = make_viewer("me", interest_tags=frozenset({"photo"}))
    pool = eligible_for_exploration(
        [Candidate(post=mine, source=CandidateSource.OON_INTEREST)],
        viewer,
        now=NOW,
        graph_creds={},
        suppressed=frozenset(),
        show_nsfw=False,
        config=ExplorationConfig(seat_secret=b"k" * 32),
    )
    assert pool == [], "the viewer's own post entered the exploration pool"


def test_rank_feed_threads_ONE_counter_object_across_both_rerank_blocks() -> None:
    """★ THE WIRING TEST (C3, 2026-08-05), and it exists because the unit test
    was not enough.

    `test_author_penalty_carries_across_rerank_blocks` proves `diversity_rerank`
    HONOURS a carried counter. It does NOT prove `rank_feed` passes one —
    removing `carried=feed_counters` from the filler call left that unit test
    green. That is this project's documented failure mode: verified at the
    mechanism boundary instead of where the user experiences it.

    So this asserts the seam directly: both rerank calls of one feed receive the
    SAME object, and the second sees state accumulated by the first.
    """
    seen: list[object] = []
    real = pipeline_mod.rerank

    def _spy(*args: object, **kwargs: object) -> object:
        seen.append(kwargs.get("carried"))
        return real(*args, **kwargs)  # type: ignore[arg-type]

    # A starved viewer: one eligible post, so `_fallback_filler` pads and the
    # SECOND block actually runs. Without padding there is only one block and
    # the test would pass vacuously — hence the assertion on len(seen).
    post = make_post("alice", "p1")
    gateway = FakeGateway(in_network=[post], popular=_popular(30))
    viewer = make_viewer("me", follows=frozenset({"alice"}))
    pipeline_mod.rerank = _spy  # type: ignore[assignment]
    try:
        rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)
    finally:
        pipeline_mod.rerank = real  # type: ignore[assignment]

    carried_args = [c for c in seen if c is not None]
    assert len(carried_args) >= 2, (
        f"expected the eligible AND filler blocks to both rerank with a carried "
        f"counter; got {len(carried_args)} of {len(seen)} calls"
    )
    assert carried_args[0] is carried_args[1], (
        "the two blocks of one feed received DIFFERENT counter objects — "
        "author/topic spacing resets at the block boundary again"
    )


# ---------------------------------------------------------------------------
# The across-Hive popularity lane (2026-08-08)
# ---------------------------------------------------------------------------


def test_the_popularity_lane_reaches_a_viewer_whose_pool_is_already_healthy() -> None:
    """★ THE GAP THIS LANE CLOSES, pinned end to end. A viewer with a full
    in-network pool never triggers `_fallback_filler`, so before this lane the
    chain's biggest post was not merely out-ranked — it was NEVER A CANDIDATE,
    and no weight, penalty or quota could reach it."""
    own = [make_post("live", f"l{i}") for i in range(40)]
    viewer = make_viewer("busy", follows=frozenset({"live"}))
    gateway = FakeGateway(in_network=own, popular=_popular())

    without = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH,
                        trust_policy=_PERMISSIVE, settings=_NO_POPULAR_LANE)
    with_lane = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH,
                          trust_policy=_PERMISSIVE, settings=_POPULAR_LANE_ON)

    assert not any(sc.source is CandidateSource.OON_POPULAR for sc in without)
    assert any(sc.source is CandidateSource.OON_POPULAR for sc in with_lane), (
        "a healthy viewer must still be reachable by chain-wide popularity"
    )


def test_the_popularity_lane_rescues_a_dead_follow_graph() -> None:
    """The returning viewer whose every follow went quiet. Before, their pool
    was EMPTY and only unvetted padding saved them; now the lane fills it with
    author-floored candidates."""
    viewer = make_viewer("returning", follows=frozenset({"ghost1", "ghost2"}))
    gateway = FakeGateway(in_network=[], popular=_popular())
    pool = gather_candidates(viewer, gateway, EPOCH, 400, _POPULAR_LANE_ON)
    assert pool, "the lane must source for a viewer with no live follows"
    assert all(c.source is CandidateSource.OON_POPULAR for c in pool)


def test_the_popularity_lane_is_an_exact_no_op_at_limit_zero() -> None:
    """The rollback path, and the reason every pre-2026-08-08 measurement still
    reproduces: `PopularConfig.limit = 0` must be byte-identical to not having
    the lane at all."""
    own = [make_post("live", f"l{i}") for i in range(40)]
    viewer = make_viewer("busy", follows=frozenset({"live"}))
    # Asserted on the CANDIDATE POOL rather than the served feed, because the
    # fallback filler also reads `popular_posts` and legitimately pads a short
    # feed from it — that is a different mechanism and it is not what this
    # switch turns off. At `limit = 0` the lane must contribute nothing, so the
    # pool must be identical whether or not the gateway has popular posts at all.
    with_fixture = FakeGateway(in_network=own, popular=_popular())
    bare = FakeGateway(in_network=own)
    off = gather_candidates(viewer, with_fixture, EPOCH, 400, _NO_POPULAR_LANE)
    reference = gather_candidates(viewer, bare, EPOCH, 400, _NO_POPULAR_LANE)
    assert off == reference
    assert not any(c.source is CandidateSource.OON_POPULAR for c in off)
    # and with the lane ON the same gateway does contribute — otherwise the
    # assertion above would pass for a lane that is broken rather than off.
    on = gather_candidates(viewer, with_fixture, EPOCH, 400, _POPULAR_LANE_ON)
    assert any(c.source is CandidateSource.OON_POPULAR for c in on)


def test_the_popularity_lane_is_selected_by_credited_breadth_not_vote_count() -> None:
    """★ THE LANE'S ONE LOAD-BEARING PROPERTY. It is served to EVERY viewer, so
    a membership rule a farm can manufacture is a platform-wide amplifier.

    The gateway's SQL prefilter counts every identity equally; `select_popular`
    re-scores with the request's `VoterTrust` budget, under which a swarm of
    unknown-tier alts buys `unknown_free`, not one unit per alt. Here the
    farmed post has FOUR TIMES the raw voters and must still lose.
    """
    from recsys.config import ScoreWeights
    from recsys.core.popular import select_popular
    from recsys.core.vote_signal import VoterTrust

    farmed = make_post(
        "farm", "f1",
        votes=[make_vote(f"alt{i}", 7_000_000_000) for i in range(40)],
    )
    honest = make_post(
        "honest", "h1",
        votes=[make_vote(f"real{i}", 7_000_000_000) for i in range(10)],
    )
    trust = VoterTrust(
        vouched=frozenset(f"real{i}" for i in range(10)),
        unknown_free=1.0,
        unknown_per_vouched=0.0,
    )
    picked = select_popular(
        [farmed, honest],
        excluded_for=lambda a: frozenset({a}),
        trust=trust,
        weights=ScoreWeights(),
        limit=2,
    )
    assert [c.post.author for c in picked] == ["honest", "farm"]
    # ... and with no trust snapshot at all the raw count wins, which is exactly
    # why the snapshot is threaded rather than assumed.
    untrusted = select_popular(
        [farmed, honest],
        excluded_for=lambda a: frozenset({a}),
        trust=None,
        weights=ScoreWeights(),
        limit=2,
    )
    assert [c.post.author for c in untrusted] == ["farm", "honest"]


def test_the_popularity_lane_still_refuses_a_proven_self_dealer() -> None:
    """It is vouch-exempt (a chain-popular post has no in-network vouch by
    construction) but NOT floor-exempt — see `CandidateSource.OON_POPULAR`."""
    assert CandidateSource.OON_POPULAR.requires_second_degree is False
    assert CandidateSource.OON_POPULAR.requires_author_floor is True
    assert CandidateSource.OON_POPULAR.counts_toward_flooding_cap is True
    assert CandidateSource.OON_POPULAR.is_viewer_chosen is False


def test_a_popular_post_the_viewer_follows_is_labelled_in_network() -> None:
    """Dedup priority: the four lanes must not double-count each other, or no
    composition target means anything."""
    shared = make_post("live", "l1")
    viewer = make_viewer("busy", follows=frozenset({"live"}))
    gateway = FakeGateway(in_network=[shared], popular=[shared])
    pool = gather_candidates(viewer, gateway, EPOCH, 400, _POPULAR_LANE_ON)
    assert [c.source for c in pool if c.post.key == shared.key] == [
        CandidateSource.IN_NETWORK
    ]


# ---------------------------------------------------------------------------
# ★★★ THE NEWNESS HORIZON MUST REACH THE GATEWAY (2026-08-08).
#
# `author_first_post` is fast only because it may stop looking once an author is
# provably older than the horizon it is given, and it OMITS everyone older. That
# makes the horizon part of the contract, not a hint: if `rank_feed` stopped
# passing `settings.exploration.max_author_age_days` — or passed a different
# number — the gateway would bound its scan to one horizon while
# `eligible_for_exploration` tested against another, and the lane would refuse
# authors the config says are eligible. Nothing about the SERVED page would look
# wrong: the seat would just forfeit, exactly as it does when there is honestly
# no newcomer. So the ask is asserted directly.
# ---------------------------------------------------------------------------


def test_rank_feed_passes_the_configured_newness_horizon_to_the_gateway() -> None:
    gateway = FakeGateway(in_network=[make_post("alice", "a1")])
    viewer = make_viewer("me", follows=frozenset({"alice"}))

    for horizon in (30, 90):
        settings = dataclasses.replace(
            DEFAULT_SETTINGS,
            exploration=dataclasses.replace(
                DEFAULT_SETTINGS.exploration, max_author_age_days=horizon
            ),
        )
        rank_feed(
            viewer, gateway, _norm(), now=NOW, since=EPOCH,
            trust_policy=_PERMISSIVE, settings=settings,
        )
        call = gateway.last_first_post_call
        assert call is not None, "the newness lookup was never called"
        assert call["horizon_days"] == horizon, (
            f"gateway asked for horizon {call['horizon_days']!r} while the lane "
            f"tests against {horizon} — the SQL bound and the predicate have "
            "drifted apart, and the lane silently refuses eligible authors"
        )
        # The gateway derives its scan floor from `now`; letting it default to
        # wall-clock while the predicate uses the request's `now` would reopen
        # the same drift on any non-live clock (tests, replays, backfills).
        assert call["now"] == NOW, (
            "the gateway was not given the request's clock, so its scan floor "
            "and the predicate's threshold are computed from different `now`s"
        )


def test_exploration_lane_names_the_reason_it_is_empty(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A dead lookup and a genuinely empty pool serve the SAME page.

    The 2026-08-08 build reported the seat "correctly forfeits" for two real
    viewers while the query behind it was taking 311 seconds. Fail-closed turns
    a broken read into plausible-looking behaviour, so the only defence is that
    an empty lane states its cause. `newness_unavailable` means OUTAGE;
    `not_new` means the predicate worked.
    """
    old = NOW - timedelta(days=400)
    gateway = FakeGateway(
        in_network=[make_post("veteran", "v1")], first_post={"veteran": old}
    )
    viewer = make_viewer("me", follows=frozenset({"veteran"}))

    with caplog.at_level(logging.WARNING, logger="recsys.exploration"):
        rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    empty = [r for r in caplog.records if "pool EMPTY" in r.getMessage()]
    assert empty, "an empty exploration lane logged nothing at all"
    message = empty[0].getMessage()
    assert "not_new" in message, (
        f"the lane did not report WHY it emptied: {message!r}. Without a "
        "per-reason count, a 311s outage and 'no newcomer today' are "
        "indistinguishable in the logs as well as in the output."
    )
    assert "newness_unavailable" not in message, (
        "the lookup answered, so this must be reported as `not_new` (the "
        "predicate working), never as an outage"
    )


def test_an_unavailable_newness_lookup_is_reported_as_an_OUTAGE_not_as_not_new(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The two refusal reasons must never be collapsed.

    A gateway that cannot answer the newness question forfeits the seat on EVERY
    request, forever, and the served page is identical to a day with no
    newcomers. If that path were counted as `not_new`, the logs would report the
    predicate working normally while the lane was structurally dead — which is
    precisely how this project has shipped unreachable features before. Pin that
    an outage is named an outage.
    """

    class GatewayWithoutNewness(FakeGateway):
        author_first_post = None  # type: ignore[assignment]

    gateway = GatewayWithoutNewness(in_network=[make_post("newbie", "n1")])
    viewer = make_viewer("me", follows=frozenset({"newbie"}))

    with caplog.at_level(logging.WARNING, logger="recsys.exploration"):
        rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, trust_policy=_PERMISSIVE)

    empty = [r for r in caplog.records if "pool EMPTY" in r.getMessage()]
    assert empty, "the lane emptied on an unresolvable predicate and said nothing"
    message = empty[0].getMessage()
    assert "newness_unavailable" in message, (
        f"an unavailable newness lookup was not reported as an outage: "
        f"{message!r}. Counting it as `not_new` makes a dead lane read exactly "
        "like a quiet day."
    )
