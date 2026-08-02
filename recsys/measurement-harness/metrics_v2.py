"""metrics_v2 — composition-aware quality metrics the re-ranker cannot fake.

WHY THIS EXISTS. The harness ground truth is
``rel(viewer, post) = interest_match(viewer, author_topic) * author_quality``.
Because rel is MULTIPLICATIVE in interest match, any DCG-family scalar over
feed slots (including the harness's nDCG@20) rises mechanically when the feed
shifts composition toward the viewer's own topic — regardless of whether the
ranker picked BETTER items. That is exactly how the previous fix round showed
a fake +55%: own-topic share of the top-20 rose 113% while the mean author
quality of those same posts FELL. This module separates the two questions the
old metric conflated:

  (a) COMPOSITION — how many own/secondary/other-topic slots the feed serves;
  (b) PICKING     — within each composition stratum, did the ranker choose the
                    best items the eligible pool offered?

THE SCALAR QUESTION, ANSWERED HONESTLY. No single scalar can simultaneously
judge composition and picking without being movable by one of them:

  * any slot-aggregated rel scalar (nDCG, mean-rel) moves under pure
    composition relabeling — the multiplicative structure guarantees it;
  * per-stratum capture ratios have a DEPTH CHANNEL: giving a stratum more
    slots forces its ceiling deeper into the pool (top-n mean quality falls
    with n), so capture gets easier as a stratum grows;
  * a fixed-composition score deliberately refuses to judge the composition
    actually served, so it can't stand alone either.

So the PRIMARY deliverable is a small vector (see :func:`viewer_metrics`).

INSTRUMENT DEFECT LEDGER — adversarial review, patched 2026-07-21. Three
defects were found in this module's previous revision. Each is fixed below;
the old numbers survive ONLY as deprecated continuity aliases.

D1 POOL-CENSORSHIP GAMEABILITY (fixed). The old headline ``fcq_capture``
   graded delivery against the POOL's own rel-ideal — a per-run ceiling.
   Dropping the pool's best content shrank the ceiling faster than delivery,
   raising the headline ~12% while delivered author quality fell ~27%. Every
   capture ratio graded against a per-run pool ceiling has this hole: shrink
   the pool, shrink the ceiling, look better.
   FIX: the corrected headline ``stack_capture_g`` grades delivered quality
   against a FIXED GLOBAL reference — the world's rel-ideal top-k for the
   viewer, computed over ALL world posts, independent of the eligible pool —
   with the composition pinned to that same global ideal and any slot the
   pool cannot fill counted as ZERO quality delivered. The denominator never
   moves with the pool, so the ratio is a monotone function of delivered
   quality alone: no pool manipulation can raise it while the viewer gets
   worse content. (Verified: censoring the pool's rel-ideal top-20 moved the
   old headline UP and ``stack_capture_g`` DOWN, in the same run.)

D2 MIS-LABELLING (fixed). ``fcq_capture`` was documented as "pure
   within-stratum picking skill". It is not: at HEAD it is DOMINATED by the
   author-diversity penalty (a deliberate product HOLD — distinct-authors@20
   stays 20.0 because of it). Isolations at shipped config: author-penalty
   OFF moves it +0.193; topic-penalty OFF moves it -0.002. Reading it as
   ranker skill mistakes the price of an intentional policy for a scoring
   defect. FIX: the successor ``stack_capture_g`` is named for what it
   measures — the quality capture of the FULL RANKING STACK (scoring term
   PLUS diversity penalties) at a pinned composition — and
   :func:`penalty_decomposition` PERMANENTLY splits it into
   ``author_pen_cost``, ``topic_pen_cost``, ``pen_interaction`` and the
   residual ``scoring_gap`` (the scoring term's own picking failure with all
   penalties off). Never cite the headline without the decomposition.

D3 DEPTH ARTIFACTS (fixed). Per-stratum achieved/ceiling/capture/AUC columns
   (``q_own``, ``ceil_q_own``, ``cap_own``, ``auc_own``, ...) move
   mechanically when a stratum's slot count changes: more slots push both
   the achieved mean and the ceiling deeper into the pool. Cross-config
   "cost" figures cited from those columns are depth artifacts whenever the
   configs serve different compositions — proven by a control that froze the
   ranker and forced composition by quota, reproducing the entire cost curve
   with zero picking change. FIX: depth-controlled variants at MATCHED slot
   counts (``q_own_m5``/``q_own_m10``, ``cap_own_m5_g``/``cap_own_m10_g``,
   ``auc_own_m5``/``auc_own_m10``, plus sec/oth at m=5) grade the ranker's
   first m same-stratum preferences at fixed m from the full preference
   order, independent of how many slots the served feed gave the stratum.
   Only these variants may be quoted as picking costs across configs that
   change composition.

WHICH NUMBERS TO TRUST when judging a SCORING-TERM change (the organic term;
diversity knobs untouched):

  TRUSTWORTHY — ``mean_q`` (absolute scale, fixed world; author quality is
  topic-independent in simworld, so composition shifts cannot mechanically
  inflate it); ``stack_capture_g`` + its decomposition (fixed denominator;
  for a scoring-only change the penalty costs stay ~constant, so its delta
  is attributable to the scoring term — confirm via ``scoring_gap``);
  depth-controlled ``q_own_m5/m10``, ``cap_own_m5/m10_g``,
  ``auc_own_m5/m10``. AUC variants carry one validity condition: the
  eligible POOL SET must be identical across the configs compared (a
  scoring-term change leaves eligibility untouched; assert pool-set
  equality as q6 does — censoring the out-of-feed set would game any AUC).

  UNSAFE — ``fcq_capture``/``fcq_q``/``q_rel_ideal`` (deprecated: pool-
  ceiling-relative = censorship-gameable, and penalty-dominated); raw
  ``q_own/q_off``, ``ceil_q_*``, ``cap_own/cap_off``, ``auc_own/auc_off``
  across configs that shift composition (depth channel); ``ndcg``,
  ``mean_rel``, ``ndcg_fixed_comp`` (movable by composition — never chase);
  ``own_share``/``entropy``/``authors``/``n_*`` (descriptors, not scores).

CALIBRATION CAVEAT. Simworld engagement is cleanly topic-structured; real
Hive noise weakens every personalization/CF magnitude. Mechanisms and signs
are reliable; exact figures are directional.

Usage (importable by the existing q-scripts without changing them):

    from metrics_v2 import viewer_metrics, aggregate, session_overlap_loop
    full = [sc.post for sc in rank_feed(viewer, ..., settings=untruncated)]
    m = viewer_metrics(world, "v-photo-00", full)      # dict[str, float]

``full_ranked_posts`` must be the COMPLETE preference order over the eligible
pool — call ``rank_feed`` with a ``DiversityConfig`` whose ``top_k`` exceeds
the pool size (the greedy re-rank is prefix-stable, so its first 200 entries
are bit-identical to the shipped feed). The post SET of that list is the
eligible pool; its order is the ranker's revealed preference.
"""
from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING

_HERE = os.path.dirname(os.path.abspath(__file__))
# ★ The second entry was "/mnt/o/HIVE-BLOG-REBUILD/recsys", which does not exist
# (2026-08-01). Derive the package root from __file__ so the harness runs from
# any working directory and can never bind to a stale tree.
# Same ordering as the panels: prepend, so the harness binds to the tree it sits
# in rather than to an installed `recsys`. This used to `append`, i.e. the exact
# opposite precedence to its own callers, in the same codebase.
for _p in (os.path.dirname(_HERE), _HERE):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)

import numpy as np
from simworld import dcg, overlap_at_k, topic_entropy

if TYPE_CHECKING:  # duck-typed at runtime; annotations only
    from simworld import World

    from recsys.config import Settings
    from recsys.contracts import Post

TIERS = ("own", "sec", "oth")
K = 20


def tier_of(world: World, viewer_name: str, post: Post) -> str:
    """Interest stratum of a post for a viewer: 'own' (match 1.0),
    'sec' (secondary interest, 0.35) or 'oth' (stranger topic, 0.05)."""
    v = world.accounts[viewer_name]
    t = world.accounts[post.author].topic
    if t == v.topic:
        return "own"
    if v.secondary is not None and t == v.secondary:
        return "sec"
    return "oth"


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else float("nan")


def _pick_at_composition(
    world: World, viewer_name: str, pool: list[Post], want: dict[str, int], k: int
) -> list[Post]:
    """First-preferred posts per stratum, filling the ``want`` quotas in the
    pool's own preference order. Returns FEWER than k posts when the pool
    cannot fill a stratum quota — callers must treat missing slots as zero
    quality delivered (that is what makes the D1 fix censorship-immune)."""
    picked: list[Post] = []
    got = dict.fromkeys(TIERS, 0)
    for p in pool:
        s = tier_of(world, viewer_name, p)
        if got[s] < want[s]:
            picked.append(p)
            got[s] += 1
        if len(picked) == k:
            break
    return picked


def _auc(in_q: list[float], out_q: list[float]) -> float:
    """Mann-Whitney AUC: P(quality of an included post > excluded same-stratum
    pool post), ties at 0.5. nan when either side is empty (no decision made)."""
    if not in_q or not out_q:
        return float("nan")
    wins = 0.0
    for a in in_q:
        for b in out_q:
            wins += 1.0 if a > b else (0.5 if a == b else 0.0)
    return wins / (len(in_q) * len(out_q))


def viewer_metrics(
    world: World, viewer_name: str, full_ranked_posts: list[Post], k: int = K
) -> dict[str, float]:
    """The per-viewer metric vector. ``full_ranked_posts`` = the ranker's
    complete preference order over the eligible pool (see module docstring).

    Keys (all floats; nan = stratum empty for this viewer/feed):

    COMPOSITION (reported, never judged by a scalar):
      n_own/n_sec/n_oth  slots per stratum in the top-k;  own_share = n_own/k.
    QUALITY (the anti-gaming anchor — fell last round while nDCG rose):
      mean_q       mean author quality of the top-k;
      q_own/q_sec/q_oth/q_off   achieved mean quality per stratum (off=sec+oth);
      ceil_q_own/ceil_q_off     pool ceiling at the SAME slot counts (top-n_s
                   qualities among same-stratum pool posts) — the depth channel
                   makes these fall as n_s grows, which is why capture ratios
                   are never reported without them;
      cap_own/cap_off           achieved / ceiling;
      auc_own/auc_off           within-stratum selection AUC (in-feed vs
                   out-of-feed same-stratum pool posts, by author quality).
    RELEVANCE (legacy + skill-isolated):
      ndcg         nDCG@k vs the GLOBAL universe ideal (the old, fakeable
                   number — kept for continuity);
      ndcg_ceiling_pool  what a PERFECT ranker scores on this exact eligible
                   pool vs the same global ideal;
      regret       ndcg_ceiling_pool - ndcg (headroom left on the table);
      ndcg_fixed_comp    DCG(actual) / DCG(best arrangement of the pool AT THE
                   FEED'S OWN composition) — picking+ordering skill given the
                   composition served; movable by choosing an easy composition,
                   so never read alone;
      mean_rel / rel_ceiling_pool   mean ground-truth rel of the top-k, and of
                   the pool's best-k.
    CORRECTED HEADLINE (fixed GLOBAL reference — defect D1; composition
    pinned to the world's rel-ideal, denominator pool-independent):
      q_gref       mean author quality of the GLOBAL rel-ideal top-k over
                   ALL world posts — the fixed reference; no pool
                   manipulation can move it;
      pinned_q_g   delivered mean author quality at that pinned composition:
                   ranker's first-preferred posts per stratum from its full
                   preference order, any slot the pool cannot fill counted
                   as ZERO (starving the pool is a delivery failure);
      stack_capture_g  delivered/reference quality ratio — the capture of
                   the FULL RANKING STACK (scoring + diversity penalties;
                   NOT pure picking skill — see defect D2 and
                   :func:`penalty_decomposition`). Monotone in delivered
                   quality; censorship-immune by construction.
    DEPTH-CONTROLLED PICKING (defect D3 — matched slot counts; grade the
    ranker's first m same-stratum preferences at fixed m, independent of the
    served composition; the ONLY per-stratum numbers quotable as costs
    across configs that change composition):
      q_own_m5 / q_own_m10 / q_sec_m5 / q_oth_m5   mean author quality of
                   the first m same-stratum preferences;
      cap_own_m5_g / cap_own_m10_g / cap_sec_m5_g / cap_oth_m5_g   same,
                   as sum-ratio vs the world's top-m same-stratum qualities
                   (fixed reference; pool starvation counts as 0);
      auc_own_m5 / auc_own_m10   Mann-Whitney AUC of the first m own-stratum
                   preferences vs the REST of the own-stratum pool. Validity
                   condition: pool set identical across compared configs.
    DEPRECATED ALIASES (defects D1+D2 — kept ONLY so q6_quality_sweep.py
    keeps running; never cite; q6's label "picking skill" is stale):
      q_rel_ideal  mean author quality of the POOL's rel-ideal top-k —
                   a per-run ceiling, movable by pool censorship;
      fcq_q        mean author quality of first-preferred posts per stratum
                   at the POOL rel-ideal composition;
      fcq_capture  fcq_q / q_rel_ideal — pool-ceiling-relative (gameable:
                   censoring the pool's best RAISES it) and dominated by the
                   author-diversity penalty (+0.193 with the penalty off).
    DIVERSITY (first-class, not an afterthought):
      entropy      topic entropy@k in bits;
      authors      distinct authors@k.
    """
    accounts = world.accounts
    top = full_ranked_posts[:k]
    pool = full_ranked_posts

    def qual(p: Post) -> float:
        return accounts[p.author].quality

    def rel(p: Post) -> float:
        return world.rel(viewer_name, p)

    top_keys = {p.key for p in top}
    tiers_top = {s: [p for p in top if tier_of(world, viewer_name, p) == s] for s in TIERS}
    tiers_pool = {s: [p for p in pool if tier_of(world, viewer_name, p) == s] for s in TIERS}

    out: dict[str, float] = {}
    n = {s: float(len(tiers_top[s])) for s in TIERS}
    out["n_own"], out["n_sec"], out["n_oth"] = n["own"], n["sec"], n["oth"]
    out["own_share"] = n["own"] / max(len(top), 1)

    # --- quality axis ---
    out["mean_q"] = _mean([qual(p) for p in top])
    ceil_parts: dict[str, list[float]] = {}
    for s in TIERS:
        in_q = [qual(p) for p in tiers_top[s]]
        pool_q = sorted((qual(p) for p in tiers_pool[s]), reverse=True)
        out[f"q_{s}"] = _mean(in_q)
        ceil_parts[s] = pool_q[: len(in_q)]
        out_q = [qual(p) for p in tiers_pool[s] if p.key not in top_keys]
        out[f"auc_{s}"] = _auc(in_q, out_q)
    off_in = [qual(p) for p in tiers_top["sec"] + tiers_top["oth"]]
    off_ceil = ceil_parts["sec"] + ceil_parts["oth"]
    out["q_off"] = _mean(off_in)
    out["ceil_q_own"] = _mean(ceil_parts["own"])
    out["ceil_q_off"] = _mean(off_ceil)
    out["cap_own"] = out["q_own"] / out["ceil_q_own"] if ceil_parts["own"] else float("nan")
    out["cap_off"] = out["q_off"] / out["ceil_q_off"] if off_ceil else float("nan")
    # off-stratum AUC: micro-pool the within-tier pairs (never across tiers,
    # so the interest-match confound can't leak into the quality comparison)
    off_pairs_w, off_pairs_n = 0.0, 0
    for s in ("sec", "oth"):
        in_q = [qual(p) for p in tiers_top[s]]
        out_q = [qual(p) for p in tiers_pool[s] if p.key not in top_keys]
        if in_q and out_q:
            off_pairs_w += _auc(in_q, out_q) * len(in_q) * len(out_q)
            off_pairs_n += len(in_q) * len(out_q)
    out["auc_off"] = off_pairs_w / off_pairs_n if off_pairs_n else float("nan")

    # --- relevance axis ---
    gains = [rel(p) for p in top]
    # global rel-ideal over ALL world posts: fixed per (world, viewer, k) and
    # pool-independent — shared by ndcg and the D1-corrected headline below
    global_ideal = sorted(world.posts, key=lambda p: (-rel(p), p.key))[:k]
    ideal_univ = [rel(p) for p in global_ideal]
    idcg = dcg(ideal_univ)
    out["ndcg"] = dcg(gains) / idcg if idcg > 0 else 0.0
    pool_rels = sorted((rel(p) for p in pool), reverse=True)[:k]
    out["ndcg_ceiling_pool"] = dcg(pool_rels) / idcg if idcg > 0 else 0.0
    out["regret"] = out["ndcg_ceiling_pool"] - out["ndcg"]
    out["mean_rel"] = _mean(gains)
    out["rel_ceiling_pool"] = _mean(pool_rels)
    # best arrangement of the pool at the feed's OWN composition
    fc_ideal: list[float] = []
    for s in TIERS:
        srels = sorted((rel(p) for p in tiers_pool[s]), reverse=True)
        fc_ideal.extend(srels[: int(n[s])])
    fc_idcg = dcg(sorted(fc_ideal, reverse=True))
    out["ndcg_fixed_comp"] = dcg(gains) / fc_idcg if fc_idcg > 0 else float("nan")

    # --- CORRECTED HEADLINE (D1): fixed GLOBAL reference. Composition is
    #     pinned to the GLOBAL rel-ideal; the denominator is computed over
    #     ALL world posts, so no pool manipulation can move it; slots the
    #     pool cannot fill deliver 0. Monotone in delivered quality — the
    #     censorship attack (shrink pool -> shrink ceiling) is closed by
    #     construction. NOT pure picking skill (D2): includes the diversity
    #     penalty costs; always read with penalty_decomposition().
    ref_quals = [qual(p) for p in global_ideal]
    out["q_gref"] = _mean(ref_quals)
    want_g = {
        s: sum(1 for p in global_ideal if tier_of(world, viewer_name, p) == s) for s in TIERS
    }
    delivered = sum(qual(p) for p in _pick_at_composition(world, viewer_name, pool, want_g, k))
    ref_sum = sum(ref_quals)
    out["pinned_q_g"] = delivered / k if k > 0 else float("nan")
    out["stack_capture_g"] = delivered / ref_sum if ref_sum > 0 else float("nan")

    # --- DEPTH-CONTROLLED picking (D3): matched slot counts. Grade the
    #     first m same-stratum preferences of the FULL order at fixed m —
    #     the served composition cannot move these via the depth channel.
    tier_pref_q = {s: [qual(p) for p in tiers_pool[s]] for s in TIERS}  # ranker order
    tier_world_q = {
        s: sorted(
            (qual(p) for p in world.posts if tier_of(world, viewer_name, p) == s),
            reverse=True,
        )
        for s in TIERS
    }
    for s, m in (("own", 5), ("own", 10), ("sec", 5), ("oth", 5)):
        first = tier_pref_q[s][:m]
        ref_m = sum(tier_world_q[s][:m])
        out[f"q_{s}_m{m}"] = _mean(first)
        out[f"cap_{s}_m{m}_g"] = sum(first) / ref_m if ref_m > 0 else float("nan")
    for m in (5, 10):
        out[f"auc_own_m{m}"] = _auc(tier_pref_q["own"][:m], tier_pref_q["own"][m:])

    # --- DEPRECATED (D1+D2): pool-ceiling-relative fcq_* aliases, values
    #     UNCHANGED, kept only so q6_quality_sweep.py keeps running. Gameable
    #     by pool censorship; dominated by the author-diversity penalty.
    rel_ideal = sorted(pool, key=lambda p: (-rel(p), p.key))[:k]
    out["q_rel_ideal"] = _mean([qual(p) for p in rel_ideal])
    want = {s: sum(1 for p in rel_ideal if tier_of(world, viewer_name, p) == s) for s in TIERS}
    picked = _pick_at_composition(world, viewer_name, pool, want, k)
    out["fcq_q"] = _mean([qual(p) for p in picked])
    out["fcq_capture"] = (
        out["fcq_q"] / out["q_rel_ideal"] if out["q_rel_ideal"] > 0 else float("nan")
    )

    # --- diversity axis ---
    out["entropy"] = topic_entropy(top, world, k)
    out["authors"] = float(len({p.author for p in top}))
    return out


def aggregate(rows: list[dict[str, float]]) -> dict[str, tuple[float, float]]:
    """Panel aggregate: key -> (nan-mean, nan-std) over per-viewer vectors."""
    out: dict[str, tuple[float, float]] = {}
    for key in rows[0]:
        vals = np.array([r[key] for r in rows], dtype=float)
        finite = vals[~np.isnan(vals)]
        if finite.size == 0:
            out[key] = (float("nan"), float("nan"))
        else:
            out[key] = (float(finite.mean()), float(finite.std()))
    return out


DECOMP_CONFIGS = ("base", "no_author", "no_topic", "no_div")


def decomposition_settings(base: Settings | None = None) -> dict[str, Settings]:
    """The four ranker configs :func:`penalty_decomposition` needs, derived
    from ``base`` (default: shipped ``Settings()``). Non-diversity fields —
    including any scoring-term change under test — carry through unchanged,
    so a scoring round can pass its candidate Settings and get a clean
    decomposition of ITS stack. ``top_k`` is raised so ``rank_feed`` returns
    the full preference order (prefix-stable; bit-identical to the shipped
    prefix). A penalty is switched off via decay=1.0, floor=1.0 (the noDiv
    convention q6 established)."""
    import dataclasses

    from recsys.config import DiversityConfig
    from recsys.config import Settings as _Settings

    if base is None:
        base = _Settings()
    d = base.diversity
    big = max(d.top_k, 100_000)

    def with_div(ad: float, af: float, td: float, tf: float) -> Settings:
        return dataclasses.replace(
            base,
            diversity=DiversityConfig(
                author_decay=ad, author_floor=af, topic_decay=td, topic_floor=tf,
                topic_affinity_strength=d.topic_affinity_strength, top_k=big,
            ),
        )

    return {
        "base": with_div(d.author_decay, d.author_floor, d.topic_decay, d.topic_floor),
        "no_author": with_div(1.0, 1.0, d.topic_decay, d.topic_floor),
        "no_topic": with_div(d.author_decay, d.author_floor, 1.0, 1.0),
        "no_div": with_div(1.0, 1.0, 1.0, 1.0),
    }


def penalty_decomposition(
    world: World,
    viewer_name: str,
    ranked: dict[str, list[Post]],
    k: int = K,
) -> dict[str, float]:
    """The PERMANENT D2 fix: split ``stack_capture_g`` into its causes so the
    headline can never again be misread as one number. ``ranked`` maps each
    name in :data:`DECOMP_CONFIGS` to the FULL preference order produced
    under :func:`decomposition_settings`.

    Returns:
      capture_base / capture_no_author / capture_no_topic / capture_no_div
                       ``stack_capture_g`` under each config;
      author_pen_cost  capture regained by switching the author-diversity
                       penalty off (the price of the distinct-authors HOLD —
                       a POLICY cost, not a scoring defect);
      topic_pen_cost   same for the topic penalty;
      pen_interaction  non-additivity of the two (no_div minus base minus
                       both single costs);
      scoring_gap      1 - capture_no_div — the scoring term's OWN picking
                       failure with every diversity penalty off. THIS is the
                       number a scoring-term round is trying to shrink. It
                       includes the pool-eligibility shortfall, measured
                       ~0.003 at HEAD (ndcg_ceiling_pool 0.997)."""
    caps = {}
    for cfg in DECOMP_CONFIGS:
        caps[cfg] = viewer_metrics(world, viewer_name, ranked[cfg], k)["stack_capture_g"]
    out = {f"capture_{c}": caps[c] for c in DECOMP_CONFIGS}
    out["author_pen_cost"] = caps["no_author"] - caps["base"]
    out["topic_pen_cost"] = caps["no_topic"] - caps["base"]
    out["pen_interaction"] = (
        caps["no_div"] - caps["base"] - out["author_pen_cost"] - out["topic_pen_cost"]
    )
    out["scoring_gap"] = 1.0 - caps["no_div"]
    return out


def session_overlap_loop(
    settings: Settings,
    viewer_name: str,
    *,
    sessions: int = 5,
    seed: int = 7,
    k: int = K,
    votes_per_session: int = 5,
) -> list[int]:
    """Session-over-session top-k overlap under the q5[A] feedback protocol,
    replicated exactly (fresh world per call; viewer upvotes the top-5 posts
    each session as engagement EDGES only — no rshares — then graph-cred + ALS
    retrain via a fresh snapshot; no trusted seeds, as in q5[A]).

    Returns the ``sessions - 1`` consecutive overlaps (each 0..k). k/k means a
    fully frozen session — the feedback loop reserved that screen."""
    from simworld import COMMUNITY, EPOCH, NOW, SimGateway, build_norm, build_world

    from recsys.contracts import EngagementEdge, ViewerProfile
    from recsys.pipeline import build_trust_snapshot, rank_feed

    world = build_world(seed=seed)
    gw = SimGateway(world)
    norm = build_norm(world)
    topic = world.accounts[viewer_name].topic
    added: list[EngagementEdge] = []
    prev: list[Post] | None = None
    overlaps: list[int] = []
    for _ in range(sessions):
        snap = build_trust_snapshot(gw, settings, since=EPOCH, now=NOW)
        v = ViewerProfile(
            account=viewer_name,
            follows=world.follows[viewer_name],
            subscribed_communities=frozenset({COMMUNITY[topic]}),
        )
        f = [
            sc.post
            for sc in rank_feed(
                v, gw, norm, now=NOW, since=EPOCH, settings=settings, snapshot=snap
            )
        ]
        if prev is not None:
            overlaps.append(overlap_at_k(prev, f, k))
        for p in f[:votes_per_session]:
            added.append(EngagementEdge(src=viewer_name, dst=p.author, upvotes=1,
                                        last_interaction=NOW))
        world.edges = world.edges + added[-votes_per_session:]
        prev = f
    return overlaps
