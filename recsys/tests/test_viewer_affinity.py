"""The viewer-own affinity channel.

MEASURED BEFORE IT EXISTED: a viewer who engaged topic-B content for 30
consecutive rounds saw topic-B's share of their feed go 0.0500 -> 0.0500. Bit
identical. Engagement moved a feed by nothing, because ~90% of the score is
viewer-blind and the only personalised term (CF) is capped at 8% in-network and
exactly 0% elsewhere.

The fix is NOT raising CF. CF is CROSS-VIEWER — other people's co-engagement
decides what you see — which is why H06/H07 capped it. This channel is
VIEWER-OWN: only the viewer's own outgoing engagement moves it, so the worst an
attacker can do by moving it is change their own feed.

★ The invariant tests at the bottom are the ones that matter. If a third party
can move viewer V's affinity, this stops being self-harm and becomes an attack
carrying more weight than CF is ever allowed.
"""

from __future__ import annotations

from datetime import timedelta

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import EngagementEdge
from recsys.core.viewer_affinity import (
    affinity_percentiles,
    blend,
    candidate_affinity,
    viewer_author_affinity,
    viewer_topic_affinity,
)
from tests.fakes import EPOCH, make_post

W = DEFAULT_SETTINGS.real_graph


def _edge(src: str, dst: str, *, upvotes: int = 0, replies: int = 0, days_ago: int = 0):
    return EngagementEdge(
        src=src, dst=dst, upvotes=upvotes, replies=replies,
        last_interaction=EPOCH - timedelta(days=days_ago),
    )


# ── the channel works ────────────────────────────────────────────────────────

def test_engaging_an_author_creates_affinity_for_them() -> None:
    edges = [_edge("me", "alice", upvotes=5), _edge("me", "bob", upvotes=1)]
    aff = viewer_author_affinity("me", edges, W, EPOCH)
    assert aff["alice"] > aff["bob"] > 0.0


def test_affinity_is_ranked_within_the_viewers_own_distribution() -> None:
    """Per-viewer normalisation — a heavy user's magnitudes must not clip anyone."""
    pct = affinity_percentiles({"alice": 100.0, "bob": 50.0, "carol": 1.0})
    assert pct["alice"] == 1.0
    assert pct["carol"] == 0.0
    assert 0.0 < pct["bob"] < 1.0


def test_more_engagement_moves_the_blended_score() -> None:
    """The whole point: sustained engagement must change the number."""
    quality = 0.5
    low = blend(quality, 0.1, 0.3)
    high = blend(quality, 0.9, 0.3)
    assert high > low, "engagement must move the score"
    assert low < quality < high


def test_topic_affinity_carries_to_authors_never_read() -> None:
    """Discovery, not just repeats: interest in a topic reaches new authors."""
    edges = [_edge("me", "alice", upvotes=5)]
    topics = viewer_topic_affinity("me", edges, W, EPOCH, {"alice": ("photography",)})
    pct = affinity_percentiles({**topics, "_floor": 0.0001})
    stranger = make_post(author="never-read", category="photography", tags=("photography",))
    assert candidate_affinity(stranger, {}, pct) is not None


def test_decay_makes_recent_engagement_count_for_more() -> None:
    recent = viewer_author_affinity("me", [_edge("me", "a", upvotes=1, days_ago=0)], W, EPOCH)
    old = viewer_author_affinity("me", [_edge("me", "a", upvotes=1, days_ago=365)], W, EPOCH)
    assert recent["a"] > old["a"]


# ── nothing changes when it should not ───────────────────────────────────────

def test_disabled_channel_is_byte_identical_to_before() -> None:
    """Weight 0.0 (the default) must reproduce the quality percentile exactly."""
    for q in (0.0, 0.25, 0.5, 0.9, 1.0):
        assert blend(q, 0.9, 0.0) == q


def test_a_viewer_with_no_history_is_scored_exactly_as_before() -> None:
    """`None` means no opinion — NOT zero, which would demote everything new."""
    for q in (0.0, 0.5, 1.0):
        assert blend(q, None, 0.3) == q


def test_a_viewer_with_one_affinity_has_no_distribution_to_rank_in() -> None:
    assert affinity_percentiles({"solo": 5.0}) == {}


# ── ★ the invariant: only the viewer can move their own affinity ─────────────

def test_engagement_aimed_AT_the_viewer_does_not_move_their_affinity() -> None:
    """★ The security property.

    If inbound edges counted, any stranger could raise their own standing in a
    victim's feed by engaging them — turning a self-harm-only channel into a
    poisonable one carrying far more weight than CF is permitted.
    """
    inbound = [_edge("stranger", "me", upvotes=50, replies=50)]
    assert viewer_author_affinity("me", inbound, W, EPOCH) == {}


def test_third_parties_engaging_each_other_do_not_move_the_viewer() -> None:
    edges = [_edge("x", "y", upvotes=99), _edge("y", "x", upvotes=99)]
    assert viewer_author_affinity("me", edges, W, EPOCH) == {}


def test_an_attacker_cannot_change_another_viewers_affinity_by_any_combination() -> None:
    """Sweep every direction an attacker could act in; the viewer's map is fixed."""
    baseline = viewer_author_affinity("me", [_edge("me", "alice", upvotes=3)], W, EPOCH)
    hostile = [
        _edge("me", "alice", upvotes=3),          # the viewer's own, unchanged
        _edge("att", "me", upvotes=99),           # attacker -> viewer
        _edge("att", "alice", upvotes=99),        # attacker -> the author
        _edge("att", "att2", upvotes=99),         # attacker -> their own alt
        _edge("alice", "me", upvotes=99),         # author -> viewer
    ]
    assert viewer_author_affinity("me", hostile, W, EPOCH) == baseline


def test_self_engagement_is_ignored() -> None:
    assert viewer_author_affinity("me", [_edge("me", "me", upvotes=99)], W, EPOCH) == {}
