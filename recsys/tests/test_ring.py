"""Tests for basic vote-ring detection: reciprocity + insularity (§8.5).

★★★ READ THIS BEFORE ADDING A FIXTURE HERE (2026-08-27).

Every test above the POPULATION section at the bottom of this file is built on
2 to 11 synthetic accounts, and **none of them could ever have caught what
`54df75a` did to this detector.** That commit took votes out of the interaction
graph (`RealGraphWeights.upvote` 1.0 -> 0.0, owner ruling) and edited this file
purely mechanically, `upvotes=` -> `replies=`, so all 16 assertions stayed green
while the live detector went from flagging nobody to flagging **32.6% of the
network** (5,977 of 18,336 accounts, including 28 of the 54 trusted seeds and
Hive's own anti-abuse accounts `hivewatchers` and `guiltyparties`).

Worse, `test_mutual_2_clique_scores_high` PINS the live defect as correct
behaviour: on a vote-free graph "all of each account's engagement volume is
inside the pair" is no longer a ring, it is a conversation.

A detector's false-positive rate is a POPULATION property. It cannot be
observed on a fixture smaller than a population, however many of them there
are. The POPULATION section exists to hold the one measurement that can see it;
add to it, not only up here.
"""

from __future__ import annotations

import random
import statistics
from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timedelta

import pytest

from recsys.config import DEFAULT_SETTINGS, RealGraphWeights, RingConfig, Settings
from recsys.contracts import EngagementEdge
from recsys.core.ring import detect_rings, ring_member_set
from recsys.pipeline import build_trust_snapshot
from tests.fakes import EPOCH, FakeGateway

WEIGHTS = RealGraphWeights()


def _edge(
    src: str,
    dst: str,
    *,
    upvotes: int = 0,
    replies: int = 0,
    reply_backs: int = 0,
    last: datetime | None = None,
) -> EngagementEdge:
    return EngagementEdge(
        src=src,
        dst=dst,
        upvotes=upvotes,
        replies=replies,
        reply_backs=reply_backs,
        last_interaction=last,
    )


def test_empty_edges_returns_empty() -> None:
    assert detect_rings([], WEIGHTS) == {}


def test_mutual_2_clique_scores_high() -> None:
    # alice & bob only ever engage each other, heavily and reciprocally -> ALL
    # of each account's engagement volume is inside the pair -> ring_score 1.0.
    edges = [
        _edge("alice", "bob", replies=10, reply_backs=5),
        _edge("bob", "alice", replies=10, reply_backs=5),
    ]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["alice"].ring_score == 1.0
    assert signals["bob"].ring_score == 1.0
    assert signals["alice"].ring_id is not None
    assert signals["alice"].ring_id == signals["bob"].ring_id


def test_one_directional_superfan_scores_zero() -> None:
    # superfan only ever upvotes celeb; celeb never engages back -> no mutual
    # edge exists at all, so superfan never joins a ring (absent, not 0.0).
    edges = [_edge("superfan", "celeb", replies=50)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals == {}
    assert "superfan" not in signals
    assert ring_member_set(signals, 0.0) == frozenset()


def test_honest_hub_with_purely_one_way_inbound_scores_zero() -> None:
    # Many distinct fans each engage a popular hub one-way; the hub never
    # engages any of them back -> no reciprocal edges at all -> no ring.
    edges = [_edge(f"fan{i}", "hub", replies=5) for i in range(10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals == {}


def test_honest_hub_with_one_reciprocal_edge_still_scores_low() -> None:
    # hub reciprocates fan0 perfectly, but that pair is a tiny slice of hub's
    # total footprint once 9 other one-way fans are added -> low insularity
    # -> low ring_score for hub, even though a real ring edge exists. fan0,
    # whose entire footprint IS the reciprocal edge, scores high in contrast.
    edges = [_edge("fan0", "hub", replies=5), _edge("hub", "fan0", replies=5)]
    edges += [_edge(f"fan{i}", "hub", replies=50) for i in range(1, 10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["fan0"].ring_score == 1.0
    assert signals["hub"].ring_score < 0.1
    assert all(f"fan{i}" not in signals for i in range(1, 10))


def test_only_engagement_RECEIVED_dilutes_insularity_never_engagement_sent() -> None:
    """★ SEMANTICS CHANGED 2026-08-03, deliberately — this test previously
    asserted the opposite and the old assertion WAS the vulnerability.

    It used to require that heavy one-way OUTBOUND engagement lowered an
    account's ring_score ("same reciprocity, lower insularity"). Measured
    consequence on a dense 4-sock reciprocal ring: ~20 one-way upvotes per sock,
    aimed at one popular honest account, took ring_score 1.0000 -> 0.4737, under
    the 0.6 discount threshold, and graph-cred from 0.0000 (condemned) to
    1.0000. Twenty free upvotes each and the detector was defeated. Sending is
    costless and attacker-chosen, so it cannot be evidence of anything.

    Receiving still dilutes, and must: that is the honest hub above, whose fans
    engage IT (see test_honest_hub_with_one_reciprocal_edge_still_scores_low,
    which is unchanged and still passes — the legitimate case is defined by
    inbound, the exploit by outbound, and that is exactly what separates them).
    """
    insular = [_edge("a1", "b1", replies=10), _edge("b1", "a1", replies=10)]
    # a2 SPENDS heavily on strangers who never engage back — the attack shape.
    spender = [
        _edge("a2", "b2", replies=10),
        _edge("b2", "a2", replies=10),
        _edge("a2", "stranger1", replies=100),
        _edge("a2", "stranger2", replies=100),
    ]
    # a3 RECEIVES from unrelated accounts — genuine evidence of an audience.
    received = [
        _edge("a3", "b3", replies=10),
        _edge("b3", "a3", replies=10),
        _edge("stranger3", "a3", replies=100),
    ]
    signals = detect_rings(insular + spender + received, WEIGHTS, now=EPOCH)

    assert signals["a1"].ring_score == 1.0
    # buying your way out is no longer possible: identical to the undiluted pair
    assert signals["a2"].ring_score == signals["a1"].ring_score
    # being engaged BY outsiders still lowers insularity, as it should
    assert 0.0 < signals["a3"].ring_score < signals["a1"].ring_score
    for name in ("stranger1", "stranger2", "stranger3"):
        assert name not in signals


def test_outbound_spending_cannot_buy_a_ring_out_of_detection() -> None:
    """Regression for the measured bypass: a dense mutual ring must stay
    flagged no matter how much free one-way engagement its members spend."""
    socks = ["s0", "s1", "s2", "s3"]
    ring = [
        _edge(a, b, replies=3) for a in socks for b in socks if a != b
    ]
    for noise in (0, 12, 20, 41, 100, 1000):
        edges = list(ring)
        edges += [_edge(a, "popular_hub", upvotes=noise) for a in socks if noise]
        signals = detect_rings(edges, WEIGHTS, now=EPOCH)
        assert signals["s0"].ring_score == 1.0, f"diluted out at noise={noise}"
        assert set(ring_member_set(signals, 0.6)) >= set(socks)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "KNOWN OPEN: a one-way PUPPET dilutes a ring out of detection for one "
        "extra account. Pass 1 can only flag accounts that landed in a "
        "reciprocal group, so an account that sprays engagement in and never "
        "reciprocates is never flagged and its credit is never discounted. "
        "Candidate fix (concentration-weighting outside credit) collides with "
        "test_honest_hub_with_one_reciprocal_edge_still_scores_low, whose fans "
        "are also single-target. If this XPASSes, someone resolved that "
        "tension — remove the marker and record how."
    ),
)
def test_KNOWN_OPEN_one_way_puppet_dilutes_a_ring() -> None:
    """Measured: 13 upvotes from ONE puppet into each of 4 socks takes the whole
    ring from 1.0000 to 0.5806 — under the 0.6 threshold, 0/4 flagged."""
    socks = ["s0", "s1", "s2", "s3"]
    edges = [_edge(a, b, replies=3) for a in socks for b in socks if a != b]
    edges += [_edge("puppet", s, replies=13) for s in socks]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert "puppet" not in signals  # never joins a group -> never discountable
    assert set(ring_member_set(signals, 0.6)) >= set(socks)


def test_a_sacrificial_second_ring_cannot_launder_the_first() -> None:
    """The residual the received-only denominator left, and the second pass
    closes: engagement received from OUTSIDE is the one remaining way to inflate
    a denominator, and an attacker can supply it themselves.

    Ring B one-way engages ring A. B never reciprocates, so the reciprocal
    adjacency never merges them and A's outside-received grows. Measured before
    the second pass: A was cleaned at just 5 upvotes each (score 1.0 -> 0.4737)
    while B stayed condemned — clean identities at 2x accounts. Credit from an
    already-flagged source is now discarded, so A holds at 1.0.
    """
    a = ["a0", "a1", "a2", "a3"]
    b = ["b0", "b1", "b2", "b3"]
    base = [
        _edge(x, y, replies=3) for grp in (a, b) for x in grp for y in grp if x != y
    ]
    for noise in (5, 20, 100, 1000):
        edges = base + [_edge(src, dst, upvotes=noise) for src in b for dst in a]
        signals = detect_rings(edges, WEIGHTS, now=EPOCH)
        assert signals["a0"].ring_score == 1.0, f"laundered at noise={noise}"
        assert set(ring_member_set(signals, 0.6)) >= set(a) | set(b)


def test_unbalanced_reciprocity_below_min_is_not_a_ring() -> None:
    # bob engages alice 10x harder than she engages him back -> ratio 0.1,
    # under the default reciprocity_min=0.5 -> no ring edge forms.
    edges = [_edge("alice", "bob", replies=1), _edge("bob", "alice", replies=10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals == {}


def test_reciprocity_min_is_configurable() -> None:
    # the same 0.1-ratio pair DOES form a ring once the threshold is lowered
    # to admit it.
    edges = [_edge("alice", "bob", replies=1), _edge("bob", "alice", replies=10)]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH, reciprocity_min=0.05)
    assert signals["alice"].ring_score > 0.0
    assert signals["bob"].ring_score > 0.0


def test_min_group_filters_out_small_components() -> None:
    edges = [_edge("alice", "bob", replies=10), _edge("bob", "alice", replies=10)]
    assert detect_rings(edges, WEIGHTS, now=EPOCH, min_group=3) == {}
    assert detect_rings(edges, WEIGHTS, now=EPOCH, min_group=2) != {}


def test_three_way_ring_shares_a_ring_id() -> None:
    edges = [
        _edge("a", "b", replies=10),
        _edge("b", "a", replies=10),
        _edge("b", "c", replies=10),
        _edge("c", "b", replies=10),
        _edge("a", "c", replies=10),
        _edge("c", "a", replies=10),
    ]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["a"].ring_id == signals["b"].ring_id == signals["c"].ring_id
    assert signals["a"].ring_score == 1.0
    assert signals["b"].ring_score == 1.0
    assert signals["c"].ring_score == 1.0


def test_stale_edge_decays_below_reciprocity_threshold() -> None:
    # alice's side of the pair is ancient (20 half-lives old) and decays
    # toward zero; bob's reply-back is fresh -> the ratio collapses well
    # under reciprocity_min even though the raw (undecayed) counts matched.
    now = EPOCH + timedelta(days=600)
    edges = [
        _edge("alice", "bob", replies=10, last=EPOCH),
        _edge("bob", "alice", replies=10, last=now),
    ]
    assert detect_rings(edges, WEIGHTS, now=now) == {}


def test_ring_member_set_thresholds_correctly() -> None:
    edges = [
        _edge("alice", "bob", replies=10),
        _edge("bob", "alice", replies=10),
        # Dilutes alice only. NOTE the direction: stranger -> alice. This was
        # alice -> stranger until 2026-08-03, but engagement an account SENDS no
        # longer dilutes its insularity (that was a free bypass — see
        # test_only_engagement_RECEIVED_dilutes_insularity_never_engagement_sent).
        # Engagement RECEIVED still does, which is what this threshold test needs
        # to produce two accounts with different scores.
        _edge("stranger", "alice", replies=100),
    ]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["bob"].ring_score == 1.0
    assert 0.0 < signals["alice"].ring_score < signals["bob"].ring_score

    assert ring_member_set(signals, 0.5) == frozenset({"bob"})
    assert ring_member_set(signals, signals["alice"].ring_score) == frozenset({"alice", "bob"})
    assert ring_member_set(signals, 1.01) == frozenset()


def test_ring_member_set_empty_signals_is_empty() -> None:
    assert ring_member_set({}, 0.0) == frozenset()


def test_deterministic_across_runs() -> None:
    edges = [
        _edge("alice", "bob", replies=10),
        _edge("bob", "alice", replies=10),
        _edge("carol", "dave", replies=5),
        _edge("dave", "carol", replies=5),
    ]
    first = detect_rings(edges, WEIGHTS, now=EPOCH)
    second = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert first == second


# ═══════════════════════════════════════════════════════════════════════════
# ★★★ THE POPULATION SECTION (2026-08-27)
#
# WHAT IT MEASURES, AND WHY NOTHING ABOVE IT CAN. Precision is a ratio over a
# population: `flagged & abusive / flagged`. Every fixture above builds the
# NUMERATOR (a hand-planted ring, correctly caught) and has no denominator at
# all, so the suite could only ever answer "does it catch a ring?" and never
# "what else does it catch?". Since `54df75a` the answer to the second question
# is: a third of Hive.
#
# THE PRODUCTION MEASUREMENT this section encodes, against Hive's own abuse
# verdict (reputation < 25, n=17,488):
#
#     base rate (downvoted-into-the-ground)           18.56%
#     precision of `ring_members`                      5.84%   = 0.31x random
#     downvote rate among accounts it did NOT flag    24.98%
#     accounts flagged                          5,977/18,336   = 32.6%
#
# A detector whose flagged set is CLEANER than its unflagged set is not a weak
# detector, it is an inverted one, and no threshold change can correct a sign.
#
# THE EDGE SHAPE IS PRODUCTION'S, NOT THE CONVENIENCE HELPER'S. `_edge` at the
# top of this file leaves `reply_backs=0`, a shape `io/hafsql.py` can never
# emit: there, `reply_backs` on `(src, dst)` IS `replies[(dst, src)]`, so a
# mutual exchange carries BOTH counts on BOTH directed edges and the pair
# weight is `5*replies + 15*reply_backs` each way. That asymmetry-flattening is
# load-bearing here — it pulls the reciprocity ratio of a lopsided pair toward
# 1.0 and admits it as a ring edge. See `tests/test_production_edge_shape.py`,
# which exists because a fixture that cannot express the production shape
# cannot test the production behaviour.
# ═══════════════════════════════════════════════════════════════════════════

#: 64 x 40 = 2,560 accounts. Sized past 2,000 so the flagged FRACTION is a
#: population statistic rather than an artefact of a handful of components.
COMMUNITIES = 64
COMMUNITY_SIZE = 40
POPULATION = COMMUNITIES * COMMUNITY_SIZE

#: The production vote/reply edge ratio the day of the ruling, used by the
#: pre-`54df75a` control below: 2,482,540 upvote-only edges against 136,124
#: edges carrying anything else = 18.24 vote-only edges per non-vote edge, and
#: 17,234,136 upvotes over those 2,482,540 edges = a mean of 6.94 each.
PROD_VOTE_EDGE_RATIO = 18.24
PROD_MEAN_UPVOTES_PER_VOTE_EDGE = 6.94


def _reply_counts(
    *,
    seed: int = 20260827,
    partners: tuple[int, int] = (2, 8),
    reply_back_p: float = 0.5,
    stranger_p: float = 0.35,
    strangers: tuple[int, int] = (1, 4),
) -> tuple[list[str], dict[tuple[str, str], int]]:
    """A directed reply count per ordered pair, for an ordinary conversational
    network of :data:`POPULATION` accounts. **No ring is planted anywhere.**

    THE MODEL, and why each parameter is what it is:

    * ``COMMUNITIES`` disjoint communities of ``COMMUNITY_SIZE`` — people talk
      mostly to people in their own corner. That is what a social graph IS; it
      is not evidence of collusion, and a detector that cannot tell the two
      apart is the thing under test.
    * each account opens conversations with ``partners`` others in its own
      community (2-8 of 39, i.e. a SPARSE community, not a clique).
    * ``reply_back_p`` = 0.5: about half of those get a reply back. This is the
      one parameter the result is sensitive to, so it is deliberately set at
      the plainest possible reading of "a conversation" rather than tuned. The
      measured sweep (2026-08-27, this fixture, `detect_rings` at the shipped
      `reciprocity_min=0.5` / `ring_discount_threshold=0.6`) is:

          reply_back_p  0.1   0.2   0.3   0.4   0.55  0.7   0.9
          flagged       29.5% 41.1% 56.4% 70.0% 85.7% 95.1% 99.3%

      There is no setting in that range, down to a network so cold that only
      one reply in ten is answered, at which the assertion below is met. The
      conclusion does not depend on the choice.
    * ``stranger_p`` / ``strangers``: one-way replies out to random accounts
      anywhere in the network — the OUTSIDE traffic that is supposed to dilute
      insularity. Raising it does not rescue the detector either: at 10-20
      stranger edges per account (~57k edges, more outside traffic than any
      account has inside) the flagged fraction is still 2.03%, and only at
      20-40 per account does it reach 0.
    """
    rng = random.Random(seed)
    communities = [
        [f"u{c:02d}a{i:02d}" for i in range(COMMUNITY_SIZE)] for c in range(COMMUNITIES)
    ]
    everyone = [account for community in communities for account in community]
    counts: dict[tuple[str, str], int] = {}

    def add(src: str, dst: str, n: int) -> None:
        counts[(src, dst)] = counts.get((src, dst), 0) + n

    for community in communities:
        for account in community:
            k = min(rng.randint(*partners), len(community) - 1)
            for other in rng.sample([x for x in community if x != account], k):
                add(account, other, rng.randint(1, 5))
                if rng.random() < reply_back_p:
                    add(other, account, rng.randint(1, 5))
    for account in everyone:
        if rng.random() < stranger_p:
            for _ in range(rng.randint(*strangers)):
                other = rng.choice(everyone)
                if other != account:
                    add(account, other, rng.randint(1, 3))
    return everyone, counts


def _hafsql_shaped_edges(
    counts: dict[tuple[str, str], int],
    votes: dict[tuple[str, str], int] | None = None,
) -> list[EngagementEdge]:
    """Assemble edges exactly as ``io/hafsql.py`` does — the load-bearing line
    being ``reply_backs=replies[(dst, src)]``, the REVERSE pair's own replies.
    ``votes`` is the traffic `54df75a` removed; it is empty for every test that
    models today's graph."""
    votes = votes or {}
    return [
        EngagementEdge(
            src=src,
            dst=dst,
            replies=counts.get((src, dst), 0),
            reply_backs=counts.get((dst, src), 0),
            upvotes=votes.get((src, dst), 0),
            last_interaction=EPOCH,
        )
        for (src, dst) in sorted(set(counts) | set(votes))
    ]


def _vote_trails(
    accounts: list[str], counts: dict[tuple[str, str], int], *, seed: int = 99
) -> dict[tuple[str, str], int]:
    """One-directional upvote-only edges at the production ratio — the 94.8% of
    the live graph that `54df75a` deleted. Deliberately never mutual: the
    measurement that justified the ruling found only 6.2% of heavy upvote-only
    edges had ANY reciprocal edge."""
    rng = random.Random(seed)
    votes: dict[tuple[str, str], int] = {}
    target = round(len(counts) * PROD_VOTE_EDGE_RATIO)
    while len(votes) < target:
        src, dst = rng.choice(accounts), rng.choice(accounts)
        if src != dst and (src, dst) not in counts and (src, dst) not in votes:
            votes[(src, dst)] = max(1, int(rng.expovariate(1 / PROD_MEAN_UPVOTES_PER_VOTE_EDGE)))
    return votes


def _flagged_fraction(edges: list[EngagementEdge], weights: RealGraphWeights, n: int) -> float:
    settings = DEFAULT_SETTINGS
    signals = detect_rings(
        edges,
        weights,
        now=EPOCH,
        reciprocity_min=settings.ring.reciprocity_min,
        min_group=settings.ring.min_group,
        self_credit_threshold=settings.thresholds.ring_discount_threshold,
    )
    members = ring_member_set(signals, settings.thresholds.ring_discount_threshold)
    return len(members) / n


#: The bar. A Sybil-ring detector that flags more than one account in fifty on
#: a population containing no ring is not usable as a discount authority, at
#: any threshold — 2% is already an order of magnitude looser than the ~0.1%
#: prevalence a ring farm can plausibly have.
MAX_FALSE_POSITIVE_FRACTION = 0.02


def test_the_population_fixture_is_a_population_and_not_a_ring_farm() -> None:
    """★ GUARD ON THE GUARD. The two tests below are only meaningful if the
    fixture really is an honest network; if the generator ever degenerates into
    dense mutual cliques, "the detector flags everyone" becomes correct and the
    measurement silently becomes vacuous. A check with nothing to inspect must
    fail, so inspect it."""
    accounts, counts = _reply_counts()
    assert len(accounts) == POPULATION >= 2000

    partners: dict[str, set[str]] = defaultdict(set)
    mutual: dict[str, set[str]] = defaultdict(set)
    for src, dst in counts:
        partners[src].add(dst)
        partners[dst].add(src)
        if (dst, src) in counts:
            mutual[src].add(dst)

    degrees = [len(partners[a]) for a in accounts]
    mutual_degrees = [len(mutual[a]) for a in accounts]
    # Nobody's whole footprint is a single partner — that shape (`test_mutual_
    # 2_clique_scores_high`) is the one thing this detector is entitled to flag.
    assert min(degrees) >= 2
    # The median account converses with ~11 people, an order of magnitude past
    # every other fixture in this file.
    assert statistics.median(degrees) >= 8
    # NO CLIQUE ANYWHERE: even the most connected account is mutually engaged
    # with well under half its own community, let alone the network.
    assert max(mutual_degrees) <= COMMUNITY_SIZE // 2
    # And the communities are not hermetically sealed — cross-community traffic
    # exists, which is precisely the outside evidence insularity is meant to see.
    assert any(src[:3] != dst[:3] for src, dst in counts)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "KNOWN BROKEN, AND SWITCHED OFF IN DEPLOYMENT (2026-08-27). Measured on "
        "this fixture: 2,130 of 2,560 accounts flagged = 83.20%, against a 2.00% "
        "bar. On the live graph the same defect flags 5,977 of 18,336 (32.6%) at "
        "5.84% precision on an 18.56% abuse base rate — 0.31x random, i.e. "
        "ANTI-correlated with abuse. Cause: `54df75a` removed votes from the "
        "graph, so `outside_received` in `core/ring.py`'s insularity denominator "
        "collapsed to a median of exactly 0.0 and `ring_score` became 'what "
        "fraction of the people you interact with do you reply back to'. No "
        "threshold fixes a sign error, so `RingConfig.enabled` is False in "
        "deployment (`RECSYS_RING_DETECTION=0`) instead. "
        "IF THIS XPASSES someone has repaired the metric: remove this marker, "
        "record the positive control that proved it (precision above the base "
        "rate on a labelled set), and only then re-arm the flag."
    ),
)
def test_a_population_with_no_planted_ring_is_not_mass_flagged() -> None:
    """★★★ THE TEST THAT WOULD HAVE CAUGHT `54df75a`, AND DID NOT EXIST.

    Runs the whole snapshot path with the SHIPPED defaults (ring detection at
    its `enabled=True` code default) over 2,560 honest accounts, and asserts the
    false-positive rate a discount authority has to clear.

    It runs through `build_trust_snapshot` rather than `detect_rings` directly
    on purpose: what matters is not the primitive's score but whether anybody's
    content actually gets discounted, and that is decided here.
    """
    accounts, counts = _reply_counts()
    gateway = FakeGateway(edges=_hafsql_shaped_edges(counts))
    snapshot = build_trust_snapshot(
        gateway,
        DEFAULT_SETTINGS,
        since=EPOCH,
        now=EPOCH,
        trusted_seeds=frozenset(),
        production=False,
    )
    fraction = len(snapshot.ring_members) / len(accounts)
    assert fraction < MAX_FALSE_POSITIVE_FRACTION, (
        f"{len(snapshot.ring_members)}/{len(accounts)} = {fraction:.2%} of an honest "
        f"population flagged as a ring"
    )


def test_the_same_population_before_54df75a_was_not_mass_flagged() -> None:
    """★★★ THE INSTRUMENT CHECK, and the thing that dates the regression.

    Without this the test above proves nothing: "a big synthetic graph gets
    flagged" would be equally explained by a bad fixture. So run the IDENTICAL
    reply graph in the shape the detector saw BEFORE `54df75a` — the same
    conversations plus the one-way vote trails that commit deleted, scored with
    the `upvote=1.0` weight it set to 0.0 — and watch the same assertion pass.

    MEASURED 2026-08-27 on this fixture, sweeping the vote/reply edge ratio:

        ratio     0.5    1.0    2.0    4.0    8.0    18.24 (production)
        flagged  81.21% 77.34% 39.02%  3.05%  0.00%   0.00%

    So the vote traffic was carrying the ENTIRE `outside_received` denominator,
    and removing it did not weaken the detector, it inverted it. The fixture is
    sound; the metric is not.
    """
    accounts, counts = _reply_counts()
    edges = _hafsql_shaped_edges(counts, _vote_trails(accounts, counts))
    pre_54df75a = replace(WEIGHTS, upvote=1.0)
    assert WEIGHTS.upvote == 0.0, "this control is meaningless unless votes are gone today"

    fraction = _flagged_fraction(edges, pre_54df75a, len(accounts))
    assert fraction < MAX_FALSE_POSITIVE_FRACTION, (
        f"the pre-54df75a graph flagged {fraction:.2%} — the fixture, not the "
        f"vote removal, would then be what the test above is measuring"
    )


def test_disabling_ring_detection_empties_ring_members_on_the_population(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★★★ THE DEPLOYED CONFIGURATION, asserted end to end from the environment.

    `RECSYS_RING_DETECTION=0` -> `Settings.from_env` -> `build_trust_snapshot`
    -> not one of the 2,560 honest accounts is discounted. This is the same
    assertion the xfail above makes and the only configuration in which it
    holds today.

    MUTANT: drop the `if settings.ring.enabled:` guard in `build_trust_snapshot`
    and this fails at 83.20%.
    """
    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    accounts, counts = _reply_counts()
    gateway = FakeGateway(edges=_hafsql_shaped_edges(counts))
    settings = Settings.from_env()
    assert not settings.ring.enabled

    snapshot = build_trust_snapshot(
        gateway, settings, since=EPOCH, now=EPOCH,
        trusted_seeds=frozenset(), production=False,
    )
    assert snapshot.ring_members == frozenset()
    assert len(snapshot.ring_members) / len(accounts) < MAX_FALSE_POSITIVE_FRACTION
    # The rest of the snapshot is still built — this is a disabled DISCOUNT, not
    # a disabled batch.
    assert len(snapshot.graph_creds) >= POPULATION - COMMUNITY_SIZE


def test_the_flag_removes_authority_not_the_primitive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ The flag is load-bearing in BOTH directions, proven on a REAL ring.

    Four socks who engage only each other are exactly what `detect_rings` is
    for. With the switch on they are discounted; with it off they are not. So
    the switch is not dead code, `core/ring.py` is untouched and still works,
    and re-arming it is one environment variable — which is the whole point of
    keeping the primitive rather than deleting it (it carries 1.78x lift on the
    live abuse measure and is the only layer that finds the Waivio bot fleet).
    """
    socks = ["sock0", "sock1", "sock2", "sock3"]
    counts = {(a, b): 4 for a in socks for b in socks if a != b}
    # A little honest background so the world is not literally only a ring.
    for i in range(6):
        counts[(f"hon{i}", f"hon{(i + 1) % 6}")] = 3
        counts[(f"hon{i}", "hub")] = 20
    gateway = FakeGateway(edges=_hafsql_shaped_edges(counts))

    monkeypatch.delenv("RECSYS_RING_DETECTION", raising=False)
    on = build_trust_snapshot(
        gateway, Settings.from_env(), since=EPOCH, now=EPOCH,
        trusted_seeds=frozenset(), production=False,
    )
    assert set(socks) <= set(on.ring_members), "the primitive stopped working"

    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    off = build_trust_snapshot(
        gateway, Settings.from_env(), since=EPOCH, now=EPOCH,
        trusted_seeds=frozenset(), production=False,
    )
    assert off.ring_members == frozenset()


# ── the switch itself ────────────────────────────────────────────────────────


def test_ring_detection_is_on_by_default_in_code() -> None:
    """The DEFAULT stays ON. A Sybil control that ships off-by-default in
    source is one that is off wherever the deploy forgets it; this is turned off
    in the ENVIRONMENT, where the reason is visible in the compose file, not
    silently in a dataclass."""
    assert RingConfig().enabled is True
    assert DEFAULT_SETTINGS.ring.enabled is True


@pytest.mark.parametrize("raw", ["0", "false", "FALSE", "no", "off", "  Off  "])
def test_the_documented_off_values_turn_it_off(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    monkeypatch.setenv("RECSYS_RING_DETECTION", raw)
    assert RingConfig.from_env().enabled is False
    assert Settings.from_env().ring.enabled is False


@pytest.mark.parametrize("raw", ["1", "true", "yes", "on", "disbaled", "OFF!", "null", "-"])
def test_anything_it_does_not_recognise_leaves_the_detector_ARMED(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    """★ FAILS SAFE, and the polarity is the MIRROR of `SeenConfig`'s on purpose.

    Seen suppression defaults off and is opted into, so an unrecognised value
    leaves it off. This defaults on and is opted out of, so an unrecognised
    value leaves it ON. A typo must never silently drop a Sybil control —
    `RECSYS_RING_DETECTION=disbaled` keeps it armed, loudly wrong rather than
    quietly disarmed.
    """
    monkeypatch.setenv("RECSYS_RING_DETECTION", raw)
    assert RingConfig.from_env().enabled is True


def test_an_unset_environment_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECSYS_RING_DETECTION", raising=False)
    assert RingConfig.from_env().enabled is True
    assert RingConfig.from_env(RingConfig(enabled=False)).enabled is False
    assert Settings.from_env().ring == RingConfig()


def test_settings_from_env_threads_the_ring_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    """★★★ THE WIRING, asserted directly.

    This package has now shipped THREE `from_env` methods whose only reference
    was inside their own error message (`ExplorationConfig` 2026-08-04, `Lite`
    2026-08-05, `Seen` 2026-08-15) — a setting that could never receive a real
    value in production while every test passed. `RingConfig.from_env` would
    have been the fourth, and the cost would be the trust batch re-flagging a
    third of the network every three days with the operator's switch sitting
    unread in the environment.

    MUTANT: drop `ring=RingConfig.from_env()` from `Settings.from_env`. This
    fails, and it is the ONLY test that does.
    """
    monkeypatch.setenv("RECSYS_RING_DETECTION", "0")
    assert Settings.from_env().ring.enabled is False, (
        "Settings.from_env ignores RECSYS_RING_DETECTION — the operator's switch "
        "is unreachable from the batch and the service"
    )
    # ...and it must not disturb the import-time singleton the whole suite and
    # every measurement-harness panel build on.
    assert DEFAULT_SETTINGS.ring.enabled is True


def test_the_ring_discount_threshold_is_not_an_off_switch() -> None:
    """★ WHY A FLAG AND NOT A NUMBER — the alternative that does not work.

    `ring_score` is capped at 1.0 by `min()` and `ring_member_set` tests `>=`,
    so a threshold of 1.0 still flags every perfectly-insular account. Turning
    the detector off by tuning would need a threshold strictly ABOVE 1.0, i.e. a
    value whose meaning is "never" written as if it were a score. That is a
    disabled feature disguised as a tuning choice, which is exactly what nobody
    reviewing the config six months from now would recognise.
    """
    edges = [
        EngagementEdge(src="a", dst="b", replies=10, reply_backs=10, last_interaction=EPOCH),
        EngagementEdge(src="b", dst="a", replies=10, reply_backs=10, last_interaction=EPOCH),
    ]
    signals = detect_rings(edges, WEIGHTS, now=EPOCH)
    assert signals["a"].ring_score == 1.0
    assert ring_member_set(signals, 1.0) == frozenset({"a", "b"})
    assert ring_member_set(signals, 1.0000001) == frozenset()
