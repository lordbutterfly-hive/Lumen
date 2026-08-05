"""Author + topic/community diversity re-ranking + truncation (§3.4).

Greedily re-orders scored candidates so back-to-back posts from the same
author *and* from the same community/tag get pushed apart by independent
per-key decays, then truncates to the final feed length. Imports nothing but
stdlib + contracts + config.

The topic penalty is **interest-aware**: each topic key's decay/floor are
attenuated toward 1.0 (= penalty off) by the viewer's affinity for that key,
inferred from the scored pool itself (:func:`_topic_affinities`). The pool is
personalized upstream — candidate sources are built from the viewer's follows
and subscriptions, and the final scores carry the per-viewer CF term — so a
topic's share of the pool's score mass is a viewer-specific interest signal
that needs no extra plumbing through the pipeline. Consequences:

* a dominant topic's penalty is attenuated in proportion to its share of the
  pool's total score mass — a topic is only (nearly) exempt when it (nearly)
  monopolizes the pool; co-equal interests split the share and each keeps
  real alternation pressure (diversity inside a topic always falls to the
  author penalty, which is never affinity-scaled);
* a low-affinity topic keeps (most of) the flat §3.4 penalty, so it competes
  for its first slots on raw score but is no longer *injected* merely because
  every repeat of the viewer's actual interest was suppressed;
* ``DiversityConfig.topic_affinity_strength`` scales the attenuation — 0.0
  restores the interest-blind flat penalty, 1.0 applies the full mass-share
  attenuation (which still never fully exempts a topic unless it carries the
  entire pool).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import blake2b

from recsys.config import DiversityConfig
from recsys.contracts import Post, ScoredCandidate


@dataclass
class _FeedCounters:
    """Diversity accounting for ONE feed, carried across its rerank blocks (C3,
    2026-08-05).

    `rank_feed` reranks up to three disjoint pools per request, and these
    counters used to be local to each call — so author/topic spacing reset at
    every block boundary while the mechanisms they drive are documented as
    feed-scoped. Passing one instance through makes the documented scope the
    real one; passing nothing keeps the old per-call behaviour for the many
    callers that legitimately rerank a single pool.
    """

    author_counts: dict[str, int] = field(default_factory=dict)
    topic_counts: dict[str, int] = field(default_factory=dict)
    unchosen_placed: int = 0


def _pen(placed_count: int, decay: float, floor: float) -> float:
    """Diversity penalty for a key already placed ``placed_count`` times.

    ``(1-floor) * decay**placed_count + floor`` — ``1.0`` on first placement,
    decaying geometrically toward (never below) ``floor`` on each repeat.
    """
    return (1.0 - floor) * decay**placed_count + floor


def _topic_key(post: Post) -> str:
    """Topic/community grouping key (§3.4): the post's community, else its
    first tag, else the empty string (untagged posts share one bucket)."""
    return post.community or (post.tags[0] if post.tags else "")


def _earned(candidate: ScoredCandidate) -> float:
    """The part of ``final`` the candidate EARNED — everything except the
    additive declared-interest offset (:attr:`ScoreBreakdown.interest_bonus`).

    Never negative: ``final = (1 - W)*earned_score + W*interest_pct`` and
    ``interest_bonus = W*interest_pct``, so the difference is ``(1 - W)`` times
    a non-negative score. ``max(..., 0.0)`` is float-noise defence, not logic.
    """
    return max(candidate.score.final - candidate.score.interest_bonus, 0.0)


def _topic_affinities(scored: list[ScoredCandidate]) -> dict[str, float]:
    """Per-topic-key viewer affinity in ``[0, 1]``, inferred from the pool.

    Affinity = the key's share of the pool's TOTAL EARNED-score mass (all
    affinities sum to 1). Volume *is* signal here: the eligible pool is built
    from the viewer's own follows, subscriptions and vouched out-of-network
    reach, and the scores carry the per-viewer CF term, so a topic the viewer
    actually engages dominates the mass while a stray global-popularity topic
    stays low. Total-mass (not max-mass) normalization matters: under the old
    max-normalization every topic comparable to the biggest got affinity ~1.0
    and its penalty switched fully off, so a viewer with two or three co-equal
    interests lost topic diversity across ALL of them at once. Under the total
    share, an affinity near 1.0 is only possible when one topic genuinely
    carries the whole pool; co-equal interests split the share and each keeps
    real alternation pressure. A degenerate all-zero-score pool yields
    all-zero affinities (flat penalty), never a division by zero.

    ★ EARNED mass, NOT ``final`` (2026-08-05). This summed ``score.final``,
    which since B-02 carries the viewer's DECLARED-interest offset. That closed
    a feedback loop: the declaration raised the topic's score mass, the raised
    mass was read back as "the viewer has affinity for this topic", and
    :func:`_attenuate` used that affinity to switch OFF the very topic penalty
    that exists to bound how much of the feed one topic takes. The declaration
    was counted twice — once to lift the scores, once again to remove the
    brake. Measured over 32 worlds at the shipped ``interest_match = 0.4``
    (with the penalty-scope fix in :func:`_effective_score` also in place):
    summing earned mass instead moves topic entropy @20 from 0.485 -> 0.590
    bits and own-topic share from 0.910 -> 0.889, with no quality column worse.
    The inference stays about what the POOL contains, which is the only thing
    this function claims to measure.
    """
    mass: dict[str, float] = {}
    for candidate in scored:
        key = _topic_key(candidate.post)
        mass[key] = mass.get(key, 0.0) + _earned(candidate)
    total = sum(mass.values())
    if total <= 0.0:
        return dict.fromkeys(mass, 0.0)
    return {key: value / total for key, value in mass.items()}


def _page_quota(placed: int, page_size: int, per_page: int) -> int:
    """How many candidates from a per-page-counted budget are allowed by the
    time ``placed`` slots are filled. Expressed as a running prefix quota
    rather than a per-block reset so the bound holds at EVERY depth, not just
    on page boundaries — a viewer who stops scrolling at 12 gets the same
    protection as one who reaches 20. Used for the emerging-author budget
    (B-04, ``DiversityConfig.emerging_per_page``) — the unchosen-lane budget
    itself moved to :func:`_quota` (B-03)."""
    pages = placed // page_size + 1
    return pages * per_page


def _quota(placed: int, page_size: int, share: float, minimum: int) -> int:
    """★ B-03 (2026-08-04). How many UNCHOSEN candidates are allowed by the
    time ``placed`` slots are filled — the share-based replacement for the old
    flat ``unchosen_max_per_page`` count.

    ``max(minimum * pages, floor(share * (placed + 1)))``: a per-page FLOOR
    (running-prefix, like :func:`_page_quota`, so discovery never reaches
    exactly zero mid-page) combined with a running SHARE of everything placed
    so far (continuous in ``placed``, not stepped at page boundaries, so the
    bound tightens smoothly rather than jumping at every 20th slot).

    ``share = 1.0`` is an EXACT no-op: ``floor(1.0 * (placed + 1)) ==
    placed + 1``, which the caller's ``unchosen_placed <= placed`` invariant
    can never reach or exceed, so the quota never binds regardless of
    ``minimum`` — pinned by
    ``test_unchosen_share_of_one_is_an_exact_no_op``.
    """
    pages = placed // page_size + 1
    return max(minimum * pages, int(share * (placed + 1)))


def _attenuate(value: float, affinity: float) -> float:
    """Pull a decay/floor ``value`` toward 1.0 (= penalty off) by ``affinity``.

    ``affinity = 0`` returns ``value`` unchanged (the interest-blind flat
    penalty); ``affinity = 1`` returns 1.0 (no topic penalty at all).
    """
    return 1.0 - (1.0 - value) * (1.0 - affinity)


def _effective_score(
    candidate: ScoredCandidate,
    author_placed: int,
    topic_placed: int,
    author_decay: float,
    author_floor: float,
    topic_decay: float,
    topic_floor: float,
    topic_affinity: float,
    unchosen_pen: float = 1.0,
) -> float:
    """Diversity-discounted score (§3.4).

        effective = (earned * author_pen * unchosen_pen + interest_bonus) * topic_pen

    The author penalty is never affinity-scaled; the topic penalty is
    (:func:`_attenuate`). ``unchosen_pen`` is the caller's already-attenuated
    unchosen-lane factor, ``1.0`` for a viewer-chosen candidate.

    ★ WHICH PART OF THE SCORE EACH PENALTY DISCOUNTS (2026-08-05). This used to
    be ``final * author_pen * topic_pen``, with the caller multiplying the
    unchosen factor on afterwards — every penalty applied to the WHOLE score.
    That was wrong for two of the three, and it was expensive.

    THE DEFECT. These penalties are MULTIPLICATIVE, i.e. they act on the score's
    RATIO scale, so their real strength depends on where the score's zero sits —
    and ``ScoreWeights.interest_match`` (B-02) moved it. An on-interest post
    carries a flat ``+0.32`` offset, and in a served feed ~89% of slots are
    on-interest, so within that block every score is lifted into a high, narrow
    band while the quality-driven spread is simultaneously compressed. A fixed
    factor like the second-post author penalty (``0.625``) then outweighs a
    quality gap roughly TWICE as large as it did before B-02: measured in
    quality-percentile units the author penalty's displacement threshold went
    from ~0.33 to ~0.66. Nobody chose that; it is an accident of one term's
    offset leaking into another term's strength.

    MEASURED CONSEQUENCE (32 worlds x 24 viewers, prior ON vs OFF, own-stratum
    capture at depth 20 — `measurement-harness/q10_prior_robustness.py`'s
    ``stack_capture_g`` is exactly this quantity): the author-pooled quality
    prior's contribution fell from +0.0102 to +0.0049 and went NEGATIVE on 5 of
    32 worlds. With the author penalty switched off entirely the prior is worth
    +0.0196 at ``interest_match = 0.4`` versus +0.0200 at 0.0 — i.e. the prior
    was never redundant and was never "front-run" by the interest term; it was
    being MASKED by a penalty that this term had silently doubled. The
    interference is specific: with the author penalty off, ``interest_match``
    costs own-stratum capture 0.9188 -> 0.9191 (nothing at all).

    THE RULE. A diversity penalty discounts what a candidate EARNED — its
    engagement, its author's standing, the lane it arrived on. It must not
    discount the viewer's DECLARED-interest offset, because:

    * that offset is a per-TOPIC constant, identical for every post and every
      author in the topic, so discounting it on an AUTHOR repeat makes the
      author penalty double as a topic penalty — a job the topic penalty
      already does, at a combined strength nobody set; and
    * the UNCHOSEN-lane penalty has the same problem and already carries its
      own explicit topic channel (it is ``_attenuate``-d by topic affinity), so
      letting it also scale the topic offset is the same double-count twice.

    THE TOPIC PENALTY KEEPS THE WHOLE SCORE, deliberately — including the
    offset. It is precisely the mechanism that bounds how much of a feed one
    topic may take, and the declared-interest offset is the topic signal, so
    exempting it there would be removing the brake from the thing it brakes.
    That is not a guess: exempting the offset from the topic penalty too was
    measured and collapses topic entropy @20 from 0.590 to 0.159 bits and
    pushes own-topic share to 0.97. Same reason the split is written as
    ``(earned*pen_a*pen_u + bonus) * pen_t`` and not as one product.

    EXACT NO-OP WHEN THE CHANNEL IS OFF: ``interest_bonus`` is 0.0 at
    ``interest_match = 0.0`` or for a viewer with no declared interests, and
    the expression collapses to the old ``final * pen_a * pen_u * pen_t``.
    """
    bonus = candidate.score.interest_bonus
    earned = _earned(candidate)
    return (
        earned * _pen(author_placed, author_decay, author_floor) * unchosen_pen + bonus
    ) * _pen(
        topic_placed,
        _attenuate(topic_decay, topic_affinity),
        _attenuate(topic_floor, topic_affinity),
    )


def _best_effective(
    remaining: list[ScoredCandidate],
    *,
    chosen: bool,
    author_counts: dict[str, int],
    topic_counts: dict[str, int],
    author_decay: float,
    author_floor: float,
    topic_decay: float,
    topic_floor: float,
    topic_affinity_strength: float,
    affinities: dict[str, float],
    unchosen_decay: float,
    unchosen_floor: float,
    unchosen_placed: int,
) -> float | None:
    """★ B-03's relevance-guard comparison point. The strongest
    diversity-discounted effective score among ``remaining`` on one side of
    the viewer-chosen/unchosen split, or ``None`` when no candidate on that
    side remains.

    Unchosen candidates additionally carry the topic-attenuated unchosen-lane
    penalty (same as the main selection loop) — the guard must compare what
    each side would ACTUALLY score if picked right now, not a pre-penalty
    number. Chosen candidates never carry that penalty (it does not apply to
    them). This is one extra O(n) pass over ``remaining``, run only when the
    share quota is under pressure — the selection loop below is already
    O(n^2), so this adds no complexity class.

    ★ The unchosen factor is now PASSED INTO :func:`_effective_score` rather
    than multiplied onto its result (2026-08-05). It has to be: that penalty
    applies to the earned part only, and once the earned/declared-interest
    split lives inside ``_effective_score`` there is no way to apply it
    correctly from outside. Both call sites had to move together or the guard
    would compare a differently-computed number than the selection loop —
    which is exactly the class of drift this guard exists to prevent.
    """
    best: float | None = None
    for candidate in remaining:
        if candidate.source.is_viewer_chosen != chosen:
            continue
        author_placed = author_counts.get(candidate.post.author, 0)
        topic_key = _topic_key(candidate.post)
        topic_placed = topic_counts.get(topic_key, 0)
        unchosen_pen = (
            1.0
            if chosen
            else _attenuate(
                _pen(unchosen_placed, unchosen_decay, unchosen_floor),
                affinities.get(topic_key, 0.0),
            )
        )
        effective = _effective_score(
            candidate,
            author_placed,
            topic_placed,
            author_decay,
            author_floor,
            topic_decay,
            topic_floor,
            topic_affinity_strength * affinities.get(topic_key, 0.0),
            unchosen_pen,
        )
        if best is None or effective > best:
            best = effective
    return best


def _tie_break(seed: str, post_key: str) -> str:
    """Deterministic per-viewer tie-break key.

    Stable for a given (viewer, post): calling twice with the same inputs returns
    the same feed, so a pull-to-refresh cannot re-roll a tie into a better slot.
    With an empty seed this degrades to the post key, preserving the old global
    ordering for callers that have no viewer (tests, offline tooling).
    """
    if not seed:
        return post_key
    return blake2b(f"{seed}\x00{post_key}".encode(), digest_size=16).hexdigest()


def diversity_rerank(
    scored: list[ScoredCandidate],
    *,
    author_decay: float,
    author_floor: float,
    topic_decay: float,
    topic_floor: float,
    topic_affinity_strength: float,
    unchosen_decay: float = 1.0,
    unchosen_floor: float = 1.0,
    unchosen_share: float = 1.0,
    unchosen_min_per_page: int = 0,
    unchosen_displacement_ratio: float = 0.0,
    emerging_authors: frozenset[str] = frozenset(),
    emerging_per_page: int = 0,
    page_size: int = 20,
    tie_break_seed: str = "",
    carried: _FeedCounters | None = None,
) -> list[ScoredCandidate]:
    """Greedily space out repeat authors AND repeat topics/communities (§3.4),
    with the topic penalty attenuated by inferred viewer affinity.

    At each step, picks the remaining candidate whose effective score —
    ``final * author_pen(author_placed) * topic_pen(topic_placed, affinity)``
    — is highest, breaking ties deterministically by ``post.key`` (ascending).
    The topic key is the post's community, falling back to its first tag (see
    :func:`_topic_key`). Each key's topic penalty is attenuated by
    ``topic_affinity_strength * affinity`` (see :func:`_topic_affinities` and
    :func:`_attenuate`): the viewer's dominant topics are barely penalized
    (author diversity still spaces them), fringe topics keep the flat penalty
    — so the feed diversifies *within* the viewer's interest profile instead
    of interleaving every topic equally. ``topic_affinity_strength = 0.0``
    restores the interest-blind behavior. Does not mutate ``scored``.

    ``unchosen_share``/``unchosen_min_per_page``/``unchosen_displacement_ratio``
    (B-03, 2026-08-04) replace the old flat ``unchosen_per_page`` count with a
    share-based running quota plus a relevance guard — see :func:`_quota` and
    :data:`recsys.config.DiversityConfig.unchosen_max_share` for the full
    rationale. Defaults (``share=1.0``, ``min_per_page=0``,
    ``displacement_ratio=0.0``) reproduce the old ``unchosen_per_page=0``
    ("off") behaviour exactly: the quota never binds.

    ``emerging_authors``/``emerging_per_page`` (B-04) give a small, SEPARATE
    budget — outside the unchosen share above — to candidates whose author is
    in the set and whose source is not ``IN_NETWORK``: see
    :data:`recsys.config.DiversityConfig.emerging_per_page`. An emerging
    candidate that has already used this page's emerging budget falls back to
    the ordinary unchosen share, never a second free pass.
    """
    affinities = _topic_affinities(scored)
    # ★ Hoisted out of the selection loop (2026-08-01). `_tie_break` is a blake2b
    # digest and the loop below is O(n^2) — computing it per candidate per pass
    # hashed each post up to n times and measured 2.02x slower than the string
    # compare it replaced. It depends only on (seed, post.key), both loop
    # invariants, so one pass over the pool is exactly equivalent.
    tie_breaks = {sc.post.key: _tie_break(tie_break_seed, sc.post.key) for sc in scored}
    remaining = list(scored)
    # ★★★ C3 (2026-08-05) — THE COUNTERS ARE FEED-SCOPED WHEN A CALLER SAYS SO.
    #
    # These used to be unconditionally local, while `rank_feed` calls this
    # function THREE times over three disjoint pools (eligible, fallback filler,
    # exploration) and every mechanism built on them is documented as
    # feed-scoped. So an author placed three times in the eligible block started
    # again from zero penalty in the filler block, and the same for topics: the
    # spacing promise held *within* a block and silently reset at the boundary.
    #
    # `carried` lets `pipeline._score` thread one accounting across the blocks
    # of a single feed. Omitted (the default) reproduces the old per-call
    # behaviour exactly, which is what every unit test and panel that reranks
    # one pool in isolation relies on.
    #
    # NOTE, stated honestly: this does NOT make the B-03 unchosen quota fire on
    # the filler block, and nothing can. That block is 100% POPULAR_FALLBACK,
    # which is never `is_viewer_chosen`, so the quota's supply condition
    # (`any(chosen in remaining)`) is False there by construction — the quota
    # cannot prefer a chosen candidate from a pool that contains none. Padding's
    # only real bound is `FallbackConfig.max_share_of_feed`, and the docs now
    # say so rather than promising a share the quota never enforced.
    counters = carried if carried is not None else _FeedCounters()
    author_counts: dict[str, int] = counters.author_counts
    topic_counts: dict[str, int] = counters.topic_counts
    unchosen_placed = counters.unchosen_placed
    emerging_placed = 0
    result: list[ScoredCandidate] = []
    while remaining:
        # ★ SHARE-BASED QUOTA on lanes the viewer never asked for, PLUS a
        # relevance guard (B-03, 2026-08-04 — replaces the old flat
        # `unchosen_max_per_page` count). The geometric penalty below was not
        # enough on its own: measured, the OON_ENGAGED lane still took 56% of
        # the first page while the viewer's own follows got 38%, and its share
        # of the feed was LESS on-topic (33%) than its share of the pool
        # (49%) — the ranker was picking that lane's worst members. A penalty
        # nudges; a quota bounds. But a FLAT COUNT could not serve both the
        # reader (who wants ~1/page) and a genuine newcomer (who needs
        # >=5/page) at once, and its only supply condition —
        # `any(chosen for c in remaining)` — evicted a strong unchosen
        # candidate for an ARBITRARILY WEAK chosen one merely because one
        # existed, with no score comparison at all.
        #
        # The lane is NOT removed, deliberately. It is the second-degree
        # discovery channel ("what the people you follow are engaging"), it is
        # the only route a brand-new author has into an established feed, and it
        # genuinely surfaces better authors (+0.074 ground-truth quality). What
        # it may not do is take most of the page. Budgeted, it keeps its job.
        #
        # SUPPLY-SAFE: the cap is only enforced while a viewer-chosen candidate
        # is actually available. A viewer whose own network is empty still gets
        # a full feed rather than a short one.
        quota = _quota(len(result), page_size, unchosen_share, unchosen_min_per_page)
        quota_pressure = unchosen_placed >= quota and any(
            c.source.is_viewer_chosen for c in remaining
        )
        capped = False
        if quota_pressure:
            if unchosen_displacement_ratio > 0.0:
                # ★ THE RELEVANCE GUARD. Only actually restrict the pool to
                # chosen-only sources when a COMPARABLY STRONG chosen
                # candidate exists to take the slot — otherwise a much
                # stronger unchosen post still wins, exactly as the pre-B-03
                # geometric penalty already promises for the un-capped case.
                best_chosen = _best_effective(
                    remaining, chosen=True,
                    author_counts=author_counts, topic_counts=topic_counts,
                    author_decay=author_decay, author_floor=author_floor,
                    topic_decay=topic_decay, topic_floor=topic_floor,
                    topic_affinity_strength=topic_affinity_strength,
                    affinities=affinities,
                    unchosen_decay=unchosen_decay, unchosen_floor=unchosen_floor,
                    unchosen_placed=unchosen_placed,
                )
                best_unchosen = _best_effective(
                    remaining, chosen=False,
                    author_counts=author_counts, topic_counts=topic_counts,
                    author_decay=author_decay, author_floor=author_floor,
                    topic_decay=topic_decay, topic_floor=topic_floor,
                    topic_affinity_strength=topic_affinity_strength,
                    affinities=affinities,
                    unchosen_decay=unchosen_decay, unchosen_floor=unchosen_floor,
                    unchosen_placed=unchosen_placed,
                )
                capped = best_unchosen is not None and (
                    best_chosen is not None
                    and best_chosen >= unchosen_displacement_ratio * best_unchosen
                )
            else:
                # Guard disabled (ratio <= 0): every candidate score is >= 0.0,
                # so `best_chosen >= 0.0 * best_unchosen` is always true once a
                # chosen candidate exists — this reproduces the pre-guard, B-03
                # hard-quota-only behaviour exactly.
                capped = True
        # ★ THE EMERGING BUDGET (B-04, 2026-08-04). A SEPARATE, small budget —
        # outside the share above, never eating into it — for candidates whose
        # author has not yet earned real standing (absent from `graph_creds`,
        # or at/below `min_vouched_score` — see
        # :func:`recsys.pipeline._score`'s `emerging_authors`). Computed once
        # per outer iteration, same as `quota`/`capped` above: only one
        # candidate is popped per iteration, so it cannot go stale mid-scan.
        emerging_quota = _page_quota(len(result), page_size, emerging_per_page)
        emerging_room = emerging_placed < emerging_quota
        best_index = 0
        best_rank: tuple[float, str] | None = None
        for index, candidate in enumerate(remaining):
            emerging_exempt = (
                emerging_room
                and not candidate.source.is_in_network
                and candidate.post.author in emerging_authors
            )
            if capped and not candidate.source.is_viewer_chosen and not emerging_exempt:
                continue
            author_placed = author_counts.get(candidate.post.author, 0)
            topic_key = _topic_key(candidate.post)
            topic_placed = topic_counts.get(topic_key, 0)
            # ★ UNCHOSEN-LANE PENALTY (2026-08-03). Same geometric shape as the
            # author and topic penalties, counted over every candidate the
            # viewer did not ask for (see CandidateSource.is_viewer_chosen for
            # the measurement that motivates it).
            #
            # A PENALTY, deliberately, not a quota. A hard cap would starve a
            # viewer whose in-network supply runs out mid-feed; a penalty is
            # supply-safe by construction — when nothing chosen remains, the
            # penalized candidate is still the best available and is placed.
            # It also stays honest when discovery genuinely IS better: a much
            # stronger unchosen post still outranks a weak followed one.
            #
            # Exact no-op at floor 1.0 (see `_pen`), which is what makes the
            # k=off control in the sweep a true control. It is also a no-op for
            # a followless viewer, whose candidates are ALL unchosen and
            # therefore all carry the identical factor at each step, leaving the
            # argmax unchanged.
            #
            # ★ AND IT IS TOPIC-AWARE, which is the whole difficulty. A BLANKET
            # lane penalty was measured and rejected: OON_ENGAGED is both the
            # vector for the follow-curve defect AND the only path a brand-new
            # author has into an established viewer's feed (someone the viewer
            # follows engages the newcomer, so it arrives second-degree). Any
            # uniform setting strong enough to move the follow curve destroyed
            # new-author discovery — at decay 0.9/floor 0.5 the q3 newcomer went
            # from top-20 for 10/10 established viewers to 0/10, undoing the
            # author-prior shrinkage win from the same day.
            #
            # The two cases differ in one measurable way: the content crowding
            # the feed is OFF-topic, the newcomer is ON-topic. So the penalty is
            # attenuated by the viewer's own inferred affinity for the
            # candidate's topic — full strength on unchosen content from a topic
            # they show no affinity for, ~off on unchosen content from the topic
            # they actually read. Discovery inside your interests stays open;
            # spillover from everywhere else is what gets bounded.
            #
            # ★ It is now PASSED INTO `_effective_score` (2026-08-05) instead of
            # multiplied onto its result, because — like the author penalty —
            # it applies to the EARNED part of the score only. See that
            # function's docstring for the measurement. `1.0` for a
            # viewer-chosen candidate is the exact no-op it always was.
            unchosen_pen = (
                1.0
                if candidate.source.is_viewer_chosen
                else _attenuate(
                    _pen(unchosen_placed, unchosen_decay, unchosen_floor),
                    affinities.get(topic_key, 0.0),
                )
            )
            effective = _effective_score(
                candidate,
                author_placed,
                topic_placed,
                author_decay,
                author_floor,
                topic_decay,
                topic_floor,
                topic_affinity_strength * affinities.get(topic_key, 0.0),
                unchosen_pen,
            )
            # ★ PER-VIEWER TIE-BREAK (2026-08-01). This was `candidate.post.key`
            # — i.e. ties resolved ALPHABETICALLY by @author/permlink, globally
            # and identically for every viewer. Determinism is right; a global
            # alphabetical order is not. Wherever scores tie, the same authors win
            # for everyone, and because the winner takes the impression, the
            # engagement and the resulting history advantage, an arbitrary
            # property (where your name sorts) compounds into a durable ranking
            # advantage. That is the most plausible mechanism behind round-1 luck
            # predicting round-60 dominance at partial correlation 0.94-0.96.
            #
            # A stable hash of (viewer, post) keeps every guarantee that mattered
            # — same inputs give the same feed, a refresh cannot re-roll it — and
            # scatters ties across viewers instead of banking them for the same
            # accounts.
            rank = (-effective, tie_breaks[candidate.post.key])
            if best_rank is None or rank < best_rank:
                best_rank = rank
                best_index = index
        chosen = remaining.pop(best_index)
        author_counts[chosen.post.author] = author_counts.get(chosen.post.author, 0) + 1
        topic_key = _topic_key(chosen.post)
        topic_counts[topic_key] = topic_counts.get(topic_key, 0) + 1
        if not chosen.source.is_viewer_chosen:
            # ★ B-04: an emerging placement counts against `emerging_placed`,
            # NOT `unchosen_placed` — it is a budget OUTSIDE the share, so it
            # must never eat into the reader's general protection. Recomputed
            # from `chosen` directly (not carried from the scan loop) so this
            # stays correct regardless of which candidate the argmax actually
            # picked; `emerging_room` is still valid — nothing in this
            # iteration has changed `emerging_placed` yet.
            chosen_is_emerging = (
                emerging_room
                and not chosen.source.is_in_network
                and chosen.post.author in emerging_authors
            )
            if chosen_is_emerging:
                emerging_placed += 1
            else:
                unchosen_placed += 1
        result.append(chosen)
    # C3: publish the running total back so a following block continues this
    # feed's accounting instead of restarting at zero. `author_counts` and
    # `topic_counts` are the same dict objects and were mutated in place.
    counters.unchosen_placed = unchosen_placed
    return result



def explore(
    ranked: list[ScoredCandidate],
    *,
    slots: int,
    window: int,
    bucket: int,
    seed: str,
) -> list[ScoredCandidate]:
    """Swap the weakest visible slots for candidates from below the cut.

    ``rank_feed`` is otherwise a pure function with no randomness, no session
    state and no impression memory anywhere in the package — so two calls with
    the same inputs return byte-identical feeds by construction, and a returning
    viewer's top-20 was measured identical across 77-79 of every 79 consecutive
    sessions. Nothing generates new information; this is the only place that
    does.

    Determinism is preserved where it matters: the choice is a pure function of
    ``(seed, bucket)``, so a refresh WITHIN a session bucket returns the same
    feed and a user cannot re-roll for a better one, while a later bucket
    differs. This is exactly the property a random shuffle would destroy.

    Exploration costs the WEAKEST visible items — the tail of the first page —
    and never displaces the head, so the price is bounded and paid where it is
    cheapest. Candidates are drawn only from the already-eligible ranked pool,
    so everything promoted has passed the second-degree gate, the graph-cred
    floor and every exclusion; exploration widens exposure, never trust.
    """
    if slots <= 0 or window <= 0 or len(ranked) <= window:
        return ranked
    slots = min(slots, window)

    head = ranked[: window - slots]
    tail_pool = ranked[window - slots :]
    if not tail_pool:
        return ranked

    # Deterministic, seed-and-bucket derived pick from the below-the-cut pool.
    picks: list[ScoredCandidate] = []
    taken: set[int] = set()
    for i in range(slots):
        digest = blake2b(f"{seed}\x00{bucket}\x00{i}".encode(), digest_size=8).digest()
        offset = int.from_bytes(digest, "big") % len(tail_pool)
        for step in range(len(tail_pool)):
            idx = (offset + step) % len(tail_pool)
            if idx not in taken:
                taken.add(idx)
                picks.append(tail_pool[idx])
                break
    rest = [c for i, c in enumerate(tail_pool) if i not in taken]
    return head + picks + rest


def truncate(scored: list[ScoredCandidate], k: int) -> list[ScoredCandidate]:
    """Keep the first ``k`` candidates (§3.4)."""
    return scored[:k]


def rerank(
    scored: list[ScoredCandidate],
    diversity: DiversityConfig,
    tie_break_seed: str = "",
    explore_bucket: int = 0,
    *,
    emerging_authors: frozenset[str] = frozenset(),
    carried: _FeedCounters | None = None,
) -> list[ScoredCandidate]:
    """Author + interest-aware topic diversity re-rank then truncate to
    ``diversity.top_k`` (§3.4).

    ``emerging_authors`` (B-04) is the caller-computed set of authors who
    qualify for the emerging budget — see
    :func:`recsys.pipeline._score`, which builds it from ``graph_creds``, and
    :data:`recsys.config.DiversityConfig.emerging_per_page` for the field this
    threads.
    """
    # ★ B-03 (2026-08-04): `unchosen_max_per_page` is now a DEPRECATED ON/OFF
    # TOGGLE for the share-based quota below, not the quota itself — see that
    # field's own docstring for why it survives at all (BUILD-ADJUDICATION
    # R5: the harness constructs it by name). `<= 0` disables the whole
    # mechanism (share + floor + guard), reproducing its old "0 = off"
    # meaning exactly; any positive value enables it, sized by the three
    # fields it no longer itself controls.
    quota_enabled = diversity.unchosen_max_per_page > 0
    diversified = diversity_rerank(
        scored,
        author_decay=diversity.author_decay,
        author_floor=diversity.author_floor,
        topic_decay=diversity.topic_decay,
        topic_floor=diversity.topic_floor,
        topic_affinity_strength=diversity.topic_affinity_strength,
        unchosen_decay=diversity.unchosen_source_decay,
        unchosen_floor=diversity.unchosen_source_floor,
        unchosen_share=diversity.unchosen_max_share if quota_enabled else 1.0,
        unchosen_min_per_page=diversity.unchosen_min_per_page if quota_enabled else 0,
        unchosen_displacement_ratio=(
            diversity.unchosen_displacement_ratio if quota_enabled else 0.0
        ),
        emerging_authors=emerging_authors,
        emerging_per_page=diversity.emerging_per_page,
        carried=carried,
        page_size=diversity.explore_window,
        tie_break_seed=tie_break_seed,
    )
    # Exploration runs AFTER diversity so it draws from a pool that is already
    # spaced out, and BEFORE truncation so it can reach genuinely unexposed
    # items rather than only reshuffling what already fit.
    explored = explore(
        diversified,
        slots=diversity.explore_slots,
        window=diversity.explore_window,
        bucket=explore_bucket,
        seed=tie_break_seed,
    )
    # Near-dup text dedup is Phase-1 (dedup-by-key already ran in merge_candidates).
    return truncate(explored, diversity.top_k)
