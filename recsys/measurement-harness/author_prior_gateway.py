"""SimGateway + the author-pooled engagement prior (NEW harness file, 2026-07-21).

``simworld.SimGateway`` is frozen, so the one extra read the rebuilt organic
term needs — ``AuthorPriorGateway.author_engagement`` — is added here by
subclassing. The implementation is the exact in-memory twin of the grouped SQL
documented on :class:`recsys.core.scoring.AuthorPriorGateway`: for each
requested author, count their top-level posts in the window and sum
``log10(1 + independent engagement)`` over them, with SELF-exclusion only
(a grouped window aggregate cannot afford the per-request lineage/ring
exclusion; that stays scoring-side, exactly as ``_SQL_POPULAR_POSTS`` does).

Anything measured with a plain ``SimGateway`` measures the prior-less
fallback, which is the honest control for the pooling half of the rebuild.
"""
from __future__ import annotations

from datetime import datetime

from simworld import SimGateway

from recsys.core.scoring import AuthorEngagement, post_base_engagement


class AuthorPriorSimGateway(SimGateway):
    """``SimGateway`` that also serves the author-pooled window aggregate."""

    def author_engagement(
        self, authors: frozenset[str], since: datetime
    ) -> dict[str, AuthorEngagement]:
        counts: dict[str, int] = {}
        totals: dict[str, float] = {}
        for p in self.w.posts:
            if p.created < since or p.author not in authors:
                continue
            counts[p.author] = counts.get(p.author, 0) + 1
            totals[p.author] = totals.get(p.author, 0.0) + post_base_engagement(
                p, frozenset({p.author})
            )
        return {
            a: AuthorEngagement(posts=counts[a], total_base=totals[a]) for a in counts
        }
