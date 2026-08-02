"""Q8 — the author-pooled prior on the STANDARD panel (closes the coverage
gap: q1..q7 all rank through a plain ``simworld.SimGateway``, which has no
``author_engagement`` method, so ``isinstance(gw, AuthorPriorGateway)`` is
False for every one of them and ``rank_feed`` silently falls back to
``prior=None`` for every candidate — see ``recsys.pipeline._author_priors``.
Half the organic rebuild (the pooled quality prior — the confirmed real
picking-skill lever, per the round's forced-composition control) has
therefore never been exercised by a standing measurement script; it was only
covered by one hand-built two-post unit test
(``tests/test_pipeline.py::test_author_pooled_prior_outranks_one_lucky_post``).
This script is the standing counterpart: same 24-viewer panel, same curated
seeds, same k=20 protocol as q6/q7, ONE ablation (author-prior gateway vs the
plain fallback), and a hard ASSERT on the prior's measured quality
contribution so a future change that weakens or breaks the prior trips this
script's exit code, not just a bespoke fixture.

WHY THIS FILE DEFINES ITS OWN GATEWAY rather than importing
``author_prior_gateway.AuthorPriorSimGateway``: that file predates a
2026-07-22 hardening fix to ``recsys.core.scoring.AuthorPriorGateway``
(``author_engagement`` gained a required-by-convention third parameter,
``excluded: Mapping[str, frozenset[str]] | None`` — the pipeline now derives
the per-author §8.4 exclusion set, self + stake lineage + per-author ring,
from the trust snapshot and passes it in, closing the "prior's leave-one-out
term uses raw, unguarded engagement" gap). The older two-argument gateway in
that file now raises ``TypeError`` on every call through the current
``recsys.pipeline._author_priors`` — it is stale scaffolding from before that
fix landed. Rather than edit a pre-existing harness file, this script ships a
gateway that implements the CURRENT protocol, mirroring the production
``recsys.io.hafsql.HafsqlClient.author_engagement`` / ``_SQL_AUTHOR_ENGAGEMENT``
semantics exactly: self is always excluded (the query's unconditional
``<> c.author``); any additional identities in ``excluded[author]`` (lineage +
ring, when the caller supplies a per-author map) are excluded on top; absent
or ``None`` degrades to self-exclusion only, the honest no-snapshot default.

PROTOCOL mirrors q1/q6/q7 exactly (seed=7 world, curated trusted seeds =
top-2 reputation authors per topic, 24-viewer panel, k=20, shipped
``Settings()``). The ONLY variable between the two runs below is which
gateway ``rank_feed`` is given — same world, same viewers, same snapshot,
same weights — so the pool-set invariance assert (as q6/q7 also run) proves
any measured delta is scoring-term-only, not a candidate-gathering artifact
(``AuthorPriorSimGateway`` only ADDS a method to ``SimGateway``; it changes
no candidate-source behavior).

CALIBRATION CAVEAT: simworld engagement is cleanly topic-structured; real
Hive noise weakens every personalization/CF magnitude. Mechanisms and signs
are reliable; exact figures are directional. The assert thresholds below are
set well inside the measured margins (see the module's own printed numbers)
specifically so ordinary re-tuning noise does not trip them — only a prior
that has stopped contributing should.
"""
from __future__ import annotations

import pathlib
import sys

# ★ Derived from __file__ (2026-08-01). These were two hardcoded absolute paths:
# a scratchpad from an unrelated session, and "/mnt/o/HIVE-BLOG-REBUILD/recsys",
# which does not exist — so no panel ran from its own directory without
# PYTHONPATH set by hand.
#
# Index 0 is DELIBERATE and stays: a measurement harness must bind to the tree
# it sits in, never to an installed `recsys` that happens to be on the path, or
# its numbers describe code nobody is looking at. The hazard the old code had
# was not the precedence, it was pointing that precedence at a path outside the
# repo; derived paths cannot drift. `metrics_v2.py` uses the same ordering.
_HARNESS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))
from typing import TYPE_CHECKING

from metrics_v2 import (
    DECOMP_CONFIGS,
    aggregate,
    decomposition_settings,
    penalty_decomposition,
    viewer_metrics,
)
from simworld import (
    COMMUNITY,
    EPOCH,
    NOW,
    TOPICS,
    PriorlessSimGateway,
    SimGateway,
    build_norm,
    build_world,
)

from recsys.config import DiversityConfig, Settings
from recsys.contracts import ViewerProfile
from recsys.core.scoring import AuthorPriorGateway
from recsys.pipeline import build_trust_snapshot, rank_feed

if TYPE_CHECKING:
    pass

BIG = 100_000  # top_k beyond any pool size -> full preference order (prefix-stable)


# ★ The inline gateway that used to live here was DELETED (2026-08-01). Its
# implementation — the one that correctly forwards `trust` to
# `post_base_engagement` — was promoted to `simworld.SimGateway`, so every panel
# now measures with it instead of only this one. Two live copies of the same
# in-memory twin were free to drift apart, and had: the other copy omitted the
# trust budget entirely.
world = build_world(seed=7)
norm = build_norm(world)
seeds: set[str] = set()
for t in TOPICS:
    tops = sorted([a for a in world.authors() if a.topic == t], key=lambda a: -a.reputation)[:2]
    seeds.update(a.name for a in tops)

# ★ The control is now EXPLICIT (2026-08-01). This used to be a plain
# `SimGateway`, which was prior-less only by accident — and because every other
# panel also used the plain gateway, they were all silently measuring this
# control rather than the shipped algorithm. `author_engagement` now lives on
# `SimGateway`, so the prior-less instrument has to be asked for by name.
gw_no_prior = PriorlessSimGateway(world)
gw_with_prior = SimGateway(world)
assert not isinstance(gw_no_prior, AuthorPriorGateway), "PriorlessSimGateway must NOT satisfy Protocol"
assert isinstance(gw_with_prior, AuthorPriorGateway), "SimGateway must satisfy Protocol"

# Trust snapshot depends only on engagement_edges/follow_graph/stake_lineage —
# all inherited unchanged from SimGateway — so it is identical regardless of
# which of the two gateways builds it; built once, shared by both runs below.
snap = build_trust_snapshot(
    gw_no_prior, Settings(), since=EPOCH, now=NOW, trusted_seeds=frozenset(seeds)
)

PANEL = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
SETTINGS = Settings(diversity=DiversityConfig(top_k=BIG))  # shipped weights; full order


def viewer_for(name: str) -> ViewerProfile:
    acct = world.accounts[name]
    return ViewerProfile(account=name, follows=world.follows[name],
                         subscribed_communities=frozenset({COMMUNITY[acct.topic]}))


print(f"world: {len(world.posts)} posts, {len(world.accounts)} accounts; "
      f"panel {len(PANEL)} viewers; k=20; q1/q6/q7 protocol (curated seeds)")
print("CAVEAT: synthetic engagement is cleanly topic-structured — signs reliable, "
      "figures directional. Ablation: author-prior gateway ON vs OFF, shipped Settings().\n")

results: dict[str, dict[str, tuple[float, float]]] = {}
pool_sets: dict[str, list[frozenset[str]]] = {}
for label, gw in [("no_prior", gw_no_prior), ("with_prior", gw_with_prior)]:
    rows = []
    pools = []
    for name in PANEL:
        full = [sc.post for sc in rank_feed(viewer_for(name), gw, norm, now=NOW, since=EPOCH,
                                            settings=SETTINGS, snapshot=snap)]
        pools.append(frozenset(p.key for p in full))
        rows.append(viewer_metrics(world, name, full))
    results[label] = aggregate(rows)
    pool_sets[label] = pools

pool_ok = all(pool_sets["no_prior"][i] == pool_sets["with_prior"][i] for i in range(len(PANEL)))
print(f"pool-set invariance no_prior vs with_prior: {'OK' if pool_ok else '** POOL SETS DIFFER **'}"
      " (proves the delta below is scoring-only, not a candidate-gathering artifact)\n")
assert pool_ok, "the author-prior gateway must not change candidate gathering, only scoring"

ROWS = [
    ("QUALITY mean author q @20 (TRUSTWORTHY)", "mean_q"),
    ("HEADLINE stack capture (global ref)", "stack_capture_g"),
    ("DEPTH-OK own q, first 5 prefs", "q_own_m5"),
    ("        own q, first 10 prefs", "q_own_m10"),
    ("        own capture@5 vs global", "cap_own_m5_g"),
    ("        own capture@10 vs global", "cap_own_m10_g"),
    ("        own AUC, first 5 prefs", "auc_own_m5"),
    ("        own AUC, first 10 prefs", "auc_own_m10"),
    ("COMPOSN own-topic share @20 (descriptor)", "own_share"),
    ("DIVERSE topic entropy @20 (descriptor)", "entropy"),
]
hdr = "metric".ljust(42) + f"{'no_prior':>10s}{'with_prior':>12s}{'delta':>10s}"
print(hdr)
print("-" * len(hdr))
for title, key in ROWS:
    a, _ = results["no_prior"][key]
    b, _ = results["with_prior"][key]
    print(f"{title.ljust(42)}{a:10.4f}{b:12.4f}{b - a:+10.4f}")

# penalty_decomposition's scoring_gap is metrics_v2's own recommended number
# for judging a scoring-term change ("THIS is the number a scoring-term round
# is trying to shrink" — module docstring, D2).
CONFIGS = decomposition_settings(SETTINGS)
scoring_gap: dict[str, float] = {}
for label, gw in [("no_prior", gw_no_prior), ("with_prior", gw_with_prior)]:
    orders: dict[str, dict[str, list]] = {name: {} for name in PANEL}
    for cfg_name in DECOMP_CONFIGS:
        s = CONFIGS[cfg_name]
        for name in PANEL:
            full = [sc.post for sc in rank_feed(viewer_for(name), gw, norm, now=NOW,
                                                since=EPOCH, settings=s, snapshot=snap)]
            orders[name][cfg_name] = full
    decomp_rows = [penalty_decomposition(world, name, orders[name]) for name in PANEL]
    decomp = aggregate(decomp_rows)
    scoring_gap[label] = decomp["scoring_gap"][0]
    print(f"\n{label:12s} scoring_gap (picking failure, diversity OFF) = {scoring_gap[label]:.4f}")

# ---- SELF-CHECK: the prior must be measurably improving picking quality ----
# Measured on this exact panel/protocol (2026-07-22): mean_q +0.0227,
# stack_capture_g +0.0377, auc_own_m5 +0.0462, scoring_gap -0.0645
# (0.1561 -> 0.0916). Thresholds below sit well inside those margins (roughly
# a third to a half) so ordinary re-tuning of unrelated weights does not trip
# this script — only a prior that has stopped contributing, or regressed
# toward/through zero, should.
mean_q_delta = results["with_prior"]["mean_q"][0] - results["no_prior"]["mean_q"][0]
stack_capture_delta = (
    results["with_prior"]["stack_capture_g"][0] - results["no_prior"]["stack_capture_g"][0]
)
auc5_delta = results["with_prior"]["auc_own_m5"][0] - results["no_prior"]["auc_own_m5"][0]
gap_improvement = scoring_gap["no_prior"] - scoring_gap["with_prior"]

print("\nSELF-CHECK — author-pooled prior must beat the prior-less fallback:")
checks = [
    ("mean_q delta", mean_q_delta, 0.010),
    ("stack_capture_g delta", stack_capture_delta, 0.015),
    ("auc_own_m5 delta", auc5_delta, 0.020),
    ("scoring_gap improvement (no_prior - with_prior)", gap_improvement, 0.025),
]
failed = False
for label, value, floor in checks:
    ok = value > floor
    failed = failed or not ok
    status = "OK" if ok else "** FAIL **"
    print(f"    {label:48s} {value:+.4f}   (must be > {floor:.3f})   {status}")
for label, value, floor in checks:
    assert value > floor, (
        f"{label} = {value:+.4f} did not clear {floor:.3f} — the author-pooled prior's "
        "quality contribution has regressed; re-check pooled_author_base/organic_post_share "
        "and the AuthorPriorGateway wiring in recsys.pipeline before shipping"
    )
print("\nALL SELF-CHECKS PASSED — the pooled prior is measurably improving picking quality "
      "on the standard panel, at flat composition (own_share/entropy deltas above are "
      "descriptors, not part of the check, and stay small by design).")
