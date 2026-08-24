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

import os
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
from tests.fakes import EPOCH, make_post, make_viewer

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


def test_reply_backs_must_never_enter_the_affinity_weight_sum() -> None:
    """★★★ THE TRIPWIRE for the one attack this channel's weighting could still
    take, and which NOTHING in this suite covered before 2026-08-24.

    Every other invariant test here blocks edges whose ``src`` is not the viewer.
    ``reply_backs`` is different and that is why it slipped through: it rides on
    the VIEWER'S OWN OUTGOING edge, so it passes the src filter untouched. The
    ONLY thing keeping it out is that ``_decayed`` does not add it to the weight
    sum. Nothing asserted that. Re-adding ``edge.reply_backs * weights.reply_back``
    broke no test.

    WHY IT MATTERS. ``io/hafsql.py`` populates ``reply_backs`` as
    ``replies.get((dst, src))`` — the OTHER PARTY'S replies TO the viewer. It is
    attacker-controlled, and ``reply_back = 15.0`` is the heaviest weight in the
    system. One forward courtesy from the viewer (upvoting a comment left on
    their own post) creates the edge; the attacker supplies the rest.

    THE NUMBERS ARE THE ONES MEASURED WHEN IT WAS REMOVED (viewer_affinity.py):
    across 2,116,047 real edges the median top outgoing edge is 52.0, so
    ``ceil(52 / 15) = 4`` attacker replies takes the top affinity slot. Below,
    ``alice`` is that median-strength genuine correspondent (10 replies + 2
    upvotes = 5*10 + 1*2 = 52) and ``attacker`` has a single courtesy upvote
    (weight 1) plus 4 inbound replies (4 * 15 = 60 if they were ever counted).

    So: correct behaviour ranks alice far above attacker. If reply_backs enters
    the sum, attacker scores 61 > 52 and TAKES THE TOP SLOT — and because
    ``affinity_percentiles`` ranks over distinct values, the top edge gets
    exactly 1.0000 regardless of margin.
    """
    edges = [
        EngagementEdge(
            src="me", dst="alice", replies=10, upvotes=2,
            last_interaction=EPOCH,
        ),
        EngagementEdge(
            src="me", dst="attacker", upvotes=1, reply_backs=4,
            last_interaction=EPOCH,
        ),
    ]
    aff = viewer_author_affinity("me", edges, W, EPOCH)

    # The genuine correspondent must outrank the attacker outright.
    assert aff["alice"] > aff["attacker"], (
        "reply_backs has entered the affinity weight sum: an attacker's replies "
        "TO the viewer now outrank a real correspondent the viewer chose"
    )
    # And the attacker must be worth EXACTLY their one courtesy upvote — pinning
    # the value, not just the order, so a partial weight cannot slip through.
    assert aff["attacker"] == W.upvote, (
        f"attacker scored {aff['attacker']}, expected exactly W.upvote="
        f"{W.upvote}; anything larger means an inbound term is being counted"
    )
    # The top slot must belong to alice once ranked.
    pct = affinity_percentiles(aff, ["alice", "attacker"])
    assert pct["alice"] == 1.0 and pct["attacker"] < 1.0


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


# ── ★ pipeline-level: banned and muted authors must not occupy the scale ─────


def _lookup_pcts(edges, *, mutes=frozenset(), authors=("alice", "bob", "carol")):
    """Run the real `_viewer_affinity_lookup` and read back each author's
    percentile via the candidate it would score."""
    from recsys.contracts import Candidate, CandidateSource
    from recsys.pipeline import TrustSnapshot, _viewer_affinity_lookup

    cands = [
        Candidate(post=make_post(a, f"p-{a}"), source=CandidateSource.OON_INTEREST)
        for a in authors
    ]
    fn = _viewer_affinity_lookup(
        make_viewer("me", mutes=mutes),
        TrustSnapshot(edges=tuple(edges)),
        DEFAULT_SETTINGS,
        EPOCH,
        cands,
    )
    if fn is None:
        return None
    return {c.post.author: fn(c) for c in cands}


def test_a_banned_author_does_not_consume_the_top_of_the_affinity_scale() -> None:
    """★ MEASURED ON REAL OWNER DATA (2026-08-24).

    `affinity_percentiles` ranks over DISTINCT VALUES, so the viewer's heaviest
    edge takes exactly 1.0000 and everyone else drops a rank. The owner's
    heaviest edge was `ecency` (weight 85) and `ecency` is in the live
    RECSYS_BANNED_AUTHORS: his real top correspondent `igormuba` scored 0.8000
    instead of 1.0000, blanchy 0.60 instead of 0.75, asgarth 0.40 instead of
    0.50. A name that can never be served to him was demoting every real
    relationship he has.

    The trust batch DOES strip banned edges, but it runs every 3 days, so the
    graph carries them in between. This asserts the request-time subtraction.
    """
    import recsys.core.banned as banned_mod

    banned_mod.banned_authors.cache_clear()
    with_ban = os.environ.get("RECSYS_BANNED_AUTHORS")
    os.environ["RECSYS_BANNED_AUTHORS"] = "alice"
    try:
        banned_mod.banned_authors.cache_clear()
        pcts = _lookup_pcts(
            [
                _edge("me", "alice", replies=17),   # heaviest — and banned
                _edge("me", "bob", replies=11),
                _edge("me", "carol", replies=9),
            ]
        )
        assert pcts is not None
        # bob is the viewer's real top correspondent and must hold the top slot.
        assert pcts["bob"] == 1.0, (
            f"bob scored {pcts['bob']}, expected 1.0 — a BANNED author is still "
            "occupying the top of the viewer's affinity distribution and "
            "demoting every genuine correspondent by one rank"
        )
        assert pcts["carol"] < pcts["bob"]
    finally:
        if with_ban is None:
            os.environ.pop("RECSYS_BANNED_AUTHORS", None)
        else:
            os.environ["RECSYS_BANNED_AUTHORS"] = with_ban
        banned_mod.banned_authors.cache_clear()


def test_a_muted_author_does_not_consume_the_top_of_the_affinity_scale() -> None:
    """The PERMANENT half. The trust batch is global and cannot know any
    viewer's mute list, so without a request-time subtraction a muted author's
    weight sits in that viewer's distribution forever. `filter_eligible` already
    stops the post being SERVED, which is exactly what makes the distortion
    invisible: the post never appears, but it still moved everyone else's rank.
    """
    pcts = _lookup_pcts(
        [
            _edge("me", "alice", replies=17),   # heaviest — and muted
            _edge("me", "bob", replies=11),
            _edge("me", "carol", replies=9),
        ],
        mutes=frozenset({"alice"}),
    )
    assert pcts is not None
    assert pcts["bob"] == 1.0, (
        f"bob scored {pcts['bob']}, expected 1.0 — a MUTED author is still "
        "occupying the top of the viewer's affinity distribution"
    )


def test_a_viewer_whose_only_affinity_is_banned_falls_through_quietly() -> None:
    """Fail QUIET, not empty-handed: if subtraction empties the map there is no
    usable signal, and the lookup must return None so the viewer-blind path
    scores the pool — never rank a pool against an empty distribution.

    ★ THIS TEST WAS VACUOUS ON ITS FIRST WRITING AND THE MUTATION CAUGHT IT.
    The first version used a SINGLE banned author. `affinity_percentiles`
    needs at least two distinct values to form a distribution and returns `{}`
    for one, so `_viewer_affinity_lookup` returned None via its
    `not author_pct and not topic_pct` guard whether or not the subtraction
    existed — it passed with the subtraction REMOVED. It now uses THREE banned
    authors with distinct weights, which without the subtraction is a perfectly
    rankable distribution, so None can only come from the subtraction emptying
    the map.
    """
    import recsys.core.banned as banned_mod

    prev = os.environ.get("RECSYS_BANNED_AUTHORS")
    os.environ["RECSYS_BANNED_AUTHORS"] = "alice,bob,carol"
    try:
        banned_mod.banned_authors.cache_clear()
        all_banned = [
            _edge("me", "alice", replies=17),
            _edge("me", "bob", replies=11),
            _edge("me", "carol", replies=9),
        ]
        assert _lookup_pcts(all_banned) is None, (
            "every author the viewer engaged is banned, so the affinity map is "
            "empty after subtraction and the lookup must fall through to the "
            "viewer-blind path"
        )
    finally:
        if prev is None:
            os.environ.pop("RECSYS_BANNED_AUTHORS", None)
        else:
            os.environ["RECSYS_BANNED_AUTHORS"] = prev
        banned_mod.banned_authors.cache_clear()
