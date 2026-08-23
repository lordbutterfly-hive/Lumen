"""The reserved RECENT-POST seat (2026-08-23).

★ WHAT THIS FIXES. An audit of the live feed measured a median served post age
of **50.6 hours**, with exactly one post under six hours old in thirty. The
primary "what is happening" surface was showing the day before yesterday.

★ WHY IT IS A SEAT AND NOT A WEIGHT. See :class:`recsys.config.FreshnessConfig`
for the full argument. The short form is that this codebase already measured the
answer for the newcomer lane and wrote it down: a post with no accumulated
engagement lands in the 3rd-4th percentile BY CONSTRUCTION, so "no weight tuning
reaches page 1; only a reserved slot does". A two-hour-old post has the same
problem for the same reason -- ``pooled_author_base`` is a log of ACCUMULATED
engagement, and accumulating is precisely what it has not had time to do.

★★★ THIS LANE PROMOTES. IT DOES NOT ADMIT. That is the single most important
property here and it is a deliberate departure from
:func:`recsys.core.exploration.insert_exploration`, which INSERTS candidates the
ranker had set aside.

Everything this function touches has ALREADY been through candidate gathering,
the second-degree vouch gate, the author floor, ring and self-dealing exclusion,
moderation, the seen-split and the full re-ranker. Nothing new enters the feed;
one post that was already going to be served moves earlier. So this lane cannot:

  * admit an unvouched author (it never sees one),
  * bypass a trust gate (it runs after all of them),
  * introduce a Sybil surface that ranking does not already have,
  * or change WHICH posts are served -- only the order of ones already chosen.

An insert-shaped lane would have needed its own ``CandidateSource``, its own
gate exemptions, its own serve budget and its own anti-farm machinery, exactly
as the exploration lane needed all four. A promote-shaped lane needs none of it,
because the trust question was answered before this code runs. The trade is that
if the ranked feed contains no recent post at all, the seat FORFEITS rather than
reaching further down for one -- which is the honest behaviour: there is nothing
fresh to show and inventing something would be worse than showing nothing.

★ WHERE THE SEAT SITS, AND THE RULE THAT DECIDED IT. The exploration seat is at
13 because a newcomer's post is a risk the reader did not ask for; a recent post
from an author they already follow is not a risk, so this seat is shallower. But
it is NOT as shallow as it first looks, because
:func:`recsys.core.popular.insert_popular` records a rule this lane is equally
bound by: positions 1-5 (one-indexed) "are whatever the reader EARNED. The
reservation is visible, not dominant." So the seat takes the first index outside
that protected head which the popularity lane has not already claimed --
zero-indexed 6. See :attr:`recsys.config.FreshnessConfig.position`.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Sequence

from recsys.config import FreshnessConfig
from recsys.contracts import ScoredCandidate


def recent_candidates(
    ranked: Sequence[ScoredCandidate],
    config: FreshnessConfig,
    now: datetime,
) -> list[ScoredCandidate]:
    """The already-ranked posts young enough to hold a freshness seat.

    Order is the RANKER'S order, not recency. Among posts that are all recent
    enough to qualify, the one the ranker scored highest is the one worth the
    seat: this lane exists to correct a POSITION, not to override the ranking
    with a second opinion about quality. Sorting by recency here would hand the
    seat to whatever was posted most recently regardless of merit, which is a
    different product and a worse one.

    ``max_posts_per_author`` is applied in that same order, so an author who
    posted three times in the last hour contributes their best-ranked post and
    not their newest.
    """
    if config.slots_per_page <= 0:
        return []
    cutoff = now - timedelta(hours=config.max_age_hours)
    per_author: dict[str, int] = {}
    out: list[ScoredCandidate] = []
    for candidate in ranked:
        created = candidate.post.created
        if created is None or created < cutoff:
            continue
        # A post dated in the FUTURE is a clock problem or a forged timestamp,
        # never a fresh post. It would otherwise sort as maximally recent and
        # take the seat on every feed until the clock caught up.
        if created > now:
            continue
        author = candidate.post.author
        seen = per_author.get(author, 0)
        if seen >= config.max_posts_per_author:
            continue
        per_author[author] = seen + 1
        out.append(candidate)
    return out


def promote_fresh(
    ranked: Sequence[ScoredCandidate],
    config: FreshnessConfig,
    now: datetime,
) -> list[ScoredCandidate]:
    """Move recent posts up to their reserved seats. Length-preserving.

    ★ NOTHING IS EVER ADDED OR DROPPED. Every return value is a permutation of
    the input. That is checkable, it is checked in the tests, and it is what
    makes this lane safe to run after every other stage: it cannot change the
    served SET, so no filter that ran before it can be undone by it.

    ★ A POST ALREADY AT OR ABOVE ITS SEAT IS LEFT ALONE, never demoted -- the
    same rule :func:`recsys.core.exploration.insert_exploration` uses. Being at
    position 1 is better than the seat at 3, and a lane that "corrects" that
    would be actively harming the thing it exists to promote.
    """
    if config.slots_per_page <= 0:
        return list(ranked)
    fresh = recent_candidates(ranked, config, now)
    if not fresh:
        return list(ranked)

    out = list(ranked)
    cutoff = now - timedelta(hours=config.max_age_hours)
    page = max(1, config.page_size)
    base = min(config.position, page - 1)
    ceiling = config.max_slots_per_feed
    promoted = 0

    for pick in fresh:
        if promoted >= ceiling:
            break
        page_index, within = divmod(promoted, config.slots_per_page)
        seat = page_index * page + min(base + within, page - 1)
        if seat >= len(out):
            break
        try:
            current = next(
                i
                for i, c in enumerate(out)
                if c.post.author == pick.post.author
                and c.post.permlink == pick.post.permlink
            )
        except StopIteration:  # pragma: no cover - pick came from `out`
            continue
        # Already at or ahead of the seat: it has the reach the seat would give
        # it. Spend the budget on the next one instead of shuffling for nothing.
        if current <= seat:
            promoted += 1
            continue
        # ★★★ THE SEAT IS ONLY TAKEN FROM A STALE INCUMBENT (2026-08-23).
        #
        # If the post ALREADY sitting at the seat is itself within
        # `max_age_hours`, the seat is doing its job and there is nothing to
        # correct: promoting past an equally-fresh post is a reorder with no
        # freshness gained. Without this the lane fires on every feed whose
        # posts happen to share a timestamp and shuffles it for nothing --
        # which is exactly what it did to `test_feed_length_is_monotonic_in_
        # the_follow_graph` and `test_a_healthy_feed_is_never_DILUTED_by_the_
        # fallback`, whose fixtures date every post at the epoch. Those two
        # failures were a real defect in this lane, not a fixture artifact:
        # a feed that is ALREADY fresh must not be reordered in the name of
        # freshness.
        #
        # The practical effect is that this lane is inert on a healthy feed and
        # acts only on the case it was built for: a stale head with something
        # recent buried behind it.
        incumbent = out[seat].post.created
        if incumbent is not None and cutoff <= incumbent <= now:
            promoted += 1
            continue
        out.insert(seat, out.pop(current))
        promoted += 1
    return out
