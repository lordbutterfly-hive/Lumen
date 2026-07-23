"""Normalization (§4): log-compress a raw signal, then percentile-rank it
against a rolling global sample.

Foundational — every scoring path depends on this, so it is authored as part
of the scaffold (reference quality for the rest of the build) and imports
nothing but stdlib + contracts.
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Iterable, Sequence

from recsys.contracts import NormContext


def log_compress(rshares: float, floor: float = 1e7) -> float:
    """hivemind's rshares compressor: ``sign(x) * log10(max(|x|/floor, 1))``.

    Tames the whale-skewed, linear-in-stake rshares before percentile ranking.
    Values with ``|x| <= floor`` map to 0.0; the sign is preserved.
    """
    if rshares == 0:
        return 0.0
    sign = 1.0 if rshares > 0 else -1.0
    return sign * math.log10(max(abs(rshares) / floor, 1.0))


def percentile_rank(value: float, sorted_samples: Sequence[float]) -> float:
    """Fraction of the rolling sample ``<= value``, in ``[0, 1]``.

    ``sorted_samples`` MUST be ascending (see :func:`build_norm_context`). An
    empty sample returns ``0.5`` — no information means a neutral rank, never a
    spuriously high or low one.

    SATURATION IS THE FAILURE MODE TO WATCH. Every value at or above the
    sample's max returns exactly ``1.0``: this function is a rank, not a
    magnitude, and it has no headroom. So a raw signal that carries an addend
    the SAMPLE was not built with will pile every item that has the addend at
    1.0 and silently delete the ordering inside that group. That is exactly
    what the pre-2026-07-21 organic term did — a per-viewer CF bump (mean
    +1.036) on a sample whose whole range was 1.133 clipped 68 of 113 pool
    posts to 1.0, and the 80% organic term became a constant across most of
    the feed head (see :mod:`recsys.core.scoring`). Rule: anything added to a
    raw value must either be present in the sample that ranks it, or be a
    bounded percentile blended in AFTER this call — never a raw addend
    ranked against a sample built without it.
    """
    n = len(sorted_samples)
    if n == 0:
        return 0.5
    return bisect.bisect_right(sorted_samples, value) / n


def build_norm_context(
    vote_signals: Iterable[float],
    reputations: Iterable[float],
    organics: Iterable[float],
) -> NormContext:
    """Sort raw rolling samples into a cacheable :class:`NormContext`.

    Call this once per rolling window (not per request); the result is shared
    across every candidate scored in that window.
    """
    return NormContext(
        vote_signal_samples=tuple(sorted(vote_signals)),
        reputation_samples=tuple(sorted(reputations)),
        organic_samples=tuple(sorted(organics)),
    )
