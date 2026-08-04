"""Tests for the reserved new-author lane (cold-start spec §4.3, item B12)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from recsys.config import ExplorationConfig
from recsys.contracts import Candidate, CandidateSource, ScoreBreakdown, ScoredCandidate
from recsys.core.exploration import (
    eligible_for_exploration,
    graduated_keys,
    insert_exploration,
)
from tests.fakes import EPOCH, make_post, make_viewer

NOW = EPOCH + timedelta(days=30)


def _cand(author: str, permlink: str, *, days_old: int = 1,
          community: str | None = "hive-1", tags=("photo",)) -> Candidate:
    post = make_post(author=author, permlink=permlink, community=community, tags=tags)
    aged = type(post)(**{**post.__dict__, "created": NOW - timedelta(days=days_old)})
    return Candidate(post=aged, source=CandidateSource.OON_ENGAGED)


def _viewer():
    return make_viewer("v", subscribed_communities=frozenset({"hive-1"}),
                       interest_tags=frozenset({"photo"}))


def _cfg(**kw) -> ExplorationConfig:
    return ExplorationConfig(**kw)


def _scored(c: Candidate, final: float = 0.1) -> ScoredCandidate:
    return ScoredCandidate(
        post=c.post, source=c.source,
        score=ScoreBreakdown(vote_norm=0.0, rep_norm=0.0, organic=final, final=final),
    )


def _explore_pool(*cands: Candidate) -> list[ScoredCandidate]:
    """Build the pool the way the PIPELINE does — through
    `eligible_for_exploration`, which is what relabels the source. Constructing
    ScoredCandidates directly skips that and tests the wrong thing."""
    return [_scored(c) for c in _eligible(list(cands))]


def _eligible(cands, viewer=None, **kw):
    return eligible_for_exploration(
        cands, viewer or _viewer(), now=NOW,
        ring_members=kw.pop("ring_members", frozenset()),
        vouched_keys=kw.pop("vouched_keys", frozenset()),
        suppressed=kw.pop("suppressed", frozenset()),
        show_nsfw=kw.pop("show_nsfw", True),
        config=kw.pop("config", _cfg()),
    )


def test_a_fresh_interest_matched_post_is_eligible() -> None:
    got = _eligible([_cand("newcomer", "p1")])
    assert [c.post.author for c in got] == ["newcomer"]
    assert got[0].source is CandidateSource.EXPLORATION


def test_stale_posts_are_retired() -> None:
    assert _eligible([_cand("a", "p1", days_old=8)]) == []
    assert len(_eligible([_cand("a", "p1", days_old=6)])) == 1


def test_a_ring_member_never_gets_a_reserved_slot() -> None:
    """The lane skips the author floor by design, so ring exclusion is one of
    the few defences it has left. A farm must not be able to buy reach here."""
    assert _eligible([_cand("sock", "p1")], ring_members=frozenset({"sock"})) == []


def test_a_graduated_post_leaves_the_pool() -> None:
    """§4.3 graduation: once a post holds a qualifying vouch it has earned the
    normal lanes and must stop consuming the scarce reserved slot."""
    c = _cand("a", "p1")
    assert _eligible([c], vouched_keys=frozenset({c.post.key})) == []


def test_content_the_viewer_never_asked_for_is_not_eligible() -> None:
    """Interest-TARGETED: an unearned impression spent on content the viewer has
    shown no interest in is how a fresh lane becomes the thing users complain
    about."""
    assert _eligible([_cand("a", "p1", community="hive-999", tags=("crypto",))]) == []


def test_per_author_epoch_budget_caps_one_author() -> None:
    cands = [_cand("prolific", f"p{i}", days_old=i % 6) for i in range(9)]
    got = _eligible(cands, config=_cfg(max_posts_per_author_epoch=3))
    assert len(got) == 3


def test_rotation_is_round_robin_over_authors_not_first_come() -> None:
    """One author with many fresh posts must not take consecutive rounds ahead
    of other new authors waiting for the same lane."""
    cands = [_cand("prolific", f"p{i}") for i in range(3)] + [_cand("quiet", "q1")]
    got = _eligible(cands)
    assert [c.post.author for c in got][:2] == ["prolific", "quiet"]


def test_selection_is_deterministic_regardless_of_input_order() -> None:
    cands = [_cand("b", "p1"), _cand("a", "p1"), _cand("c", "p1"), _cand("a", "p2")]
    first = [c.post.key for c in _eligible(cands)]
    second = [c.post.key for c in _eligible(list(reversed(cands)))]
    assert first == second


def test_zero_slots_disables_the_lane_entirely() -> None:
    assert _eligible([_cand("a", "p1")], config=_cfg(slots_per_page=0)) == []


def test_insertion_never_displaces_anything() -> None:
    """A reserved slot may only ADD to a feed. If it could displace, the lane
    would be taking from the viewer rather than from unused space."""
    ranked = [_scored(_cand(f"a{i}", "p", days_old=1), final=1.0 - i / 100) for i in range(20)]
    pool = _explore_pool(_cand("newcomer", "n1"))
    out = insert_exploration(ranked, pool, _cfg())
    assert len(out) == len(ranked) + 1
    assert [c.post.key for c in ranked] == [
        c.post.key for c in out if c.source is not CandidateSource.EXPLORATION
    ]


def test_insertion_lands_at_the_configured_position() -> None:
    ranked = [_scored(_cand(f"a{i}", "p"), final=1.0 - i / 100) for i in range(20)]
    pool = _explore_pool(_cand("newcomer", "n1"))
    out = insert_exploration(ranked, pool, _cfg(position=13))
    assert out[13].source is CandidateSource.EXPLORATION


def test_insertion_into_an_empty_or_short_feed_is_safe() -> None:
    pool = _explore_pool(_cand("newcomer", "n1"))
    assert insert_exploration([], pool, _cfg()) == []
    short = [_scored(_cand("a", "p"))]
    assert len(insert_exploration(short, pool, _cfg())) == 1


def test_empty_pool_returns_the_feed_unchanged() -> None:
    ranked = [_scored(_cand(f"a{i}", "p")) for i in range(5)]
    assert insert_exploration(ranked, [], _cfg()) == ranked


def test_graduation_requires_a_QUALIFYING_voucher_not_any_engager() -> None:
    """§4.4 trusted graduation. If any engager graduated a post, a ring could
    vote up its own boosted post and promote it out of the budgeted lane into
    the unbudgeted ones."""
    index = {"@a/p1": frozenset({"ringmate"}), "@b/p1": frozenset({"real"})}
    assert graduated_keys(index, frozenset({"real"})) == frozenset({"@b/p1"})


@pytest.mark.parametrize("bad", [
    {"slots_per_page": -1},
    {"page_size": 0},
    {"position": 20},
    {"max_age_days": 0},
    {"max_posts_per_author_epoch": 0},
])
def test_config_refuses_incoherent_settings(bad: dict) -> None:
    with pytest.raises(ValueError):
        ExplorationConfig(**bad)


# ---------------------------------------------------------------------------
# Solo self-farmer (found by MEASUREMENT, 2026-08-04 — q5b, not by a test).
# The lane's other defences all miss a single account engaging with itself:
# no ring to detect, epoch budget not exceeded, no graph-cred entry to floor,
# genuinely fresh and genuinely interest-matched. It took the first slot and
# landed at position 13 in an established viewer's feed.
# ---------------------------------------------------------------------------


def _attributed(author: str, permlink: str, *, commenters=(), rebloggers=(),
                votes=(), days_old: int = 1) -> Candidate:
    from recsys.core.vote_signal import AttributedPost
    base = make_post(author=author, permlink=permlink, community="hive-1", tags=("photo",))
    fields = {**base.__dict__, "created": NOW - timedelta(days=days_old), "votes": votes}
    return Candidate(
        post=AttributedPost(**fields, commenters=commenters, rebloggers=rebloggers),
        source=CandidateSource.OON_ENGAGED,
    )


def test_self_commenter_is_not_eligible() -> None:
    got = _eligible([_attributed("farmer", "p1", commenters=("farmer",))])
    assert got == []


def test_self_reblogger_is_not_eligible() -> None:
    got = _eligible([_attributed("farmer", "p1", rebloggers=("farmer",))])
    assert got == []


def test_self_voter_is_not_eligible() -> None:
    from recsys.contracts import Vote
    vote = Vote(voter="farmer", rshares=100, timestamp=NOW)
    got = _eligible([_attributed("farmer", "p1", votes=(vote,))])
    assert got == []


def test_genuine_newcomer_with_real_engagement_stays_eligible() -> None:
    """The rule must be SELF-attribution, not "has engagement".

    A newcomer whose debut earned two real comments and an outside upvote is
    exactly who this lane is for; a rule of "credited engagement is zero" or
    "has any engagement" would drop them.
    """
    from recsys.contracts import Vote
    vote = Vote(voter="stranger", rshares=100, timestamp=NOW)
    got = _eligible([
        _attributed("newcomer", "p1", commenters=("alice", "bob"),
                    rebloggers=("carol",), votes=(vote,))
    ])
    assert [c.post.author for c in got] == ["newcomer"]


def test_self_dealing_is_judged_per_post_not_per_author() -> None:
    """A self-comment on one post must not disqualify the author's other posts.

    The penalty is losing THAT post's slot, not an author-level ban — an
    author-level rule would be a griefing handle (comment once on a rival's
    behalf) and is not what §8.4's self-exclusion does.
    """
    got = _eligible([
        _attributed("mixed", "farmed", commenters=("mixed",), days_old=1),
        _attributed("mixed", "clean", days_old=2),
    ])
    assert [c.post.permlink for c in got] == ["clean"]


def test_unattributed_post_fails_toward_silence_not_toward_exclusion() -> None:
    """A plain Post carries counters with no identity, so self-dealing is
    invisible and eligibility is unchanged — the same fail-toward-silence
    posture as `independent_vote_signal`. Production must hydrate attribution."""
    got = _eligible([_cand("unknown", "p1")])
    assert [c.post.author for c in got] == ["unknown"]


# ---------------------------------------------------------------------------
# The two ordering bugs that made the lane a measured no-op (2026-08-04).
# Both passed every unit test at the time — they only showed up as "the
# newcomer is still at position 99", which is why these are pinned here.
# ---------------------------------------------------------------------------


def test_authors_rotate_newest_first_not_alphabetically() -> None:
    """The spec says rotation WEIGHTED BY RECENCY; v1 dropped the weighting.

    With alphabetical order the scarce slot went to whoever sorted first, so an
    established author with one stale unvouched post outranked a newcomer who
    posted an hour ago — and renaming yourself `aaa-` bought the slot outright.
    """
    got = _eligible([
        _cand("aaa-established", "old", days_old=6),
        _cand("zzz-newcomer", "fresh", days_old=1),
    ])
    assert [c.post.author for c in got] == ["zzz-newcomer", "aaa-established"]


def test_pick_already_deep_in_the_feed_is_promoted_not_skipped() -> None:
    """De-duplicating against the ranked feed made the lane a no-op.

    Its central case is a post that IS in the feed and unreachable: measured, a
    newcomer's debut sat at position 99 of 200. Treating "already present" as
    "already served" meant the pool emptied and nothing was ever promoted.
    """
    feed = [_scored(_cand("est", f"e{i}")) for i in range(40)]
    target = _scored(_cand("newcomer", "debut"))
    feed.insert(30, target)

    out = insert_exploration(feed, [target], _cfg(page_size=20, position=13))

    assert [c.post.key for c in out].index(target.post.key) == 13
    assert len(out) == len(feed)  # promoted, not duplicated
    assert len({c.post.key for c in out}) == len(out)


def test_pick_already_ahead_of_the_slot_keeps_its_place() -> None:
    """A post already beating the slot must not be DEMOTED into it, and must
    not spend the slot either — the next pick gets it."""
    feed = [_scored(_cand("est", f"e{i}")) for i in range(40)]
    ahead = _scored(_cand("lucky", "already-high"))
    feed.insert(2, ahead)
    deep = _scored(_cand("newcomer", "debut"))
    feed.insert(35, deep)

    out = insert_exploration(feed, [ahead, deep], _cfg(page_size=20, position=13))

    keys = [c.post.key for c in out]
    assert keys.index(ahead.post.key) == 2      # untouched
    assert keys.index(deep.post.key) == 13      # got the slot instead
    assert len(out) == len(feed)


# ---------------------------------------------------------------------------
# Viewer-safety filters. The lane takes the RAW candidate set on purpose (it
# must contain posts that lose on score), which means it also skips every
# protection `filter_eligible` applies. The first build skipped all of them:
# MEASURED, a muted author landed at position 13 in the feed of the viewer who
# muted them.
# ---------------------------------------------------------------------------


def test_a_muted_author_never_reaches_the_exploration_slot() -> None:
    viewer = make_viewer("v", subscribed_communities=frozenset({"hive-1"}),
                         interest_tags=frozenset({"photo"}),
                         mutes=frozenset({"blocked"}))
    got = _eligible([_cand("blocked", "p1"), _cand("fine", "p2")], viewer)
    assert [c.post.author for c in got] == ["fine"]


def test_a_suppressed_post_never_reaches_the_exploration_slot() -> None:
    blocked = _cand("author", "bad")
    got = _eligible([blocked, _cand("author2", "ok")],
                    suppressed=frozenset({blocked.post.key}))
    assert [c.post.permlink for c in got] == ["ok"]


def test_nsfw_is_excluded_unless_the_viewer_opted_in() -> None:
    base = make_post(author="a", permlink="x", community="hive-1", tags=("photo",))
    nsfw = type(base)(**{**base.__dict__, "created": NOW - timedelta(days=1),
                         "is_nsfw": True})
    cand = Candidate(post=nsfw, source=CandidateSource.OON_ENGAGED)
    assert _eligible([cand], show_nsfw=False) == []
    assert len(_eligible([cand], show_nsfw=True)) == 1


# ---------------------------------------------------------------------------
# PIPELINE-LEVEL graduation. The unit tests above call
# `eligible_for_exploration` with hand-supplied `vouched_keys`, so they proved
# the function correct while the WIRING was dead: `rank_feed` fed it the
# `engager_index` built for the second-degree GATE, which covers only sources
# with `requires_second_degree` — today `OON_ENGAGED` and nothing else. For a
# pool drawn from every source, graduation was a membership test against a set
# that structurally could not contain the key. Only a pipeline-level test sees
# this, which is why it lives here.
# ---------------------------------------------------------------------------


def test_graduation_works_for_a_gate_exempt_lane_not_just_oon_engaged(monkeypatch) -> None:
    """★ Asserts on the POOL, not on the final feed.

    The first version of this test asserted the post's source in the returned
    feed was not EXPLORATION, and was VACUOUS: the fixture's feed is one item
    long, so `insert_exploration` breaks out at `at=13 > len(out)=1` and the
    source could never have been EXPLORATION whether graduation worked or not.
    It passed with the bug deliberately reintroduced. The bug is in what the
    pipeline PUTS IN THE POOL, so that is what gets asserted — verified to fail
    when `engager_keys` is reverted to `gated_keys`.
    """
    import recsys.pipeline as pipeline_mod
    from recsys.config import Settings
    from recsys.core.normalize import build_norm_context
    from recsys.pipeline import TrustPolicy, rank_feed
    from tests.fakes import FakeGateway

    settings = Settings()
    samples = [float(i) for i in range(50)]  # >= NormConfig.min_samples
    norms = build_norm_context(samples, samples, samples)

    post = make_post(author="newcomer", permlink="p1", community="hive-1", tags=("photo",))
    fresh = type(post)(**{**post.__dict__, "created": NOW - timedelta(hours=1)})

    viewer = make_viewer("v", follows=frozenset({"alice"}),
                         subscribed_communities=frozenset({"hive-1"}),
                         interest_tags=frozenset({"photo"}))

    # The SAME post + the SAME "alice (a follow) engaged it" fact, surfaced via
    # the community lane -- a lane with requires_second_degree == False.
    gateway = FakeGateway(community=[fresh], engagers={fresh.key: frozenset({"alice"})})

    seen: list[list[str]] = []
    real = pipeline_mod.insert_exploration

    def spy(ranked, pool, config):
        seen.append([c.post.key for c in pool])
        return real(ranked, pool, config)

    monkeypatch.setattr(pipeline_mod, "insert_exploration", spy)
    rank_feed(viewer, gateway, norms, now=NOW, since=EPOCH,
              settings=settings, trust_policy=TrustPolicy.WARN)

    # It holds a qualifying vouch from someone the viewer follows -> graduated,
    # so the normal machinery serves it and it must be OUT of the pool. With the
    # gate-only engager_index it stayed in forever.
    assert all(fresh.key not in pool for pool in seen)


def test_an_unvouched_post_in_the_same_lane_DOES_enter_the_pool(monkeypatch) -> None:
    """The control for the test above — without it, "not in the pool" would be
    satisfied by the pool simply always being empty."""
    import recsys.pipeline as pipeline_mod
    from recsys.config import Settings
    from recsys.core.normalize import build_norm_context
    from recsys.pipeline import TrustPolicy, rank_feed
    from tests.fakes import FakeGateway

    settings = Settings()
    samples = [float(i) for i in range(50)]
    norms = build_norm_context(samples, samples, samples)

    post = make_post(author="newcomer", permlink="p1", community="hive-1", tags=("photo",))
    fresh = type(post)(**{**post.__dict__, "created": NOW - timedelta(hours=1)})
    viewer = make_viewer("v", follows=frozenset({"alice"}),
                         subscribed_communities=frozenset({"hive-1"}),
                         interest_tags=frozenset({"photo"}))
    # identical, except nobody has vouched
    gateway = FakeGateway(community=[fresh], engagers={})

    seen: list[list[str]] = []
    real = pipeline_mod.insert_exploration

    def spy(ranked, pool, config):
        seen.append([c.post.key for c in pool])
        return real(ranked, pool, config)

    monkeypatch.setattr(pipeline_mod, "insert_exploration", spy)
    rank_feed(viewer, gateway, norms, now=NOW, since=EPOCH,
              settings=settings, trust_policy=TrustPolicy.WARN)

    assert any(fresh.key in pool for pool in seen)


def test_an_author_already_placed_ABOVE_the_slot_does_not_also_get_it() -> None:
    """One author, two slots on the same page — `diversity_rerank` cannot space
    them because the splice happens after it."""
    feed = [_scored(_cand("est", f"e{i}")) for i in range(40)]
    feed[5] = _scored(_cand("alice", "strong"))     # real reach, above the slot
    other = _scored(_cand("newcomer", "debut"))

    out = insert_exploration(feed, [_scored(_cand("alice", "fresh")), other],
                             _cfg(page_size=20, position=13))

    keys = [c.post.key for c in out]
    assert not any(c.post.permlink == "fresh" for c in out)   # declined
    assert keys.index(other.post.key) == 13                   # slot went to the newcomer
    assert sum(1 for c in out if c.post.author == "alice") == 1


def test_an_author_buried_BELOW_the_slot_is_still_promoted() -> None:
    """★ The regression that the first version of the author check caused.

    It compared against the whole feed, so the q3 newcomer's three debut posts
    — all buried together at 99/106/108 — each blocked the promotion of the
    other two, and the newcomer snapped straight back to position 99. Being at
    99 three times is not reach; it is the case the lane exists for.
    """
    feed = [_scored(_cand("est", f"e{i}")) for i in range(60)]
    debuts = [_scored(_cand("newcomer", f"debut-{i}")) for i in range(3)]
    for offset, d in zip((40, 45, 50), debuts, strict=True):
        feed.insert(offset, d)

    out = insert_exploration(feed, debuts, _cfg(page_size=20, position=13))

    assert [c.post.key for c in out].index(debuts[0].post.key) == 13
    assert len({c.post.key for c in out}) == len(out)          # no duplicates
    assert len(out) == len(feed)                               # nothing dropped


def test_the_author_check_does_not_break_promotion_of_the_pick_itself() -> None:
    """The pick's own key is excluded from the author comparison — a promoted
    post trivially "appears" in the feed as itself, and that is the whole
    central case."""
    feed = [_scored(_cand("est", f"e{i}")) for i in range(40)]
    target = _scored(_cand("newcomer", "debut"))
    feed.insert(30, target)

    out = insert_exploration(feed, [target], _cfg(page_size=20, position=13))

    assert [c.post.key for c in out].index(target.post.key) == 13
