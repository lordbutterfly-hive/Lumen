"""Candidate merging (§3.1): combine per-source candidate pools into one
deduplicated, deterministically ordered list.

Pure stdlib; imports nothing but ``recsys.contracts``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from itertools import chain

from recsys.contracts import Candidate, CandidateSource

SOURCE_PRIORITY: dict[CandidateSource, int] = {
    CandidateSource.IN_NETWORK: 0,
    CandidateSource.OON_ENGAGED: 1,
    CandidateSource.OON_COMMUNITY: 2,
    CandidateSource.OON_INTEREST: 3,
    CandidateSource.INTEREST_COMMUNITY: 4,
    CandidateSource.INTEREST_TAG: 5,
    CandidateSource.OON_ALS: 6,
}


def merge_candidates(*groups: Iterable[Candidate]) -> list[Candidate]:
    """Merge candidate groups, deduping by ``post.key`` (§3.1).

    When the same post appears under multiple sources, the highest-priority
    source wins (see :data:`SOURCE_PRIORITY`). The result is ordered by
    priority (highest first); ties preserve each key's first-appearance order
    across ``groups``.
    """
    best: dict[str, Candidate] = {}
    for candidate in chain.from_iterable(groups):
        key = candidate.post.key
        current = best.get(key)
        if current is None or SOURCE_PRIORITY[candidate.source] < SOURCE_PRIORITY[current.source]:
            best[key] = candidate
    return sorted(best.values(), key=lambda c: SOURCE_PRIORITY[c.source])


def top_up(
    base: Sequence[Candidate], extra: Iterable[Candidate], target: int
) -> list[Candidate]:
    """Pad ``base`` with candidates from ``extra`` until it holds ``target``.

    The starved-feed complement to :func:`merge_candidates` (§13.5b): merging
    is symmetric and unbounded, whereas topping up is *asymmetric and capped* —
    ``base`` is the viewer's real, personalized pool and is never reordered,
    dropped or deduped away, and only the shortfall ``target - len(base)`` is
    drawn from ``extra`` (in ``extra``'s own order, skipping keys already in
    ``base``).

    Consequences that make this safe to call unconditionally:

    * ``len(base) >= target`` returns ``base`` unchanged (as a new list) and
      never touches ``extra`` — a healthy feed cannot be diluted;
    * the amount of padding is continuous in ``len(base)``: a pool one post
      short of ``target`` gains exactly one filler, so there is no cliff at
      the threshold where a feed's composition flips;
    * ``extra`` may be shorter than the shortfall — you get what exists. This
      function never invents candidates, so an empty network still yields an
      empty list and the caller stays honest about it.
    """
    deficit = target - len(base)
    if deficit <= 0:
        return list(base)
    seen = {candidate.post.key for candidate in base}
    padded = list(base)
    for candidate in extra:
        if len(padded) >= target:
            break
        if candidate.post.key in seen:
            continue
        seen.add(candidate.post.key)
        padded.append(candidate)
    return padded


__all__ = ["SOURCE_PRIORITY", "merge_candidates", "top_up"]
