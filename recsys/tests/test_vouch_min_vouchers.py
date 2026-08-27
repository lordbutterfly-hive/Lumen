"""`GraphCredConfig.vouch_min_vouchers` (k) — the compensating control for
turning ring detection off.

★★★ THE REGRESSION THIS FILE EXISTS TO CATCH
============================================
Ring detection was disabled on 2026-08-27 (`RingConfig.enabled = False`,
`RECSYS_RING_DETECTION=0`) because it was measured ANTI-correlated with abuse.
That was the right call, and it silently removed a control nothing replaced.

`core/graph_cred.py` records an `outside_engager` only under
`if weight > 0.0 and not ring_flagged`. `ring_flagged` needs a non-empty
`ring_members`, so with the detector off it is permanently False and the word
"outside" loses its meaning: EVERY member of a reciprocal sock clique becomes
every other member's outside engager. `pipeline._voter_trust_from_creds` then
propagated vouch on ONE such engager (`not ...isdisjoint(vouched_set)`), so a
single inbound engagement from one already-vouched account carried the entire
clique into the vouched tier.

MEASURED ON THE LIVE 18,246-ACCOUNT SNAPSHOT (2026-08-27 18:23Z, 49 of 54 seeds
landed, `ring_members` empty). One engagement from one trusted seed into a
60-account reciprocal clique, sock graph-cred pinned at the live engaged-band
p90 (0.91 — where a 60-clique at 4 replies/pair actually lands):

    k   whole clique vouched      median socks vouched   ceiling per touch
    1        45 of 49 seeds              60 of 60              101
    2         0 of 49 seeds               0 of 60                0

TWO BOUNDS, STATED HONESTLY, so this is not read as more than it is:

1. With NO contact with the honest world at all the clique is unvouched at k = 1
   too (measured, 0 of 500). The seed anchor was never defeated. What k = 2
   closes is the AMPLIFICATION — one touch bought the whole clique instead of
   the one account actually engaged.

2. k PRICES the clique attack, it does not close it. An attacker who buys ~k^2
   endorsements from distinct already-vouched accounts (k socks, k vouchers
   each) still takes the clique — measured live, 1 endorsement at k = 1, 4 at
   k = 2, 9 at k = 3. `test_the_residual_is_k_squared_endorsements_not_infinite`
   pins that so nobody reads this file as a proof of closure.

THE COST: on the same live graph the vouched tier goes 7,395 -> 4,913, and the
loss falls on thin accounts (median 1 outside engager, 2 received events). See
`GraphCredConfig.vouch_min_vouchers` for the full table.

★ EVERY OTHER SYBIL TEST IN THIS SUITE RUNS AT `ring.enabled=True`, i.e. a
configuration that is NOT deployed. The `ring_off` tests below run the same
properties through `Settings.from_env()` with `RECSYS_RING_DETECTION=0`, so the
DEPLOYED configuration is covered rather than assumed.
"""

from __future__ import annotations

import collections
from dataclasses import replace

import pytest

from recsys.config import DEFAULT_SETTINGS, GraphCredConfig, Settings
from recsys.contracts import EngagementEdge, GraphCred
from recsys.pipeline import _voter_trust_from_creds, build_trust_snapshot
from tests.fakes import EPOCH, FakeGateway

HONEST = 300
CLIQUE = 60


# ── the knob ────────────────────────────────────────────────────────────────


def test_the_shipped_default_is_two() -> None:
    """★ The default IS the fix. A knob that ships at the vulnerable value is a
    fix that is switched off, which is this package's most-repeated failure."""
    assert GraphCredConfig().vouch_min_vouchers == 2
    assert DEFAULT_SETTINGS.graph_cred.vouch_min_vouchers == 2


@pytest.mark.parametrize("raw,expected", [("1", 1), ("2", 2), ("3", 3), (" 3 ", 3)])
def test_the_env_override_is_read(monkeypatch: pytest.MonkeyPatch, raw: str, expected: int) -> None:
    monkeypatch.setenv("RECSYS_VOUCH_MIN_VOUCHERS", raw)
    assert GraphCredConfig.from_env().vouch_min_vouchers == expected


def test_an_unset_environment_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECSYS_VOUCH_MIN_VOUCHERS", raising=False)
    base = replace(GraphCredConfig(), vouch_min_vouchers=3)
    assert GraphCredConfig.from_env(base) == base
    assert GraphCredConfig.from_env().vouch_min_vouchers == 2


@pytest.mark.parametrize("raw", ["", "  "])
def test_a_blank_value_is_treated_as_unset(monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
    monkeypatch.setenv("RECSYS_VOUCH_MIN_VOUCHERS", raw)
    assert GraphCredConfig.from_env().vouch_min_vouchers == 2


@pytest.mark.parametrize("raw", ["two", "2.5", "yes", "-", "0x2"])
def test_a_malformed_value_is_refused_not_silently_defaulted(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    """★ FAIL LOUD. Silently falling back would ship k = 2 while the operator
    believes they set k = 3 — the same class of defect as a `from_env` nobody
    threads: the setting looks configured and is not."""
    monkeypatch.setenv("RECSYS_VOUCH_MIN_VOUCHERS", raw)
    with pytest.raises(ValueError, match="RECSYS_VOUCH_MIN_VOUCHERS"):
        GraphCredConfig.from_env()


@pytest.mark.parametrize("bad", [0, -1])
def test_a_value_below_one_is_refused(bad: int) -> None:
    with pytest.raises(ValueError, match="vouch_min_vouchers must be >= 1"):
        GraphCredConfig(vouch_min_vouchers=bad)


def test_settings_from_env_threads_the_k_knob(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ THE WIRING, asserted directly.

    `Settings.from_env` has shipped four sub-configs whose `from_env` nobody
    called (`exploration`, `lite`, `seen`, `ring` — each recorded in that
    method's own docstring). An unthreaded knob is a knob permanently at its
    default: the operator cannot weaken it, and cannot verify it either.

    MUTANT: delete `graph_cred=GraphCredConfig.from_env()` from
    `Settings.from_env` and this fails.
    """
    monkeypatch.setenv("RECSYS_VOUCH_MIN_VOUCHERS", "3")
    assert Settings.from_env().graph_cred.vouch_min_vouchers == 3, (
        "Settings.from_env ignores RECSYS_VOUCH_MIN_VOUCHERS — the operator's knob "
        "has no path into the pipeline"
    )
    monkeypatch.delenv("RECSYS_VOUCH_MIN_VOUCHERS", raising=False)
    assert Settings.from_env().graph_cred.vouch_min_vouchers == 2


# ── the regression: a clique must not be bought wholesale ───────────────────


def _cred(account: str, engagers: set[str], score: float = 0.6) -> GraphCred:
    return GraphCred(
        account=account,
        score=score,
        follow_follower_ratio=1.0,
        outside_engaged=bool(engagers),
        outside_engagers=frozenset(engagers),
    )


def _clique_creds(size: int, *, touched_by: set[str]) -> dict[str, GraphCred]:
    """A reciprocal sock clique. With `ring_members` empty every member is every
    other member's `outside_engager`, which is exactly the state the deployed
    configuration produces. `touched_by` engages sock0 and nothing else."""
    socks = [f"sock{i}" for i in range(size)]
    creds = {s: _cred(s, set(socks) - {s}) for s in socks}
    creds["sock0"] = _cred("sock0", (set(socks) - {"sock0"}) | touched_by)
    return creds


def _socks(trust) -> set[str]:
    return {a for a in trust.vouched if a.startswith("sock")}


def test_one_seed_touch_does_not_vouch_a_whole_sock_clique() -> None:
    """★★★ THE REGRESSION TEST THAT WAS MISSING.

    MUTANT: restore `not gc.outside_engagers.isdisjoint(vouched_set)` in
    `_voter_trust_from_creds` (or set `RECSYS_VOUCH_MIN_VOUCHERS=1`) and the
    shipped-k assertion fails at 60 of 60.
    """
    creds = {"seed": _cred("seed", set()), **_clique_creds(CLIQUE, touched_by={"seed"})}
    seeds = frozenset({"seed"})

    # k = 1: the deployed-before-this-fix behaviour, kept as the positive control
    # so the assertion below cannot pass because the fixture stopped working.
    at_k1 = _voter_trust_from_creds(creds, _k(1), seeds)
    assert at_k1 is not None
    assert len(_socks(at_k1)) == CLIQUE, (
        "the k=1 control did not reproduce the regression — the fixture is not "
        "exercising vouch propagation and the k=2 result below proves nothing"
    )

    # k = 2 (shipped): only the sock that was actually engaged can be reached,
    # and it cannot be reached either, because ONE seed is one voucher.
    at_default = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, seeds)
    assert at_default is not None
    assert _socks(at_default) == set(), (
        f"{len(_socks(at_default))} of {CLIQUE} socks vouched from one engagement"
    )


def test_buying_k_endorsements_buys_exactly_the_account_engaged() -> None:
    """★ What the attacker gets for paying the full k price: one account.

    Two distinct vouched accounts engaging the SAME sock vouch that sock and
    nothing else — the other socks still cannot present a second vouched engager,
    because only one of them is vouched. Measured identically on the live graph
    (1 of 60). Cost therefore scales with k, not with clique size.
    """
    creds = {
        "seed": _cred("seed", set()),
        "seed2": _cred("seed2", set()),
        **_clique_creds(CLIQUE, touched_by={"seed", "seed2"}),
    }
    trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, frozenset({"seed", "seed2"}))
    assert trust is not None
    assert _socks(trust) == {"sock0"}


def test_the_residual_is_k_squared_endorsements_not_infinite() -> None:
    """★★★ THE HONEST LIMIT OF k, pinned so the fix is never read as a close.

    Once k socks are vouched, every remaining sock has k vouched engagers and the
    clique cascades. So the price is ~k^2 purchased endorsements — k socks, k
    distinct already-vouched engagers each — not infinity.

    Measured on the live 18,246-account graph with endorsers an attacker would
    actually choose (zero-contention vouched seeds; a high-out-degree seed loses
    its sock to the fan-out cap and misleadingly looks safe):

        k   endorsements to take a 60-clique
        1        1
        2        4
        3        9

    This test asserts the SHAPE on a fixture rather than the live numbers: at the
    shipped k, k^2 endorsements arranged k-per-sock take the clique, and one
    fewer does not. If someone later claims k closes the attack, this fails them.
    """
    k = DEFAULT_SETTINGS.graph_cred.vouch_min_vouchers
    endorsers = [f"seed{i}" for i in range(k)]
    base = {e: _cred(e, set()) for e in endorsers}
    seeds = frozenset(endorsers)
    socks = [f"sock{i}" for i in range(CLIQUE)]

    def clique_with(paid: dict[int, list[str]]) -> set[str]:
        creds = dict(base)
        creds.update({s: _cred(s, set(socks) - {s}) for s in socks})
        for idx, buyers in paid.items():
            name = socks[idx]
            creds[name] = _cred(name, (set(socks) - {name}) | set(buyers))
        trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, seeds)
        assert trust is not None
        return _socks(trust)

    # k^2 endorsements, k into each of k socks: the clique falls.
    full = {i: endorsers for i in range(k)}
    assert len(clique_with(full)) == CLIQUE, (
        f"k^2 = {k * k} endorsements did not take the clique — re-derive the "
        "residual before trusting the price stated in the docs"
    )
    # k^2 - 1 endorsements: the cascade has not started yet.
    short = {i: endorsers for i in range(k - 1)}
    short[k - 1] = endorsers[:-1]
    assert len(clique_with(short)) < CLIQUE, (
        "one endorsement short of k^2 already takes the clique — the price is "
        "lower than documented"
    )


def test_spreading_k_endorsements_over_different_socks_buys_nothing() -> None:
    """★ The obvious evasion, closed: two purchased endorsements aimed at two
    DIFFERENT socks leave each with one voucher, so neither is vouched — 0 of 60
    on the live graph too."""
    socks = [f"sock{i}" for i in range(CLIQUE)]
    creds = {"seed": _cred("seed", set()), "seed2": _cred("seed2", set())}
    creds.update({s: _cred(s, set(socks) - {s}) for s in socks})
    creds["sock0"] = _cred("sock0", (set(socks) - {"sock0"}) | {"seed"})
    creds["sock1"] = _cred("sock1", (set(socks) - {"sock1"}) | {"seed2"})
    trust = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, frozenset({"seed", "seed2"}))
    assert trust is not None
    assert _socks(trust) == set()


@pytest.mark.parametrize("size", [10, 60, 101, 500])
def test_the_clique_cannot_be_grown_out_of_the_control(size: int) -> None:
    """Scaling the clique is free for an attacker, so the defence must not
    depend on its size. At k = 1 the reach is capped at the fan-out ceiling
    (`vouch_max_fanout` x rounds, ~101) and grows with the clique up to it; at
    the shipped k it is 0 at every size."""
    creds = {"seed": _cred("seed", set()), **_clique_creds(size, touched_by={"seed"})}
    seeds = frozenset({"seed"})
    at_k1 = _voter_trust_from_creds(creds, _k(1), seeds)
    at_default = _voter_trust_from_creds(creds, DEFAULT_SETTINGS, seeds)
    assert at_k1 is not None and at_default is not None
    assert len(_socks(at_k1)) > 0, "k=1 control is vacuous at this size"
    assert _socks(at_default) == set()


def test_no_contact_with_the_honest_world_is_already_closed_at_k_one() -> None:
    """★ THE BOUND ON THE FINDING, pinned so the fix is not oversold.

    A clique that touches nothing is unvouched at BOTH k. The seed anchor was
    never defeated; `vouch_min_vouchers` closes the amplification, not the
    anchor. If this ever starts differing by k, the anchor itself has broken and
    that is the louder problem.
    """
    creds = {"seed": _cred("seed", set()), **_clique_creds(CLIQUE, touched_by=set())}
    seeds = frozenset({"seed"})
    for settings in (_k(1), DEFAULT_SETTINGS):
        trust = _voter_trust_from_creds(creds, settings, seeds)
        assert trust is not None
        assert _socks(trust) == set()


def _k(value: int) -> Settings:
    return replace(
        DEFAULT_SETTINGS,
        graph_cred=replace(DEFAULT_SETTINGS.graph_cred, vouch_min_vouchers=value),
    )


# ── the DEPLOYED configuration: ring detection OFF, end to end ──────────────


def _world(clique: int, *, seed_touches_sock: bool):
    """An honest population plus a reciprocal sock clique.

    ★ THE FOLLOW GRAPH IS NOT OPTIONAL. `compute_graph_cred` runs PageRank over
    the FOLLOW adjacency; with an empty follow graph every raw rank collapses and
    `_normalize_scores` puts the whole population in one band, so the vouch gate
    has nothing to discriminate on and the test passes for the wrong reason. A
    first attempt at this fixture did exactly that.
    """
    counts: dict[tuple[str, str], int] = {}
    follows: dict[str, set[str]] = collections.defaultdict(set)
    for i in range(HONEST):
        a, b = f"hon{i}", f"hon{(i + 1) % HONEST}"
        counts[(a, b)] = 3
        counts[(a, "hub")] = 20
        follows[a] |= {b, "hub"}
    counts[("seed0", "hub")] = 20
    counts[("hon0", "seed0")] = 5
    follows["seed0"].add("hub")
    follows["hon0"].add("seed0")

    socks = [f"sock{i}" for i in range(clique)]
    for a in socks:
        for b in socks:
            if a != b:
                counts[(a, b)] = 4
                follows[a].add(b)
    if seed_touches_sock:
        counts[("seed0", "sock0")] = 1
        follows["seed0"].add("sock0")

    edges = [
        EngagementEdge(
            src=s,
            dst=d,
            replies=counts.get((s, d), 0),
            reply_backs=counts.get((d, s), 0),
            upvotes=0,
            last_interaction=EPOCH,
        )
        for (s, d) in sorted(counts)
    ]
    gateway = FakeGateway(
        edges=edges, follow_graph={k: frozenset(v) for k, v in follows.items()}
    )
    return frozenset(socks), gateway


def _snapshot_trust(gateway, settings):
    snap = build_trust_snapshot(
        gateway,
        settings,
        since=EPOCH,
        now=EPOCH,
        trusted_seeds=frozenset({"seed0"}),
        production=False,
    )
    trust = _voter_trust_from_creds(snap.graph_creds, settings, snap.trusted_seeds)
    assert trust is not None
    return snap, trust


def test_ring_off_is_the_state_that_makes_a_clique_self_vouching(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★★★ THE DEPLOYED CONFIGURATION, end to end from the environment.

    This is the property no other Sybil test in the suite covers: every one of
    them builds `DEFAULT_SETTINGS`, where `ring.enabled` is True — a
    configuration that has not been deployed since 2026-08-27.

    Asserts the mechanism, not just the outcome: with the detector ON, a clique
    member's engagers are ring-flagged and never recorded, so `outside_engagers`
    excludes the clique. With it OFF they are all recorded, which is what makes
    k the only thing standing between one touch and the whole clique.
    """
    socks, gateway = _world(CLIQUE, seed_touches_sock=True)

    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    off = Settings.from_env()
    assert not off.ring.enabled
    snap_off, _ = _snapshot_trust(gateway, off)
    assert snap_off.ring_members == frozenset()
    inside = {
        a for a in socks if snap_off.graph_creds[a].outside_engagers & (socks - {a})
    }
    assert inside == socks, (
        "with ring detection off every clique member must count its co-conspirators "
        "as OUTSIDE engagers — if not, this fixture is not reproducing the deployed "
        "state and the k measurement below means nothing"
    )

    monkeypatch.setenv("RECSYS_RING_DETECTION", "1")
    on = Settings.from_env()
    assert on.ring.enabled
    snap_on, _ = _snapshot_trust(gateway, on)
    assert snap_on.ring_members & socks, "the detector should still see this clique"


def test_ring_off_one_touch_does_not_vouch_the_clique_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★★★ THE FULL PATH: env -> Settings -> build_trust_snapshot -> VoterTrust,
    in the DEPLOYED ring-off configuration.

    MUTANT: `RECSYS_VOUCH_MIN_VOUCHERS=1` (or reverting the `isdisjoint` test)
    and the shipped-k assertion fails with the whole clique vouched.
    """
    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    socks, gateway = _world(CLIQUE, seed_touches_sock=True)

    monkeypatch.setenv("RECSYS_VOUCH_MIN_VOUCHERS", "1")
    settings_k1 = Settings.from_env()
    assert settings_k1.graph_cred.vouch_min_vouchers == 1
    _, trust_k1 = _snapshot_trust(gateway, settings_k1)
    assert len(trust_k1.vouched & socks) == len(socks), (
        "the k=1 control did not reproduce the regression end to end"
    )

    monkeypatch.delenv("RECSYS_VOUCH_MIN_VOUCHERS", raising=False)
    settings = Settings.from_env()
    assert settings.graph_cred.vouch_min_vouchers == 2
    _, trust = _snapshot_trust(gateway, settings)
    assert not (trust.vouched & socks), (
        f"{len(trust.vouched & socks)} of {len(socks)} socks vouched at the shipped k"
    )


def _multi_seed_world(n_seeds: int = 8, n_honest: int = 120):
    """An honest world shaped like the LIVE one: several seeds, and honest
    accounts engaged by MORE THAN ONE other account.

    ★ WHY NOT `_world`. `_world`'s honest population is a pure chain plus a
    shared hub with ONE seed, so no honest account can ever present two vouched
    engagers and k = 2 vouches nobody in it — measured, and pinned below in
    `test_a_single_seed_chain_world_collapses_at_k_two` because it is a real
    property of k that a reader should see. It is not the live shape: the live
    graph has 49 landed seeds and the k = 2 vouched tier has a median of 14
    distinct outside engagers per account. Testing coverage on the chain world
    would have measured the fixture, not the control.
    """
    counts: dict[tuple[str, str], int] = {}
    follows: dict[str, set[str]] = collections.defaultdict(set)
    seeds = [f"seed{i}" for i in range(n_seeds)]
    honest = [f"hon{i}" for i in range(n_honest)]
    # every seed engages the first slice of the honest population, so those
    # accounts have >= k vouched engagers from round one
    for s_ in seeds:
        follows[s_].add("hub")
        counts[(s_, "hub")] = 10
        for h in honest[:20]:
            counts[(s_, h)] = 4
            follows[s_].add(h)
    # the rest of the honest population is engaged by several earlier accounts,
    # which is what an ordinary conversation graph looks like
    for i, h in enumerate(honest):
        for j in (1, 2, 3):
            other = honest[(i + j) % n_honest]
            counts[(other, h)] = 3
            follows[other].add(h)
        counts[(h, "hub")] = 5
        follows[h].add("hub")
    edges = [
        EngagementEdge(
            src=s_, dst=d, replies=counts.get((s_, d), 0),
            reply_backs=counts.get((d, s_), 0), upvotes=0, last_interaction=EPOCH,
        )
        for (s_, d) in sorted(counts)
    ]
    gateway = FakeGateway(
        edges=edges, follow_graph={k: frozenset(v) for k, v in follows.items()}
    )
    return frozenset(seeds), frozenset(honest), gateway


def test_ring_off_the_honest_population_still_earns_vouch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ THE COST SIDE, asserted rather than asserted-away.

    k = 2 must TIGHTEN the vouched tier, not empty it. On a world shaped like
    the live graph (several seeds, accounts engaged by more than one other
    account) the honest tier survives — which is what the live measurement says
    too: 7,395 -> 4,913 vouched of 18,246, a 33.6% cut, not a wipe.
    """
    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    monkeypatch.delenv("RECSYS_VOUCH_MIN_VOUCHERS", raising=False)
    seeds, honest, gateway = _multi_seed_world()
    settings = Settings.from_env()
    assert settings.graph_cred.vouch_min_vouchers == 2
    snap = build_trust_snapshot(
        gateway, settings, since=EPOCH, now=EPOCH,
        trusted_seeds=seeds, production=False,
    )
    trust = _voter_trust_from_creds(snap.graph_creds, settings, snap.trusted_seeds)
    assert trust is not None
    covered = trust.vouched & honest
    assert covered, (
        "k=2 vouched no honest account at all — that is a collapsed tier, not a "
        "tightened one"
    )
    # And it is a real slice of the population, not one or two accounts.
    assert len(covered) >= 20, f"only {len(covered)} of {len(honest)} honest accounts vouched"


def test_a_single_seed_chain_world_collapses_at_k_two(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ THE HONEST LIMIT OF k, measured and pinned rather than discovered later.

    In a world with ONE seed whose only engagement goes to a hub, and an honest
    population arranged as a chain, NO honest account can ever present two
    vouched engagers, so k = 2 vouches nobody but the seed. That is not a bug in
    the propagation — it is what requiring two independent endorsements MEANS on
    a graph too sparse to supply them, and the same structural reason 54.2% of
    the accounts that lose vouched status on the live graph have exactly one
    outside engager.

    It does not describe production (49 landed seeds; 4,913 accounts vouched at
    k = 2 on the live snapshot), but it does describe what would happen to a NEW
    or heavily-pruned deployment, and whoever tunes k should see it here rather
    than in a feed that quietly stopped crediting anyone.
    """
    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    monkeypatch.delenv("RECSYS_VOUCH_MIN_VOUCHERS", raising=False)
    _unused_socks, gateway = _world(CLIQUE, seed_touches_sock=True)
    settings = Settings.from_env()
    _, trust = _snapshot_trust(gateway, settings)
    assert not {a for a in trust.vouched if a.startswith("hon") or a == "hub"}
    # ...and at k = 1 the same world DOES credit the honest population, so this
    # is k's doing and not a broken fixture.
    monkeypatch.setenv("RECSYS_VOUCH_MIN_VOUCHERS", "1")
    _, trust_k1 = _snapshot_trust(gateway, Settings.from_env())
    assert {a for a in trust_k1.vouched if a.startswith("hon") or a == "hub"}


def test_ring_off_a_directed_cycle_is_still_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ The 2026-08-01 property, re-asserted in the ring-off world.

    The directed-cycle attack was closed by the SEED ANCHOR, not by ring
    detection, so it must survive the detector being switched off. Pinned here
    because that reasoning had never been run against `ring.enabled=False`.
    """
    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    monkeypatch.delenv("RECSYS_VOUCH_MIN_VOUCHERS", raising=False)
    settings = Settings.from_env()
    names = [f"sock{i}" for i in range(10)]
    counts = {(names[i], names[(i + 1) % 10]): 4 for i in range(10)}
    counts[("seed0", "hub")] = 20
    counts[("hon0", "seed0")] = 5
    follows = {n: frozenset({names[(i + 1) % 10]}) for i, n in enumerate(names)}
    follows["seed0"] = frozenset({"hub"})
    follows["hon0"] = frozenset({"seed0"})
    edges = [
        EngagementEdge(src=s, dst=d, replies=c, upvotes=0, last_interaction=EPOCH)
        for (s, d), c in sorted(counts.items())
    ]
    gateway = FakeGateway(edges=edges, follow_graph=follows)
    _, trust = _snapshot_trust(gateway, settings)
    assert not (trust.vouched & set(names))
