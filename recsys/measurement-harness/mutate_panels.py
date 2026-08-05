"""B-07 — a panel that passes on its own mutant is not a gate.

WHY THIS EXISTS (measured on q11, `scratchpad/eI_q11_mutants.py`, BUILDMAP-B-
QUALITY-2026-08-04.md B-07): deleting the unchosen-source penalty, gutting it
toward a no-op floor, deleting the per-page cap, or loosening the cap to
10/page ALL passed q11's pre-B-06 self-check — and deleting the penalty made
the panel's headline number BETTER than shipped. A panel that cannot detect
the removal of the mechanism it exists to guard is not measuring anything.

DESIGN. Config mutants ONLY — no code mutation, so this is buildable
deterministically. For each `(panel, mutant)` pair:
  1. the mutant is a `{"dotted.path": value}` object naming a change to
     `Settings` (e.g. `{"diversity.unchosen_source_floor": 1.0}`);
  2. if any path segment does not exist on the CURRENT `Settings` tree (some
     mutant fields are created by units B-02/B-03/B-04, which have not
     landed), the row is marked N/A rather than crashing;
  3. otherwise the panel is re-executed as a subprocess with
     `LUMEN_SETTINGS_MUTANT=json.dumps(mutant)` in its environment, and its
     BASELINE (same panel, no env var) is also executed once and cached;
  4. a panel that routes its top-level `Settings()` construction through
     `simworld.harness_settings()` picks the mutation up automatically —
     panels that don't are simply never wired into MUTANTS below.

CLASSIFICATION per row:
  CAUGHT    baseline exits 0, mutant exits non-zero — the panel's own
            self-check noticed the mutation.
  MISSED    baseline exits 0, mutant ALSO exits 0 — the defect this harness
            exists to catch: the panel is blind to this mutant.
  N/A       the mutant names a field that does not exist yet (B-02/03/04).
  N/E       baseline itself exits non-zero (q6/q7 are RED BY DESIGN — drifted
            pins, q11's monotonicity assertion is expected red at HEAD per
            B-06). Exit code cannot distinguish "caught" from "already
            broken for an unrelated reason" here — NOT a gate result, and it
            is not counted as a pass OR a fail by `--exit-code`.

Usage:
    python3 measurement-harness/mutate_panels.py            # full run
    python3 measurement-harness/mutate_panels.py --list     # declared matrix only, no subprocesses
    python3 measurement-harness/mutate_panels.py --panel q11_follow_curve.py   # one panel

Exit code (full run only): non-zero iff at least one applicable
(non-N/A, non-N/E) mutant was MISSED. N/A and N/E rows are reported but do
not by themselves fail the run — they are not something this script can
adjudicate; see the printed WARNING counts.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time

_HARNESS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HARNESS))
sys.path.insert(0, str(_HARNESS.parent))

from simworld import _MUTANT_ENV, settings_path_exists

from recsys.config import Settings

# =============================================================================
# Minimum mutant set (BUILDMAP-B-QUALITY-2026-08-04.md, B-07 table). Extend
# per panel as coverage grows — this is the FLOOR, not the ceiling.
# =============================================================================
Mutant = tuple[str, dict[str, object]]  # (short name, {"dotted.path": value})

# ============================================================================
# ★★★ E2 (2026-08-05) — DECLARED BLINDNESS.
#
# This unit exited 1 with 6-7 MISSED rows and was reported nowhere, while the
# project's status line quoted "13/13 panels exit 0". BUILDMAP-B:498 makes
# "every panel must FAIL its own mutants" a release requirement, so a
# permanently-red gate nobody runs is worse than no gate: it trains people to
# ignore it.
#
# Not every MISS is a defect, and pretending otherwise is why it stayed red.
# Some are STRUCTURAL — the panel genuinely cannot perceive the mutation, for a
# reason already written down. The honest gate is therefore: a miss must be
# DECLARED HERE WITH A REASON, or the run fails. SILENCE fails, not blindness.
#
# TWO WAYS TO FAIL, both deliberate:
#   * an UNDECLARED miss -> a new blind spot appeared and nobody said so;
#   * a DECLARED miss that is now CAUGHT -> the declaration is STALE. Coverage
#     improving must force the note to be deleted, or this file slowly fills
#     with excuses for problems that no longer exist.
#
# Keyed by (panel filename, exact mutant label).
# ============================================================================
EXPECTED_MISSES: dict[tuple[str, str], str] = {
    ("q11_follow_curve.py", "emerging_per_page=0 [B-04, N/A at HEAD]"):
        "`emerging_per_page` is DOCUMENTED INERT — a newcomer's graph-cred jumps past "
        "`min_vouched_score` on the first vote, so this budget is never the binding "
        "constraint. A mutant of an inert field cannot be caught by anything. Delete "
        "this entry if the field is ever made live.",
    ("q3_newauthor.py", "emerging_per_page=0 [B-04, N/A at HEAD]"):
        "Same inert field as above.",
    ("q8_author_prior_panel.py", "organic_prior_shrinkage=0.0"):
        "STRUCTURAL, and documented in ALGO-STATE §1b: shrinkage's cost is paid on "
        "q8's OWN axis, so deleting it makes q8's numbers BETTER (+0.0118 -> +0.0189). "
        "A metric that improves when you delete the mechanism cannot gate it. "
        "`organic_prior_shrinkage=0.0` IS caught — by q3_newauthor.py, which measures "
        "the newcomer reach shrinkage actually exists to buy.",
    ("q9_prior_shrinkage.py", "organic_prior_shrinkage=0.0"):
        "STRUCTURAL. q9 is a SWEEP over k, and k=0.0 is one of its own swept points "
        "and a legitimate control. E1 gave this panel a real gate (the SHIPPED k must "
        "clear q8's floors) and k=0.0 clears them — the prior still works at k=0, only "
        "the newcomer refinement is gone. Caught by q3_newauthor.py. The gate DOES fire "
        "if the shipped k moves to a failing value or off the swept grid.",
    ("q5b_spam_coldlane.py", "exploration.slots_per_page=0"):
        "The REGISTERED MUTANT IS WRONG, and q5b's own comments say so: this panel's "
        "gating mutation is `organic_recency`, not the exploration lane. Kept visible "
        "rather than quietly re-pointed, because silently swapping a mutant is how a "
        "registry stops describing what it tests. Real exploration-lane coverage is "
        "q3_newauthor.py (CAUGHT) and attacks/exploration_capture.py.",
    ("q11_follow_curve.py", "unchosen_source_floor=1.0"):
        "★ THE ONE GENUINE GAP, recorded rather than papered over. NO panel catches "
        "this mutant — disabling the unchosen-lane penalty FLOOR alone (leaving the "
        "cap) does not move q11's accepted-curve check enough to trip it, and no other "
        "panel measures it. This is a real hole in the evidence base, not a structural "
        "impossibility. It needs a panel that measures lane composition directly.",
}


MUTANTS: dict[str, list[Mutant]] = {
    "q11_follow_curve.py": [
        ("unchosen_max_share=1.0 [B-03, N/A at HEAD]", {"diversity.unchosen_max_share": 1.0}),
        ("unchosen_source_floor=1.0", {"diversity.unchosen_source_floor": 1.0}),
        ("emerging_per_page=0 [B-04, N/A at HEAD]", {"diversity.emerging_per_page": 0}),
        ("interest_match=0.0 [B-02, N/A at HEAD]", {"weights.interest_match": 0.0}),
        # ★ Extra, beyond the buildmap's minimum table: `unchosen_max_share`
        # doesn't exist yet, but its PREDECESSOR field does — this is the
        # "cap DELETED" mutant `scratchpad/eI_q11_mutants.py` actually
        # measured (the pre-B-03 mechanism), so it is real coverage today,
        # not a placeholder. Kept alongside the official (N/A) row above so
        # both are visible and it's obvious which is which.
        ("unchosen_max_per_page=0 (cap off, pre-B-03 field)",
         {"diversity.unchosen_max_per_page": 0}),
    ],
    "q3_newauthor.py": [
        ("emerging_per_page=0 [B-04, N/A at HEAD]", {"diversity.emerging_per_page": 0}),
        ("exploration.slots_per_page=0", {"exploration.slots_per_page": 0}),
        ("organic_prior_shrinkage=0.0", {"weights.organic_prior_shrinkage": 0.0}),
    ],
    "q8_author_prior_panel.py": [
        ("organic_prior_shrinkage=0.0", {"weights.organic_prior_shrinkage": 0.0}),
        ("organic_post_share=1.0", {"weights.organic_post_share": 1.0}),
    ],
    "q9_prior_shrinkage.py": [
        ("organic_prior_shrinkage=0.0", {"weights.organic_prior_shrinkage": 0.0}),
        ("organic_post_share=1.0", {"weights.organic_post_share": 1.0}),
    ],
    "q7_corrected_baseline.py": [
        # ★ organic_cf=0.0 CANNOT be a single-field mutant: `ScoreWeights.
        # __post_init__` enforces `organic_quality + organic_cf == 1.0`
        # (config.py ~line 271), so mutating `organic_cf` alone raises
        # ValueError while CONSTRUCTING the mutated Settings — before the
        # panel's own logic ever runs. Found by actually running this row:
        # the first version of this mutant showed as a "pass" (non-zero
        # exit) for entirely the wrong reason. Paired with `organic_quality:
        # 1.0` so the invariant holds and the mutant tests what it claims to
        # — CF contributing nothing to the organic term.
        ("organic_cf=0.0 (paired organic_quality=1.0)",
         {"weights.organic_cf": 0.0, "weights.organic_quality": 1.0}),
        ("author_floor=1.0", {"diversity.author_floor": 1.0}),
        ("topic_affinity_strength=0.0", {"diversity.topic_affinity_strength": 0.0}),
    ],
    "q5b_spam_coldlane.py": [
        ("exploration.slots_per_page=0", {"exploration.slots_per_page": 0}),
    ],
    "q2_newuser.py": [
        ("min_feed_size=0", {"fallback.min_feed_size": 0}),
    ],
}

TIMEOUT_S = 600


def _run(panel: str, mutation: dict[str, object] | None) -> tuple[int, float, str]:
    env = dict(os.environ)
    if mutation:
        env[_MUTANT_ENV] = json.dumps(mutation)
    else:
        env.pop(_MUTANT_ENV, None)
    t0 = time.monotonic()
    proc = subprocess.run(
        [sys.executable, str(_HARNESS / panel)],
        cwd=str(_HARNESS), env=env, capture_output=True, text=True, timeout=TIMEOUT_S,
    )
    return proc.returncode, time.monotonic() - t0, proc.stdout + proc.stderr


def _mutant_paths_exist(mutation: dict[str, object]) -> tuple[bool, list[str]]:
    base = Settings()
    missing = [p for p in mutation if not settings_path_exists(base, p)]
    return (not missing), missing


def build_matrix(panels: list[str]) -> dict[str, list[tuple[str, str, str]]]:
    """panel -> [(mutant_name, status, detail), ...]. Does not run anything
    beyond the N/A field-existence check — used by --list."""
    out: dict[str, list[tuple[str, str, str]]] = {}
    for panel in panels:
        rows = []
        for name, mutation in MUTANTS.get(panel, []):
            ok, missing = _mutant_paths_exist(mutation)
            if ok:
                rows.append((name, "?", "not yet run"))
            else:
                rows.append((name, "N/A", f"missing field(s): {', '.join(missing)}"))
        out[panel] = rows
    return out


def run_matrix(
    panels: list[str],
) -> tuple[dict[str, list[tuple[str, str, str]]], int, int, int, int, int]:
    """Full run: spawns the baseline once per panel + one subprocess per
    applicable mutant. Returns (matrix, n_caught, n_missed, n_na, n_ne, n_ne_blind,
    n_declared, n_stale).

    N/E (baseline itself exits non-zero — RED BY DESIGN) still runs the
    mutant subprocess and compares its FULL stdout+stderr, byte-for-byte,
    against the baseline's. Identical output is a STRONGER negative than
    "can't gate via exit code": it means the panel produced not one
    differing character under the mutation — provably blind to it,
    independent of gating. Different output is still not proof of a working
    gate (a real gate must actually assert and fail), so it stays N/E, but is
    flagged separately from the blind case.
    """
    out: dict[str, list[tuple[str, str, str]]] = {}
    n_caught = n_missed = n_na = n_ne = n_ne_blind = 0
    n_declared = n_stale = 0
    baseline_cache: dict[str, tuple[int, float, str]] = {}
    for panel in panels:
        rows = []
        for name, mutation in MUTANTS.get(panel, []):
            ok, missing = _mutant_paths_exist(mutation)
            if not ok:
                rows.append((name, "N/A", f"missing field(s): {', '.join(missing)}"))
                n_na += 1
                continue
            if panel not in baseline_cache:
                baseline_cache[panel] = _run(panel, None)
            base_rc, _, base_out = baseline_cache[panel]
            if base_rc != 0:
                mut_rc, mut_t, mut_out = _run(panel, mutation)
                if mut_out == base_out:
                    rows.append((name, "N/E-BLIND",
                                 f"baseline exits {base_rc} (RED BY DESIGN) AND mutant output is "
                                 f"BYTE-IDENTICAL to baseline ({mut_t:.0f}s) — provably no effect"))
                    n_ne_blind += 1
                else:
                    rows.append((name, "N/E",
                                 f"baseline exits {base_rc} (RED BY DESIGN); mutant output DIFFERS "
                                 f"({mut_t:.0f}s) but exit code can't confirm a real gate fired"))
                    n_ne += 1
                continue
            mut_rc, mut_t, _ = _run(panel, mutation)
            declared = EXPECTED_MISSES.get((panel, name))
            if mut_rc != 0:
                if declared is not None:
                    # E2: coverage improved and the declaration is now a lie.
                    rows.append((name, "STALE-DECL",
                                 f"mutant exit {mut_rc} in {mut_t:.0f}s — this miss is "
                                 f"DECLARED in EXPECTED_MISSES but is now CAUGHT; delete "
                                 f"the declaration"))
                    n_stale += 1
                else:
                    rows.append((name, "CAUGHT", f"mutant exit {mut_rc} in {mut_t:.0f}s"))
                    n_caught += 1
            elif declared is not None:
                rows.append((name, "DECLARED",
                             f"blind in {mut_t:.0f}s — {declared}"))
                n_declared += 1
            else:
                rows.append((name, "MISSED",
                             f"mutant exit 0 in {mut_t:.0f}s — panel is BLIND to this mutant"))
                n_missed += 1
        out[panel] = rows
    return out, n_caught, n_missed, n_na, n_ne, n_ne_blind, n_declared, n_stale


def print_matrix(matrix: dict[str, list[tuple[str, str, str]]]) -> None:
    for panel, rows in matrix.items():
        print(f"\n{panel}")
        print("-" * len(panel))
        if not rows:
            print("    (not wired for mutation testing)")
            continue
        for name, status, detail in rows:
            print(f"    [{status:9s}] {name:52s} {detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--list", action="store_true",
                     help="declared matrix + N/A only, no subprocesses")
    ap.add_argument("--panel", default=None, help="restrict to one panel filename")
    args = ap.parse_args()

    panels = [args.panel] if args.panel else list(MUTANTS)
    for p in panels:
        if p not in MUTANTS:
            print(f"unknown panel {p!r}; known: {sorted(MUTANTS)}", file=sys.stderr)
            return 2

    if args.list:
        matrix = build_matrix(panels)
        print_matrix(matrix)
        return 0

    print(f"running full mutant matrix over {len(panels)} panel(s); "
          f"{sum(len(MUTANTS[p]) for p in panels)} declared mutant row(s)...\n")
    (matrix, n_caught, n_missed, n_na, n_ne, n_ne_blind,
     n_declared, n_stale) = run_matrix(panels)
    print_matrix(matrix)
    print(f"\nTOTALS: {n_caught} CAUGHT, {n_missed} MISSED, {n_declared} DECLARED "
          f"(structurally blind, reason recorded), {n_stale} STALE-DECL, "
          f"{n_na} N/A (field not built yet), "
          f"{n_ne} N/E (baseline already red, output differs — not gatable either way), "
          f"{n_ne_blind} N/E-BLIND (baseline already red AND mutant output byte-identical)")
    if n_missed:
        print(f"\n*** {n_missed} mutant(s) MISSED — the panel(s) above did not notice the "
              "mutation. ***")
    if n_ne_blind:
        print(f"\n*** {n_ne_blind} mutant(s) N/E-BLIND — the panel's baseline is already red "
              "for an unrelated reason, so exit-code gating is moot, but the mutant ALSO "
              "produced not one differing byte of output: the panel cannot perceive this "
              "mutation at all. ***")
    if n_ne:
        print(f"\nNOTE: {n_ne} row(s) could not be exit-code-gated because their panel's own "
              "baseline already exits non-zero (by design) — mutant output differed from "
              "baseline, which is SOME evidence the mutation is visible, but not proof a real "
              "gate would fire. Not counted as "
              "pass or fail.")
    if n_stale:
        print(f"\n*** {n_stale} STALE DECLARATION(S) — a miss recorded in EXPECTED_MISSES is "
              "now CAUGHT. Coverage improved; delete the declaration so this file keeps "
              "describing reality. ***")
    if n_declared:
        print(f"\nNOTE: {n_declared} row(s) are DECLARED blind spots with a recorded reason "
              "(see EXPECTED_MISSES). They do not fail this gate — an UNDECLARED miss does, "
              "and so does a declaration that has gone stale. Blindness is allowed here; "
              "silence about it is not.")
    return 1 if (n_missed or n_ne_blind or n_stale) else 0


if __name__ == "__main__":
    raise SystemExit(main())
