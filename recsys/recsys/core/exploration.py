"""Exploration lane (§4.3 of the cold-start spec, build item B12).

THE PROBLEM IT SOLVES. A brand-new author is not blocked — they are outscored.
Measured: a post published this instant with no engagement and no author history
scores exactly `organic_recency` (0.10) against a window median around 0.46, i.e.
the 3rd-4th percentile, BY CONSTRUCTION. 80% of the composite is a measure of
attention already received and the other 20% (vote, reputation) is also
incumbency, so no weight tuning reaches the first page. Sweeping
`organic_recency` 0.1 -> 2.0 was measured to cost nDCG at every step while still
leaving a followed author's fresh post at 0/40 first-page reach.

The one thing that works is a RESERVED SLOT, and that is what this is.

WHY IT IS SEPARATE FROM THE UNCHOSEN-LANE CAP. Capping `OON_ENGAGED` fixed the
follow curve (defect ratio 0.395 -> 1.071) and broke new-author discovery
(10/10 -> 0/10) because that lane is simultaneously the crowding problem AND the
only route a newcomer had into an established feed. Measured over the whole cap
ladder, no single value serves both — readers and new writers need two
mechanisms, not one dial. This is the second mechanism.

THE BUDGET IS DELIBERATELY TINY — 1 slot per 20-post page, 5% of impressions.
Justification is external and measured: YouTube's production fresh/tail slot cost
-0.12% overall dwell against +2.52% fresh-content interactions and +5.5%
small-provider dwell (Wang et al., KDD 2023); TikTok's manual heating ran ~1-2%
of daily views; Meta's live backlash arrived at tens-of-percent unconnected
content. The spec's instruction is explicit: start at 1 slot, never 2.

THE SYBIL POSTURE. This lane is an explicit, budgeted, defended bypass of the
second-degree vouch — the gate still governs the other ~95% of the feed. It does
NOT take the author graph-cred floor, deliberately: a brand-new author is below
every floor by construction, which is the entire point. Its defences are instead:

  * ring exclusion — a detected ring member is never eligible;
  * a per-author epoch budget, so a farm cannot convert account count into slots;
  * interest targeting, so a slot is spent on someone the viewer plausibly wants;
  * graduation on a QUALIFYING vouch only, so a ring voting up its own boosted
    post cannot graduate it into the normal lanes;
  * bounded impressions — the boost pays reach, never score and never cred,
    which is the cold-start spec's own model for exactly this ambiguity.

NOT IMPLEMENTED, and honestly — BOTH gaps trace to the same missing serving log
(spec item B11), and neither is a small caveat:

  * The per-post SERVE cap (~100 serves) does not exist. Only the age cap is
    enforced, so a post holds the slot for its whole eligibility window instead
    of being retired early on futility. That window is NOT the 7 days
    `max_age_days` advertises, for anyone but the viewer's own follows: every
    OON/community/tag/interest query applies `AND created >= since` in SQL, and
    `since` defaults to `history.sourcing_freshness_days` (3 days). Only
    IN_NETWORK gets the wider `in_network_freshness_days`. So for a stranger's
    post — the lane's entire audience — the effective cap is
    min(sourcing_freshness_days, max_age_days) = 3 days, and `max_age_days` is
    unreachable. Nothing cross-validates the two, so raising one silently does
    nothing. This makes the real exposure SMALLER than documented, not larger.
  * `max_posts_per_author_epoch` is NOT epoch-scoped despite its name. It is
    evaluated inside a single call, over a set already narrowed to the 7-day
    freshness window, so what it actually enforces is "at most 3 of this
    author's posts in THIS request's rotation" — a concurrency cap, not the
    spec's 3-posts-per-30-day budget. There is no persisted count anywhere in
    `recsys/`. A prolific author can therefore keep 3 posts in flight
    indefinitely and cycle far more than 3 through any real 30-day window; with
    newest-first rotation that structurally favours whoever posts most often,
    which is the opposite of "no author can monopolise the lane". The name is
    kept so it still matches the spec field it implements — the shortfall is
    recorded here rather than papered over by renaming it.

Both are Sybil-relevant, so the lane's real bound today is the per-request
concurrency cap plus ring detection plus self-deal exclusion, NOT the budget the
spec describes. B11 is the prerequisite for closing either.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timedelta

from recsys.config import ExplorationConfig
from recsys.contracts import Candidate, CandidateSource, Post, ScoredCandidate, ViewerProfile


def _interest_match(post: Post, viewer: ViewerProfile) -> bool:
    """Whether the post falls inside something the viewer explicitly asked for.

    Interest-TARGETED by design (the spec follows Trial-Reels' cold-audience-by-
    interest policy): an exploration slot is a scarce, unearned impression, and
    spending it on content the viewer has shown no interest in is how a fresh
    lane becomes the thing users complain about.
    """
    if post.community and post.community in viewer.subscribed_communities:
        return True
    if post.community and post.community in viewer.interest_communities:
        return True
    return bool(viewer.interest_tags and set(post.tags) & viewer.interest_tags)


def _is_self_dealt(post: Post) -> bool:
    """Whether the post's own author appears among its engagers.

    ★ Added 2026-08-04 after the lane was MEASURED handing its slot to a
    spammer. The threat this closes is the one every other defence here misses:
    a SOLO self-farmer. `q5b` publishes 3 posts, each claiming 60 comments and
    20 reblogs, every one of them by the author. Against the lane's stated
    defences that account is invisible —

      * ring exclusion needs a GROUP; one account forms no ring, so
        `ring_members` never contains it;
      * the per-author epoch budget is 3 posts, and it published exactly 3;
      * `graph_creds` has no entry for it at all, exactly like a real newcomer,
        so no cred band and no floor can tell the two apart;
      * it is genuinely interest-matched and genuinely fresh.

    Measured, it therefore took the recency rotation's first slot and landed at
    position 13 in an ESTABLISHED viewer's feed — a self-farmed post with zero
    real engagement placed on the first page, by the discovery lane, for a
    viewer whose vouch gate had correctly excluded it everywhere else.

    Self-attribution is what separates the two: a genuine newcomer's debut has
    no engagers at all, while the farm's entire engagement is its own author.
    The rule is therefore NOT "has engagement" (that would exclude the newcomer
    whose first post earned two real comments) and NOT "credited engagement is
    zero" (which is also true of the honest newcomer). It is precisely: the
    author is engaging with themselves.

    This is §8.4's existing self-exclusion applied to eligibility rather than to
    score. Losing the exploration slot is the whole penalty — self-promotion is
    not otherwise punished, and every other lane treats the post exactly as
    before.

    LIMITS, stated honestly. A farmer who spends a SECOND account to do the
    commenting defeats this — but two mutually-engaging accounts are a ring,
    which `detect_rings` covers, and it costs them an account per post. A plain
    :class:`Post` carries counters with no identity, so self-dealing is
    invisible and this returns False; that is the same fail-toward-silence
    posture as `independent_vote_signal`, and it is why production must hydrate
    attribution. Votes are checked too, so a self-upvote alone is enough.
    """
    author = post.author
    if any(v.voter == author for v in post.votes):
        return True
    commenters: tuple[str, ...] = getattr(post, "commenters", ())
    rebloggers: tuple[str, ...] = getattr(post, "rebloggers", ())
    return author in commenters or author in rebloggers


def eligible_for_exploration(
    candidates: Iterable[Candidate],
    viewer: ViewerProfile,
    *,
    now: datetime,
    ring_members: frozenset[str],
    vouched_keys: frozenset[str],
    suppressed: frozenset[str],
    show_nsfw: bool,
    config: ExplorationConfig,
) -> list[Candidate]:
    """The exploration pool: posts that could not get in on merit and should be
    given one bounded chance to.

    ``candidates`` is the WHOLE gathered pool, not the posts that failed
    eligibility.

    ★ That distinction was a real bug on the first build (2026-08-04). Sourcing
    from the failed set looked elegant — "posts that could not get in" — and was
    wrong: the spec's condition is *0 qualifying vouches*, not *failed the
    gate*. A brand-new author's post very often PASSES eligibility (the
    cold-start `INTEREST_*` lanes are gate-exempt, and one friendly vouch clears
    the second-degree gate) and then simply loses on score, which is the entire
    problem this lane exists to solve. Sourcing from failures skipped exactly
    those posts. Measured with the failed-set version: a cold viewer's feed put
    the newcomer's three debut posts at positions 99, 106 and 108 — present,
    unreachable, and never once given the reserved slot.

    ``vouched_keys`` names posts that already hold at least one qualifying
    vouch; those have graduated and are excluded (§4.3). Because the pool is now
    drawn from everything, the caller must also exclude whatever already made
    the ranked feed — :func:`insert_exploration` does that — or a post could be
    shown twice.

    Every condition is required (§4.3): fresh enough, no qualifying vouch yet,
    author not ring-flagged, matches the viewer's declared interests, and inside
    the author's per-epoch budget. Ordering is a deterministic round-robin over
    authors, newest-first within an author, so no author can monopolise the lane
    and the same inputs always yield the same order.
    """
    if config.slots_per_page <= 0:
        return []
    cutoff = now - timedelta(days=config.max_age_days)
    fresh: list[Candidate] = []
    for candidate in candidates:
        post = candidate.post
        # ★ VIEWER-SAFETY FILTERS (added 2026-08-04). These are NOT redundant
        # with `filter_eligible`, and assuming they were is how the lane shipped
        # broken. This function is handed the RAW gathered `candidates`, on
        # purpose — the pool must contain posts that lose on score, and
        # `filter_eligible`'s output has already had the second-degree gate
        # applied, which would re-impose exactly the gate this lane exists to
        # bypass. The cost of taking the raw set is that every OTHER protection
        # `filter_eligible` applies is skipped too, and the first build skipped
        # all of them.
        #
        # Measured, with a cold viewer who had MUTED an author: that author's
        # posts landed at position 13 — the reserved slot — in the feed of the
        # very viewer who muted them. A mute is an unconditional promise to the
        # reader, and the discovery lane was quietly overriding it. Suppressed
        # posts and NSFW leaked by the same route.
        if post.author in viewer.mutes:
            continue
        if post.key in suppressed:
            continue
        if post.is_nsfw and not show_nsfw:
            continue
        if post.created < cutoff:
            continue
        if post.key in vouched_keys:
            continue
        if post.author in ring_members:
            continue
        if _is_self_dealt(post):
            continue
        if not _interest_match(post, viewer):
            continue
        fresh.append(candidate)

    # Per-author epoch budget, then round-robin. Sorting by (author, -created)
    # first makes both steps deterministic regardless of input order.
    fresh.sort(key=lambda c: (c.post.author, -c.post.created.timestamp(), c.post.key))
    by_author: dict[str, list[Candidate]] = {}
    for candidate in fresh:
        bucket = by_author.setdefault(candidate.post.author, [])
        if len(bucket) < config.max_posts_per_author_epoch:
            bucket.append(candidate)

    # ★ Authors are rotated NEWEST-FIRST, not alphabetically (fixed 2026-08-04).
    # The spec's phrase is "deterministic rotation WEIGHTED BY RECENCY"; the
    # first build implemented the rotation and dropped the weighting, ordering
    # authors by name. Measured, that made the lane useless in exactly its
    # target case: 60 authors were eligible in the sim world, the slot budget
    # reached ~10 of them, and they were allocated in alphabetical order — so
    # `a-photo-00`, an ESTABLISHED author who merely had one unvouched post,
    # took every slot and `newbie-author` never got one. The newcomer stayed at
    # positions 99/106/108, unchanged from having no exploration lane at all.
    #
    # It was also a free Sybil handle: with alphabetical order, renaming
    # yourself `aaa-` bought the scarce slot outright. Recency is not gameable
    # in the same way — everyone can post now, and the per-author epoch budget
    # is what actually bounds a farm.
    rotated: list[Candidate] = []
    authors = sorted(by_author, key=lambda a: (-by_author[a][0].post.created.timestamp(), a))
    for depth in range(config.max_posts_per_author_epoch):
        for author in authors:
            bucket = by_author[author]
            if depth < len(bucket):
                rotated.append(
                    Candidate(post=bucket[depth].post, source=CandidateSource.EXPLORATION)
                )
    return rotated


def insert_exploration(
    ranked: Sequence[ScoredCandidate],
    pool: Sequence[ScoredCandidate],
    config: ExplorationConfig,
) -> list[ScoredCandidate]:
    """Splice exploration picks into an already-ranked feed at a fixed position.

    Inserted AFTER re-ranking, never scored against the rest: the whole point is
    that this content cannot win on score. Placement is one slot per page at
    ``config.position`` — deep enough not to displace the head, shallow enough
    to actually be seen.

    ★ "NEVER DISPLACES ANYTHING" WAS FALSE and is corrected here (2026-08-04).
    Within this function nothing is dropped — a fresh pick grows the list by one
    and a promotion is length-neutral. But `rank_feed` truncates to
    `settings.diversity.top_k` immediately after calling this, and neither the
    growth nor the shift is accounted for there, so at the boundary the marginal
    tail item falls outside the cut. Nothing validates `top_k` against
    `page_size`/`position`, so a caller who sets `top_k` with no headroom past
    the deepest exploration-touched page loses one item per pick.

    That is not a bug to fix, it is what RESERVING a slot means — the reserved
    content has to come from somewhere, and the displaced item is the weakest
    one on the page. It was simply described wrongly. Under the shipped defaults
    (`top_k=200`, `page_size=20`, filler padding keeping eligible+filler <=
    top_k) a single pick does not reach the boundary at all.

    If the pool is empty the feed is returned unchanged.

    ★ A pick already present in ``ranked`` is PROMOTED, not skipped — it is
    removed from wherever it landed and placed in the reserved slot. This was
    the second bug in this build (2026-08-04). The first version de-duplicated
    against the feed, which sounded right and made the lane a no-op in its
    central case: measured, a cold viewer's feed already contained the
    newcomer's three debut posts at positions 99, 106 and 108, so every one of
    them was "already present", the pool emptied, and nothing was ever promoted.
    Being in the feed at position 99 is indistinguishable from being absent.

    A post is only promoted if it currently sits DEEPER than the slot; one
    already ahead of it is left alone rather than demoted. Nothing is ever
    dropped — items shift, so a feed only grows or reorders.
    """
    if config.slots_per_page <= 0 or not pool:
        return list(ranked)

    out = list(ranked)
    picks = list(pool)
    page = max(1, config.page_size)
    base = min(config.position, page - 1)
    inserted = 0
    while picks:
        page_index, within = divmod(inserted, config.slots_per_page)
        at = page_index * page + min(base + within, page - 1)
        if at > len(out):
            break
        pick = picks.pop(0)
        # ★ AN AUTHOR ALREADY PLACED ABOVE THE SLOT DOES NOT ALSO GET IT
        # (added 2026-08-04). Dedup was by post KEY only, so an author with a
        # merit-ranked post could win the reserved slot with a SECOND, unrelated
        # post — two slots for one author, and `diversity_rerank` cannot re-run
        # to space them because the splice happens after it.
        #
        # ★★ The FIRST version of this check compared against the whole feed
        # ("author appears anywhere") and broke the lane's primary case
        # outright: the q3 newcomer publishes THREE debut posts, all of them
        # buried together at 99/106/108, so each one blocked the promotion of
        # the other two and the newcomer went straight back to 99 — the exact
        # no-op this lane was built to fix. It was also far stricter than
        # anything the system actually enforces: `diversity_rerank` applies a
        # SOFT decay (`author_decay`/`author_floor`), never a hard cap.
        #
        # AHEAD OF THE SLOT is the honest analogue of rerank's "already placed"
        # counter, which counts only what was placed above. An author at
        # position 5 has real reach and is declined; an author whose every post
        # sits at 99+ has none, and is exactly who the slot is for. This also
        # corrects a misreading of the original repro: `alice` at position 21 of
        # a 22-item feed looked like "already visible" and was in fact the tail.
        #
        # The pick's own key is excluded so promotion still works — a promoted
        # post trivially "appears" in the feed as itself.
        if any(
            i <= at and c.post.author == pick.post.author and c.post.key != pick.post.key
            for i, c in enumerate(out)
        ):
            continue
        # Already in the feed? Promote it from wherever it landed. Deeper than
        # the slot only — a post already ahead of the slot keeps its better
        # place, and the slot stays open for the next pick rather than being
        # spent demoting someone.
        existing = next((i for i, c in enumerate(out) if c.post.key == pick.post.key), None)
        if existing is not None:
            if existing <= at:
                continue
            out.pop(existing)
        out.insert(at, pick)
        inserted += 1
    return out


def graduated_keys(
    engager_index: Mapping[str, frozenset[str]],
    qualifying: frozenset[str],
) -> frozenset[str]:
    """Post keys holding at least one QUALIFYING vouch — i.e. graduated out of
    the exploration pool and into the normal lanes.

    Qualifying, not merely any engagement: graduation on a bare engager would let
    a ring vote up its own boosted post and promote it, which is the specific
    hole §4.4's "trusted graduation" clause exists to close.
    """
    return frozenset(
        key for key, engagers in engager_index.items() if engagers & qualifying
    )


__all__ = ["eligible_for_exploration", "graduated_keys", "insert_exploration"]
