"""Seed-anchored vouch propagation — the directed-cycle fix (2026-08-01).

THE ATTACK. The vouched tier used to be a LOCAL test: "did this account receive
engagement from outside its own detected ring". `detect_rings` builds components
from RECIPROCAL pairs only (`core/ring.py`: an edge needs both directions
non-zero), so a DIRECTED cycle S0->S1->S2->S0 contains no reciprocal pair, forms
no component, and every sock counts as every other sock's "outside" engager.
Three accounts and three one-way upvotes vouched the entire cycle, converting the
~1.0 unknown-tier breadth cap into unbounded linear-in-K breadth.

THE FIX. Vouch is anchored: it starts at `trusted_seeds` and propagates only to
accounts engaged by someone already vouched, for at most `vouch_max_rounds` hops.
A closed cycle touches no seed, so it never enters the set.

WHY BOUNDED ROUNDS ARE LOAD-BEARING. If an attacker buys ONE genuine endorsement
from a vouched account into the cycle, vouch propagates along it. Bounded rounds
cap how many socks that single purchase buys; unbounded propagation (transitive
closure) reopens the hole completely. That is asserted here so nobody "optimises"
the bound away later.
"""

from __future__ import annotations

from dataclasses import replace

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import GraphCred
from recsys.pipeline import _voter_trust_from_creds


def _cred(account: str, engagers: set[str], score: float = 0.5) -> GraphCred:
    """A graph-cred row that passes the score floor and names its outside engagers."""
    return GraphCred(
        account=account,
        score=score,
        follow_follower_ratio=1.0,
        outside_engaged=bool(engagers),
        outside_engagers=frozenset(engagers),
    )


def _directed_cycle(k: int) -> dict[str, GraphCred]:
    """K socks in a one-directional ring: s0 -> s1 -> ... -> s(k-1) -> s0.

    No pair is reciprocal, so ring detection sees nothing and every sock has a
    non-empty `outside_engagers`.
    """
    names = [f"sock{i}" for i in range(k)]
    return {
        names[i]: _cred(names[i], {names[(i - 1) % k]})  # engaged by its predecessor
        for i in range(k)
    }


def test_directed_cycle_cannot_vouch_itself() -> None:
    """The attack: 3 accounts, 3 one-way upvotes. Must vouch nobody."""
    creds = _directed_cycle(3)
    # A seed exists in the graph but is entirely disconnected from the cycle.
    creds["seed"] = _cred("seed", set())
    trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, frozenset({"seed"}))
    assert trust is not None
    assert trust.vouched == frozenset({"seed"}), (
        "a closed directed cycle reached no seed and must not be vouched"
    )


def test_directed_cycle_stays_closed_as_it_grows() -> None:
    """Scaling the attack must not help — K socks buy exactly nothing."""
    for k in (3, 5, 10, 25):
        creds = _directed_cycle(k)
        creds["seed"] = _cred("seed", set())
        trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, frozenset({"seed"}))
        assert trust is not None
        socks = {a for a in trust.vouched if a.startswith("sock")}
        assert socks == set(), f"K={k}: {len(socks)} socks vouched"


def test_honest_account_engaged_by_a_seed_is_vouched() -> None:
    """The property that must survive: real accounts still earn vouch."""
    creds = {
        "seed": _cred("seed", set()),
        "honest": _cred("honest", {"seed"}),
    }
    trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, frozenset({"seed"}))
    assert trust is not None
    assert "honest" in trust.vouched


def test_vouch_propagates_multiple_hops_up_to_the_bound() -> None:
    """A chain seed -> a -> b -> c is reachable within the default 3 rounds."""
    creds = {
        "seed": _cred("seed", set()),
        "a": _cred("a", {"seed"}),
        "b": _cred("b", {"a"}),
        "c": _cred("c", {"b"}),
    }
    trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, frozenset({"seed"}))
    assert trust is not None
    assert {"a", "b", "c"} <= trust.vouched


def test_round_bound_limits_what_one_bought_endorsement_buys() -> None:
    """★ The residual attack: one purchase must not vouch an unbounded set.

    An attacker buys ONE genuine endorsement from a vouched account into sock0.
    Vouch then walks the cycle. At the default bound only the first few socks are
    reached; with the bound raised high enough the WHOLE cycle vouches, which is
    exactly the hole this fix closes. Asserting the monotonic relationship keeps
    anyone from "simplifying" this into a transitive closure.

    ★ CORRECTION (2026-08-01): this docstring used to claim the bound "is not a
    tuning knob". It is exactly a tuning knob, and this fixture understates what
    it tunes. A directed cycle is a CHAIN, so reach here grows by one sock per
    hop — linear, which makes a generous bound look cheap. Replace the cycle with
    a sock TREE, which costs an attacker nothing extra, and reach is EXPONENTIAL:
    at fan-out 10 one purchased endorsement vouches 111 socks at 3 hops and
    111,111 at 6. See test_vouch_bound_tradeoff.py for both curves and for the
    honest cost this bound imposes on sparse accounts.
    """
    k = 10
    creds = _directed_cycle(k)
    creds["seed"] = _cred("seed", set())
    # The purchased endorsement: a seed engages sock0.
    creds["sock0"] = _cred("sock0", {"seed"})

    def vouched_socks(rounds: int) -> int:
        settings = replace(
            DEFAULT_SETTINGS,
            graph_cred=replace(DEFAULT_SETTINGS.graph_cred, vouch_max_rounds=rounds),
        )
        trust = _voter_trust_from_creds(creds, settings, frozenset({"seed"}))
        assert trust is not None
        return len({a for a in trust.vouched if a.startswith("sock")})

    bounded = vouched_socks(3)
    generous = vouched_socks(k + 5)  # effectively a closure
    assert bounded < k, "the bound must stop one purchase from vouching the whole cycle"
    assert generous == k, (
        "unbounded propagation is expected to vouch the entire cycle — this is why "
        "vouch_max_rounds must stay bounded"
    )
    assert bounded < generous


def test_no_seed_falls_back_to_the_local_rule_rather_than_vouching_nobody() -> None:
    """Fail SAFE, not shut.

    An empty vouched set is not neutral: every honest account loses its credited
    breadth simultaneously, which hands ranking to the vote farms the budget
    exists to demote. Production refuses an empty seed set (F-R2); this is the
    dev/test path and it must keep the pre-anchoring behaviour.
    """
    creds = {
        "honest": _cred("honest", {"peer"}),
        "peer": _cred("peer", set()),
    }
    trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, frozenset())
    assert trust is not None
    assert "honest" in trust.vouched
