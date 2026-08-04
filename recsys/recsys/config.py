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

    #: Weight of the VIEWER-OWN affinity percentile inside the organic slice
    #: (2026-08-01). Applied as `organic = blend(quality_pct, viewer_pct, w)`,
    #: i.e. it trades against the quality percentile only — the 10/10/80 outer
    #: split and `organic_cf` are untouched.
    #:
    #: WHY THIS IS NOT "just raise organic_cf". CF is a CROSS-VIEWER signal
    #: (other people's co-engagement decides what you see), which is exactly why
    #: H06/H07 capped it at 8% in-network and 0% elsewhere. Those caps are still
    #: right. This term is VIEWER-OWN: only the viewer's own outgoing engagement
    #: moves it, so the worst an attacker achieves by moving it is changing their
    #: own feed. Self-harm, not an attack — which is why it can carry real weight
    #: where CF cannot. See recsys/core/viewer_affinity.py for the invariant.
    #:
    #: DEFAULT 0.0 = OFF, deliberately. At 0.0 `blend` returns the quality
    #: percentile unchanged, so every existing measurement, tuning table and
    #: panel reproduces bit-for-bit. Turning this on is a measured decision:
    #: raise it, re-run the composition-immune reads (mean_q@20, stack_capture_g,
    #: auc_own_m5) and require them flat-or-up. Own-topic share rising while
    #: mean_q falls is the documented REGRESSION signature and vetoes the change.
    #: Council C's stated target for a cold viewer is ~0.3.
    organic_viewer: float = 0.0

    #: Weights on DISTINCT-PERSON breadth inside the organic term (§6): how much
    #: one more independent voter / commenter / reblogger is worth. Previously
    #: module constants in `core/vote_signal.py`, so they could not be swept,
    #: A/B'd or rolled back without a code change — which is why they had never
    #: been swept.
    #:
    #: ★ AN OPEN CONTRADICTION, NOT A SETTLED TUNING (2026-08-01). At these
    #: values one upvoter is worth ~2 distinct commenters (measured marginal
    #: dfinal on real pool posts: +0.0639 per upvoter vs +0.0359 per commenter,
    #: ratio 0.562). The TRUST layer values the same two actions in the opposite
    #: direction and far more sharply — `RealGraphWeights.reply = 5.0` against
    #: `upvote = 1.0`. The two layers disagree about what a comment means by
    #: roughly 9x, and the product goal is explicitly to rank by where people
    #: comment and engage.
    #:
    #: Swept on the project's own instrument (production-shaped, 24 viewers), a
    #: reply weight of 0.5-0.8 is flat-or-BETTER on every column q7 treats as a
    #: decision column, while discussed posts rank far better:
    #:
    #:     reply_w   mean_q@20   ownAUC@5   own capture   corr(rank, comments)
    #:       0.30      0.7100     0.7430        0.8255                  0.2317
    #:       0.50      0.7109     0.7471        0.8293                  0.2930
    #:       0.80      0.7112     0.7509        0.8298                  0.3680
    #:
    #: NOT changed here, deliberately. The simulator generates comments with
    #: probability proportional to quality, so comments are a quality proxy BY
    #: CONSTRUCTION and the sweep cannot prove 0.8 is right on Hive — only that
    #: 0.3 is not the optimum of the project's own instrument. This is the same
    #: LIVE-DATA gate already applied to `organic_cf`. The knob now exists so the
    #: decision can be made on real data instead of a code edit.
    organic_voter_breadth: float = 0.5
    organic_reply_breadth: float = 0.3
    organic_reblog_breadth: float = 0.5
    organic_post_share: float = 1.0 / 3.0
    #: Shrinkage constant ``k`` for the author-pooled prior (2026-08-03). The
    #: leave-one-out mean is weighted ``(1 - organic_post_share) * n / (n + k)``
    #: where ``n`` is the number of OTHER window posts it is estimated from, so
    #: the prior earns its weight with evidence instead of taking a fixed two
    #: thirds from the author's second post onward. See
    #: :func:`recsys.core.scoring.pooled_author_base` for the full rationale.
    #:
    #: 0.0 reproduces the pre-shrinkage fixed blend byte-for-byte, so the
    #: k = 0 column below is also the control.
    #:
    #: SWEPT 2026-08-03 on `measurement-harness/q9_prior_shrinkage.py` over FOUR
    #: worlds (seeds 7/11/23/42), because one world would have picked a
    #: different k — seed 7 alone says 3, seed 11 says 2, seeds 23/42 say 5.
    #: Section A is q3's new-author panel at its hardest loadout (9 votes + 2
    #: comments + 1 reblog); section B is q8's protocol exactly (its k = 0
    #: column reproduces the standing q8 output to 4dp, which is what validates
    #: the sweep apparatus).
    #:
    #:   k     newcomer reaches top-20, by seed      largest k still clearing
    #:         s7      s11     s23     s42           q8's floors, by seed
    #:   0.0   0/10    0/10    0/10    0/10          s7: 8   s11: NONE
    #:   1.0   0/10    0/10    0/10    0/10          s23: 8  s42: 3
    #:   2.0   8/10   10/10    5/10    0/10
    #:   3.0  10/10   10/10    8/10    0/10   <- shipped
    #:   5.0  10/10   10/10   10/10   10/10
    #:
    #: 3.0 is the largest value that never costs the prior more than the
    #: project's own guard allows on ANY world it was measured on (seed 42
    #: binds: at k = 5 its depth-controlled picking delta falls to +0.0161,
    #: under q8's 0.020 floor). Going to 5 to buy the last two seeds' top-20
    #: would be buying newcomer reach by degrading the estimator past the bar
    #: this project set for it — and it would still have PASSED the seed-7-only
    #: q8 panel, which is exactly the "fix that passes its own test" failure
    #: this round keeps re-teaching.
    #:
    #: WHAT IT COSTS, stated plainly: the prior's contribution to delivered
    #: top-20 author quality gives back 15-26% (mean_q delta +0.0304 -> +0.0225
    #: at seed 7), i.e. ~0.008 absolute on a 0-1 quality scale. What it buys:
    #: the newcomer's pooled base goes from -66.7% of its own earned signal to
    #: -26.7% on every seed, and on the two seeds where top-20 is still missed
    #: the position moves from 64th/70th (invisible) to 20th/23rd.
    #:
    #: ★★ MEASURED LIMIT ON THE ABOVE (2026-08-03, council B, re-verified): the
    #: newcomer win is CONDITIONAL ON WHO ENGAGES THEM. q3/q9 source the debut
    #: post's votes from `a-photo-01..08`, who are established and graph-cred
    #: VOUCHED. Re-run with a brand-new audience carrying no other footprint —
    #: the realistic case in a young community, where the first arrivals are also
    #: new — the same loadout scores **0/10 top-20 AND 0/10 top-50 on seeds
    #: 7/11/23/42**, against 10/10/10/8/5 with an established audience. Cause is
    #: upstream of this field entirely: `VoterTrust.credited_breadth` caps
    #: UNVOUCHED engager breadth at `VoteSignalConfig.unknown_free = 1.0`
    #: regardless of how many there are (vote_signal.py's own docstring: "10 bare
    #: alts buy unknown_free breadth, not 10"), so `own_base` is already crushed
    #: before the prior blends anything. Shrinkage cannot lift what breadth
    #: budgeting has floored.
    #: **So: WHO engages a newcomer matters far more than HOW MANY do, and this
    #: field helps the discoverable-by-established case only.** Do not quote the
    #: 0/10 -> 10/10 figure without that condition attached.
    #:
    #: ★ NOT tuned to close the gap entirely — that needs the OTHER lever
    #: (excluding posts too young to have accumulated engagement), which
    #: targets the actual confound instead of discounting every thin-pool
    #: author symmetrically. It is LIVE-HAFSQL-GATED: simworld draws every
    #: post's engagement independently of the post's age, so post age carries
    #: no information here and a maturity horizon tuned on it would be tuned
    #: against nothing.
    organic_prior_shrinkage: float = 3.0
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
        if self.organic_prior_shrinkage < 0.0:
            raise ValueError(
                "organic_prior_shrinkage must be >= 0, got "
                f"{self.organic_prior_shrinkage}"
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
    """Out-of-network eligibility gates (§8).

    ★★ BOTH FLOORS ARE, IN PRACTICE, A TEST FOR "score == 0.0" — AND THAT IS THE
    ONLY COHERENT SETTING (measured 2026-08-04, closing cold-start spec item
    D2/B3 as WON'T-BUILD rather than leaving it open).

    D2 asked for these to become live percentiles — "vouch floor ≈
    bottom-30%-excluding, author floor ≈ bottom-10%-excluding" — with an
    acceptance test that each excludes a nonzero set. That test has always
    failed (0 of 180 accounts on seeds 7/11/23/42), and the reason is not a
    tuning miss: **the score distribution has a gap that makes the target
    unreachable.**

    `_normalize_scores` emits exactly three bands:

        0.0            proven self-dealing (0 accounts in an honest population)
        0.10           unknown / never-engaged  (23-35 of 180)
        0.1993 - 1.0   engaged, percentile-ranked  (145-157 of 180)

    Nothing ever lands strictly between 0.0 and 0.10. So a floor at 0.05
    excludes precisely the self-dealing band and can never exclude anyone else,
    and any floor raised far enough to bite the ENGAGED band must first pass
    0.10 and therefore removes **every newcomer and unknown account**:

        exclude bottom 10%  ->  floor 0.1000  (still only the 0.0 band)
        exclude bottom 20%  ->  floor 0.1993  ->  all 35 unknowns excluded
        exclude bottom 30%  ->  floor 0.3234  ->  all 35 unknowns excluded

    Since the unknown tier IS the newcomer on-ramp this project spends most of
    its effort protecting, a percentile floor cannot be adopted without undoing
    that work. The band design and the percentile-floor design are mutually
    exclusive; the bands won.

    Do not "fix" the acceptance test by raising these numbers. If a graded
    discount on low-standing authors is genuinely wanted, it belongs where the
    spec's §8.3(iv) put it — a soft ranking discount, not an eligibility gate —
    and that is a different mechanism from these two floors.
    """

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
    #: Geometric penalty on candidates from lanes the viewer did NOT ask for
    #: (``CandidateSource.is_viewer_chosen`` is False: OON_ENGAGED, OON_ALS,
    #: POPULAR_FALLBACK), counted across the whole served ordering — same shape
    #: as the author/topic penalties. ``floor = 1.0`` is an EXACT no-op.
    #:
    #: SWEPT 2026-08-03 on `measurement-harness/q11_follow_curve.py` (4 seeds x
    #: 2 topics, follow counts 1..20). "defect ratio" = on-topic share of the
    #: top-20 at 20 follows divided by at 1 follow; below 1.0 means following
    #: MORE people made the feed WORSE:
    #:
    #:   decay/floor   defect ratio   IN_NETWORK share @20   mean quality @20
    #:   1.0 / 1.00        0.395            0.306                 0.791   <- off
    #:   0.9 / 0.50        0.605            0.469                 0.773
    #:   0.8 / 0.40        0.766            0.594                 0.761   <- shipped
    #:   0.7 / 0.30        0.919            0.713                 0.744
    #:   0.6 / 0.25        1.008            0.781                 0.734
    #:   0.5 / 0.20        1.081            0.837                 0.729
    #:
    #: 0.8/0.40 is the knee: it closes most of the inversion (0.395 -> 0.766)
    #: and makes the viewer's own follows the MAJORITY of their feed again
    #: (0.306 -> 0.594) for a third of the quality cost the stronger settings
    #: pay. Marginal rate: off -> 0.8/0.40 buys +0.371 ratio for -0.030 quality;
    #: 0.8/0.40 -> 0.6/0.25 buys +0.242 more for another -0.027.
    #:
    #: ★ A REAL TRADE, NOT SOLD AS A FREE WIN. Measured against simworld's
    #: ground-truth author quality, the OON_ENGAGED lane genuinely does surface
    #: better authors — mean gap **+0.074** over IN_NETWORK across seeds
    #: 7/11/23/42 x 2 topics. So part of its score advantage is real merit and
    #: part is the selection artifact described in
    #: `CandidateSource.is_viewer_chosen`. What does NOT follow from a +0.074
    #: quality edge is 2.3x over-representation (33% of the pool taking 75% of
    #: the top 20). This corrects the over-representation, not the merit, and
    #: knowingly pays ~0.030 of delivered author quality to do it.
    #:
    #: The project's standing bar — "own-share UP, delivered quality DOWN is a
    #: REGRESSION" (see `organic_cf` above) — was set for a case where the
    #: quality drop bought NOTHING but a composition shift. Here it buys the
    #: product's core promise: that following someone determines what you see.
    #: This is therefore a deliberate, documented exception to that bar rather
    #: than an oversight. LIVE-DATA-GATED like every other composition knob.
    unchosen_source_decay: float = 0.8
    unchosen_source_floor: float = 0.4
    #: HARD cap: at most this many candidates from lanes the viewer never asked
    #: for, per `explore_window` slots of the served feed, enforced as a running
    #: prefix quota (so it binds at every depth, not only on page boundaries).
    #: 0 = off.
    #:
    #: WHY A CAP AS WELL AS THE PENALTY ABOVE. The penalty alone was measured
    #: insufficient: `OON_ENGAGED` still took 56% of the first page while the
    #: viewer's own follows took 38%, and the lane's share of the FEED was less
    #: on-topic (33%) than its share of the POOL (49%) — the ranker was
    #: selecting that lane's least relevant members. A geometric penalty nudges;
    #: this bounds. The lane is deliberately NOT removed: it is the
    #: second-degree discovery channel, the only route a brand-new author has
    #: into an established viewer's feed, and it does surface genuinely better
    #: authors (+0.074 ground-truth quality). Budgeted, it keeps that job
    #: without owning the page.
    #:
    #: SUPPLY-SAFE by construction — the cap is only enforced while a
    #: viewer-chosen candidate is still available, so a viewer whose own network
    #: is empty still gets a full feed.
    unchosen_max_per_page: int = 3
    top_k: int = 200

    #: How many of the FIRST PAGE's slots are reserved for exploration
    #: (2026-08-01). 0 = off, and off is the default.
    #:
    #: WHY THIS EXISTS. `rank_feed` is a pure function of its inputs, and the
    #: package contains no randomness, no session state and no impression memory
    #: — grep for "random", "seen", "impression": nothing outside comments. So
    #: two calls with the same inputs return byte-identical feeds BY
    #: CONSTRUCTION. Measured: a returning viewer's top-20 was identical across
    #: 77-79 of every 79 consecutive sessions, with the diversity re-ranker both
    #: ON and OFF, because the re-ranker shapes WHICH posts are frozen in, never
    #: whether the feed can change at all. Nothing in the pipeline generates new
    #: information, so nothing can dislodge an established ordering.
    #:
    #: Exploration is the only lever that gives an unexposed post any impression
    #: at all, which also makes it the only counterweight to the filter bubble
    #: the viewer-own affinity channel creates (see
    #: tests/test_engagement_drift.py's documented full-capture case).
    #:
    #: The slots are filled DETERMINISTICALLY per (viewer, session bucket): a
    #: refresh inside the bucket returns the same feed, so a user cannot re-roll
    #: for a better one, while a later session differs.
    explore_slots: int = 0

    #: Size of the exploration session bucket, in hours. Feeds vary between
    #: buckets and are stable within one.
    explore_bucket_hours: int = 6

    #: The visible window exploration is drawn INTO — the first page. Slots are
    #: taken from the tail of this window and filled from below it, so
    #: exploration costs the weakest visible items rather than the strongest.
    explore_window: int = 20

    def __post_init__(self) -> None:
        if not 0.0 < self.unchosen_source_decay <= 1.0:
            raise ValueError(
                "unchosen_source_decay must be in (0, 1], got "
                f"{self.unchosen_source_decay}"
            )
        if not 0.0 <= self.unchosen_source_floor <= 1.0:
            raise ValueError(
                "unchosen_source_floor must be in [0, 1], got "
                f"{self.unchosen_source_floor}"
            )
        if not 0.0 <= self.topic_affinity_strength <= 1.0:
            raise ValueError(
                f"topic_affinity_strength must be in [0, 1], got {self.topic_affinity_strength}"
            )


@dataclass(frozen=True)
class ExplorationConfig:
    """The reserved new-author slot (cold-start spec §4.3, item B12).

    A brand-new post is not blocked, it is OUTSCORED: with no engagement and no
    author history its organic raw is exactly `organic_recency` (0.10) against a
    window median near 0.46 — the 3rd-4th percentile, by construction. Sweeping
    `organic_recency` up to 2.0 was measured to cost nDCG at every step and STILL
    leave a followed author's fresh post at 0/40 first-page reach. A reserved
    slot is the only mechanism that reaches the page.

    `slots_per_page = 1` is the spec's instruction verbatim — "start at 1 slot,
    never 2" — and it is externally justified rather than guessed: YouTube's
    production fresh/tail slot cost -0.12% overall dwell for +2.52% fresh-content
    interactions and +5.5% small-provider dwell (Wang et al., KDD 2023);
    TikTok's manual heating ran ~1-2% of daily views; Meta's backlash arrived at
    tens-of-percent unconnected content. 0 disables the lane entirely.
    """

    slots_per_page: int = 1
    page_size: int = 20
    #: Deep enough not to displace the head, shallow enough to be seen.
    position: int = 13
    max_age_days: int = 7
    #: Per-author epoch budget. A farm cannot convert account count into slots
    #: because the rotation is round-robin over AUTHORS, but without this an
    #: author with many fresh posts could still take consecutive rounds.
    max_posts_per_author_epoch: int = 3

    def __post_init__(self) -> None:
        if self.slots_per_page < 0:
            raise ValueError(f"slots_per_page must be >= 0, got {self.slots_per_page}")
        if self.page_size <= 0:
            raise ValueError(f"page_size must be > 0, got {self.page_size}")
        if not 0 <= self.position < self.page_size:
            raise ValueError(
                f"position must be in [0, page_size); got {self.position} "
                f"with page_size {self.page_size}"
            )
        if self.max_age_days <= 0:
            raise ValueError(f"max_age_days must be > 0, got {self.max_age_days}")
        if self.max_posts_per_author_epoch <= 0:
            raise ValueError(
                "max_posts_per_author_epoch must be > 0, got "
                f"{self.max_posts_per_author_epoch}"
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

    #: How many hops of vouch propagation to walk out from ``trusted_seeds``
    #: (2026-08-01, directed-cycle fix).
    #:
    #: The vouched tier used to be "did this account receive engagement from
    #: outside its own detected ring". A DIRECTED cycle S0->S1->S2->S0 contains
    #: no reciprocal pair, so ``detect_rings`` finds no component, so each sock
    #: is "outside" the others and 3 accounts + 3 one-way upvotes vouched the
    #: whole cycle — buying unbounded breadth instead of the ~1.0 unknown cap.
    #:
    #: Vouch is now ANCHORED: it starts at ``trusted_seeds`` and propagates only
    #: to accounts engaged by someone already vouched. A closed sock cycle
    #: touches no seed and therefore never enters the set.
    #:
    #: BOUNDED ROUNDS ARE LOAD-BEARING, NOT A TUNING KNOB. Measured on the
    #: seed-7 world, if an attacker buys ONE genuine endorsement from a vouched
    #: account into the cycle: 3 rounds vouches 1 of 10 socks, 5 rounds vouches
    #: 3, and UNBOUNDED propagation vouches all 10 — i.e. transitive closure
    #: reopens the hole completely. One purchased endorsement must buy at most a
    #: few hops, so this is a cost multiplier on the attack, not a performance
    #: setting. Do not implement as a closure; do not raise casually.
    #:
    #: 3 measured as the sweet spot: identical honest coverage to the old rule
    #: (145/145 on the seed-7 world) with the attack fully closed (0/10 socks).
    vouch_max_rounds: int = 3

    #: Maximum accounts ONE voucher can transmit vouch to per propagation round.
    #:
    #: ★ THE BOUND THAT ACTUALLY BINDS (2026-08-01). ``vouch_max_rounds`` caps
    #: propagation DEPTH, and the attacker chooses the depth — so it bounded
    #: nothing. Breadth per round was unlimited: every account engaged by anyone
    #: already vouched was added, so one purchased (or merely reciprocated)
    #: endorsement plus a single hub vouched the hub's entire engagement list at
    #: depth 1. Measured against a real snapshot with real seeds:
    #:
    #:     attacker structure          socks   vouched
    #:     directed 10-cycle              10         0   <- the documented target
    #:     chain b=2 d=8                 511         7   <- the OLD fixture's shape
    #:     star  b=500 d=1               500       500   <- wide and shallow
    #:     star-of-stars b=50 d=2       2500      2500
    #:
    #: The old fixture was a chain, which is why depth looked like the binding
    #: constraint. It never was.
    #:
    #: Chosen on a measured sweep (3000-account honest worlds vs a 500-sock star
    #: one hop from one endorsement). A cap costs an honest graph NOTHING until
    #: it falls below that graph's own out-degree, while attacker reach falls
    #: linearly in the cap:
    #:
    #:     cap    honest fan-out 3 / 10 / 50      attacker star-500
    #:     none      1.3%  /  37.0%  /  100%                    500
    #:     100       1.3%  /  37.0%  /  100%                    200
    #:      50       1.3%  /  37.0%  /  100%                    100   <- shipped
    #:      25       1.3%  /  37.0%  /  71.7%                    50
    #:      10       1.3%  /  37.0%  /  14.0%                    20
    #:
    #: 50 is the tightest value that degraded NO honest topology measured, for a
    #: 5x cut in what one endorsement buys. Tighter is available and strictly
    #: safer if the honest cost turns out to be acceptable.
    #:
    #: ★ CALIBRATION STILL REQUIRED BEFORE LIVE USE. The honest worlds above are
    #: synthetic trees; Hive's real out-degree distribution has not been
    #: measured. A genuine high-volume curator may engage far more than 50
    #: distinct accounts per window, and every engagee past the cap simply goes
    #: un-vouched BY THEM (anyone else may still vouch them). Measure the real
    #: distribution, then set this above the honest bulk and below farm scale.
    #: Set to 0 to disable the cap entirely and restore the unbounded — and
    #: measurably vulnerable — behaviour.
    #:
    #: Ties are broken by graph-cred score, so a voucher spends its budget on
    #: its most credible engagees first — a sock swarm, whose members all sit at
    #: the same low score, cannot arrange to be preferred.
    vouch_max_fanout: int = 50

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
class RingConfig:
    """Knobs for the reciprocity/insularity ring detector (:mod:`recsys.core.ring`).

    ★ These were FUNCTION DEFAULTS with no Settings field at all (found
    2026-08-01): ``detect_rings(..., reciprocity_min=0.5, min_group=2)``, and the
    single production call passed neither. They could not be tuned, ablated or
    measured without editing code — which is precisely the shape the H01/F-R2
    hardening closed elsewhere.
    """

    #: How balanced a mutual pair must be to count as a ring edge: ``min/max``
    #: of the two directions' weights. 1.0 demands perfect symmetry; 0.0 accepts
    #: any mutual pair however lopsided.
    reciprocity_min: float = 0.5

    #: Smallest connected component treated as a ring. 2 = a mutual pair.
    min_group: int = 2

    def __post_init__(self) -> None:
        if not (0.0 <= self.reciprocity_min <= 1.0):
            raise ValueError(f"reciprocity_min must be in [0, 1], got {self.reciprocity_min}")
        if self.min_group < 2:
            raise ValueError(
                "min_group must be >= 2 (a ring needs two accounts), got "
                f"{self.min_group}"
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

    #: How many CF-affine authors to SOURCE candidates from (2026-08-01).
    #: 0 = off, and off is the default.
    #:
    #: `CandidateSource.OON_ALS` was declared, priority-mapped in
    #: `candidates.SOURCE_PRIORITY` and gated in `second_degree` — and produced
    #: by NOTHING. Collaborative filtering could only ever re-score posts that
    #: the follow graph, a subscription or a signup interest had already
    #: surfaced; it has never introduced a single post to anyone. So
    #: personalisation-by-DISCOVERY did not exist, and no weight change could
    #: create it, because the candidates were never in the pool to weight.
    #:
    #: `OON_ALS` requires_second_degree, so anything sourced here still clears
    #: the vouch gate and the graph-cred floor — the correct posture for a
    #: source driven by other people's co-engagement, and deliberately unlike
    #: the gate-exempt interest lane.
    als_source_authors: int = 0
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
    #: Separate, WIDER freshness window for the viewer's OWN FOLLOWS
    #: (``IN_NETWORK`` only). 0 = "use ``sourcing_freshness_days``", an exact
    #: no-op. See :func:`recsys.pipeline.gather_candidates`.
    #:
    #: WHY IT IS SEPARATE. `sourcing_freshness_days` gates EVERY source,
    #: including a viewer's own follows, so an author who does not post for
    #: three days disappears from the feed of people who explicitly asked to see
    #: them — not deprioritised, ABSENT. Measured 2026-08-03: **8-13% of authors
    #: are in that state at any moment** (seeds 7/11/23/42), at mean quality
    #: 0.55-0.60 — mid-tier working authors, not junk. Meanwhile
    #: `quality_prior_days` is 45 and `trust_days` is 365, so their reputation
    #: and graph-cred persist for months after their content becomes
    #: unreachable. Nothing justified one window doing both jobs.
    #:
    #: WHY NOT JUST WIDEN `sourcing_freshness_days`. Widening it globally
    #: measures as a strict improvement here (pool 62->114, in-network share of
    #: the top-20 0.400->0.480, mean quality 0.654->0.703 on seed 7) — but that
    #: is an INSTRUMENT ARTEFACT: simworld contains exactly 7 days of posts, so
    #: "widen to 7" means "use everything" and the discovery lanes cannot flood
    #: because there is nothing more to flood with. On the real chain widening
    #: every lane grows the pool without bound and surfaces stale strangers.
    #: A viewer's own follows are the one lane where a wider window is safe:
    #: they asked for those authors by name, and `organic_recency` still
    #: discounts age within the lane.
    #:
    #: MEASURED (2026-08-03, in-network widened alone, discovery held at 3):
    #:
    #:   days   pool   in-net share @20   mean q @20   hidden follows served
    #:   off      62         0.400           0.654            0.00
    #:   5        72         0.470           0.673            1.10
    #:   7        85         0.480           0.674            1.50   <- shipped
    #:   14       85         0.480           0.674            1.50
    #:
    #: (seed 7; seeds 11/23/42 agree — in-net share up on all four, mean quality
    #: UP on three and flat on the fourth, so unlike the unchosen-source penalty
    #: this one costs nothing measurable.) It also does NOT squeeze discovery:
    #: the pool grows rather than being reallocated.
    #:
    #: ★ 7 IS NOT A MEASURED OPTIMUM — simworld holds exactly 7 days of posts, so
    #: every value >= 7 is the same run and the ladder saturates. The choice is
    #: made on product grounds (a week is the natural "people I follow" cadence,
    #: and `sourcing_freshness_days`' own note calls ~a week the right horizon for
    #: deciding which posts appear) and is LIVE-DATA-GATED: on the real chain,
    #: re-measure pool size and staleness before trusting it.
    #:
    #: ★ TWO THINGS A SCRUTINIZER FOUND, STATED RATHER THAN BURIED (2026-08-04):
    #:
    #: (a) **A HIGH-FREQUENCY FOLLOWED AUTHOR'S SHARE SCALES WITH THIS WINDOW,
    #: and nothing caps it.** `IN_NETWORK` is exempt from `cap_oon_flooding`
    #: (which keys on `requires_author_floor`) AND from the unchosen-source
    #: penalty (`is_viewer_chosen` is True for it), so its only bound is the
    #: author-diversity floor — and `author_floor=0.25` bottoms the penalty out
    #: rather than blocking. Widening 3 -> 7 days roughly doubles a daily
    #: poster's supply while a weekly poster gains nothing, so their share of a
    #: follower's first page rises. Whether that is correct is genuinely
    #: arguable — the viewer did follow them — but it is the "own-share up"
    #: composition shift this file calls a regression pattern elsewhere, so it
    #: is named here rather than left to be discovered.
    #:
    #: (b) **The standard panels CANNOT measure (a).** Every `q*.py` panel and
    #: every test passes an explicit `since=EPOCH`, and the widening is computed
    #: relative to the caller's `since`, so on those callers it is a byte-
    #: identical no-op (q7's `distinct authors @20` is 18.333 before and after).
    #: Only `rank_feed`'s own default (`since=None`) exercises it. The window
    #: arithmetic is therefore pinned directly by
    #: tests/test_config_windows.py rather than by any panel — do not assume a
    #: green panel run says anything about this field.
    in_network_freshness_days: int = 7

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
        # 0 means "same as sourcing". Anything else must be WIDER (never
        # narrower — a viewer's own follows must not be gated harder than
        # strangers) and must not outrun the quality-prior horizon.
        if self.in_network_freshness_days and not (
            self.sourcing_freshness_days
            <= self.in_network_freshness_days
            <= self.quality_prior_days
        ):
            raise ValueError(
                "in_network_freshness_days must be 0 (= sourcing) or satisfy "
                "sourcing_freshness_days <= in_network_freshness_days <= "
                f"quality_prior_days; got {self.in_network_freshness_days}"
            )


@dataclass(frozen=True)
class LiteConfig:
    """Lumen Lite reachability (§E.4). OFF by default — see the rollout note.

    ★★ THE PROBLEM. Lite users have no Hive account. Every lite post is
    published by a SHARED frontend account as a depth-1 COMMENT under a rolling
    container post (`<publisher>/lumen-c-<ulid>`), because Hive caps root posts
    at one per 5 minutes per account but replies at one per 3 seconds — the
    container model is what takes the ceiling from 12/hour to ~1200/hour. That
    is verified on mainnet (`CONTAINER-POST-MAP-2026-07-27.md`).

    Two consequences made the entire Lite tier invisible to ranking:

      * every candidate query filters `parent_author = ''`, so no lite post has
        ever entered `gather_candidates`;
      * a lite post's chain AUTHOR is the publisher account, not the writer, so
        even if sourced, all engagement and all graph-cred would collapse onto
        one account and every real lite user would score zero.

    Worse than invisible: `_SQL_COMMENTS_FOR_POSTS` counts rows with
    `parent_author <> ''`, so each lite post was counted as a COMMENT ON ITS
    CONTAINER — lite writers were inflating the publisher's organic score.

    THE FIX IS ON-CHAIN, NOT CROSS-DATABASE. `publisher/footer.ts` writes
    `json_metadata.lumen_user_id` on every lite post, and HAFSQL stores
    json_metadata, so the writer's identity is recoverable in the same query
    that sources the post. No join against Lumen's Postgres, no ingestion job,
    no new failure mode — the chain is the source of truth. (`lib/lite/recsys/
    resolver.ts` was built for a cross-DB version of this and has zero
    consumers; it is not needed for sourcing.)

    THE TRUST BOUNDARY IS `publisher_accounts`, AND IT IS LOAD-BEARING.
    `json_metadata` is attacker-controlled: anyone may publish a comment
    claiming `app = lumen/1.0` and any `lumen_user_id` they like. The claim is
    therefore honoured ONLY when the post's chain author is a configured
    publisher account. Leave this empty and lite sourcing is off entirely —
    which is the default, so this change is inert until someone deliberately
    names the publishers.

    ACCEPTED LIMITATION: a comment inherits its category from the container
    root, so lite posts sit in category `lumen` and can never match a `hive-*`
    community. They are reachable via the tag, in-network and engaged lanes —
    not via the community lane. That is a property of the container model, not
    of this config.
    """

    publisher_accounts: frozenset[str] = frozenset()
    app_id: str = "lumen/1.0"

    @property
    def enabled(self) -> bool:
        return bool(self.publisher_accounts)


@dataclass(frozen=True)
class Settings:
    """Root config object threaded through the pipeline."""

    weights: ScoreWeights = field(default_factory=ScoreWeights)
    norm: NormConfig = field(default_factory=NormConfig)
    history: HistoryWindows = field(default_factory=HistoryWindows)
    thresholds: Thresholds = field(default_factory=Thresholds)
    diversity: DiversityConfig = field(default_factory=DiversityConfig)
    cold_start: ColdStartConfig = field(default_factory=ColdStartConfig)
    exploration: ExplorationConfig = field(default_factory=ExplorationConfig)
    fallback: FallbackConfig = field(default_factory=FallbackConfig)
    real_graph: RealGraphWeights = field(default_factory=RealGraphWeights)
    graph_cred: GraphCredConfig = field(default_factory=GraphCredConfig)
    flooding: FloodingConfig = field(default_factory=FloodingConfig)
    ring: RingConfig = field(default_factory=RingConfig)
    als: ALSConfig = field(default_factory=ALSConfig)
    vote_signal: VoteSignalConfig = field(default_factory=VoteSignalConfig)
    hafsql: HafsqlConfig = field(default_factory=HafsqlConfig)
    lite: LiteConfig = field(default_factory=LiteConfig)


DEFAULT_SETTINGS = Settings()
