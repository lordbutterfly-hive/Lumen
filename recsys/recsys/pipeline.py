"""Home-Mixer-adapted ranking pipeline (§3): gather candidate sources, filter
for eligibility, score each in isolation, then diversity-re-rank and truncate.

This is the integration seam — it wires the pure ``recsys.core`` modules
together and is the only core-side place that calls a :class:`HafsqlGateway`.

The Sybil/trust inputs (graph-cred, ring membership) are produced by
:func:`build_trust_snapshot` — a weekly batch job — and passed into
:func:`rank_feed` as a :class:`TrustSnapshot`; the request-scoped inputs
(second-degree engager index, suppression set, stake lineage) are fetched
per request. So none of the anti-gaming machinery is orphaned: every gate has
a producer feeding it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum

from recsys.config import DEFAULT_SETTINGS, ScoreWeights, Settings
from recsys.contracts import (
    Candidate,
    CandidateSource,
    GraphCred,
    HafsqlGateway,
    NormContext,
    Post,
    ScoredCandidate,
    ViewerProfile,
    VoteExclusions,
)
from recsys.core.als import ALSModel, train_als, viewer_affinity_percentiles
from recsys.core.als_guard import als_batch_drift
from recsys.core.candidates import merge_candidates, top_up
from recsys.core.coldstart import (
    INTEREST_LANE_SOURCES,
    interest_candidates,
    is_established_followless,
    popular_fallback,
)
from recsys.core.flooding import cap_oon_flooding
from recsys.core.graph_cred import compute_graph_cred
from recsys.core.rerank import rerank
from recsys.core.ring import detect_rings, ring_member_set
from recsys.core.scoring import (
    AuthorEngagement,
    AuthorPriorGateway,
    organic_quality_raw,
    score_candidates,
)
from recsys.core.second_degree import filter_eligible
from recsys.core.vote_signal import (
    VoterTrust,
    independent_organic_engagement,
    independent_vote_signal,
)

logger = logging.getLogger("recsys.pipeline")


class TrustPolicy(StrEnum):
    """What :func:`rank_feed` does when it has no FRESH trust snapshot (H01).

    A snapshot is "fresh" when it is present AND not flagged ``degraded`` (the
    §H11 between-batch anomaly gate sets ``degraded=True`` when it disables a
    poisoned/anomalous CF model for the week). An absent or degraded snapshot
    silently reverts every Sybil defense — breadth budget off, ring/lineage
    exclusion empty, graph-cred floor fail-open, CF off — which is exactly the
    H01 finding. This policy decides whether that state is refused or made loud;
    it never lets it pass silently.

    :attr:`FAIL_CLOSED` is the DEFAULT (H01 fail-open-by-default fix,
    2026-07-22): a caller who supplies no fresh snapshot is REFUSED, not quietly
    served a full-breadth fail-open feed. Choosing the permissive path is now a
    deliberate, self-documenting opt-in — :attr:`WARN` — reserved for the
    offline measurement harness (which genuinely needs pre-hardening behaviour)
    and the unit tests that exercise non-trust behaviour with no snapshot. The
    safe behaviour is what you get by doing nothing; the farmable one you must
    ask for.
    """

    # THE DEFAULT (production-safe). Refuse to rank without fresh trust rather
    # than silently serve a fully fail-open feed. Raises :class:`MissingTrustError`.
    # A caller who does nothing gets THIS — the safe behaviour, not the farmable one.
    FAIL_CLOSED = "fail_closed"
    # OPT-IN ONLY (never the default since the 2026-07-22 flip). Rank in degraded
    # mode BUT emit a metric + WARNING log every time, so the fail-open state is
    # never silent. Two legitimate opt-in callers: (1) the frozen §4 measurement
    # harness, which measures PRE-hardening behaviour by design; (2) the pipeline
    # unit tests that exercise non-trust behaviour (gather/eligibility/scoring/
    # fallback/diversity) with no snapshot. Both pass ``trust_policy=WARN``
    # explicitly with a rationale — production never reaches this path by
    # omission. The served feed is byte-identical to the old silent behaviour;
    # only the log line + counter are added.
    WARN = "warn"


class MissingTrustError(RuntimeError):
    """:func:`rank_feed` was asked to rank under :attr:`TrustPolicy.FAIL_CLOSED`
    with no fresh trust snapshot (H01). Every anti-Sybil defense would otherwise
    revert to full-breadth fail-open with no in-request signal; production
    refuses rather than serve that silently."""


class _EventCounter:
    """Process-local monotonic event counter. Exposed at module scope so an
    operator — or a regression test — can prove a loud path fired without
    scraping logs; wire :attr:`count` to a real metrics backend in production.
    Phase-0 single-process, so not thread-safe by design."""

    def __init__(self) -> None:
        self.count = 0

    def record(self) -> None:
        self.count += 1


# Counts :func:`rank_feed` calls that ran WITHOUT fresh trust under
# :attr:`TrustPolicy.WARN` (H01) — the loud-but-served degraded path.
TRUST_DEGRADATION = _EventCounter()
# Counts :func:`build_trust_snapshot` batches whose freshly-trained ALS drifted
# beyond ``settings.als.max_batch_drift`` from the prior snapshot and were
# therefore rejected — CF disabled, snapshot marked ``degraded`` (§H11). A
# non-zero value between batches is an operator's signal that the anomaly gate
# fired and a week's CF was withheld pending investigation.
ALS_DRIFT_REJECTIONS = _EventCounter()


@dataclass(frozen=True)
class TrustSnapshot:
    """Weekly-batch Sybil/trust outputs (§8.3/§8.5): graph-cred per account and
    the set of ring-flagged accounts. Produced by :func:`build_trust_snapshot`,
    consumed by :func:`rank_feed`. The empty snapshot is the honest Phase-0
    default (no floor, no ring discount) until the batch job runs.

    ``degraded`` (H01/§H11) marks a snapshot whose trust inputs are known to be
    NOT fresh — e.g. the §H11 between-batch anomaly gate disabled a poisoned CF
    model for the week (``als=None, degraded=True``). :func:`rank_feed` treats a
    degraded snapshot exactly like a missing one: loud under
    :attr:`TrustPolicy.WARN`, refused under :attr:`TrustPolicy.FAIL_CLOSED`."""

    graph_creds: dict[str, GraphCred] = field(default_factory=dict)
    ring_members: frozenset[str] = frozenset()
    als: ALSModel | None = None
    degraded: bool = False


def build_trust_snapshot(
    gateway: HafsqlGateway,
    settings: Settings,
    *,
    since: datetime,
    now: datetime | None = None,
    trusted_seeds: frozenset[str] = frozenset(),
    previous: TrustSnapshot | None = None,
    production: bool = False,
) -> TrustSnapshot:
    """Weekly batch: detect rings, then compute Sybil-hardened graph-cred over
    the follow graph (§8.3/§8.5). Ring membership feeds graph-cred's self-dealing
    discount; stake lineage feeds it too.

    H11 — BETWEEN-BATCH ANOMALY GATE (wired here, 2026-07-22). ``previous`` is
    last week's snapshot. When it carries a trained model, the freshly-trained
    ALS is compared to it with :func:`~recsys.core.als_guard.als_batch_drift`
    (a normalized week-over-week instability figure); if the drift exceeds
    ``settings.als.max_batch_drift`` the fresh model is NOT frozen into the
    snapshot — CF is disabled for the week (``als=None``) and the snapshot is
    marked ``degraded``, which the H01 fail-closed path treats exactly like a
    missing snapshot (refused, or served loudly under
    :attr:`TrustPolicy.WARN`). This is the circuit breaker between "ALS finished
    training" and "ALS is live": a co-engagement campaign that poisons ONE
    week's training run (the C1/C2 shape — a one-directional sock->author edge
    slips both ring detection and stake-lineage) would otherwise ride the CF
    slice of EVERY request for the following week. ``previous=None`` (a
    first-ever batch, or a caller that does not thread last week's snapshot) and
    a ``previous`` whose model is ``None`` (cold start, or itself a degraded
    week) skip the comparison — absence of a comparable prior is not an anomaly,
    the same posture ``als_batch_drift`` takes for no shared users/authors. It
    is a pure backstop to the C1/C2 in-training breadth budget below, which
    already caps unknown-tier co-engagement BEFORE training.

    H12: ``train_als`` gets the SAME ``now`` and ``settings.real_graph.half_life_days``
    every other RealGraph consumer here (``detect_rings``, ``compute_graph_cred``)
    already uses, so a co-engagement edge decays out of the CF matrix on the
    same 30-day half-life it decays out of ring detection and graph-cred —
    before this fix ``r_ui`` never decayed at all, so a year-old edge (including
    since-abandoned sock co-engagement) counted exactly as much as yesterday's.

    C1/C2: the graph-cred we just computed is turned into the SAME
    :class:`~recsys.core.vote_signal.VoterTrust` breadth budget the vote/organic
    signals use (:func:`_voter_trust_from_creds`) and threaded into ``train_als``,
    so unknown-tier one-directional sock co-engagement is breadth-budgeted BEFORE
    CF training instead of poisoning a targeted viewer's CF percentile. Because
    it is built from THIS batch's graph-cred (outside-engaged-gated vouched set),
    the same laundered reciprocal pair that H02 keeps unknown in the vote signal
    is also unknown here — one consistent trust chokepoint feeds every signal.

    F-R2 — EMPTY-SEEDS PRODUCTION GUARD. With ``seed_teleport_share`` sending the
    bulk of TrustRank's teleport mass to ``trusted_seeds``, an EMPTY seed set makes
    graph-cred silently revert toward uniform teleport — a Sybil clique then mints
    free rank with nothing raising. ``rank_feed`` already fails CLOSED on a
    missing/degraded snapshot; this mirrors that posture for the one remaining
    silent-degradation path. When ``production`` is set, refuse to build a snapshot
    from an empty ``trusted_seeds`` rather than fall back to uniform teleport. The
    empty-seeds path stays allowed for the offline harness/unit tests (the default,
    ``production=False`` — the same deliberate opt-in as ``TrustPolicy.WARN``).
    """
    if production and not trusted_seeds:
        raise ValueError(
            "build_trust_snapshot: refusing to build a production trust snapshot "
            "with empty trusted_seeds — TrustRank's seed teleport mass would revert "
            "to uniform, letting a Sybil clique mint free rank. Supply a curated "
            "trusted_seeds set at deploy (F-R2), or pass production=False for the "
            "offline harness."
        )
    # TIERED HISTORY (settings.history, 2026-07-23): `since` here is the LONG
    # TRUST window (now - history.trust_days). Engagement edges feed graph-cred /
    # ALS / ring detection, which must be slow-moving and expensive to fake — a
    # wide window is itself the Sybil defence. The caller passes now - trust_days
    # here, NOT the short sourcing window that rank_feed uses for candidates.
    edges = gateway.engagement_edges(since)
    accounts = frozenset({e.src for e in edges} | {e.dst for e in edges})
    follows = gateway.follow_graph(accounts)
    ring_signals = detect_rings(edges, settings.real_graph, now=now)
    ring_members = ring_member_set(ring_signals, settings.thresholds.ring_discount_threshold)
    lineage = {account: gateway.stake_lineage(account) for account in accounts}
    graph_creds = compute_graph_cred(
        edges,
        follows,
        settings.real_graph,
        config=settings.graph_cred,
        trusted_seeds=trusted_seeds,
        ring_members=ring_members,
        lineage=lineage,
        now=now,
    )
    trained = train_als(
        edges,
        settings.als,
        ring_members=ring_members,
        lineage=lineage,
        now=now,
        half_life_days=settings.real_graph.half_life_days,
        trust=_voter_trust_from_creds(graph_creds, settings),
    )
    # §H11 between-batch anomaly gate: refuse to freeze a model that swung wildly
    # from the one it replaces. Only compares when there is a comparable prior
    # model (see the docstring); als_batch_drift itself returns 0.0 on no shared
    # (user, author) overlap, so total population churn cannot trip it either.
    # ``als`` is what we FREEZE — the freshly-trained model, or None (CF disabled)
    # when the gate fires; ``trained`` stays the real model for the comparison.
    als: ALSModel | None = trained
    degraded = False
    if previous is not None and previous.als is not None:
        drift = als_batch_drift(trained, previous.als)
        if drift > settings.als.max_batch_drift:
            logger.warning(
                "build_trust_snapshot: ALS week-over-week drift %.4f exceeds "
                "max_batch_drift %.4f (§H11) — disabling this week's CF (als=None) and "
                "marking the snapshot degraded rather than freezing a possibly poisoned "
                "model. rank_feed fails closed on it until a clean batch is supplied.",
                drift,
                settings.als.max_batch_drift,
            )
            ALS_DRIFT_REJECTIONS.record()
            als = None
            degraded = True
    return TrustSnapshot(
        graph_creds=graph_creds, ring_members=ring_members, als=als, degraded=degraded
    )


def _organic_signal(
    post: Post,
    viewer: ViewerProfile,
    now: datetime,
    excluded: frozenset[str],
    als: ALSModel | None = None,
    cf_weight: float = 0.0,
    *,
    weights: ScoreWeights | None = None,
    prior: AuthorEngagement | None = None,
    trust: VoterTrust | None = None,
    require_attribution: bool = False,
) -> float:
    """The §4 norm-sample producer, and the per-post organic QUALITY raw
    (:func:`recsys.core.scoring.organic_quality_raw`).

    This is the function the rolling-window norm builder calls once per window
    post, so what it returns IS the distribution ``NormContext.organic_samples``
    is drawn from — and therefore the distribution the scorer's percentile step
    must be given values from. Keeping the two in one place is the invariant
    that the 2026-07-21 saturation bug broke.

    ``viewer``/``als``/``cf_weight`` are RETIRED here and ignored: the CF term
    is no longer an additive bump on this raw value (it clipped 68/113 pool
    posts at organic percentile 1.0 — see :mod:`recsys.core.scoring`), it is a
    per-viewer percentile blended in after normalization. They are kept in the
    signature because the frozen measurement harness's norm builder calls this
    positionally, and because the shape of the call — "this is what a post is
    worth before we know who is looking" — is exactly right.

    ``trust`` graph-cred-weights the post's own engagement breadth against
    funded alts (§8.4), and ``require_attribution`` makes a missing-attribution
    post fail loud; both default to the pre-hardening value the norm sample is
    built on, so the frozen harness's ``trust``-less call is unchanged.
    """
    return organic_quality_raw(
        post,
        now,
        excluded,
        prior=prior,
        weights=weights if weights is not None else DEFAULT_SETTINGS.weights,
        trust=trust,
        require_attribution=require_attribution,
    )


def _author_priors(
    gateway: HafsqlGateway,
    authors: frozenset[str],
    since: datetime,
    snap: TrustSnapshot,
    settings: Settings,
) -> dict[str, AuthorEngagement]:
    """Author-pooled engagement priors for ``authors`` over the window (§6).

    One grouped read per request (not per candidate). A gateway that does not
    implement :class:`~recsys.core.scoring.AuthorPriorGateway` returns nothing
    and every post falls back to its own engagement — the pre-rebuild
    behaviour, degraded honestly rather than faked.

    The prior's engagement is filtered through the SAME §8.4 exclusion set the
    scorer applies to ``own_base`` — self + stake lineage + per-author ring,
    derived here from the weekly trust ``snap`` (identical to what
    :func:`_score` builds per candidate) and passed to the gateway. Without it
    ``total_base`` was self-excluded only, so an author could inflate their own
    pooled prior with delegation-tied alts or a reciprocal ring — exactly the
    engagement the vote signal already refuses on ``own_base``.

    H05: exclusion alone leaves BREADTH un-budgeted — unknown-tier sock
    upvotes on an author's other window posts pass every §8.4 exclusion (they
    are not the author, not lineage, not a reciprocal ring) and still inflate
    ``total_base``. The same :func:`_voter_trust` graph-cred budget
    :func:`_score` builds per request is passed here too, so the gateway can
    credit each window post's breadth ``vouched + budgeted(unknown)`` exactly
    as ``own_base`` is credited, before summing — see
    :class:`~recsys.core.scoring.AuthorPriorGateway`.
    """
    if not authors or not isinstance(gateway, AuthorPriorGateway):
        return {}
    excluded = {
        author: gateway.stake_lineage(author) | _ring_exclusion(author, snap) | {author}
        for author in authors
    }
    trust = _voter_trust(snap, settings)
    return dict(gateway.author_engagement(authors, since, excluded, trust=trust))


def _suppressed(gateway: HafsqlGateway, candidates: list[Candidate]) -> frozenset[str]:
    """Network-suppressed keys among ``candidates`` (§8.7)."""
    keys = frozenset(c.post.key for c in candidates)
    return gateway.suppressed_keys(keys) if keys else frozenset()


def gather_candidates(
    viewer: ViewerProfile,
    gateway: HafsqlGateway,
    since: datetime,
    limit: int,
    settings: Settings,
) -> list[Candidate]:
    """Collect and merge the Phase-0 candidate sources (§3.1), then cap OON
    post-flooding per author (§8.8). Cold viewers get the interest lane."""
    groups: list[list[Candidate]] = []

    # Route the gate-exempt interest lane on the UNSPOOFABLE structural condition
    # (no follow graph to rank from), NOT the client-supplied ``is_new`` flag that
    # ``is_cold()`` also honours. A viewer WITH follows could otherwise keep
    # ``is_new=true`` to force the gate-exempt lane to be appended on top of their
    # in-network feed — the exact spoofable-flag shape ``is_established_followless``
    # was hardened against (coldstart.py: "the ALS-row test is the one that cannot
    # be spoofed"). A true cold/followless viewer still gets the lane here.
    if not viewer.follows:
        groups.append(interest_candidates(viewer, gateway, since, limit, settings.cold_start))

    if viewer.follows:
        groups.append(
            [
                Candidate(post=p, source=CandidateSource.IN_NETWORK)
                for p in gateway.in_network_posts(viewer.follows, since, limit)
            ]
        )
        groups.append(list(gateway.engaged_oon_posts(viewer.follows, since, limit)))

    if viewer.subscribed_communities:
        groups.append(
            [
                Candidate(post=p, source=CandidateSource.OON_COMMUNITY)
                for p in gateway.community_posts(viewer.subscribed_communities, since, limit)
            ]
        )

    merged = merge_candidates(*groups)
    return cap_oon_flooding(merged, settings.flooding.max_oon_posts_per_author)


def _fallback_filler(
    eligible: list[Candidate],
    viewer: ViewerProfile,
    gateway: HafsqlGateway,
    since: datetime,
    limit: int,
    snap: TrustSnapshot,
    settings: Settings,
    *,
    show_nsfw: bool,
) -> list[Candidate]:
    """The popular-lane padding a starved viewer needs — empty for a healthy
    one. Guarantees a non-empty, non-starved feed for **every** viewer (§13.5b).

    The old guard was ``not eligible and is_cold(viewer)``, which asks an
    *identity* question ("is this a new account?"). That misses the state that
    actually breaks a feed: an established viewer whose follows have all gone
    quiet has ``is_cold() == False`` (they do have follows) yet realises zero
    candidates, and got a silently empty feed. The condition that matters is
    the *realised* one — did we actually produce enough candidates for this
    viewer — so the trigger is now the eligible count and nothing else. Cold
    viewers are covered by it as a special case rather than as the only case.

    Starved is ``len(eligible) < settings.fallback.min_feed_size`` (one screen,
    see :class:`FallbackConfig`). Two shapes of top-up, split at the only place
    the split is free:

    * **Some personalized pool (``eligible`` non-empty).** Pad with exactly the
      shortfall, so the viewer's own posts keep the largest share of the feed
      the pool can support and the padding tapers continuously to zero at the
      threshold — a pool of 19 gains one filler, a pool of 20 gains none and
      is bit-for-bit unchanged.
    * **No personalized pool at all (``eligible`` empty).** Nothing to dilute
      and no signal to preserve, so the popular lane simply *is* the feed at
      full depth — byte-identical to the pre-existing cold-viewer behavior, and
      the reason a zero-pool viewer still gets a scrollable feed rather than
      exactly one screen. The discontinuity sits at 0 -> 1 personalized posts,
      where it costs at most one slot of the first screen, instead of at the
      threshold, where it would flip a whole screen's composition.

    The fallback lane is gate-exempt by construction (``INTEREST_TAG``), which
    is the same trust already extended to every cold viewer; it still passes
    through :func:`filter_eligible`, so suppression (§8.7), NSFW and the
    viewer's mutes apply to padding exactly as they do to the real pool. A
    muted or suppressed author cannot re-enter a feed through the top-up.

    Padding is a fallback, never a floor: if the network itself has nothing to
    offer, the feed stays short (or empty) rather than being filled with
    invented content. That residual case is reported by the returned length.

    Returns only the *padding*, deduped against ``eligible``, because the
    caller ranks the two blocks separately — see :func:`rank_feed`.

    ``_SQL_POPULAR_POSTS`` orders the fetched pool by attributed distinct
    identity with SELF-exclusion only — stake-lineage and ring exclusion need
    the weekly trust snapshot, which SQL cannot see (and the frozen gateway
    signature cannot carry). So the pool arrives ordered by a signal a
    lineage/ring farm can still inflate. Before ``top_up`` decides WHICH posts
    become padding, re-order ``admissible`` by the SAME full §8.4 exclusion set
    (self + lineage + per-author ring) and graph-cred breadth budget the scorer
    will use, so a farmed post cannot win a padding slot over an honest one on
    the strength of identities scoring would discard. (The padding is then
    re-scored under the same exclusions in :func:`rank_feed`; this closes the
    remaining gap — the *selection* order — that re-scoring alone leaves open
    when there are more admissible fallback posts than shortfall slots.)
    """
    if len(eligible) >= settings.fallback.min_feed_size:
        return []

    fallback = popular_fallback(gateway, since, limit)
    admissible = filter_eligible(
        fallback,
        viewer,
        {},
        snap.graph_creds,
        settings.thresholds,
        suppressed=_suppressed(gateway, fallback),
        show_nsfw=show_nsfw,
    )
    admissible = _order_by_full_exclusion(admissible, gateway, snap, settings)
    target = (
        settings.fallback.min_feed_size if eligible else len(eligible) + len(admissible)
    )
    return top_up(eligible, admissible, target)[len(eligible) :]


def _order_by_full_exclusion(
    candidates: list[Candidate],
    gateway: HafsqlGateway,
    snap: TrustSnapshot,
    settings: Settings,
) -> list[Candidate]:
    """Stable-sort ``candidates`` by their attributed independent engagement
    under the FULL §8.4 exclusion set (self + stake-lineage + per-author ring)
    and the graph-cred breadth budget — the same exclusions scoring applies.

    Used to make the fallback pool's SELECTION order consistent with scoring, so
    a lineage/ring-farmed post cannot occupy a padding slot on identities the
    scorer would discard. Descending; Python's sort is stable, so the SQL order
    breaks ties (recency, then the self-excluded distinct count)."""
    if not candidates:
        return candidates
    trust = _voter_trust(snap, settings)
    authors = {c.post.author for c in candidates}
    lineage = {author: gateway.stake_lineage(author) for author in authors}

    def key(candidate: Candidate) -> float:
        author = candidate.post.author
        excluded = lineage[author] | _ring_exclusion(author, snap) | {author}
        return independent_organic_engagement(candidate.post, excluded, trust=trust)

    return sorted(candidates, key=key, reverse=True)


def _voter_trust_from_creds(
    graph_creds: Mapping[str, GraphCred], settings: Settings
) -> VoterTrust | None:
    """Build the request's breadth budget (§8.4 funded-alt hardening) from a
    graph-cred map. Shared by :func:`_voter_trust` (the per-request path, given
    a snapshot) and :func:`build_trust_snapshot` (the batch path, which feeds the
    SAME budget into ``train_als`` for C1/C2), so every signal — vote, organic,
    author-prior, CF — is budgeted against ONE trust chokepoint.

    ``None`` when ``graph_creds`` is empty: with no graph-cred we cannot tell a
    funded alt from a genuine newcomer, so every identity keeps full breadth —
    the value the frozen §4 norm sample is built on and byte-identical to the
    pre-hardening pipeline for every caller that ranks without a snapshot.

    H02 — THE VOUCHED GATE: ``vouched`` is every account that received engagement
    from OUTSIDE its own ring/lineage (``GraphCred.outside_engaged``), not merely
    every account whose scalar score clears the engaged/unknown boundary. The
    score alone cannot separate "engaged from outside" from "engaged only by my
    own pair": a ring-flagged-but-below-scale reciprocal pair (the deliberate
    newcomer carve-out — two accounts, one mutual follow + one mutual upvote) is
    NOT zeroed and lands in the engaged band (score > floor), so a score-only
    test would mark it vouched and hand it FULL un-budgeted breadth — the H02
    laundering door. Gating on ``outside_engaged`` keeps that laundered pair in
    the UNKNOWN tier (flat ``unknown_free`` budget — not vouched, and NOT blocked:
    its first genuine vote still counts). A genuine newcomer is identical until
    the instant either account receives ONE outside upvote/comment/reblog, which
    flips ``outside_engaged`` True and earns real breadth. ``and gc.score > floor``
    is kept as a defensive belt (``outside_engaged`` already implies received > 0
    ⇒ engaged band ⇒ score > floor, so it never changes the set on real
    graph-cred output — only guards a hand-built cred that sets the flag but not
    the score)."""
    if not graph_creds:
        return None
    floor = settings.graph_cred.min_vouched_score
    vouched = frozenset(
        account
        for account, gc in graph_creds.items()
        if gc.outside_engaged and gc.score > floor
    )
    return VoterTrust(
        vouched=vouched,
        unknown_free=settings.vote_signal.unknown_free,
        unknown_per_vouched=settings.vote_signal.unknown_per_vouched,
    )


def _voter_trust(snap: TrustSnapshot, settings: Settings) -> VoterTrust | None:
    """The graph-cred-weighted breadth control for this request (§8.4), or
    ``None`` when the snapshot carries no graph-cred. Thin wrapper over
    :func:`_voter_trust_from_creds` reading ``snap.graph_creds`` — see there for
    the H02 vouched-gate semantics."""
    return _voter_trust_from_creds(snap.graph_creds, settings)


def _ring_exclusion(author: str, snap: TrustSnapshot) -> frozenset[str]:
    """Ring co-members to exclude from ``author``'s post (§8.4/§8.5), scoped
    PER AUTHOR rather than globally.

    A ring vote is self-dealing only between two flagged members — the same
    both-endpoints-flagged rule ``compute_graph_cred`` already applies to
    engagement edges. So a post by a flagged author excludes the (flagged) ring
    set; a post by an UN-flagged author excludes nobody on ring grounds. The
    prior code passed the whole ``snap.ring_members`` set into every post, which
    stripped a flagged account's honest votes off unrelated authors' posts — a
    false-positive channel with no corresponding self-dealing to prevent."""
    return snap.ring_members if author in snap.ring_members else frozenset()


def _score(
    candidates: list[Candidate],
    viewer: ViewerProfile,
    gateway: HafsqlGateway,
    norm: NormContext,
    now: datetime,
    snap: TrustSnapshot,
    settings: Settings,
    priors: dict[str, AuthorEngagement] | None = None,
) -> list[ScoredCandidate]:
    """Hydrate vote-exclusions once per author, score each candidate in
    isolation (§3.3), then diversity-re-rank (§3.4).

    Personalization enters at ONE place: ``cf_percentiles``, the viewer's own
    ALS affinity ranks over the candidate authors (§6.1). It is computed once
    per request against the model's full item index — never against the
    candidate pool, so a censored or padded pool cannot reshape it — and is
    ``None`` when this viewer has no CF slice at all (no model, cold viewer,
    or ``ALSConfig.cf_weight`` ablated to 0), in which case the quality
    percentile carries the whole 80%.

    NOTE ``ALSConfig.cf_weight`` is now a GATE, not a magnitude: CF enters as
    a percentile weighted by ``ScoreWeights.organic_cf``, so any positive
    ``cf_weight`` behaves identically and only 0 turns CF off. Renaming it is
    a follow-up for the config owner.

    H07/C1 (2026-07-22): a viewer who is routed to the gate-exempt interest
    lane by :func:`~recsys.core.coldstart.is_cold` for the FOLLOWLESS reason,
    but who is not a true cold start — they have a row in ``snap.als`` — gets
    their interest-lane candidates' ``cf_percentile`` forced to ``None`` (see
    :func:`~recsys.core.coldstart.is_established_followless`). That lane
    applies no graph-cred floor at all, so it is otherwise their entire feed
    with zero identity-based gating; suppressing CF there closes the door a
    poisoned co-engagement edge would otherwise have to lift a spam author
    through, without touching a TRUE cold newcomer (no ALS row), whose CF
    slice is already ``None`` for the ordinary reason (no trained factors).
    """
    authors = {candidate.post.author for candidate in candidates}
    lineage = {author: gateway.stake_lineage(author) for author in authors}
    author_priors = priors if priors is not None else {}
    trust = _voter_trust(snap, settings)
    require_attribution = settings.vote_signal.require_attribution
    scored_inputs: list[tuple[Candidate, float, float]] = []
    for candidate in candidates:
        exclusions = VoteExclusions(
            author=candidate.post.author,
            lineage=lineage[candidate.post.author],
            ring_members=_ring_exclusion(candidate.post.author, snap),
        )
        excluded = exclusions.excluded()
        vote_signal_raw = independent_vote_signal(candidate.post, exclusions, trust=trust)
        organic_raw = _organic_signal(
            candidate.post,
            viewer,
            now,
            excluded,
            weights=settings.weights,
            prior=author_priors.get(candidate.post.author),
            trust=trust,
            require_attribution=require_attribution,
        )
        scored_inputs.append((candidate, vote_signal_raw, organic_raw))

    cf_percentiles = (
        viewer_affinity_percentiles(snap.als, viewer.account, authors)
        if snap.als is not None and settings.als.cf_weight > 0.0
        else None
    )
    has_als_row = snap.als is not None and viewer.account in snap.als.user_index
    cf_suppressed_sources = (
        INTEREST_LANE_SOURCES if is_established_followless(viewer, has_als_row) else frozenset()
    )
    scored = score_candidates(
        scored_inputs,
        norm,
        settings.weights,
        cf_percentiles,
        cf_suppressed_sources=cf_suppressed_sources,
    )
    return rerank(scored, settings.diversity)


def _trust_is_fresh(snapshot: TrustSnapshot | None) -> bool:
    """Whether ``snapshot`` carries FRESH trust (H01): it is present, NOT flagged
    ``degraded`` by the §H11 between-batch anomaly gate, AND actually carries
    trust inputs (``graph_creds`` non-empty). A ``None``, degraded, OR
    empty-but-present snapshot means every Sybil defense (breadth budget,
    ring/lineage exclusion, graph-cred floor, CF) would revert to full-breadth
    fail-open — so all three are refused (FAIL_CLOSED) or served loudly (WARN),
    never silently.

    The ``graph_creds`` non-emptiness clause is the H01 RESIDUAL fix (Opus
    council 2026-07-22). The documented Phase-0 default ``TrustSnapshot()`` has
    ``graph_creds={}`` and ``degraded=False``, so the old ``present and not
    degraded`` test passed it as fresh; ``_voter_trust`` then returned ``None``
    on the empty map and the breadth budget + graph-cred floor went SILENTLY
    off — the exact silent fail-open this gate exists to prevent, hiding at the
    gate's own documented default. A batch that genuinely ran but found an
    all-newcomer network still produces a NON-empty ``graph_creds`` (every
    account is scored, unknown-tier included), so this rejects only the
    never-populated empty default, not a legitimately quiet week."""
    return (
        snapshot is not None
        and not snapshot.degraded
        and bool(snapshot.graph_creds)
    )


def rank_feed(
    viewer: ViewerProfile,
    gateway: HafsqlGateway,
    norm: NormContext,
    *,
    now: datetime,
    since: datetime,
    limit: int = 400,
    settings: Settings = DEFAULT_SETTINGS,
    snapshot: TrustSnapshot | None = None,
    show_nsfw: bool = False,
    trust_policy: TrustPolicy = TrustPolicy.FAIL_CLOSED,
) -> list[ScoredCandidate]:
    """Rank a viewer's discovery feed end to end (§3).

    ``norm`` is the cacheable 7-day global distribution (§4), built once per
    window by the caller. Empty samples are refused loudly rather than
    silently collapsing every score to 0.5. ``snapshot`` carries the weekly
    Sybil/trust outputs.

    H01 — NO SILENT FAIL-OPEN, AND SAFE-BY-DEFAULT (2026-07-22). An absent
    snapshot (or one the §H11 gate flagged ``degraded``) turns off the breadth
    budget, ring/lineage exclusion, the graph-cred floor and CF all at once.
    That must never happen silently, and — the fail-open-by-default fix — must
    not happen at all unless the caller explicitly asks for it. ``trust_policy``
    now DEFAULTS to :attr:`TrustPolicy.FAIL_CLOSED`: a caller who provides no
    fresh snapshot is REFUSED with :class:`MissingTrustError`, not quietly
    served a full-breadth fail-open feed. The permissive path,
    :attr:`TrustPolicy.WARN`, must be requested by name (it emits a WARNING log +
    increments :data:`TRUST_DEGRADATION`, then serves the degraded feed
    byte-identically to the old behaviour) — reserved for the frozen §4
    measurement harness, which measures pre-hardening behaviour by design, and
    the unit tests that exercise non-trust behaviour without a snapshot. Doing
    nothing now yields the SAFE behaviour; the farmable one is an explicit,
    self-documenting opt-in.

    No viewer, in any state, receives an empty feed while the network has a
    single eligible post for them: a realised pool shorter than
    ``settings.fallback.min_feed_size`` is padded from the popular lane
    (:func:`_fallback_filler`). A pool at or above that size never touches the
    fallback and is returned exactly as it would have been before.

    The viewer's own pool and the padding are **scored and re-ranked as two
    separate blocks**, padding strictly after. Interleaving them by score was
    measured to be worse on both counts: the filler outranked the viewer's own
    posts (a 6-post interest pool landed at feed positions 14-19 behind 14
    popular posts), and the filler's topics polluted the re-ranker's inferred
    viewer affinity, which reads topic interest off the pool's score mass. Two
    blocks keep the padding a strict tail extension — it can only ever add to
    a feed, never displace or reinterpret what the viewer actually asked for.
    Both blocks are ranked against the same global ``norm``, so scores stay
    comparable; only their interleaving is suppressed. Author-diversity spacing
    is per-block, so one author may appear on both sides of the seam.
    """
    min_samples = settings.norm.min_samples
    if (
        min(len(norm.vote_signal_samples), len(norm.reputation_samples), len(norm.organic_samples))
        < min_samples
    ):
        raise ValueError(
            f"NormContext has fewer than {min_samples} samples; refusing to rank — too few "
            "to percentile-rank meaningfully (it would degenerate toward a flat 0.5 and let "
            "the tie-break become the real ranker). Build it from the rolling window (§4)."
        )
    if not _trust_is_fresh(snapshot):
        reason = "no trust snapshot" if snapshot is None else "degraded trust snapshot"
        if trust_policy is TrustPolicy.FAIL_CLOSED:
            raise MissingTrustError(
                f"rank_feed refusing to rank ({reason}): the breadth budget, ring/lineage "
                "exclusion, graph-cred floor and CF would all silently revert to full-breadth "
                "fail-open. Provide a fresh TrustSnapshot, or pass trust_policy="
                "TrustPolicy.WARN to serve a degraded feed loudly instead."
            )
        logger.warning(
            "rank_feed ranking with %s: breadth budget, ring/lineage exclusion, graph-cred "
            "floor and CF are degraded to fail-open. This must not happen in steady-state "
            "production — wire a fresh weekly TrustSnapshot (viewer=%s).",
            reason,
            viewer.account,
        )
        TRUST_DEGRADATION.record()
    snap = snapshot if snapshot is not None else TrustSnapshot()

    candidates = gather_candidates(viewer, gateway, since, limit, settings)
    suppressed = _suppressed(gateway, candidates)
    gated_keys = frozenset(c.post.key for c in candidates if c.source.requires_second_degree)
    engager_index = (
        gateway.second_degree_engagers(gated_keys, viewer.follows) if gated_keys else {}
    )
    eligible = filter_eligible(
        candidates,
        viewer,
        engager_index,
        snap.graph_creds,
        settings.thresholds,
        suppressed=suppressed,
        show_nsfw=show_nsfw,
    )

    filler = _fallback_filler(
        eligible,
        viewer,
        gateway,
        since,
        limit,
        snap,
        settings,
        show_nsfw=show_nsfw,
    )
    # One grouped author-prior read for BOTH blocks (§6): the prior is a
    # per-author window aggregate, so it is identical for the viewer's own
    # pool and for the popular padding, and fetching it once keeps the
    # two-block split free of a second round trip.
    #
    # TIERED HISTORY (settings.history, 2026-07-23): the author QUALITY PRIOR pools
    # an author's events over a MEDIUM window (quality_prior_days) — deliberately
    # WIDER than the short candidate-sourcing window `since` — so there are enough
    # events per author to beat the ~5-voter Bernoulli noise floor (Spearman 0.353
    # @ 7d). Sourcing stays on `since` (freshness); trust is the long window in
    # build_trust_snapshot. LIVE-DATA-GATED: the horizon default is a placeholder
    # to tune against real HAFSQL — simworld has no multi-year history.
    quality_since = now - timedelta(days=settings.history.quality_prior_days)
    priors = _author_priors(
        gateway,
        frozenset(c.post.author for c in eligible) | frozenset(c.post.author for c in filler),
        quality_since,
        snap,
        settings,
    )
    ranked = _score(eligible, viewer, gateway, norm, now, snap, settings, priors)
    if filler:
        ranked = ranked + _score(filler, viewer, gateway, norm, now, snap, settings, priors)
    return ranked[: settings.diversity.top_k]
