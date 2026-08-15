"""SEEN-POST SUPPRESSION — a post this reader has already been SERVED TWICE
steps aside for one they have not, and comes back only if it GREW.

★★★ THE MEASUREMENT. Top-20 for `lordbutterfly` at 18:25 and again at 23:04 UTC
on 2026-08-14 — 4h 39m apart, outliving the 2h presentation ceiling — was **16 of
20 identical, 80% repeat**. The delivery log agrees at a severity that
understates nothing: 44.5% of all `(viewer, post)` pairs sit at >= 2 impressions
(531 of 1,192 over six days), one pair at 66, one post served 118 times.

★★★ WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT.

It is a SPLIT, not a filter. :func:`split_seen` returns BOTH halves — the posts
that go forward and the posts that stepped aside, the latter ordered so the
least-shown comes back first. Two reasons, and neither is style:

  * A filter that DROPS leaves nothing for the starvation valve to re-admit. The
    valve (`pipeline.rank_feed`) is the hard floor that guarantees suppression
    yields BEFORE a feed goes below one screen, and it can only do that if the
    posts it needs still exist. A dropped set is gone.
  * The obvious alternative — a `seen` kwarg on `second_degree.filter_eligible`
    beside its existing `suppressed` — is refused by contract C10 and by blast
    radius. `suppressed` on that signature is §8.7 NETWORK SUPPRESSION, an ABUSE
    signal. This is a READER-STATE signal. Two frozensets of keys with
    near-identical names on the function where mutes, bans, the vouch gate, the
    author floor and the self-post rule all live is an invitation to pass the
    wrong one, and `filter_eligible` is the most security-load-bearing function
    in the package. Suppression is a product rule, not a gate. It stays out.

★★★ CONTRACT C5 — EXPLORATION IS EXEMPT, AND THE EXEMPTION IS LOAD-BEARING.

The resurrection rule keys on engagement GROWTH. A newcomer's debut post has
`E = 0` by construction — that is the definition of the population the reserved
seat serves. So its baseline is 0, the relative arm is 0, and the absolute arm
demands engagers it cannot earn while suppressed: `exploration.py`'s own note
records the loop ("a newcomer denied impressions cannot earn the engagement that
would clear them"). Without an exemption, suppression turns the newcomer lane
into a strictly-bounded, NON-RENEWABLE 2 impressions per viewer, ever.

Live evidence that this is not hypothetical: **20 of 30 exploration
`(viewer, post)` pairs are already at >= 2 impressions** under the old counter.
Every one of them would have been buried.

The exemption holds in TWO places, deliberately, because one of them is
structural and structure gets refactored:

  1. **STRUCTURALLY, in `pipeline.rank_feed`.** The split is applied to
     `filter_eligible`'s output and to the fallback filler. The exploration pool
     is built by `eligible_for_exploration(candidates, ...)` from the RAW
     gathered pool — never from `eligible` — so it does not pass through the
     split at all. That is not an accident of ordering: `exploration.py` is
     explicit that it takes raw candidates because `filter_eligible` has already
     applied the second-degree gate and that gate is exactly what the newcomer
     lane exists to bypass.
  2. **EXPLICITLY, here.** :func:`split_seen` never suppresses a candidate whose
     source is :attr:`CandidateSource.EXPLORATION`, whatever pool it is handed.
     Belt and braces: (1) is a property of a call site 200 lines away in a
     function that has been re-ordered three times this month. A guarantee that
     depends on nobody moving a line is not a guarantee.

The exploration pool re-stamps its picks (`Candidate(post=..., source=
CandidateSource.EXPLORATION)`), so a post can legitimately be in `eligible` as
`OON_INTEREST` *and* in the pool as `EXPLORATION`. Suppressing the merit copy
does not touch the seat copy — which is the exemption working, not a leak.

★ THIS MODULE IS PURE. No I/O, no clock, no database — same posture as
`second_degree.py`. The impression state is read by `recsys.io.seen_log` and
handed in. That is what makes the rule testable offline and what stops a
database outage from changing a ranking decision by accident.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from recsys.config import SeenConfig
from recsys.contracts import Candidate, CandidateSource

__all__ = ["SeenState", "SeenSplit", "resurrects", "split_seen"]


@dataclass(frozen=True)
class SeenState:
    """What the delivery log knows about one `(viewer, post)` pair.

    Keyed by the RANKED identity (`Post.key`, i.e. `@author/permlink`), never by
    the served identity — see `io.seen_log` for the C8 proof that those are
    different strings for every Lumen-native post.
    """

    #: Deliveries inside the window. The number the owner's rule consumes.
    impressions: int

    #: ★★★ DISTINCT NON-LITE ENGAGERS THIS POST CARRIED AT ITS MOST RECENT SERVE.
    #: Without this column the resurrection rule is unmeasurable — "did it grow"
    #: has no meaning without a baseline to grow FROM.
    #:
    #: `None` means the serving build did not report it (a row written before the
    #: baseline existed). It is "UNKNOWN", never 0 — see :func:`resurrects` for
    #: which way an unknown fails and why.
    engagers_at_last_serve: int | None = None

    #: Epoch seconds of the most recent delivery. Used ONLY to order the repeats
    #: the starvation valve re-admits (oldest first). Never compared to a
    #: threshold, so a skewed clock costs ordering, never a suppression decision.
    last_served_at: float = 0.0


@dataclass(frozen=True)
class SeenSplit:
    """Both halves plus the counters the INFO line publishes.

    ★ THE COUNTERS ARE THE POINT OF RETURNING AN OBJECT rather than a tuple. An
    empty `repeats` and a failed impression read produce IDENTICAL served output,
    and this project has already shipped a feature that was silently unreachable
    behind exactly that ambiguity. `baseline_unknown` separates "nothing grew"
    from "nothing was measurable"; `exempt` proves the C5 exemption is live
    rather than trusted.
    """

    #: Goes forward to scoring. Everything not suppressed.
    fresh: list[Candidate] = field(default_factory=list)

    #: Stepped aside. ASCENDING by impressions, then OLDEST-served first — the
    #: least-shown, longest-ago post is the first thing the valve gives back.
    repeats: list[Candidate] = field(default_factory=list)

    #: How many candidates had any impression history at all.
    seen_count: int = 0

    #: Suppressed = at/over the threshold AND did not resurrect.
    suppressed: int = 0

    #: At/over the threshold but GREW enough to come back on merit.
    resurrected: int = 0

    #: At/over the threshold with a NULL baseline, so growth could not be
    #: evaluated. Kept (see :func:`resurrects`) and counted separately.
    baseline_unknown: int = 0

    #: C5: candidates skipped because they are EXPLORATION-sourced.
    exempt: int = 0


def resurrects(
    state: SeenState,
    engagers_now: int | None,
    config: SeenConfig,
) -> bool:
    """Has this post grown enough since the reader last saw it to earn another
    showing?

    ``E_now - engagers_at_last_serve >= max(min_absolute, ceil(relative * baseline))``

    ★★★ WHY THIS NEEDS NO RESET BOOKKEEPING, AND WHY THAT IS THE WHOLE DESIGN.
    The baseline is OVERWRITTEN ON EVERY SERVE (the aggregate's `ON CONFLICT DO
    UPDATE` sets `engagers_at_last_serve` from the serving build). So the moment
    a resurrected post is shown again its baseline re-arms at the new, higher
    engager count, and the NEXT resurrection costs another full growth step on
    top of that. Impressions keep accruing (3, 4, 5...) and are never reset.

    The consequences are exactly the owner's rule: a post that stops growing
    stays suppressed permanently; a post that keeps taking off keeps coming back,
    each time at a higher price. Zero extra state, no `resurrected_at` column,
    and no oscillation — a warm build that resurrects a post three times without
    ever DELIVERING it re-evaluates against the *same* baseline each time,
    because only a delivery advances it. Nothing ratchets.

    ★ PRECEDENT, NOT INVENTION. Same shape as `ExplorationServeLog.graduated`,
    which returns a serve budget to an author whose engager count is strictly
    greater than the baseline recorded when the slot was spent. That docstring
    records TWO earlier designs that both keyed on the EXISTENCE of engagement
    and both were regressions. This keys on the delta for the same reason, and
    adds a threshold because a resurrection is worth more than a graduation.

    ★★★ AN UNMEASURABLE RULE MUST NOT SILENTLY BECOME A STRICT ONE. A `None`
    baseline — or a post whose current engager count this build could not compute
    — means growth CANNOT be evaluated, and this returns ``True`` (do not
    suppress). The failure direction that shows a reader a post they may have
    already seen is strictly cheaper than the one that empties their feed, and it
    self-heals on the very next serve, which writes a real baseline.
    """
    baseline = state.engagers_at_last_serve
    if baseline is None or engagers_now is None:
        return True
    growth = engagers_now - baseline
    if growth <= 0:
        return False
    required = max(
        config.resurrect_min_absolute,
        math.ceil(config.resurrect_relative * baseline),
    )
    return growth >= required


def split_seen(
    candidates: Sequence[Candidate],
    seen: Mapping[str, SeenState],
    config: SeenConfig,
    engagers_now: Mapping[str, int],
) -> SeenSplit:
    """Split a candidate pool into what goes forward and what steps aside.

    ``seen`` and ``engagers_now`` are both keyed by ``Post.key`` — the RANKED
    identity. ``candidates`` may be any pool; nothing here assumes it came from
    `filter_eligible`.

    ★ ORDER IS PRESERVED in ``fresh``. The split runs PRE-SCORING, so the pool it
    hands on is the pool the diversity re-ranker allocates lane quotas against —
    which is the second reason for this placement. Removing already-scored items
    afterwards would mean every lane quota, every author-spacing budget and the
    filler's own sizing had been spent on posts that will not be served: a lane
    that gets 4 slots, all of them seen, would contribute 0 to the page and its
    quota would simply be LOST rather than reallocated. Both faults are silent.

    ★ ``repeats`` IS ORDERED FOR THE VALVE, not for the reader: ascending by
    impressions, then oldest-served first, then by the pool's own original order
    as a stable tie-break. The least-shown, longest-ago post is what a starved
    feed gets back first.
    """
    split_fresh: list[Candidate] = []
    # (impressions, last_served_at, original_index, candidate) — sorted at the end.
    aside: list[tuple[int, float, int, Candidate]] = []
    seen_count = 0
    suppressed = 0
    resurrected = 0
    baseline_unknown = 0
    exempt = 0

    for index, candidate in enumerate(candidates):
        # ★★★ CONTRACT C5, ENFORCED HERE AND NOT ONLY BY CALL ORDER. See the
        # module docstring: the resurrection rule is unreachable for a debut post
        # (E = 0 by construction), so suppressing the newcomer seat makes the
        # lane non-renewable — 2 impressions per viewer, ever. 20 of 30 live
        # exploration pairs are ALREADY at >= 2. This check costs one identity
        # comparison per candidate and removes the entire class of "somebody
        # moved the split and buried every newcomer".
        if candidate.source is CandidateSource.EXPLORATION:
            exempt += 1
            split_fresh.append(candidate)
            continue

        state = seen.get(candidate.post.key)
        if state is None or state.impressions < config.suppress_after_impressions:
            # Not seen, or not seen enough. Nothing to decide.
            if state is not None:
                seen_count += 1
            split_fresh.append(candidate)
            continue

        seen_count += 1
        if resurrects(state, engagers_now.get(candidate.post.key), config):
            # Counted apart from a genuine growth resurrection so an operator can
            # tell "it grew" from "we could not tell". Both keep the post.
            if state.engagers_at_last_serve is None:
                baseline_unknown += 1
            else:
                resurrected += 1
            split_fresh.append(candidate)
            continue

        suppressed += 1
        aside.append((state.impressions, state.last_served_at, index, candidate))

    aside.sort(key=lambda row: (row[0], row[1], row[2]))
    return SeenSplit(
        fresh=split_fresh,
        repeats=[row[3] for row in aside],
        seen_count=seen_count,
        suppressed=suppressed,
        resurrected=resurrected,
        baseline_unknown=baseline_unknown,
        exempt=exempt,
    )
