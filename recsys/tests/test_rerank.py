"""Tests for recsys.core.rerank (§3.4, interest-aware topic diversity)."""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from recsys.config import DiversityConfig, ScoreWeights
from recsys.contracts import CandidateSource, ScoreBreakdown, ScoredCandidate
from recsys.core.rerank import (
    _attenuate,
    _FeedCounters,
    _pen,
    _tie_break,
    _topic_key,
    diversity_rerank,
    rerank,
    truncate,
)
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


# ---------------------------------------------------------------------------
# B-03 (2026-08-04): the share-based unchosen quota + relevance guard that
# replaces the flat `unchosen_max_per_page` count. See
# recsys/config.py::DiversityConfig.unchosen_max_share for the measured
# frontier this closes. `_NEUTRAL` (above) still zeroes the author/topic
# penalties; these tests additionally hold the geometric unchosen-lane
# penalty at its own no-op (decay=floor=1.0) unless a test says otherwise, so
# only the quota mechanism under test can move the ordering.
# ---------------------------------------------------------------------------

_PEN_OFF = dict(unchosen_decay=1.0, unchosen_floor=1.0)


def test_unchosen_share_of_one_is_an_exact_no_op() -> None:
    # The control column of the B-03 sweep, mirroring
    # test_unchosen_floor_of_one_is_an_exact_no_op above: share=1.0 must
    # reproduce the byte-identical order regardless of min_per_page or the
    # displacement ratio, because `_quota` can never bind at share=1.0.
    scored = [
        _scored("a", "p1", 0.90, CandidateSource.OON_ENGAGED),
        _scored("b", "p2", 0.89, CandidateSource.IN_NETWORK),
        _scored("c", "p3", 0.88, CandidateSource.OON_ENGAGED),
        _scored("d", "p4", 0.87, CandidateSource.IN_NETWORK),
    ]
    off = diversity_rerank(scored, **_NEUTRAL, **_PEN_OFF)
    explicit = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=1.0, unchosen_min_per_page=5, unchosen_displacement_ratio=0.9,
    )
    assert [c.post.key for c in off] == [c.post.key for c in explicit]


def test_unchosen_min_per_page_binds_when_share_rounds_to_zero() -> None:
    # At placed=0, floor(share * (placed + 1)) == floor(0.02 * 1) == 0 -- a
    # pure share with no floor would block even the FIRST unchosen candidate
    # the moment any chosen candidate exists, however strong the unchosen one
    # is. `unchosen_min_per_page` exists precisely to stop that.
    scored = [
        _scored("unchosen1", "u1", 0.90, CandidateSource.OON_ENGAGED),
        _scored("chosen1", "c1", 0.10, CandidateSource.IN_NETWORK),
    ]
    no_floor = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.02, unchosen_min_per_page=0, unchosen_displacement_ratio=0.0,
    )
    # No floor: the weak chosen candidate is forced ahead of the far stronger
    # unchosen one purely because the share quota (0 slots at placed=0) with
    # no guard (ratio=0.0) blocks it outright.
    assert [c.post.author for c in no_floor] == ["chosen1", "unchosen1"]

    with_floor = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.02, unchosen_min_per_page=1, unchosen_displacement_ratio=0.0,
    )
    # The floor guarantees at least 1 unchosen slot even at placed=0, so the
    # stronger unchosen candidate is free to win on raw score.
    assert [c.post.author for c in with_floor] == ["unchosen1", "chosen1"]


def test_unchosen_share_quota_caps_the_lane_like_the_old_count() -> None:
    # The share-based mechanism must still do the ORIGINAL job: a lane whose
    # every candidate outscores every in-network one must not take the whole
    # head. Same shape as test_unchosen_lane_cannot_monopolise_the_feed, now
    # driven by share/min instead of unchosen_per_page.
    scored = [
        _scored(f"oon{i}", f"o{i}", 0.75 - i * 0.01, CandidateSource.OON_ENGAGED, community="misc")
        for i in range(6)
    ] + [
        _scored(f"inn{i}", f"n{i}", 0.70 - i * 0.01, CandidateSource.IN_NETWORK, community="photo")
        for i in range(6)
    ]
    off = diversity_rerank(scored, **_NEUTRAL, **_PEN_OFF)
    on = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.15, unchosen_min_per_page=1, unchosen_displacement_ratio=0.0,
        page_size=12,
    )
    head_off = sum(1 for c in off[:6] if c.source == CandidateSource.IN_NETWORK)
    head_on = sum(1 for c in on[:6] if c.source == CandidateSource.IN_NETWORK)
    assert head_off <= 1, "control should be dominated by the unchosen lane"
    assert head_on > head_off


def test_displacement_guard_lets_a_much_stronger_unchosen_candidate_through() -> None:
    # The failure mode the guard exists to close: the old flat cap's only
    # supply condition was "does ANY chosen candidate exist", with no score
    # comparison at all, so an arbitrarily weak chosen candidate evicted a
    # far stronger unchosen one. share=0/min=0 makes the quota bind
    # immediately; ratio=0.5 means capping should only happen when the best
    # chosen candidate is within a comparable range of the best unchosen one.
    scored = [
        _scored("weak_chosen", "c1", 0.10, CandidateSource.IN_NETWORK),
        _scored("strong_unchosen", "u1", 0.95, CandidateSource.OON_ENGAGED),
    ]
    guarded = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.5,
    )
    # 0.10 < 0.5 * 0.95 == 0.475 -- the guard refuses to cap, so the far
    # stronger unchosen candidate wins on raw score despite quota pressure.
    assert [c.post.author for c in guarded] == ["strong_unchosen", "weak_chosen"]

    # The same pool with NO guard (ratio=0.0) reproduces the old defect: the
    # weak chosen candidate is forced ahead purely because it exists.
    unguarded = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.0,
    )
    assert [c.post.author for c in unguarded] == ["weak_chosen", "strong_unchosen"]


def test_displacement_guard_still_caps_when_chosen_is_comparably_strong() -> None:
    # The guard is a THRESHOLD, not a blanket exemption for the unchosen lane:
    # when the best chosen candidate is genuinely close to the best unchosen
    # one, capping still fires.
    scored = [
        _scored("close_chosen", "c1", 0.85, CandidateSource.IN_NETWORK),
        _scored("slightly_ahead_unchosen", "u1", 0.90, CandidateSource.OON_ENGAGED),
    ]
    guarded = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.9,
    )
    # 0.85 >= 0.9 * 0.90 == 0.81 -- close enough that the guard still allows
    # capping, so the chosen candidate takes the slot despite scoring lower.
    assert [c.post.author for c in guarded] == ["close_chosen", "slightly_ahead_unchosen"]


def test_config_rejects_out_of_range_unchosen_share() -> None:
    with pytest.raises(ValueError, match="unchosen_max_share"):
        DiversityConfig(unchosen_max_share=1.5)
    with pytest.raises(ValueError, match="unchosen_max_share"):
        DiversityConfig(unchosen_max_share=-0.1)


def test_config_rejects_negative_unchosen_min_per_page() -> None:
    with pytest.raises(ValueError, match="unchosen_min_per_page"):
        DiversityConfig(unchosen_min_per_page=-1)


def test_config_rejects_negative_unchosen_displacement_ratio() -> None:
    with pytest.raises(ValueError, match="unchosen_displacement_ratio"):
        DiversityConfig(unchosen_displacement_ratio=-0.1)


def test_rerank_unchosen_max_per_page_zero_disables_the_whole_quota_mechanism() -> None:
    # ★ Backward-compatible TOGGLE (R5). `unchosen_max_per_page <= 0` must
    # disable share/min/ratio entirely through the public `rerank()` entry
    # point, regardless of how aggressively they are configured — the same
    # "0 = off" meaning the field has always had.
    scored = [
        _scored(f"oon{i}", f"o{i}", 0.9 - i * 0.01, CandidateSource.OON_ENGAGED)
        for i in range(6)
    ] + [
        _scored(f"inn{i}", f"n{i}", 0.5 - i * 0.01, CandidateSource.IN_NETWORK)
        for i in range(2)
    ]
    aggressive_but_toggled_off = DiversityConfig(
        author_decay=1.0, author_floor=1.0, topic_decay=1.0, topic_floor=1.0,
        unchosen_source_decay=1.0, unchosen_source_floor=1.0,
        unchosen_max_per_page=0,
        unchosen_max_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.0,
        top_k=200,
    )
    truly_off = DiversityConfig(
        author_decay=1.0, author_floor=1.0, topic_decay=1.0, topic_floor=1.0,
        unchosen_source_decay=1.0, unchosen_source_floor=1.0,
        unchosen_max_per_page=0,
        top_k=200,
    )
    a = rerank(scored, aggressive_but_toggled_off)
    b = rerank(scored, truly_off)
    assert [c.post.key for c in a] == [c.post.key for c in b]
    # And it is genuinely a no-op vs no quota at all: pure score order.
    assert [c.post.key for c in a] == sorted(
        (c.post.key for c in scored),
        key=lambda k: -next(c.score.final for c in scored if c.post.key == k),
    )


# ---------------------------------------------------------------------------
# B-04 (2026-08-04): the emerging-author budget — a SEPARATE, small budget
# outside the unchosen share, for candidates whose author has not yet earned
# real standing. `emerging_authors` is caller-supplied (built in
# recsys.pipeline._score from graph_creds); these tests supply it directly.
# ---------------------------------------------------------------------------


def test_emerging_authors_bypass_the_unchosen_quota_via_a_separate_budget() -> None:
    scored = [
        _scored("established", "c1", 0.5, CandidateSource.IN_NETWORK),
        _scored("newbie", "u_new", 0.6, CandidateSource.OON_ENGAGED),
        _scored("spillover", "u_old", 0.7, CandidateSource.OON_ENGAGED),
    ]
    ranked = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.0,
        emerging_authors=frozenset({"newbie"}), emerging_per_page=1,
    )
    # "newbie" bypasses the fully-closed quota via its own budget and is
    # placed first (it also has the highest score among what is admissible at
    # each step); "spillover" — the highest RAW score overall — has no
    # exemption and is pushed to last because the quota is closed against it
    # whenever a chosen candidate remains.
    assert [c.post.author for c in ranked] == ["newbie", "established", "spillover"]


def test_emerging_budget_falls_back_to_ordinary_unchosen_once_exhausted() -> None:
    # Two emerging authors, budget for only one per page: the first admitted
    # uses the budget; the second gets no free pass and is treated as an
    # ordinary unchosen candidate (still subject to the fully-closed quota).
    scored = [
        _scored("established", "c1", 0.5, CandidateSource.IN_NETWORK),
        _scored("newbie_a", "u_a", 0.65, CandidateSource.OON_ENGAGED),
        _scored("newbie_b", "u_b", 0.60, CandidateSource.OON_ENGAGED),
    ]
    ranked = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.0,
        emerging_authors=frozenset({"newbie_a", "newbie_b"}), emerging_per_page=1,
    )
    # newbie_a (higher score) takes the one emerging slot; newbie_b, with no
    # budget left, falls behind the chosen candidate exactly like an ordinary
    # unchosen candidate would under a fully-closed quota.
    assert [c.post.author for c in ranked] == ["newbie_a", "established", "newbie_b"]


def test_emerging_placement_does_not_consume_the_unchosen_share() -> None:
    # The budget is OUTSIDE the share, never eating into it: an emerging
    # placement must not bring a SUBSEQUENT ordinary unchosen candidate any
    # closer to being capped than if the emerging pick had never happened.
    # `unchosen_min_per_page=1` (share=0.0) gives a CONSTANT ordinary budget
    # of exactly 1 unchosen slot, independent of `placed` -- the cleanest way
    # to observe whether the emerging pick silently spent it.
    with_emerging = [
        _scored("chosen1", "c1", 0.50, CandidateSource.IN_NETWORK),
        _scored("chosen2", "c2", 0.45, CandidateSource.IN_NETWORK),
        _scored("newbie", "u_new", 0.60, CandidateSource.OON_ENGAGED),
        _scored("spillover", "u_old", 0.55, CandidateSource.OON_ENGAGED),
    ]
    ranked = diversity_rerank(
        with_emerging, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.0, unchosen_min_per_page=1, unchosen_displacement_ratio=0.0,
        emerging_authors=frozenset({"newbie"}), emerging_per_page=1,
    )
    # Both "newbie" (via its own budget) and "spillover" (via the ordinary
    # 1-per-page floor, UNTOUCHED by the emerging pick) place ahead of BOTH
    # chosen candidates -- if the emerging placement had consumed the
    # ordinary budget, "spillover" would have queued behind a chosen post.
    assert [c.post.author for c in ranked] == ["newbie", "spillover", "chosen1", "chosen2"]


def test_emerging_per_page_zero_disables_the_lane() -> None:
    scored = [
        _scored("established", "c1", 0.5, CandidateSource.IN_NETWORK),
        _scored("newbie", "u_new", 0.6, CandidateSource.OON_ENGAGED),
    ]
    ranked = diversity_rerank(
        scored, **_NEUTRAL, **_PEN_OFF,
        unchosen_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.0,
        emerging_authors=frozenset({"newbie"}), emerging_per_page=0,
    )
    # No budget at all: "newbie" is an ordinary unchosen candidate and loses
    # its slot to the chosen candidate under the fully-closed quota.
    assert [c.post.author for c in ranked] == ["established", "newbie"]


def test_config_rejects_negative_emerging_per_page() -> None:
    with pytest.raises(ValueError, match="emerging_per_page"):
        DiversityConfig(emerging_per_page=-1)


def test_rerank_threads_emerging_authors_through_to_the_reranker() -> None:
    scored = [
        _scored("established", "c1", 0.5, CandidateSource.IN_NETWORK),
        _scored("newbie", "u_new", 0.6, CandidateSource.OON_ENGAGED),
        _scored("spillover", "u_old", 0.7, CandidateSource.OON_ENGAGED),
    ]
    diversity = DiversityConfig(
        author_decay=1.0, author_floor=1.0, topic_decay=1.0, topic_floor=1.0,
        unchosen_source_decay=1.0, unchosen_source_floor=1.0,
        unchosen_max_per_page=1,  # toggle ON
        unchosen_max_share=0.0, unchosen_min_per_page=0, unchosen_displacement_ratio=0.0,
        emerging_per_page=1,
        top_k=200,
    )
    without = rerank(scored, diversity)
    with_emerging = rerank(scored, diversity, emerging_authors=frozenset({"newbie"}))
    # Default (no emerging_authors supplied) is a no-op — neither unchosen
    # candidate gets an exemption, so "established" (the only chosen source)
    # goes first and the cap releases once it is the only one left; the two
    # unchosen candidates then place by raw score ("spillover" 0.7 > "newbie" 0.6).
    assert [c.post.author for c in without] == ["established", "spillover", "newbie"]
    # With "newbie" named as emerging, it jumps ahead via its own budget.
    assert [c.post.author for c in with_emerging] == ["newbie", "established", "spillover"]


# ============================================================================
# ★ 2026-08-05 — THE EARNED/DECLARED SPLIT. The multiplicative diversity
# penalties act on the score's RATIO scale, so their real strength depends on
# where the score's zero sits. `ScoreWeights.interest_match` (B-02) adds a flat
# per-topic offset, which silently roughly DOUBLED the author penalty's
# displacement threshold and masked the author-pooled quality prior (it went
# negative on 5 of 32 worlds). The fix: the author and unchosen-lane penalties
# discount the EARNED part only; the topic penalty still discounts everything.
# These tests pin that, because a future term that re-couples them would look
# exactly like a tuning drift in the panels.
# ============================================================================


def _with_bonus(sc: ScoredCandidate, earned: float, bonus: float) -> ScoredCandidate:
    """Rebuild a candidate as `earned + bonus`, recording the bonus as the
    declared-interest offset the way `score_candidate` does."""
    return ScoredCandidate(
        post=sc.post,
        source=sc.source,
        score=ScoreBreakdown(
            vote_norm=earned, rep_norm=earned, organic=earned,
            final=earned + bonus, interest_bonus=bonus,
        ),
    )


@pytest.mark.parametrize("bonus", [0.0, 0.1, 0.32, 0.6])
def test_author_penalty_ordering_is_invariant_to_the_declared_interest_offset(
    bonus: float,
) -> None:
    # Every candidate is on-interest, so the offset is a CONSTANT across the
    # comparison and must therefore change nothing about who wins. Before the
    # fix, raising it flipped this: alice's second post lost to bob's first.
    earned = {"a1": 0.90, "a2": 0.80, "b1": 0.55}
    scored = [
        _with_bonus(_scored("alice", "a1", earned["a1"]), earned["a1"], bonus),
        _with_bonus(_scored("alice", "a2", earned["a2"]), earned["a2"], bonus),
        _with_bonus(_scored("bob", "b1", earned["b1"]), earned["b1"], bonus),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5, author_floor=0.25,
        topic_decay=1.0, topic_floor=1.0, topic_affinity_strength=0.0,
    )
    # 0.80 * 0.625 = 0.50 < 0.55, so bob takes slot 2 at EVERY offset.
    assert [c.post.permlink for c in result] == ["a1", "b1", "a2"]


@pytest.mark.parametrize("bonus", [0.0, 0.1, 0.32, 0.6])
def test_a_strong_author_repeat_still_beats_a_weak_rival_at_every_offset(
    bonus: float,
) -> None:
    # The mirror case: the earned gap IS big enough, so the repeat wins — and
    # keeps winning however large the shared offset is. Before the fix a large
    # enough offset drowned the gap and handed the slot to the weak rival.
    earned = {"a1": 0.90, "a2": 0.85, "b1": 0.20}
    scored = [
        _with_bonus(_scored("alice", "a1", earned["a1"]), earned["a1"], bonus),
        _with_bonus(_scored("alice", "a2", earned["a2"]), earned["a2"], bonus),
        _with_bonus(_scored("bob", "b1", earned["b1"]), earned["b1"], bonus),
    ]
    result = diversity_rerank(
        scored,
        author_decay=0.5, author_floor=0.25,
        topic_decay=1.0, topic_floor=1.0, topic_affinity_strength=0.0,
    )
    # 0.85 * 0.625 = 0.53 > 0.20 at every offset.
    assert [c.post.permlink for c in result] == ["a1", "a2", "b1"]


def test_the_topic_penalty_still_discounts_the_declared_interest_offset() -> None:
    # The deliberate ASYMMETRY: the topic penalty is the mechanism that bounds
    # how much of a feed one topic takes, and the offset IS the topic signal —
    # so it stays subject to it. Exempting it there was measured and collapses
    # topic entropy@20 from 0.590 to 0.159 bits.
    hot = [
        _with_bonus(_scored("a", f"h{i}", 0.5, community="hive-photo"), 0.5, 0.32)
        for i in range(3)
    ]
    cold = _with_bonus(_scored("z", "c1", 0.30, community="hive-food"), 0.30, 0.0)
    result = diversity_rerank(
        [*hot, cold],
        author_decay=1.0, author_floor=1.0,
        topic_decay=0.2, topic_floor=0.0, topic_affinity_strength=0.0,
    )
    # One hot post in, the topic penalty has already crushed the whole score —
    # OFFSET INCLUDED — from 0.82 to 0.164, below the off-topic post's 0.30, so
    # the cold topic takes slot 2. Were the offset exempt here, the hot posts
    # would keep 0.32 apiece and sweep the page: that is the entropy collapse.
    assert [c.post.permlink for c in result] == ["h0", "c1", "h1", "h2"]


def test_zero_interest_bonus_reproduces_the_pre_2026_08_05_effective_score() -> None:
    # THE BYTE-IDENTITY NET. With no declared-interest offset anywhere, the
    # split expression `(earned*pen_a*pen_u + 0) * pen_t` is algebraically the
    # old `final*pen_a*pen_t*pen_u`. Asserted against an INDEPENDENT
    # re-implementation of the pre-2026-08-05 selection loop rather than a
    # hardcoded ordering, so it keeps testing the equivalence rather than one
    # sample of it.
    scored = [
        _scored("alice", "p1", 0.9, CandidateSource.IN_NETWORK),
        _scored("alice", "p2", 0.8, CandidateSource.IN_NETWORK),
        _scored("bob", "p3", 0.7, CandidateSource.OON_ENGAGED),
        _scored("carol", "p4", 0.6, CandidateSource.OON_ENGAGED),
        _scored("dan", "p5", 0.55, CandidateSource.OON_INTEREST, community="hive-food"),
    ]
    assert all(c.score.interest_bonus == 0.0 for c in scored)
    kwargs = dict(
        author_decay=0.5, author_floor=0.25,
        topic_decay=0.6, topic_floor=0.4, topic_affinity_strength=0.5,
        unchosen_decay=0.8, unchosen_floor=0.4,
    )
    result = diversity_rerank(scored, **kwargs)  # type: ignore[arg-type]
    assert [c.post.permlink for c in result] == [
        c.post.permlink for c in _pre_20260805_rerank(scored, **kwargs)  # type: ignore[arg-type]
    ]


def _pre_20260805_rerank(
    scored: list[ScoredCandidate],
    *,
    author_decay: float,
    author_floor: float,
    topic_decay: float,
    topic_floor: float,
    topic_affinity_strength: float,
    unchosen_decay: float = 1.0,
    unchosen_floor: float = 1.0,
) -> list[ScoredCandidate]:
    """The pre-2026-08-05 selection loop, verbatim in its essentials: affinity
    from ``final`` mass, and every penalty multiplied onto the WHOLE score.
    Kept here (quota/emerging budgets omitted — they are orthogonal and off in
    the caller above) purely as the control for the identity assertion."""
    mass: dict[str, float] = {}
    for candidate in scored:
        key = _topic_key(candidate.post)
        mass[key] = mass.get(key, 0.0) + max(candidate.score.final, 0.0)
    total = sum(mass.values())
    affinities = {k: (v / total if total > 0 else 0.0) for k, v in mass.items()}
    tie_breaks = {c.post.key: _tie_break("", c.post.key) for c in scored}
    remaining = list(scored)
    author_counts: dict[str, int] = {}
    topic_counts: dict[str, int] = {}
    unchosen_placed = 0
    result: list[ScoredCandidate] = []
    while remaining:
        best_rank: tuple[float, str] | None = None
        best_index = 0
        for index, candidate in enumerate(remaining):
            topic_key = _topic_key(candidate.post)
            affinity = topic_affinity_strength * affinities.get(topic_key, 0.0)
            effective = (
                candidate.score.final
                * _pen(author_counts.get(candidate.post.author, 0), author_decay, author_floor)
                * _pen(
                    topic_counts.get(topic_key, 0),
                    _attenuate(topic_decay, affinity),
                    _attenuate(topic_floor, affinity),
                )
            )
            if not candidate.source.is_viewer_chosen:
                effective *= _attenuate(
                    _pen(unchosen_placed, unchosen_decay, unchosen_floor),
                    affinities.get(topic_key, 0.0),
                )
            rank = (-effective, tie_breaks[candidate.post.key])
            if best_rank is None or rank < best_rank:
                best_rank = rank
                best_index = index
        chosen = remaining.pop(best_index)
        author_counts[chosen.post.author] = author_counts.get(chosen.post.author, 0) + 1
        key = _topic_key(chosen.post)
        topic_counts[key] = topic_counts.get(key, 0) + 1
        if not chosen.source.is_viewer_chosen:
            unchosen_placed += 1
        result.append(chosen)
    return result


# ---------------------------------------------------------------------------
# C3 (2026-08-05) — diversity counters are FEED-scoped, not block-scoped.
#
# `rank_feed` reranks up to three disjoint pools per request. These counters
# were local to each call, so author/topic spacing reset at every block
# boundary while every mechanism built on them is documented as feed-scoped.
# ---------------------------------------------------------------------------


_DIV = dict(
    author_decay=0.5,
    author_floor=0.1,
    topic_decay=1.0,
    topic_floor=1.0,
    topic_affinity_strength=0.0,
)


def test_author_penalty_carries_across_rerank_blocks() -> None:
    """★ THE DEFECT. An author placed repeatedly in block 1 must not start from
    zero penalty in block 2. Same author, two blocks, one feed.

    Mutation-checked: dropping `carried=` from the second call restores the
    identical effective score and this fails.
    """
    counters = _FeedCounters()
    block1 = [_scored("hog", f"p{i}", 0.9) for i in range(4)]
    diversity_rerank(block1, **_DIV, carried=counters)
    assert counters.author_counts["hog"] == 4

    # Block 2: the same author against a fresh rival of equal raw score.
    block2 = [_scored("hog", "p9", 0.5), _scored("newcomer", "p1", 0.5)]
    carried_out = diversity_rerank(block2, **_DIV, carried=counters)
    fresh_out = diversity_rerank(block2, **_DIV)

    assert carried_out[0].post.author == "newcomer", (
        "with four prior placements carried over, the hogging author must not "
        "still win the first slot of the next block"
    )
    assert fresh_out[0].post.author == "hog", (
        "control: with counters reset (the old behaviour) the tie-break favours "
        "'hog', which is exactly the bug"
    )


def test_omitting_carried_reproduces_the_old_per_call_behaviour_exactly() -> None:
    """Every unit test and panel that reranks ONE pool must be untouched — the
    feed-scoping is opt-in by the caller that actually has multiple blocks."""
    pool = [_scored("a", f"p{i}", 0.9 - i / 100) for i in range(3)] + [
        _scored("b", "p0", 0.5)
    ]
    assert [c.post.key for c in diversity_rerank(pool, **_DIV)] == [
        c.post.key for c in diversity_rerank(pool, **_DIV, carried=None)
    ]


# ---------------------------------------------------------------------------
# C1 (2026-08-05) — the declared-interest offset vs AUTHOR diversity.
#
# `_effective_score` is `(earned * pen_a * pen_u + interest_bonus) * pen_t`, so
# the offset is deliberately immune to the AUTHOR penalty (see that function's
# docstring for the measured reason — the offset is a per-topic constant and
# discounting it on an author repeat makes the author penalty double as a topic
# penalty at a combined strength nobody set).
#
# The reciprocal was never priced: because the offset is added AFTER the author
# penalty, a prolific ON-interest author's repeat is compared against an
# OFF-interest rival with no offset at all, so a large enough offset lets the
# repeat win. `interest_match`'s own sweep table has NO author-diversity axis,
# and no panel gates it.
#
# MEASURED HERE (1 prolific on-interest author, 30 off-interest rivals, 20 slots):
#
#     interest_match | distinct authors@20 | slots to the prolific author
#              0.00  |                 20  |  1
#              0.40  |                 20  |  1   <- SHIPPED: no cost at all
#              0.50  |                 20  |  1
#              0.60  |                 19  |  2
#              0.80  |                 19  |  2
#
# So the shipped value is clear of it and this is NOT a live defect. What was
# missing is a guard on RAISING it, which is what these tests are.
# ---------------------------------------------------------------------------


def _interest_diversity_probe(interest_match: float) -> tuple[int, int]:
    """Distinct authors in the top 20, and the prolific author's share, for a
    pool of one prolific ON-interest author against 30 OFF-interest rivals of
    equal earned score. Returns (distinct_authors, prolific_slots)."""
    bonus = interest_match * 0.8  # W = organic weight (0.8) * interest_match
    pool = [
        _scored("hog", f"p{i}", 0.85, tags=("photo",)) for i in range(20)
    ]
    pool = [
        ScoredCandidate(
            post=c.post,
            source=c.source,
            score=ScoreBreakdown(
                vote_norm=0.0, rep_norm=0.0, organic=0.85,
                final=0.85 + bonus, interest_bonus=bonus,
            ),
        )
        for c in pool
    ]
    pool += [_scored(f"off{j}", "p0", 0.85, tags=(f"topic{j}",)) for j in range(30)]
    out = diversity_rerank(
        pool, author_decay=0.5, author_floor=0.1, topic_decay=0.9,
        topic_floor=0.5, topic_affinity_strength=0.0,
    )[:20]
    authors = [c.post.author for c in out]
    return len(set(authors)), authors.count("hog")


def test_the_shipped_interest_match_costs_no_author_diversity() -> None:
    """★ THE GUARD ON RAISING IT. At the shipped weight the author-diversity
    outcome must be IDENTICAL to the interest term being off. If a future sweep
    raises `interest_match` past the point where the offset starts overpowering
    the author penalty, this fails and forces the trade to be made explicitly —
    which is the whole thing that was missing (no sweep axis, no panel)."""
    shipped = ScoreWeights().interest_match
    control_distinct, control_hog = _interest_diversity_probe(0.0)
    distinct, hog = _interest_diversity_probe(shipped)
    assert (distinct, hog) == (control_distinct, control_hog), (
        f"at interest_match={shipped} the declared-interest offset costs author "
        f"diversity: {distinct} distinct authors / {hog} slots to one author, "
        f"versus {control_distinct}/{control_hog} with the term off. The offset "
        f"is exempt from the author penalty by design, so raising this weight "
        f"weakens author diversity — make that trade explicitly."
    )


def test_the_interaction_is_real_above_the_shipped_value() -> None:
    """The control for the guard above: without it, a change that made the
    offset penalty-scaled again (undoing the measured 2026-08-05 fix) would
    leave the guard passing for the wrong reason."""
    assert _interest_diversity_probe(0.8)[0] < _interest_diversity_probe(0.0)[0], (
        "a large declared-interest offset no longer displaces off-interest "
        "authors — if that is deliberate, this test and C1's note in "
        "_effective_score both need updating"
    )
