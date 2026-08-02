"""Graph-cred behaviour on the edge shape `io/hafsql.py` ACTUALLY EMITS.

WHY THIS FILE EXISTS
====================
Every other graph-cred test builds `EngagementEdge` through a local helper that
leaves `reply_backs` at its default of 0. **Production never emits that shape.**
`io/hafsql.py:612` populates `reply_backs` from `replies[(dst, src)]` — the
REVERSE edge's own reply count — so in production a mutual reply exchange yields
`replies=1, reply_backs=1` on BOTH edges.

`_raw_event_count` summed both fields, so one mutual reply scored 2 events per
direction and cleared `min_ring_self_dealing_events = 2` — the exact threshold
`GraphCredConfig.__post_init__` refuses to let anyone set to 1, on the grounds
that "1 would make the newcomer protection a no-op". With the production
gateway, 2 WAS 1, and the entire relocated-newcomer carve-out was dead for
anyone who had a conversation.

Measured before the fix, two brand-new accounts:

    one mutual UPVOTE each way -> 1 event  -> cred 1.0000   (protected)
    one mutual REPLY  each way -> 2 events -> cred 0.0000   (condemned)
    the suite's own fixture shape          -> cred 1.0000   (a lie)

The tests were green throughout. A fixture that cannot express the production
shape cannot test the production behaviour, and the more carefully the rest of
the suite was written the more confidently it certified the wrong thing.

So: these tests construct edges through `_hafsql_edges`, which reproduces the
gateway's field assignment exactly. Anything asserting on ring/self-dealing
thresholds belongs here rather than in a file using the convenience helper.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime

from recsys.config import DEFAULT_SETTINGS as S
from recsys.contracts import EngagementEdge
from recsys.core.graph_cred import _raw_event_count, compute_graph_cred
from recsys.core.ring import detect_rings

NOW = datetime(2024, 1, 2, tzinfo=UTC)
THEN = datetime(2024, 1, 1, tzinfo=UTC)


def _hafsql_edges(
    pairs: list[tuple[str, str]], *, upvotes: int = 1, replies: int = 0
) -> list[EngagementEdge]:
    """Emit both directions of each pair exactly as `io/hafsql.py:605-621` does.

    The load-bearing line is ``reply_backs=reply_count[(dst, src)]`` — the
    reverse pair's replies, not a separate signal.
    """
    reply_count: dict[tuple[str, str], int] = {}
    for a, b in pairs:
        reply_count[(a, b)] = replies
        reply_count[(b, a)] = replies

    edges: list[EngagementEdge] = []
    for a, b in pairs:
        for src, dst in ((a, b), (b, a)):
            edges.append(
                EngagementEdge(
                    src=src,
                    dst=dst,
                    replies=reply_count.get((src, dst), 0),
                    reply_backs=reply_count.get((dst, src), 0),
                    upvotes=upvotes,
                    last_interaction=THEN,
                )
            )
    return edges


def _condemned(edges: list[EngagementEdge]) -> tuple[int, int]:
    rings = frozenset(
        detect_rings(
            edges,
            S.real_graph,
            now=NOW,
            reciprocity_min=S.ring.reciprocity_min,
            min_group=S.ring.min_group,
        )
    )
    creds = compute_graph_cred(
        edges, {}, S.real_graph, config=S.graph_cred, ring_members=rings, now=NOW
    )
    return sum(1 for c in creds.values() if c.score == 0.0), len(creds)


def _clique(k: int) -> list[tuple[str, str]]:
    return list(itertools.combinations([f"s{i}" for i in range(k)], 2))


# ── ★ the bug this file was written for ──────────────────────────────────────

def test_one_mutual_reply_is_ONE_event_not_two() -> None:
    """★ `reply_backs` must not be counted as an event on this edge.

    It is the reverse edge's `replies`, and that edge counts them itself. Summing
    it here double-counts every mutual exchange.
    """
    edge = _hafsql_edges([("a", "b")], upvotes=0, replies=1)[0]
    assert edge.replies == 1 and edge.reply_backs == 1, "not the production shape"
    assert _raw_event_count(edge) == 1


def test_two_newcomers_having_one_conversation_are_not_self_dealers() -> None:
    """★ The relocated-newcomer carve-out, on the shape production emits.

    Two brand-new accounts reply to each other once. That is a conversation, not
    a ring, and condemning it is the "blackout" the carve-out exists to prevent.
    """
    condemned, total = _condemned(_hafsql_edges([("n1", "n2")], upvotes=0, replies=1))
    assert condemned == 0, f"{condemned}/{total} newcomers condemned for one conversation"


def test_one_mutual_upvote_and_one_mutual_reply_are_treated_alike() -> None:
    """Neither is evidence of self-dealing; they must not diverge by field name."""
    up = _condemned(_hafsql_edges([("n1", "n2")], upvotes=1, replies=0))
    reply = _condemned(_hafsql_edges([("n1", "n2")], upvotes=0, replies=1))
    assert up == reply == (0, 2)


# ── the protection that must NOT have been weakened ──────────────────────────

def test_collusion_topologies_are_still_fully_condemned() -> None:
    """★ The regression check on the fix above.

    Dropping a term from the event count must not buy any real ring a reprieve.
    These four shapes are the battery a previous ring fix failed: it passed its
    own tests and released the triangle-free ones (even cycle 6/6 -> 0/6,
    K5,5 10/10 -> 0/10).
    """
    for name, pairs in (
        ("3-clique", _clique(3)),
        ("even cycle n=6", [(f"c{i}", f"c{(i + 1) % 6}") for i in range(6)]),
        ("bipartite K5,5", [(f"L{i}", f"R{j}") for i in range(5) for j in range(5)]),
        ("20-clique", _clique(20)),
    ):
        condemned, total = _condemned(_hafsql_edges(pairs))
        assert condemned == total, f"{name}: only {condemned}/{total} condemned"


def test_sustained_mutual_volume_is_still_condemned() -> None:
    """The repeated-pattern arm: a single pair, but at self-dealing volume."""
    condemned, total = _condemned(_hafsql_edges([("a", "b")], upvotes=20, replies=5))
    assert condemned == total == 2
