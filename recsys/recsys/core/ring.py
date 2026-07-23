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


def _account_totals(pair_weight: Mapping[tuple[str, str], float]) -> dict[str, float]:
    """Total engagement volume (sent + received, every partner) touching each
    account — the denominator ``ring_score`` measures insularity against."""
    totals: dict[str, float] = defaultdict(float)
    for (src, dst), w in pair_weight.items():
        if w <= 0.0:
            continue
        totals[src] += w
        totals[dst] += w
    return totals


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


def detect_rings(
    edges: Sequence[EngagementEdge],
    weights: RealGraphWeights,
    *,
    now: datetime | None = None,
    reciprocity_min: float = 0.5,
    min_group: int = 2,
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

    totals = _account_totals(pair_weight)
    adjacency = _reciprocal_adjacency(pair_weight, reciprocity_min)
    groups = [group for group in _connected_groups(adjacency) if len(group) >= min_group]

    signals: dict[str, RingSignal] = {}
    for ring_id, group in enumerate(groups):
        group_set = set(group)
        for account in group:
            total = totals.get(account, 0.0)
            if total <= 0.0:
                score = 0.0
            else:
                reciprocated = 0.0
                for other in group_set:
                    if other == account:
                        continue
                    w_out = pair_weight.get((account, other), 0.0)
                    w_in = pair_weight.get((other, account), 0.0)
                    if w_out <= 0.0 or w_in <= 0.0:
                        continue
                    ratio = min(w_out, w_in) / max(w_out, w_in)
                    reciprocated += ratio * (w_out + w_in)
                score = min(1.0, reciprocated / total)
            signals[account] = RingSignal(account=account, ring_score=score, ring_id=ring_id)
    return signals


def ring_member_set(signals: Mapping[str, RingSignal], threshold: float) -> frozenset[str]:
    """Accounts whose ``ring_score`` clears ``threshold`` (§8.5 — e.g. against
    :attr:`recsys.config.Thresholds.ring_discount_threshold`)."""
    return frozenset(
        account for account, signal in signals.items() if signal.ring_score >= threshold
    )


__all__ = ["detect_rings", "ring_member_set"]
