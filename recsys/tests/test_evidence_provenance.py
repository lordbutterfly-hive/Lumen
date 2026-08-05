"""Every measurement script this codebase CITES must exist, or be declared.

★★ 2026-08-05 POST-CLOSEOUT COUNCIL (Seat 2, quantified and confirmed here).
Load-bearing constants in this project are justified in prose by naming the
script that measured them — `A1_namegrind.py` for the keyed exploration seat,
`A4_slot_sweep.py` for `max_slots_per_feed`, `A13_setcover_e2e.py` for the
set-cover attack. **Thirteen such scripts do not exist anywhere in the tree.**
They were written in a scratch directory that did not survive the session that
made them (the same way Seat 3's attack scripts "died with /tmp"), so the numbers
behind several shipped security parameters cannot be re-run by anyone.

That is a quiet, compounding trap: a reader sees a citation, assumes the number
was measured and is checkable, and it is neither. It is the documentation
equivalent of a panel that cannot fail.

This test does not pretend the scripts are back. It makes their ABSENCE
enforced and visible, exactly as `mutate_panels.EXPECTED_MISSES` did for blind
mutants: a missing script must be listed below with a reason, a NEW dangling
citation fails the suite, and a declaration that has gone stale (the file now
exists) also fails, so the list cannot rot in the other direction either.

Rule going forward: **a measurement worth citing is worth committing.** Write it
under `measurement-harness/` or `measurement-harness/attacks/` before quoting its
output in a docstring.
"""

from __future__ import annotations

import pathlib
import re

_ROOT = pathlib.Path(__file__).resolve().parent.parent

#: Cited but absent. Key: filename. Value: why it is gone and what depends on it.
#: Deleting an entry is correct once the script is restored — the test enforces
#: that, so this list cannot silently outlive the problem.
MISSING_EVIDENCE: dict[str, str] = {
    "A1_namegrind.py": (
        "Cited by `config.py`/`core/exploration.py` as the measurement behind the "
        "KEYED exploration seat (6 accounts + ~92,546 offline hashes held the seat in "
        "613/720 cells, 85.1%). Authored 2026-08-04 in a scratch dir that did not "
        "survive. The FIX is pinned by real tests; the ATTACK NUMBER is not "
        "reproducible — re-measure before quoting it."
    ),
    "A4_slot_sweep.py": (
        "Cited by `ExplorationConfig.max_slots_per_feed` as the measurement behind the "
        "value 3 (10 ground socks took 75.5% of exploration slots, 20 took 83.6%). "
        "Not reproducible. The parameter ships on an unverifiable number."
    ),
    "A13_setcover_e2e.py": (
        "Cited alongside A1 for the end-to-end set-cover version of the seat-grinding "
        "attack. Not reproducible."
    ),
    "A8_popular_lane.py": (
        "Cited by `config.py`/`pipeline.py` for the POPULAR_FALLBACK share measurement "
        "(~39% of the median feed) that justified the 25% cap. Not reproducible."
    ),
    "A10c_reach_correct.py": (
        "Cited by `core/exploration.py` and `tests/test_exploration.py` for the lane's "
        "reach correctness measurement. Not reproducible."
    ),
    "A5_suppression_compose.py": (
        "Cited by `core/exploration.py` and `tests/test_exploration.py` for the "
        "suppression-composition case. Not reproducible."
    ),
    "A11_pool_truncation.py": (
        "Cited by `tests/test_pipeline.py` for the pool-truncation measurement. "
        "Not reproducible."
    ),
    "eI_q11_mutants.py": (
        "Cited by `mutate_panels.py` and `q11_follow_curve.py` as the provenance of "
        "q11's mutant set. The mutants themselves are now registered IN "
        "`mutate_panels.py`, so the gate is real; only the derivation is lost."
    ),
    "atk1_farm.py": (
        "Cited by `attacks/exploration_capture.py` as the ancestor script its farm "
        "scenario was lifted from. The SUCCESSOR is committed and runs, which is why "
        "this one matters least — the capture numbers ARE reproducible today via "
        "`exploration_capture.py`."
    ),
    "atk3b_band0_clear.py": (
        "Cited by `attacks/exploration_capture.py` for the band-0 clearing scenario. "
        "That scenario is NOT carried by the committed successor — it is a genuine "
        "coverage gap, not just a lost derivation."
    ),
    "truncation.py": (
        "Prose reference in `pipeline.py` to a truncation experiment. Not a file that "
        "ever existed under this name in-tree; kept declared so the scan stays honest."
    ),
    "f5b.py": (
        "Prose reference in `tests/test_vouch_bound_tradeoff.py` to a vouch-bound "
        "sweep. Not reproducible."
    ),
    "f5c.py": (
        "Prose reference in `tests/test_vouch_bound_tradeoff.py`, sibling of f5b. "
        "Not reproducible."
    ),
}

_PY_NAME = re.compile(r"\b([A-Za-z0-9_]+\.py)\b")


def _cited_names() -> dict[str, set[str]]:
    cited: dict[str, set[str]] = {}
    sources = [p for p in _ROOT.rglob("*.py") if ".venv" not in str(p)]
    sources.append(_ROOT / "README.md")
    for path in sources:
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        for name in _PY_NAME.findall(text):
            cited.setdefault(name, set()).add(str(path.relative_to(_ROOT)))
    return cited


def _present_names() -> set[str]:
    return {p.name for p in _ROOT.rglob("*.py")}


def test_every_cited_measurement_script_exists_or_is_declared_missing() -> None:
    """A NEW dangling citation fails here. Restore the script, or declare it."""
    cited = _cited_names()
    present = _present_names()
    missing = {name: where for name, where in cited.items() if name not in present}
    undeclared = {n: sorted(w) for n, w in missing.items() if n not in MISSING_EVIDENCE}
    assert not undeclared, (
        "these scripts are cited but do not exist and are not declared in "
        f"MISSING_EVIDENCE — commit the measurement or declare it: {undeclared}"
    )


def test_no_declaration_outlives_the_missing_script() -> None:
    """The mirror image: once a script is restored, its declaration is a lie and
    must go. Without this the registry becomes its own kind of rot."""
    present = _present_names()
    stale = sorted(name for name in MISSING_EVIDENCE if name in present)
    assert not stale, (
        f"these scripts now EXIST but are still declared missing — delete their "
        f"MISSING_EVIDENCE entries: {stale}"
    )


def test_every_declaration_carries_a_real_reason() -> None:
    """A one-word excuse is how a registry stops meaning anything."""
    thin = sorted(name for name, why in MISSING_EVIDENCE.items() if len(why) < 60)
    assert not thin, f"these declarations need a real reason, not a placeholder: {thin}"
