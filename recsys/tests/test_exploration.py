"""Exploration slots — the only source of new information in the pipeline.

THE FINDING. `rank_feed` is a pure function of its inputs, and the package
contains no randomness, no session state and no impression memory: grep for
"random", "shuffle", "seen", "impression" and nothing appears outside comments.
So two calls with identical inputs return byte-identical feeds BY CONSTRUCTION.
Measured: a returning viewer's top-20 was identical across 77-79 of every 79
consecutive sessions, with the diversity re-ranker both ON and OFF — because the
re-ranker decides WHICH posts get frozen in, never whether the feed can change.

Exploration also pays for the viewer-own affinity channel: that channel can
capture a feed entirely (see test_engagement_drift.py), and nothing else in the
pipeline can surface something the viewer has not already shown interest in.

WHAT MUST NOT BREAK: determinism where it matters. A refresh inside a session
bucket must return the same feed, or a user can re-roll until they like it.
"""

from __future__ import annotations

from dataclasses import replace

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import CandidateSource, ScoreBreakdown, ScoredCandidate
from recsys.core.rerank import explore, rerank
from tests.fakes import make_post


def _pool(n: int) -> list[ScoredCandidate]:
    """Descending scores, so position n is genuinely 'below the cut'."""
    out = []
    for i in range(n):
        score = 1.0 - i / n
        out.append(
            ScoredCandidate(
                post=make_post(author=f"a{i:03d}", permlink=f"p{i:03d}"),
                source=CandidateSource.IN_NETWORK,
                score=ScoreBreakdown(vote_norm=score, rep_norm=score, organic=score, final=score),
            )
        )
    return out


def _keys(feed, k=20):
    return [sc.post.key for sc in feed[:k]]


def test_disabled_by_default_changes_nothing() -> None:
    """explore_slots = 0 is the shipped default and must be a no-op."""
    pool = _pool(100)
    assert explore(pool, slots=0, window=20, bucket=1, seed="v") == pool


def test_exploration_promotes_items_from_below_the_cut() -> None:
    pool = _pool(100)
    out = explore(pool, slots=3, window=20, bucket=1, seed="viewer")
    baseline = set(_keys(pool))
    promoted = set(_keys(out)) - baseline
    assert promoted, "no unexposed item reached the visible window"


def test_the_head_of_the_feed_is_never_displaced() -> None:
    """Exploration costs the weakest visible slots, never the strongest."""
    pool = _pool(100)
    out = explore(pool, slots=3, window=20, bucket=7, seed="viewer")
    assert _keys(out, 17) == _keys(pool, 17)


def test_a_refresh_within_a_session_returns_the_same_feed() -> None:
    """★ The property a random shuffle would destroy: no re-rolling."""
    pool = _pool(100)
    a = explore(pool, slots=3, window=20, bucket=42, seed="viewer")
    b = explore(pool, slots=3, window=20, bucket=42, seed="viewer")
    assert _keys(a) == _keys(b)


def test_a_later_session_bucket_differs() -> None:
    pool = _pool(100)
    buckets = [
        tuple(_keys(explore(pool, slots=3, window=20, bucket=b, seed="viewer")))
        for b in range(8)
    ]
    assert len(set(buckets)) > 1, "the feed never changed across session buckets"


def test_different_viewers_explore_differently() -> None:
    pool = _pool(100)
    feeds = {v: tuple(_keys(explore(pool, slots=3, window=20, bucket=1, seed=v))) for v in "abcde"}
    assert len(set(feeds.values())) > 1


def test_exploration_never_invents_candidates() -> None:
    """Everything promoted was already eligible — this widens exposure, not trust."""
    pool = _pool(100)
    out = explore(pool, slots=5, window=20, bucket=3, seed="viewer")
    assert {sc.post.key for sc in out} == {sc.post.key for sc in pool}
    assert len(out) == len(pool)


def test_a_pool_smaller_than_the_window_is_untouched() -> None:
    pool = _pool(10)
    assert explore(pool, slots=3, window=20, bucket=1, seed="v") == pool


def test_rerank_end_to_end_is_stable_then_varies() -> None:
    settings = replace(
        DEFAULT_SETTINGS.diversity, explore_slots=3, explore_window=20, explore_bucket_hours=6
    )
    pool = _pool(100)
    first = _keys(rerank(pool, settings, "viewer", 100))
    again = _keys(rerank(pool, settings, "viewer", 100))
    assert first == again, "identical inputs must give an identical feed"
    next_bucket = _keys(rerank(pool, settings, "viewer", 101))
    assert first != next_bucket, "consecutive session buckets produced the same feed"
