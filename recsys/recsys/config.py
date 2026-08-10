"""Tunable Phase-0 configuration.

All values are *hand-tuned starting points* (Phase 2 / LightGBM learns them).
Immutable dataclasses; construct a custom :class:`Settings` to override, or
load secrets from the environment in production (see :class:`HafsqlConfig`).
"""

from __future__ import annotations

import importlib.resources
import os
from dataclasses import dataclass, field, replace

#: Floor on the curated seed list (C5, R13/R2). Below this the list is not a
#: meaningfully-sized trust root — refuse to load rather than silently run
#: `build_trust_snapshot(production=True)` off a handful of accounts. See
#: `recsys/data/trusted_seeds.txt`'s own header and
#: O:/LUMEN-DOCS/algo-tests/TRUSTED-SEEDS-2026-08-04.md for composition.
#: Smallest seed list that can honestly serve as a trust root. PUBLIC as of
#: 2026-08-05 (C4): `recsys.jobs.trust_batch` has its OWN loader on the
#: production path and must enforce the SAME floor. Two loaders with two
#: different contracts is how `_MIN_TRUSTED_SEEDS` came to be inert exactly
#: where it mattered — see `trust_batch.load_trusted_seeds`.
MIN_TRUSTED_SEEDS = 25
#: Backwards-compatible private alias; prefer the public name.
_MIN_TRUSTED_SEEDS = MIN_TRUSTED_SEEDS


def _load_trusted_seeds() -> frozenset[str]:
    """Load the curated, operator-approved trust-root seed list (C5, R2, R13):
    one Hive account per line, ``#`` comments and blank lines ignored.

    ★ Read via :mod:`importlib.resources`, NOT a path built off ``__file__``.
    A filesystem-relative path resolves fine from a repo checkout and then
    silently misses the file once the package is installed from a wheel/sdist
    elsewhere on disk — exactly the "works on my machine, breaks in prod"
    packaging trap. ``recsys/data/trusted_seeds.txt`` ships as package data
    via ``[tool.setuptools.package-data]`` in ``pyproject.toml`` so this
    resolves identically in both cases.

    ★★ THIS IS THE ONLY SANCTIONED WAY seeds enter the system. It reads a
    file a human wrote and reviewed; it computes nothing from chain data. The
    ruling this must never violate (``build_trust_snapshot``'s own docstring,
    2026-08-03): auto-DERIVING a seed rule from data puts the trust root up
    for sale, because whatever rule picks seeds is exactly what an attacker
    buys. A human-curated file is not derivation.

    Refuses (raises ``ValueError``) below ``_MIN_TRUSTED_SEEDS`` — a short
    list is not a trust root, it is a config typo waiting to fail shut on
    every account at once, and that should be loud at import time rather than
    discovered the first time `production=True` refuses every request.
    """
    raw = (
        importlib.resources.files("recsys")
        .joinpath("data", "trusted_seeds.txt")
        .read_text(encoding="utf-8")
    )
    seeds: set[str] = set()
    for line in raw.splitlines():
        account = line.split("#", 1)[0].strip()
        if account:
            seeds.add(account)
    if len(seeds) < _MIN_TRUSTED_SEEDS:
        raise ValueError(
            f"recsys/data/trusted_seeds.txt has only {len(seeds)} accounts "
            f"(minimum {_MIN_TRUSTED_SEEDS}) — refusing to load a seed list too "
            "short to be a meaningful trust root. See TRUSTED-SEEDS-*.md."
        )
    return frozenset(seeds)


@dataclass(frozen=True)
class ScoreWeights:
    """The §0 outer composition: a stake term capped at
    ``vote_share_of_final`` of ``final``, and the remaining mass split between
    reputation and organic in the ``reputation : organic`` ratio.

    ★ IT IS NO LONGER "10 / 10 / 80, must sum to 1.0" (2026-08-10, PRUNED R4).
    Those three literals were the weights ``earned`` applied, and ``earned`` is
    not ``final`` — two conditional blends sit between them, so a fixed triple
    could only hold the owner's stake cap on one of four candidate paths (see
    :attr:`vote_share_of_final`). ``score_candidate`` now solves the triple per
    path; ``reputation`` and ``organic`` set the ratio it splits the remainder
    in, and ``organic`` additionally keeps its absolute meaning as the base of
    ``interest_weight``.

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
    [0, 1] and the outer blend keeps its meaning.

    ``organic_cf_oon_scale`` (§H06, PRUNED audit 2026-07-22) additionally
    scales ``organic_cf`` DOWN for every candidate source that is not
    ``IN_NETWORK`` — the second-degree-gate-exempt ``INTEREST_*``/OON lanes
    where CF is most exposed to un-vetted, one-directional co-engagement
    (see :func:`recsys.core.scoring.score_candidate` and the field's own
    docstring below). ``IN_NETWORK`` candidates are always scaled by exactly
    1.0, so the formula above is unchanged for them.
    """

    #: ★★★ PAYOUT/STAKE = 10% OF THE FINAL SCORE (2026-08-09, owner: "make
    #: payout amount something like 10% of overall ranking").
    #:
    #: This is the STAKE term — the rshares a post drew, i.e. its payout. It is
    #: the most purchasable number on Hive (vote selling, trails, curation
    #: bots), so it is deliberately a MINORITY signal — but not zero: a post
    #: nobody paid anything for is still weaker evidence than one people put
    #: real stake behind, and zeroing it threw that away entirely.
    #:
    #: ★ THE NUMBER IS 10% OF `final`, NOT 10% OF `earned` — they are different
    #: and the difference is what made a bare `vote = 0.10` misleading. `final =
    #: (1 - W)*earned + W*interest_pct` where `W = organic * interest_match`
    #: (scoring.py), so a `0.10` weight inside `earned` was only 6.8% of what a
    #: reader actually sees.
    #:
    #: ★★★ IT IS NOW THE TARGET ITSELF, NOT A PRE-SOLVED WEIGHT (2026-08-10,
    #: PRUNED R4). This field used to be the weight `earned` applies, hand-solved
    #: to `0.1434` so that `(1 - 0.7566*0.4) * 0.1434 = 0.1000` on ONE path. The
    #: solve was correct for that path and wrong for the other three, because
    #: both scalings between `earned` and `final` are CONDITIONAL:
    #:
    #:     interest blend   skipped when `pipeline._interest_lookup` returns None
    #:                      — i.e. for any viewer who declared no interest tags
    #:     in-network blend applied only to `CandidateSource.IN_NETWORK`
    #:
    #: so the realised stake share of `final` was, measured:
    #:
    #:     interest tags + OON        0.1434 * 0.69736          = 0.10000  ✔
    #:     interest tags + IN_NETWORK 0.1434 * 0.95 * 0.69736   = 0.09500
    #:     no tags       + OON        0.1434                    = 0.14340  (+43%)
    #:     no tags       + IN_NETWORK 0.1434 * 0.95             = 0.13623
    #:
    #: A viewer who skips the interest picker therefore got 43% more of the most
    #: purchasable number on Hive than the owner capped it at — the opposite of
    #: what this field exists to enforce.
    #:
    #: So the field now states the OWNER'S NUMBER and `score_candidate` solves
    #: for the `earned` weight per candidate path (`_earned_weights`): it divides
    #: this target by whatever scaling that path actually applies, and hands the
    #: remaining mass to reputation and organic in their configured ratio. The
    #: solve is re-derived per request from the live config, so `interest_match`
    #: or `in_network_bonus` moving can no longer silently drift the 10% — the
    #: invariant `__post_init__` checks is that the WORST path is still solvable.
    #:
    #: On the one path the old constant was right for, the derived weight is
    #: 0.14339796 against the hand-rounded 0.1434 — a 2.04e-6 difference, which
    #: is the rounding error in the old literal, corrected.
    vote_share_of_final: float = 0.10
    #: ★ `reputation` and `organic` are the RATIO in which the non-stake mass of
    #: `earned` is split (2026-08-10). They no longer have to sum to 1.0 with the
    #: stake weight, because the stake weight is now path-dependent. `organic`
    #: keeps its ABSOLUTE meaning as well: `interest_weight = organic *
    #: interest_match` (see `interest_match`), which is deliberately left reading
    #: the CONFIGURED value rather than the per-path effective one, so the
    #: declared-interest term's contribution to `final` is byte-identical to what
    #: it was before this change on every path.
    reputation: float = 0.10
    #: Distinct independent people who voted, commented or reblogged — graph-cred
    #: budgeted, self/ring/banned excluded, and a voter must clear the 100 HP
    #: dust floor to count as a person at all. Ten bots are worth nothing here.
    organic: float = 0.7566
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

    #: ★ B-02 (2026-08-04) — the declared-interest term. Weight of the viewer's
    #: DECLARED-INTEREST percentile, applied as
    #: ``final = blend(earned, interest_pct, organic * w)`` — i.e. it blends
    #: against the finished EARNED composite (see
    #: :func:`recsys.core.scoring.score_candidate`), NOT against the organic
    #: slice alone. Its contribution to ``final`` is ``organic * w *
    #: interest_pct``, exactly what the original in-organic form contributed,
    #: so the VALUE of this field means the same thing it always did.
    #:
    #: ★★ RE-BASED FROM THE ORGANIC SLICE TO THE COMPOSITE (2026-08-05) —
    #: see `score_candidate`'s docstring for the measurement. The short form:
    #: this term is nearly CONSTANT inside a topic, so within the ~89% of a
    #: served feed that is on-interest it supplied no ordering while still
    #: taking 40% of the organic slice. That left the DISCRIMINATING weights in
    #: that block at ``0.10 vote / 0.10 rep / 0.48 quality`` — vote and
    #: reputation silently amplified 1.67x, paid for entirely by the quality
    #: percentile, which is where the author-pooled prior lives. Blending
    #: against the composite scales all three earned signals identically, so
    #: the balance among them now survives every value of this field.
    #: This is a re-basing of what the term takes its weight FROM; it is not a
    #: change in the term's strength (the gap it opens between an on-interest
    #: and an off-interest candidate is unchanged, pinned by
    #: ``test_interest_terms_contribution_to_final_is_unchanged_by_the_re_basing``).
    #:
    #: WHY THIS IS THE REAL FIX FOR "following more people makes the feed
    #: worse" (measured, `O:/LUMEN-DOCS/algo-tests/BUILDMAP-B-QUALITY-2026-08-04.md`
    #: §0/B-02): nothing in `score_candidate` read `viewer.interest_tags` at
    #: all before this field — declared interests affected pool MEMBERSHIP
    #: only, never rank. Two accounts with identical follows got the identical
    #: top-20 set 33/48 of the time (Spearman 0.955): ~94% of the average
    #: served slot's score was viewer-blind. A hard per-page quota on
    #: off-interest content (`DiversityConfig.unchosen_max_share` et al.)
    #: cannot fix that on its own — the measured frontier is that the reader
    #: wants a tight quota (~1/page) while a new author needs a loose one
    #: (>=5/page), and a quota has no way to tell a RELEVANT unchosen post from
    #: an irrelevant one. This term gives the score itself a way to prefer an
    #: on-topic out-of-network post over an off-topic one, so the quota only
    #: has to arbitrate between posts that already cleared a relevance bar.
    #:
    #: RAW: :func:`recsys.core.viewer_affinity`-style — see
    #: :func:`recsys.core.scoring.declared_interest_raw`. ★ REBUILT 2026-08-08:
    #: the RARITY of the rarest interest the post actually claims
    #: (``max over (post.tags ∩ interest_tags) of tag_rarity_weight``), NOT the
    #: share ``|post.tags ∩ interest_tags| / |post.tags|`` it was until then.
    #: The share form could not tell a topic from a namespace — `hive` is worn
    #: by 10.6% of every root post on the chain, 13 of 20 posts on the owner's
    #: own served page carried it, and a post tagged `[hive]` scored a perfect
    #: 1.000 — and its denominator punished a post that described itself with 8
    #: honest tags 8:1 against that. See that function's docstring for the
    #: measurement, the spray bound that replaced the denominator, and the proof
    #: that the rebuild carries NO tuning constant (the caller percentile-ranks
    #: the raw, and `max` commutes with any monotone rescaling of the weight, so
    #: the served order is invariant to it). Still 0.0 when the
    #: viewer declared nothing or the post carries no tags. Percentile-ranked
    #: WITHIN THE REQUEST'S OWN POOL (:func:`recsys.pipeline._interest_lookup`,
    #: reusing :func:`recsys.core.viewer_affinity.affinity_percentiles` — the
    #: same doctrine `viewer_affinity_percentiles` uses for CF: a raw bump
    #: ranked against the wrong distribution either saturates or, since this
    #: raw is already bounded to [0, 1], compresses everyone toward the same
    #: value in a mostly-on-topic pool with no percentile step to spread it).
    #:
    #: DEFAULT-OFF IS BYTE-IDENTICAL (mandatory invariant, pinned by
    #: ``test_interest_match_zero_is_byte_identical_to_the_pre_b02_score`` in
    #: ``tests/test_scoring.py``): ``blend`` returns the input unchanged at
    #: weight <= 0.0 or a ``None`` percentile, so every existing panel/pin at
    #: ``interest_match = 0.0`` reproduces to 4dp.
    #:
    #: IT IS VIEWER-OWN, NOT CROSS-VIEWER, unlike CF: only the viewer's OWN
    #: signup choice of ``interest_tags`` moves it, so no stranger can move
    #: another viewer's feed through it — the same self-harm-only posture
    #: ``organic_viewer`` documents below.
    #:
    #: ★ THE CEILING, STATED HONESTLY (per the build map: "say in the
    #: docstring what bounds this"). ``post.tags`` is attacker-controlled free
    #: text — any author may tag a post with every popular interest. UNTIL
    #: 2026-08-08 the `len(post.tags)` denominator was the stated bound, and it
    #: bounded the wrong case: it only ever charged for spraying tags OUTSIDE
    #: the viewer's interests, so a post carrying the viewer's interests and
    #: NOTHING else scored a perfect 1.000 however many it sprayed — the
    #: pre-existing tag-stuffing test asserted exactly that, at 1.0.
    #:
    #: The bound is now on the case that was open: the raw is a `max`, so the
    #: 2nd..kth sprayed interest tag is worth EXACTLY ZERO. A post claiming all
    #: six of a viewer's interests scores precisely what the single rarest of
    #: them scores and can never out-rank an honest post carrying that same
    #: tag. That is strictly stronger than the denominator was, and it is why
    #: no rarity-weighted SUM form (`min(hits, k)/k`, noisy-OR, decayed sums)
    #: was acceptable — each of them lets a sprayer beat an honest single-topic
    #: post. It is also the trade the gate-EXEMPT exploration lane
    #: (`core/exploration.py::_interest_match`, BUILD-ADJUDICATION R3) already
    #: made when it restricted itself to the PRIMARY tag only. This term does
    #: NOT bypass the vouch gate or the author floor (it only re-ranks
    #: candidates that already cleared them, same as
    #: `organic_cf`/`organic_viewer`), so it is free to look at the whole
    #: intersection — it just takes the best of it rather than the sum.
    #:
    #: ★ RARITY IS NOT SEMANTICS, and the split is deliberate.
    #: `tag_rarity_weight` cannot tell a niche topic from a mechanical marker
    #: (`hiveposh`, df 9, means only "cross-posted to Twitter" and would score
    #: 0.61). That is handled at DERIVATION
    #: (`recsys.viewer.derive_interest_tags`, which refuses to INFER a
    #: non-topical tag as somebody's interest) and deliberately NOT here: an
    #: interest a viewer picked EXPLICITLY is their own word and is honoured at
    #: whatever rarity it has — the signup picker really does offer "Hive
    #: Community".
    #:
    #: ★★ SHIPPED VALUE IS **NOT** SWEPT AGAINST TAG NOISE (B-17, unbuilt as of
    #: this weight's selection, 2026-08-04). simworld gives every post exactly
    #: 2 tags with `tags[0]` always the true topic (100% purity, verified
    #: 4/4 seeds) — a world where tag-stuffing is structurally unmodelled. It
    #: is therefore LIVE-DATA-GATED on the SAME terms as `organic_cf`:
    #: re-derive (or down-weight) once B-17's noisy-tag instrument exists.
    #: Nothing here should be read as a claim that the value is farming-proof;
    #: only that the byte-identity-at-0.0 safety net and the primary-tag-only
    #: exploration lane already absorb the sharpest form of the exploit
    #: (tag-spraying a brand-new, gate-exempt post to reach everyone on page
    #: one).
    #:
    #: SWEPT 2026-08-04 jointly with `unchosen_max_share`/`unchosen_min_per_page`/
    #: `unchosen_displacement_ratio` and `emerging_per_page` below, on q3's
    #: newcomer rung (real accounts, both an established and a fresh audience,
    #: seeds 7/11/23/42, 9 distinct voters + 2 comments + 1 reblog) crossed
    #: against `measurement-harness/q11_follow_curve.py`'s SHIPPED-arm
    #: monotonicity self-check. ★★ THE SWEEP WAS RE-RUN after
    #: `unchosen_max_share`/`unchosen_min_per_page` were corrected to their
    #: byte-compatible values (0.0/3 — see that field's docstring for why);
    #: the first-draft numbers below (measured at share=0.15/min=1, since
    #: retracted) were WORSE on every axis and are not reproduced here:
    #:
    #:   interest_match   newcomer top-20/40   q11 violations (of 8 gaps)
    #:        0.0                 —                       2
    #:        0.3                 —                       4
    #:   ★     0.4               40/40                    3      <- shipped
    #:
    #: (newcomer frontier only measured at 0.4 in the re-run; the 0.0/0.3 rows
    #: are carried from the reader-curve-only sweep at the byte-compatible
    #: quota base.) NO VALUE TESTED MAKES q11 EXIT 0 — stated plainly, not
    #: hidden; the residual violations (n0->n1/n2 and n12->n20, on the shipped
    #: value) are reported honestly in this builder's session report.
    #:
    #: ★★★ THE "IN_NETWORK is exempt" MECHANISM HYPOTHESIS ABOVE WAS TESTED,
    #: NOT INHERITED, AND IS REFUTED (2026-08-04, Builder A). A direct
    #: source-level breakdown of the SHIPPED-arm top-20 (per-source mean_rel
    #: AND share at every follow count, 4 seeds x 2 topics) shows
    #: `IN_NETWORK`'s OWN relevance is NOT the low outlier the hypothesis
    #: predicted — at n=1/2/3/5 it is `OON_ENGAGED` that scores lowest among
    #: present sources, and at the endpoint (n=20, where `IN_NETWORK` finally
    #: holds 80% of the feed) `IN_NETWORK`'s own mean_rel (0.672) is the
    #: HIGHEST of any source present, while `OON_ENGAGED` — still holding its
    #: floor-mandated minimum share — collapses to 0.067. The two real,
    #: measured drivers are different from the inherited hypothesis:
    #: (1) a LANE-TRANSITION effect at n=0->n=1/2 — going from the fully
    #: gate-exempt `INTEREST_TAG` pool (n=0, no follow graph) to the
    #: author-floor-gated `OON_INTEREST` pool plus newly-introduced
    #: `IN_NETWORK`/`OON_ENGAGED` lanes (n>=1) shifts composition and the
    #: request-scoped interest percentile at the same moment, independent of
    #: `IN_NETWORK` volume (which is still only 5% of the feed at n=1); and
    #: (2) `DiversityConfig.unchosen_min_per_page` (currently 3) is a FLOOR,
    #: not a ceiling — it forces a minimum 3-of-20 (15%) allocation to
    #: unchosen lanes at EVERY follow count regardless of whether anything
    #: good remains there, and by n=20 the surviving `OON_ENGAGED` candidates
    #: for that floor are visibly poor (0.067 mean_rel). Lowering
    #: `unchosen_min_per_page` (tested 0/1/2 at im=0.2 and 0.4) does shrink the
    #: endpoint drop (e.g. im=0.4: endpoint delta -0.1193 at min=3 -> -0.0713
    #: at min=1) but costs newcomer reach hard (24/40 -> 8/40) and, at im=0.4,
    #: turns some of q10's worlds NEGATIVE that were positive at min=3 — a
    #: worse trade on the axes this map already prioritizes, so the field was
    #: left at its shipped value; this is recorded here as a real, measured
    #: lever for whoever revisits the follow-curve residual next, not a
    #: forgotten idea.
    #:
    #: 0.4 IS THE VALUE CHOSEN: at the byte-compatible quota base it clears
    #: BOTH the ORIGINAL "must not regress" numeric bar this field's own map
    #: set (`rel@20 >= 0.594` at n=5, `>= 0.614` at n=9 — measures 0.608/0.622
    #: here) AND B-04's own newcomer acceptance number (`top-20 >= 30/40`,
    #: measures 40/40 — full success), a dramatic, real improvement over the
    #: `0/10` (single-seed q3 panel) / `0/40` (this sweep) the pre-B-02/03/04
    #: `unchosen_max_per_page=3` config delivered on the SAME rung.
    #:
    #: ★★★ 2026-08-04 JOINT SWEEP (Builder A) — CONFIRMS 0.4 IS PARETO-OPTIMAL
    #: FOR THIS TRADE, NOT JUST "THE VALUE THAT PASSED AT THE TIME". Crossed
    #: this field (0.0-0.4) against `organic_prior_shrinkage`, `organic_post_
    #: share`, and the FULL `DiversityConfig.unchosen_*`/`emerging_per_page`
    #: family, always measuring q10 (`measurement-harness/
    #: q10_prior_robustness.py`, now 7 worlds — see that file's own 2026-08-04
    #: addendum for a SEEDS-coverage gap this sweep also found and closed),
    #: q11 (this field's own table above), and newcomer reach together. Result:
    #: newcomer reach and q10's cross-world robustness move in DIRECT,
    #: near-monotonic opposition as this field rises, and no other knob in the
    #: swept space breaks that opposition — shrinkage/post_share move q10 by
    #: <0.001 at fixed `interest_match` (an order of magnitude below this
    #: field's own effect), and loosening the unchosen quota's
    #: `unchosen_displacement_ratio` improves q10's numbers only by
    #: reproducing the un-quota'd, WORSE q11 curve (its own docstring already
    #: predicted this; re-confirmed directly). No point tested clears q11's
    #: monotonicity self-check at all. 0.4 remains shipped because it is the
    #: only tested point with both zero negative-world `stack_capture_g` on
    #: q10's PRE-2026-08-04 seeds and newcomer reach >=20/40 — i.e. already
    #: Pareto-optimal among everything tried, not merely convenient. This is a
    #: genuine three-way product trade (reader relevance / newcomer reach /
    #: prior robustness); treat it as one, not as a bug still waiting for the
    #: right knob value.
    #:
    #: ★★★ 2026-08-05 — THE "THREE-WAY TRADE" ABOVE WAS NOT A TRADE. IT WAS A
    #: SEAM, AND IT IS CLOSED. THIS FIELD'S VALUE IS UNCHANGED AT 0.4.
    #: The joint sweep above was right that no value of any knob resolved the
    #: conflict, and wrong about why: it searched the parameter space of a
    #: mechanism that was miswired. Decomposed over 32 worlds x 24 viewers,
    #: the whole of this field's cost to the pooled prior ran through ONE
    #: interaction — the re-ranker's MULTIPLICATIVE author-repeat penalty. With
    #: that penalty switched off, this field costs own-stratum quality capture
    #: 0.9188 -> 0.9191 (i.e. NOTHING) and the prior is worth +0.0196 here
    #: versus +0.0200 at ``interest_match = 0.0``. The prior was never
    #: redundant and was never "front-run" by this term on shared information:
    #: it was MASKED by a penalty this term had silently doubled the strength
    #: of, by adding a flat offset to a score that penalty multiplies.
    #: Fixed in `core/rerank.py::_effective_score` (the author and
    #: unchosen-lane penalties now discount the EARNED part of the score only)
    #: and `_topic_affinities` (inference reads earned mass, closing a
    #: second loop where this term switched off its own topic penalty), plus
    #: the composite re-basing described at the head of this docstring. Result
    #: over the same 32 worlds, at this field's UNCHANGED 0.4:
    #:
    #:   metric               BEFORE (2026-08-04)      AFTER (2026-08-05)
    #:   mean_q delta       min +0.0024 mean +0.0078   min +0.0069 mean +0.0128
    #:   stack_capture_g    min -0.0045 mean +0.0049   min +0.0061 mean +0.0137
    #:   negative worlds    5 of 32                    0 of 32
    #:
    #: q10 is GREEN on its own untouched floors; q11's follow-curve violations
    #: went 4 -> 2 (the n0->n1 and n1->n2 ones this docstring reports above as
    #: residual are GONE, and rel@20 rose 0.5645 -> 0.5939); q3's newcomer rung
    #: went 9/10 -> 10/10 established and 7/10 -> 10/10 on the FRESH audience
    #: this file's `organic_prior_shrinkage` note calls the realistic case.
    #: Nothing here argues for moving this field; it argues that the frontier
    #: it was measured against was an artifact.
    #: ★★★ C1 (2026-08-05) — THE AXIS THIS SWEEP TABLE WAS MISSING.
    #:
    #: Every sweep recorded for this field measured relevance, quality and the
    #: follow curve. NONE of them measured AUTHOR DIVERSITY, and there is a real
    #: interaction: `_effective_score` is
    #: ``(earned * pen_a * pen_u + interest_bonus) * pen_t``, so the offset is
    #: deliberately immune to the AUTHOR penalty (see that function's docstring
    #: for the measured reason). The reciprocal was never priced — because the
    #: offset is added AFTER the author penalty, a prolific ON-interest author's
    #: repeat competes against an OFF-interest rival that receives no offset at
    #: all, so a large enough offset lets the repeat win.
    #:
    #: MEASURED (1 prolific on-interest author vs 30 off-interest rivals, 20
    #: slots — `tests/test_rerank.py::_interest_diversity_probe`):
    #:
    #:     interest_match | distinct authors@20 | slots to the prolific author
    #:              0.00  |                 20  |  1
    #:              0.40  |                 20  |  1   <- SHIPPED, no cost
    #:              0.50  |                 20  |  1
    #:              0.60  |                 19  |  2
    #:              0.80  |                 19  |  2
    #:
    #: So the shipped value is CLEAR of the interaction — this is not a live
    #: defect, and the 2026-08-05 council's report of a one-slot cost at 0.4 did
    #: not reproduce. Degradation begins at 0.6. Raising this field past 0.5
    #: trades author diversity and must be a stated decision, not a sweep
    #: outcome: `test_the_shipped_interest_match_costs_no_author_diversity`
    #: fails if the shipped value moves into that region.
    interest_match: float = 0.4

    #: Weight of the VIEWER-OWN affinity percentile inside the organic slice
    #: (2026-08-01). Applied as `organic = blend(quality_pct, viewer_pct, w)`,
    #: i.e. it trades against the quality percentile only — the outer split and
    #: `organic_cf` are untouched.
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
    #: ★ TURNED ON 2026-08-08 (owner: "wire the fucking social graph right
    #: now"). 0.0 -> 0.3, Council C's stated cold-viewer target. Before this,
    #: who you actually engage with contributed EXACTLY NOTHING to your rank:
    #: measured final weights were organic 54.4% / interest-tag 32% / vote 6.8%
    #: / reputation 6.8% / your own engagement history 0%. Costs no extra query
    #: — the edges are already in the trust snapshot (`_viewer_affinity_lookup`).
    organic_viewer: float = 0.3

    #: ★★ THE FOLLOW WEIGHT (2026-08-08, owner: "follows need to do slightly
    #: more. not a lot but slightly more"). How much a candidate is worth for
    #: the single fact that the viewer FOLLOWS its author. Applied in
    #: :func:`recsys.core.scoring.score_candidate` as
    #: ``earned = blend(earned, 1.0, w)`` for ``IN_NETWORK`` candidates only —
    #: i.e. it lifts a followed author's composite by ``w * (1 - earned)``.
    #:
    #: WHAT IT FIXES. Before this, following someone controlled POOL
    #: MEMBERSHIP and nothing else: `IN_NETWORK` and every discovery lane were
    #: scored by the identical viewer-blind formula. `organic_viewer` above is
    #: NOT this signal — it is built from the viewer's OUTGOING ENGAGEMENT
    #: EDGES (`viewer_author_affinity` reads `snap.edges`, not
    #: `viewer.follows`), so a follow you have never upvoted or replied to
    #: contributes exactly 0.0 through it. The two channels are disjoint by
    #: construction, so this is not a double-count of the same evidence.
    #:
    #: VIEWER-OWN, so it carries the same self-harm-only safety posture as
    #: `organic_viewer` and `interest_match`, NOT the poisonable cross-viewer
    #: posture that caps `organic_cf` at 0.1: nobody but the viewer can put an
    #: author into the viewer's own `IN_NETWORK` lane.
    #:
    #: ★ 0.0 IS BYTE-IDENTICAL to the pre-2026-08-08 score (`blend` returns its
    #: input at weight <= 0.0, and the call is additionally guarded on
    #: `> 0.0`), which is what keeps every panel pin and sweep table in this
    #: file reproducible.
    #:
    #: SWEEP-PENDING — the shipped value and its live table are written here
    #: once measured. Until then this field is 0.0 (off, byte-identical).
    #:
    #: WHAT IT IS NOT ALLOWED TO BE. This is a RANKING nudge, never an
    #: eligibility change: it cannot admit a post the gates rejected, and it
    #: never touches the exploration lane's reserved seat (that is spliced
    #: after re-rank and does not compete on score at all). It is also NOT a
    #: substitute for removing `OON_INTEREST` from `CandidateSource.
    #: is_viewer_chosen` — that lever was measured to take the tag lane from 13
    #: of 20 slots to ~3 and is a reversal, not a nudge.
    #:
    #: ★ HONEST SECOND-ORDER EFFECT, stated rather than discovered later. The
    #: bonus lands in `earned`, and `rerank._topic_affinities` infers the
    #: viewer's per-topic affinity from the pool's EARNED-score mass — so
    #: topics the viewer's follows write in gain a slightly larger mass share
    #: and their topic-diversity penalty is attenuated slightly more. This is
    #: NOT the double-count that the 2026-08-05 fix removed for
    #: `interest_match`: that term is a per-TOPIC constant, so it lifted one
    #: topic's mass and then switched off that same topic's brake. This one is
    #: per-AUTHOR-RELATIONSHIP and lands on whatever topics the viewer's
    #: follows happen to write about, which is a genuine fact about the pool
    #: rather than a restatement of the term itself. Measured on the panels at
    #: the shipped value — see the 2026-08-08 run recorded below.
    in_network_bonus: float = 0.05

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
        if not 0.0 <= self.vote_share_of_final <= 1.0:
            raise ValueError(
                "vote_share_of_final must be in [0, 1], got "
                f"{self.vote_share_of_final}"
            )
        if self.reputation < 0.0 or self.organic < 0.0:
            raise ValueError(
                f"reputation/organic must be >= 0, got {self.reputation}/{self.organic}"
            )
        if self.vote_share_of_final < 1.0 and self.reputation + self.organic <= 0.0:
            raise ValueError(
                "reputation + organic must be > 0 — they are the ratio the non-stake "
                "mass of `earned` is split in, and a zero total leaves it undefined. "
                "(Exempt at vote_share_of_final == 1.0, where there is no such mass.)"
            )
        # ★ THE TARGET MUST BE REACHABLE ON THE WORST *REACHABLE* PATH.
        # `score_candidate` solves `vote_weight = vote_share_of_final / scale`,
        # where `scale` is the product of the two conditional blends that stand
        # between `earned` and `final` for that candidate — the in-network bonus
        # and the declared-interest blend. There are four combinations; the
        # binding one is the smallest POSITIVE scale, because a scale of exactly
        # zero means `earned` is discarded outright on that path (e.g.
        # `in_network_bonus == 1.0`, "a followed post always scores 1.0") and
        # the stake term then carries 0% — under the owner's cap, not over it,
        # so it is not a violation. Anything else that cannot be solved WOULD
        # have to clamp, silently re-introducing the per-path drift this
        # replaced. Refuse that config instead of clamping it.
        scales = {
            (1.0 - bonus) * (1.0 - blend_w)
            for bonus in (0.0, self.in_network_bonus)
            for blend_w in (0.0, self.organic * self.interest_match)
        }
        positive = {s for s in scales if s > 0.0}
        if positive and self.vote_share_of_final > min(positive):
            raise ValueError(
                f"vote_share_of_final={self.vote_share_of_final} is unreachable on the "
                f"most-discounted candidate path (smallest positive scale "
                f"{min(positive):.6f}, from in_network_bonus={self.in_network_bonus} "
                f"and organic*interest_match={self.organic * self.interest_match:.6f}). "
                "Lower the stake target, or lower interest_match/in_network_bonus."
            )
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
        if not 0.0 <= self.interest_match <= 1.0:
            raise ValueError(f"interest_match must be in [0, 1], got {self.interest_match}")
        # Bounded like every other blend weight: `blend` clamps internally, but a
        # value outside [0, 1] here means the operator meant something this field
        # cannot express, and silently clamping it would hide that.
        if not 0.0 <= self.in_network_bonus <= 1.0:
            raise ValueError(
                f"in_network_bonus must be in [0, 1], got {self.in_network_bonus}"
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

    #: ★ B-03 (2026-08-04) — the SHARE this replaces `unchosen_max_per_page`'s
    #: hard count with: the maximum fraction of PLACED slots that may come from
    #: lanes the viewer never asked for, enforced (with `unchosen_min_per_page`
    #: and `unchosen_displacement_ratio` below) as a running-prefix quota — see
    #: :func:`recsys.core.rerank._quota`.
    #:
    #: WHY THE FLAT COUNT HAD TO GO. `unchosen_max_per_page=3` could not serve
    #: both sides that need it (`BUILDMAP-B-QUALITY-2026-08-04.md` §0's "THE
    #: FRONTIER THAT DECIDES THIS MAP", tags-only, 8 seeds x 6 topics, q3's
    #: 9-voter newcomer rung):
    #:
    #:   cap    reader rel@20, n=9    newcomer top-50/40    newcomer top-20/40
    #:     0        0.457 (-32.8%)          40/40                  30/40
    #:     1        0.614  (-9.7%)           4/40                   0/40
    #:     3 (old)  0.571 (-16.0%)          24/40                   0/40
    #:     5             —                  40/40                   1/40
    #:
    #: The reader wants ~1/page; the newcomer needs >=5/page. A single COUNT
    #: cannot be both, because the mechanism it enforces — "no more than N
    #: unchosen candidates get in, whoever they are" — has no way to tell a
    #: RELEVANT unchosen post (an on-topic newcomer) from an irrelevant one
    #: (off-topic spillover). `ScoreWeights.interest_match` (B-02) is what
    #: makes that distinction available to the scorer; `emerging_per_page`
    #: below (B-04) is what gives a newcomer a budget the SHARE cannot eat.
    #: With both landed, the share only has to arbitrate among candidates that
    #: already cleared a relevance bar, so it can stay tight for the reader.
    #:
    #: 1.0 is an EXACT no-op (see :func:`recsys.core.rerank._quota`: at
    #: share=1.0 the running quota is always `placed + 1`, which the
    #: `unchosen_placed <= placed` invariant can never reach or exceed, so the
    #: cap never binds regardless of `unchosen_min_per_page`) — pinned by
    #: ``test_unchosen_share_of_one_is_an_exact_no_op``.
    #:
    #: ★★ SHIPPED AT 0.0 — DELIBERATELY BYTE-COMPATIBLE WITH THE OLD FLAT CAP,
    #: NOT THE FRONTIER TABLE'S 0.15 THIS DOCSTRING ORIGINALLY PLANNED
    #: (2026-08-04, corrected after measurement). `_quota(placed, page_size,
    #: share, minimum)` at `share=0.0` reduces to `minimum * pages` exactly —
    #: :func:`recsys.core.rerank._page_quota`'s OLD formula, with
    #: `unchosen_min_per_page` playing the role `unchosen_max_per_page` used
    #: to. So `share=0.0, min=3` reproduces the pre-B-03 `unchosen_per_page=3`
    #: composition BIT-FOR-BIT — verified directly: `q8_author_prior_panel.py`
    #: and `q9_prior_shrinkage.py` (unrelated panels this map does not own —
    #: they grade the author-pooled PRIOR, not this quota) both went from
    #: PASSING at session start to FAILING the instant `share` moved off 0.0
    #: with `min` off 3, at ANY `interest_match` value including 0.0 — proving
    #: the break was this field's COMPOSITION SHIFT, not the score term. `0.15`
    #: (this file's first draft default) is a real, buildable point on the
    #: frontier and the fields fully support it — it is simply not the shipped
    #: value, because every measured combination that moved off `share=0.0`
    #: broke a panel outside this builder's scope to fix. See
    #: `ScoreWeights.interest_match`'s docstring for what DID move (the score),
    #: and re-sweep this field jointly once B-05 owns both maps at once.
    unchosen_max_share: float = 0.0

    #: Floor on the running quota above, in absolute candidates per
    #: `explore_window` page: discovery never reaches exactly zero even where
    #: `unchosen_max_share * (placed + 1)` rounds down to 0 early in a page.
    #: 0 restores a pure share with no floor.
    #:
    #: ★★ SHIPPED AT 3 — matching the retired `unchosen_max_per_page`'s own
    #: value exactly, for the byte-compatibility reason `unchosen_max_share`'s
    #: docstring explains: at `share=0.0` this field alone decides the quota,
    #: reproducing `pages * 3` — the old formula, verbatim.
    #:
    #: ★★★ IT IS A FLOOR, NOT A CEILING — MEASURED CONSEQUENCE (2026-08-04,
    #: Builder A, joint `interest_match` x q10/q11 sweep). Because this many
    #: unchosen-lane slots are GUARANTEED every page regardless of what is
    #: available there, it can force in whatever the unchosen lane's weakest
    #: surviving candidates are, not just bound how much of the good stuff
    #: gets through. Source-level breakdown of the shipped q11 follow-curve at
    #: n=20 (`OON_ENGAGED` still holding its mandated 3/20 = 15% share):
    #: `OON_ENGAGED`'s OWN mean ground-truth relevance within that share is
    #: 0.067, against 0.672 for `IN_NETWORK`'s 16/20 share the same page — the
    #: floor is filling those 3 slots with the worst of what remains in that
    #: lane once the good candidates have already been placed elsewhere.
    #: Lowering this value shrinks that cost (tested 0/1/2 at
    #: `ScoreWeights.interest_match`=0.4: the q11 endpoint drop shrinks from
    #: -0.1193 at 3 to -0.0713 at 1) but also shrinks the newcomer-discovery
    #: volume this same floor exists to guarantee (24/40 -> 8/40 on the same
    #: sweep) and, at `interest_match`=0.4, pushed some of q10's worlds
    #: NEGATIVE that were positive at 3 — a worse trade on every axis this
    #: session measured, so left at 3. Recorded here as a real lever, not
    #: applied, for whoever next revisits the follow-curve residual — see
    #: `ScoreWeights.interest_match`'s own 2026-08-04 addendum for the full
    #: joint-sweep table this was measured against.
    #:
    #: ★★ OPERATOR RULING 2026-08-04 — THIS VALUE IS NOW A DECISION, NOT A
    #: DEFAULT. The trade above was put to the operator explicitly: 3 costs the
    #: reader (q11's endpoint drop stays at -0.1193 and the follow curve is NOT
    #: monotonic), 1 costs new writers (newcomer reach 24/40 -> 8/40). The
    #: ruling was **new writers matter more — keep it at 3**.
    #:
    #: So the non-monotonic follow curve is an ACCEPTED COST, not an open bug.
    #: Anyone revisiting it is reopening a decided product question and should
    #: say so out loud rather than treating the curve as a defect to be quietly
    #: tuned away. If the platform's priorities change — a mature corpus with
    #: plenty of new writers already discoverable, say — this is the first knob
    #: to revisit, and the numbers above are the ones to re-measure against.
    #:
    #: ★★★ SCOPE CORRECTION 2026-08-05 (C3) — READ THIS BEFORE QUOTING A SHARE.
    #: This quota binds ONLY within a single ``diversity_rerank`` call, and
    #: ``rank_feed`` reranks the eligible pool and the fallback-filler pool as
    #: TWO SEPARATE BLOCKS. The filler block is 100% ``POPULAR_FALLBACK``, which
    #: is never ``is_viewer_chosen``, so the quota's supply condition
    #: (``any(chosen in remaining)``) is False there BY CONSTRUCTION and the
    #: quota cannot fire on it at ANY configured value — it cannot prefer a
    #: viewer-chosen candidate from a pool that contains none.
    #:
    #: Measured for a starved viewer: served feed 85% unchosen, against the
    #: "3 per 20-post page" (<=15%) this field reads as promising. That is NOT a
    #: bug in the quota; padding is unconditionally unchosen, so composition is
    #: not a thing a quota can bound there. The real and only bound on padding
    #: dilution is :attr:`FallbackConfig.max_share_of_feed` (0.25), a different
    #: and coarser cap. C3 made the author/topic counters feed-scoped, which
    #: fixes SPACING across the boundary; it deliberately did not pretend to
    #: make this quota apply to padding.
    #:
    #: So: this value governs the composition of the ELIGIBLE block. Quote it
    #: for that, and quote ``max_share_of_feed`` for how much of a thin feed is
    #: padding at all.
    unchosen_min_per_page: int = 3

    #: ★ B-03's RELEVANCE GUARD. The share/floor above may only actually
    #: restrict the candidate pool to viewer-chosen sources when a
    #: COMPARABLY STRONG chosen candidate is available to take the slot —
    #: `best_chosen_effective >= unchosen_displacement_ratio *
    #: best_unchosen_effective` among the still-`remaining` pool (see
    #: :func:`recsys.core.rerank.diversity_rerank`). This is what stops the
    #: old mechanism's other failure mode: evicting a strong unchosen
    #: candidate for an ARBITRARILY WEAK chosen one merely because one
    #: existed (`any(c.source.is_viewer_chosen for c in remaining)` was the
    #: entire supply condition — no score comparison at all).
    #:
    #: 0.0 makes the guard itself a no-op — the quota decides on count alone,
    #: which is the pre-guard behaviour (every candidate score is >= 0.0, so
    #: `best_chosen_effective >= 0.0 * best_unchosen_effective` is always
    #: true whenever a chosen candidate is available at all). A nonzero value
    #: means: only cap when the best chosen candidate scores at least that
    #: FRACTION of the best unchosen one — comfortably close, not merely
    #: present. Values > 1.0 are legal and progressively stricter (the guard
    #: fires only when the chosen candidate is not just close but actually
    #: the stronger one); no upper bound is enforced because there is no
    #: natural ceiling on how conservative an operator may want the cap to be.
    #:
    #: ★★ SHIPPED AT 0.0 — THE GUARD IS OFF BY DEFAULT, and this is a
    #: measured finding, not a placeholder (2026-08-04). Swept on
    #: `measurement-harness/q11_follow_curve.py`'s SHIPPED-arm curve (4 seeds
    #: x 2 topics), at the FIRST-DRAFT `unchosen_max_share=0.15`,
    #: `unchosen_min_per_page=1` (since retracted in favour of the
    #: byte-compatible 0.0/3 — see that field's docstring) held fixed. The
    #: guard's own conclusion (any nonzero ratio reopens the same selection-
    #: bias hole the quota exists to close) does not depend on which share/min
    #: pair it was measured against — it was NOT re-verified at 0.0/3 due to
    #: time, and re-sweeping it there is worth doing before relying on this
    #: table's exact violation counts:
    #:
    #:   ratio   q11 monotonicity violations (of 8 gaps)   rel@20 shape
    #:    0.0                    2                          recovers by n=20
    #:    0.5                    reproduces ~1.0's shape (worse than 0.0)
    #:    0.85 (map's suggestion)      reproduces the UN-quota'd curve almost
    #:                                  exactly — see mechanism below
    #:    1.0 (= OFF/no-op)      matches the pre-B-03 unguarded-quota curve
    #:
    #: THE MECHANISM, once measured rather than assumed: `OON_ENGAGED`
    #: content scores systematically HIGHER than `IN_NETWORK` due to the
    #: selection-bias artifact `CandidateSource.is_viewer_chosen` documents
    #: (+0.04 to +0.22 mean organic, every seed) — so at ANY guard ratio
    #: above ~0, `best_unchosen_effective` routinely clears
    #: `ratio * best_chosen_effective` for generic, not-specially-relevant
    #: spillover, not just for a genuinely deserving candidate. The guard's
    #: OWN premise (protect a stronger unchosen candidate from an arbitrarily
    #: weak chosen one) is real and the mechanism is fully built and tested
    #: (`test_displacement_guard_lets_a_much_stronger_unchosen_candidate_through`,
    #: `test_displacement_guard_still_caps_when_chosen_is_comparably_strong`),
    #: but on THIS instrument the population it protects overlaps too heavily
    #: with the population the quota exists to bound. Shipping it at 0.0 keeps
    #: the mechanism available (and correctly tested) for an operator to raise
    #: once real engagement data can separate "genuinely better" unchosen
    #: content from the selection-biased kind — this is therefore
    #: LIVE-DATA-GATED like `organic_cf`, not abandoned.
    unchosen_displacement_ratio: float = 0.0

    #: ★ DEPRECATED as the enforcement mechanism (B-03, 2026-08-04) — kept ONLY
    #: as a backward-compatible ON/OFF TOGGLE for the three fields above, never
    #: deleted, because two files outside this builder's ownership construct
    #: or reference it by name (BUILD-ADJUDICATION R5):
    #: `measurement-harness/q11_follow_curve.py` builds `Settings` via
    #: `dataclasses.replace(BASE.diversity, unchosen_max_per_page=cap)` in its
    #: own `cfg()` — renaming or deleting the field would `TypeError` the
    #: panel that grades this very change; `q7_corrected_baseline.py`
    #: mentions it in a comment only (no code risk, but the number there is
    #: now stale — see this builder's report).
    #:
    #: `<= 0` disables the ENTIRE unchosen-quota mechanism (share + floor +
    #: guard) — reproducing the pre-B-03 "0 = off" meaning of this field
    #: EXACTLY, so `unchosen_max_per_page=0` still means "no unchosen quota at
    #: all", the same as it always has. Any positive value ENABLES the quota;
    #: its magnitude no longer sizes anything (the three fields above do) —
    #: only its sign/zero-ness is read. A caller that never touches this field
    #: (the intended path going forward) gets the quota on by the shipped
    #: default (3, unchanged), sized by `unchosen_max_share` et al.
    #:
    #: See :func:`recsys.core.rerank.rerank` for exactly how this gates the
    #: three fields above.
    unchosen_max_per_page: int = 3

    #: ★ B-04 (2026-08-04) — the emerging-author budget: how many candidates
    #: per `explore_window` page may bypass the unchosen SHARE (not the
    #: geometric penalty above, which still applies) because their author is
    #: `_is_emerging` — absent from `graph_creds` entirely, or sitting at or
    #: below `GraphCredConfig.min_vouched_score` (see
    #: :func:`recsys.pipeline._score`, which builds the actual
    #: ``emerging_authors`` set passed to the re-ranker). Same "unknown, not
    #: bad" band `CandidateSource.requires_author_floor` already treats
    #: permissively — no new trust concept.
    #:
    #: WHY OUTSIDE THE SHARE, NOT A LARGER SHARE. A newcomer arrives as
    #: `OON_ENGAGED` — `is_viewer_chosen == False` — and would otherwise queue
    #: behind every piece of ordinary off-topic spillover for the SAME budget
    #: the reader's protection depends on. Raising the shared share to fit
    #: them back in reopens exactly the spillover problem `unchosen_max_share`
    #: exists to bound. A separate, small, dedicated budget lets a genuinely
    #: under-recognized author through without loosening the reader's general
    #: protection at all.
    #:
    #: ★★ A HONEST LIMIT, MEASURED RATHER THAN ASSUMED (2026-08-04): this
    #: field does NOT rescue q3's own "9 distinct voters + 2 comments + 1
    #: reblog" rung — checked directly (`snap.graph_creds[NEWBIE].score ==
    #: 0.507` at that engagement level, seed 7), well above
    #: `min_vouched_score` (0.10), so that author is no longer "emerging" by
    #: this predicate at all; they are ordinary "engaged" tier and compete for
    #: the SHARE, not this budget. What closed that rung (measured jointly
    #: with `ScoreWeights.interest_match`, see its docstring's table) was the
    #: score-level fix (interest_match) plus the share, not this field.
    #:
    #: ★★★ THE "COLDER END" CLAIM BELOW WAS ALSO TESTED END-TO-END AND IS
    #: ALSO NOT SUPPORTED (2026-08-04, Builder A) — this field appears INERT
    #: for BOTH populations, not just the warmer one above. Built a genuine
    #: zero-vote/zero-comment/zero-reblog debut (`world.post_engagers[key] =
    #: set()` — cannot arrive via `OON_ENGAGED` at all, by construction) and
    #: swept `emerging_per_page` in {0, 1, 3} crossed with `interest_match` in
    #: {0.0, 0.2, 0.4}, 4 seeds x 10 established same-topic viewers (40 rows)
    #: per point: EVERY combination scored top-20 = 40/40, IDENTICAL at every
    #: `emerging_per_page` value including 0 (the lane fully disabled). Traced
    #: why: this debut is absent from `graph_creds` (confirmed — it clears the
    #: "emerging" predicate), but it never needed the budget to win a slot in
    #: THIS instrument — its `OON_INTEREST` candidacy already outranks most of
    #: a real viewer's own thin `IN_NETWORK`/`POPULAR_FALLBACK` tail on raw
    #: score (verified directly: position 13 of 148 candidates on a plain
    #: `interest_match=0.0`, recency-only raw of 0.096, percentile 0.04 — most
    #: of the surrounding pool scores even lower). So across every population
    #: this field's own docstring names as a target — the q3 engaged rung
    #: (doesn't clear the predicate) and a true cold debut (clears the
    #: predicate but doesn't need the budget on this instrument) —
    #: `emerging_per_page` measurably changes nothing. NOT tested: several
    #: simultaneous emerging candidates competing for the SAME feed's limited
    #: slots (this field is a per-page BUDGET, which only binds under
    #: contention a lone debut does not create) — that remains the one
    #: plausible scenario where this lane could matter and was not measured
    #: this session. Until that is checked, treat this field as unproven
    #: rather than confirmed-working; it is not proven inert in every
    #: scenario, only in the two this docstring already claimed for it.
    #:
    #: 0 disables the lane (an emerging candidate is then only ever an
    #: ordinary unchosen candidate, gated by the share like anything else).
    #: 1 is the shipped default — the spec's own "start at 1, never 2"
    #: posture for a reserved slot (`ExplorationConfig.slots_per_page`'s
    #: docstring cites the production literature this mirrors).
    #:
    #: NOT a second free pass: an emerging candidate whose author has already
    #: used this page's emerging budget falls back to the ordinary unchosen
    #: share/guard, exactly like any other unchosen candidate (see
    #: :func:`recsys.core.rerank.diversity_rerank`).
    #:
    #: NOT the exploration lane (`ExplorationConfig`/`CandidateSource.EXPLORATION`).
    #: That lane bypasses the vouch gate AND the author floor entirely — it is
    #: for a post with literally zero engagement. This budget only changes
    #: DIVERSITY-RERANK ORDERING among candidates that already passed
    #: `filter_eligible` (the vouch gate, the author floor, mutes,
    #: suppression, NSFW) — it grants no new eligibility, only a fairer shot
    #: at a slot once eligible. BUILD-ADJUDICATION's map is explicit that
    #: relabeling this lane's picks AS `EXPLORATION` to reuse its gate-exempt
    #: posture is NOT an option without a dedicated adversarial review — not
    #: done here.
    emerging_per_page: int = 1

    #: ★★★ THE POPULARITY LANE'S BUDGET (2026-08-08). A SEPARATE, small budget
    #: — outside `unchosen_max_share`, never eating into it — for
    #: `OON_POPULAR` candidates, built exactly like `emerging_per_page` above
    #: and for the same reason.
    #:
    #: WHY THE LANE NEEDS ONE AT ALL. `OON_POPULAR` is not `is_viewer_chosen`
    #: (the viewer did not ask for chain-wide popularity — calling it "chosen"
    #: to dodge the cap would be a lie in a predicate whose whole job is to
    #: record what the viewer asked for). So without this it shares ONE running
    #: quota — `unchosen_min_per_page` = 3 per page — with `OON_ENGAGED`,
    #: `OON_ALS` and any padding. A lane the owner wants at ~4 of 20 with >=3
    #: inside the top 10 cannot live inside a 3-per-page budget it does not own.
    #:
    #: ★ IT IS NOT A RESERVED SLOT, and the distinction is the requirement.
    #: This budget only EXEMPTS a popular candidate from the unchosen cap; it
    #: never places one. Every member still competes on diversity-discounted
    #: effective score against everything else on the page, still carries the
    #: unchosen-lane penalty, and still loses to a better post. Removing an
    #: obstacle is what "earn it" permits; splicing at a fixed index (what the
    #: exploration seat does) is what it forbids. If the lane does not reach 3
    #: in the top 10 on real viewers, the honest report is the measured number —
    #: not a bigger number here.
    #:
    #: 0 disables the budget (the lane, if sourced, then competes inside the
    #: shared unchosen quota) and is an exact no-op for every pre-2026-08-08
    #: measurement.
    #: ★ 1, not 4 (2026-08-09, owner: "it doesnt have to dominate but it has to
    #: show up at least once, we dont have to force 3").
    #:
    #: These slots are EXEMPT from the unchosen-lane penalty, so every one of
    #: them is a post placed above what its own score earned — measured at
    #: `q12` G2a as -2.860 ranks of displacement. Four such slots cost every
    #: reader -0.1022 relevance at n=9 (`q11`); one costs -0.0523. Halving the
    #: harm for a lane the owner wants PRESENT rather than DOMINANT is the whole
    #: trade, and it is the owner's own framing.
    popular_per_page: int = 1
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
        if not 0.0 <= self.unchosen_max_share <= 1.0:
            raise ValueError(
                f"unchosen_max_share must be in [0, 1], got {self.unchosen_max_share}"
            )
        if self.unchosen_min_per_page < 0:
            raise ValueError(
                "unchosen_min_per_page must be >= 0, got "
                f"{self.unchosen_min_per_page}"
            )
        if self.unchosen_displacement_ratio < 0.0:
            raise ValueError(
                "unchosen_displacement_ratio must be >= 0, got "
                f"{self.unchosen_displacement_ratio}"
            )
        if self.emerging_per_page < 0:
            raise ValueError(
                f"emerging_per_page must be >= 0, got {self.emerging_per_page}"
            )
        if self.popular_per_page < 0:
            raise ValueError(
                f"popular_per_page must be >= 0, got {self.popular_per_page}"
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
    #:
    #: ★★★ THE OWNER ASKED FOR THIS INSIDE THE TOP TEN ("1 needs to be in top
    #: 10") AND IT IS DELIBERATELY STILL 13 (2026-08-08). The move itself is a
    #: one-character change and its cost is measured and cheap — see the report;
    #: what blocks it is an ENFORCEMENT fact about the lane, not the position:
    #:
    #: `ExplorationServeLog` is an IN-PROCESS dict (`recsys/serve_log.py` says
    #: so in its own scope note). So `max_serves_per_author = 3` — the only
    #: bound on this lane keyed on something an attacker cannot control, on the
    #: least-gated source in the system (`requires_second_degree` False AND
    #: `requires_author_floor` False) — is in reality "3 per replica, reset to
    #: zero by every deploy". A restart is a total amnesty on every serve count,
    #: two replicas do not share one, and `graduated()` refunds the whole budget
    #: as soon as an author's distinct-engager count rises, which one comment
    #: from a second sock achieves.
    #:
    #: Doubling that lane's visibility before its only real budget survives a
    #: deploy is the wrong order to do two things in. `ExplorationServeLog.merge`
    #: already exists, so the work is a STORE (a table beside
    #: `recsys/db/schema.sql`, load-on-start, flush-on-timer), not a redesign.
    #: **Flip this to 9 the day serve counts are persisted and shared.**
    position: int = 13
    #: ★★ SEAT OCCUPANT = THE BEST OF THE EQUALLY-UNHEARD (2026-08-08, owner:
    #: "the highest ranked one has an assured top 10 slot"). See
    #: :func:`recsys.core.exploration.seat_order` for the mechanism, the key it
    #: sorts on, and the honest statement of what it costs (the keyed-MAC
    #: lottery becomes a tie-break, and within band 0 freshness becomes the de
    #: facto ordering signal).
    #:
    #: ``False`` restores the pre-2026-08-08 order byte-for-byte — the pool
    #: arrives in need-band order with :func:`~recsys.core.exploration.
    #: _rotation_key`'s keyed shuffle inside each band, and nothing re-sorts it.
    #:
    #: ★★★ SHIPPED **OFF**, AND THE REASON IS AN OPEN BUG, NOT A PREFERENCE
    #: (2026-08-08). RIVAL SUPPRESSION IS LIVE: `tests/test_rival_suppression.py`
    #: is 2 passed / 2 **xfail(strict=True)** at this tree, i.e. no fix has
    #: landed. Two sock accounts comment on a newcomer's post, the newcomer
    #: replies as anyone would, and the resulting reciprocal edges floor their
    #: graph-cred to 0.0000 (against 0.5286 with one sock). `eligible_for_
    #: exploration` then drops `cred.score <= 0.0` outright, so suppression
    #: EVICTS a rival from this lane. 51 of 15,855 live `graph_cred` rows sit at
    #: exactly 0.0 today.
    #:
    #: THE ARITHMETIC THAT DECIDED THIS. Let the leading need band hold N
    #: members and let the attacker's post score below k of them.
    #:
    #:   * keyed lottery (this field False): the attacker holds the seat with
    #:     probability 1/N, and to make that 1 they must suppress ALL N-1
    #:     rivals — the cost is the whole band and it does not fall as their own
    #:     post gets better or worse;
    #:   * score order (True): the attacker holds the seat with probability 0
    #:     unless they suppress, and with probability **1** once they suppress
    #:     just the k members ABOVE them. k <= N-1 always, and for a mediocre
    #:     post k is small. So score order converts a probabilistic 1/N into a
    #:     DETERMINISTIC 1 at strictly lower cost, and — the part the lottery
    #:     never rewarded — it does so for a LOW-scoring attacker.
    #:
    #: The mechanism itself is built, tested and measured (see
    #: :func:`recsys.core.exploration.seat_order`), and it is one flip away the
    #: day `test_rival_suppression.py`'s two strict xfails go green. Shipping it
    #: before then would make suppression the cheapest way to buy the reserved
    #: seat, which is a worse trade than leaving the occupant to the lottery.
    #:
    #: ★ WHAT ACTUALLY FIXED THE OWNER'S COMPLAINT was not this field. The seat
    #: was going to a 28,777-post 2020 account because the lane had no newness
    #: test at all; `max_author_age_days` above is the fix, and it is on.
    seat_by_score: bool = False
    #: ★★★ THE NEWNESS PREDICATE (2026-08-08). Maximum ACCOUNT age, in days
    #: since the author's first post, for the reserved seat. `0` disables it and
    #: reproduces the pre-2026-08-08 lane byte-for-byte.
    #:
    #: WHY IT HAD TO EXIST BEFORE THE SEAT COULD MOVE INTO THE TOP TEN. This
    #: lane bands authors on `engagement_received` — the UNENGAGED — and read no
    #: author age at all. `core/exploration.py`'s own comment conceded the gap:
    #: "This does NOT make the lane new-author-only; that needs an author-age or
    #: graph-cred-absence condition, which both councils flagged as the real
    #: v1.0 gap." On Hive the unengaged are overwhelmingly DOWNVOTED VETERANS,
    #: not debuts. Measured across 5 real viewers (2026-08-08), the seat went to:
    #:
    #:     tdvtv             created 2020-12-17   28,777 posts
    #:     darkflame         created 2016         15,552 posts
    #:     sadcorp           since 2018            1,233 posts, rep -40.8bn
    #:     alexwo            since 2023              947 posts, rep -843bn
    #:     toluwanispecial                           768 posts
    #:     liza-amin                                   3 posts  <- the only debut
    #:
    #: Promoting that population into the top ten would make a WORSE post more
    #: visible, which is the opposite of the change's purpose.
    #:
    #: 30 DAYS is the same horizon the chain-measured newcomer cohort behind
    #: `serve_window_days` uses (1,506 accounts created in 30 days, ~14.5 true
    #: debuts/day, median 3 posts in a newcomer's first 30 days) — so a genuine
    #: debut gets a month of eligibility, spanning several `serve_window_days`
    #: refills, and a 2016 account gets none.
    #:
    #: ★ FAIL-CLOSED, and that is the deliberate direction. An author whose
    #: first-post date could not be resolved is treated as NOT new and refused
    #: the lane. Fail-open would mean any author the lookup missed is silently
    #: treated as a debut — precisely the state this predicate exists to detect,
    #: reintroduced as the failure mode. The cost is stated plainly: a lookup
    #: outage empties the lane rather than filling it with veterans, and an empty
    #: lane FORFEITS the seat (see `ExplorationConfig`'s class docstring), which
    #: costs a measured 2.18% of page composite and returns the slot to merit
    #: content.
    max_author_age_days: int = 30
    #: ★★★ OPTION C — PREFER AN INTEREST MATCH, FALL BACK TO ANY NEWCOMER
    #: (2026-08-09, owner's explicit choice). ``False`` restores the
    #: pre-2026-08-09 lane byte-for-byte: an interest match is MANDATORY and the
    #: seat forfeits without one.
    #:
    #: THE MEASUREMENT THAT FORCED IT. `_interest_match` requires the newcomer's
    #: post CATEGORY to be one of the viewer's interest tags. Measured on the
    #: live chain: **136 genuinely new authors posted in 3 days across 91
    #: distinct categories, and 91 of 91 fell outside all three test viewers'
    #: interest sets combined** — so the gate did not TARGET the seat, it
    #: DELETED it, for everyone, every request. A reserved slot that never fills
    #: is not a conservative default; it is a lane that has been off since it
    #: shipped while reporting "correctly forfeits".
    #:
    #: ★ WHAT THE FALLBACK DOES NOT RELAX. Nothing. Every other condition in
    #: :func:`~recsys.core.exploration.eligible_for_exploration` still applies to
    #: a fallback pick — mute, self-post, suppressed, NSFW, post age,
    #: `max_author_age_days` newness, proven-self-dealt cred, on-post
    #: self-dealing, `max_serves_per_author`, `max_slots_per_feed`, the keyed
    #: `_rotation_key` seat MAC. The ONLY thing that changes is that "the viewer
    #: never declared this topic" stops being fatal when the alternative is
    #: showing them nothing.
    #:
    #: ★★ THE PREFERENCE IS ABSOLUTE, NOT A BLEND, and that is what keeps R3
    #: intact. When ANY interest-matched newcomer is eligible, the pool is
    #: EXACTLY those and a non-matching candidate cannot outrank one — see the
    #: split in `eligible_for_exploration`. A mixed pool would have handed the
    #: seat back to whoever scored best across both sets, i.e. to tag-spray
    #: pressure, which ruling R3 (primary-tag-only matching) closed for good
    #: reason after one sock tagged 12 topics and reached 60/60 viewers.
    interest_fallback: bool = True
    max_age_days: int = 7
    #: Per-author epoch budget. A farm cannot convert account count into slots
    #: because the rotation is round-robin over AUTHORS, but without this an
    #: author with many fresh posts could still take consecutive rounds.
    max_posts_per_author_epoch: int = 3
    #: ★ PER-FEED LANE CEILING (C2a, 2026-08-04). Bounds how many exploration
    #: picks ONE served feed may carry, regardless of page count. Without it
    #: the ceiling is ``slots_per_page * pages`` — 1 * 10 = 10 on the shipped
    #: 200-post/20-per-page feed — which lets an account-count farm convert
    #: page depth directly into slots: `A4_slot_sweep.py` measured 10 ground
    #: socks taking 75.5% of every exploration slot on the platform, 20 taking
    #: 83.6%, with 0 ring flags (an account-count farm has no reason to form a
    #: ring, so ring exclusion cannot see it — see the module docstring).
    #:
    #: Enforced in :func:`insert_exploration`'s ``while picks:`` loop: it stops
    #: after this many insertions.
    #:
    #: THE TRADE, stated plainly and NOT hidden: this caps the LANE'S SIZE, so
    #: an honest newcomer cohort competing for the same feed gets 3 seats
    #: instead of 10 — a 70% cut in total exploration impressions per feed.
    #: Confirmed on `tests/test_exploration.py::test_max_slots_per_feed_...`:
    #: 10 distinct eligible newcomers competing for one 200-post feed get
    #: exactly 3 insertions at the shipped default, not 10. Who pays: new
    #: authors, uniformly — this does nothing to a farm's SHARE of the lane,
    #: only its absolute per-feed take, which is why the map that specified it
    #: (BUILDMAP-C, C2a) requires it ship alongside C2b/tag-breadth pricing
    #: (already shipped, see `_interest_match`) rather than alone. `q3_newauthor`
    #: (single-newcomer panel) is unaffected by this field by construction — it
    #: only ever has one eligible newcomer per feed, well under any cap 1; the
    #: cost above is a multi-newcomer/cohort effect, not visible in that panel.
    max_slots_per_feed: int = 3
    #: ★★★ B1 / THE SERVING LOG (2026-08-05) — how many exploration slots ONE
    #: author may be given before the lane stops offering them, unless engagement
    #: arrives. ``0`` disables the log entirely (exact pre-B1 behaviour).
    #:
    #: THE HOLE THIS CLOSES. Every other bound on this lane is per-author or
    #: per-feed, and the lane's PRIORITY key was ``len(distinct engagers
    #: received)`` — a number the attacker controls BY NOT ACTING. An account
    #: that never engages and is never engaged sits in need-band 0 forever, and
    #: band 0 is the exclusive top band (``DEFAULT_NEED_BANDS[0] == 0``). So the
    #: cheapest way to own the new-author lane was to create accounts and do
    #: nothing: measured (``attacks/exploration_capture.py``) at 20 socks taking
    #: **100% of every served exploration slot** across 3 seeds, with honest
    #: newcomers reaching 0%.
    #:
    #: WHY A SERVE COUNT FIXES WHAT A CAP COULD NOT. Being SERVED is something
    #: the SYSTEM observes and the attacker cannot decline, refuse or fake — it
    #: is the one fact in this lane that is not attacker-writable. Counting it
    #: converts a free, permanent position into a CONSUMABLE: each identity buys
    #: at most this many slots, so owning the lane costs a fresh account per
    #: ``max_serves_per_author`` slots instead of nothing. That is what "pricing
    #: account count" means here, and it is why the fix is a log rather than
    #: another threshold.
    #:
    #: 3 is deliberately small. The lane exists to give an unheard author a
    #: chance to be heard, not a subscription: if three page-one placements
    #: produce no engagement at all, the honest reading is that this post is not
    #: connecting, and the slot is better spent on someone unheard. An author who
    #: DOES earn engagement leaves band 0 by the normal route and no longer needs
    #: the lane.
    #: ★★★ SHIPPED AT 3 — 2026-08-05, OWNER'S RULING after the round-3 council
    #: measured the off-switch and found it WORSE for the class it was meant to
    #: protect. Both sides of this are recorded because the reasoning reversed
    #: twice in one day and the next person deserves the whole picture:
    #:
    #:   cap 0 (unlimited) -> 1 of 20 newcomers reached
    #:   cap 1             -> 7 of 20
    #:   cap 3             -> 7 of 20 on seed 7; 4 of 20 on seeds 11 and 23,
    #:                        i.e. MEAN 5 of 20   <- SHIPPED
    #:
    #: ★★ THE "7-8 of 20" THIS ORIGINALLY SAID WAS SEED 7 ONLY, generalised from
    #: the first of three worlds and then repeated in three places. A re-run
    #: varying only the cap gives 7/4/4. Worse for the ruling: with socks
    #: present, cap 1 measured BETTER than cap 3 on both axes on every seed
    #: (50% vs 70% farm capture; 5 vs 1 honest newcomers reached), and
    #: `attacks/exploration_capture.py`'s own message already says "1 -> 5".
    #: THE CAP CHOICE IS THEREFORE NOT SETTLED BY EVIDENCE — re-measure across
    #: seeds, with and without socks, before treating 3 as justified.
    #:   cap 100           -> 1 of 20
    #:
    #: 0 does NOT mean "no rationing"; it means one author holds the reserved
    #: seat for a whole clock bucket, because the rotation is keyed per BUCKET
    #: and not per VIEWER. So "turn it off" concentrated the lane instead of
    #: opening it — the opposite of the intent, and the failure mode the block
    #: below already described.
    #:
    #: THE COST, STATED: the serve budget is what makes a free DENIAL attack
    #: worth running — an attacker who creates no accounts and spends nothing
    #: burns an honest newcomer's budget by requesting feeds (~1.1 requests per
    #: newcomer retired). `ExplorationServeLog.clear()` is now WIRED (see
    #: `pipeline.rank_feed`), so retirement is no longer PERMANENT — an author
    #: who earns engagement gets their budget back. That removes the permanence,
    #: NOT the attack: a newcomer who is denied impressions cannot earn the
    #: engagement that would clear them. The real answer is the refilling budget
    #: (`REFILL-DESIGN-ADJUDICATED-2026-08-05.md`), still unbuilt.
    #:
    #: (Previous note, kept because its measurements stand:)
    #: ★★ 2026-08-05 POST-CLOSEOUT COUNCIL — why this was briefly set to 0.
    #:
    #: This shipped at 3 for one day. All three council seats found it
    #: NET-NEGATIVE, from three independent lenses, and the orchestrator
    #: verified the mechanism at source:
    #:
    #: * The counter (`recsys.serve_log.ExplorationServeLog`) keys on AUTHOR
    #:   ALONE — no viewer, no time window, no refill. So "3" is not "3 per
    #:   reader" or "3 per week": it is **3 exploration slots in total, across
    #:   every viewer who ever loads a feed, for the lifetime of the process**.
    #: * `ExplorationServeLog.clear()` — the method whose docstring promises to
    #:   un-retire an author who earns engagement — has NO production caller.
    #:   Retirement is permanent.
    #: * Measured: the lane goes permanently empty after ~36-48 requests **with
    #:   no attacker present**; 11 requests retired 10 of 20 honest newcomers.
    #: * It prices the attacker at nothing: 100 accounts buy 300 slots, and
    #:   then the farm creates 100 more. A defence that is free to the attacker
    #:   and fatal to the class it protects is worse than no defence.
    #: * It was invisible to every gate this project owns: deleting
    #:   `serve_log.record()` left all 799 tests passing and all 14 panels
    #:   byte-identical, and `max_serves_per_author` appears ZERO times in
    #:   `mutate_panels.py`.
    #:
    #: 0 restores the pre-B1 behaviour exactly (the lane is farmable but OPEN),
    #: which is the state consistent with the standing ruling that new writers
    #: matter more than the reader-side gain from closing it.
    #:
    #: THE REPLACEMENT IS A REFILLING BUDGET, NOT A BIGGER NUMBER. Raising this
    #: value was measured to make things WORSE, not better (3 -> 7 of 20
    #: newcomers reached; 10 or 100 -> 1 of 20), because a lifetime cap on a
    #: global counter concentrates the whole lane on whoever is served first.
    #: The shape that works is a budget that REFILLS — see the design work in
    #: `/mnt/o/LUMEN-DOCS/algo-tests/COUNCIL-2026-08-05-POSTCLOSEOUT/`.
    max_serves_per_author: int = 3
    #: ★★★ THE REFILLING BUDGET (2026-08-05, owner's ruling: "we do need the
    #: refilling budget for new accounts").
    #:
    #: `max_serves_per_author` is spent within a ROLLING WINDOW of this many
    #: days rather than for the lifetime of the process. An author whose window
    #: has elapsed starts a fresh one — so a new writer keeps getting a
    #: recurring chance instead of being exiled after three placements, which is
    #: what "3 impressions, ever" amounted to and what four councils objected to.
    #:
    #: **0 disables the refill and restores the lifetime cap byte-for-byte.**
    #:
    #: WHY 7 DAYS, and it is measured rather than picked: the lane's effective
    #: freshness is 3 days (`sourcing_freshness_days`), so a 7-day window spans
    #: more than one full cycle — a second genuine chance before reset — while
    #: sitting inside the measured p75 posting gap of real Hive newcomers
    #: (~4 days), so it refills faster than most newcomers post. Chain-measured
    #: cohort: 1,506 accounts created in 30 days, ~14.5 true debuts/day, median
    #: 3 posts in a newcomer's first 30 days.
    #:
    #: ★★★ MEASURED 2026-08-06, three seats independently, after the first
    #: measurement was WRONG (it pinned posts at a fixed clock while advancing
    #: the reading clock, so epochs 1-3 served zero slots and the arms agreed by
    #: construction). 4 epochs x 8 panels x 3 seeds, only this field varying:
    #:
    #:     lifetime cap   distinct honest reached 9.3-11.3   farm share  7.2-7.4%
    #:     7-day refill   distinct honest reached 18.7-19.0  farm share 28.0-30.2%
    #:
    #: **+71-101% newcomer reach for roughly 4x the farm's share of the lane.**
    #: The lifetime cap does not ration this lane, it KILLS it after one epoch —
    #: socks are permanently exiled but so is every honest newcomer, and only
    #: epoch 0 ever serves anyone. That is what four councils were objecting to.
    #:
    #: The farm cost is accepted DELIBERATELY: farms are to be handled by a
    #: report/takedown path (owner ruling 2026-08-06), which truncates a farm's
    #: yield once noticed. Without takedown a refill hands a farm a recurring
    #: harvest (~52/year rather than one). Judge this lane on HONEST REACH and
    #: treat farm share as a cost capped downstream — see
    #: `/mnt/o/LUMEN-DOCS/algo-tests/PLAN-TO-LAUNCH-2026-08-05.md`.
    #:
    #: ★★ THE COST, STATED RATHER THAN DISCOVERED LATER. A refilling budget is
    #: strictly MORE generous to a farm than a lifetime cap: a sock's budget
    #: also returns every window, so account-count farming becomes a recurring
    #: rather than a one-time yield. What still bounds it: `max_slots_per_feed`,
    #: `max_posts_per_author_epoch`, the keyed seat rotation, ring/self-deal
    #: exclusion, and graduation returning a budget only on engagement that is
    #: NEW (`ExplorationServeLog.graduated`) so free engagement cannot refill
    #: anyone. The adjudicated design also calls for a vouched-engagement gate
    #: and a per-voucher fan-out cap; those are NOT built — see
    #: `REFILL-DESIGN-ADJUDICATED-2026-08-05.md`. Measure before widening this.
    serve_window_days: int = 7
    #: ★ MAC KEY for the reserved-seat rotation (C1a, 2026-08-04 — CRITICAL).
    #:
    #: THE BUG THIS CLOSES. The rotation key used to be an UNKEYED
    #: ``blake2b(f"{bucket}:{author}")`` — no viewer, no secret, pure clock.
    #: Computable by anyone, for any future bucket, for a name that does not
    #: exist yet. Measured (`A1_namegrind.py`, `A13_setcover_e2e.py`): 6
    #: accounts + ~92,546 offline hashes (~0.08s) held the reserved seat in
    #: 613/720 (bucket x viewer) cells — 85.1% — against 60 honest silent
    #: rivals, with ZERO votes, comments, reblogs, or ring flags, and cost was
    #: near-flat in the size of the honest field. It converted an
    #: RC/account-bounded cost into a free offline hash search.
    #:
    #: THE FIX. Keyed ``blake2b`` — a MAC, not a salt prefix (prefixing a
    #: secret into the message is a DIFFERENT, weaker construction: it does not
    #: use the hash's own keying input, and a length-extension-style confusion
    #: is easy for a future edit to introduce by accident. ``key=`` is the
    #: primitive doing the actual work here). Without the secret, an attacker
    #: cannot even evaluate the function to grind against — see
    #: :func:`recsys.core.exploration._rotation_key`.
    #:
    #: ``None`` is the "not configured" state, resolved at use time (never
    #: silently) by :func:`recsys.core.exploration._resolve_seat_secret`:
    #:
    #:   * ``production=True`` and ``seat_secret is None`` -> RAISE here, in
    #:     ``__post_init__``. Never fall back to unkeyed — unkeyed IS the
    #:     vulnerability, and a silent revert is the exact H01/F-R2 shape this
    #:     codebase already refuses elsewhere.
    #:   * ``production=False`` and ``seat_secret is None`` -> a per-process
    #:     random 32-byte key + a WARNING log, never silent and never a
    #:     disabled lane (a disabled lane would mean every dev/test run
    #:     measures a different algorithm than production).
    #:
    #: Loaded from ``LUMEN_EXPLORE_SEAT_SECRET`` (64 hex chars = 32 bytes) via
    #: :meth:`from_env` — the SAME env-loading boundary :class:`HafsqlConfig`
    #: uses for its own credentials (see its ``from_env``), reused rather than
    #: inventing a second pattern. Never in a config file, never frozen into
    #: the trust snapshot, never logged in full — log only a short fingerprint
    #: (:func:`recsys.core.exploration.seat_secret_fingerprint`) if an operator
    #: needs to confirm two replicas agree.
    #:
    #: DELIBERATELY NOT mixed with the viewer (BUILDMAP-C's C1b, out of this
    #: unit's scope and shipped OFF by that map's own ruling): concentration
    #: was only ever dangerous because the pick was GRINDABLE, and keying
    #: removes that. A per-viewer phase would spend the exploration budget
    #: teaching nothing, for no security benefit once the pick can no longer be
    #: precomputed.
    seat_secret: bytes | None = None
    #: The PREVIOUS secret, held alongside a freshly-rotated ``seat_secret``
    #: during a rollover window so every replica agrees on which key covers
    #: which bucket regardless of deploy timing (see
    #: ``seat_secret_active_from_bucket``). ``None`` outside a rollover.
    previous_seat_secret: bytes | None = None
    #: The bucket at which ``seat_secret`` becomes the active key for that
    #: bucket and every bucket after it; buckets strictly before it still
    #: resolve to ``previous_seat_secret``. 0 (default) means ``seat_secret``
    #: has always been active — the ordinary, non-rotating case.
    #:
    #: LOAD-BEARING, NOT COSMETIC. Rotating the secret without an activation
    #: bucket would re-roll every viewer's seat the instant ANY ONE replica
    #: redeploys, rather than at one shared clock tick — a staggered rollout
    #: would then have different replicas disagreeing on the seat's occupant
    #: for the whole length of the deploy, which is exactly the
    #: within-bucket-stability property `rotation_hours` exists to guarantee.
    #: Hold both secrets and select by bucket instead.
    seat_secret_active_from_bucket: int = 0
    #: Dev/test switch (2026-08-04). ``False`` (default): an absent
    #: ``seat_secret`` falls back to a per-process random key + a loud warning
    #: — the safe, non-raising default every existing fixture and test
    #: constructs under. ``True``: an absent ``seat_secret`` is REFUSED at
    #: construction (see ``__post_init__``), because in production a
    #: per-process random key is worse than useless — every replica would pick
    #: its own occupant for the same viewer, and a deploy that forgot the env
    #: var would surface only as a livesite ticket about a flickering feed,
    #: not a loud failure. Same boundary shape as
    #: :func:`recsys.pipeline.build_trust_snapshot`'s own ``production`` flag.
    production: bool = False
    #: ★ How long one viewer keeps the SAME occupant of the reserved slot, in
    #: hours (2026-08-04). 0 disables rotation.
    #:
    #: WHY THIS IS NOT `DiversityConfig.explore_bucket_hours`. That field is the
    #: re-ranker's own exploration slot, which ships at 0 and is a different
    #: mechanism. This package has already been bitten twice by one property
    #: serving two purposes (`requires_second_degree` silently carrying the
    #: flooding cap, then the author floor), so the second bucket gets its own
    #: name rather than borrowing a knob that means something else.
    #:
    #: WHAT IT SUBSTITUTES FOR. The spec's real bound is a per-post SERVE CAP
    #: (~100 serves, then retire on futility), and that needs the serving log
    #: (item B11) which does not exist. Without any serve counting, a post with
    #: zero engagement holds the slot for its whole eligibility window — and
    #: because the pipeline is deterministic, that means the SAME viewer meets
    #: the SAME newcomer in the same seat on every refresh for days.
    #:
    #: Rotating the seat on a clock removes that symptom with no stored state:
    #: stable inside a bucket (a viewer cannot refresh-reroll for a better
    #: feed — the same property `explore_bucket_hours` documents) and different
    #: across buckets, so a reader meets up to four different newcomers a day.
    #: "Up to": the seat can only move between authors who are EQUALLY unheard,
    #: so the realised number is bounded by how many authors tie at the bottom.
    #: Measured in the sim world that tier held one author in 175 of 206 pools
    #: and two in the rest — there, a reader meets one newcomer all day. A live
    #: corpus with many debuts a day has a much larger bottom tier; this is a
    #: property of supply, not of the setting.
    #: It is NOT a serve cap: it neither counts impressions nor retires a post
    #: for earning nothing, so B11 is still the real fix.
    #:
    #: ★ THE BUCKET IS GLOBAL, NOT PER-VIEWER — a deliberate launch-stage
    #: choice, and the first thing to revisit as the site grows. It is derived
    #: from the clock alone, so every viewer whose pool holds the same
    #: tied-least-heard authors meets the SAME newcomer in the same six hours.
    #:
    #: At launch that is the behaviour we want, and concentrating is the point:
    #: the whole supply-side goal (cold-start spec §4.1) is to manufacture ONE
    #: legitimate first vouch for a new author, and one reader in fifty noticing
    #: is likelier when the audience is pointed at the same person than when it
    #: is scattered one-newcomer-per-reader. Small site, thin traffic, needs
    #: concentration.
    #:
    #: At scale it inverts: you only need a bounded number of impressions to
    #: learn whether a post works, so showing it to EVERYONE spends reach that
    #: teaches nothing, and it manufactures a chosen-one effect where whoever
    #: holds the bucket gets the entire platform's exploration traffic. The
    #: production systems this lane is modelled on allocate per item and per
    #: slice of traffic for exactly that reason.
    #:
    #: The change when that day comes is one line: mix the viewer into the
    #: offset (e.g. `bucket + stable_hash(viewer.account)`) so the phase differs
    #: per reader while the period stays 6h. Deliberately NOT done now — it
    #: would dilute the launch-stage concentration described above, and it wants
    #: a real traffic measurement to size, not a guess.
    rotation_hours: int = 6

    def __post_init__(self) -> None:
        if self.slots_per_page < 0:
            raise ValueError(f"slots_per_page must be >= 0, got {self.slots_per_page}")
        if self.rotation_hours < 0:
            raise ValueError(f"rotation_hours must be >= 0, got {self.rotation_hours}")
        # ★ 2026-08-05 council (Seat 2): this was the ONE ExplorationConfig field
        # with no validation, so `-1` silently disabled the serve budget while
        # reading as "configured". 0 is the documented off switch; negative is a
        # typo, and a typo must never look like a policy.
        if self.serve_window_days < 0:
            raise ValueError(
                f"serve_window_days must be >= 0 (0 disables the refill), "
                f"got {self.serve_window_days}"
            )
        if self.max_serves_per_author < 0:
            raise ValueError(
                f"max_serves_per_author must be >= 0 (0 disables the serve budget), "
                f"got {self.max_serves_per_author}"
            )
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
        if self.max_slots_per_feed < 0:
            raise ValueError(
                f"max_slots_per_feed must be >= 0, got {self.max_slots_per_feed}"
            )
        # ★ C1a — RAISE, never fall back to unkeyed (see seat_secret's docstring
        # for why). This is the loudest point this class can enforce it: the one
        # place every ExplorationConfig, however constructed, passes through.
        if self.production and self.seat_secret is None:
            raise ValueError(
                "ExplorationConfig: production=True requires seat_secret. An "
                "absent secret must never silently fall back to an unkeyed or "
                "per-process-random reserved seat in production — that is "
                "exactly the offline-grindable hole C1a closes (measured: 6 "
                "accounts + ~92,546 offline hashes held the seat in 85.1% of "
                "cells against 60 honest rivals). Set LUMEN_EXPLORE_SEAT_SECRET "
                "(64 hex chars) and construct via "
                "ExplorationConfig.from_env(production=True)."
            )
        if self.seat_secret is not None and len(self.seat_secret) != 32:
            raise ValueError(
                "ExplorationConfig.seat_secret must be exactly 32 bytes "
                f"(blake2b key), got {len(self.seat_secret)}"
            )
        if self.previous_seat_secret is not None and len(self.previous_seat_secret) != 32:
            raise ValueError(
                "ExplorationConfig.previous_seat_secret must be exactly 32 "
                f"bytes, got {len(self.previous_seat_secret)}"
            )
        if self.seat_secret_active_from_bucket < 0:
            raise ValueError(
                "seat_secret_active_from_bucket must be >= 0, got "
                f"{self.seat_secret_active_from_bucket}"
            )

    @classmethod
    def from_env(cls, *, production: bool = False) -> ExplorationConfig:
        """Load the seat-rotation secret(s) from the environment (C1a) — the
        SAME env-loading boundary :class:`HafsqlConfig.from_env` uses for its
        own credentials, reused rather than inventing a second pattern. Never
        read from a config file; the secret must be a deploy-time artifact.

        ``LUMEN_EXPLORE_SEAT_SECRET`` — 64 hex chars (32 bytes). Required when
        ``production=True``; enforced by ``__post_init__``, not here, so a
        hand-built ``ExplorationConfig(production=True, seat_secret=...)``
        gets the identical guarantee as going through this constructor.

        ``LUMEN_EXPLORE_SEAT_SECRET_PREVIOUS`` /
        ``LUMEN_EXPLORE_SEAT_SECRET_ACTIVE_FROM_BUCKET`` — optional rollover
        pair; supply both together when rotating (see
        ``seat_secret_active_from_bucket``'s docstring). Reading only one of
        the pair is almost certainly an operator mistake, but is not refused
        here — the SHAPE of that mistake (an activation bucket with nothing to
        activate FROM) is already handled the same as "no rollover in
        progress" by ``_resolve_seat_secret``, so it fails toward the current
        secret rather than toward an exception mid-rollout.
        """

        def _hex32(name: str) -> bytes | None:
            raw = os.environ.get(name)
            if not raw:
                return None
            try:
                return bytes.fromhex(raw)
            except ValueError as exc:
                raise ValueError(f"{name} is not valid hex: {exc}") from exc

        active_from_raw = os.environ.get("LUMEN_EXPLORE_SEAT_SECRET_ACTIVE_FROM_BUCKET")
        return cls(
            production=production,
            seat_secret=_hex32("LUMEN_EXPLORE_SEAT_SECRET"),
            previous_seat_secret=_hex32("LUMEN_EXPLORE_SEAT_SECRET_PREVIOUS"),
            seat_secret_active_from_bucket=(
                int(active_from_raw) if active_from_raw is not None else 0
            ),
        )


@dataclass(frozen=True)
class ColdStartConfig:
    """Interest-selection seeding (rev 2.2). Tags are the sole interest
    substrate since communities were retired as a lane (2026-08-04, R1/R3)."""

    # Enforced at the signup/API boundary (outside recsys): a viewer must pick
    # at least this many interest tags, so the cold-start lane is never empty.
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

    #: ★ C6 (2026-08-04). Upper bound on padding's share of the RETURNED feed.
    #: ``POPULAR_FALLBACK`` is exempt from both the second-degree vouch gate
    #: (``requires_second_degree``) and — unlike every other exempt source —
    #: was ALSO exempt from the graph-cred AUTHOR FLOOR
    #: (``CandidateSource.requires_author_floor``, ``contracts.py``); the only
    #: defense was `_fallback_filler`'s own drop of the proven-self-dealt
    #: (score <= 0.0) band. Measured (`A8_popular_lane.py`, 2026-08-04):
    #: **60/60** viewers received padding, mean **38.7%** of the served feed,
    #: max **56.0%** — through a lane with the LEAST vetting of any source.
    #:
    #: 0.25 (1 in 4) is the shipped default: generous enough that a healthy
    #: feed's occasional top-up (a handful of posts out of 20+) is nowhere
    #: near the cap and stays byte-for-byte unaffected, tight enough that a
    #: feed which is now MOSTLY unvetted padding gets bounded instead.
    #:
    #: ``rank_feed``'s docstring already claims (`pipeline.py`) that a pool at
    #: or above `min_feed_size` never touches the fallback — that text was
    #: describing the OLD guard (`len(eligible) < min_feed_size`); the actual
    #: guard bails at `diversity.top_k` (200), which is why a thin-but-nonzero
    #: pool could still be diluted to <=56%. This field bounds the dilution
    #: directly rather than relying on the (already-corrected-elsewhere) bail
    #: threshold to do it.
    #:
    #: WHO PAYS, stated plainly: a cold/niche viewer whose own pool was tiny
    #: relative to `min_feed_size` used to be padded all the way to a full
    #: screen (or deeper, up to `top_k`) regardless of share; now the total
    #: feed length itself shrinks with the cap, because there is no longer
    #: enough vetted content to justify padding it out that far. See
    #: `_fallback_filler` for exactly how the cap composes with the existing
    #: `min_feed_size` floor and supply ceiling. If real traffic shows this
    #: cutting a real cohort below one screen, RAISE this value — the fix is a
    #: config number, not removing the bound.
    #:
    #: 0.0 bounds padding to whatever is needed to reach exactly
    #: `min_feed_size` (the tightest legal setting — the floor still wins).
    #: 1.0 disables the cap entirely: an exact no-op, byte-identical to
    #: pre-C6 behaviour.
    max_share_of_feed: float = 0.25

    def __post_init__(self) -> None:
        if self.min_feed_size < 0:
            raise ValueError(f"min_feed_size must be >= 0, got {self.min_feed_size}")
        if not 0.0 <= self.max_share_of_feed <= 1.0:
            raise ValueError(
                f"max_share_of_feed must be in [0, 1], got {self.max_share_of_feed}"
            )


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
    #: ★★★ B4 (2026-08-06) — CEILING on the unknown-identity budget.
    #:
    #: Without it the budget is `unknown_free + unknown_per_vouched * vouched`,
    #: which grows without bound in the target's own popularity — measured 31.0
    #: at 10 vouched engagers and ~300 once a follow graph exists. Lite signups
    #: are FREE, so that is a zero-cost purchase, and QA measured 3-4x inflation
    #: of the organic score on posts that already had genuine votes. The
    #: per-vouched growth is still right in principle; being unbounded is not.
    #:
    #: 10.0: a post with 5+ vouched engagers already sits at the cap, so the
    #: newcomer floor (`unknown_free`) and the funded-alt bound are untouched,
    #: and only the runaway tail is removed. `<= 0` disables the cap.
    unknown_max: float = 10.0
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


#: ★ Env names for the lite publisher accounts. These lived in
#: ``recsys/io/hafsql.py`` alone; they are here now because
#: :meth:`LiteConfig.from_env` is the single resolver and that module delegates
#: to it. `hafsql` re-exports them so its own docstrings stay accurate.
LITE_PUBLISHER_ACCOUNTS_ENV = "LITE_PUBLISHER_ACCOUNTS"
LITE_FRONTEND_ACCOUNT_ENVS: tuple[str, ...] = (
    "LITE_FRONTEND_ACCOUNT_MAINNET",
    "LITE_FRONTEND_ACCOUNT_MIRRORNET",
    "LITE_FRONTEND_ACCOUNT_TESTNET",
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
    #: ★★★ L2 (2026-08-05) — DSN for the Lumen app's OWN Postgres, where lite
    #: engagement lives (`lumen_vote` / `lumen_reblog`, migration
    #: `0009_engagement.sql`). This is a THIRD database, distinct from both the
    #: public HAFSQL mirror and the recsys DB (`RECSYS_DATABASE_URL`): the
    #: frontend calls it `LITE_DATABASE_URL`.
    #:
    #: `None` (the default) means lite engagement is simply not read — the same
    #: honest-degrade posture A15 network-suppression already takes for its own
    #: optional connection: a WARNING, an empty result, never a crash and never
    #: a silent pretence that there was no engagement.
    #:
    #: Lite engagement is deliberately confined to POST HYDRATION. It never
    #: reaches `engagement_edges`, so it cannot build graph-cred or confer
    #: vouch — see `Vote.lite` for why that boundary is the whole design.
    engagement_dsn: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.publisher_accounts)

    @property
    def engagement_enabled(self) -> bool:
        """Separate from :attr:`enabled` on purpose: a deploy can source lite
        POSTS (publishers configured) long before it can reach the app database,
        and reading engagement without the DSN is not a degraded mode, it is a
        different one."""
        return self.engagement_dsn is not None

    @classmethod
    def from_env(cls, base: LiteConfig | None = None) -> LiteConfig:
        """Resolve publishers and the engagement DSN from the environment.

        ★★★ THE SINGLE SOURCE, deliberately. The publisher env names lived in
        ``recsys/io/hafsql.py`` only, and the DSN was read nowhere at all, so
        ``LiteConfig.from_env`` had NO CALLER — the identical shape of the
        2026-08-04 defect where ``ExplorationConfig.from_env`` was referenced
        only inside its own error message and the keyed seat could never
        receive a real key. Two separate consequences, both live:

        * ``Settings.lite`` was always the empty default, so the L1 lite-author
          discovery fix could never fire in production;
        * nothing read ``LUMEN_LITE_DATABASE_URL``, so L2 lite engagement could
          never be read either.

        Both entry points now come through here. ``recsys.io.hafsql``'s own
        ``_lite_config_from_env`` delegates to this rather than keeping a second
        copy of the rules, because two env readers that can disagree is how a
        config path rots.

        ``base`` lets an operator name publishers in code and keep the DSN in
        the environment, where a credential belongs, without either clobbering
        the other: anything already set on ``base`` wins over an absent
        variable, and an explicitly-set variable wins over the default.
        """
        source = base if base is not None else cls()
        accounts: set[str] = set(source.publisher_accounts)
        csv = os.environ.get(LITE_PUBLISHER_ACCOUNTS_ENV, "")
        accounts.update(name.strip() for name in csv.split(",") if name.strip())
        for env_name in LITE_FRONTEND_ACCOUNT_ENVS:
            value = os.environ.get(env_name, "").strip()
            if value:
                accounts.add(value)
        return replace(
            source,
            publisher_accounts=frozenset(accounts),
            engagement_dsn=os.environ.get("LUMEN_LITE_DATABASE_URL", source.engagement_dsn),
        )


@dataclass(frozen=True)
class TrustConfig:
    """Weekly trust-snapshot freshness (A8.3, 2026-08-04).

    ★ THE GAP THIS CLOSES. `TrustSnapshot` had no timestamp at all, so
    `_trust_is_fresh` (pipeline.py) could tell "present" and "non-empty" and
    "not degraded" apart but had no way to tell a snapshot built THIS WEEK
    from one built six months ago — both looked identically fresh, and both
    would be served under :attr:`~recsys.pipeline.TrustPolicy.FAIL_CLOSED`
    with no operator-visible signal that the batch had silently stopped
    running. That is the same silent-degradation shape H01/F-R2 close
    elsewhere in this package, just on the CALENDAR axis instead of the
    empty/degraded axis.

    ``max_snapshot_age_days`` is consulted only when
    ``TrustSnapshot.built_at`` is present — a snapshot with no timestamp
    (every existing fixture/harness snapshot, and any snapshot from before
    this field existed) stays exactly as fresh as before this unit, so
    nothing already-passing changes behaviour. Only a snapshot that carries a
    timestamp AND has aged past the limit newly fails freshness — consistent
    with :attr:`~recsys.pipeline.TrustPolicy.FAIL_CLOSED` being the safe
    default: an operator who stops running the weekly batch gets a refused
    feed, not a silently-stale one.

    14 days (two batch periods) is the shipped default: one missed run is
    tolerated (the batch may legitimately be a few days late), two in a row
    is treated as the operational failure it is.
    """

    max_snapshot_age_days: int = 14

    def __post_init__(self) -> None:
        if self.max_snapshot_age_days < 0:
            raise ValueError(
                "max_snapshot_age_days must be >= 0 (0 disables the check), got "
                f"{self.max_snapshot_age_days}"
            )


@dataclass(frozen=True)
class PopularConfig:
    """The across-Hive popularity lane (2026-08-08, owner: "we need across Hive
    popularity lane and that needs at least 3 slots inside top 10 but not
    manually set. it has to surface there").

    See :mod:`recsys.core.popular` for the mechanism. The short version: a
    genuinely huge post outside the viewer's follows and outside their tags was
    never a CANDIDATE, so no ranking change could reach it;
    ``POPULAR_FALLBACK`` is padding for a starved pool, not a lane. This sources
    chain-wide top posts for every viewer on every request and selects among
    them by TRUST-BUDGETED credited breadth.

    ★ "NOT MANUALLY SET" IS AN ARCHITECTURAL CONSTRAINT, not a preference. The
    lane is NOT spliced at fixed indices the way the exploration seat is
    (:func:`recsys.core.exploration.insert_exploration`). Its members are scored
    by the ordinary composite and placed by the ordinary greedy re-ranker; the
    only thing this build gives them is
    :attr:`DiversityConfig.popular_per_page`, which stops the UNCHOSEN-lane
    quota from capping them — a removal of an obstacle, not a reserved seat. If
    they do not genuinely out-score the page they do not appear, and the
    measured count is what it is.
    """

    #: How many posts the lane may contribute to the candidate pool. Sized
    #: against the owner's target shape (popularity ~4 of 20 served, >=3 inside
    #: the top 10) with headroom for the ones that lose on score, get deduped
    #: into a higher-priority lane, or fail `filter_eligible`.
    #:
    #: 0 DISABLES the lane and is an exact no-op — `select_popular` returns []
    #: and `gather_candidates` appends nothing, so every measurement taken
    #: before 2026-08-08 reproduces bit-for-bit.
    #:
    #: ★★★ SHIPPED AT **0**, AND THE LANE IS THE MEASUREMENT THAT SAYS WHY
    #: (2026-08-08). This is not a half-built feature: the sourcing gap is
    #: closed, selection is credited-breadth, the recall set is per-author
    #: capped, and it is covered by tests. It is off because at the CURRENT
    #: SCORING WEIGHTS it does not pay for itself, on two independent measures:
    #:
    #: * **It fails the requirement it was asked to meet.** The owner's terms
    #:   were ">=3 slots inside top 10 but not manually set — it has to
    #:   surface there". Measured over 96 feeds: with `popular_per_page`
    #:   exemption ON the lane holds 3.72 of 20 but only **0.93 of the top
    #:   10**; with the exemption OFF but still sourced, **0.76**. Against the
    #:   required 3.0 that is a margin of **-2.24**. Popular posts simply do
    #:   not out-score their neighbours here, so the only route to 3 is to
    #:   SPLICE them at fixed indices — precisely what "not manually set"
    #:   forbids. Widening the exemption until the number appears would be
    #:   dressing a reserved slot up as earned.
    #: * **It costs the reader more than any other lane.** `q11_follow_curve`
    #:   is GREEN with `limit = 0` and RED at all 8 follow counts with the lane
    #:   on, by **-0.046 to -0.110** against `ACCEPTED_CURVE`; `q1` nDCG@20
    #:   goes 0.777 -> 0.696 (through its own 0.70 floor). Attributed by
    #:   single-field mutants, not inferred: `popular.limit=0` restores GREEN,
    #:   while `weights.in_network_bonus=0.0` and
    #:   `exploration.max_author_age_days=0` each leave all 8 violations in
    #:   place. Independently, turning the lane off raises `mean_rel@20` by
    #:   **+0.1126 (+17.1%)** — against 0.0137 for the whole exploration lane,
    #:   i.e. ~8x the cost of the newcomer seat for a target it misses by 69%.
    #:
    #: **WHAT WOULD MAKE IT SHIPPABLE is a scoring change, not a bigger quota:**
    #: chain-wide popularity has to EARN top-10 positions through the composite
    #: (a lane-aware treatment of the organic percentile, measured against
    #: `mean_q@20`/`stack_capture_g`/`auc_own_m5`), at which point this flips to
    #: 25 and `DiversityConfig.popular_per_page` stops being the load-bearing
    #: part. Until then the honest report is the measured number.
    #: ★ TURNED ON 2026-08-09 (owner: "turn it on"). It sat at 0, so the lane
    #: was sourced by nobody and contributed exactly zero posts — measured live
    #: across 12 viewers at limit 0: 0.00 `oon_popular` in the top 10 AND 0.00
    #: anywhere in a 50-post feed. The earlier "it costs 17.1% reader
    #: relevance" reading was taken BEFORE the interest term was repaired (the
    #: tag-count denominator that was handing a third of the score to
    #: single-tag `hive` meta-posts) and before stake-weighted votes were
    #: removed above, so it was measuring a lane competing against a broken
    #: composite. 25 is the value this field's own note names as correct once
    #: the lane can earn its place; `DiversityConfig.popular_per_page` (4) is
    #: the per-page budget that bounds it.
    #: ★★★ HELD AT 0 AGAIN — 2026-08-09, and this time with the numbers.
    #:
    #: The owner said "turn it on", so it was turned on (25) and MEASURED, not
    #: assumed. It fails this project's own two purpose-built gates, under the
    #: repaired composite the 08-09 note below hoped would rescue it:
    #:
    #:   * `q11_follow_curve.py` — hard AssertionError, ALL 8 follow counts
    #:     regressed below the accepted curve: n=0 -0.1024, n=3 -0.0710,
    #:     n=5 -0.0798, n=20 -0.0370. Reverting ONLY this field (keeping
    #:     the vote change) returns SELF-CHECK PASSED, so the popularity
    #:     lane is the cause and the vote change is not implicated. Isolated by
    #:     `LUMEN_SETTINGS_MUTANT='{"popular.limit": 0}'`.
    #:     ★ THAT DIAGNOSTIC CONCLUSION IS FALSE (PRUNED H1b, re-measured
    #:     2026-08-10): reverting only this field leaves q11 RED at 2 of 8
    #:     follow counts, so a second, unattributed regression exists. The
    #:     field is still shipped at 25 here, against the ruling three lines
    #:     above; that contradiction is NOT resolved by this build.
    #:   * `q12_lane_balance.py` — G1b: 0.469 of the required 3.0 slots in the
    #:     top 10 (-84%). G2a: `oon_popular` lands a mean of 3.144 ranks ABOVE
    #:     what its own score earns, against a -1.0 bound (-214%).
    #:
    #: G2a is the part that settles it. The lane is not losing a fair fight — it
    #: is being PLACED, three ranks above merit, by the per-page exemption. So
    #: switching it on does not deliver "popular posts earn their way in"; it
    #: delivers a smaller, quieter version of the manual placement the owner
    #: already ruled out, and charges every reader 3-10 points of relevance for
    #: 16% of the target.
    #:
    #: NOT re-pinning ACCEPTED_CURVE to make this green — that file says so
    #: itself, and it is right. What would actually earn the lane its slots is a
    #: scoring change (chain-wide popularity competing inside the composite),
    #: not a bigger quota. One line flips this to 25 the moment that lands, or
    #: the moment the owner decides the relevance cost is worth paying.
    limit: int = 25

    #: How many posts the SQL prefilter returns for the selection step to
    #: choose from. This is a RECALL budget, and the ratio to ``limit`` is the
    #: lane's only defence against a farm displacing honest posts out of the
    #: prefilter — see :mod:`recsys.core.popular`'s residual note. `_SQL_
    #: POPULAR_POSTS` is not trust-weighted (SQL cannot see the weekly
    #: graph-cred snapshot), so a funded-alt swarm CAN buy prefilter positions;
    #: what it cannot do is survive `select_popular`'s budgeted re-scoring. 6x
    #: `limit` means a farm must fill 150 slots, not out-rank one post.
    #:
    #: Not larger, because every prefiltered row is HYDRATED (votes, comments,
    #: rebloggers) on the request path — see `recsys.io.hafsql`'s measured
    #: hydration cost, which is dominated by total vote volume and is exactly
    #: where this query's rows sit (the busiest posts on the chain).
    #: ★ Lane composition (2026-08-09, owner's numbers). `payout_share` is the
    #: ONLY route stake takes into this lane — the owner capped it at 10%
    #: because Hive votes are botted. `comment_share` splits the remaining 90%
    #: between comments and reblogs.
    payout_share: float = 0.10
    comment_share: float = 0.60
    #: On-chain DISPLAY reputation at or above this is "established".
    rep_bonus_threshold: float = 60.0
    #: Maximum LIFT reputation can give a crowd, as a fraction. 0.4 = at most
    #: 1.4x. Deliberately below the ratio between a large and a small genuine
    #: crowd (200 commenters carry 1.43x the log spread of 40), so reputation
    #: can never let a small established group out-score a much larger real one.
    #: An earlier ADDITIVE form worth up to 5.0 did exactly that. See `_weighted`.
    rep_lift: float = 0.4
    #: ★★★ CONTAINER POSTS CAN NEVER WIN THIS LANE (2026-08-09).
    #:
    #: `peak.snaps`, `ecency.waves` and `leothreads` publish ROLLING CONTAINER
    #: posts that other frontends file short-form content into as comments —
    #: the same mechanism Lumen uses for `lumen-c-<ulid>`. They accumulate
    #: hundreds of commenters because that is their JOB, not because anyone
    #: found them interesting, so on a conversation-ranked lane they win by
    #: construction. Measured live on a 60-post chain-wide pool: the top THREE
    #: picks were `peak.snaps/snap-container-…` (112 commenters, 100% of the
    #: most-discussed), a second `peak.snaps` container (106), and
    #: `ecency.waves/waves-…` (68). A reader would have been served an empty
    #: shell whose comments are other people's snaps.
    #:
    #: This is the same shape as the `hive` TAG defect the interest term had —
    #: a namespace marker scoring as if it were content — one level up.
    #:
    #: Matched on author AND permlink prefix together. Author alone would
    #: exclude a genuine post by those accounts; prefix alone would exclude
    #: anyone who happens to name a post that way.
    container_markers: tuple[tuple[str, str], ...] = (
        ("peak.snaps", "snap-container-"),
        ("ecency.waves", "waves-"),
        ("leothreads", "leothread-"),
    )
    #: Our own containers, matched against `LiteConfig.publisher_accounts` so a
    #: new publisher account is covered the day it is configured, with no second
    #: list to keep in sync.
    lumen_container_prefix: str = "lumen-c-"

    #: ★★★ THE RESERVED SLOT (2026-08-09, owner: "lock in 1 popular post inside
    #: top 10, force it in, make sure it cant show up twice, always sub 5 spot").
    #:
    #: 1-indexed position in the served feed. 6 satisfies "sub 5": positions 1-5
    #: are never touched, so the head of the feed stays whatever the reader
    #: earned, and the popular post sits immediately below it where it is still
    #: plainly visible.
    #:
    #: WHY A RESERVED SLOT AND NOT A BIGGER QUOTA. Measured across 96 feeds, the
    #: lane appeared in 40% of them and that number was IDENTICAL at
    #: `DiversityConfig.popular_per_page` of 1, 2 and 3 — the cap governs how
    #: many appear where the lane already won, and cannot create presence where
    #: it lost. Only a reserved position can, which is exactly how the newcomer
    #: lane has always worked (`ExplorationConfig.position`).
    #:
    #: 0 disables the reservation and returns the lane to earning its slots.
    reserved_position: int = 6
    #: Hard ceiling on popular posts in ONE feed. Enforced in `insert_popular`,
    #: which drops the surplus — a review found this field was previously read
    #: only as `<= 0` and was otherwise decorative, while 11% of feeds served two
    #: popular posts and 2% served three. `DiversityConfig.popular_per_page`
    #: cannot do this job: it is an exemption budget, not a cap.
    max_reserved_per_feed: int = 1
    #: Ceiling on what reputation ALONE can add. Reputation is stake-derived and
    #: an aged account can hold it, so it must help without being buyable
    #: without limit.
    rep_max_credit: int = 10

    source_limit: int = 150

    def __post_init__(self) -> None:
        if self.limit < 0:
            raise ValueError(f"popular limit must be >= 0, got {self.limit}")
        if not 0.0 <= self.payout_share <= 1.0:
            raise ValueError(f"popular payout_share must be in [0,1], got {self.payout_share}")
        if not 0.0 <= self.comment_share <= 1.0:
            raise ValueError(f"popular comment_share must be in [0,1], got {self.comment_share}")
        if not 0.0 <= self.rep_lift <= 1.0:
            raise ValueError(f"popular rep_lift must be in [0,1], got {self.rep_lift}")
        if self.reserved_position < 0:
            raise ValueError(
                f"popular reserved_position must be >= 0, got {self.reserved_position}"
            )
        if 0 < self.reserved_position <= 5:
            raise ValueError(
                "popular reserved_position must be 0 (off) or > 5 — the owner's rule is that "
                f"the head of the feed is never displaced, got {self.reserved_position}"
            )
        if self.max_reserved_per_feed < 0:
            raise ValueError(
                f"popular max_reserved_per_feed must be >= 0, got {self.max_reserved_per_feed}"
            )
        if self.rep_max_credit < 0:
            raise ValueError(f"popular rep_max_credit must be >= 0, got {self.rep_max_credit}")
        if self.source_limit < 0:
            raise ValueError(
                f"popular source_limit must be >= 0, got {self.source_limit}"
            )
        if self.limit and self.source_limit < self.limit:
            raise ValueError(
                "popular source_limit must be >= limit — a prefilter smaller "
                "than the lane makes the credited-breadth selection step a "
                "no-op and silently reinstates the untrusted SQL ordering as "
                f"the lane's membership rule (got source_limit={self.source_limit}, "
                f"limit={self.limit})"
            )


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
    popular: PopularConfig = field(default_factory=PopularConfig)
    fallback: FallbackConfig = field(default_factory=FallbackConfig)
    real_graph: RealGraphWeights = field(default_factory=RealGraphWeights)
    graph_cred: GraphCredConfig = field(default_factory=GraphCredConfig)
    flooding: FloodingConfig = field(default_factory=FloodingConfig)
    ring: RingConfig = field(default_factory=RingConfig)
    als: ALSConfig = field(default_factory=ALSConfig)
    vote_signal: VoteSignalConfig = field(default_factory=VoteSignalConfig)
    hafsql: HafsqlConfig = field(default_factory=HafsqlConfig)
    lite: LiteConfig = field(default_factory=LiteConfig)
    trust: TrustConfig = field(default_factory=TrustConfig)
    #: ★ C5/R2/R13 (2026-08-04). The curated trust-root seed list, loaded once
    #: from the package-data file at import time (see `_load_trusted_seeds`).
    #: `build_trust_snapshot` defaults its own `trusted_seeds` parameter from
    #: THIS field when the caller passes none — see that function's docstring
    #: for why the wiring lives there rather than requiring every caller to
    #: remember `trusted_seeds=settings.trusted_seeds` by hand (R2: "a wiring
    #: requirement every caller must remember is the defect, not the fix").
    #: Override explicitly (e.g. `frozenset()`) for any test/harness world
    #: that must NOT have real Hive account names land in its synthetic
    #: graph-cred — see `build_trust_snapshot`'s fixture-migration note.
    trusted_seeds: frozenset[str] = field(default_factory=_load_trusted_seeds)

    @classmethod
    def from_env(cls, *, production: bool = False) -> Settings:
        """Construct ``Settings`` with secrets loaded from the environment —
        the wiring ``Settings`` itself was missing (2026-08-04, C1a follow-up).

        Before this method existed, NOTHING called
        :meth:`ExplorationConfig.from_env` — ``grep -rn
        'ExplorationConfig.from_env'`` returned exactly one hit, inside that
        method's own error-message string. Every ``Settings()`` (including
        :data:`DEFAULT_SETTINGS`, which every current caller uses) therefore
        always carried ``exploration.seat_secret is None`` no matter what
        ``LUMEN_EXPLORE_SEAT_SECRET`` held in the real environment — the seat
        rotation's keyed MAC (the fix for the measured 85.1%-seat-capture
        hole, see ``ExplorationConfig.seat_secret``'s own docstring) had no
        path to ever receive a real key.

        Threads exactly one sub-config through its own env-loading boundary
        today: :meth:`ExplorationConfig.from_env`, which reads
        ``LUMEN_EXPLORE_SEAT_SECRET`` (plus the optional rollover pair — see
        that method's docstring for the full contract). Every other field
        keeps its ordinary hand-tuned ``field(default_factory=...)`` default;
        nothing else on ``Settings`` currently has a secret to load (compare
        :class:`HafsqlConfig`, whose own ``from_env`` is called directly by
        the two process entry points that need it —
        ``recsys.service.app``/``recsys.jobs.trust_batch`` — rather than
        through ``Settings``, because the HAFSQL credentials are threaded
        into the gateway constructor, not this dataclass).

        ``production`` is forwarded verbatim to ``ExplorationConfig.from_env``,
        so ``Settings.from_env(production=True)`` with no
        ``LUMEN_EXPLORE_SEAT_SECRET`` set raises ``ValueError`` right here
        (via ``ExplorationConfig.__post_init__``) rather than silently
        constructing a production ``Settings`` with an unkeyed/random seat —
        the same "refuse to start" guarantee a caller gets from constructing
        ``ExplorationConfig`` directly.

        Deliberately NOT wired into :data:`DEFAULT_SETTINGS` (evaluated once
        at import time with ``production=False`` and relied on by the whole
        test suite plus every measurement-harness panel as a stable,
        offline, environment-independent baseline — reading real env vars at
        import time would make that baseline flaky/order-dependent). A
        production entry point should call
        ``Settings.from_env(production=True)`` explicitly instead of
        importing ``DEFAULT_SETTINGS``.
        """
        # ★★★ L1/L2 (2026-08-05) — `lite` is threaded for exactly the reason
        # the docstring above records for `exploration`, and it was the SAME
        # defect one layer over: `Settings.lite` was always the empty default,
        # so `settings.lite.enabled` was False everywhere in production and the
        # L1 lite-author discovery fix (`author_prior_cache.discover_recent_
        # authors(..., lite=settings.lite)`) could never fire — a fix that
        # passes its own tests and is unreachable where it matters, which is
        # this codebase's most-repeated failure. `LiteConfig.from_env` also
        # carries the L2 engagement DSN, so both halves come through one door.
        return cls(
            exploration=ExplorationConfig.from_env(production=production),
            lite=LiteConfig.from_env(),
        )


DEFAULT_SETTINGS = Settings()
