"""What `vouch_max_rounds` actually costs, on both sides of the trade.

WHY THIS FILE EXISTS
====================
`test_round_bound_limits_what_one_bought_endorsement_buys` establishes that a
bounded walk beats a transitive closure, and its docstring calls the bound "not
a tuning knob". Both halves of that are misleading, and the reason is the
topology it measures on: a directed CYCLE, which is a chain, so the attacker's
reach grows by exactly one sock per hop. That linearity is a property of the
fixture, not of the bound.

Measured 2026-08-01 (`scratchpad/verify/f5c.py`), replacing the cycle with a sock
TREE — one bought endorsement, then socks engaging socks, which costs an attacker
nothing extra:

    sock fan-out |    1 hop   2      3      4       5        6
               1 |        1   2      3      4       5        6     <- the old fixture
               2 |        1   3      7     15      31       63
               5 |        1   6     31    156     781     3906
              10 |        1  11    111   1111   11111   111111

So hostile reach is EXPONENTIAL in the bound, exactly like honest reach. The
bound does not distinguish honest propagation from hostile propagation at all —
it is a single knob that scales both, and it is the only thing standing between
one purchased endorsement and unbounded sock vouching.

THE HONEST COST, which was undocumented
=======================================
The same sweep over honest fan-out (`f5b.py`, 3000-account network, % vouched):

    fan-out |    1 hop     2       3       4       5       6
          2 |     0.1%   0.2%    0.5%    1.0%    2.1%    4.2%
          5 |     0.2%   1.0%    5.2%   26.0%  100.0%  100.0%
         30 |     1.0%  31.0%  100.0%  100.0%  100.0%  100.0%
        100 |     3.3% 100.0%  100.0%  100.0%  100.0%  100.0%

At the shipped bound of 3, a well-connected account's neighbourhood is fully
reached while a SPARSE account — few distinct outside engagers, i.e. a new or
peripheral one — reaches 0.5-5% of the network. The bound is therefore free for
established accounts and near-total exclusion for exactly the population the
discoverability work exists to serve.

THE CONCLUSION, and why the value does NOT change here
======================================================
Raising the bound to serve sparse accounts would hand an attacker the identical
multiplier, so it is not the fix. Vouch reach is the wrong instrument for that
problem: the lane that actually serves a sparse account is the one that asks
whether the AUTHOR is credible rather than whether the viewer's network has
already seen the post (`CandidateSource.requires_author_floor`, see
test_follow_cliff). This file exists so that trade-off is visible in the suite
instead of being rediscovered by someone raising the knob because the newcomer
numbers look bad.
"""

from __future__ import annotations

from dataclasses import replace

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import GraphCred
from recsys.pipeline import _voter_trust_from_creds


def _cred(account: str, engagers: set[str]) -> GraphCred:
    return GraphCred(
        account=account,
        score=0.6,
        follow_follower_ratio=1.0,
        outside_engaged=bool(engagers),
        outside_engagers=frozenset(engagers),
    )


def _tree(
    prefix: str,
    branch: int,
    depth: int,
    root_engagers: set[str],
    *,
    population: int | None = None,
) -> dict[str, GraphCred]:
    """A fan-out tree rooted at ``prefix``0, engaged by ``root_engagers``.

    ``population`` caps the total account count, which is what makes fan-out the
    interesting variable: for a FIXED number of accounts, higher fan-out means a
    shallower network. The bound reaches everything within ``bound`` hops of a
    seed, so what actually decides coverage is the network's DEPTH relative to
    the bound — fan-out matters only because it sets that depth. Building to a
    fixed depth instead would make every fan-out look equally uncovered, which is
    true but says nothing about real graphs, where population is what is fixed.
    """
    creds = {f"{prefix}0": _cred(f"{prefix}0", root_engagers)}
    layer, n = [f"{prefix}0"], 1
    for _ in range(depth):
        nxt = []
        for parent in layer:
            for _ in range(branch):
                if population is not None and n >= population:
                    break
                account = f"{prefix}{n}"
                n += 1
                creds[account] = _cred(account, {parent})
                nxt.append(account)
        layer = nxt
        if population is not None and n >= population:
            break
    return creds


def _vouched(creds: dict[str, GraphCred], rounds: int, prefix: str) -> int:
    settings = replace(
        DEFAULT_SETTINGS,
        graph_cred=replace(DEFAULT_SETTINGS.graph_cred, vouch_max_rounds=rounds),
    )
    trust = _voter_trust_from_creds(creds, settings, frozenset({"seed"}))
    assert trust is not None
    return len({a for a in trust.vouched if a.startswith(prefix)})


def test_hostile_reach_is_exponential_not_linear_in_the_bound() -> None:
    """★ The correction: the cycle fixture made the attacker look linear.

    A sock tree costs an attacker no more than a sock cycle and grows like any
    other tree. If this ever reads as linear again, the fixture has collapsed
    back to a chain and the bound's cost is being understated.
    """
    creds = {"seed": _cred("seed", set()), **_tree("sock", 3, 6, {"seed"})}
    reach = [_vouched(creds, r, "sock") for r in (1, 2, 3, 4)]

    assert reach == sorted(reach)
    linear = [reach[0] * r for r in (1, 2, 3, 4)]
    assert reach[-1] > linear[-1] * 2, (
        f"hostile reach {reach} is not growing faster than linear {linear} — the "
        "fixture is a chain again and understates what raising the bound costs"
    )


def test_raising_the_bound_helps_the_attacker_as_much_as_the_honest_graph() -> None:
    """★ Why the knob cannot simply be raised to serve sparse accounts.

    Both populations are trees with the same fan-out, so both multiply by the
    same factor per hop. Anything that buys a newcomer reach buys a sock farm the
    same reach.
    """
    honest = {"seed": _cred("seed", set()), **_tree("h", 3, 6, {"seed"})}
    hostile = {"seed": _cred("seed", set()), **_tree("sock", 3, 6, {"seed"})}

    h3, h5 = _vouched(honest, 3, "h"), _vouched(honest, 5, "h")
    s3, s5 = _vouched(hostile, 3, "sock"), _vouched(hostile, 5, "sock")

    assert h5 > h3 and s5 > s3
    honest_gain, hostile_gain = h5 / max(h3, 1), s5 / max(s3, 1)
    assert abs(honest_gain - hostile_gain) < 0.5, (
        f"honest gain {honest_gain:.1f}x vs hostile {hostile_gain:.1f}x — if these "
        "ever diverge the bound has become a real discriminator and this analysis "
        "needs redoing"
    )


def test_a_sparse_account_is_barely_reached_at_the_shipped_bound() -> None:
    """★ The undocumented honest cost, pinned so it stays visible.

    Low fan-out is the signature of a NEW account: few distinct people have
    engaged it. At the shipped bound such an account's neighbourhood is almost
    entirely unvouched, while a well-connected one is fully reached. This is not
    a bug to fix by raising the bound (see above) — it is the reason the interest
    lane must not depend on vouch reach.
    """
    # Same population, different fan-out — so the only thing that differs is how
    # DEEP the network is, which is exactly what the bound cuts against.
    sparse = {"seed": _cred("seed", set()), **_tree("h", 2, 40, {"seed"}, population=3000)}
    # Fan-out is held at the vouch fan-out cap: past it a voucher stops
    # transmitting, so a denser tree measures the CAP rather than the depth bound
    # this test is about. (Below the cap, the cap costs an honest graph nothing —
    # measured 1.3%/37.0%/100.0% identical at every cap for fan-out 3/10/50.)
    dense = {
        "seed": _cred("seed", set()),
        **_tree("h", DEFAULT_SETTINGS.graph_cred.vouch_max_fanout, 40, {"seed"}, population=3000),
    }
    bound = DEFAULT_SETTINGS.graph_cred.vouch_max_rounds

    sparse_share = _vouched(sparse, bound, "h") / (len(sparse) - 1)
    dense_share = _vouched(dense, bound, "h") / (len(dense) - 1)

    # 0.8, not 0.9: at fan-out == the cap the first three layers are
    # 1 + 50 + 2500 = 2551 of 3000 (85%), the rest sitting one hop past the depth
    # bound. The contrast with the sparse case below is the point, not the exact
    # ceiling — a well-connected neighbourhood is reached almost entirely, a
    # sparse one barely at all.
    assert dense_share > 0.8, "a well-connected neighbourhood should be mostly reached"
    assert sparse_share < 0.1, (
        f"sparse reach {sparse_share:.1%} — if this improved, re-measure the "
        "hostile side before claiming the newcomer gap is closed"
    )


# ── ★ the bound that actually binds: per-voucher FAN-OUT ─────────────────────

def _star(width: int) -> dict[str, GraphCred]:
    """One endorsement into a hub, then `width` socks engaged by that hub."""
    creds = {"seed": _cred("seed", set()), "hub": _cred("hub", {"seed"})}
    for i in range(width):
        creds[f"k{i}"] = _cred(f"k{i}", {"hub"})
    return creds


def test_one_endorsement_cannot_vouch_an_unbounded_sock_list() -> None:
    """★ THE CRITICAL HOLE the depth bound did not close.

    `vouch_max_rounds` caps propagation DEPTH, and the attacker chooses the
    depth. Breadth per round was unlimited, so one endorsement plus one hub
    vouched the hub's ENTIRE engagement list at depth 1 — measured 50,000 socks
    from 50,000, with the documented directed-cycle attack fully closed the whole
    time. The old fixture was a chain, which is why depth looked like the binding
    constraint; it never was.
    """
    for width in (500, 5_000, 50_000):
        vouched = _vouched(_star(width), DEFAULT_SETTINGS.graph_cred.vouch_max_rounds, "k")
        assert vouched < width, f"{vouched}/{width} socks vouched from one endorsement"
        assert vouched <= DEFAULT_SETTINGS.graph_cred.vouch_max_fanout * 3, (
            f"{vouched} socks vouched — the per-voucher fan-out cap is not binding"
        )


def test_the_cap_does_not_shrink_an_honest_graph_within_its_reach() -> None:
    """The cap must cost nothing until it falls below a graph's own out-degree.

    This is what makes it shippable: honest coverage at fan-out 3, 10 and 50 was
    measured bit-identical with the cap at none/100/50/25/10.
    """
    cap = DEFAULT_SETTINGS.graph_cred.vouch_max_fanout
    honest = {"seed": _cred("seed", set()), **_tree("h", 3, 8, {"seed"}, population=3000)}
    with_cap = _vouched(honest, 3, "h")

    uncapped_settings = replace(
        DEFAULT_SETTINGS,
        graph_cred=replace(DEFAULT_SETTINGS.graph_cred, vouch_max_fanout=0, vouch_max_rounds=3),
    )
    trust = _voter_trust_from_creds(honest, uncapped_settings, frozenset({"seed"}))
    assert trust is not None
    without_cap = len({a for a in trust.vouched if a.startswith("h")})

    assert with_cap == without_cap, (
        f"the cap cost an honest fan-out-3 graph {without_cap - with_cap} accounts "
        f"despite a cap of {cap}"
    )


def test_the_residual_bound_is_stated_honestly_not_assumed_closed() -> None:
    """★ HONEST LIMIT, pinned so nobody reads the cap as a full close.

    An attacker who structures at exactly the cap still reaches roughly
    cap^(rounds-1): the two bounds MULTIPLY. Measured, one endorsement:
        flat star, any width      -> ~100 socks   (cap binds hard)
        star-of-stars at the cap  -> ~2,550 socks (cap^(rounds-1))
    That is bounded where it was unbounded, and it is not zero. Closing the
    remainder means lowering `vouch_max_rounds`, which costs honest coverage
    exponentially (fan-out 10: 37.0% at 3 rounds, 3.7% at 2) — a real trade
    needing live out-degree data, not a free tightening.
    """
    cap = DEFAULT_SETTINGS.graph_cred.vouch_max_fanout
    rounds = DEFAULT_SETTINGS.graph_cred.vouch_max_rounds

    creds = {"seed": _cred("seed", set()), "hub": _cred("hub", {"seed"})}
    n, layer = 0, ["hub"]
    for _ in range(2):
        nxt = []
        for parent in layer:
            for _ in range(cap):
                creds[f"k{n}"] = _cred(f"k{n}", {parent})
                nxt.append(f"k{n}")
                n += 1
        layer = nxt

    vouched = _vouched(creds, rounds, "k")
    assert vouched <= cap**(rounds - 1) + cap, (
        f"{vouched} socks exceeds the stated residual bound cap^(rounds-1)"
    )
    assert vouched > cap, (
        "the residual is smaller than documented — re-measure and tighten the "
        "docstring rather than leaving an over-pessimistic bound in the suite"
    )
