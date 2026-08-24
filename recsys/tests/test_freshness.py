"""Tests for the reserved recent-post seat (:mod:`recsys.core.freshness`).

Pure unit tests against hand-built candidates, the same convention
``test_exploration.py`` uses for its lane: no gateway, no database, no network.

★ THE SAFETY PROPERTY IS TESTED FIRST AND EVERYWHERE. This lane runs after
moderation, the vouch gate, the seen split and the ban filter, so the ONLY thing
that makes it safe to run there is that it returns a permutation of its input.
Several tests below assert that explicitly rather than trusting it, because a
lane that could add or drop a post at this stage would silently undo every
filter that came before it.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from recsys.config import FreshnessConfig
from recsys.contracts import Candidate, CandidateSource, ScoreBreakdown, ScoredCandidate
from recsys.core.freshness import promote_fresh, recent_candidates
from tests.fakes import EPOCH, make_post

NOW = EPOCH + timedelta(days=30)


def _sc(author: str, permlink: str, *, hours_old: float, score: float = 0.5) -> ScoredCandidate:
    post = make_post(author=author, permlink=permlink)
    aged = type(post)(**{**post.__dict__, "created": NOW - timedelta(hours=hours_old)})
    return ScoredCandidate(
        post=aged,
        source=CandidateSource.IN_NETWORK,
        score=ScoreBreakdown(vote_norm=0.0, rep_norm=0.0, organic=score, final=score),
    )


def _keys(feed):
    return [f"{c.post.author}/{c.post.permlink}" for c in feed]


def _feed(n: int, *, fresh_at: dict[int, float] | None = None):
    """``n`` stale posts, with the given indices made fresh (value = hours old)."""
    fresh_at = fresh_at or {}
    return [
        _sc(f"a{i}", f"p{i}", hours_old=fresh_at.get(i, 100.0))
        for i in range(n)
    ]


# --------------------------------------------------------------------------
# the safety property
# --------------------------------------------------------------------------

def test_the_output_is_always_a_permutation_of_the_input():
    """The property that makes this lane safe to run after every filter."""
    feed = _feed(30, fresh_at={20: 1.0, 25: 2.0, 28: 3.0})
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert len(out) == len(feed)
    assert sorted(_keys(out)) == sorted(_keys(feed))


def test_nothing_is_promoted_when_no_post_is_fresh():
    feed = _feed(30)
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert _keys(out) == _keys(feed)


def test_an_empty_feed_is_returned_unchanged():
    assert promote_fresh([], FreshnessConfig(), NOW) == []


# --------------------------------------------------------------------------
# the behaviour the lane exists for
# --------------------------------------------------------------------------

def test_a_fresh_post_buried_deep_is_promoted_to_the_seat():
    feed = _feed(30, fresh_at={22: 2.0})
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert _keys(out)[6] == "a22/p22", "the fresh post should hold the seat at index 6"
    assert _keys(feed)[22] == "a22/p22", "and it was at 22 before"


def test_a_fresh_post_already_ahead_of_the_seat_is_not_demoted():
    feed = _feed(30, fresh_at={1: 2.0})
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert _keys(out)[1] == "a1/p1", "position 1 beats the seat at 6; leave it alone"
    assert _keys(out) == _keys(feed)


def test_an_entirely_fresh_feed_is_left_alone():
    """A feed that is already fresh must not be reordered in freshness's name."""
    feed = _feed(30, fresh_at={i: 1.0 for i in range(30)})
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert _keys(out) == _keys(feed)


# ★★★ THE STALE-INCUMBENT GUARD IS COVERED BY `test_pipeline.py`, NOT HERE, AND
# THAT IS DELIBERATE AFTER TWO FAILED ATTEMPTS TO UNIT-TEST IT.
#
# The guard says: if the post already holding a seat is ITSELF fresh, leave it.
# Two constructions were written here to exercise it and both were vacuous --
# proven by mutation, not by inspection. Making every post fresh does not reach
# it (the first pick sits AT the seat and exits through the "already ahead"
# branch). Nor does the same-author variant (the cap moves the pick list but the
# seat advances a whole page each promotion, so the pick stays ahead of it).
#
# Instrumenting the real pipeline settled it: across the full suite the branch is
# reached 12 times and the guard fires 3 times, so it is live code, not dead --
# my reachability reasoning was simply wrong. Its coverage is real and lives in
# `test_feed_length_is_monotonic_in_the_follow_graph` and
# `test_a_healthy_feed_is_never_DILUTED_by_the_fallback`: both FAIL when the
# guard is removed, which is exactly how the defect was found in the first place.
#
# Writing a third contrived local test that merely LOOKS like it covers this
# would be worse than none, because it would read as coverage while asserting
# something the guard does not control.


def test_the_seat_is_taken_when_its_incumbent_is_stale():
    """The complement of the test above: a stale incumbent DOES yield."""
    feed = _feed(30, fresh_at={22: 1.0})  # only one fresh post, seat holds a stale one
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert _keys(out)[6] == "a22/p22"


def test_a_stale_post_is_never_promoted():
    feed = _feed(30, fresh_at={22: 6.5})  # just past the 6h default
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert _keys(out) == _keys(feed)


def test_a_post_dated_in_the_future_is_refused():
    """A forged or clock-skewed timestamp would otherwise take the seat forever."""
    feed = _feed(30)
    feed[22] = _sc("evil", "future", hours_old=-5.0)
    out = promote_fresh(feed, FreshnessConfig(), NOW)
    assert _keys(out) == _keys(feed)


# --------------------------------------------------------------------------
# the budgets
# --------------------------------------------------------------------------

def test_one_author_cannot_take_every_seat():
    """★ THIS TEST WAS VACUOUS ONCE AND THE MUTATION RUN CAUGHT IT.

    The first version asserted over ``_keys(out)[:20]``, but with three seats at
    6/26/46 the second and third promotions land OUTSIDE that window, so the
    assertion passed whether or not the cap existed. Removing
    ``max_posts_per_author`` failed nothing. It now asserts on the SEATS
    themselves, which is the thing the cap governs.
    """
    feed = _feed(70)
    for i, h in ((40, 1.0), (41, 2.0), (42, 3.0)):
        feed[i] = _sc("spammer", f"s{i}", hours_old=h)
    cfg = FreshnessConfig()
    out = promote_fresh(feed, cfg, NOW)
    seats = [cfg.position + p * cfg.page_size for p in range(cfg.max_slots_per_feed)]
    held = [_keys(out)[s] for s in seats if s < len(out)]
    spam = [k for k in held if k.startswith("spammer/")]
    assert len(spam) == 1, f"max_posts_per_author=1 but seats hold {held}"


def test_the_per_feed_ceiling_bounds_total_promotions():
    feed = _feed(80)
    for i, h in ((40, 1.0), (50, 2.0), (60, 3.0), (70, 4.0)):
        feed[i] = _sc(f"f{i}", f"fp{i}", hours_old=h)
    cfg = FreshnessConfig(max_slots_per_feed=2)
    out = promote_fresh(feed, cfg, NOW)
    seats = [6 + p * cfg.page_size for p in range(4)]
    held = [s for s in seats if s < len(out) and _keys(out)[s].startswith("f")]
    assert len(held) <= 2


def test_slots_per_page_zero_disables_the_lane_entirely():
    feed = _feed(30, fresh_at={22: 1.0})
    out = promote_fresh(feed, FreshnessConfig(slots_per_page=0), NOW)
    assert _keys(out) == _keys(feed), "must be byte-identical to the pre-lane behaviour"


# --------------------------------------------------------------------------
# selection order
# --------------------------------------------------------------------------

def test_selection_follows_the_rankers_order_not_recency():
    """Among posts that all qualify, the seat goes to the best-RANKED one.

    Sorting by recency here would hand the seat to whatever was posted most
    recently regardless of merit, which is a different product.
    """
    feed = _feed(30)
    feed[10] = _sc("better", "b", hours_old=5.0)   # ranked higher, less fresh
    feed[11] = _sc("newer", "n", hours_old=0.5)    # ranked lower, fresher
    picks = recent_candidates(feed, FreshnessConfig(), NOW)
    assert [c.post.author for c in picks] == ["better", "newer"]


# --------------------------------------------------------------------------
# the owner rule
# --------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [0, 1, 3, 4])
def test_the_protected_head_cannot_be_configured_away(bad):
    """1-5 one-indexed are whatever the reader earned. Enforced structurally."""
    with pytest.raises(ValueError, match="reader earned"):
        FreshnessConfig(position=bad)


# ── ★ the protected head, enforced on the SERVED feed (2026-08-24) ───────────


def test_a_placed_post_is_swapped_out_of_the_protected_head() -> None:
    """★ MEASURED DEFECT, 2026-08-24.

    `promote_fresh` seats a recent post at index 6. `insert_popular` then runs
    LAST and can both demote a head-ranked popular post to its own index AND
    evict surplus popular posts to the tail — each removal above the fresh seat
    shifts everything below it UP one. A full `rank_feed` simulation served a
    freshness-PLACED post, whose merit rank was 10-13, at position 4.

    The ordering note at `promote_fresh`'s call site anticipated only the
    DOWNWARD drift ("can push this seat from 6 to 7, and that is fine").
    Positions 1-5 are the reader's own, and this closes the upward direction.
    """
    from recsys.pipeline import _enforce_protected_head

    feed = _feed(10)
    # the placed post has drifted up to index 3, inside the protected head
    out = _enforce_protected_head(feed, {feed[3].post.key}, seat=6)
    assert out[3].post.key == "@a6/p6", "the placed post is still inside the head"
    assert out[6].post.key == "@a3/p3", "the placed post did not land on its seat"


def test_the_head_guard_is_a_swap_so_every_other_index_survives() -> None:
    """★ SWAP, NEVER MOVE. Popping and re-inserting would shift the POPULAR seat
    off its own reserved index — the exact class of bug this fixes. Only the two
    exchanged positions may differ."""
    from recsys.pipeline import _enforce_protected_head

    feed = _feed(10)
    before = [c.post.key for c in feed]
    out = [c.post.key for c in _enforce_protected_head(list(feed), {feed[2].post.key}, seat=6)]
    moved = [i for i, (a, b) in enumerate(zip(before, out)) if a != b]
    assert moved == [2, 6], f"indices other than the swapped pair changed: {moved}"


def test_the_head_guard_is_a_no_op_when_nothing_was_placed() -> None:
    """An earned head must never be reordered — the guard acts only on posts
    `promote_fresh` actually moved."""
    from recsys.pipeline import _enforce_protected_head

    feed = _feed(10)
    before = [c.post.key for c in feed]
    assert [c.post.key for c in _enforce_protected_head(list(feed), set(), seat=6)] == before
    # ...and a placed post already OUTSIDE the head is left where it is.
    assert [c.post.key for c in _enforce_protected_head(list(feed), {feed[8].post.key}, seat=6)] == before


def test_the_head_guard_tolerates_a_feed_shorter_than_the_seat() -> None:
    from recsys.pipeline import _enforce_protected_head

    feed = _feed(4)
    before = [c.post.key for c in feed]
    assert [c.post.key for c in _enforce_protected_head(list(feed), {feed[1].post.key}, seat=6)] == before


def test_the_head_guard_works_at_the_lowest_LEGAL_seat() -> None:
    """★ FOUND BY SCRUTINY — a legal config silently disabled the guard.

    `_PROTECTED_HEAD` is an EXCLUSIVE 0-indexed bound, so index 5 is the first
    seat OUTSIDE the head, and `FreshnessConfig.__post_init__` explicitly
    ACCEPTS `position = 5` as exactly that. The guard's entry test was
    `seat <= _PROTECTED_HEAD`, which treated that validator-approved value as
    "already inside the head, nothing to do" and returned unchanged. No error,
    no log line, and no test would have caught it — every other test here
    hardcodes seat=6.
    """
    from recsys.config import FreshnessConfig
    from recsys.pipeline import _enforce_protected_head

    FreshnessConfig(position=5)  # must not raise — that is the whole point

    feed = _feed(10)
    # Snapshot BEFORE the call: the guard swaps IN PLACE, so reading `feed`
    # afterwards reads the already-swapped list and compares a value to itself.
    intruder = feed[2].post.key
    out = _enforce_protected_head(feed, {intruder}, seat=5)
    assert out[2].post.key != intruder, (
        "at the lowest LEGAL seat the guard did nothing — a placed post is "
        "still sitting inside the reader's earned positions"
    )
    assert out[5].post.key == intruder


def test_the_head_guard_evicts_EVERY_intruder_not_just_the_first() -> None:
    """★ ALSO FOUND BY SCRUTINY. `max_slots_per_feed` is 3, so `promote_fresh`
    can record several keys and more than one can drift into the head. The
    original loop broke after the first swap, leaving the second placed post in
    the reader's earned positions."""
    from recsys.pipeline import _enforce_protected_head

    feed = _feed(12)
    promoted = {feed[1].post.key, feed[3].post.key}
    out = _enforce_protected_head(feed, promoted, seat=6)
    head_keys = {c.post.key for c in out[:5]}
    assert not (head_keys & promoted), f"still in the head: {head_keys & promoted}"
    tail_keys = [c.post.key for c in out[5:]]
    assert all(k in tail_keys for k in promoted), "an intruder vanished"
    assert len({c.post.key for c in out}) == len(out), "a post was duplicated"
