"""Rival suppression: a stranger must not be able to floor someone else's credibility.

THE ATTACK (council member C, measured). Victim is a new author with no audience.
Two sock accounts comment on their post. The victim replies to both — the single
most encouraged behaviour on a social platform. Those two reciprocal edges give
the victim two ring partners, the breadth arm of the self-dealing test fires, and
the victim's graph-cred is floored to the self-dealer band (0.0), suppressing them
from every gated discovery lane.

    1 sock  + replies            -> cred 0.5286   (fine)
    2 socks + replies            -> cred 0.0000   (suppressed)
    2 socks + replies + 1 genuine outside engager -> cred 0.5253 (protected)
    2 socks, victim never replies -> cred 0.5253  (no ring forms)

Cost: 2 accounts, 2 comments, and the victim completes the trap themselves. It
only bites authors with no audience yet — i.e. exactly the cold-start population
the product most needs to protect.

★ STATUS: OPEN. A fix was attempted on 2026-08-01 and REVERTED.

The attempt required the condemned account to sit in a CLOSED TRIANGLE (its ring
partners engaging each other), reasoning that a real ring is a triangle while the
attack is a star. It protected the victim and broke something worse:

  * triangle-free rings stopped being condemned AT ALL — measured, an even cycle
    of 6 went 6/6 -> 0/6 and a complete bipartite K5,5 went 10/10 -> 0/10, both
    trivial for an attacker to build. The q4 panel could not see it because its
    ring is clique-shaped.
  * it was itself bypassable: giving each sock a disjoint triangle that never
    touches the victim restored the suppression, amortizing to 0.3 accounts per
    victim — CHEAPER than the 2-per-victim attack it was written to close.

A ring evasion lets an attacker GAIN; suppression only lets them grief. Trading
the first for the second is a bad trade, so the original rule stands.

WHY A PREDICATE CANNOT FIX THIS: a victim and a small genuine ring are locally
isomorphic in the 1-hop neighbourhood the detector sees. Any fix needs
information the neighbourhood does not contain — who INITIATED (the victim only
ever replies), or the victim's own history. Do not re-attempt with another shape
test over `partners`.
"""

from __future__ import annotations

import pytest

from recsys.config import DEFAULT_SETTINGS
from recsys.core.graph_cred import compute_graph_cred
from tests.fakes import EPOCH


def _e(src: str, dst: str, **kw: int):
    from recsys.contracts import EngagementEdge

    return EngagementEdge(src=src, dst=dst, last_interaction=EPOCH, **kw)


WEIGHTS = DEFAULT_SETTINGS.real_graph
CONFIG = DEFAULT_SETTINGS.graph_cred


def _cred(edges, follows, ring):
    return compute_graph_cred(
        edges, follows, WEIGHTS, config=CONFIG, ring_members=frozenset(ring), now=EPOCH
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "KNOWN OPEN: two strangers can floor a newcomer's graph-cred. The "
        "shape-based fix was reverted (it released triangle-free rings and was "
        "bypassable at 0.3 accounts/victim). If this XPASSes, someone has fixed "
        "it properly — remove this marker and record how."
    ),
)
def test_two_strangers_cannot_floor_a_newcomers_credibility() -> None:
    """★ The attack. A STAR of two socks around a victim must not condemn them."""
    edges = [
        _e("sock1", "victim", replies=1),
        _e("victim", "sock1", replies=1),
        _e("sock2", "victim", replies=1),
        _e("victim", "sock2", replies=1),
    ]
    follows = {
        "sock1": frozenset({"victim"}),
        "sock2": frozenset({"victim"}),
        "victim": frozenset({"sock1", "sock2"}),
    }
    cred = _cred(edges, follows, {"sock1", "sock2", "victim"})
    assert cred["victim"].score > 0.0, (
        "two strangers plus the victim's own polite replies must not floor them"
    )


def test_a_genuine_closed_ring_of_the_same_size_is_still_condemned() -> None:
    """The evasion the breadth arm exists to close must stay closed.

    Same degree as the attack above (2), but every pair is mutual — a real
    triangle every member chose. Shape, not size, is what separates them.
    """
    edges = [
        _e("a", "b", replies=1),
        _e("b", "a", replies=1),
        _e("b", "c", replies=1),
        _e("c", "b", replies=1),
        _e("a", "c", replies=1),
        _e("c", "a", replies=1),
    ]
    follows = {
        "a": frozenset({"b", "c"}),
        "b": frozenset({"a", "c"}),
        "c": frozenset({"a", "b"}),
    }
    cred = _cred(edges, follows, {"a", "b", "c"})
    assert cred["a"].score == 0.0
    assert cred["b"].score == 0.0
    assert cred["c"].score == 0.0


@pytest.mark.xfail(
    strict=True,
    reason=(
        "KNOWN OPEN: two strangers can floor a newcomer's graph-cred. The "
        "shape-based fix was reverted (it released triangle-free rings and was "
        "bypassable at 0.3 accounts/victim). If this XPASSes, someone has fixed "
        "it properly — remove this marker and record how."
    ),
)
def test_scaling_the_star_does_not_help_the_attacker() -> None:
    """More socks, still a star, still no condemnation of the victim."""
    for n in (2, 3, 5):
        edges = []
        follows: dict[str, frozenset[str]] = {}
        socks = [f"sock{i}" for i in range(n)]
        for sk in socks:
            edges += [_e(sk, "victim", replies=1), _e("victim", sk, replies=1)]
            follows[sk] = frozenset({"victim"})
        follows["victim"] = frozenset(socks)
        cred = _cred(edges, follows, {*socks, "victim"})
        assert cred["victim"].score > 0.0, f"n={n} socks floored the victim"


def test_sustained_mutual_volume_is_still_self_dealing() -> None:
    """The victim is not made immune — genuine repeated self-dealing still counts.

    The repeated-pattern arm is untouched: a pair trading sustained bidirectional
    volume is condemned regardless of shape.
    """
    reps = CONFIG.min_ring_self_dealing_events
    edges = [
        _e("x", "y", upvotes=reps, replies=reps),
        _e("y", "x", upvotes=reps, replies=reps),
    ]
    follows = {"x": frozenset({"y"}), "y": frozenset({"x"})}
    cred = _cred(edges, follows, {"x", "y"})
    assert cred["x"].score == 0.0
    assert cred["y"].score == 0.0
