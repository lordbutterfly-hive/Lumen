"""DEPRECATED SHIM — ``author_engagement`` now lives on ``simworld.SimGateway``.

★ 2026-08-01. This file used to ADD the author-pooled prior by subclassing, and
every panel except q8 instantiated the plain ``SimGateway`` instead — so the
prior, the headline of the 2026-07-21 organic rebuild, was inactive in every
panel that produced a tuning table. The method therefore moved onto
``SimGateway`` itself: the default instrument must be the shipped algorithm, and
measuring WITHOUT the prior must be the deliberate act (``PriorlessSimGateway``).

The previous header claimed "anything measured with a plain SimGateway measures
the prior-less fallback, which is the honest control" — that is now exactly
backwards, which is why it is quoted here rather than left in place.

``AuthorPriorSimGateway`` survives only so existing imports keep working.
"""
from __future__ import annotations

from simworld import SimGateway


class AuthorPriorSimGateway(SimGateway):
    """Retained as an ALIAS. ``author_engagement`` moved onto ``SimGateway``
    itself (2026-08-01) because every panel that instantiated the plain gateway
    silently measured the prior-less fallback — see the note on ``SimGateway``.
    Existing panels importing this name keep working and now get the same
    behaviour as everything else."""
