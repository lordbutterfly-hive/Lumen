"""Basic vote-ring detection (§8.5): reciprocity + insularity.

Phase-0 scope only — temporal synchrony (burst-timing correlation across a
group) is deferred to Phase-1 per the build plan. This module builds the
directed, weighted RealGraph engagement graph (the same weighted-sum-of-
features formula :func:`recsys.core.graph_cred.edge_weight` uses —
reimplemented locally per FIX-F so this detector doesn't import
``graph_cred``; keep the two formulas in sync) and scores each account on how
MUTUAL and INSULAR its engagement is:

* **Mutual** — for a pair ``(A, B)``, the reciprocity ratio is
  ``min(w(A->B), w(B->A)) / max(w(A->B), w(B->A))``, in ``[0, 1]``. Only pairs
  clearing ``reciprocity_min`` in both directions count as a "ring edge".
* **Insular** — connected components over ring edges are candidate ring
  groups (size >= ``min_group``). An account's ``ring_score`` is the
  reciprocity-weighted fraction of its *total* engagement volume (sent +
  received, to every partner, in or out of the group) that falls inside its
  group. An account whose entire footprint is a perfectly-reciprocated pair
  scores 1.0; a busy honest account whose reciprocal partners are a small
  slice of a much larger footprint scores near 0.0; an account with no
  qualifying ring edge at all never joins a group and is simply absent from
  the result (not explicitly scored 0.0 — it was never "involved", §8.5).

Soft scores only — §8.5 says "never a hard ban". Callers apply a threshold
(e.g. :attr:`recsys.config.Thresholds.ring_discount_threshold`) downstream via
:func:`ring_member_set`.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime

from recsys.config import RealGraphWeights
from recsys.contracts import EngagementEdge, RingSignal


def _edge_weight(edge: EngagementEdge, weights: RealGraphWeights, now: datetime) -> float:
    """Same weighted-sum-of-features + time-decay formula as
    ``recsys.core.graph_cred.edge_weight`` (§8.3), reimplemented here per
    FIX-F to keep this module's dependency surface independent of the
    PageRank module. Always non-negative."""
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


def _pair_weight(
    edges: Sequence[EngagementEdge], weights: RealGraphWeights, now: datetime
) -> dict[tuple[str, str], float]:
    """Total time-decayed weight per directed ``(src, dst)`` pair. Self-loops
    (malformed ``src == dst`` edges) are dropped — they carry no ring signal."""
    pair_weight: dict[tuple[str, str], float] = {}
    for edge in edges:
        if edge.src == edge.dst:
            continue
        key = (edge.src, edge.dst)
        pair_weight[key] = pair_weight.get(key, 0.0) + _edge_weight(edge, weights, now)
    return pair_weight


def _received_totals(
    pair_weight: Mapping[tuple[str, str], float],
    ignore_sources: frozenset[str] = frozenset(),
) -> dict[str, float]:
    """Total engagement volume each account RECEIVED, from every partner.

    ★ RECEIVED, NOT sent+received (2026-08-03) — this is the insularity
    denominator's outside term, and the change closes a live bypass.

    THE BYPASS. ``ring_score`` is inside-volume / total-volume, and the old
    denominator counted every edge touching the account in BOTH directions. So
    an account diluted its own score by SPENDING engagement outward — free,
    unlimited, entirely attacker-controlled, and indistinguishable from ordinary
    activity. Measured on a dense 4-sock reciprocal ring: ~20 one-way upvotes
    per sock aimed at one popular honest account took ``ring_score`` from 1.0000
    to 0.4737, under the 0.6 discount threshold, and the socks' graph-cred went
    from 0.0000 (condemned, self-dealing fully discounted) to **1.0000**. Four
    accounts, twenty free upvotes each, whole detector defeated.

    WHY RECEIVED IS THE RIGHT DENOMINATOR. Inbound engagement is evidence that
    somebody outside chose you; outbound engagement is evidence of nothing,
    because you chose it yourself and it costs an upvote. An insularity measure
    must not be buyable with the very resource the attacker has in surplus.
    After the change the same ring holds ``ring_score`` 1.0000 at 12, 20, 41,
    100 and even 1000 noise upvotes per sock — the dilution vector is gone, not
    merely raised in price.

    MEASURED COST, honestly: dropping outside-SENT shrinks the denominator for
    accounts that send much and receive little, so a few more accounts cross the
    threshold. Across seeds 7/11/23/42 that is **4 newly-flagged accounts out of
    579** that land in any group at all (0.7%) — profile 19-20 outgoing edges
    against 1 incoming, and 3 of the 4 are viewers with ZERO posts (so there is
    no content of theirs to suppress; the cost is that their votes are
    discounted on flagged authors' posts). See ``ring_score``'s note in
    :func:`detect_rings` for the residual attack this does NOT close.

    ``ignore_sources`` names accounts whose outbound engagement must not be
    credited to the receiver at all — the two-pass discount in
    :func:`detect_rings`.
    """
    received: dict[str, float] = defaultdict(float)
    for (src, dst), w in pair_weight.items():
        if w <= 0.0 or src in ignore_sources:
            continue
        received[dst] += w
    return received


def _reciprocal_adjacency(
    pair_weight: Mapping[tuple[str, str], float], reciprocity_min: float
) -> dict[str, set[str]]:
    """Undirected adjacency over pairs whose engagement is mutual (both
    directions > 0) and balanced enough (``min/max >= reciprocity_min``) to
    count as a ring edge."""
    adjacency: dict[str, set[str]] = defaultdict(set)
    seen: set[frozenset[str]] = set()
    for (a, b), w_ab in pair_weight.items():
        pair_key = frozenset((a, b))
        if pair_key in seen:
            continue
        seen.add(pair_key)
        w_ba = pair_weight.get((b, a), 0.0)
        if w_ab <= 0.0 or w_ba <= 0.0:
            continue
        ratio = min(w_ab, w_ba) / max(w_ab, w_ba)
        if ratio >= reciprocity_min:
            adjacency[a].add(b)
            adjacency[b].add(a)
    return adjacency


def _connected_groups(adjacency: Mapping[str, set[str]]) -> list[list[str]]:
    """Connected components over the reciprocal-edge graph, in deterministic
    (sorted-node) traversal order — both which node starts each component and
    the order components are discovered are stable across runs."""
    visited: set[str] = set()
    groups: list[list[str]] = []
    for start in sorted(adjacency):
        if start in visited:
            continue
        visited.add(start)
        component = [start]
        stack = [start]
        while stack:
            node = stack.pop()
            for neighbor in sorted(adjacency[node]):
                if neighbor not in visited:
                    visited.add(neighbor)
                    component.append(neighbor)
                    stack.append(neighbor)
        groups.append(sorted(component))
    return groups


def _score_groups(
    groups: Sequence[Sequence[str]],
    pair_weight: Mapping[tuple[str, str], float],
    *,
    ignore_sources: frozenset[str],
) -> dict[str, RingSignal]:
    """Score every account in every group. ``ignore_sources`` names accounts
    whose OUTBOUND engagement must not count as outside evidence for the
    receiver — see the two-pass note in :func:`detect_rings`."""
    # Single source of truth for the received-only denominator — do NOT inline
    # this again; a hand-duplicated copy here went undetected once already.
    received = _received_totals(pair_weight, ignore_sources)

    signals: dict[str, RingSignal] = {}
    for ring_id, group in enumerate(groups):
        group_set = set(group)
        for account in group:
            reciprocated = 0.0
            inside = 0.0
            inside_credited_in = 0.0
            for other in group_set:
                if other == account:
                    continue
                w_out = pair_weight.get((account, other), 0.0)
                w_in = pair_weight.get((other, account), 0.0)
                inside += w_out + w_in
                if w_in > 0.0 and other not in ignore_sources:
                    inside_credited_in += w_in
                if w_out <= 0.0 or w_in <= 0.0:
                    continue
                ratio = min(w_out, w_in) / max(w_out, w_in)
                reciprocated += ratio * (w_out + w_in)
            # Denominator = the group's own volume (both directions, since the
            # numerator counts both) + engagement received from OUTSIDE it.
            # Outbound engagement to outsiders is deliberately absent — see
            # `_received_totals` for the bypass that including it opened.
            outside_received = max(0.0, received.get(account, 0.0) - inside_credited_in)
            total = inside + outside_received
            score = min(1.0, reciprocated / total) if total > 0.0 else 0.0
            signals[account] = RingSignal(account=account, ring_score=score, ring_id=ring_id)
    return signals


def detect_rings(
    edges: Sequence[EngagementEdge],
    weights: RealGraphWeights,
    *,
    now: datetime | None = None,
    reciprocity_min: float = 0.5,
    min_group: int = 2,
    self_credit_threshold: float = 0.6,
) -> dict[str, RingSignal]:
    """Basic reciprocity + insularity ring detector (§8.5).

    Builds the directed weighted engagement graph, links accounts whose
    pairwise engagement is mutual and balanced (ratio >= ``reciprocity_min``)
    into ring edges, and takes connected components of size >= ``min_group``
    as candidate ring groups. Every account in a qualifying group gets a
    ``ring_score`` in ``[0, 1]`` (see module docstring for the formula) and a
    shared ``ring_id`` per group. Accounts that never clear a reciprocal edge
    with anyone — a one-directional superfan, an honest hub with only diverse
    inbound engagement — never join a group and are absent from the result.

    Deterministic: component discovery and ``ring_id`` assignment both
    iterate accounts in sorted order. Empty ``edges`` (or no pair ever mutual
    enough) ⇒ ``{}``. ``now`` defaults to the current time (injectable for
    deterministic runs/tests, same convention as ``compute_graph_cred``).
    """
    resolved_now = now if now is not None else datetime.now(UTC)
    pair_weight = _pair_weight(edges, weights, resolved_now)
    if not pair_weight:
        return {}

    adjacency = _reciprocal_adjacency(pair_weight, reciprocity_min)
    groups = [group for group in _connected_groups(adjacency) if len(group) >= min_group]

    # ★ TWO PASSES (2026-08-03). Pass 1 scores insularity with every outside
    # engager counted. Pass 2 rescores, ignoring engagement received FROM an
    # account pass 1 already flagged.
    #
    # WHY. With sending no longer able to dilute (see `_received_totals`), the
    # only remaining way to inflate a denominator is to RECEIVE from outside —
    # and an attacker can supply that themselves. Measured: a second, sacrificial
    # ring B one-way engaging ring A cleaned A at just 5 upvotes each while B
    # stayed condemned, so the attacker bought clean identities at 2x accounts.
    # Discarding credit from flagged sources closes it: A holds ring_score
    # 1.0000 at 5, 20, 100 and 1000 upvotes each.
    #
    # PRECEDENT: `graph_cred.py` already refuses to count a ring-flagged source
    # toward `outside_received` (`if weight > 0.0 and not ring_flagged`). This is
    # the same rule applied one layer earlier, at the place the score is formed.
    #
    # COST, measured across seeds 7/11/23/42: ONE additional account flagged out
    # of 579 that land in any group. Deterministic, because pass 1 is.
    #
    # ★★ KNOWN-OPEN, DO NOT READ THIS AS "DILUTION IS CLOSED" (2026-08-03).
    # Pass 1 can only flag an account that landed in a RECIPROCAL group, so a
    # one-way PUPPET — an account that sprays engagement into the ring and never
    # reciprocates — never joins a group, never gets flagged, and its credit is
    # therefore never discounted here. Measured on the dense 4-sock ring: ONE
    # puppet sending 13 upvotes to each sock drops all four to 0.5806 and the
    # entire ring escapes (0/4 flagged). What the two changes above actually
    # bought is a cost increase, not a closure: outward spraying (0 extra
    # accounts) and the sacrificial reciprocal ring (~2x accounts) are dead;
    # the one-way puppet (1 extra account) is not.
    # Pinned by tests/test_ring.py::test_KNOWN_OPEN_one_way_puppet_dilutes_a_ring.
    #
    # The candidate fix is to weight each outside engager's credit by how
    # CONCENTRATED its engagement is on this group — an engager whose entire
    # footprint points at one group is not independent evidence of anything.
    # NOT applied here because it collides with a documented intended behaviour:
    # `test_honest_hub_with_one_reciprocal_edge_still_scores_low` builds fans
    # whose only engagement IS the hub, so concentration cannot separate them
    # from puppets on that fixture. Needs a decision about which of the two the
    # metric is really for, on real-graph evidence rather than a synthetic star.
    first = _score_groups(groups, pair_weight, ignore_sources=frozenset())
    flagged = frozenset(
        account for account, signal in first.items() if signal.ring_score >= self_credit_threshold
    )
    if not flagged:
        return first
    return _score_groups(groups, pair_weight, ignore_sources=flagged)


def ring_member_set(signals: Mapping[str, RingSignal], threshold: float) -> frozenset[str]:
    """Accounts whose ``ring_score`` clears ``threshold`` (§8.5 — e.g. against
    :attr:`recsys.config.Thresholds.ring_discount_threshold`)."""
    return frozenset(
        account for account, signal in signals.items() if signal.ring_score >= threshold
    )


__all__ = ["detect_rings", "ring_member_set"]
