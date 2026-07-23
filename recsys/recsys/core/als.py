"""Implicit-feedback ALS (§6.1) — the collaborative-filtering slice of the
80% organic bucket.

Factorizes the *viewer x author* engagement matrix (Hu, Koren & Volinsky,
"Collaborative Filtering for Implicit Feedback Datasets", ICDM 2008) so an
established viewer's affinity toward an author they have never personally
engaged can still be estimated from co-engagement patterns shared with other
viewers. This solves *content/graph* cold-start for viewers who already have
some history; it does not solve *behavioral* cold-start for a brand-new
viewer with none (§6.1 — those fall back to in-network + community-popular).

Phase-0 prototype scale: dense per-row ridge solves in pure numpy, the same
posture ``graph_cred`` takes for its adjacency matrix. Move to a sparse/ALS
library (e.g. ``implicit``) if the viewer x author matrix grows past a
nightly-batch-job budget.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np

from recsys.config import ALSConfig
from recsys.contracts import EngagementEdge
from recsys.core.vote_signal import VoterTrust

# Mirrors RealGraphWeights.half_life_days's default (recsys.config) — the
# fallback ONLY for a caller that passes `now` without `half_life_days`.
# Production always threads the live value explicitly (see
# recsys.pipeline.build_trust_snapshot), so this default never drifts from
# the config default silently affecting a real ranking.
_DEFAULT_HALF_LIFE_DAYS = 30.0


@dataclass(frozen=True)
class ALSModel:
    """Learned viewer x author latent factors (§6.1).

    ``user_factors`` / ``item_factors`` are row-aligned with ``user_index`` /
    ``item_index`` (account name -> row index). "Item" here means *author*,
    per §6.1's user x author factorization (the user x community
    factorization is a separate model built the same way over a different
    edge projection).
    """

    user_factors: np.ndarray  # (n_users, k)
    item_factors: np.ndarray  # (n_items, k)
    user_index: dict[str, int]
    item_index: dict[str, int]

    def affinity(self, user: str, item: str) -> float:
        """Predicted viewer -> author affinity: ``dot(user_vec, item_vec)``.

        ``0.0`` for a user or item absent from this training run's index
        (cold) -- never extrapolate a score for an account ALS has no factors
        for.
        """
        u = self.user_index.get(user)
        i = self.item_index.get(item)
        if u is None or i is None:
            return 0.0
        return float(np.dot(self.user_factors[u], self.item_factors[i]))


def viewer_affinity_percentiles(
    model: ALSModel, viewer: str, authors: Iterable[str]
) -> dict[str, float] | None:
    """Per-viewer joint normalization of CF affinity (§6.1 re-plumb, 2026-07-21).

    For each requested author, the percentile of ``affinity(viewer, author)``
    within the viewer's OWN affinity distribution over ALL trained authors
    (the model's full item index). This replaces the retired additive raw
    bump (``organic_raw + cf_weight * affinity``), which died at the global
    percentile step: the §4 norm sample is built viewer-independent at cf=0,
    so the bump pushed 68/113 pool posts past the sample max and clipped them
    at organic = 1.0, erasing every above-median CF distinction exactly where
    the model is informative (graded same-topic generalization on unengaged
    pairs, quality-AUC 0.805). A percentile within the viewer's own
    distribution cannot clip, and — because the reference set is the model's
    full item index, never the candidate pool — pool censorship cannot
    reshape it.

    Returns ``None`` when the viewer has no trained factors (behavioral
    cold-start, or an empty model): the caller must drop the CF slice for the
    whole request rather than blend an uninformative constant. Authors absent
    from the item index score a neutral 0.5 — unknown is not the same state
    as bad (the same doctrine as ``GraphCredConfig.min_vouched_score``), so a
    brand-new author is neither boosted nor buried by a model that has never
    seen them.
    """
    u = model.user_index.get(viewer)
    if u is None or not model.item_index:
        return None
    affinities = model.item_factors @ model.user_factors[u]
    sorted_affinities = np.sort(affinities)
    n = len(sorted_affinities)
    out: dict[str, float] = {}
    for author in authors:
        i = model.item_index.get(author)
        if i is None:
            out[author] = 0.5
        else:
            # bisect_right semantics — consistent with normalize.percentile_rank
            rank = int(np.searchsorted(sorted_affinities, affinities[i], side="right"))
            out[author] = rank / n
    return out


def _edge_decay(edge: EngagementEdge, now: datetime, half_life_days: float) -> float:
    """Time-decay factor for one edge's ``r_ui`` contribution (H12).

    Identical formula and semantics to ``graph_cred.edge_weight`` /
    ``ring._edge_weight``: ``0.5 ** (age_days / half_life_days)`` where
    ``age_days`` is the age of ``edge.last_interaction`` relative to ``now``
    (``None`` -> no decay, future timestamps clamp to age 0). Kept as its own
    function rather than importing ``graph_cred.edge_weight`` because that
    function ALSO applies ``RealGraphWeights``' per-feature weights (reply=5,
    upvote=1, ...) — a weighting ``r_ui`` deliberately does NOT use (see the
    docstring below); only the decay half needs to be shared.
    """
    if edge.last_interaction is None:
        return 1.0
    age_days = max((now - edge.last_interaction).days, 0)
    return 0.5 ** (age_days / half_life_days)


def _budget_unknown_breadth(
    raw: dict[tuple[str, str], float], trust: VoterTrust
) -> dict[tuple[str, str], float]:
    """Per-author (item) breadth budget on the CF rating set (C1/C2, funded-alt
    hardening 2026-07-22), mirroring
    :meth:`recsys.core.vote_signal.VoterTrust.credited_breadth`.

    For each author (``dst``/item), the engagers (``src``/users) split into
    vouched (in ``trust.vouched``) and unknown. Vouched engagers ALWAYS count;
    unknown engagers count only up to ``unknown_free + unknown_per_vouched *
    (vouched engager count)`` of them, exactly as the vote signal budgets a
    post's unknown voters. Excess unknown ``(src, author)`` ratings are dropped
    BEFORE training, so a swarm of one-directional ``sock -> author`` edges (the
    C1/C2 vector — a one-directional star forms no reciprocal edge, so it slips
    ring detection, and funding-by-transfer writes no delegation row, so it
    slips lineage) cannot inflate that author's item factor and poison a
    targeted viewer's CF percentile: with zero vouched engagers the author's
    unknown budget is exactly ``unknown_free``, so more socks buy nothing.

    Deterministic: unknown engagers are admitted highest-``r_ui`` first, ties
    broken by ``src`` name, so the surviving rating set never depends on edge or
    dict iteration order. The newcomer invariant holds in CF too —
    ``unknown_free >= 1`` keeps at least one genuine newcomer's engagement in
    the matrix for every author. ``trust=None`` (the norm-sample / test path)
    never calls this and leaves the matrix byte-identical to pre-hardening.
    """
    by_item: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for (src, dst), volume in raw.items():
        by_item[dst].append((src, volume))
    budgeted: dict[tuple[str, str], float] = {}
    for dst, engagers in by_item.items():
        vouched = [(s, v) for s, v in engagers if s in trust.vouched]
        unknown = [(s, v) for s, v in engagers if s not in trust.vouched]
        for s, v in vouched:
            budgeted[(s, dst)] = v
        cap = int(trust.unknown_free + trust.unknown_per_vouched * len(vouched))
        if cap > 0 and unknown:
            unknown.sort(key=lambda sv: (-sv[1], sv[0]))
            for s, v in unknown[:cap]:
                budgeted[(s, dst)] = v
    return budgeted


def _interaction_matrix(
    edges: Sequence[EngagementEdge],
    ring_members: frozenset[str],
    lineage: Mapping[str, frozenset[str]],
    *,
    now: datetime | None = None,
    half_life_days: float = _DEFAULT_HALF_LIFE_DAYS,
    trust: VoterTrust | None = None,
) -> tuple[dict[str, int], dict[str, int], dict[tuple[int, int], float]]:
    """Collapse edges into ``(user_index, item_index, {(u, i): r_ui})``.

    Self-dealing edges are excluded first (§8.4/§8.5), mirroring
    ``graph_cred._engagement_by_pair``: an edge contributes nothing when the
    author (``dst``) is a stake-lineage sibling of the viewer (``src``), or both
    are members of the same detected ring — so a collusion ring cannot launder
    co-engagement into CF affinity.

    ``r_ui`` (§6.1) is the raw interaction volume -- ``replies +
    reply_backs + reblogs + upvotes`` -- summed over every edge for a given
    ordered ``(viewer, author)`` pair. The Phase-1 telemetry fields
    (``mentions``, ``profile_visits``, ``post_opens``, ``revisits``,
    ``dwell_seconds``) are ignored here, same as their 0.0 weight in
    :class:`~recsys.config.RealGraphWeights` -- unauthenticated signals stay
    out of both the trust graph and the CF matrix until they're gated
    (§8.9). Pairs whose summed ``r_ui`` is ``<= 0`` are skipped entirely, so
    they never enter the sparse rating set (and thus never allocate a row or
    column).

    H12 (2026-07-22): each edge's contribution is now time-decayed by
    :func:`_edge_decay` -- the SAME ``0.5 ** (age_days / half_life_days)``
    formula ``graph_cred``/``ring`` already apply to every OTHER RealGraph
    consumer, resolved against ``now`` (wall-clock if omitted, matching
    ``compute_graph_cred``/``detect_rings``'s own ``now is None`` fallback so
    all three RealGraph consumers agree on "now" for a given batch run). Before
    this fix a co-engagement pair from a year ago counted exactly as much as
    one from yesterday, so a stale CF affinity — including one built from
    since-abandoned sock co-engagement — never faded from the trained model
    the way graph-cred and ring detection already fade theirs. ``now=None``
    (every pre-H12 call site and every edge with no ``last_interaction``)
    reproduces the undecayed pre-fix sum exactly: :func:`_edge_decay` returns
    ``1.0`` whenever ``edge.last_interaction`` is ``None``, so a synthetic test
    edge built without it is untouched regardless of what ``now`` resolves to.

    C1/C2 (2026-07-22): when ``trust`` is supplied, the decayed rating set is
    passed through :func:`_budget_unknown_breadth` before indexing — a
    per-author graph-cred breadth budget mirroring the vote/organic signals, so
    unknown-tier one-directional sock co-engagement cannot inflate an author's
    item factor. ``trust=None`` (every pre-C1 call site, the §4 norm-sample
    path, and every unit test that does not build a snapshot) leaves the rating
    set exactly as the decay step produced it.
    """
    resolved_now = now if now is not None else datetime.now(UTC)
    raw: dict[tuple[str, str], float] = {}
    for edge in edges:
        if edge.dst in lineage.get(edge.src, frozenset()):
            continue
        if edge.src in ring_members and edge.dst in ring_members:
            continue
        key = (edge.src, edge.dst)
        volume = edge.replies + edge.reply_backs + edge.reblogs + edge.upvotes
        decay = _edge_decay(edge, resolved_now, half_life_days)
        raw[key] = raw.get(key, 0.0) + volume * decay

    # C1/C2: graph-cred breadth budget on the CF rating set, BEFORE indexing —
    # the same VoterTrust budget the vote/organic signals apply, mirrored here
    # so unknown-tier one-directional co-engagement (which slips ring + lineage)
    # cannot buy unbounded CF item-factor mass. ``None`` leaves the matrix
    # byte-identical to the pre-hardening / norm-sample path.
    if trust is not None:
        raw = _budget_unknown_breadth(raw, trust)

    user_index: dict[str, int] = {}
    item_index: dict[str, int] = {}
    ratings: dict[tuple[int, int], float] = {}
    # Sorted so row/column index assignment (and thus the RNG draw) is canonical
    # regardless of edge order — reproducible across gateway/backend swaps.
    for (src, dst), r_ui in sorted(raw.items()):
        if r_ui <= 0:
            continue
        u = user_index.setdefault(src, len(user_index))
        i = item_index.setdefault(dst, len(item_index))
        ratings[(u, i)] = r_ui
    return user_index, item_index, ratings


def train_als(
    edges: Sequence[EngagementEdge],
    config: ALSConfig,
    *,
    ring_members: frozenset[str] = frozenset(),
    lineage: Mapping[str, frozenset[str]] | None = None,
    now: datetime | None = None,
    half_life_days: float = _DEFAULT_HALF_LIFE_DAYS,
    trust: VoterTrust | None = None,
) -> ALSModel:
    """Fit implicit-feedback ALS on the viewer x author engagement matrix
    (§6.1, Hu/Koren/Volinsky 2008).

    Confidence ``c_ui = 1 + alpha * r_ui`` and preference ``p_ui = 1`` for
    every ``(u, i)`` pair with positive summed ``r_ui`` (see
    :func:`_interaction_matrix`); every unrated pair implicitly has
    ``p_ui = 0`` (and thus ``c_ui - 1 = 0``, contributing nothing beyond the
    shared ``YtY`` term below).

    Alternates ``config.iterations`` times between solving for user factors
    with item factors fixed and vice versa, using the efficient per-row
    ridge solve from Hu/Koren/Volinsky §4:

        ``x_u = (YtY + Yt(Cu - I)Y + reg*I)^-1 * Yt Cu p_u``

    ``YtY`` is precomputed once per alternation and shared across every row;
    because ``p_ui = 0`` off a user's rated items, ``Yt Cu p_u`` reduces to
    ``sum_i c_ui * y_i`` over just the items ``u`` rated, and because
    ``Cu - I`` is zero off those same items, the correction term reduces to
    ``sum_i (c_ui - 1) * y_i y_i^T`` over the same small set -- so each row
    solve costs ``O(rated_items * k^2)``, not ``O(n_items * k^2)``. The item
    solve is the symmetric mirror image (users and items swap roles).

    Factors are initialized from ``np.random.default_rng(config.seed)``, so
    training is deterministic for a fixed ``(edges, config, now, half_life_days)``
    tuple. ``now`` was added for H12 (below) and, left at its default, resolves
    to wall-clock time exactly like ``compute_graph_cred``/``detect_rings`` do
    -- so, as with those two, a real batch run is only bit-reproducible when
    the caller pins ``now`` explicitly; every edge in this module's own unit
    tests has no ``last_interaction`` and is therefore decay-inert regardless
    (see :func:`_edge_decay`), which is why the existing determinism tests are
    unaffected by this addition.

    H12 (2026-07-22): ``r_ui`` is now time-decayed (:func:`_interaction_matrix`,
    :func:`_edge_decay`) with the SAME ``half_life_days`` half-life
    ``graph_cred``/``ring`` already apply to every other RealGraph consumer —
    before this fix, a co-engagement edge from a year ago counted exactly as
    much toward CF affinity as one from yesterday. Production threads
    ``half_life_days=settings.real_graph.half_life_days`` (single source of
    truth: ``recsys.config.RealGraphWeights.half_life_days``) from
    :func:`recsys.pipeline.build_trust_snapshot`; the default here only
    matters for a caller that passes ``now`` without also passing
    ``half_life_days``.

    C1/C2 (2026-07-22): ``trust`` threads the SAME graph-cred breadth budget
    (:class:`~recsys.core.vote_signal.VoterTrust`) the vote/organic signals use
    into the CF matrix, so unknown-tier one-directional sock co-engagement is
    breadth-budgeted BEFORE training rather than buying an author unbounded
    item-factor mass (see :func:`_budget_unknown_breadth`). Production derives
    it once per batch from the freshly-computed graph-cred and threads it here
    (``recsys.pipeline.build_trust_snapshot``); ``None`` (the default, every
    unit test, the norm-sample path) trains on the raw decayed ratings exactly
    as before.

    Empty ``edges``, or edges none of which have positive summed ``r_ui``,
    yield an :class:`ALSModel` with ``(0, config.factors)``-shaped factor
    arrays and empty index maps; :meth:`ALSModel.affinity` on it is always
    ``0.0``.
    """
    user_index, item_index, ratings = _interaction_matrix(
        edges,
        ring_members,
        lineage if lineage is not None else {},
        now=now,
        half_life_days=half_life_days,
        trust=trust,
    )
    k = config.factors

    if not ratings:
        return ALSModel(
            user_factors=np.zeros((0, k), dtype=np.float64),
            item_factors=np.zeros((0, k), dtype=np.float64),
            user_index=user_index,
            item_index=item_index,
        )

    n_users = len(user_index)
    n_items = len(item_index)

    rng = np.random.default_rng(config.seed)
    user_factors = rng.normal(scale=0.01, size=(n_users, k))
    item_factors = rng.normal(scale=0.01, size=(n_items, k))

    # Per-row sparse interaction lists: (column, confidence) pairs, so each
    # ridge solve below only touches the few items/users actually rated.
    by_user: dict[int, list[tuple[int, float]]] = {u: [] for u in range(n_users)}
    by_item: dict[int, list[tuple[int, float]]] = {i: [] for i in range(n_items)}
    for (u, i), r_ui in ratings.items():
        c_ui = 1.0 + config.alpha * r_ui
        by_user[u].append((i, c_ui))
        by_item[i].append((u, c_ui))

    reg_eye = config.regularization * np.eye(k, dtype=np.float64)

    for _ in range(config.iterations):
        user_factors = _solve_factors(item_factors, by_user, n_users, k, reg_eye)
        item_factors = _solve_factors(user_factors, by_item, n_items, k, reg_eye)

    return ALSModel(
        user_factors=user_factors,
        item_factors=item_factors,
        user_index=user_index,
        item_index=item_index,
    )


def _solve_factors(
    fixed: np.ndarray,
    interactions: dict[int, list[tuple[int, float]]],
    n_rows: int,
    k: int,
    reg_eye: np.ndarray,
) -> np.ndarray:
    """One HKV alternation: solve every row's factor vector against the
    ``fixed`` side (item factors when solving for users, user factors when
    solving for items -- §4 of Hu/Koren/Volinsky, see :func:`train_als`).

    A row with no interactions (never occurs for a row that made it into
    ``user_index``/``item_index``, but handled defensively) falls back to
    ``(YtY + reg*I)^-1 * 0 == 0``, the neutral zero vector.
    """
    yty = fixed.T @ fixed  # shared across every row this alternation
    out = np.zeros((n_rows, k), dtype=np.float64)
    for row, cols in interactions.items():
        a = yty.copy()
        b = np.zeros(k, dtype=np.float64)
        for col, c_ui in cols:
            y = fixed[col]
            a += (c_ui - 1.0) * np.outer(y, y)
            b += c_ui * y
        a += reg_eye
        out[row] = np.linalg.solve(a, b)
    return out


__all__ = ["ALSModel", "train_als", "viewer_affinity_percentiles"]
