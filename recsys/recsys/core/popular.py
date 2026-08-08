"""The across-Hive popularity lane (2026-08-08).

THE GAP IT CLOSES, and it is a SOURCING gap. A genuinely huge post that sits
outside the viewer's follows and outside their derived tags never entered the
candidate pool at all: `in_network_posts` needs a follow, `engaged_oon_posts`
needs one of the viewer's follows to have engaged it, `tag_posts` needs a tag
match, and the ALS lane needs a trained CF row. Popularity therefore affected
the RANKING of whatever got in and could contribute nothing of its own.
`POPULAR_FALLBACK` looks like it covers this and does not: `_fallback_filler`
only fires when the realised pool is below `FallbackConfig.min_feed_size`, so
for a healthy feed the popular query is never executed. No weight, penalty or
quota can reach a post that was never a candidate.

★★★ SELECTION IS CREDITED BREADTH, NOT VOTE COUNT — the one thing this lane
must not get wrong. It is served to EVERY viewer, so if its membership is
decided by a number a farm can manufacture, it is a platform-wide amplifier on
day one. Two separate steps, and the distinction is the whole design:

  * **Recall (SQL, `HafsqlGateway.popular_posts`).** `_SQL_POPULAR_POSTS`
    orders by `0.5*distinct voters above a dust floor + 0.3*distinct commenters
    + 0.5*distinct rebloggers`, self-excluded. That is already
    distinct-identity-shaped rather than a raw vote sum, but it is NOT trust
    weighted: SQL cannot see the weekly graph-cred snapshot, so every identity
    counts the same there and a funded-alt swarm can buy its way into the
    prefilter. This step is treated as RECALL ONLY — it decides what gets
    LOOKED at, never what gets served.
  * **Selection (here).** Each prefiltered post is re-scored with
    :func:`recsys.core.scoring.post_base_engagement` under the request's own
    :class:`~recsys.core.vote_signal.VoterTrust` budget and §8.4 exclusion set —
    the identical function and identical guards the 80% organic term already
    uses. Unknown-tier identities are budgeted (`unknown_free +
    unknown_per_vouched * vouched`), so N bare alts buy the budget, not N. The
    top `limit` by that number is the lane.

★★ THE RESIDUAL, STATED RATHER THAN LEFT TO BE FOUND. Selection cannot promote
a post the prefilter never returned, so a farm that floods the prefilter can
still DISPLACE honest posts out of the recall set even though it cannot survive
selection. The mitigation is headroom: `PopularConfig.source_limit` is a
multiple of `limit`, so the farm must fill the whole prefilter (not merely
out-rank one honest post) before an honest post is pushed out. That is a cost
multiplier, not a closure — the closure is a trust-weighted ORDER BY, which
needs the graph-cred snapshot inside SQL and is not built.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from recsys.config import ScoreWeights
from recsys.contracts import Candidate, CandidateSource, Post
from recsys.core.scoring import post_base_engagement
from recsys.core.vote_signal import VoterTrust


def credited_breadth(
    post: Post,
    excluded: frozenset[str],
    *,
    trust: VoterTrust | None,
    weights: ScoreWeights,
) -> float:
    """This post's log-compressed, trust-budgeted independent engagement.

    A thin, NAMED wrapper over :func:`recsys.core.scoring.post_base_engagement`
    rather than a second implementation: "how much genuine attention has this
    post received" already has exactly one definition in this package, and the
    lane's selection rule has to be that one or the lane is ranking on a
    quantity nothing else in the system believes.

    ``require_attribution`` is deliberately NOT forwarded. A post whose
    comment/reblog identities were never hydrated scores its votes only — it
    sorts DOWN, which is the fail-toward-silence posture the vote signal already
    takes. Failing loud here would let one unhydrated row in a chain-wide query
    take down every viewer's feed, which is a much worse trade than the same
    flag makes on the request's own candidate pool.
    """
    return post_base_engagement(post, excluded, trust=trust, weights=weights)


def select_popular(
    posts: Sequence[Post],
    *,
    excluded_for: Callable[[str], frozenset[str]],
    trust: VoterTrust | None,
    weights: ScoreWeights,
    limit: int,
) -> list[Candidate]:
    """The lane: the ``limit`` prefiltered posts with the highest CREDITED
    breadth, as :data:`~recsys.contracts.CandidateSource.OON_POPULAR`.

    ``excluded_for`` maps an author to their §8.4 exclusion set (self + ring
    co-members; stake lineage is retired — see
    :func:`recsys.pipeline._lineage_for`), supplied by the caller because only
    the pipeline holds the trust snapshot.

    Ties break on ``post.key`` so the lane is deterministic for a given window
    — two replicas must agree, and a lane whose membership depends on row order
    would make every measurement of it unreproducible.

    ``limit <= 0`` disables the lane and returns ``[]``, which is what makes
    the whole mechanism an exact no-op at
    :attr:`recsys.config.PopularConfig.limit` = 0.
    """
    if limit <= 0 or not posts:
        return []
    ranked = sorted(
        posts,
        key=lambda p: (
            -credited_breadth(p, excluded_for(p.author), trust=trust, weights=weights),
            p.key,
        ),
    )
    return [
        Candidate(post=post, source=CandidateSource.OON_POPULAR)
        for post in ranked[:limit]
    ]


__all__ = ["credited_breadth", "select_popular"]
