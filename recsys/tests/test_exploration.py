"""Tests for the reserved new-author lane (cold-start spec §4.3, item B12)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from recsys.config import ExplorationConfig
from recsys.contracts import Candidate, CandidateSource, ScoreBreakdown, ScoredCandidate
from recsys.core.exploration import (
    eligible_for_exploration,
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


def test_a_post_that_already_outranks_the_slot_does_not_consume_it() -> None:
    """Graduation, positional. Replaces the spec's "0 qualifying vouches" rule,
    which was measured to drop a newcomer from 13 to ~115 the moment they earned
    their first real endorsement. The honest question is not "has someone
    vouched?" but "does this post still need the slot?"."""
    feed = [_scored(_cand("est", f"e{i}")) for i in range(40)]
    arrived = _scored(_cand("newcomer", "debut"))
    feed.insert(4, arrived)                      # already ahead of position 13
    later = _scored(_cand("other", "debut"))
    feed.insert(30, later)

    out = insert_exploration(feed, [arrived, later], _cfg(page_size=20, position=13))

    keys = [c.post.key for c in out]
    assert keys.index(arrived.post.key) == 4     # left alone, not demoted
    assert keys.index(later.post.key) == 13      # slot went to the one that needs it
    assert len(out) == len(feed)


def test_nobody_can_eject_a_newcomer_from_the_lane() -> None:
    """The old vouch rule was a griefing vector — a third party could eject a
    newcomer by vouching for them, which is why the spec had to make ejection
    expensive by requiring a QUALIFYING voucher. Positional graduation cannot be
    triggered by anyone other than the ranking itself."""
    from recsys.contracts import Vote
    votes = tuple(Vote(voter=f"griefer{i}", rshares=10**9, timestamp=NOW) for i in range(5))
    got = _eligible([_attributed("newcomer", "debut", votes=votes)])
    assert [c.post.author for c in got] == ["newcomer"]


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


def test_a_vouch_does_not_eject_a_post_from_the_lane(monkeypatch) -> None:
    """★ THE GRADUATION CLIFF — the regression this pins (2026-08-04).

    The spec ejected a post from the pool on its first qualifying vouch, on the
    premise that a vouch means it no longer needs the slot. Measured, false: the
    post still scores at the 3rd-4th percentile, so it fell from position 13 to
    102-123. And because graduation was viewer-relative, the fall happened
    exactly among the voucher's own followers:

        follows the voucher (x9) -> ejected -> debut at 102..123
        does not follow      (x1) -> in pool -> debut at  13

    A newcomer's first real endorsement was the thing that buried them. The post
    must now STAY in the pool; `insert_exploration` decides positionally whether
    it still needs the slot.
    """
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
    # alice is someone the viewer follows, and she has vouched for the debut.
    gateway = FakeGateway(community=[fresh], engagers={fresh.key: frozenset({"alice"})})

    seen: list[list[str]] = []
    real = pipeline_mod.insert_exploration

    def spy(ranked, pool, config):
        seen.append([c.post.key for c in pool])
        return real(ranked, pool, config)

    monkeypatch.setattr(pipeline_mod, "insert_exploration", spy)
    rank_feed(viewer, gateway, norms, now=NOW, since=EPOCH,
              settings=settings, trust_policy=TrustPolicy.WARN)

    assert any(fresh.key in pool for pool in seen)


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


def test_one_promotion_per_author_per_feed_even_when_pages_are_free() -> None:
    """★ An explicit POLICY, previously only an accident of the `i <= at` check.

    The round-robin builds depth-1/depth-2 entries per author, which reads like
    a promise of up to `max_posts_per_author_epoch` slots. It is not: the budget
    is ~10 slots in a 200-post feed and its purpose is spreading scarce reach
    across as many unheard authors as possible, so one author taking 3 of 10 is
    a direct loss. Pages without a pick are not empty — they carry normal
    content.
    """
    feed = [_scored(_cand("est", f"e{i}")) for i in range(200)]
    debuts = [_scored(_cand("newcomer", f"debut-{i}")) for i in range(3)]

    out = insert_exploration(feed, debuts, _cfg(page_size=20, position=13))

    keys = [c.post.key for c in out]
    assert keys.index(debuts[0].post.key) == 13
    # the 2nd and 3rd are NOT promoted, though pages 2..10 are all free
    assert debuts[1].post.key not in keys
    assert debuts[2].post.key not in keys


def test_a_second_author_still_gets_the_next_page_slot() -> None:
    """The control: one-per-author must not degrade into one-per-FEED."""
    feed = [_scored(_cand("est", f"e{i}")) for i in range(200)]
    a = _scored(_cand("newcomer-a", "d0"))
    b = _scored(_cand("newcomer-b", "d0"))

    out = insert_exploration(feed, [a, b], _cfg(page_size=20, position=13))

    keys = [c.post.key for c in out]
    assert keys.index(a.post.key) == 13
    assert keys.index(b.post.key) == 33


def test_rotation_is_ordered_by_NEED_not_by_post_recency() -> None:
    """★ The change that finally made the lane reach page 1 (2026-08-04).

    Recency is not newness. Nothing in eligibility tests whether an author is
    new, so an established author's quiet recent post qualifies identically —
    and under a pure recency key it took the slot for being a few hours fresher.
    Measured, simworld seed 7: the pool's first four authors had received 27,
    53, 22 and 27 engagements; the newcomer (0 received) was fifth and got page
    2. With need-first ordering the newcomer takes position 13 — the actual
    reserved slot — and q3 panel [A] flipped to `top-20 hit: True`.
    """
    veteran = _attributed("veteran", "quiet", days_old=0,
                          commenters=tuple(f"reader{i}" for i in range(12)))
    newcomer = _cand("newcomer", "debut", days_old=1)  # older, but 0 received

    got = _eligible([veteran, newcomer])

    assert [c.post.author for c in got] == ["newcomer", "veteran"]


def test_need_ordering_keeps_recency_as_the_tie_break() -> None:
    """Among equally-unheard authors, behaviour is exactly as before."""
    got = _eligible([_cand("older", "p", days_old=3), _cand("fresher", "p", days_old=1)])
    assert [c.post.author for c in got] == ["fresher", "older"]


def test_one_griefer_cannot_demote_a_newcomer_by_commenting_repeatedly() -> None:
    """★ The need key is a field the ATTACKER writes on the VICTIM.

    The first version summed raw `len(votes) + children + reblog_count`, and
    `children` is incremented by anyone who comments. Measured: ONE griefer
    account, 5 comments per post, moved the newcomer from slot 13 (page 1) to
    slot 53 (page 3) for every viewer. Counting DISTINCT identities caps any one
    griefer at +1, so demotion costs an account per unit of harm, not a comment.
    """
    griefed = _attributed("newcomer", "debut", days_old=0,
                          commenters=("griefer",) * 30, rebloggers=("griefer",))
    rival = _attributed("rival", "p", days_old=1, commenters=("a", "b"))

    got = _eligible([griefed, rival])

    # 1 distinct griefer < 2 distinct readers -> the newcomer still leads
    assert [c.post.author for c in got] == ["newcomer", "rival"]


def test_genuine_distinct_readers_DO_count_as_being_heard() -> None:
    """The control. The rule must not become "engagement never counts" — an
    author five different people have engaged really has been heard, and should
    yield the scarce slot to someone nobody has read yet."""
    heard = _attributed("heard", "p", days_old=0,
                        commenters=("a", "b", "c"), rebloggers=("d", "e"))
    unheard = _cand("unheard", "p", days_old=1)

    got = _eligible([heard, unheard])

    assert [c.post.author for c in got] == ["unheard", "heard"]
