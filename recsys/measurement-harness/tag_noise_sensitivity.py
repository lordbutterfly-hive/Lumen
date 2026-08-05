"""B-17 — Instrument B5: what does a realistic tag-noise level do to the
panels that depend on tags?

WHY THIS EXISTS. Measured at `tag_noise=0.0` (the only value that ever ran
before `simworld.build_world(tag_noise=...)` existed): **100% of posts** have
`tags[0] == true topic`, and every post carries exactly two, perfectly
topic-correlated tags. After the community removal (B-00/R1), `_topic_key`
(`rerank.py`) is `post.tags[0] if post.tags else ""` with NO community
fallback, so the topic-attenuated unchosen-lane penalty, `_topic_affinities`,
`_attenuate`, and any declared-interest scoring term that reads `post.tags`
are ALL validated against a tag oracle that cannot exist on real Hive, where
the first tag is attacker-chosen free text.

This script builds the SAME world 3 times (seeds x topics unchanged) at
tag_noise in {0.0, 0.1, 0.3} — an INDEPENDENT rng stream drives the noise
(see `simworld._apply_tag_noise`), so the population, posts, votes, comments,
reblogs and follow graph are BYTE-IDENTICAL across the three runs; only tag
assignment differs. Any measured delta is attributable to tag noise alone,
not to a different random world.

PROTOCOL mirrors q7/q8 (seed set, curated trusted seeds, 24-viewer panel,
k=20, shipped `Settings()`), so the tag_noise=0.0 row should be readable
against q7/q8's own printed numbers as a sanity cross-check (not asserted —
those panels use seed=7 only; this one averages 4 seeds).

Reports TWO things:
  1. the standard viewer_metrics vector (mean_q, stack_capture_g, mean_rel,
     own_share, entropy) at each noise level — how much the RANKING side
     degrades;
  2. the EXPLORATION lane's reach at each noise level — and an HONEST
     LIMITATION on why this second number is expected to be FLAT (not a bug
     in the noise generator): `exploration._interest_match` (R3, C2b) tests
     `post.category`, not `post.tags`, and `simworld.build_world` sets
     `category=a.topic` — the AUTHOR'S TRUE TOPIC, drawn independently of
     `tags` and untouched by `_apply_tag_noise`. On real Hive `category` is
     the SAME chain field as `tags[0]` (confirmed: `recsys/io/hafsql.py:814`,
     `community = category if category.startswith("hive-") else None`, fed
     by the identical `SELECT ... category ... tags ...` query — Hivemind
     convention sets `category` from the post's own first tag/community, not
     from a separate ground truth). So `_interest_match`'s R3 fix is
     attacker-chosen EITHER WAY on production; simworld's `category` field
     is the one place in this harness that is currently NOT attacker-
     reachable, and B-17 does not extend noise onto it (see READ ME below —
     this is a recommendation for C/R3's owner, not a change made here).
"""
from __future__ import annotations

import pathlib
import sys

_HARNESS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))

from dataclasses import dataclass

from metrics_v2 import aggregate, viewer_metrics
from simworld import (
    EPOCH,
    NOW,
    TAGS,
    TOPICS,
    SimGateway,
    World,
    build_norm,
    build_world,
    harness_settings,
)

from recsys.contracts import CandidateSource, ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

SEEDS = (7, 11, 23, 42)
NOISE_LEVELS = (0.0, 0.1, 0.3)
K = 20

BASE = harness_settings()  # B-07 hook; byte-identical to Settings() when unset


@dataclass
class NoiseResult:
    metrics: dict[str, tuple[float, float]]
    tag_mismatch_rate: float
    explore_share: float


def panel_for(world: World) -> list[str]:
    return [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]


def run(tag_noise: float) -> NoiseResult:
    """One (tag_noise) row: aggregate viewer_metrics over 4 seeds x 24
    viewers, plus tag-invariant-violation rate and exploration-lane reach."""
    agg_rows: list[dict[str, float]] = []
    mismatch_num, mismatch_den = 0, 0
    explore_hits, explore_n = 0, 0
    for seed in SEEDS:
        world = build_world(seed=seed, tag_noise=tag_noise)
        gw = SimGateway(world)
        norm = build_norm(world)
        curated: set[str] = set()
        for t in TOPICS:
            tops = sorted([a for a in world.authors() if a.topic == t],
                          key=lambda a: -a.reputation)[:2]
            curated.update(a.name for a in tops)
        # `production=False`: these are SYNTHETIC seeds from a simulated world,
        # not the real curated list — the same opt-out every other panel uses
        # (cf. q7/q8's "C5/R2: synthetic seeds, not the real curated list").
        # Made explicit 2026-08-05 when C4 gave `build_trust_snapshot` a minimum
        # seed count: this panel's world yields ~12 curated accounts, which is a
        # perfectly good simulation and not a production trust root.
        snap = build_trust_snapshot(gw, BASE, since=EPOCH, now=NOW,
                                    trusted_seeds=frozenset(curated),
                                    production=False)

        mismatch_num += sum(1 for p in world.posts
                            if p.tags and p.tags[0] != world.post_topic[p.key])
        mismatch_den += len(world.posts)

        for name in panel_for(world):
            acct = world.accounts[name]
            viewer = ViewerProfile(account=name, follows=world.follows[name],
                                   interest_tags=frozenset(TAGS[acct.topic]))
            scored = list(rank_feed(viewer, gw, norm, now=NOW, since=EPOCH,
                                    settings=BASE, snapshot=snap))
            full = [sc.post for sc in scored]
            agg_rows.append(viewer_metrics(world, name, full))
            top = scored[:K]
            explore_hits += sum(1 for sc in top if sc.source == CandidateSource.EXPLORATION)
            explore_n += len(top)

    return NoiseResult(
        metrics=aggregate(agg_rows),
        tag_mismatch_rate=mismatch_num / mismatch_den if mismatch_den else float("nan"),
        explore_share=explore_hits / explore_n if explore_n else float("nan"),
    )


print(f"seeds {SEEDS} x topics {TOPICS}; 24-viewer panel (q7/q8 protocol); k={K}; "
      f"tag_noise in {NOISE_LEVELS}\n")

results = {tn: run(tn) for tn in NOISE_LEVELS}

print("TAG-INVARIANT VIOLATION RATE (tags[0] != true topic) — sanity check the noise landed:")
for tn in NOISE_LEVELS:
    print(f"    tag_noise={tn:.1f}: {results[tn].tag_mismatch_rate:.1%}")

ROWS = [
    ("QUALITY  mean author q @20", "mean_q"),
    ("HEADLINE stack capture (global ref)", "stack_capture_g"),
    ("RELEVANCE mean_rel@20 (ground truth, B-01)", "mean_rel"),
    ("COMPOSN  own-topic share @20", "own_share"),
    ("DIVERSE  topic entropy @20 (bits)", "entropy"),
    ("         own AUC, first 5 prefs", "auc_own_m5"),
]
print("\nSTANDARD PANEL METRICS vs tag_noise:")
hdr = ("metric".ljust(42)
       + "".join(f"{f'noise={tn:.1f}':>13s}" for tn in NOISE_LEVELS)
       + f"{'delta(0.3-0.0)':>16s}")
print(hdr)
print("-" * len(hdr))
for title, key in ROWS:
    line = title.ljust(42)
    vals = []
    for tn in NOISE_LEVELS:
        m, _ = results[tn].metrics[key]
        vals.append(m)
        line += f"{m:13.4f}"
    line += f"{vals[-1] - vals[0]:+16.4f}"
    print(line)

print("\nEXPLORATION LANE reach (share of top-20 slots sourced EXPLORATION) vs tag_noise:")
for tn in NOISE_LEVELS:
    print(f"    tag_noise={tn:.1f}: {results[tn].explore_share:.4f}")

print(
    "\nREAD ME — the exploration-lane row above is EXPECTED TO BE FLAT, and that is itself "
    "the finding, not a null result. `exploration._interest_match` (R3/C2b) tests "
    "`post.category`, and `simworld.build_world` draws `category=a.topic` (the author's TRUE "
    "topic) independently of `tags` — `_apply_tag_noise` only touches `.tags`, by design (B-17's "
    "brief), so this lane's simulated eligibility cannot see the noise at all.\n"
    "\n"
    "ON REAL HIVE, `category` is NOT an independent ground-truth field — it is the SAME "
    "attacker-supplied datum as `tags[0]` (`recsys/io/hafsql.py:814`: "
    "`community = category if category.startswith('hive-') else None`, read off the identical "
    "`SELECT ... category ... tags ...` row; Hivemind convention derives `category` from the "
    "post's own first tag/community, never from a separate oracle). R3's own docstring already "
    "concedes `post.category` is 'still attacker-chosen' — it only closes the MULTI-tag-spray "
    "vector (12 tags on one post reaching 60/60 viewers), not single-tag spoofing. But "
    "`simworld`'s `category` field is currently the ONE place in this harness that is NOT "
    "attacker-reachable at any noise level, which means every exploration-lane measurement here "
    "(q3's fresh-audience rows, q5b's spam-coldlane check, this script's explore_share row) is "
    "validated against a friendlier `category` than production ever provides. This is a gap in "
    "the SIMULATOR, not a claim about R3's fix being wrong — recommending it to whoever owns R3 "
    "(the exploration lane is C's attack surface; this file is my instrument), not changed here: "
    "wiring `category` to track the same noisy first-tag `_apply_tag_noise` produces would change "
    "candidate-pool COMPOSITION for every panel that touches exploration or second-degree tag "
    "matching, which is a bigger blast radius than 'add a tag-noise parameter, default off.'"
)


# ============================================================================
# ★★★ E1 (2026-08-05) — THIS PANEL NOW HAS A GATE.
#
# Until today this file contained ZERO executable assertions in ~190 lines: no
# `assert`, no `raise`, no `sys.exit`. It could not fail short of a crash. That
# matters more here than in most panels, because BUILDMAP-B:392 makes this file
# the HARD GATE for `ScoreWeights.interest_match` — "B-02's `interest_match`
# weight MUST NOT be chosen before this exists". The shipped 0.4 was therefore
# chosen against a gate that was incapable of failing.
#
# WHAT IS GATED, and why these and not the headline number:
#
#   1. QUALITY SURVIVES NOISE. The finding this file exists to report is that
#      tag noise breaks TARGETING, not ranking: mean author quality @20 is flat
#      or better at noise 0.3 (measured +0.0120). If quality ever collapses with
#      the tags, the ranker has started depending on attacker-supplied text for
#      something other than topic matching, which is a different and worse
#      system. Bound is generous (0.05) because the direction, not the
#      magnitude, is the claim.
#
#   2. RELEVANCE DEGRADES BUT DOES NOT COLLAPSE TO CHANCE. Relevance SHOULD
#      fall — pinning it tight would gate away the finding. What must hold is
#      that a noisy-tag world is still meaningfully personalised: with 6 topics,
#      a topic-blind feed scores ~1/6; measured at noise 0.3 is 0.4596. The
#      floor sits well above chance and well below measured, so it catches a
#      collapse without policing ordinary drift.
#
#      CALIBRATION, measured 2026-08-05: with the declared-interest term OFF
#      (`weights.interest_match=0.0`) this metric falls to 0.3404 — i.e. the
#      term is worth ~0.12 of relevance in a noisy-tag world, and the floor
#      sits just under the value the system reaches WITHOUT it. So the gate is
#      calibrated to catch "personalisation stopped working", not "the interest
#      term was retuned", which is the distinction it should be making.
#
# Deliberately NOT gated: own-topic share and topic entropy. Both move a lot
# with noise BY DESIGN (that is the measurement), and a bound on either would
# be a bound on the instrument rather than on the system.
# ============================================================================
_HI = max(NOISE_LEVELS)
_LO = min(NOISE_LEVELS)
_MAX_QUALITY_DROP = 0.05
_MIN_REL_UNDER_NOISE = 0.30

_q_lo, _ = results[_LO].metrics["mean_q"]
_q_hi, _ = results[_HI].metrics["mean_q"]
_rel_hi, _ = results[_HI].metrics["mean_rel"]

_failures = []
if _q_lo - _q_hi > _MAX_QUALITY_DROP:
    _failures.append(
        f"author quality @20 fell {_q_lo - _q_hi:+.4f} from noise {_LO} to {_HI} "
        f"({_q_lo:.4f} -> {_q_hi:.4f}), past the {_MAX_QUALITY_DROP} bound — the "
        f"ranker's QUALITY judgement should not depend on attacker-supplied tags"
    )
if _rel_hi < _MIN_REL_UNDER_NOISE:
    _failures.append(
        f"mean_rel@20 at noise {_HI} is {_rel_hi:.4f}, below the "
        f"{_MIN_REL_UNDER_NOISE} floor — personalisation has collapsed toward "
        f"topic-blind (~1/{len(TOPICS)} = {1 / len(TOPICS):.3f}) under tag noise"
    )
if _failures:
    raise AssertionError(
        "tag_noise_sensitivity gate failed:\n  - " + "\n  - ".join(_failures)
    )
print(
    f"\nGATE: quality holds under tag noise ({_q_lo:.4f} -> {_q_hi:.4f}, bound "
    f"{_MAX_QUALITY_DROP}) and relevance stays above chance "
    f"({_rel_hi:.4f} >= {_MIN_REL_UNDER_NOISE})."
)
