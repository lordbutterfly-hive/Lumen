"""Tests for recsys.core.rerank (§3.4, interest-aware topic diversity)."""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from recsys.config import DiversityConfig
from recsys.contracts import CandidateSource, ScoreBreakdown, ScoredCandidate
from recsys.core.rerank import diversity_rerank, rerank, truncate
from tests.fakes import make_post


def _scored(
    author: str,
    permlink: str,
    final: float,
    source: CandidateSource = CandidateSource.IN_NETWORK,
    *,
    community: str | None = None,
    tags: Sequence[str] = ("hive",),
) -> ScoredCandidate:
    post = make_post(author=author, permlink=permlink, community=community, tags=tags)
    breakdown = ScoreBreakdown(vote_norm=final, rep_norm=final, organic=final, final=final)
    return ScoredCandidate(post=post, source=source, score=breakdown)


def test_same_author_top_posts_separated_by_other_author() -> None:
    scored = [
        _scored("alice", "p1", 1.0),
        _scored("alice", "p2", 0.9),
        _scored("bob", "p3", 0.5),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.0,
        topic_decay=1.0,
        topic_floor=1.0,
        topic_affinity_strength=0.9,
    )
    authors = [c.post.author for c in result]
    assert authors == ["alice", "bob", "alice"]


def test_much_higher_base_score_still_wins() -> None:
    scored = [
        _scored("alice", "p1", 1.0),
        _scored("alice", "p2", 0.95),
        _scored("bob", "p3", 0.05),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=1.0,
        topic_floor=1.0,
        topic_affinity_strength=0.9,
    )
    assert (result[0].post.author, result[0].post.permlink) == ("alice", "p1")


def test_tie_break_is_deterministic_by_post_key() -> None:
    scored = [
        _scored("alice", "z", 1.0),
        _scored("alice", "a", 1.0),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=1.0,
        topic_floor=1.0,
        topic_affinity_strength=0.9,
    )
    assert [c.post.permlink for c in result] == ["a", "z"]


def test_tie_break_is_deterministic_across_topics() -> None:
    scored = [
        _scored("alice", "z", 1.0, community="commX"),
        _scored("alice", "a", 1.0, community="commY"),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=0.5,
        topic_floor=0.0,
        topic_affinity_strength=0.9,
    )
    assert [c.post.permlink for c in result] == ["a", "z"]


def test_author_diversity_holds_when_topics_differ() -> None:
    """Author spacing still applies even when every post is a different topic
    (so the topic penalty, which only bites on a *repeat* topic, never fires
    here) — the two penalties are independent, not substitutes."""
    scored = [
        _scored("alice", "p1", 1.0, community="commA"),
        _scored("alice", "p2", 0.9, community="commB"),
        _scored("bob", "p3", 0.5, community="commC"),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.0,
        topic_decay=0.5,
        topic_floor=0.0,
        topic_affinity_strength=0.9,
    )
    authors = [c.post.author for c in result]
    assert authors == ["alice", "bob", "alice"]


def test_diversity_rerank_does_not_mutate_input() -> None:
    scored = [_scored("alice", "p1", 1.0), _scored("bob", "p2", 0.5)]
    original = list(scored)
    diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=0.6,
        topic_floor=0.4,
        topic_affinity_strength=0.9,
    )
    assert scored == original


def test_truncate_limits_length() -> None:
    scored = [_scored("alice", f"p{i}", 1.0 - i * 0.01) for i in range(10)]
    result = truncate(scored, 3)
    assert result == scored[:3]


def test_truncate_does_not_mutate_input() -> None:
    scored = [_scored("alice", "p1", 1.0), _scored("bob", "p2", 0.5)]
    original = list(scored)
    truncate(scored, 1)
    assert scored == original


def test_rerank_applies_diversity_then_truncates() -> None:
    scored = [
        _scored("alice", "p1", 1.0),
        _scored("alice", "p2", 0.99),
        _scored("alice", "p3", 0.98),
        _scored("bob", "p4", 0.5),
    ]
    diversity = DiversityConfig(author_decay=0.5, author_floor=0.0, top_k=2)
    result = rerank(scored, diversity)
    assert len(result) == 2
    assert [c.post.author for c in result] == ["alice", "bob"]


def test_rerank_does_not_mutate_input() -> None:
    scored = [_scored("alice", "p1", 1.0), _scored("bob", "p2", 0.5)]
    original = list(scored)
    rerank(scored, DiversityConfig())
    assert scored == original


def _dominant_plus_fringe() -> list[ScoredCandidate]:
    """Five high-scored posts in the viewer's dominant community (distinct
    authors) plus one low-scored post from a fringe topic."""
    return [
        _scored("a1", "p1", 1.00, community="hive-dominant"),
        _scored("a2", "p2", 0.99, community="hive-dominant"),
        _scored("a3", "p3", 0.98, community="hive-dominant"),
        _scored("a4", "p4", 0.97, community="hive-dominant"),
        _scored("a5", "p5", 0.96, community="hive-dominant"),
        _scored("a6", "p6", 0.55, community=None, tags=("crafts", "diy")),
    ]


def test_low_affinity_topic_is_not_injected_over_dominant_interest() -> None:
    """CHANGED (interest-aware diversity): the old flat topic penalty pulled
    the 0.55-scored fringe-topic post ahead of four 0.96+-scored posts from
    the community that carries ~90% of the pool's score mass — off-interest
    content displacing on-interest content to satisfy a topic-count quota.
    Now the dominant key's penalty is attenuated by its inferred affinity, so
    the fringe post competes on raw score (and its own first placement is, as
    always, unpenalized): it places last instead of second."""
    result = diversity_rerank(
        _dominant_plus_fringe(),
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=0.5,
        topic_floor=0.0,
        topic_affinity_strength=0.9,
    )
    keys = [c.post.permlink for c in result]
    assert keys == ["p1", "p2", "p3", "p4", "p5", "p6"]


def test_strength_zero_restores_interest_blind_interleave() -> None:
    """``topic_affinity_strength=0.0`` is the exact old §3.4 behavior: the
    fringe post jumps ahead of four same-community posts once the dominant
    community has been placed once (the pre-change assertion, kept as the
    escape-hatch anchor)."""
    result = diversity_rerank(
        _dominant_plus_fringe(),
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=0.5,
        topic_floor=0.0,
        topic_affinity_strength=0.0,
    )
    keys = [c.post.permlink for c in result]
    assert keys == ["p1", "p6", "p2", "p3", "p4", "p5"]


def test_comparable_affinity_topics_still_interleave() -> None:
    """Diversity WITHIN the interest profile survives: between two topics of
    comparable affinity, a repeat of the top topic still yields to a
    close-scored post from the other — the 0.9 strength keeps a whisper of
    alternation pressure among co-equal interests."""
    scored = [
        _scored("a1", "p1", 1.000, community="hive-photo"),
        _scored("a2", "p2", 0.987, community="hive-photo"),
        _scored("b1", "p3", 0.985, community="hive-travel"),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=0.5,
        topic_floor=0.0,
        topic_affinity_strength=0.9,
    )
    keys = [c.post.permlink for c in result]
    assert keys == ["p1", "p3", "p2"]


def test_co_dominant_topics_both_keep_alternation_pressure() -> None:
    """Regression pin for the affinity-normalization bug: the old code
    normalized each topic's score mass by the MAX topic's mass, so every topic
    comparable to the biggest got affinity ~1.0 and its penalty switched fully
    off — a viewer with two co-equal interests lost topic diversity across
    both at once (here: all three commA posts before any commB post). Under
    total-mass normalization each co-equal topic holds ~0.5 affinity, keeping
    real alternation pressure: the feed interleaves A, B, A, B, A, B. Author
    penalty is neutralized (decay=floor=1.0) to isolate the topic penalty."""
    scored = [
        _scored("a1", "p1", 1.00, community="commA"),
        _scored("a2", "p2", 0.99, community="commA"),
        _scored("a3", "p3", 0.98, community="commA"),
        _scored("b1", "p4", 0.97, community="commB"),
        _scored("b2", "p5", 0.96, community="commB"),
        _scored("b3", "p6", 0.95, community="commB"),
    ]
    result = diversity_rerank(
        scored,
        author_decay=1.0,
        author_floor=1.0,
        topic_decay=0.5,
        topic_floor=0.0,
        topic_affinity_strength=0.9,
    )
    keys = [c.post.permlink for c in result]
    assert keys == ["p1", "p4", "p2", "p5", "p3", "p6"]


def test_author_diversity_survives_inside_dominant_topic() -> None:
    """The trap guard: exempting the viewer's dominant topic from the topic
    penalty must NOT disable author spacing inside it — the author penalty is
    never affinity-scaled."""
    scored = [
        _scored("alice", "p1", 1.00, community="hive-photo"),
        _scored("alice", "p2", 0.99, community="hive-photo"),
        _scored("bob", "p3", 0.70, community="hive-photo"),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=0.6,
        topic_floor=0.4,
        topic_affinity_strength=0.9,
    )
    assert [c.post.author for c in result] == ["alice", "bob", "alice"]


def test_all_zero_scores_fall_back_to_deterministic_order() -> None:
    """A degenerate all-zero-score pool must not divide by zero: affinities
    collapse to 0 (flat penalty) and the post.key tie-break orders the feed."""
    scored = [
        _scored("b", "z", 0.0, community="commA"),
        _scored("a", "y", 0.0, community="commB"),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5,
        author_floor=0.25,
        topic_decay=0.6,
        topic_floor=0.4,
        topic_affinity_strength=0.9,
    )
    assert [c.post.key for c in result] == ["@a/y", "@b/z"]


def test_config_rejects_out_of_range_affinity_strength() -> None:
    with pytest.raises(ValueError, match="topic_affinity_strength"):
        DiversityConfig(topic_affinity_strength=1.5)
    with pytest.raises(ValueError, match="topic_affinity_strength"):
        DiversityConfig(topic_affinity_strength=-0.1)


def test_rerank_low_affinity_not_injected_via_public_api() -> None:
    """Through the public rerank()/DiversityConfig entry point the pipeline
    actually calls (default topic_affinity_strength=0.9): the low-affinity
    community's post is no longer hoisted to slot 2 — it places on raw
    score."""
    scored = [
        _scored("a1", "p1", 1.00, community="hive-dominant"),
        _scored("a2", "p2", 0.99, community="hive-dominant"),
        _scored("a3", "p3", 0.98, community="hive-dominant"),
        _scored("a4", "p4", 0.55, community="other-community"),
    ]
    diversity = DiversityConfig(
        author_decay=0.5, author_floor=0.25, topic_decay=0.5, topic_floor=0.0, top_k=200
    )
    result = rerank(scored, diversity)
    keys = [c.post.permlink for c in result]
    assert keys == ["p1", "p2", "p3", "p4"]


# ---------------------------------------------------------------------------
# Unchosen-source penalty (2026-08-03): bound how much of a viewer's feed can
# come from lanes they never asked for. See CandidateSource.is_viewer_chosen
# for the measurement, and measurement-harness/q11_follow_curve.py for the sweep.
# ---------------------------------------------------------------------------

_NEUTRAL = dict(
    author_decay=1.0, author_floor=1.0, topic_decay=1.0, topic_floor=1.0,
    topic_affinity_strength=0.0,
)


def test_unchosen_floor_of_one_is_an_exact_no_op() -> None:
    # The control column of every sweep. `_pen` returns exactly 1.0 at floor
    # 1.0 for any decay, so the ordering must be byte-identical -- assert
    # equality of the full order, not a metric.
    scored = [
        _scored("a", "p1", 0.90, CandidateSource.OON_ENGAGED),
        _scored("b", "p2", 0.89, CandidateSource.IN_NETWORK),
        _scored("c", "p3", 0.88, CandidateSource.OON_ENGAGED),
        _scored("d", "p4", 0.87, CandidateSource.IN_NETWORK),
    ]
    off = diversity_rerank(scored, **_NEUTRAL)
    explicit = diversity_rerank(scored, **_NEUTRAL, unchosen_decay=0.5, unchosen_floor=1.0)
    assert [c.post.key for c in off] == [c.post.key for c in explicit]


def test_unchosen_lane_cannot_monopolise_the_feed() -> None:
    # The defect in miniature: an engagement-selected lane whose every candidate
    # outscores every in-network one. Without the penalty it takes the whole
    # head; with it, the viewer's own follows get in.
    # Topics mirror the measured shape: at 20 same-topic follows EVERY
    # IN_NETWORK post was on-topic and EVERY OON_ENGAGED post was off-topic.
    # The score gap between the lanes is the MEASURED one (+0.05; the real range
    # was +0.04 to +0.22 mean organic across seeds), not an invented landslide —
    # a penalty is meant to correct a systematic edge, not to overturn any gap.
    scored = [
        _scored(f"oon{i}", f"o{i}", 0.75 - i * 0.01, CandidateSource.OON_ENGAGED,
                community="misc")
        for i in range(6)
    ] + [
        _scored(f"inn{i}", f"n{i}", 0.70 - i * 0.01, CandidateSource.IN_NETWORK,
                community="photo")
        for i in range(6)
    ]
    off = diversity_rerank(scored, **_NEUTRAL)
    on = diversity_rerank(scored, **_NEUTRAL, unchosen_decay=0.8, unchosen_floor=0.4)
    head_off = sum(1 for c in off[:6] if c.source == CandidateSource.IN_NETWORK)
    head_on = sum(1 for c in on[:6] if c.source == CandidateSource.IN_NETWORK)
    # Measured: control 1 of the first 6 slots in-network, penalty 4 of 6.
    assert head_off <= 1, "control should be dominated by the unchosen lane"
    assert head_on >= 4
    assert head_on > head_off


def test_KNOWN_LIMIT_penalty_is_inert_when_the_pool_is_one_topic() -> None:
    """A real limit of the topic-attenuated form, pinned so it is not a surprise.

    Affinity is a topic's share of the pool's score mass, so a single-topic pool
    gives that topic affinity 1.0 and `_attenuate` switches the penalty fully
    OFF. That is correct on its own terms — with no off-topic content there is
    no spillover to bound.

    ★ AND THE SAME-TOPIC CASE IT LEAVES OPEN IS BENIGN — measured 2026-08-03,
    so this is a deliberate non-fix rather than an unexamined gap. Same-topic
    strangers in a viewer's top-20, by same-topic follow count (seeds 7/11/23):

        follows   own-follow slots   same-topic stranger slots
           5            5-7                  6-11
          12            9-11                  0-4
          20           10-12                   0

    The "crowding" is heaviest exactly when the viewer follows fewest people —
    i.e. it is DISCOVERY inside their declared interest — and it disappears on
    its own as they follow more of the topic (by 20 follows the pool contains no
    same-topic strangers at all, because they follow them). Penalising it would
    take content the viewer plainly wants and would hit the newest viewers
    hardest. Left alone on purpose.
    """
    scored = [
        _scored(f"oon{i}", f"o{i}", 0.90, CandidateSource.OON_ENGAGED, community="photo")
        for i in range(4)
    ] + [
        _scored(f"inn{i}", f"n{i}", 0.70, CandidateSource.IN_NETWORK, community="photo")
        for i in range(4)
    ]
    off = diversity_rerank(scored, **_NEUTRAL)
    on = diversity_rerank(scored, **_NEUTRAL, unchosen_decay=0.8, unchosen_floor=0.4)
    assert [c.post.key for c in off] == [c.post.key for c in on]


def test_unchosen_penalty_spares_the_viewers_own_topic() -> None:
    """The reason the penalty is topic-attenuated at all.

    A BLANKET lane penalty was measured and rejected: it fixed the follow curve
    but destroyed new-author discovery (q3's newcomer went from top-20 for 10/10
    established viewers to 0/10), because the same lane carries both. Unchosen
    content in the topic the viewer actually reads must therefore keep its
    place, while unchosen content from elsewhere is what gets bounded.
    """
    # Pool mass is dominated by "photo", so photo affinity is high and "misc" low.
    scored = [
        _scored(f"p{i}", f"pp{i}", 0.80, CandidateSource.IN_NETWORK, community="photo")
        for i in range(8)
    ] + [
        _scored("newcomer", "debut", 0.60, CandidateSource.OON_ENGAGED, community="photo"),
        _scored("stranger", "off", 0.60, CandidateSource.OON_ENGAGED, community="misc"),
    ]
    ranked = diversity_rerank(
        scored,
        author_decay=1.0, author_floor=1.0, topic_decay=1.0, topic_floor=1.0,
        topic_affinity_strength=0.0,
        unchosen_decay=0.8, unchosen_floor=0.4,
    )
    order = [c.post.author for c in ranked]
    # identical raw score, identical source — only the topic differs
    assert order.index("newcomer") < order.index("stranger")
