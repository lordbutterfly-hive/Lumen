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

★★★ k, AND WHICH TESTS BELOW PIN WHICH CONTRACT (2026-08-27)
============================================================
`GraphCredConfig.vouch_min_vouchers` (k) now decides how many DISTINCT already-
vouched engagers an account needs before vouch propagates to it. It shipped at 2
as the compensating control for disabling ring detection: with `ring_members`
empty every member of a reciprocal sock clique is every other member's "outside"
engager, so at k = 1 ONE purchased engagement carried a whole clique (measured
live: 60 of 60 socks, ceiling 101 per touch, for 45 of 49 landed seeds).

The single-voucher fixtures below measure the ROUND bound, which is a different
knob, so they pass k = 1 EXPLICITLY rather than inheriting the default and
quietly measuring an empty set. Each is paired with the shipped-k assertion, so
the cost of k = 2 is stated in the same test that states the k = 1 property
instead of living only in a config comment.
"""

from __future__ import annotations

from dataclasses import replace

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import GraphCred
from recsys.pipeline import _voter_trust_from_creds


def _with_k(k: int):
    """`DEFAULT_SETTINGS` with `vouch_min_vouchers` pinned, nothing else changed."""
    return replace(
        DEFAULT_SETTINGS,
        graph_cred=replace(DEFAULT_SETTINGS.graph_cred, vouch_min_vouchers=k),
    )


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
    """The property that must survive: real accounts still earn vouch — and the
    exact price `vouch_min_vouchers` charges for it.

    ★ 2026-08-27. This used to assert only the first line: one seed engagement
    vouches an honest account. That is the k = 1 contract, and it is precisely
    what k = 2 changes, so asserting it against `DEFAULT_SETTINGS` after k
    shipped would have been asserting the OLD contract against the NEW default.
    Both are pinned instead, because the second one IS the cost: at the shipped
    k an account needs engagement from TWO distinct vouched accounts, and 54.2%
    of the accounts that lose vouched status on the live graph have exactly one
    outside engager in the whole window (see `GraphCredConfig.vouch_min_vouchers`).

    Losing vouched status is not a ban — the account sits in the BUDGETED unknown
    tier (`unknown_free` + `unknown_per_vouched` per vouched voter), the same
    tier a genuine newcomer starts in.
    """
    one_voucher = {"seed": _cred("seed", set()), "honest": _cred("honest", {"seed"})}
    two_vouchers = {
        "seed": _cred("seed", set()),
        "seed2": _cred("seed2", set()),
        "honest": _cred("honest", {"seed", "seed2"}),
    }
    seeds1 = frozenset({"seed"})
    seeds2 = frozenset({"seed", "seed2"})

    # k = 1: one engagement is enough. The pre-2026-08-27 contract, still a
    # supported (and measured-vulnerable) configuration.
    trust = _voter_trust_from_creds(one_voucher, _with_k(1), seeds1)
    assert trust is not None and "honest" in trust.vouched

    # k = 2 (shipped): one is NOT enough — this is the documented cost side.
    trust = _voter_trust_from_creds(one_voucher, _with_k(2), seeds1)
    assert trust is not None and "honest" not in trust.vouched

    # ...and two distinct vouched engagers still earn it, at the shipped default.
    trust = _voter_trust_from_creds(two_vouchers, DEFAULT_SETTINGS, seeds2)
    assert trust is not None and "honest" in trust.vouched, (
        "real accounts must still be able to earn vouch at the shipped k"
    )


def test_vouch_propagates_multiple_hops_up_to_the_bound() -> None:
    """Vouch reaches 3 hops out — at k = 1 along a chain, and at the shipped k
    along a chain where each hop presents k distinct vouched engagers.

    ★ 2026-08-27: the single-voucher chain is kept (it is the round bound's own
    fixture) but pinned at k = 1, because at k = 2 it propagates to nobody and
    `{"a","b","c"} <= vouched` would have been asserted against an empty set for
    the wrong reason. The k-voucher chain proves multi-hop propagation is not
    something k removes — only single-voucher propagation is.
    """
    chain = {
        "seed": _cred("seed", set()),
        "a": _cred("a", {"seed"}),
        "b": _cred("b", {"a"}),
        "c": _cred("c", {"b"}),
    }
    trust = _voter_trust_from_creds(chain, _with_k(1), frozenset({"seed"}))
    assert trust is not None
    assert {"a", "b", "c"} <= trust.vouched

    # The same chain at the shipped k: one voucher per hop is no longer enough.
    trust = _voter_trust_from_creds(chain, DEFAULT_SETTINGS, frozenset({"seed"}))
    assert trust is not None
    assert not ({"a", "b", "c"} & trust.vouched)

    # A chain that DOES present k distinct vouched engagers at every hop still
    # walks the full depth at the shipped default.
    k = DEFAULT_SETTINGS.graph_cred.vouch_min_vouchers
    seeds = {f"seed{i}" for i in range(k)}
    wide = {name: _cred(name, set()) for name in seeds}
    previous = set(seeds)
    for hop in ("a", "b", "c"):
        names = {f"{hop}{i}" for i in range(k)}
        for name in names:
            wide[name] = _cred(name, set(previous))
        previous = names
    trust = _voter_trust_from_creds(wide, DEFAULT_SETTINGS, frozenset(seeds))
    assert trust is not None
    assert {f"{hop}{i}" for hop in ("a", "b", "c") for i in range(k)} <= trust.vouched, (
        "multi-hop propagation must survive k — only single-voucher hops are cut"
    )


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

    def vouched_socks(rounds: int, min_vouchers: int = 1) -> int:
        settings = replace(
            DEFAULT_SETTINGS,
            graph_cred=replace(
                DEFAULT_SETTINGS.graph_cred,
                vouch_max_rounds=rounds,
                # ★ k = 1 EXPLICITLY (2026-08-27): this test is about the ROUND
                # bound, and the cycle is single-voucher, so at the shipped k = 2
                # every assertion below would hold at 0 == 0 < 10 while measuring
                # nothing at all. The shipped-k result is asserted separately at
                # the end.
                vouch_min_vouchers=min_vouchers,
            ),
        )
        trust = _voter_trust_from_creds(creds, settings, frozenset({"seed"}))
        assert trust is not None
        return len({a for a in trust.vouched if a.startswith("sock")})

    bounded = vouched_socks(3)
    generous = vouched_socks(k + 5)  # effectively a closure
    assert bounded > 0, "nothing propagated — the round-bound comparison is vacuous"
    assert bounded < k, "the bound must stop one purchase from vouching the whole cycle"
    assert generous == k, (
        "unbounded propagation is expected to vouch the entire cycle — this is why "
        "vouch_max_rounds must stay bounded"
    )
    assert bounded < generous

    # ★ AT THE SHIPPED k THE SAME PURCHASE BUYS ZERO, at any round bound. The
    # round bound stops one purchase from buying the WHOLE cycle; k stops it from
    # buying any of it beyond the account actually engaged. Both still matter:
    # k only closes propagation, the round bound is what limits the residual when
    # an attacker does pay for k distinct endorsements.
    shipped = DEFAULT_SETTINGS.graph_cred.vouch_min_vouchers
    if shipped >= 2:
        assert vouched_socks(3, shipped) == 0
        assert vouched_socks(k + 5, shipped) == 0, (
            "at k >= 2 even an unbounded walk cannot enter a single-voucher cycle"
        )


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
