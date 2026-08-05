"""Tests for the reserved new-author lane (cold-start spec §4.3, item B12)."""

from __future__ import annotations

import hashlib
import os
import pathlib
from datetime import timedelta

import pytest

from recsys.config import ExplorationConfig
from recsys.contracts import (
    Candidate,
    CandidateSource,
    GraphCred,
    ScoreBreakdown,
    ScoredCandidate,
    Vote,
)
from recsys.core.exploration import (
    eligible_for_exploration,
    insert_exploration,
)
from tests.fakes import EPOCH, make_post, make_viewer, make_vote

NOW = EPOCH + timedelta(days=30)


def _cred(account: str, score: float) -> GraphCred:
    return GraphCred(account=account, score=score, follow_follower_ratio=1.0)


def _cand(author: str, permlink: str, *, days_old: int = 1,
          category: str = "photo", tags=("photo",)) -> Candidate:
    post = make_post(author=author, permlink=permlink, category=category, tags=tags)
    aged = type(post)(**{**post.__dict__, "created": NOW - timedelta(days=days_old)})
    return Candidate(post=aged, source=CandidateSource.OON_ENGAGED)


def _viewer():
    return make_viewer("v", interest_tags=frozenset({"photo"}))


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
        graph_creds=kw.pop("graph_creds", {}),
        suppressed=kw.pop("suppressed", frozenset()),
        show_nsfw=kw.pop("show_nsfw", True),
        config=kw.pop("config", _cfg()),
        bucket=kw.pop("bucket", 0),
    )


def test_a_fresh_interest_matched_post_is_eligible() -> None:
    got = _eligible([_cand("newcomer", "p1")])
    assert [c.post.author for c in got] == ["newcomer"]
    assert got[0].source is CandidateSource.EXPLORATION


def test_stale_posts_are_retired() -> None:
    assert _eligible([_cand("a", "p1", days_old=8)]) == []
    assert len(_eligible([_cand("a", "p1", days_old=6)])) == 1


def test_a_proven_self_dealer_never_gets_a_reserved_slot() -> None:
    """★ C4 (2026-08-04): the lane's rewritten defence.

    The lane skips the author floor by design, so SOME identity check is one
    of the few defences it has left. It now excludes on the PROVEN self-dealt
    band graph-cred already computes (``score <= 0.0``), the same bar
    `_fallback_filler` uses — not the raw ring flag. See the companion test
    below for why the flag alone was the wrong bar."""
    creds = {"sock": _cred("sock", 0.0)}
    assert _eligible([_cand("sock", "p1")], graph_creds=creds) == []


def test_a_ring_flagged_author_with_real_outside_engagement_still_gets_the_slot() -> None:
    """★ THE REGRESSION C4 FIXES (2026-08-04) — this is the actual bug, not
    just a rename of the test above.

    Measured (`A10c_reach_correct.py`): a victim with real outside engagement
    keeps `cred = 0.5068` (the documented graph-cred protection holds) but was
    ALSO `ring_flagged = True` under the old rule, and the raw flag alone shut
    this lane for them — page1 60/60 -> 0/60, exploration slots 60 -> 0.
    `A5_suppression_compose.py`: two reusable sock accounts flag 100/100
    victims this way for 0.02 accounts/victim, not the "2 accounts/victim"
    `tests/test_rival_suppression.py`'s docstring records — and the same
    attack HANDS THE SEAT TO THE ATTACKER instead of merely griefing (seat13
    0/60 -> 60/60 in that measurement), so the old rule let suppression pay.

    A ring-flagged author's graph-cred score is untouched by the flag alone —
    only PROVEN self-dealing (scale or a repeated pattern, see
    ``GraphCredConfig.min_ring_self_dealing_events``) zeroes it — so this
    victim sits well above the 0.0 exclusion band even though `ring_members`
    still names them. The lane must keep them.
    """
    creds = {"victim": _cred("victim", 0.5068)}
    got = _eligible([_cand("victim", "p1")], graph_creds=creds)
    assert [c.post.author for c in got] == ["victim"]


def test_an_author_with_no_graph_cred_entry_is_not_excluded() -> None:
    """The control: a true newcomer has no entry in `graph_creds` at all
    (nobody has scored them yet), and that must fail OPEN — the same posture
    the graph-cred floor takes everywhere else — not be treated as
    self-dealt by absence."""
    assert [c.post.author for c in _eligible([_cand("newcomer", "p1")], graph_creds={})] == [
        "newcomer"
    ]


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
    assert _eligible([_cand("a", "p1", category="crypto", tags=("crypto",))]) == []


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
    {"rotation_hours": -1},
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
    base = make_post(author=author, permlink=permlink, category="photo", tags=("photo",))
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
    viewer = make_viewer("v", interest_tags=frozenset({"photo"}),
                         mutes=frozenset({"blocked"}))
    got = _eligible([_cand("blocked", "p1"), _cand("fine", "p2")], viewer)
    assert [c.post.author for c in got] == ["fine"]


def test_a_suppressed_post_never_reaches_the_exploration_slot() -> None:
    blocked = _cand("author", "bad")
    got = _eligible([blocked, _cand("author2", "ok")],
                    suppressed=frozenset({blocked.post.key}))
    assert [c.post.permlink for c in got] == ["ok"]


def test_nsfw_is_excluded_unless_the_viewer_opted_in() -> None:
    base = make_post(author="a", permlink="x", category="photo", tags=("photo",))
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

    post = make_post(author="newcomer", permlink="p1", category="photo", tags=("photo",))
    fresh = type(post)(**{**post.__dict__, "created": NOW - timedelta(hours=1)})
    viewer = make_viewer("v", follows=frozenset({"alice"}),
                         interest_tags=frozenset({"photo"}))
    # alice is someone the viewer follows, and she has vouched for the debut.
    gateway = FakeGateway(tag=[fresh], engagers={fresh.key: frozenset({"alice"})})

    seen: list[list[str]] = []
    real = pipeline_mod.insert_exploration

    # ★ `**kwargs` (2026-08-04, BUILDER-11 C2c wiring fallout): `rank_feed` now
    # passes `lineage=` to `insert_exploration` (the per-farm lineage bound was
    # built and accepted the argument but nothing supplied it — see
    # `recsys/pipeline.py`'s call site). This spy only inspects `pool`, so it
    # must forward whatever it is called with rather than hard-coding a stale
    # 3-arg signature; it is a pass-through recorder, not a behavior fixture.
    def spy(ranked, pool, config, **kwargs):
        seen.append([c.post.key for c in pool])
        return real(ranked, pool, config, **kwargs)

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

    post = make_post(author="newcomer", permlink="p1", category="photo", tags=("photo",))
    fresh = type(post)(**{**post.__dict__, "created": NOW - timedelta(hours=1)})
    viewer = make_viewer("v", follows=frozenset({"alice"}),
                         interest_tags=frozenset({"photo"}))
    # identical, except nobody has vouched
    gateway = FakeGateway(tag=[fresh], engagers={})

    seen: list[list[str]] = []
    real = pipeline_mod.insert_exploration

    # ★ `**kwargs` (2026-08-04, BUILDER-11 C2c wiring fallout) — see the sibling
    # test above for why: this spy only inspects `pool` and must forward
    # whatever it is called with rather than hard-coding a stale 3-arg shape.
    def spy(ranked, pool, config, **kwargs):
        seen.append([c.post.key for c in pool])
        return real(ranked, pool, config, **kwargs)

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


def test_the_lane_never_reorders_the_feed_it_was_given() -> None:
    """★ THE NON-HARM INVARIANT, multi-pick (2026-08-04).

    `test_insertion_never_displaces_anything` pins this for ONE pick. The
    interesting case is several, spliced across pages, because that is when a
    promotion pops an item out of the middle of the list while later inserts are
    still shifting indices — the shape where an off-by-one silently reorders the
    viewer's own feed.

    The lane's contract is that it SHIFTS and never REORDERS: strip the picks out
    of the result and what is left must be the input, in the input's order. That
    is what makes "reserving a slot" honest — the cost is one position of drift
    per pick placed above you, never a re-ranking of content the viewer earned.
    """
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(80)]
    # Three different authors so each is entitled to its own page slot, and one
    # of them is ALREADY deep in the feed so a promotion (pop + insert) happens.
    buried = _scored(_cand("newcomer-c", "d"))
    ranked.insert(60, buried)
    pool = [_scored(_cand("newcomer-a", "d")), _scored(_cand("newcomer-b", "d")), buried]

    out = insert_exploration(ranked, pool, _cfg(page_size=20, position=13))

    picks = {c.post.key for c in pool}
    assert [c.post.key for c in out if c.post.key not in picks] == [
        c.post.key for c in ranked if c.post.key not in picks
    ]
    # and nothing was lost on the way through
    assert set(picks) | {c.post.key for c in ranked} == {c.post.key for c in out}


def test_a_pick_already_in_the_feed_is_never_pushed_deeper_than_the_shift() -> None:
    """★ The other half of non-harm: the lane must not COST its own beneficiary.

    A pick that already sits above its slot is left where it is — but earlier
    picks inserted above it still shift it down by one each. That bounded drift
    is the honest statement; anything larger would mean the lane demoted someone
    it was built to help, which is the exact failure the vouch-graduation rule
    produced (position 13 -> ~115) before graduation was made positional.
    """
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(80)]
    early = _scored(_cand("newcomer-b", "d"))
    # Index 15: BELOW page 1's slot (13) so the first insert really does shift
    # it, and ABOVE page 2's slot (33) so it declines that one and stays put.
    # A test that put it above every slot would pass while exercising nothing.
    ranked.insert(15, early)
    fresh = _scored(_cand("newcomer-a", "d"))    # not in the feed at all
    was = [c.post.key for c in ranked]
    before = was.index(early.post.key)

    out = insert_exploration(ranked, [fresh, early], _cfg(page_size=20, position=13))

    keys = [c.post.key for c in out]
    after = keys.index(early.post.key)
    inserted_above = sum(1 for k in keys[:after] if k not in was)
    assert inserted_above == 1                 # `fresh` took the page-1 slot
    assert after - before == inserted_above    # drift is exactly the shift, no more


# --- clock rotation of the seat (2026-08-04) --------------------------------


def test_the_seat_is_stable_inside_a_bucket_and_moves_between_them() -> None:
    """★ Why this exists: nothing counts serves, so without rotation a post that
    earns nothing holds a given viewer's seat for its whole eligibility window —
    and the pipeline has no randomness, so that viewer sees the same newcomer in
    the same position on every refresh for days.

    ★ The buckets here are chosen so the shuffle is genuinely ACTIVE. An earlier
    version used 4 authors at bucket 100 and 3 at bucket 99; both are exact
    multiples, so under the old index rotation the offset was 0 and the test
    read the UNROTATED order while claiming to have verified rotation.

    ★ PINNED SECRET (C1a, 2026-08-04): with the config default (an
    unconfigured, per-process-RANDOM dev secret), ``first[0] != later[0]``
    has a genuine, non-negligible chance of coinciding across only two sample
    buckets — this is exactly the flakiness the mandatory attack test's
    `honest_baseline` math predicts (~1-in-5 for a 5-author tier), not a
    hypothetical. Caught by 8 repeated local runs during review. An explicit
    fixed secret makes the demonstration reproducible, same rationale as the
    pool-churn test above.
    """
    secret = hashlib.sha256(b"seat-stability-fixed-secret-v2").digest()
    cfg = _cfg(seat_secret=secret)
    cands = [_cand(a, "p") for a in ("ann", "bob", "cass", "dan", "eve")]

    first = [c.post.author for c in _eligible(cands, bucket=101, config=cfg)]
    later = [c.post.author for c in _eligible(cands, bucket=102, config=cfg)]
    unrotated = [c.post.author for c in _eligible(cands, bucket=0, config=cfg)]

    assert first != unrotated          # the shuffle really ran
    assert first[0] != later[0]        # next bucket, someone else gets the seat
    assert sorted(first) == sorted(later) == sorted(unrotated)   # same pool


def test_pool_churn_inside_a_bucket_does_not_reroll_the_seat() -> None:
    """★★ THE PROPERTY THE FIRST IMPLEMENTATION GOT WRONG.

    It rotated by `bucket % len(tier)`, which makes the seat a function of TIER
    SIZE — so a post arriving or ageing out anywhere in the tier, even at the
    tail, re-rolled the seat mid-bucket. Measured then: an older post arriving
    moved the seat 85% of the time and the tail ageing out moved it 76%, both
    0% before rotation existed. Ageout is continuous on a live site, so the
    "stable inside a bucket" promise failed exactly where it has to hold — and
    it let an attacker choose the occupant by publishing or withholding a post.

    Keying each author independently of the tier's composition is what fixes it.

    ★ PINNED SECRET (C1a, 2026-08-04). The rotation key is now MAC-keyed (see
    `_rotation_key`), so — unlike before — the exact winner among a set of
    named authors is a function of the secret, not just the names and bucket.
    Left on the config default (an unconfigured, per-process-RANDOM dev
    secret), this demonstration would occasionally show a genuinely new tied
    member (zoe/older) winning the seat outright by chance, which is a
    DIFFERENT and legitimate event ("a new equally-needy candidate can win"),
    not the bug this test pins. An explicit fixed secret makes the concrete
    demonstration reproducible, exactly as the file already pins specific
    bucket values and author-name patterns elsewhere to keep a demonstration
    "genuinely active" rather than an accident of the inputs — see this
    module's own remark on 4-vs-3-author buckets above.
    """
    secret = hashlib.sha256(b"pool-churn-fixed-secret").digest()
    cfg = _cfg(seat_secret=secret)
    base = [_cand(a, "p") for a in ("ann", "bob", "cass", "dan", "eve")]
    bucket = 101
    seat = _eligible(base, bucket=bucket, config=cfg)[0].post.author

    # someone new joins the tier
    joined = _eligible([*base, _cand("zoe", "p")], bucket=bucket, config=cfg)
    # the tail member ages out of the window entirely
    left = _eligible(base[:-1], bucket=bucket, config=cfg)
    # an OLDER post arrives — under the old key this alone moved the seat
    older = _eligible([*base, _cand("older", "p", days_old=5)], bucket=bucket, config=cfg)

    for label, got in (("join", joined), ("ageout", left), ("older", older)):
        assert got[0].post.author == seat, f"{label} re-rolled the seat mid-bucket"


def test_the_shuffle_is_stable_across_processes() -> None:
    """`hash()` is randomised per process; two replicas serving one viewer must
    agree, and this package has just removed exactly this class of
    nondeterminism from the harness. Pinning a concrete expected order is what
    makes a regression to `hash()` (or to an unkeyed digest — see C1a) fail
    here rather than in production.

    ★ UPDATED for C1a (2026-08-04): `_rotation_key` now REQUIRES a secret
    (keyed `blake2b`, not the bare unkeyed digest this test used to pin — see
    `test_the_old_unkeyed_rotation_grind_no_longer_wins_the_seat` for why the
    old, keyless shape was a critical vulnerability). The pinned value below
    is for one FIXED test secret; unlike the old pin it says nothing about
    what any other secret produces, which is the entire point of a MAC.
    """
    from recsys.core.exploration import _rotation_key

    secret = hashlib.sha256(b"test-only-fixed-secret").digest()
    assert _rotation_key("ann", 101, secret).hex() == "1ce93c78dbbeebdf"
    assert _rotation_key("ann", 102, secret) != _rotation_key("ann", 101, secret)
    assert _rotation_key("bob", 101, secret) != _rotation_key("ann", 101, secret)
    # A DIFFERENT secret must produce a DIFFERENT order for the same inputs —
    # otherwise `key=` would be decorative. This is the MAC property itself.
    other_secret = hashlib.sha256(b"a-different-secret").digest()
    assert _rotation_key("ann", 101, other_secret) != _rotation_key("ann", 101, secret)


def test_posting_more_often_does_not_buy_the_seat_from_a_quiet_author() -> None:
    """The need key's second component was the recency of the author's newest
    post, so at identical zero engagement a prolific author held standing
    precedence over a quiet one. The keyed shuffle is what removes it; this pins
    that the prolific author does NOT simply own the seat."""
    prolific = [_cand("zz-prolific", f"p{i}", days_old=0) for i in range(3)]
    quiet = [_cand("aa-quiet", "p", days_old=2)]

    seats = {_eligible(prolific + quiet, bucket=b)[0].post.author for b in range(101, 121)}

    assert "aa-quiet" in seats, "the quiet author never gets the seat"


def test_rotation_never_lets_a_heard_author_overtake_an_unheard_one() -> None:
    """The constraint that makes rotation safe. Rotating the whole ordering
    would handed the scarce seat to someone already being read, undoing the
    least-heard-first rule that is the only reason this lane reaches its target.
    Only authors on the SAME need tier trade places.
    """
    unheard = [_cand(a, "p") for a in ("ann", "bob")]
    heard = [
        _attributed("popular", "p", commenters=("x", "y", "z"), rebloggers=("w",)),
        _attributed("famous", "p", commenters=("m", "n", "o", "p2"), rebloggers=("q",)),
    ]
    for bucket in range(6):
        order = [c.post.author for c in _eligible(unheard + heard, bucket=bucket)]
        assert set(order[:2]) == {"ann", "bob"}, f"bucket {bucket} promoted a heard author"


def test_a_uniquely_neediest_author_keeps_the_seat_in_every_bucket() -> None:
    """A tier of one cannot rotate — and should not. With one genuine newcomer
    among established authors, the newcomer must not lose page one to a clock.
    This is also why switching rotation on moved no measurement panel.
    """
    newcomer = _cand("newcomer", "debut")
    others = [
        _attributed(a, "p", commenters=("x", "y"), rebloggers=("z",))
        for a in ("est1", "est2", "est3")
    ]
    for bucket in range(8):
        assert _eligible([newcomer, *others], bucket=bucket)[0].post.author == "newcomer"


def test_rotation_switches_off_cleanly() -> None:
    """`rotation_hours = 0` must reproduce the pre-rotation ordering exactly, so
    the behaviour can be reverted by config alone if it misbehaves live."""
    cands = [_cand(a, "p") for a in ("ann", "bob", "cass")]
    off = _cfg(rotation_hours=0)
    assert [c.post.author for c in _eligible(cands, bucket=99, config=off)] == [
        c.post.author for c in _eligible(cands, bucket=0)
    ]


# ---------------------------------------------------------------------------
# C1a — the seat-rotation key is now SECRET-KEYED, not the bare unkeyed
# `blake2b` the module shipped with (2026-08-04, CRITICAL).
#
# THE BUG: `_rotation_key(author, bucket) = blake2b(f"{bucket}:{author}")` took
# no viewer and no secret, and `bucket` is derived from the wall clock alone —
# computable offline for the next decade by anyone, for a name that does not
# even need to exist yet. Measured (`A1_namegrind.py`, `A13_setcover_e2e.py`):
# 6 accounts + ~92,546 offline hashes (~0.08s) held the reserved seat in
# 613/720 (bucket, viewer) cells — 85.1% — against 60 honest silent rivals,
# with ZERO votes, comments, reblogs, or ring flags. 5 ground accounts beat 20
# un-ground ones; cost was near-flat in the size of the honest field.
# ---------------------------------------------------------------------------


def test_rotation_key_actually_uses_the_secret_not_merely_accepts_it() -> None:
    """Narrow, fast pin of the MAC property itself: a regression that widens
    `_rotation_key`'s signature to accept `secret` but forgets to thread it
    into `blake2b(key=...)` — i.e. silently keeps computing the OLD unkeyed
    digest — would pass every OTHER test in this module (none of them pins a
    specific value against a specific secret except this one and the process-
    stability test above) and must be caught here."""
    from recsys.core.exploration import _rotation_key

    a = _rotation_key("ann", 101, b"\x00" * 32)
    b = _rotation_key("ann", 101, b"\x01" * 32)
    assert a != b, "the digest does not depend on the secret at all"
    unkeyed = hashlib.blake2b(b"101:ann", digest_size=8).digest()
    assert a != unkeyed and b != unkeyed, "the digest silently ignores key= and falls back to it"


def test_two_replicas_with_the_same_secret_produce_byte_identical_order() -> None:
    """★ REQUIRED (C1a): 'Two replicas with the same secret MUST produce
    byte-identical order.' Simulated as two INDEPENDENTLY constructed
    `ExplorationConfig` objects sharing only the secret BYTES — standing in
    for two separate server processes that were handed the same deploy
    artifact, not two references to the same Python object. This is the
    property that makes the reserved seat coherent across a fleet at all."""
    secret = hashlib.sha256(b"shared-deploy-secret").digest()
    cands = [_cand(a, "p") for a in ("ann", "bob", "cass", "dan", "eve")]
    replica_a = _eligible(cands, bucket=101, config=ExplorationConfig(seat_secret=secret))
    replica_b = _eligible(cands, bucket=101, config=ExplorationConfig(seat_secret=secret))
    assert [c.post.key for c in replica_a] == [c.post.key for c in replica_b]
    # and a THIRD replica with a DIFFERENT secret must generally disagree —
    # otherwise the equality above would be vacuous (any two configs agree).
    other = _eligible(
        cands, bucket=101,
        config=ExplorationConfig(seat_secret=hashlib.sha256(b"a different key").digest()),
    )
    assert [c.post.key for c in other] != [c.post.key for c in replica_a]


def test_rotation_activation_bucket_selects_between_old_and_new_secret() -> None:
    """★ REQUIRED (C1a): 'Rotation carries an ACTIVATION BUCKET so all
    replicas switch at the same bucket regardless of deploy time.' Without it
    a staggered deploy has replicas disagreeing on the occupant for the whole
    rollout window — exactly the property `rotation_hours` exists to prevent.

    Buckets strictly BEFORE the activation point must resolve identically to
    a config running the OLD secret alone; buckets at or after it must match
    a config running the NEW secret alone.
    """
    old_secret = hashlib.sha256(b"old-deploy-secret").digest()
    new_secret = hashlib.sha256(b"new-deploy-secret").digest()
    cands = [_cand(a, "p") for a in ("ann", "bob", "cass", "dan", "eve")]
    rolling = ExplorationConfig(
        seat_secret=new_secret,
        previous_seat_secret=old_secret,
        seat_secret_active_from_bucket=200,
    )
    only_old = ExplorationConfig(seat_secret=old_secret)
    only_new = ExplorationConfig(seat_secret=new_secret)

    before = [c.post.key for c in _eligible(cands, bucket=199, config=rolling)]
    before_expected = [c.post.key for c in _eligible(cands, bucket=199, config=only_old)]
    at_activation = [c.post.key for c in _eligible(cands, bucket=200, config=rolling)]
    at_activation_expected = [c.post.key for c in _eligible(cands, bucket=200, config=only_new)]
    well_after = [c.post.key for c in _eligible(cands, bucket=999, config=rolling)]
    well_after_expected = [c.post.key for c in _eligible(cands, bucket=999, config=only_new)]

    assert before == before_expected
    assert at_activation == at_activation_expected
    assert well_after == well_after_expected


def test_production_with_no_seat_secret_is_refused() -> None:
    """'Absent secret in production -> RAISE at Settings construction.' Never
    silently unkeyed, never silently disable the lane."""
    with pytest.raises(ValueError):
        ExplorationConfig(production=True)


def test_production_with_a_seat_secret_is_accepted() -> None:
    ExplorationConfig(production=True, seat_secret=b"0" * 32)  # must not raise


def test_seat_secret_must_be_exactly_32_bytes() -> None:
    with pytest.raises(ValueError):
        ExplorationConfig(seat_secret=b"too-short")


def test_previous_seat_secret_must_be_exactly_32_bytes_too() -> None:
    with pytest.raises(ValueError):
        ExplorationConfig(seat_secret=b"1" * 32, previous_seat_secret=b"short")


def test_dev_mode_with_no_secret_still_rotates_rather_than_going_silent() -> None:
    """'Absent secret in dev -> per-process random secret + a WARNING. Still
    never unkeyed.' Confirms the lane keeps functioning (returns a full,
    rotated pool) rather than crashing or silently emptying when nobody
    configured a secret — the dev/test default path every other test in this
    module already relies on via `_cfg()`."""
    cands = [_cand(a, "p") for a in ("ann", "bob", "cass", "dan", "eve")]
    got = _eligible(cands, bucket=101, config=_cfg())  # production=False, no secret
    assert {c.post.author for c in got} == {"ann", "bob", "cass", "dan", "eve"}


def test_from_env_reads_the_hex_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "11" * 32)
    cfg = ExplorationConfig.from_env(production=True)
    assert cfg.seat_secret == bytes.fromhex("11" * 32)
    assert cfg.production is True


def test_from_env_with_no_var_and_production_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LUMEN_EXPLORE_SEAT_SECRET", raising=False)
    with pytest.raises(ValueError):
        ExplorationConfig.from_env(production=True)


def test_from_env_reads_the_rollover_pair(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "22" * 32)
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET_PREVIOUS", "33" * 32)
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET_ACTIVE_FROM_BUCKET", "5000")
    cfg = ExplorationConfig.from_env()
    assert cfg.seat_secret == bytes.fromhex("22" * 32)
    assert cfg.previous_seat_secret == bytes.fromhex("33" * 32)
    assert cfg.seat_secret_active_from_bucket == 5000


def test_seat_secret_fingerprint_is_short_and_does_not_leak_the_secret() -> None:
    """'Never logged... log a SHA-256 prefix of 8 hex chars if an operator
    needs to confirm two replicas agree.'"""
    from recsys.core.exploration import seat_secret_fingerprint

    secret = hashlib.sha256(b"deploy-secret").digest()
    fp = seat_secret_fingerprint(secret)
    assert len(fp) == 8
    assert fp != secret.hex()[:8]  # not merely truncating the secret's own hex
    assert fp == seat_secret_fingerprint(secret)  # same secret -> same fingerprint
    assert fp != seat_secret_fingerprint(hashlib.sha256(b"a different secret").digest())


def test_the_old_unkeyed_rotation_grind_no_longer_wins_the_seat() -> None:
    """★★★ MANDATORY ATTACK TEST for C1a (2026-08-04). FAILS on the old
    (unkeyed) construction, PASSES on the new (keyed) one.

    Reproduces the offline grind from `A1_namegrind.py` / `A13_setcover_e2e.py`
    at test scale, against BOTH constructions:

      OLD (what this module shipped with — reproduced inline below, since the
      fix deletes it from the source; this inline copy IS the regression pin):
          blake2b(f"{bucket}:{author}", digest_size=8)          # no key
      Computable by anyone, for any future bucket, for a name that does not
      need to exist yet — no account, no votes, no secret required.

      NEW (`recsys.core.exploration._rotation_key`): the same construction
      with `key=secret`. Without knowing the secret, an attacker cannot even
      EVALUATE the function to grind against.

    Method: grind a pool of candidate names against a fixed honest tier at a
    fixed bucket under the OLD construction, and keep the single best one —
    this is a real, deterministic offline search, exactly what `A1_namegrind`
    and `A13_setcover_e2e` did against the live pipeline. Confirm it reliably
    beats the honest tier under the OLD scheme (this IS the seat-13 takeover).
    Then take that SAME pre-ground name and test it against the NEW keyed
    construction across many secrets the attacker could not have known at
    grind time — if keying genuinely removes the advantage, the ground name
    should win the seat only at the honest baseline rate (1 in tier_size + 1),
    not the ~100% the old construction guaranteed.

    Mutation-checked: reverting `_rotation_key` to ignore `secret` (or calling
    the OLD helper below in its place) makes part (2)'s win rate collapse back
    to ~100%, failing the final assertion.
    """
    from recsys.core.exploration import _rotation_key

    def old_unkeyed_digest(author: str, bucket: int) -> bytes:
        # The construction this build REMOVES from `recsys/core/exploration.py`.
        return hashlib.blake2b(f"{bucket}:{author}".encode(), digest_size=8).digest()

    BUCKET = 555_555
    HONEST = [f"honest-{i:03d}" for i in range(8)]
    honest_old_min = min(old_unkeyed_digest(h, BUCKET) for h in HONEST)

    # Offline grind: enumerate candidate names deterministically (computing a
    # hash needs no registered account) and keep the smallest OLD digest.
    GRIND_N = 4000
    candidates = [f"grind-{i:06d}" for i in range(GRIND_N)]
    best_name = min(candidates, key=lambda nm: old_unkeyed_digest(nm, BUCKET))
    best_old_digest = old_unkeyed_digest(best_name, BUCKET)

    # (1) The grind DOES win under the OLD, vulnerable scheme — deterministic,
    # not luck. This reproduces the actual seat-13 takeover.
    assert best_old_digest < honest_old_min, (
        "grind setup is too weak to demonstrate the attack — widen GRIND_N"
    )

    # (2) The SAME pre-ground name against the NEW keyed construction, swept
    # over many secrets the attacker could not have known when grinding.
    trials = 200
    wins = 0
    for i in range(trials):
        secret = hashlib.sha256(f"unknown-to-the-grind-{i}".encode()).digest()
        pool = {h: _rotation_key(h, BUCKET, secret) for h in HONEST}
        pool[best_name] = _rotation_key(best_name, BUCKET, secret)
        winner = min(pool, key=lambda a: pool[a])
        wins += winner == best_name

    win_rate = wins / trials
    honest_baseline = 1 / (len(HONEST) + 1)
    # Old construction: win rate is 1.0, proven deterministically in (1).
    # New construction: must sit near the honest baseline, nowhere near 1.0.
    # A generous 4x band absorbs sampling noise at trials=200 while still
    # failing hard against anything still grindable.
    assert win_rate < honest_baseline * 4, (
        f"the pre-ground name won {win_rate:.1%} of {trials} independent secrets "
        f"(honest baseline {honest_baseline:.1%}) — keying did not remove the "
        "grinding advantage"
    )


# ---------------------------------------------------------------------------
# C2a — per-feed lane ceiling (2026-08-04).
#
# Without it, one feed's ceiling was `slots_per_page * pages` — 1 * 10 = 10 on
# the shipped 200-post/20-per-page feed — letting account COUNT convert
# directly into slots regardless of ring/self-dealing exclusion, which cannot
# see a farm that never forms a reciprocal edge. `max_slots_per_feed` bounds
# the lane's absolute size per feed, independent of page count.
# ---------------------------------------------------------------------------


def test_max_slots_per_feed_bounds_a_farms_take_of_one_feed() -> None:
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(120)]
    pool = _explore_pool(*[_cand(f"newcomer-{i:02d}", "d") for i in range(10)])
    assert len(pool) == 10  # sanity: all 10 distinct authors are genuinely eligible
    out = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=3))
    inserted = sum(1 for c in out if c.source is CandidateSource.EXPLORATION)
    assert inserted == 3


def test_max_slots_per_feed_default_caps_the_old_ten_slot_ceiling() -> None:
    """The OLD ceiling for this exact shape (10 distinct eligible newcomers,
    a 200-post/20-per-page feed) was 10 insertions. The shipped default now
    caps it at 3 — a farm converting account count into slots gets 70% less
    per feed, without changing per-author or per-page behaviour at all."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(200)]
    pool = _explore_pool(*[_cand(f"newcomer-{i:02d}", "d") for i in range(10)])
    out = insert_exploration(ranked, pool, _cfg())  # default max_slots_per_feed=3
    inserted = sum(1 for c in out if c.source is CandidateSource.EXPLORATION)
    assert inserted == 3
    assert inserted < 10  # the old ceiling this replaces


def test_max_slots_per_feed_of_zero_disables_new_insertions() -> None:
    ranked = [_scored(_cand("est", "p"))]
    pool = _explore_pool(_cand("newcomer", "d"))
    out = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=0))
    assert out == ranked


def test_max_slots_per_feed_does_not_reduce_a_take_already_under_the_cap() -> None:
    """Control: the cap must not shrink a normal, well-under-budget insertion
    — only a farm actually pushing past it should ever notice this field."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(80)]
    pool = _explore_pool(_cand("newcomer-a", "d"), _cand("newcomer-b", "d"))
    out = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=3))
    inserted = sum(1 for c in out if c.source is CandidateSource.EXPLORATION)
    assert inserted == 2


# ---------------------------------------------------------------------------
# C2b — tag-breadth VERIFICATION (2026-08-04). `_interest_match` shipped
# primary-tag-only before this build (see its docstring, ruling R3); this is
# a direct reproduction of the attack it closes, not a new fix. BUILDER 8's
# brief asked this to be verified rather than assumed, since a full
# `set(tags) & interest_tags` test was measured to be exactly the free,
# unbounded predicate that took one sock from 10/60 to 60/60 viewers.
# ---------------------------------------------------------------------------


def test_c2b_a_full_tag_spray_no_longer_defeats_interest_targeting() -> None:
    """VERIFICATION, not a new fix. Reproduces the measured attack inline: a
    post carrying every one of the viewer's genuinely-followed topics buried
    inside a 12-tag spray, whose PRIMARY tag (``post.category``) is something
    the viewer never asked for, must still be excluded. A full
    ``set(post.tags) & viewer.interest_tags`` test would have matched this
    post on ``"photo"`` alone — measured, one sock tagged with all 12 topics
    reached 60/60 viewers on page 1 under that rule. `post.category` is a
    scalar the author picks once per post and cannot multiply within one
    post, which is the whole point of R3/C2b."""
    spray = (
        "crypto", "photo", "art", "tech", "gaming", "music", "travel",
        "food", "fashion", "sports", "finance", "politics",
    )
    got = _eligible([_cand("sprayer", "p1", category="crypto", tags=spray)])
    assert got == []


def test_c2b_the_matching_primary_tag_still_works_alongside_a_tag_spray() -> None:
    """Control for the test above: the spray itself is not what disqualifies
    the post — ``category`` matching the viewer's interest is what qualifies
    it, tag list notwithstanding."""
    spray = (
        "crypto", "photo", "art", "tech", "gaming", "music", "travel",
        "food", "fashion", "sports", "finance", "politics",
    )
    got = _eligible([_cand("honest", "p1", category="photo", tags=spray)])
    assert [c.post.author for c in got] == ["honest"]


# ---------------------------------------------------------------------------
# C2c — per-FARM bound via creation/funding lineage (2026-08-04).
#
# THE GAP: `max_slots_per_feed` (C2a) caps the lane's total SIZE per feed but
# has no notion that two DIFFERENT authors might be the same farm — an
# account-count farm converts sock count directly into feed SHARE even under
# a 3-slot ceiling, because the per-author dedup above only ever compares one
# author to itself. Measured (`A4_slot_sweep.py`): 20 ground socks took 83.6%
# of the ENTIRE exploration budget with 0 ring flags — an account-count farm
# has no reciprocal edge for ring detection to see, no shared post for the
# per-post checks, and no self-vote for `_is_self_dealt`.
#
# THE FIX: group authors by creation/funding lineage (the same relation
# `stake_lineage`/`_lineage_for` already compute elsewhere in this package,
# widened — see this unit's build report) and cap promotions to ONE per
# lineage group per feed, generalising the existing per-author positional
# scan rather than duplicating it.
# ---------------------------------------------------------------------------


def test_c2c_at_most_one_promotion_per_lineage_group_per_feed() -> None:
    """★★★ MANDATORY ATTACK TEST for C2c (2026-08-04). FAILS without the
    ``lineage`` cap, PASSES with it — reproduces the measured farm attack at
    test scale.

    Five sock authors sharing one funding lineage each individually clear
    every OTHER defence in this lane (fresh, interest-matched, no graph-cred
    entry, no self-dealing, distinct authors so the per-author cap never
    fires) and, absent a lineage cap, the per-feed ceiling (C2a,
    ``max_slots_per_feed=3``) does nothing to stop them taking every seat in
    the budget — exactly the mechanism `A4_slot_sweep.py` measured at 83.6%
    farm share on the live budget. Grouping by lineage caps their combined
    take at ONE promotion, the same one-per-group bound
    `max_slots_per_feed` alone cannot express.
    """
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(120)]
    farm = [_cand(f"sock-{i:02d}", "d") for i in range(5)]
    pool = _explore_pool(*farm)
    assert len(pool) == 5  # sanity: every sock genuinely clears eligibility alone
    lineage = {
        c.post.author: frozenset(
            s.post.author for s in farm if s.post.author != c.post.author
        )
        for c in farm
    }

    # BEFORE: no lineage supplied — the per-feed ceiling alone (C2a) lets the
    # farm take every one of its 3 slots, the exact share-conversion this unit
    # exists to close.
    unbounded = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=3))
    assert sum(1 for c in unbounded if c.source is CandidateSource.EXPLORATION) == 3

    # AFTER: with the lineage map, the whole farm shares ONE promotion.
    out = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=3), lineage=lineage)
    inserted = [c for c in out if c.source is CandidateSource.EXPLORATION]
    assert len(inserted) == 1


def test_lineage_cap_absent_is_bit_for_bit_the_old_per_author_behaviour() -> None:
    """Control: ``lineage=None`` (the default — no caller wired yet) must
    reproduce exactly the pre-C2c per-author-only dedup, not a stricter or
    looser rule by accident."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(80)]
    pool = _explore_pool(_cand("newcomer-a", "d"), _cand("newcomer-b", "d"))
    with_none = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=3), lineage=None)
    without_kwarg = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=3))
    assert [c.post.key for c in with_none] == [c.post.key for c in without_kwarg]
    assert sum(1 for c in with_none if c.source is CandidateSource.EXPLORATION) == 2


def test_lineage_cap_does_not_penalize_genuinely_unrelated_newcomers() -> None:
    """Control: two authors that do NOT share a lineage group must both still
    get their own seat — the cap must fire on actual shared membership, never
    merely on a ``lineage`` mapping being present at all."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(80)]
    a = _explore_pool(_cand("newcomer-a", "d"))[0]
    b = _explore_pool(_cand("newcomer-b", "d"))[0]
    lineage = {
        "newcomer-a": frozenset({"friend-of-a"}),
        "newcomer-b": frozenset({"friend-of-b"}),
    }

    out = insert_exploration(ranked, [a, b], _cfg(page_size=20, position=13), lineage=lineage)

    keys = [c.post.key for c in out]
    assert keys.index(a.post.key) == 13
    assert keys.index(b.post.key) == 33


def test_lineage_cap_fires_regardless_of_which_side_declares_the_relationship() -> None:
    """``stake_lineage`` is not guaranteed symmetric for every edge shape (its
    own docstring says so — a chain of delegations is not fully transitive).
    A ONE-DIRECTIONAL lineage map — only ``sockA``'s entry names ``sockB``,
    never the reverse — must still cap the pair regardless of which one is
    popped from the pool first, or the cap's behaviour would depend on pool
    POP ORDER, an implementation accident rather than a policy."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(80)]
    a = _explore_pool(_cand("sockA", "d"))[0]
    b = _explore_pool(_cand("sockB", "d"))[0]
    lineage = {"sockA": frozenset({"sockB"})}  # only ONE direction declared

    out_ab = insert_exploration(ranked, [a, b], _cfg(page_size=20, position=13), lineage=lineage)
    out_ba = insert_exploration(ranked, [b, a], _cfg(page_size=20, position=13), lineage=lineage)

    for label, out in (("a-then-b", out_ab), ("b-then-a", out_ba)):
        inserted = sum(1 for c in out if c.source is CandidateSource.EXPLORATION)
        assert inserted == 1, f"{label}: the one-directional lineage map failed to cap the pair"


def test_lineage_groups_larger_than_two_are_still_capped_at_one() -> None:
    """Control for group size: the cap is ONE PER GROUP, not one-per-pair — a
    lineage group of 4 must not sneak a 2nd promotion in just because the
    group is bigger than the two-account cases above."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(120)]
    group = [_cand(f"member-{i}", "d") for i in range(4)]
    pool = _explore_pool(*group)
    lineage = {
        c.post.author: frozenset(
            s.post.author for s in group if s.post.author != c.post.author
        )
        for c in group
    }

    out = insert_exploration(ranked, pool, _cfg(max_slots_per_feed=3), lineage=lineage)

    assert sum(1 for c in out if c.source is CandidateSource.EXPLORATION) == 1


# ---------------------------------------------------------------------------
# C8 — band the need tier (2026-08-04).
#
# THE GAP: `received` counts DISTINCT engager identities (fixed earlier, see
# the block comment above it), which closed per-comment griefing but not
# per-IDENTITY griefing: since the sort/rotation keys used the exact count,
# ONE identity commenting once on a rival was enough to move that rival from
# `received=0` (tied with a genuine newcomer) to `received=1` (strictly
# worse), and that SAME one identity is reusable against every rival in the
# pool for the same fixed one-time cost. Measured (`A10c_reach_correct.py`):
# 1 account + 60 comments (a handful per rival) took the attacker from best
# position 33 to 13 while flooring 20 rivals simultaneously.
#
# THE FIX, TAKE 1 (same-day regression, corrected below): band the count
# (`_need_tier`) with the literal BUILDMAP-C edges `(0, 3, 8, 20)`, so 0, 1
# and 2 distinct engagers all sit in the SAME bottom band. The coordinator's
# end-to-end pipeline tests caught this before ship: it silently merges a
# GENUINE zero-engagement newcomer with an author who already has one or two
# real readers, and the keyed shuffle then picks arbitrarily between them —
# on `tests/test_pipeline.py::_explore_world` (1 newcomer + 25 established
# authors at 2 voters each) the newcomer stopped being first at all,
# deterministically, 5/5 runs. That is this lane's PRIMARY case, so eroding
# it is a regression, not a hardening.
#
# THE FIX, TAKE 2 (shipped): zero is its OWN band, `DEFAULT_NEED_BANDS =
# (0, 1, 3, 8, 20)`. Band 0 is exactly `{0}` — a true newcomer is never
# diluted by ANY engagement — and the coarsening C8 exists for (raise the
# price above 1 identity) applies from band 1 upward, to authors who already
# have some audience. HONEST TRADE, not hidden: this reopens the 0->1
# boundary to a single identity (see the residual test below) — the
# coordinator's explicit ruling is that the newcomer case wins that tie.
# ---------------------------------------------------------------------------


def test_c8_a_genuine_zero_engagement_newcomer_always_leads_a_lightly_engaged_rival() -> None:
    """★★★ REGRESSION PIN for the same-day coordinator-caught bug (2026-08-04).
    FAILS on the literal BUILDMAP-C edges `(0, 3, 8, 20)`, PASSES on the
    shipped `(0, 1, 3, 8, 20)` — reproduces
    `tests/test_pipeline.py::_explore_world` at unit scale.

    `(0, 3, 8, 20)` puts a genuine zero-engagement newcomer in the SAME band
    as an author who already has one or two real, distinct engagers, so the
    keyed shuffle (or, with rotation off, the recency tie-break) can pick
    EITHER one — measured on the pipeline fixture (1 newcomer, 25 established
    authors each with 2 real voters): the newcomer stopped leading at all,
    deterministically. Zero as its own band restores an unconditional top
    priority for a true newcomer regardless of how fresh or stale a
    lightly-engaged rival is.
    """
    rival = _attributed(
        "rival", "p", days_old=0,  # FRESHER than the newcomer...
        commenters=("readerA", "readerB"),  # ...and with 2 genuine distinct engagers.
    )
    newcomer = _cand("newcomer", "p", days_old=3)  # older, but genuinely never engaged

    got = _eligible([rival, newcomer])

    assert [c.post.author for c in got] == ["newcomer", "rival"], (
        "a lightly-engaged rival outranked a genuine zero-engagement newcomer"
    )


def test_c8_one_identity_cannot_demote_a_rival_that_already_has_a_baseline_audience() -> None:
    """★★★ MANDATORY ATTACK TEST for C8 (2026-08-04, corrected scope). FAILS on
    raw distinct-engager counts, PASSES with the shipped band default —
    reproduces the measured attack (`A10c_reach_correct.py`) at test scale,
    for the case C8 actually still defends: an author who ALREADY has some
    real audience (not a bare zero-engagement newcomer — see the zero-band
    regression test above and the residual test below for why zero itself is
    handled separately).

    Rivals and the attacker both start with ONE genuine, distinct engager
    (a real baseline audience — band 1, `{1, 2}`). ONE griefer identity then
    adds a second distinct comment to each of 20 rivals (1 -> 2 engagers).
    Under RAW counts, that second comment would make each rival strictly
    WORSE than the attacker's own untouched, STALE post — the exact
    demotion the measurement pins (attacker best position 33 -> 13 while
    flooring 20 rivals). Banding keeps 1 and 2 in the SAME band, so a lone
    griefer identity's single extra touch does not change any rival's band,
    and a rival's genuine freshness — not the griefer's one-time touch —
    decides the scarce slot instead.
    """
    rivals = [
        _attributed(
            f"rival{i:02d}", "p", days_old=1,
            commenters=("baseline-reader", "griefer"),  # 1 genuine + 1 griefer touch = 2
        )
        for i in range(20)
    ]
    # stale; already has ITS OWN one genuine engager, never touched by the griefer
    attacker = _attributed("attacker", "p1", days_old=5, commenters=("baseline-reader",))

    got = _eligible([attacker, *rivals])

    assert got[0].post.author != "attacker", (
        "one griefer identity still bought the attacker the front of the round-robin"
    )
    assert got[0].post.author.startswith("rival")


def test_residual_one_identity_can_still_move_a_rival_out_of_the_zero_only_band() -> None:
    """★ HONEST RESIDUAL, pinned rather than hidden (2026-08-04). This is NOT a
    bug — it is the accepted trade the coordinator explicitly ruled on: "if
    zero-as-its-own-band weakens the demotion defence at the 0->1 boundary
    specifically, say so honestly rather than trading the newcomer away for
    it — the newcomer case wins that tie."

    Because band 0 is now exactly `{0}` (see `DEFAULT_NEED_BANDS`'s
    docstring), ONE griefer identity commenting once on each of N rivals who
    otherwise have ZERO engagement still moves every one of them out of band
    0 — the same single-identity power C8 exists to remove, narrowly reopened
    at this one boundary. An attacker whose own post is ALSO untouched (0
    engagers) keeps band 0 to themselves and wins the slot. This is the exact
    mechanism `test_c8_one_identity_cannot_demote_a_rival_that_already_has_a_baseline_audience`
    shows is CLOSED once a rival has even one real engager already — the gap
    is specific to the zero boundary, not the banding generally.
    """
    rivals = [
        _attributed(f"rival{i:02d}", "p", days_old=1, commenters=("griefer",))
        for i in range(20)
    ]
    attacker = _cand("attacker", "p1", days_old=5)  # stale; never touched by the griefer

    got = _eligible([attacker, *rivals])

    assert got[0].post.author == "attacker", (
        "if this starts failing, the zero-boundary residual has been closed — "
        "update this test's docstring (and DEFAULT_NEED_BANDS's) to say so, "
        "do not just delete the assertion"
    )


def test_need_tier_band_edges_are_inclusive_of_the_upper_boundary() -> None:
    """Direct unit test of :func:`_need_tier` against the shipped default
    band edges, pinned so a future edit to the bisect direction (left vs
    right) is caught here rather than only inferred from an end-to-end
    ordering test."""
    from recsys.core.exploration import DEFAULT_NEED_BANDS, _need_tier

    assert DEFAULT_NEED_BANDS == (0, 1, 3, 8, 20)
    assert _need_tier(0, DEFAULT_NEED_BANDS) == 0    # band 0 is EXACTLY {0}
    assert _need_tier(1, DEFAULT_NEED_BANDS) == 1    # the edge belongs to the NEW band
    assert _need_tier(2, DEFAULT_NEED_BANDS) == 1
    assert _need_tier(3, DEFAULT_NEED_BANDS) == 2
    assert _need_tier(7, DEFAULT_NEED_BANDS) == 2
    assert _need_tier(8, DEFAULT_NEED_BANDS) == 3
    assert _need_tier(19, DEFAULT_NEED_BANDS) == 3
    assert _need_tier(20, DEFAULT_NEED_BANDS) == 4
    assert _need_tier(1000, DEFAULT_NEED_BANDS) == 4


def test_one_and_two_distinct_engagers_tie_but_zero_and_three_do_not() -> None:
    """Boundary check inside `eligible_for_exploration` itself, complementing
    the unit-level test above, for the SHIPPED (corrected) bands: 1 and 2
    distinct engagers must tie with each other (band 1) but NEITHER may tie
    with a genuine 0-engagement newcomer (band 0, exclusive) or with 3
    (band 2)."""
    one = _attributed("one-engager", "p", days_old=0, commenters=("a",))
    two = _attributed("two-engagers", "p", days_old=0, commenters=("a", "b"))
    three = _attributed("three-engagers", "p", days_old=0, commenters=("a", "b", "c"))
    newcomer = _cand("zero-engagers", "p", days_old=0)

    got = _eligible([one, two, three, newcomer])

    assert got[0].post.author == "zero-engagers"     # alone, ahead of everyone
    assert got[-1].post.author == "three-engagers"   # alone, one band above 1-2
    assert {c.post.author for c in got[1:3]} == {"one-engager", "two-engagers"}


def test_c8_banding_does_not_hide_a_genuinely_well_heard_author() -> None:
    """Control: the rule must not become "engagement never counts". An author
    with real, distinct engagement well past the band edges still yields the
    slot to someone genuinely unheard — this is the SAME property
    `test_genuine_distinct_readers_DO_count_as_being_heard` already pins with
    5 engagers (band 2, `[3, 8)` under the shipped bands — well above band 0,
    so that older test needed no fixture change, verified by running it
    unmodified). This test pins the much larger gap explicitly."""
    heard = _attributed(
        "heard", "p", days_old=0, commenters=tuple(f"reader{i}" for i in range(12))
    )
    unheard = _cand("unheard", "p", days_old=1)

    got = _eligible([heard, unheard])

    assert [c.post.author for c in got] == ["unheard", "heard"]


# ---------------------------------------------------------------------------
# C2 / DOUBLE-SERVE (2026-08-05).
#
# `insert_exploration` declined an author only when they were already at or
# ABOVE the reserved slot. B-04's emerging-author budget routinely lands a
# newcomer on page 1 BELOW slot 13 — the realistic case — and that author then
# ALSO drew an exploration promotion, spending one of only `max_slots_per_feed`
# (3) slots on somebody who already had guaranteed page-1 reach.
# ---------------------------------------------------------------------------


def test_an_author_already_on_page_one_does_not_also_take_the_reserved_slot() -> None:
    """★ THE DOUBLE-SERVE. `newb` sits at 15 with one post (as B-04 would place
    them) and offers a SECOND post to the lane. Pre-fix the second post was
    spliced at 13, so one author held [13, 16] and a scarce slot bought no new
    discovery. The slot must go to the genuinely unseen author instead."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(40)]
    ranked[15] = _scored(_cand("newb", "already"), final=0.5)
    picks = [_scored(_cand("newb", "second")), _scored(_cand("unseen", "debut"))]

    out = insert_exploration(ranked, picks, _cfg(max_slots_per_feed=3))
    at13 = out[13].post.author
    assert at13 == "unseen", f"slot 13 went to {at13!r}, not the unseen author"
    newb_positions = [i for i, c in enumerate(out) if c.post.author == "newb"]
    assert len(newb_positions) == 1, (
        f"newb occupies {newb_positions} — an author already on page 1 drew a "
        f"second slot from the exploration budget"
    )


def test_a_pick_already_on_page_one_is_not_re_promoted_within_the_page() -> None:
    """The other half: promoting a post from 15 to 13 buys the reader nothing
    and costs the lane a slot an unseen author could have had."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(40)]
    ranked[15] = _scored(_cand("newb", "debut"), final=0.5)
    out = insert_exploration(
        ranked, [_scored(_cand("newb", "debut")), _scored(_cand("unseen", "debut"))],
        _cfg(max_slots_per_feed=1),
    )
    assert out[13].post.author == "unseen"
    # Exactly one occurrence, and NOT the reserved slot. It sits at 16 rather
    # than 15 only because inserting `unseen` at 13 shifts everything below it
    # down by one — the post was not moved by the lane.
    assert [i for i, c in enumerate(out) if c.post.author == "newb"] == [16]


def test_a_buried_author_is_still_promoted_the_regression_this_must_not_cause() -> None:
    """★ THE GUARD ON THE GUARD. An earlier attempt at this check compared
    against the WHOLE feed and broke the lane's primary case: the q3 newcomer's
    three debut posts, buried together at 99/106/108, each blocked the others.
    Posts that deep have no reach — they are exactly who the slot is for."""
    ranked = [_scored(_cand(f"est{i}", "p"), final=1.0 - i / 1000) for i in range(120)]
    ranked[99] = _scored(_cand("newb", "a"), final=0.01)
    ranked[106] = _scored(_cand("newb", "b"), final=0.01)
    out = insert_exploration(
        ranked, [_scored(_cand("newb", "c"))], _cfg(max_slots_per_feed=3)
    )
    assert out[13].post.author == "newb", (
        "a newcomer whose every post is buried at 99+ was NOT promoted — this is "
        "the whole-feed regression the page-scoped bound exists to avoid"
    )


# ---------------------------------------------------------------------------
# M04 (2026-08-05) — the dev seat key must be STABLE ACROSS PROCESSES.
#
# This is the fix for this project's single worst instrument failure: run-to-run
# non-reproducibility that was initially misdiagnosed as BLAS/numpy. The cause
# was `_DEV_FALLBACK_SECRET` being `secrets.token_bytes(32)` PER PROCESS, so
# every panel run used a different MAC key and the exploration seat rotated
# differently each time.
#
# The 2026-08-05 mutation audit found this fix had ZERO test coverage: reverting
# it to a per-process random value passed all 754 tests AND all 13 panels, while
# silently destroying reproducibility again. A future "simplification" back to
# `token_bytes` would have gone green everywhere.
# ---------------------------------------------------------------------------


def test_the_dev_fallback_secret_is_stable_across_processes() -> None:
    """★ THE M04 REGRESSION TEST. Spawns real subprocesses — an in-process check
    cannot distinguish a module constant from a per-process random value, which
    is exactly why nothing caught this.

    Also varies PYTHONHASHSEED, since the same class of nondeterminism was
    separately found in `simworld` set iteration.
    """
    import subprocess
    import sys

    prog = (
        "from recsys.core.exploration import _dev_fallback_secret;"
        "import sys; sys.stdout.write(_dev_fallback_secret().hex())"
    )
    seen = set()
    for hashseed in ("0", "1", "42"):
        env = {**os.environ, "PYTHONHASHSEED": hashseed}
        out = subprocess.run(
            [sys.executable, "-c", prog], capture_output=True, text=True, env=env,
            cwd=str(pathlib.Path(__file__).resolve().parent.parent),
        )
        assert out.returncode == 0, out.stderr
        seen.add(out.stdout.strip())
    assert len(seen) == 1, (
        f"the dev seat key differs across processes ({len(seen)} distinct values: "
        f"{seen}) — the measurement harness is non-reproducible again, which is "
        f"the defect that was once misdiagnosed as BLAS. It must be a FIXED "
        f"constant; production still refuses to start without a real secret."
    )


def test_the_dev_fallback_secret_is_not_a_production_path() -> None:
    """The control: the key above is safe to be public ONLY because production
    cannot reach it. If that ever stops being true, the fixed key becomes a
    grindable seat again."""
    with pytest.raises(ValueError):
        ExplorationConfig(production=True, seat_secret=None)


def test_the_serving_log_retires_an_author_at_the_cap() -> None:
    """★ B1 — the one bound in this lane keyed on something the attacker cannot
    control. An author already given `max_serves_per_author` slots without
    earning engagement leaves the pool.

    Mutation-checked: removing the retire branch in `eligible_for_exploration`
    makes this fail."""
    cand = _cand("spent", "d")
    cfg = _cfg(max_serves_per_author=3)
    fresh = eligible_for_exploration(
        [cand], _viewer(), now=NOW, graph_creds={}, suppressed=frozenset(),
        show_nsfw=False, config=cfg, serves={"spent": 0},
    )
    retired = eligible_for_exploration(
        [cand], _viewer(), now=NOW, graph_creds={}, suppressed=frozenset(),
        show_nsfw=False, config=cfg, serves={"spent": 3},
    )
    assert fresh, "an unserved author must be eligible"
    assert retired == [], "an author at the serve cap must leave the lane"


def test_the_serving_log_is_inert_when_no_caller_supplies_one() -> None:
    """Every existing unit test and panel reranks without a log; that path must
    reproduce pre-B1 behaviour exactly."""
    cand = _cand("nobody", "d")
    with_none = eligible_for_exploration(
        [cand], _viewer(), now=NOW, graph_creds={}, suppressed=frozenset(),
        show_nsfw=False, config=_cfg(), serves=None,
    )
    assert with_none, "absent a serve log the lane must behave as before"


def test_serve_count_breaks_ties_within_a_need_tier() -> None:
    """Two equally-unheard authors are NOT equal if the system already served
    one of them — that is the observed fact the need bands cannot see."""
    cands = [_cand("served", "d"), _cand("unserved", "d")]
    out = eligible_for_exploration(
        cands, _viewer(), now=NOW, graph_creds={}, suppressed=frozenset(),
        show_nsfw=False, config=_cfg(max_serves_per_author=5),
        serves={"served": 2},
    )
    assert out, "both authors should still be eligible below the cap"
    assert out[0].post.author == "unserved", (
        f"the already-served author outranked the unserved one: "
        f"{[c.post.author for c in out]}"
    )


# ---------------------------------------------------------------------------
# 2026-08-05 POST-CLOSEOUT COUNCIL — the serve budget is OFF, and cannot be
# turned on by accident.
# ---------------------------------------------------------------------------


def test_the_serve_budget_ships_at_three() -> None:
    """★★★ OWNER'S RULING 2026-08-05, after the round-3 council measured the
    off-switch and found it WORSE for the class it protects.

    `0` does NOT mean "no rationing" — it means ONE author holds the reserved
    seat for a whole clock bucket, because the rotation is keyed per bucket and
    not per viewer. Measured across 3 seeds: cap 0 -> 1 of 20 newcomers reached;
    cap 1 -> 7/20; cap 3 -> 7 on seed 7 but 4 on seeds 11 and 23 (mean 5);
    cap 100 -> 1/20. The original "7-8" was seed 7 only — see
    `ExplorationConfig.max_serves_per_author`, which records that the cap choice
    is NOT settled by evidence and that cap 1 measured better under attack.

    The reasoning reversed twice in one day, so both directions are recorded in
    `ExplorationConfig`'s own docstring rather than only in a report.

    MUTANT: set the default back to 0. This fails.
    """
    assert ExplorationConfig().max_serves_per_author == 3


def test_earning_engagement_clears_a_spent_serve_budget() -> None:
    """★★★ `clear()` WIRED — it had NO production caller since B1 shipped, so
    retirement was PERMANENT and the method's own docstring promise ("used when
    they leave the lane by earning engagement") was unkept. Both Seat 1 and
    Seat 3 found it independently.

    Asserted through `rank_feed`, not on the log in isolation: this project's
    signature defect is a mechanism that works while the pipeline never calls
    it, and that is exactly what `clear()` was.

    HONEST LIMIT, pinned in the docstring so nobody over-reads this gate: it
    proves retirement is not permanent for an author who EARNS engagement. It
    does not close the denial attack — a newcomer denied impressions cannot earn
    the engagement that would clear them.

    MUTANT: remove the `serve_log.clear(...)` loop from `rank_feed`. This fails.
    """
    from recsys.config import Settings
    from recsys.core.normalize import build_norm_context
    from recsys.pipeline import TrustPolicy, rank_feed
    from recsys.serve_log import ExplorationServeLog
    from tests.fakes import FakeGateway

    settings = Settings()
    samples = [float(i) for i in range(50)]
    norms = build_norm_context(samples, samples, samples)
    post = make_post(author="newcomer", permlink="p1", category="photo", tags=("photo",))
    fresh = type(post)(**{**post.__dict__, "created": NOW - timedelta(hours=1)})
    viewer = make_viewer("v", follows=frozenset({"alice"}), interest_tags=frozenset({"photo"}))

    # The author is carrying a spent budget from earlier serves.
    log = ExplorationServeLog({"newcomer": 3})

    # No engagement yet: the spent budget must survive, or "retire at the cap"
    # would mean nothing at all.
    quiet = FakeGateway(tag=[fresh])
    rank_feed(viewer, quiet, norms, now=NOW, since=EPOCH, settings=settings,
              trust_policy=TrustPolicy.WARN, serve_log=log)
    assert log.counts().get("newcomer", 0) >= 3, (
        "an author with no engagement lost their spent budget — the cap is inert"
    )

    # Now someone real engages them: the budget is returned. The engagement has
    # to be ON THE POST — `FakeGateway(engagers=...)` is second-degree data and
    # is deliberately NOT what "has this author been heard" reads, which the
    # first version of this test got wrong.
    voted = type(fresh)(**{**fresh.__dict__, "votes": (make_vote("alice"),)})
    heard = FakeGateway(tag=[voted])
    rank_feed(viewer, heard, norms, now=NOW, since=EPOCH, settings=settings,
              trust_policy=TrustPolicy.WARN, serve_log=log)
    assert "newcomer" not in log.counts(), (
        "an author who earned engagement is still carrying a spent budget — "
        "retirement is permanent"
    )


def test_a_negative_serve_budget_is_refused_rather_than_silently_disabling() -> None:
    """★ Seat 2: this was the ONE `ExplorationConfig` field with no validation,
    so `-1` silently disabled the budget while reading as configured. 0 is the
    documented off switch; a typo must never look like a policy.

    MUTANT: drop the `__post_init__` check. This fails.
    """
    with pytest.raises(ValueError, match="max_serves_per_author"):
        ExplorationConfig(max_serves_per_author=-1)


def test_disabling_the_serve_budget_also_disables_its_ordering() -> None:
    """★★ ROUND-3 COUNCIL (Seat 2). Turning `max_serves_per_author` to 0 stopped
    RETIREMENT but left B1's serve-count TIE-BREAK live in the sort key, so
    ordering still flipped with serve counts at the shipped default. "0 restores
    the pre-B1 behaviour exactly" was false — a half-revert is its own bug.

    ★ The first version of this test built its own fixture, produced an EMPTY
    lane, and passed with the mechanism deleted. Second vacuous gate written in
    one session; both were caught only by mutation testing. It now uses the
    fixture the rest of this file uses and asserts the lane is non-empty FIRST.

    MUTANT: ungate the `served_counts` term in the sort key. This fails.
    """
    pool = [_cand("served", "p-served"), _cand("unserved", "p-unserved")]
    common = dict(
        now=NOW, graph_creds={}, suppressed=frozenset(), show_nsfw=False,
        config=_cfg(max_serves_per_author=0),
    )
    with_serves = [
        c.post.author for c in eligible_for_exploration(pool, _viewer(), **common,
                                                        serves={"served": 99})
    ]
    without = [
        c.post.author for c in eligible_for_exploration(pool, _viewer(), **common, serves={})
    ]
    assert len(without) == 2, f"empty lane — the comparison would be vacuous: {without}"
    assert with_serves == without, (
        f"serve counts still reorder the lane with the budget disabled: "
        f"{without} -> {with_serves}"
    )

    # And the mechanism genuinely works when it is ON, so the assertion above
    # is about the OFF switch rather than about a term that never mattered.
    on = dict(common, config=_cfg(max_serves_per_author=3))
    assert [
        c.post.author for c in eligible_for_exploration(pool, _viewer(), **on,
                                                        serves={"served": 2})
    ] != [c.post.author for c in eligible_for_exploration(pool, _viewer(), **on, serves={})]


def test_a_lite_like_never_reorders_the_new_writer_lane() -> None:
    """★★★ THE NET-NEW DEFECT THIS ROUND CREATED — composition, not mechanism.

    `Vote.lite` was honoured in both `vote_signal` consumers and missed in a
    THIRD: the need-band computation that governs this lane. Unfiltered, a free
    lite vote counted FULL VALUE and UNBOUNDED there while being capped for
    merit, so a lite reader LIKING a newcomer's post pushed them OUT of the lane
    — measured end to end at 0-1 lite likes -> rank 13, seen by 10/10 viewers;
    3 lite likes -> rank 33, seen by 0/10.

    Latent while L1/L2 could not reach production; LIVE the moment that was
    fixed. Neither change was wrong on its own.

    ★ The first version of this test compared two EMPTY lanes and passed with
    the mechanism deleted. It is written against the fixture the rest of this
    file uses, and asserts the lane is non-empty FIRST, because a vacuous
    equality is how a gate stops being one.

    MUTANT: drop `if not v.lite` from the engagers set. This fails.
    """
    lite_votes = tuple(
        Vote(voter=f"01LITE{i}", rshares=0, timestamp=EPOCH, lite=True) for i in range(3)
    )
    plain = _cand("newcomer", "p-new")
    liked = Candidate(
        post=type(plain.post)(**{**plain.post.__dict__, "votes": lite_votes}),
        source=plain.source,
    )
    rival = _cand("rival", "p-rival")
    common = dict(
        now=NOW, graph_creds={}, suppressed=frozenset(), show_nsfw=False, config=_cfg()
    )
    def lane(pool: list[Candidate]) -> list[str]:
        return [c.post.author for c in eligible_for_exploration(pool, _viewer(), **common)]

    without = lane([plain, rival])
    with_likes = lane([liked, rival])
    assert len(without) == 2, (
        f"fixture produced no lane — the comparison would be vacuous: {without}"
    )
    assert with_likes == without, (
        "free lite likes reordered the new-writer lane — a like from a lite "
        f"reader evicts the newcomer it was meant to help: {without} -> {with_likes}"
    )


def test_graduation_requires_engagement_that_is_NEW_since_the_slot_was_spent() -> None:
    """★★★ THE POPULATION MATRIX. Two previous designs of this rule shipped and
    both were regressions, each found by a council rather than by review, and
    each because it was verified against the WRONG POPULATION:

      1. "clear on has-engagement, every request" — a per-request RESET. One
         author took 288 of 300 slots.
      2. "clear on has-engagement AND not in the exploration pool" — an author
         AT THE CAP is filtered out of that pool BY THE CAP, so it fired for
         exactly the population it existed to hold. Budget 3 -> 0 on the next
         request; the lane went back to 100% farm capture.

    Both keyed on the EXISTENCE of engagement. So this test enumerates the four
    populations explicitly rather than checking one happy path — the at-cap rows
    are the ones both previous designs got wrong.

    MUTANT: compare against `>= 0` instead of the recorded baseline, or drop the
    `author in self._counts` guard. This fails.
    """
    from recsys.serve_log import ExplorationServeLog

    log = ExplorationServeLog()

    # (a) AT THE CAP with STATIC engagement -> must NOT graduate. This is the
    # row design #2 got wrong, and it is the farm's whole attack.
    log.record(["capped"], {"capped": 1})
    log.record(["capped"], {"capped": 1})
    log.record(["capped"], {"capped": 1})
    assert log.counts()["capped"] == 3
    assert log.graduated({"capped": 1}) == [], "static engagement graduated an author at the cap"

    # (b) AT THE CAP with NEW engagement -> must graduate; that is the point.
    assert log.graduated({"capped": 2}) == ["capped"]

    # (c) BELOW the cap with static engagement -> must NOT graduate, so the
    # budget still accumulates. This is the row design #1 got wrong.
    log2 = ExplorationServeLog()
    log2.record(["young"], {"young": 4})
    assert log2.graduated({"young": 4}) == []
    log2.record(["young"], {"young": 4})
    assert log2.counts()["young"] == 2, "the budget stopped accumulating for an engaged author"

    # (d) An author who never spent a slot has nothing to graduate from.
    assert log2.graduated({"stranger": 99}) == []


def test_graduation_is_wired_into_the_served_pipeline() -> None:
    """Behaviour is pinned above; this pins that `rank_feed` CONSULTS it — the
    reachability half, which is the half this project keeps dropping. `clear()`
    sat with no production caller at all for a full round."""
    import inspect

    from recsys.pipeline import rank_feed

    source = inspect.getsource(rank_feed)
    assert "serve_log.graduated(" in source
    assert "serve_log.clear(author)" in source
    assert "engagement_counts" in source, "record() is not given the baseline it compares against"
