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
        snap = build_trust_snapshot(gw, BASE, since=EPOCH, now=NOW,
                                    trusted_seeds=frozenset(curated))

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
