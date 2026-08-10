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

★★★ SELECTION IS THE CONVERSATION, NOT THE VOTE COUNT (rebuilt 2026-08-09).
It is served to EVERY viewer, so if its membership is decided by a number a farm
can manufacture, it is a platform-wide amplifier on day one. Votes are the
cheapest such number on Hive, which is why they enter this lane ONLY through the
10% payout share.

  * **Recall (SQL, `HafsqlGateway.popular_posts`).** `_SQL_POPULAR_POSTS` orders
    by distinct commenters and rebloggers, self-excluded. Voters were removed
    from recall entirely (they were 0.5 of 1.3 = 38% of it), because a post the
    prefilter never returns cannot be rescued by any scoring below.
  * **Selection (`select_popular`, here).** Rescores that pool on
    `0.9*(0.6*comments + 0.4*reblogs) + 0.1*payout`, every part relative to the
    pool's own maximum, with each commenter/reblogger weighted by the SAME
    `VoterTrust` budget the organic term uses and tilted up to 1.5x when
    on-chain reputation is >= 60.

The two steps are different questions on purpose: recall asks "which posts could
possibly belong", selection asks "which of them earned it".
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence

from recsys.config import PopularConfig, ScoreWeights
from recsys.contracts import Candidate, CandidateSource, Post, ScoredCandidate
from recsys.core.normalize import log_compress
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


def is_container_post(
    post: Post, popular: PopularConfig, lite_publishers: frozenset[str] = frozenset()
) -> bool:
    """True for a rolling CONTAINER post that other content is filed into.

    See `PopularConfig.container_markers` for why these cannot be allowed to win
    a conversation-ranked lane: they collect commenters structurally, so they
    beat every real post without being about anything.

    Author AND prefix must both match — `peak.snaps` may publish a genuine post,
    and a stranger may name a post `waves-something`.
    """
    for author, prefix in popular.container_markers:
        if post.author == author and post.permlink.startswith(prefix):
            return True
    return bool(
        lite_publishers
        and post.author in lite_publishers
        and post.permlink.startswith(popular.lumen_container_prefix)
    )


def _high_rep(
    identities: frozenset[str], reputations: Mapping[str, float], threshold: float
) -> int:
    """How many of these accounts are established (display reputation >= threshold).

    A COUNT, deliberately. The first version measured a FRACTION
    (`above / len`), which meant a post with one established commenter scored
    1.500 and a post with thirty commenters of whom ten were established scored
    1.167 — more genuine discussion produced a LOWER score. The owner asked for
    "weight it stronger if accounts above 60 rep", which is a count.

    Missing reputations read as below the bar: an identity we could not measure
    must not be handed a bonus we cannot justify.
    """
    return sum(1 for name in identities if reputations.get(name, 0.0) >= threshold)


def _weighted(
    identities: frozenset[str],
    *,
    trust: VoterTrust | None,
    reputations: Mapping[str, float],
    popular: PopularConfig,
) -> float:
    """How much this crowd counts: sybil budget + bounded spread + capped
    reputation credit.

    ★★★ REBUILT 2026-08-09 (second pass) after an adversarial review proved the
    first version was farmable. Three faults, one cause — the honest signal had
    almost no dynamic range, so a term an attacker controls decided the lane:

    1. **The budget SATURATES.** `credited_breadth` credits an all-unvouched set
       exactly `unknown_free` (1.0) whether it holds 1 account or 1000. That is
       correct for votes, which are free; used alone here it meant a post with
       200 real commenters and a post with 40 was indistinguishable, and the
       reputation multiplier became the whole ranking. Measured then: 40 aged
       rep-65 accounts BEAT 200 genuine commenters.
    2. **Reputation multiplied that constant** instead of consuming budget, so
       the farm's tilt scaled a number it shared with everyone.
    3. **One outlier crushed the pool.** Dividing a raw count by the pool max
       let a single viral post squash the 54% comment term to a ~0.007 spread
       and flip the order of unrelated posts.

    The fix is additive, and each part answers one fault:

        weighted = credited_breadth(ids)          # sybil budget, unchanged
                 + log10(1 + len(ids))            # spread a farm can only grow
                                                  #   logarithmically (fixes 1 and 3)
                 + rep_bonus * min(high_rep, rep_max_credit)   # capped (fixes 2)

    Why `log10`: it restores the ability to tell 200 commenters (2.30) from 40
    (1.61) while making the farm pay exponentially for each extra rank, and it
    is the same compression the payout term already uses — so one viral post now
    scores 3.48 against 2.30, not 100x.

    Why the reputation credit is CAPPED: reputation on Hive is stake-derived and
    an aged account can hold it, so it must help without being buyable without
    limit. `rep_max_credit` is the ceiling on what reputation alone can add.
    """
    if not identities:
        return 0.0
    budget = float(len(identities)) if trust is None else trust.credited_breadth(identities)
    spread = math.log10(1.0 + len(identities))
    established = _high_rep(identities, reputations, popular.rep_bonus_threshold)
    # ★★★ REPUTATION LIFTS THE CROWD, IT DOES NOT REPLACE IT (2026-08-09, third
    # pass). The previous form added `rep_bonus * min(established, cap)` — up to
    # 5.0, against a trust budget capped at 1.0 and a log spread worth only 2.30
    # at 200 commenters. Measured: 40 aged rep-65 accounts scored 7.61 and BEAT
    # 200 genuine commenters at 3.30. That is the original defect in additive
    # clothing, and it is worse than it looks, because Hive reputation IS stake
    # (display 60 ≈ one full upvote from ~243k HP) — so a 5.0-weight lever
    # bought with stake walked straight around the owner's 10% cap on stake.
    #
    # Now it MULTIPLIES the crowd term and is bounded to `1 + rep_lift`. A small
    # established crowd can be lifted, but it cannot out-score a crowd several
    # times larger: at the shipped 0.4 the most reputation can do is 1.4x, while
    # 200 commenters carry 1.43x the spread of 40 — so genuine breadth wins,
    # which is the property the whole lane exists to express.
    #
    # It also stops silently excluding Lumen Lite writers, who have no chain
    # reputation at all and could never earn the additive credit.
    lift = 1.0 + popular.rep_lift * (
        min(established, popular.rep_max_credit) / popular.rep_max_credit
        if popular.rep_max_credit > 0
        else 0.0
    )
    return budget + spread * lift


def select_popular(
    posts: Sequence[Post],
    *,
    excluded_for: Callable[[str], frozenset[str]],
    trust: VoterTrust | None,
    weights: ScoreWeights,
    limit: int,
    popular: PopularConfig,
    reputations: Mapping[str, float] | None = None,
    lite_publishers: frozenset[str] = frozenset(),
) -> list[Candidate]:
    """The lane: the ``limit`` posts leading the CONVERSATION, as
    :data:`~recsys.contracts.CandidateSource.OON_POPULAR`.

    ★★★ REBUILT 2026-08-09. Owner: *"popular lane needs to come from comments
    and reblogs and 10% from payout... take into account the reputation onchain
    from the people commenting, weight it stronger if accounts above 60 rep."*

    It used to select on :func:`credited_breadth`, which is dominated by
    distinct VOTERS. That made the one lane served to every viewer a
    vote-count contest, in a system whose owner has capped vote influence at
    ~10% precisely because Hive votes are botted — and it is why the lane could
    not win top-10 slots on merit and had to be handed them by the per-page
    exemption (`q12_lane_balance` G2a measured +3.144 ranks of unearned
    placement).

    The score, all three parts RELATIVE TO THIS POOL so the lane always has a
    top and cannot drift on absolute thresholds:

        popularity = (1 - payout_share) * conversation + payout_share * payout_rel
        conversation = comment_share * comment_rel + (1 - comment_share) * reblog_rel

    `comment_rel` / `reblog_rel` are each post's trust-budgeted, reputation-
    tilted commenter / reblogger weight over the pool's maximum. `payout_rel` is
    log-compressed rshares over the pool's maximum — capped by
    `popular.payout_share` at 10%, which is the owner's number and the only
    place stake enters this lane at all.

    Every identity passes through the caller's `excluded_for`, so the author,
    their ring, and banned accounts contribute nothing — a banned troll cannot
    promote anyone into the lane every viewer sees.

    Ties break on ``post.key`` so the lane is deterministic for a given window:
    two replicas must agree, and a lane whose membership depends on row order
    would make every measurement of it unreproducible.

    ``limit <= 0`` disables the lane and returns ``[]``.
    """
    if limit <= 0 or not posts:
        return []
    # ★ Containers are removed BEFORE scoring, not penalised after: a post that
    # cannot legitimately win should never be in the pool competing for the
    # pool-relative maxima either, or it would still deflate everyone else's
    # comment_rel by holding the ceiling.
    posts = [p for p in posts if not is_container_post(p, popular, lite_publishers)]
    if not posts:
        return []
    reps: Mapping[str, float] = reputations or {}

    rows: list[tuple[Post, float, float, float]] = []
    for post in posts:
        excluded = excluded_for(post.author)
        commenters = frozenset(getattr(post, "commenters", frozenset())) - excluded
        rebloggers = frozenset(getattr(post, "rebloggers", frozenset())) - excluded
        payout = sum(
            vote.rshares
            for vote in post.votes
            if vote.rshares > 0 and not vote.lite and vote.voter not in excluded
        )
        rows.append(
            (
                post,
                _weighted(commenters, trust=trust, reputations=reps, popular=popular),
                _weighted(rebloggers, trust=trust, reputations=reps, popular=popular),
                log_compress(payout),
            )
        )

    max_c = max((c for _, c, _, _ in rows), default=0.0)
    max_r = max((r for _, _, r, _ in rows), default=0.0)
    max_p = max((p for _, _, _, p in rows), default=0.0)

    def _rel(value: float, biggest: float) -> float:
        # A pool where nobody was commented on scores every post 0 on that part,
        # rather than dividing by zero or inventing a tie at 1.0.
        return value / biggest if biggest > 0 else 0.0

    def _score(row: tuple[Post, float, float, float]) -> float:
        _, c, r, p = row
        conversation = (
            popular.comment_share * _rel(c, max_c)
            + (1.0 - popular.comment_share) * _rel(r, max_r)
        )
        return (
            (1.0 - popular.payout_share) * conversation
            + popular.payout_share * _rel(p, max_p)
        )

    ranked = sorted(rows, key=lambda row: (-_score(row), row[0].key))
    return [
        Candidate(post=post, source=CandidateSource.OON_POPULAR)
        for post, _, _, _ in ranked[:limit]
    ]


def insert_popular(
    ranked: Sequence[ScoredCandidate],
    config: PopularConfig,
) -> list[ScoredCandidate]:
    """Guarantee exactly one popular post at a reserved position in the feed.

    ★★★ WHY THIS EXISTS (2026-08-09). The lane reached only 40% of feeds, and
    that figure did NOT move at `popular_per_page` 1, 2 or 3 — a cap governs how
    many popular posts appear where the lane already won and cannot produce one
    where it lost. The owner accepted the relevance cost and asked for the post
    to be locked in. A reserved position is the only mechanism that delivers
    that, and it is the one the newcomer lane has used since 2026-08-04
    (`insert_exploration`), so this deliberately mirrors its shape rather than
    inventing a second placement concept.

    THE THREE RULES, each enforced structurally rather than by convention:

    * **Never above the head.** `reserved_position` is 1-indexed and validated
      to be 0 or greater than 5, so positions 1-5 are whatever the reader
      earned. The reservation is visible, not dominant.
    * **Never twice.** The feed is scanned for an existing `OON_POPULAR` post
      first. If one is already at or above the slot, NOTHING happens — a lane
      that won on merit is never given a second copy. If one sits deeper, it is
      MOVED, not copied. Only when the feed has none is one taken from the tail.
    * **Never more than `max_reserved_per_feed`.** One promotion per feed, full
      stop.

    ★ PROMOTION, NOT INSERTION — the lesson `insert_exploration` learned the
    hard way. Its first version skipped any pick already present, which made the
    lane a no-op in its central case: the post was "already there" at position
    99, which a reader cannot tell from absent. Moving the existing post keeps
    the feed length identical and cannot duplicate anything.

    Nothing is ever dropped: items shift by one, so the feed only reorders.
    """
    slot = config.reserved_position
    if slot <= 0 or config.max_reserved_per_feed <= 0 or not ranked:
        return list(ranked)

    feed = list(ranked)
    index = slot - 1  # 1-indexed position -> list index
    if index >= len(feed):
        return feed  # feed shorter than the slot; nothing to reserve

    existing = [i for i, c in enumerate(feed) if c.source == CandidateSource.OON_POPULAR]

    # ★★★ ONE PER FEED, ENFORCED HERE (2026-08-09, owner: "cap it at 1 popular
    # post per feed"). Measured before this: 11% of feeds served two popular
    # posts in the top 10 and 2% served three.
    #
    # `DiversityConfig.popular_per_page` could never do this — it is an EXEMPTION
    # budget, not a cap: it lets a popular candidate skip the unchosen-lane
    # penalty, and a second one can still place on the ordinary unchosen budget.
    # Nothing downstream counted them. This is the only place that does.
    #
    # The surplus is moved to the TAIL, not deleted. Deleting was tried first and
    # it broke the feed's length contract: `limit` posts were requested and fewer
    # came back (`test_limit_parameter_truncates_the_payload_and_count_agrees`).
    # A tail move is length-neutral, so every downstream count still holds, and
    # the surplus lands past the served window rather than in the reader's page.
    if len(existing) > config.max_reserved_per_feed:
        surplus = set(existing[config.max_reserved_per_feed :])
        kept = [c for i, c in enumerate(feed) if i not in surplus]
        moved = [c for i, c in enumerate(feed) if i in surplus]
        feed = kept + moved
        existing = [i for i, c in enumerate(feed) if c.source == CandidateSource.OON_POPULAR]

    if existing and existing[0] == index:
        return feed  # already exactly where it belongs

    # ★ A POPULAR POST THAT RANKS INTO THE HEAD IS MOVED DOWN, NOT LEFT THERE
    # (2026-08-09, third pass). The first version returned unchanged whenever one
    # sat at or above the slot, reasoning that a lane winning on merit should
    # keep its place. Measured, that left popular posts served at positions 4 and
    # 5 in 7 of 96 feeds — the owner's rule is that positions 1-5 are the
    # reader's own, whether the popular post got there by placement or by score.
    # Config validation only ever constrained the SETTING; this constrains the
    # SERVED FEED, which is the thing the rule was about.

    take_from = existing[0] if existing else None
    if take_from is None:
        # No popular post in the feed at all: there is nothing to promote and
        # this function does not invent candidates. An empty lane stays empty —
        # honest, and it keeps `select_popular` the only place membership is
        # decided.
        return feed

    picked = feed.pop(take_from)
    feed.insert(index, picked)
    return feed


__all__ = ["credited_breadth", "insert_popular", "is_container_post", "select_popular"]
