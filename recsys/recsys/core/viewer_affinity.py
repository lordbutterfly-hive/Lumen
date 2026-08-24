"""Per-viewer affinity: the ONE personalisation channel that is safe to weight.

WHY THIS MODULE EXISTS
======================
Measured on the shipped build: a viewer who engaged topic-B content for 30
consecutive rounds saw topic-B's share of their feed go 0.0500 -> 0.0500. Bit
identical. Engagement moved the feed by exactly nothing, because ~90% of the
composite score is viewer-blind by construction (`organic_quality_raw` and
`independent_vote_signal` take no ViewerProfile) and the only personalised term —
the CF percentile — is capped at 8% for IN_NETWORK and *exactly zero* for every
other source (`organic_cf_oon_scale = 0.0`). The only thing that moved a feed was
a STRUCTURAL change: follow, subscribe, or edit your interests. Bimodal, never
continuous.

THE TRAP THIS AVOIDS
====================
The obvious fix — raise `organic_cf` / `organic_cf_oon_scale` — is wrong, and the
existing config says why at length (H06/H07). CF is a CROSS-VIEWER signal: it
learns viewer->author affinity from *other people's* co-engagement, so raising it
raises a channel strangers can poison. Those caps were measured and they are
still right.

The gap is that there is no channel where the only person who can move a viewer's
feed is that viewer. That is what this module adds.

    cross-viewer (CF)      : other people's behaviour decides what you see
                             -> poisonable -> must stay budgeted and small
    viewer-own (this)      : YOUR behaviour decides what YOU see
                             -> the worst an attacker can do by moving it is
                                change their own feed. Self-harm, not an attack.

MEASUREMENTS PRESERVED FROM A REVERTED BUILD (2026-08-24)
=========================================================
A SELECTION lane built on this channel was designed, scrutinised, and then
REVERTED on the owner's ruling: "i dont want another affinity lane. i need
everything thats just follower based to be affinity based as well." Two findings
are kept here because anyone who later proposes selection-by-affinity will need
them, and because the code that carried them is gone:

  * MEANINGFUL EDGES vs BARE UPVOTES. Ranking tolerates upvote-only edges
    because `upvote = 1.0` barely moves a score. SELECTION is a threshold, and
    on the live mirror curation/autovote trails reach 1,936-2,233 distinct
    upvote partners — "any outgoing edge" would flood a pool with authors the
    viewer never meaningfully chose. Population-wide: only 5.2% of 2,618,664
    edges carry a reply or reblog, and of upvote-only edges with >=10 upvotes
    just 6.2% have ANY reciprocal edge.
  * THE SNAPSHOT-SOURCING INVARIANT. Any selection built on these edges must
    read `snapshot.edges` — the same banned/curator-filtered list
    `compute_graph_cred` consumed — never a fresher query. The edge that admits
    an author is itself received engagement, placing them in the engaged band
    (>= `min_vouched_score` 0.10) and so above `graph_cred_floor` (0.05);
    verified live, 0 of 51 floored accounts had any inbound edge from a
    non-ring-flagged source. Sourcing from live edges reopens the 2-star
    flooring bug inside the trust batch's lag window.

THE INVARIANT — read this before touching anything here
=======================================================
A viewer-own score may reorder THAT VIEWER'S pool and nothing else. It must never
feed `graph_cred`, `train_als`, the §4 norm sample, `trusted_seeds`, or any other
viewer's candidates or ranking. The moment it does it becomes a cross-viewer
signal and inherits every poisoning vector H06 describes — while carrying a much
larger weight than CF is allowed. `affinity_percentiles` therefore takes a single
viewer's edges and returns a mapping used only for that request.

The residual risk is engagement BAIT (an author farming your clicks), which is
bounded by the same log compression the organic term already applies and is the
irreducible cost of any engagement-driven feed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime

from recsys.config import RealGraphWeights
from recsys.contracts import EngagementEdge, Post


def _decayed(edge: EngagementEdge, weights: RealGraphWeights, now: datetime) -> float:
    """The edge's weighted feature sum with the same half-life decay graph-cred
    uses, so "recent" means the same thing everywhere in the system."""
    # ★★★ `reply_backs` IS DELIBERATELY ABSENT (2026-08-08). It is the ONE term
    # on this edge the viewer does not control, and including it broke the
    # invariant this module's own docstring states three paragraphs above.
    #
    # `io/hafsql.py:1874` populates it as `replies.get((dst, src))` — the
    # AUTHOR's replies TO the viewer. `graph_cred.py` already documents that
    # this field is the reverse direction and excludes it from the ring event
    # count for exactly that reason; nobody carried the conclusion across to the
    # weighted term. So with `reply_back = 15.0` — the heaviest weight in the
    # system — a stranger could write themselves into a viewer's affinity by
    # replying to them, needing only ONE forward act from the viewer to create
    # the edge (upvoting a comment left on your own post is the most common
    # courtesy on the chain).
    #
    # MEASURED the day it was removed. Across 2,116,047 real edges from 14,225
    # sources the median top outgoing edge is 52.0, so `ceil(52/15)` = **4
    # attacker replies** takes the top slot; `affinity_percentiles` ranks over
    # DISTINCT VALUES, so the top edge gets exactly 1.0000 regardless of margin;
    # and at `organic_viewer = 0.3` that is `0.68*0.8*0.3 = 0.1632` of `final`,
    # which is 81.5% of a real page's measured 0.2002 earned band. The attacker
    # also owns `last_interaction`, so they refresh the 30-day half-life alone.
    # On the owner's own graph the term was carrying an edge from rank 2 (59.37)
    # to outside the top 6 (6.47) once removed — i.e. it was mostly not his.
    #
    # What remains is only what the VIEWER did: their replies, upvotes, reblogs.
    # That is the self-harm-only posture the module claims, actually enforced.
    raw = (
        edge.replies * weights.reply
        + edge.upvotes * weights.upvote
        + edge.reblogs * weights.reblog
        + edge.mentions * weights.mention
    )
    if raw <= 0.0:
        return 0.0
    if edge.last_interaction is None or weights.half_life_days <= 0:
        return raw
    age_days = max((now - edge.last_interaction).days, 0)
    # ★ THE RELATIONSHIP FLOOR (2026-08-24) — see `RealGraphWeights.
    # affinity_decay_floor` for why a relationship must not decay on the trust
    # layer's clock. `floor = 0.0` is byte-identical to the previous pure
    # exponential; at 0.7 a relationship keeps >=70% of its accumulated weight
    # permanently and recency only modulates the remaining band.
    floor = weights.affinity_decay_floor
    return raw * (floor + (1.0 - floor) * (0.5 ** (age_days / weights.half_life_days)))


def viewer_author_affinity(
    viewer_account: str,
    edges: Sequence[EngagementEdge],
    weights: RealGraphWeights,
    now: datetime,
) -> dict[str, float]:
    """Decayed weight of the viewer's OWN OUTGOING engagement, per author.

    Only edges whose ``src`` is the viewer count. An edge pointing AT the viewer
    is someone else's behaviour and must never influence what the viewer is
    shown — that is the cross-viewer channel this module exists to stay out of.
    """
    out: dict[str, float] = {}
    for edge in edges:
        if edge.src != viewer_account or edge.dst == viewer_account:
            continue
        w = _decayed(edge, weights, now)
        if w > 0.0:
            out[edge.dst] = out.get(edge.dst, 0.0) + w
    return out


def affinity_percentiles(
    affinity: Mapping[str, float], universe: Sequence[str] = ()
) -> dict[str, float]:
    """Rank the viewer's affinities WITHIN THEIR OWN distribution.

    Per-viewer normalisation, exactly as `als.viewer_affinity_percentiles` does
    for CF and for the same reason: a global percentile would let a heavy user's
    raw magnitudes clip the whole scale to 1.0 for everyone else, which is the
    saturation defect already fixed once for the CF bump. Ranking inside the
    viewer's own distribution cannot clip.

    A viewer with fewer than two distinct affinities has no distribution to rank
    within, so this returns ``{}`` and the caller falls back to the viewer-blind
    quality percentile — the honest answer for someone who has not engaged
    anything yet.
    """
    engaged = {k: v for k, v in affinity.items() if v > 0.0}
    if not engaged:
        return {}

    # ★ UNENGAGED ITEMS ARE ZEROS, NOT ABSENCES (fixed 2026-08-01 after the
    # end-to-end drift measurement came back +0.0000 with the channel ON).
    #
    # Ranking only the engaged items meant a viewer who engages exactly ONE
    # topic — the strongest preference expressible — produced a single-valued
    # distribution and therefore no signal at all. But "I engaged beta 30 times
    # and alpha never" is precisely the preference this channel exists to carry.
    # Seeding the distribution with the request's own candidate keys at weight 0
    # puts unengaged content at the bottom of the viewer's OWN scale, which is
    # what makes the ranking relative rather than absolute.
    full = {k: 0.0 for k in universe}
    full.update(engaged)

    values = sorted(set(full.values()))
    if len(values) < 2:
        return {}
    span = len(values) - 1
    ranks = {v: i / span for i, v in enumerate(values)}
    return {key: ranks[w] for key, w in full.items()}


def candidate_affinity(
    post: Post,
    author_pct: Mapping[str, float],
    topic_pct: Mapping[str, float],
) -> float | None:
    """The viewer's affinity percentile for one candidate, or ``None``.

    Author affinity dominates when present — "I engage this person" is a far
    stronger statement than "I engage this tag". Topic affinity is the fallback
    so a viewer's interests still carry into authors they have never read, which
    is what makes the channel work for discovery rather than only for repeats.

    ``None`` means "no opinion", and the caller must treat it as such: the
    quality percentile carries the full organic weight rather than a zero being
    blended in, which would silently demote everything the viewer has not
    already engaged.
    """
    if post.author in author_pct:
        return author_pct[post.author]
    keys = [k for k in (post.community, post.category, *post.tags) if k]
    scores = [topic_pct[k] for k in keys if k in topic_pct]
    if scores:
        return max(scores)
    # The viewer has affinity data but none of it touches this candidate: that is
    # an opinion (the bottom of their scale), not an absence. Returning None here
    # would let never-engaged content keep a full quality score while engaged
    # content is merely blended, which inverts the intent.
    return 0.0 if (author_pct or topic_pct) else None


def viewer_topic_affinity(
    viewer_account: str,
    edges: Sequence[EngagementEdge],
    weights: RealGraphWeights,
    now: datetime,
    author_topics: Mapping[str, Sequence[str]],
    per_author: Mapping[str, float] | None = None,
) -> dict[str, float]:
    """Decayed viewer engagement attributed to topics, via the authors engaged.

    ``author_topics`` maps an author to the topic keys their window posts carry.
    Engagement is spread evenly across an author's topics rather than counted
    once per topic, so a prolific multi-topic author cannot dominate the
    viewer's topic profile purely by breadth.

    ★ ``per_author`` (2026-08-24) — PASS THE CALLER'S ALREADY-COMPUTED MAP.
    This function used to ALWAYS recompute ``viewer_author_affinity`` here, a
    full linear scan of the snapshot's entire edge list. Its only production
    caller (``pipeline._viewer_affinity_lookup``) computes that exact map, with
    these exact four arguments, immediately before calling this — so every feed
    build scanned the edge list TWICE for one identical result. Measured on the
    live container: **79 ms per scan at 2,618,664 edges**, and ``_score`` runs
    at up to four sites per build, so the duplicate cost was ~80-320 ms of
    GIL-serialised CPU per feed.

    Omitting the argument preserves the old behaviour exactly, so no existing
    caller changes meaning.

    ★ CORRECTED 2026-08-24 — this paragraph used to end "supplying it is a pure
    computation reuse and CANNOT alter the result, because the map passed in is
    by construction the map this line would have rebuilt." **That is false as
    wired.** The production caller (`pipeline._viewer_affinity_lookup`) subtracts
    banned and muted authors from the map BEFORE passing it, so topic affinity
    now also excludes their topics. That is deliberate and desirable — engaging
    a muted author should not leak their topics onto other authors — but it IS a
    behaviour change, and the two files must not contradict each other about it.
    The equivalence claim holds only for a caller that passes the unmodified map.
    """
    if per_author is None:
        per_author = viewer_author_affinity(viewer_account, edges, weights, now)
    out: dict[str, float] = {}
    for author, w in per_author.items():
        topics = [t for t in author_topics.get(author, ()) if t]
        if not topics:
            continue
        share = w / len(topics)
        for topic in topics:
            out[topic] = out.get(topic, 0.0) + share
    return out


def blend(quality_pct: float, viewer_pct: float | None, viewer_weight: float) -> float:
    """Blend the viewer-own percentile into the quality percentile.

    Kept as a named function so the invariant is testable in one place: with
    ``viewer_pct is None`` or ``viewer_weight == 0`` the result is EXACTLY the
    quality percentile, so a viewer with no history and a deployment with the
    channel switched off both reproduce the previous behaviour bit-for-bit.
    """
    if viewer_pct is None or viewer_weight <= 0.0:
        return quality_pct
    w = min(max(viewer_weight, 0.0), 1.0)
    return (1.0 - w) * quality_pct + w * viewer_pct


__all__ = [
    "affinity_percentiles",
    "blend",
    "candidate_affinity",
    "viewer_author_affinity",
    "viewer_topic_affinity",
]
