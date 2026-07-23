"""Tunable Phase-0 configuration.

All values are *hand-tuned starting points* (Phase 2 / LightGBM learns them).
Immutable dataclasses; construct a custom :class:`Settings` to override, or
load secrets from the environment in production (see :class:`HafsqlConfig`).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ScoreWeights:
    """The fixed 10 / 10 / 80 composition (§0). Must sum to 1.0.

    The ``organic_*`` fields govern what the 80% organic slice IS — not its
    weight (that ruling stands). Rebuilt 2026-07-21 after the saturation
    finding: the additive raw CF bump clipped 68/113 pool posts at organic
    percentile 1.0, so the 80% term was a constant across most of the feed
    head and ordering fell to the 10% vote term + tie-breaks. The organic
    value is now a jointly-normalized blend of two percentiles:

        organic = organic_quality * qual_pct + organic_cf * cf_pct

    * ``qual_pct`` — global percentile (vs the rolling window sample, §4) of
      the author-pooled engagement estimator: ``organic_post_share`` of the
      post's own log-engagement plus the complement times the leave-one-out
      mean over the author's OTHER window posts. Pooling denoises the ~5-voter
      Bernoulli luck of a single post with independent breadth the author
      already earned (measured: per-post Spearman vs author quality 0.353 ->
      pooled 0.694). On-chain signal only.
    * ``cf_pct`` — the trained ALS affinity percentile within the VIEWER'S OWN
      distribution over all trained authors (per-viewer joint normalization,
      ``recsys.core.als.viewer_affinity_percentiles``) — never a raw additive
      bump, so the global percentile step can no longer clip it. When no CF
      slice exists for the whole request (no model, cold viewer, or the
      ``ALSConfig.cf_weight`` ablation switch at 0) the quality percentile
      carries the full organic weight.

    ``organic_quality + organic_cf`` must sum to 1.0 so ``organic`` stays in
    [0, 1] and the 10/10/80 outer blend keeps its meaning.

    ``organic_cf_oon_scale`` (§H06, PRUNED audit 2026-07-22) additionally
    scales ``organic_cf`` DOWN for every candidate source that is not
    ``IN_NETWORK`` — the second-degree-gate-exempt ``INTEREST_*``/OON lanes
    where CF is most exposed to un-vetted, one-directional co-engagement
    (see :func:`recsys.core.scoring.score_candidate` and the field's own
    docstring below). ``IN_NETWORK`` candidates are always scaled by exactly
    1.0, so the formula above is unchanged for them.
    """

    vote: float = 0.10
    reputation: float = 0.10
    organic: float = 0.80
    # Inside the organic slice (candidate G_composite, measured 2026-07-21;
    # RE-SWEPT 2026-07-22, see organic_cf note below for the {0.0..0.3} table).
    organic_quality: float = 0.9
    organic_cf: float = 0.1
    # organic_cf RE-SWEPT 0.3 -> 0.1 (2026-07-22), LIVE-DATA-GATED. The CF
    # joint-normalization term was foregrounded as the saturation fix but is
    # NOT the picking lever (the author-pooled quality prior is); an isolated
    # sweep over {0.0, 0.1, 0.2, 0.3} on the FULL rebuild (pooled prior ON, CF
    # gate ON, 24-viewer q7 panel, identical eligible pool across configs so
    # the AUC columns are valid) reads, per organic_cf:
    #
    #   organic_cf                 0.0     0.1     0.2     0.3(old)
    #   mean_q@20  (anchor)        0.700   0.695   0.694   0.690
    #   pinned_q_g (fixed comp)    0.654   0.651   0.644   0.632
    #   stack_capture_g (glob ref) 0.799   0.797   0.788   0.772
    #   auc_own_m5 (depth-ctl pick)0.743   0.747   0.734   0.730
    #   q_own_m5   (depth-ctl)     0.746   0.748   0.742   0.739
    #   own-topic share@20         0.367   0.383   0.394   0.400
    #   topic entropy@20 (bits)    2.312   2.287   2.275   2.278
    #   distinct organic pctl/113  81.7    109.1   109.1   109.1
    #
    # On EVERY composition-immune quality read (mean_q — topic-independent in
    # simworld so composition cannot inflate it; pinned_q_g and stack_capture_g
    # — global-reference, censorship-immune; plus a metric-free forced-own-
    # quota control that agrees at every W) CF is monotone HARMFUL: more CF
    # only shifts composition toward own-topic (own_share 0.367 -> 0.400) — the
    # exact "own-share up, delivered quality down" pattern this project rules a
    # REGRESSION. The one axis CF may LEGITIMATELY help — depth-controlled own-
    # topic PICKING (auc_own_m5 / q_own_m5 / cap_own_m5_g) — PEAKS at 0.1 and
    # falls from 0.2 up. And CF's structural deep-pool tie-breaking saturates
    # AT 0.1: distinct organic percentiles jump 81.7 -> 109.1 of 113 pool posts
    # at 0.1 and stay flat at 0.2/0.3, so weight above 0.1 buys ZERO extra
    # ordering and only quality cost. 0.3 is thus DOMINATED by 0.1 on the
    # synthetic instrument (>= on every axis, smaller composition shift).
    #
    # NOT set to 0.0 (the synthetic quality-optimal) — the evidence is NOT
    # unambiguous: 0.1 is the synthetic own-topic-PICKING peak, AND simworld
    # STRUCTURALLY understates CF. Its topic structure is clean and its author
    # quality is topic-independent, so the pooled prior + interest lane already
    # serve the right topic and CF can only move composition here; it has no
    # session dynamics, no cold-start viewers, and no unengaged-pair discovery
    # need — exactly where CF earns its keep on the real chain (q4: ALS graded
    # same-topic generalization on UNENGAGED pairs, quality-AUC 0.805, which
    # this synthetic reproduces but the feed metric cannot reward). 0.1 keeps a
    # small CF contribution at its synthetic knee and preserves that cold-start
    # lever. LIVE-DATA GATE: a real-Hive A/B (cold-start personalization +
    # unengaged-pair lift) must confirm before launch. If live data shows no
    # cold-start value, drop to 0.0; if strong, the 0.1-0.2 band. Both remain
    # one-field flips (organic_cf + organic_quality = 1.0).
    # Post's own share in the pooled author estimator: 0.5*b_post + 1.0*LOO
    # normalized -> 1/3. A convex combination of same-scale log-engagement
    # values, so the estimator stays inside the norm sample's range (no clip).
    # H06 (PRUNED audit 2026-07-22): the CF percentile was blended into
    # ``organic`` at the SAME ``organic_cf`` weight for every candidate
    # source, including the second-degree-gate-EXEMPT ``INTEREST_*``/OON
    # lanes. Those lanes are exactly where a one-directional, un-reciprocated
    # sock->author edge survives ring/lineage exclusion (see C1/C2) and
    # poisons a viewer's own ALS affinity distribution, so weighing CF there
    # as heavily as in-network engagement the viewer's own follow graph has
    # already vetted re-opens a laundering door one layer up the stack from
    # the breadth-budget fixes. ``organic_cf_oon_scale`` multiplies
    # ``organic_cf`` for every non-``IN_NETWORK`` source (see
    # :func:`recsys.core.scoring.score_candidate`); IN_NETWORK is always
    # scaled by exactly 1.0 (unchanged). Default 0.0 fully drops the CF slice
    # for gate-exempt sources -- the same conservative, LIVE-DATA-GATED
    # posture as ``organic_cf`` itself (see its note above): the synthetic
    # harness cannot measure the cold-start/unengaged-pair value CF exists
    # for, so this is not tuned against it. A real-Hive A/B may justify
    # raising it toward 1.0 once OON/interest-lane CF quality is measured
    # rather than assumed.
    organic_cf_oon_scale: float = 0.0
    organic_post_share: float = 1.0 / 3.0
    # Additive freshness bonus inside the quality raw, ON THE SAME SCALE as the
    # log-engagement term (never a multiplicative decay, so an old well-engaged
    # post is not crushed and a brand-new empty post is not zero).
    #
    # RE-CALIBRATED 0.5 -> 0.10 (2026-07-21) because the author-pooled prior
    # moved the distribution this weight was set against, not because recency
    # is unwanted. 0.5 was chosen when the engagement term was ONE post's
    # log-engagement (sd 0.177 across the window). Pooling an author's window
    # posts is a variance-reduction step by construction, and it compresses
    # that spread to sd 0.113 — so an UNCHANGED 0.5 recency addend silently
    # became ~1.6x more influential relative to the signal it competes with.
    # Measured consequence of leaving it at 0.5 (24-viewer panel, k=20):
    # nDCG rises to 0.445 from the shipped 0.396 while depth-controlled
    # own-stratum selection AUC@5 FALLS to 0.700 from 0.722 and own-topic
    # share climbs 0.415 -> 0.438 — nDCG up, picking down, composition
    # shifted: the exact pattern this project rules a REGRESSION. At 0.10 the
    # rebuild is instead a strict improvement on every axis at flat
    # composition (see the round report).
    #
    # 0.0 (candidate #3 — DELETE the term) measures identically on quality
    # (mean author q@20 0.692 either way) and is NOT taken: simworld has no
    # session dynamics (no repeat visits, no "already seen"), which is exactly
    # where freshness earns its keep on the real chain, and at 0.0 the deep
    # pool loses ordering — 28 of 113 pool posts tie on organic vs 2.2 at 0.10
    # (the top-20 is unaffected either way). Both 0.0 and the old 0.5 remain
    # one-field flips, not code changes.
    organic_recency: float = 0.10
    organic_half_life_hours: float = 48.0

    def __post_init__(self) -> None:
        total = self.vote + self.reputation + self.organic
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"score weights must sum to 1.0, got {total}")
        inner = self.organic_quality + self.organic_cf
        if abs(inner - 1.0) > 1e-9:
            raise ValueError(
                f"organic_quality + organic_cf must sum to 1.0, got {inner}"
            )
        if not 0.0 <= self.organic_post_share <= 1.0:
            raise ValueError(
                f"organic_post_share must be in [0, 1], got {self.organic_post_share}"
            )
        if not 0.0 <= self.organic_cf_oon_scale <= 1.0:
            raise ValueError(
                f"organic_cf_oon_scale must be in [0, 1], got {self.organic_cf_oon_scale}"
            )
        if self.organic_recency < 0.0:
            raise ValueError(f"organic_recency must be >= 0, got {self.organic_recency}")
        if self.organic_half_life_hours <= 0.0:
            raise ValueError(
                f"organic_half_life_hours must be > 0, got {self.organic_half_life_hours}"
            )


@dataclass(frozen=True)
class NormConfig:
    """Log-compress + percentile-rank against a rolling global window (§4)."""

    window_days: int = 7
    rshares_floor: float = 1e7  # hivemind: sign*log10(max(|rshares|/floor, 1))
    # Below this many rolling samples the percentile rank is untrustworthy;
    # the scorer refuses to run rather than silently rank everything at 0.5.
    min_samples: int = 50


@dataclass(frozen=True)
class Thresholds:
    """Out-of-network eligibility gates (§8)."""

    second_degree_min_engagers: int = 1  # §8.1, adapts UTEG MinFavCount=1
    graph_cred_floor: float = 0.05  # §8.3 soft floor for OON distribution
    ring_discount_threshold: float = 0.6  # §8.5 discount at/above this ring score
    # §8.2 vouch quality: a second-degree engager only counts as a vouch if its
    # own graph-cred clears this (a fresh/low-standing account can't vouch).
    vouch_graph_cred_floor: float = 0.05


@dataclass(frozen=True)
class DiversityConfig:
    """Author-diversity decay + truncation (§3.4). Twitter defaults."""

    author_decay: float = 0.5
    author_floor: float = 0.25
    # Topic/community diversity, applied after author diversity, so a feed can't
    # collapse to one community even across many authors.
    topic_decay: float = 0.6
    topic_floor: float = 0.4
    # Interest-aware topic diversity: how strongly the viewer's inferred
    # per-topic affinity (recsys.core.rerank._topic_affinities = the topic's
    # share of the pool's TOTAL score mass, so all affinities sum to 1)
    # attenuates the topic penalty. 0.0 = the old interest-blind flat penalty;
    # 1.0 = full mass-share attenuation — a topic is only fully exempt if it
    # carries the entire pool, so co-equal favorite topics each keep real
    # alternation pressure (the earlier max-mass normalization switched the
    # penalty fully off for EVERY near-dominant topic at once; retuned after
    # that fix). 0.5 was chosen against the metrics_v2 quality instrument,
    # not nDCG: delivered quality is flat-to-slightly-up across the whole
    # knob (mean-author-q@20 +0.004, picking skill fcq_capture ~0.707
    # everywhere — the knob is purely a composition dial), so the costs
    # decide. 0.45-0.55 buys most of the achievable own-topic composition
    # (own-share 0.31 -> 0.42 of the ~0.47 at 0.75) at the shallow end of
    # every cost curve: own-slot capture -0.016, own-tier selection AUC
    # -0.034, topic entropy 2.24 of the flat penalty's 2.38 bits (per-viewer
    # min 1.88), 5-session feedback loop at baseline (9/24 frozen, min
    # overlap 17 vs 14). From 0.60 upward the cap/AUC/entropy costs step down
    # and keep worsening while quality stays flat. Author diversity is never
    # affinity-scaled.
    topic_affinity_strength: float = 0.5
    top_k: int = 200

    def __post_init__(self) -> None:
        if not 0.0 <= self.topic_affinity_strength <= 1.0:
            raise ValueError(
                f"topic_affinity_strength must be in [0, 1], got {self.topic_affinity_strength}"
            )


@dataclass(frozen=True)
class ColdStartConfig:
    """Interest-selection seeding (rev 2.2). Communities weighted above tags."""

    # Community-over-tag precedence is enforced by SOURCE_PRIORITY on dedup
    # (INTEREST_COMMUNITY outranks INTEREST_TAG), not a weight here.
    # Enforced at the signup/API boundary (outside recsys): a viewer must pick
    # at least this many interests, so the cold-start lane is never empty.
    min_interests: int = 3


@dataclass(frozen=True)
class FallbackConfig:
    """Starved-feed top-up (§13.5b, generalized from cold viewers to *any*
    viewer whose realised candidate pool comes up short).

    ``min_feed_size`` is the point below which a feed counts as starved. 20 is
    the first-screen depth every measurement in the harness reports at
    (nDCG@20, own-topic@20, overlap@20): a viewer holding fewer than one screen
    of eligible posts has a visibly broken feed, whether that is 0 posts or 3.
    At or above it the fallback lane never runs at all, so a healthy feed is
    bit-for-bit unchanged.
    """

    min_feed_size: int = 20

    def __post_init__(self) -> None:
        if self.min_feed_size < 0:
            raise ValueError(f"min_feed_size must be >= 0, got {self.min_feed_size}")


@dataclass(frozen=True)
class RealGraphWeights:
    """Per-feature weights that collapse a RealGraph :class:`EngagementEdge`
    into a scalar edge weight (§8.3, rev 2.2). Reciprocity (a reply back) is
    the strongest cheap-to-verify signal; passive opens the weakest."""

    # Steeper than a flat scale (closer to X's cited reply-heavy ordering, §5)
    # so cheap actions can't rival reciprocated conversation.
    reply: float = 5.0
    reply_back: float = 15.0
    upvote: float = 1.0
    reblog: float = 2.0
    # Phase-1 telemetry signals: no HAFSQL/data source AND no server-side
    # bot-defense yet (§8.9), so held at 0.0 until plausibility checks exist —
    # otherwise they'd be free, unauthenticated weight.
    mention: float = 0.0
    profile_visit: float = 0.0
    post_open: float = 0.0
    revisit: float = 0.0
    dwell_per_minute: float = 0.0
    half_life_days: float = 30.0  # time-decay of the edge's last interaction


@dataclass(frozen=True)
class HafsqlConfig:
    """Public read-only HAFSQL Postgres (Appendix B). The documented public
    credentials are the defaults; override any field from the environment."""

    host: str = "hafsql-sql.mahdiyari.info"
    port: int = 5432
    dbname: str = "haf_block_log"
    user: str = "hafsql_public"
    password: str = "hafsql_public"
    connect_timeout: int = 10

    @classmethod
    def from_env(cls) -> HafsqlConfig:
        return cls(
            host=os.environ.get("HAFSQL_HOST", cls.host),
            port=int(os.environ.get("HAFSQL_PORT", cls.port)),
            dbname=os.environ.get("HAFSQL_DB", cls.dbname),
            user=os.environ.get("HAFSQL_USER", cls.user),
            password=os.environ.get("HAFSQL_PASSWORD", cls.password),
            connect_timeout=int(os.environ.get("HAFSQL_TIMEOUT", cls.connect_timeout)),
        )


@dataclass(frozen=True)
class GraphCredConfig:
    """PageRank + Sybil-resistance params for graph-cred (§8.3)."""

    damping: float = 0.85
    iterations: int = 50
    # TrustRank/EigenTrust: bias the teleport toward a pre-trusted seed set so a
    # closed Sybil clique can't mint free rank from uniform teleport. This share
    # of teleport mass goes to seeds; the remainder stays uniform.
    seed_teleport_share: float = 0.8
    # The UNKNOWN band, and the bottom of the engaged band (§8.3). An account
    # nobody has engaged yet — a new author, a newcomer who comments before
    # posting, a pure consumer — scores exactly this: unknown is not the same
    # state as bad, and must not be scored as if it were. Every account that
    # HAS been engaged is percentile-ranked among the engaged population and
    # lands strictly above it, in (min_vouched_score, 1.0]. Only a caught
    # self-dealer (all received engagement zeroed as lineage/ring) scores 0.0.
    # So any floor in (0, min_vouched_score] fails exactly the caught
    # self-dealers and nobody else, and only floors above this value start
    # cutting into new and weakly-engaged accounts.
    min_vouched_score: float = 0.10
    # Relocated-newcomer-blackout fix (§8.3): a reciprocal pair flagged by
    # ring.py's insularity test is only treated as PROVEN self-dealing --
    # zeroed weight, eligible for the 0.0 band -- if it shows SCALE (the
    # account has more than one distinct ring-flagged partner, i.e. it sits in
    # an actual multi-party ring) or a REPEATED pattern (both directions of a
    # single pair clear this many raw interaction events). Two brand-new
    # accounts whose entire footprint is one mutual exchange (e.g. one upvote
    # each way -- the starter-pack on-ramp) clear neither test and are treated
    # as ordinary, unproven engagement instead. Must be >= 2: at 1, every
    # qualifying ring edge already has >=1 event per direction by construction
    # and the newcomer protection this field exists for would be a no-op.
    # Lineage-based self-dealing is exempt from this gate -- lineage is a
    # verified on-chain stake relationship, not a behavioral inference from
    # engagement volume, so it needs no scale evidence.
    min_ring_self_dealing_events: int = 2

    def __post_init__(self) -> None:
        if not 0.0 < self.min_vouched_score <= 1.0:
            raise ValueError(
                f"min_vouched_score must be in (0, 1], got {self.min_vouched_score}"
            )
        if self.min_ring_self_dealing_events < 2:
            raise ValueError(
                "min_ring_self_dealing_events must be >= 2 (1 would make the "
                f"single-reciprocal-interaction protection a no-op), got "
                f"{self.min_ring_self_dealing_events}"
            )


@dataclass(frozen=True)
class FloodingConfig:
    """Post-frequency cap for OON discovery eligibility (§8.8)."""

    max_oon_posts_per_author: int = 3


@dataclass(frozen=True)
class ALSConfig:
    """Implicit-feedback ALS for the collaborative-filtering slice of the
    organic bucket (§6.1) — factorizes the viewer x author engagement matrix.
    ``cf_weight`` scales the learned viewer->author affinity into the organic
    signal blend; ``seed`` keeps training deterministic."""

    factors: int = 32
    iterations: int = 15
    regularization: float = 0.1
    alpha: float = 40.0
    cf_weight: float = 1.5
    seed: int = 0
    # §H11 between-batch anomaly gate (wired into
    # :func:`recsys.pipeline.build_trust_snapshot` via
    # :func:`recsys.core.als_guard.als_batch_drift`). The MAXIMUM tolerated
    # week-over-week ALS instability. ``als_batch_drift`` returns the mean
    # absolute change in predicted ``(viewer, author)`` affinity over the pairs
    # BOTH weeks trained, divided by last week's RMS affinity on that same grid
    # — a relative "how big was the average swing versus what the model normally
    # predicts" figure (see that module's docstring for why normalized, not a
    # raw delta). When a freshly-trained batch drifts ABOVE this from the prior
    # snapshot, ``build_trust_snapshot`` DISABLES that week's CF (``als=None``)
    # and marks the snapshot ``degraded`` — the H01 fail-closed path then treats
    # it as not-fresh and refuses to serve the anomalous model, rather than
    # freezing possibly-poisoned factors into every request for the whole week
    # (the C1/C2 attack shape: a one-directional sock->author co-engagement
    # campaign that slips ring detection + stake-lineage).
    #
    # Measured drift magnitudes through the FULL pipeline (graph-cred + the
    # C1/C2 in-training breadth budget + train_als, DEFAULT_SETTINGS, now=EPOCH,
    # see the §H11 pipeline tests): ordinary organic week-over-week churn ~0.019;
    # a 30-sock one-directional campaign on the shared grid 0.07 (vouched socks)
    # to 0.22 (unknown-tier socks). Default 0.5 is deliberately CONSERVATIVE — a
    # swing of half the typical affinity magnitude — because the cost of a FALSE
    # positive is high: under the fail-closed default a degraded snapshot takes
    # the feed OFFLINE until a clean batch (or last week's snapshot) is supplied.
    # H11 is a defense-in-depth BACKSTOP to the C1/C2 breadth budget (which
    # already caps unknown-tier co-engagement BEFORE training), not the
    # front-line Sybil defense, so it should fire only on gross, unambiguous
    # instability. LIVE-DATA-GATED like every other ALS param here: calibrate
    # against the real week-over-week drift distribution before launch. Both the
    # value and the wiring are decoupled — the gate is exercised at explicit
    # thresholds in the tests, so re-tuning this one field never touches code.
    max_batch_drift: float = 0.5

    def __post_init__(self) -> None:
        if self.factors <= 0:
            raise ValueError(f"factors must be > 0, got {self.factors}")
        if self.iterations <= 0:
            raise ValueError(f"iterations must be > 0, got {self.iterations}")
        if self.regularization <= 0:
            raise ValueError(
                f"regularization must be > 0 (else the ridge solve can be singular), "
                f"got {self.regularization}"
            )
        if self.alpha < 0:
            raise ValueError(f"alpha must be >= 0, got {self.alpha}")
        if self.max_batch_drift <= 0.0:
            raise ValueError(
                "max_batch_drift must be > 0 (at 0 every non-identical retrain — any "
                f"organic churn — would degrade the snapshot), got {self.max_batch_drift}"
            )


@dataclass(frozen=True)
class VoteSignalConfig:
    """Independent-engagement breadth hardening (§4/§8.4, funded-alt fix
    2026-07-22). See :class:`recsys.core.vote_signal.VoterTrust`.

    The vote signal and the organic engagement term reward the count of
    DISTINCT independent identities (voters / commenters / rebloggers). Funded
    sock-puppet alts are distinct on-chain accounts that slip every §8.4
    exclusion — self (they are not the author), stake-lineage (funding by
    transfer writes no delegation row) and ring (a one-directional
    ``alt -> author`` star forms no reciprocal edge) — so an un-weighted count
    is bought one-for-one. These budget the UNKNOWN tier (graph-cred at the
    engaged/unknown boundary, i.e. never genuinely engaged by anyone):

        credited breadth = vouched_count + min(unknown_count,
                               unknown_free + unknown_per_vouched * vouched_count)

    ``unknown_free`` is the newcomer floor: a post whose only engagers are
    brand-new accounts (a new author in a fresh community) still earns breadth
    for ``unknown_free`` of them, so a genuine new user's first upvote always
    counts — the exact newcomer-blocking regression this project made once and
    undid. A bare-alt swarm hits the same floor (zero vouched → budget is
    exactly ``unknown_free``, not the alt count). ``unknown_per_vouched`` lets a
    genuinely popular post (many vouched voters) absorb proportionally more real
    newcomers; it grants the bare-alt attack nothing.

    The vouched/unknown split is drawn at ``GraphCredConfig.min_vouched_score``
    (the canonical engaged/unknown boundary), so no floor lives here.

    ``require_attribution`` makes attributed scoring fail LOUD: a plain
    :class:`~recsys.contracts.Post` reaching the organic term (production always
    hydrates an ``AttributedPost``, so a bare ``Post`` is a dropped-identity
    plumbing failure) raises instead of scoring a silent zero. Default OFF
    because the plain-``Post`` measurement harness and unit fixtures are valid
    inputs; PRODUCTION settings set it ``True`` so real plumbing failures
    surface. (An ``AttributedPost`` with empty commenters/rebloggers is a real
    "nobody discussed this" observation and never raises.)
    """

    # unknown_free = 1.0 is the tightest setting the newcomer invariant permits
    # (a lone newcomer vote still credits its full 0.5 breadth) AND the strongest
    # bare-alt suppression: a funded-alt swarm has zero vouched voters, so its
    # unknown budget is exactly unknown_free regardless of alt count — the spam
    # post's rank stops responding to more alts entirely. Measured (seed=7,
    # cold interest-lane viewer, 0.5 HP alts): spam feed position is FLAT at 17
    # for 3 / 10 / 20 alts (pre-fix: 11 / 8 / 5 — it climbed with every alt) and
    # honest-viewer nDCG@20 is unchanged (0.4099 vs 0.4098). unknown_per_vouched
    # does nothing to the bare-alt attack (budget = unknown_free + slope*0); it
    # is kept generous (2.0) so a genuinely popular honest post — many vouched
    # voters — absorbs proportionally more real newcomers without penalty.
    unknown_free: float = 1.0
    unknown_per_vouched: float = 2.0
    require_attribution: bool = False

    def __post_init__(self) -> None:
        if self.unknown_free < 1.0:
            raise ValueError(
                "unknown_free must be >= 1.0 so a genuine newcomer's first "
                f"upvote always counts (§ newcomer invariant), got {self.unknown_free}"
            )
        if self.unknown_per_vouched < 0.0:
            raise ValueError(
                f"unknown_per_vouched must be >= 0, got {self.unknown_per_vouched}"
            )


@dataclass(frozen=True)
class HistoryWindows:
    """Tiered history horizons (QUEUED-SIGNAL-HIERARCHY-AND-HISTORY-2026-07-22).

    A single 7-day ``since`` shared by every HAFSQL fetch is wrong in BOTH
    directions: it starves the slow, expensive-to-fake signals (trust, ring) of
    the multi-year history that MAKES them Sybil-resistant, while naively widening
    that one window would surface two-year-old posts as fresh candidates. Each
    consumer therefore gets its OWN horizon:

      * candidate SOURCING (freshness) -> SHORT. The only place a ~week is right:
        it decides which posts appear. Widening this is the feed-staleness footgun.
      * author QUALITY PRIOR -> MEDIUM. Enough events per author to beat the
        ~5-voter Bernoulli noise floor (measured Spearman-vs-quality 0.353 @ 7d).
      * TRUST / graph-cred / ALS -> LONG, and RING/self-deal -> LONG. Trust must
        be slow-moving and costly to manufacture; a wide window is itself the
        Sybil defence, and ring temporal patterns are invisible in a one-week frame.

    NEWCOMER SAFETY (load-bearing invariant, see core/coldstart.py): the long
    trust window must NEVER gate the cold-start / interest lanes. A brand-new
    viewer or author reaches the feed via the interest community/tag sources over
    the SHORT sourcing window — gate-exempt, independent of trust ("never gate on
    the absence of history"). The long window makes an established author's
    credibility higher/more-stable, which widens the relative newcomer gap in the
    trust-gated OON lane ONLY; the interest on-ramp is untouched. Re-measure both
    on-ramps, never assume.

    LIVE-DATA-GATED: simworld has no multi-year synthetic history and cannot
    honestly validate these horizons — the defaults below are conservative
    starting points to tune against live HAFSQL (measure query cost + index
    coverage + snapshot build time first). Land AFTER the organic-prior rebuild,
    never simultaneously. Tier ordering is enforced in __post_init__ so a
    misconfig can't make sourcing wider than trust.
    """

    sourcing_freshness_days: int = 3  # candidate pools: in-network / community / tag / engaged-OON
    quality_prior_days: int = 45  # author-pooled quality prior
    trust_days: int = 365  # engagement_edges -> graph-cred / ALS
    ring_days: int = 365  # temporal ring / self-deal detection

    def __post_init__(self) -> None:
        if not (0 < self.sourcing_freshness_days <= self.quality_prior_days <= self.trust_days):
            raise ValueError(
                "history windows must satisfy 0 < sourcing_freshness_days <= "
                f"quality_prior_days <= trust_days; got {self.sourcing_freshness_days}, "
                f"{self.quality_prior_days}, {self.trust_days}"
            )
        if self.ring_days <= 0:
            raise ValueError(f"ring_days must be > 0, got {self.ring_days}")


@dataclass(frozen=True)
class Settings:
    """Root config object threaded through the pipeline."""

    weights: ScoreWeights = field(default_factory=ScoreWeights)
    norm: NormConfig = field(default_factory=NormConfig)
    history: HistoryWindows = field(default_factory=HistoryWindows)
    thresholds: Thresholds = field(default_factory=Thresholds)
    diversity: DiversityConfig = field(default_factory=DiversityConfig)
    cold_start: ColdStartConfig = field(default_factory=ColdStartConfig)
    fallback: FallbackConfig = field(default_factory=FallbackConfig)
    real_graph: RealGraphWeights = field(default_factory=RealGraphWeights)
    graph_cred: GraphCredConfig = field(default_factory=GraphCredConfig)
    flooding: FloodingConfig = field(default_factory=FloodingConfig)
    als: ALSConfig = field(default_factory=ALSConfig)
    vote_signal: VoteSignalConfig = field(default_factory=VoteSignalConfig)
    hafsql: HafsqlConfig = field(default_factory=HafsqlConfig)


DEFAULT_SETTINGS = Settings()
