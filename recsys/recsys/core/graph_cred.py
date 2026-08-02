"""Graph-cred (§8.3): engagement-weighted follow-graph PageRank, Sybil-hardened.

The *topology is the follow graph* (``follows``); each follow edge A->B is
weighted by how much A actually engages B (the RealGraph :class:`EngagementEdge`
A->B collapsed by :func:`edge_weight`). Raw, unengaged follows therefore carry
~no weight — which is the whole point (raw follows are free custom_json ops and
thus Sybil-farmable; reciprocated *activity* is not).

Three additional Sybil-resistance layers close the gaps a vanilla PageRank
leaves open (COUNCIL-FINDINGS-2026-07-19, WAVE 1):
  * **Seeded teleport** (TrustRank/EigenTrust) so a closed Sybil clique can't
    mint free rank from uniform teleport alone.
  * **Self-dealing edge discount** — stake-lineage siblings and intra-ring
    pairs contribute zero engagement weight (same exclusion logic §8.4 already
    applies to the independent vote signal). Ring membership alone is not
    enough to zero an edge: it additionally requires evidence of SCALE (the
    account has more than one distinct ring-flagged partner) or a REPEATED
    pattern (both directions of the pair clear ``min_ring_self_dealing_events``
    raw interactions) — see the relocated-newcomer-blackout note below.
    Lineage discounting is unconditional; it is a verified on-chain fact, not
    an inference from behavior.
  * **Follow/follower-ratio prior** — divides down accounts that follow far
    more than follow them back, before normalization.

Scored in THREE bands, because "we have evidence this account is bad" and "we
have no evidence about this account yet" are different states and must not
share a score:

  * **0.0 — self-dealing.** Reserved for *positive evidence*: every unit of
    engagement the account has received came from its own stake lineage or its
    own detected ring and was zeroed by the self-dealing discount. Absolute,
    so it is unaffected by how many accounts exist or how good the rest of the
    network is.
  * **``min_vouched_score`` — unknown.** Nobody has engaged this account yet:
    a brand-new author, a newcomer who upvotes and comments before ever
    posting, an ordinary reader who only ever consumes. This is the *absence*
    of evidence, so it is scored as the weakest standing that is still
    standing — strictly below every engaged account, strictly above the
    self-dealing band, and above any floor in
    :class:`recsys.config.Thresholds`. A raw, unengaged follow therefore still
    buys nothing: it cannot lift anyone out of this band.
  * **``(min_vouched_score, 1]`` — engaged.** Every account that HAS been
    engaged is percentile-ranked (robust to a single hyper-node, unlike
    divide-by-max) *among the engaged population only* and mapped into that
    band, so never-engaged accounts cannot inflate it.

The band split (rather than a whole-population percentile) is what lets a
floor mean anything at all: a percentile is a quota ("the bottom N%"), never a
quality bar, and a large exact tie-band at the bottom drags even that quota up
(:func:`recsys.core.normalize.percentile_rank` counts samples ``<=`` the value,
so a band of *k* tied accounts all inherit the band's TOP rank ``k/n``; with
``k = 39`` of ``n = 180`` no account could score below 0.217).

What the 0.0 band is worth, measured, is exactly one thing: a *detected* ring
or lineage group is held below the floor instead of floating back to
mid-distribution (measured 0.54 for a 20-account ring under a whole-population
percentile, where it cleared the floor and could vouch for strangers). It is
NOT general Sybil resistance and must never be sold as such — an attacker who
keeps a single alt's engagement lopsided enough to miss the ring detector's
reciprocity test (two operations: one upvote in, one reply back) has clean
received engagement and lands in the engaged band. The floor is exactly as
strong as ring/lineage detection and no stronger; the load-bearing defense for
out-of-network distribution is the second-degree vouch COUNT gate (§8.1),
which requires an engager the *viewer already follows*.

RELOCATED-NEWCOMER-BLACKOUT FIX (measured, this revision): ring.py's
insularity test scores a reciprocal PAIR whose entire footprint is each other
at ``ring_score == 1.0`` regardless of magnitude — one mutual upvote scores
identically to a thousand. That is correct for what ring.py measures
(insularity), but treating a bare ``ring_score >= threshold`` as *proof* of
self-dealing conflated "these two accounts only ever engage each other" with
"these two accounts only ever engage each other, MANY times" — and the first
of those is the single most ordinary onboarding event on the network (two
brand-new accounts, a starter-pack mutual follow, one upvote back). Nothing
in a single reciprocal exchange distinguishes it from a two-account Sybil
pair — that is not a gap in this implementation, it is true at n=1 — so the
only honest fix is to not condemn at n=1: :func:`_engagement_by_pair` now
additionally requires SCALE (the account has more than one distinct
ring-flagged partner — it is in an actual multi-party ring, not an isolated
pair) or a REPEATED pattern (both directions of the pair clear
``config.min_ring_self_dealing_events`` raw interaction events) before
treating a ring-flagged pair's engagement as proven rather than ordinary.
Measured on the harness's 20-sybil/1-patsy attack (dense, many-partner,
high-volume by construction): still 20/20 flagged, ring-cred still 0.0 for
all 20, patsy's inflated cred still suppressed by the floor — see
:mod:`measurement-harness.q4_graph_als`. Lineage discounting is untouched:
it is real evidence regardless of scale.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime

import numpy as np

from recsys.config import GraphCredConfig, RealGraphWeights
from recsys.contracts import EngagementEdge, GraphCred
from recsys.core.normalize import percentile_rank


def edge_weight(edge: EngagementEdge, weights: RealGraphWeights, now: datetime) -> float:
    """Collapse a RealGraph edge into a scalar, time-decayed weight (§8.3).

    Weighted sum of the interaction counts, discounted by
    ``0.5 ** (age_days / weights.half_life_days)`` where ``age_days`` is the age
    of ``edge.last_interaction`` relative to ``now`` (``None`` ⇒ no decay,
    future timestamps clamp to age 0). Always non-negative.
    """
    raw = (
        weights.reply * edge.replies
        + weights.reply_back * edge.reply_backs
        + weights.upvote * edge.upvotes
        + weights.reblog * edge.reblogs
        + weights.mention * edge.mentions
        + weights.profile_visit * edge.profile_visits
        + weights.post_open * edge.post_opens
        + weights.revisit * edge.revisits
        + (edge.dwell_seconds / 60) * weights.dwell_per_minute
    )
    if edge.last_interaction is None:
        decay = 1.0
    else:
        age_days = max((now - edge.last_interaction).days, 0)
        decay = 0.5 ** (age_days / weights.half_life_days)
    return max(0.0, raw * decay)


def compute_graph_cred(
    edges: Sequence[EngagementEdge],
    follows: Mapping[str, frozenset[str]],
    weights: RealGraphWeights,
    *,
    config: GraphCredConfig,
    trusted_seeds: frozenset[str] = frozenset(),
    ring_members: frozenset[str] = frozenset(),
    lineage: Mapping[str, frozenset[str]] | None = None,
    now: datetime | None = None,
) -> dict[str, GraphCred]:
    """Engagement-weighted, Sybil-hardened follow-graph PageRank (§8.3).

    Follow edges form the topology; each is weighted by the engagement on
    that ordered pair, EXCEPT self-dealing edges — an edge A->B contributes
    zero when B is a stake-lineage sibling of A (``B in lineage.get(A)``,
    unconditional), or A and B are both members of the same detected
    engagement ring AND that ring flag clears a SCALE bar: A or B has more
    than one distinct ring-flagged partner, or both directions of the A<->B
    pair itself show at least ``config.min_ring_self_dealing_events`` raw
    interactions each (see :func:`_engagement_by_pair`). A bare mutual
    ring-flag on an otherwise-untouched pair — e.g. two brand-new accounts who
    engaged each other exactly once — does not by itself zero the edge.

    PageRank teleport is seeded toward ``trusted_seeds`` (TrustRank/
    EigenTrust): ``config.seed_teleport_share`` of the teleport mass is spread
    uniformly over ``trusted_seeds``, the remainder uniformly over every
    account — closing the hole where a closed Sybil clique mints free rank
    from purely uniform teleport. Empty ``trusted_seeds`` falls back to fully
    uniform teleport (today's behavior).

    The raw rank is then discounted by each account's follow/follower-ratio
    prior (``1 / (1 + max(0, ratio - 1))`` — divides down accounts that follow
    far more than follow them back) and normalized into the three bands of the
    module docstring: an account whose only received engagement was zeroed as
    self-dealing scores ``0.0``; an account nobody has engaged yet scores
    ``config.min_vouched_score`` (unknown, not judged); everyone else is
    percentile-ranked among the engaged population and mapped into
    ``(config.min_vouched_score, 1]``. Received engagement is counted from
    ``edges`` directly, NOT from the follow-restricted PageRank topology, so a
    brand-new author engaged by someone who does not (yet) follow them enters
    the engaged band on their first genuine interaction.

    ``follow_follower_ratio`` is computed from ``follows`` alone. Empty
    ``edges`` and ``follows`` ⇒ ``{}``; a follow graph with no engagement on
    any edge ⇒ every score ``config.min_vouched_score`` (everyone unknown —
    a uniformly empty signal is ranked, not scored, so nobody is inflated and
    nobody is condemned). ``now`` defaults to the current time (injectable for
    deterministic runs/tests). Uses ``config.damping`` / ``config.iterations``.
    """
    resolved_now = now if now is not None else datetime.now(UTC)
    resolved_lineage: Mapping[str, frozenset[str]] = lineage if lineage is not None else {}
    accounts = _account_universe(edges, follows)
    if not accounts:
        return {}
    nodes = sorted(accounts)
    ratios = _follow_follower_ratios(nodes, follows)
    pair_weight, discounted, outside_received, outside_engagers = _engagement_by_pair(
        edges,
        weights,
        resolved_now,
        resolved_lineage,
        ring_members,
        config.min_ring_self_dealing_events,
    )
    seeds = trusted_seeds & accounts
    raw = _weighted_pagerank(
        nodes, follows, pair_weight, config.damping, config.iterations, seeds,
        config.seed_teleport_share,
    )
    received = _received_engagement(nodes, pair_weight)
    scores = _normalize_scores(
        nodes, raw, ratios, received, discounted, config.min_vouched_score
    )
    return {
        account: GraphCred(
            account=account,
            score=scores[account],
            follow_follower_ratio=ratios[account],
            outside_engaged=outside_received.get(account, 0.0) > 0.0,
            outside_engagers=frozenset(outside_engagers.get(account, ())),
        )
        for account in nodes
    }


def _account_universe(
    edges: Sequence[EngagementEdge], follows: Mapping[str, frozenset[str]]
) -> set[str]:
    """Every account touched by an edge endpoint or the follow graph."""
    accounts: set[str] = set()
    for edge in edges:
        accounts.add(edge.src)
        accounts.add(edge.dst)
    for follower, followees in follows.items():
        accounts.add(follower)
        accounts.update(followees)
    return accounts


def _follow_follower_ratios(
    nodes: Sequence[str], follows: Mapping[str, frozenset[str]]
) -> dict[str, float]:
    """``following_count / max(follower_count, 1)`` for every node (§8.3)."""
    follower_counts: dict[str, int] = {}
    for followees in follows.values():
        for followee in followees:
            follower_counts[followee] = follower_counts.get(followee, 0) + 1
    return {
        account: len(follows.get(account, frozenset())) / max(follower_counts.get(account, 0), 1)
        for account in nodes
    }


def _raw_event_count(edge: EngagementEdge) -> int:
    """Discrete interaction-EVENT count on a single edge — every count field
    summed, ignoring ``RealGraphWeights`` and time-decay entirely (``dwell_seconds``
    is continuous, not a count, so it is excluded too). This is the SCALE
    signal :func:`_ring_scale_signals` uses to gate ring-based self-dealing
    (§8.3 relocated-newcomer-blackout fix): "was there more than one
    interaction here" must not move just because the feature weights get
    retuned — a single upvote is a single upvote at any weight.
    """
    return (
        edge.replies
        # ★ `reply_backs` is DELIBERATELY ABSENT (2026-08-01). `io/hafsql.py`
        # populates it from `replies[(dst, src)]` — the REVERSE edge's own reply
        # count — so summing it here counted the partner's reply as one of this
        # edge's events, and one mutual reply exchange scored 2 in BOTH
        # directions. That cleared `min_ring_self_dealing_events = 2` outright,
        # which is the exact threshold `GraphCredConfig.__post_init__` refuses to
        # set to 1 because "1 would make the newcomer protection a no-op". With
        # the production gateway, 2 WAS 1.
        #
        # Measured on the real hafsql edge shape, two brand-new accounts:
        #     one mutual upvote each way -> 1 event  -> cred 1.0000 (protected)
        #     one mutual reply  each way -> 2 events -> cred 0.0000 (condemned)
        # The suite could not see it: its fixtures leave `reply_backs` at 0, a
        # shape production never emits, so the tests exercised a mutual reply as
        # if it were a single event.
        #
        # Both directions are still counted — as the reverse edge's own
        # `replies`, which is where they belong — and `_ring_scale_signals`
        # already inspects both. The reciprocity SIGNAL is untouched:
        # `RealGraphWeights.reply_back` still weights this field everywhere that
        # weighting (rather than event counting) is the question.
        + edge.upvotes
        + edge.reblogs
        + edge.mentions
        + edge.profile_visits
        + edge.post_opens
        + edge.revisits
    )


def _ring_scale_signals(
    edges: Sequence[EngagementEdge], ring_members: frozenset[str]
) -> tuple[dict[str, frozenset[str]], dict[tuple[str, str], int]]:
    """Reconstruct just enough ring-adjacency structure from ``edges`` and
    ``ring_members`` to gate self-dealing on scale (§8.3), without importing
    :mod:`recsys.core.ring` — this module's dependency surface stays as
    documented, and the two SCALE tests below only need raw event counts, not
    ring.py's reciprocity-ratio math.

    Returns ``(partners, raw_count)``:

    * ``partners[account]`` — every OTHER ring-flagged account it has a
      genuinely bidirectional edge with (both directions present, any
      volume). ``len(...) > 1`` means the account sits in an actual
      multi-party ring, not an isolated pair — breadth alone is SCALE
      evidence no matter how small any single edge in it is.
    * ``raw_count[(src, dst)]`` — the summed :func:`_raw_event_count` for
      that directed pair (only pairs where both endpoints are ring-flagged
      are tracked), used to detect a REPEATED pattern within a single pair.
    """
    raw_count: dict[tuple[str, str], int] = defaultdict(int)
    for edge in edges:
        if edge.src in ring_members and edge.dst in ring_members:
            raw_count[(edge.src, edge.dst)] += _raw_event_count(edge)
    partners: dict[str, set[str]] = defaultdict(set)
    for src, dst in raw_count:
        if raw_count[(src, dst)] > 0 and raw_count.get((dst, src), 0) > 0:
            partners[src].add(dst)
            partners[dst].add(src)
    return {account: frozenset(others) for account, others in partners.items()}, dict(raw_count)



def _engagement_by_pair(
    edges: Sequence[EngagementEdge],
    weights: RealGraphWeights,
    now: datetime,
    lineage: Mapping[str, frozenset[str]],
    ring_members: frozenset[str],
    min_ring_self_dealing_events: int,
) -> tuple[
    dict[tuple[str, str], float],
    dict[str, float],
    dict[str, float],
    dict[str, set[str]],
]:
    """Split each directed ``(src, dst)`` edge's time-decayed weight into the
    clean pair weights and the weight thrown away as self-dealing.

    Self-dealing discount (§8.3/§8.5, reuses the vote signal's exclusion
    logic): an edge contributes nothing when ``dst`` is a stake-lineage
    sibling of ``src`` (unconditional — a verified on-chain fact), OR both
    ``src`` and ``dst`` are members of the same detected engagement ring AND
    that ring membership clears a SCALE bar (§8.3 relocated-newcomer-blackout
    fix): the pair sits in an actual multi-party ring (either endpoint has
    more than one distinct ring-flagged partner via :func:`_ring_scale_signals`),
    or both directions of the pair itself clear at least
    ``min_ring_self_dealing_events`` raw interaction events (a repeated
    pattern with just that one partner). Below both bars, a ring-flagged
    pair's engagement is ordinary and unproven — indistinguishable from two
    brand-new accounts who mutually engaged once, which is exactly the
    onboarding case the old unconditional rule blacked out — and is counted
    like any other engagement instead of thrown away.

    Returns ``(pair_weight, discounted_received, outside_received)``. The
    second mapping — how much self-dealt engagement each account RECEIVED — is
    what distinguishes an account we have caught farming itself from one we
    simply know nothing about yet (see :func:`_normalize_scores`); without it
    both look identical from the clean weights alone, and conflating them is
    what blacked out newcomers who engage others before they post.

    The third mapping (H02) — how much engagement each account received from
    OUTSIDE its own ring — is the discriminator the vouched tier gates on
    (:func:`recsys.pipeline._voter_trust`). It counts a non-self-dealt edge
    toward the RECEIVER only when the edge is NOT an intra-ring pair
    (``ring_flagged``, scale-INDEPENDENT): the below-scale newcomer-carve-out
    edges survive as ``pair_weight`` (correct — they are not proven
    self-dealing) yet are excluded HERE, so a laundered reciprocal pair accrues
    zero ``outside_received`` and stays unknown-tier while one genuine non-ring
    engager flips it. Lineage edges never reach this branch (already
    ``self_dealt``), so they are excluded for free. This feeds ONLY the
    ``outside_engaged`` flag; scores are computed from ``pair_weight`` /
    ``discounted_received`` exactly as before and are unchanged.
    """
    partners, raw_count = _ring_scale_signals(edges, ring_members)
    pair_weight: dict[tuple[str, str], float] = {}
    discounted_received: dict[str, float] = {}
    outside_received: dict[str, float] = {}
    outside_engagers: dict[str, set[str]] = {}
    for edge in edges:
        weight = edge_weight(edge, weights, now)
        lineage_dealt = edge.dst in lineage.get(edge.src, frozenset())
        ring_flagged = edge.src in ring_members and edge.dst in ring_members
        breadth = (
            len(partners.get(edge.src, frozenset())) > 1
            or len(partners.get(edge.dst, frozenset())) > 1
        )
        repeated = (
            raw_count.get((edge.src, edge.dst), 0) >= min_ring_self_dealing_events
            and raw_count.get((edge.dst, edge.src), 0) >= min_ring_self_dealing_events
        )
        # ⚠ RIVAL SUPPRESSION IS A KNOWN, OPEN ISSUE HERE — see
        # tests/test_rival_suppression.py. Breadth alone condemns, and a
        # STRANGER can manufacture breadth: two socks comment on a newcomer's
        # post, the newcomer replies to both as anyone would, and those two
        # reciprocal edges floor their graph-cred (measured: 0.0000 vs 0.5286
        # with one sock). Only authors with no audience yet are exposed — one
        # genuine outside engager protects them — i.e. exactly cold start.
        #
        # A shape-based fix was tried on 2026-08-01 and REVERTED: requiring the
        # condemned account to sit in a closed triangle protected the victim but
        # released every triangle-free ring — measured, an even cycle of 6 and a
        # complete bipartite K5,5 both went from fully condemned to 0 condemned,
        # while the q4 panel could not see it because its ring is clique-shaped.
        # It was also bypassable by giving each sock a disjoint triangle,
        # amortizing to 0.3 accounts per victim — cheaper than the attack it
        # closed. A victim and a small genuine ring are locally isomorphic in the
        # 1-hop neighbourhood, so no predicate over `partners` separates them.
        # Fixing this needs a different mechanism (initiation order, or the
        # victim's own history), not another shape test. Do not re-attempt with
        # a neighbourhood predicate.
        ring_at_scale = ring_flagged and (breadth or repeated)
        self_dealt = lineage_dealt or ring_at_scale
        if self_dealt:
            discounted_received[edge.dst] = discounted_received.get(edge.dst, 0.0) + weight
            continue
        key = (edge.src, edge.dst)
        pair_weight[key] = pair_weight.get(key, 0.0) + weight
        if weight > 0.0 and not ring_flagged:
            outside_received[edge.dst] = outside_received.get(edge.dst, 0.0) + weight
            # ★ WHO engaged, not just how much (2026-08-01). The scalar total
            # cannot answer "was any of this from an account that is itself
            # vouched", which is what seed-anchored vouch propagation needs to
            # stop a directed sock cycle from vouching itself.
            outside_engagers.setdefault(edge.dst, set()).add(edge.src)
    return pair_weight, discounted_received, outside_received, outside_engagers


def _teleport_vector(
    nodes: Sequence[str],
    trusted_seeds: frozenset[str],
    damping: float,
    seed_teleport_share: float,
) -> np.ndarray:
    """Per-node teleport probability mass (§8.3, TrustRank/EigenTrust).

    ``seed_teleport_share`` of the ``(1 - damping)`` teleport mass is spread
    uniformly over ``trusted_seeds``; the remainder is spread uniformly over
    every node. Empty ``trusted_seeds`` falls back to fully uniform teleport
    (``(1 - damping) / n`` for every node) regardless of
    ``seed_teleport_share``.
    """
    n = len(nodes)
    total_mass = 1.0 - damping
    uniform_share = total_mass / n
    if not trusted_seeds:
        return np.full(n, uniform_share, dtype=np.float64)
    seed_mass_each = (total_mass * seed_teleport_share) / len(trusted_seeds)
    remainder_share = (total_mass * (1.0 - seed_teleport_share)) / n
    return np.array(
        [
            remainder_share + (seed_mass_each if node in trusted_seeds else 0.0)
            for node in nodes
        ],
        dtype=np.float64,
    )


def _weighted_pagerank(
    nodes: Sequence[str],
    follows: Mapping[str, frozenset[str]],
    pair_weight: Mapping[tuple[str, str], float],
    damping: float,
    iterations: int,
    trusted_seeds: frozenset[str],
    seed_teleport_share: float,
) -> dict[str, float]:
    """Power-iteration PageRank over the follow graph, each edge weighted by
    its engagement and teleport optionally seeded toward ``trusted_seeds``
    (§8.3). Returns the raw (non-normalized) rank per node; an all-zero
    adjacency (no engagement anywhere) ⇒ every rank ``0.0``."""
    n = len(nodes)
    index = {account: i for i, account in enumerate(nodes)}
    # Phase-0 dense adjacency: fine as a weekly batch job at prototype scale.
    # At Hive's real account count move to scipy.sparse / igraph (§8.3).
    adjacency = np.zeros((n, n), dtype=np.float64)
    for follower, followees in follows.items():
        i = index[follower]
        for followee in followees:
            adjacency[i, index[followee]] = pair_weight.get((follower, followee), 0.0)

    if not adjacency.any():
        return dict.fromkeys(nodes, 0.0)

    out_weight = adjacency.sum(axis=1)
    dangling = out_weight == 0.0
    safe_out_weight = np.where(dangling, 1.0, out_weight)
    transition = np.where(dangling[:, None], 0.0, adjacency / safe_out_weight[:, None])

    teleport = _teleport_vector(nodes, trusted_seeds, damping, seed_teleport_share)
    rank = np.full(n, 1.0 / n, dtype=np.float64)
    for _ in range(iterations):
        dangling_mass = damping * rank[dangling].sum() / n
        rank = teleport + dangling_mass + damping * (rank @ transition)

    return dict(zip(nodes, rank.tolist(), strict=True))


def _ratio_prior(ratio: float) -> float:
    """Follow/follower-ratio prior multiplier (§8.3): divides down accounts
    that follow far more than follow them back, applied before normalization.
    ``ratio <= 1`` ⇒ no discount (multiplier 1.0); ``ratio == 2`` ⇒ multiplier
    0.5."""
    return 1.0 / (1.0 + max(0.0, ratio - 1.0))


def _received_engagement(
    nodes: Sequence[str], pair_weight: Mapping[tuple[str, str], float]
) -> dict[str, float]:
    """Total engagement weight each account has RECEIVED (§8.3), after the
    self-dealing discount already applied by :func:`_engagement_by_pair`.

    Absolute: independent of the population size and of every other account's
    rank — which is precisely what a percentile is not. ``0.0`` means nobody
    outside the account's own ring/lineage has ever engaged it, which is
    equally true of a Sybil and of an account that joined yesterday;
    :func:`_normalize_scores` tells the two apart by whether any *discounted*
    engagement was received.

    Counted over the engagement edges themselves rather than the
    follow-restricted PageRank topology: an upvote from someone who does not
    follow you is still somebody engaging you, and requiring the voucher to
    also be a follower would wall out every author whose audience is lurkers.
    """
    received = dict.fromkeys(nodes, 0.0)
    for (_src, dst), weight in pair_weight.items():
        if weight > 0.0 and dst in received:
            received[dst] += weight
    return received


def _normalize_scores(
    nodes: Sequence[str],
    raw: Mapping[str, float],
    ratios: Mapping[str, float],
    received: Mapping[str, float],
    discounted: Mapping[str, float],
    min_vouched_score: float,
) -> dict[str, float]:
    """Apply the follow/follower-ratio prior, then place every account in one of
    the three bands of the module docstring (§4, §8.3).

    The band test is on EVIDENCE, not on emptiness:

    * ``received == 0`` **and** ``discounted > 0`` ⇒ ``0.0``. Everything this
      account ever received came from its own lineage/ring and was zeroed —
      that is a caught self-dealer, and the only thing a floor may fail.
    * ``received == 0`` **and** ``discounted == 0`` ⇒ ``min_vouched_score``.
      Nobody has engaged this account at all: unknown, not bad. Scoring this
      state ``0.0`` is the defect this band exists to prevent — it blacked out
      the newcomer who upvotes and comments *before* posting (they are in the
      snapshot at 0.0 and fail the author floor) while the newcomer who posts
      first is absent from the snapshot and fails open, i.e. it punished
      exactly the newcomer who participates, and it disqualified every pure
      consumer from ever vouching for a stranger.
    * ``received > 0`` ⇒ percentile-ranked among the engaged population only
      and mapped into ``(min_vouched_score, 1]``. Unknown accounts are kept
      out of that sample so they cannot compress the engaged band upward
      (:func:`percentile_rank` is strictly positive, so every engaged account
      lands strictly above the unknown band).

    An all-zero ``raw`` (no adjacency/engagement anywhere) leaves the engaged
    band empty rather than percentile-ranking a uniformly empty signal: nobody
    is inflated to the 100th percentile, and nobody is condemned for it either
    — every non-self-dealing account is simply unknown.
    """
    priored = {account: raw[account] * _ratio_prior(ratios[account]) for account in nodes}
    engaged = (
        [account for account in nodes if received.get(account, 0.0) > 0.0]
        if any(raw.values())
        else []
    )
    sorted_priored = sorted(priored[account] for account in engaged)
    span = 1.0 - min_vouched_score
    engaged_set = frozenset(engaged)
    scores: dict[str, float] = {}
    for account in nodes:
        if account in engaged_set:
            scores[account] = min_vouched_score + span * percentile_rank(
                priored[account], sorted_priored
            )
        elif received.get(account, 0.0) <= 0.0 and discounted.get(account, 0.0) > 0.0:
            scores[account] = 0.0
        else:
            scores[account] = min_vouched_score
    return scores
