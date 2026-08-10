"""Second-degree eligibility gate for out-of-network candidates
(§8.1, §8.2, §8.3, §8.7).

Pure filtering logic. Callers supply the engager index and graph-cred lookups
so this module stays free of any I/O; imports nothing but ``recsys.contracts``
and ``recsys.config``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import replace

from recsys.config import PopularConfig, Thresholds
from recsys.contracts import Candidate, CandidateSource, GraphCred, Post, ViewerProfile
from recsys.core.banned import is_banned
from recsys.core.popular import is_container_post


def passes_second_degree(
    candidate: Candidate, in_network_engagers: frozenset[str], min_engagers: int = 1
) -> bool:
    """Second-degree gate (§8.1): only un-opted-in OON discovery sources
    (``OON_ENGAGED`` / ``OON_ALS``) need enough in-network engagers; in-network
    and the viewer-chosen interest lane are exempt.

    ``in_network_engagers`` should already be vouch-quality filtered (see
    :func:`qualifying_engagers`) by the caller — this function just counts.
    """
    if not candidate.source.requires_second_degree:
        return True
    return len(in_network_engagers) >= min_engagers


def qualifying_engagers(
    in_network_engagers: frozenset[str],
    graph_creds: Mapping[str, GraphCred],
    vouch_graph_cred_floor: float,
) -> frozenset[str]:
    """Vouch-quality filter (§8.2): an in-network engager only counts as a
    vouch for the second-degree gate if its *own* graph-cred clears the vouch
    floor — a caught self-dealer can't vouch for a stranger.

    What this drops is exactly graph-cred's ``0.0`` band, and that band is
    reserved for positive evidence of self-dealing (every unit of engagement
    received came from the account's own lineage or detected ring). It is NOT
    "low standing": an account nobody has engaged yet — including every pure
    consumer, which on Hive is most accounts — scores
    ``GraphCredConfig.min_vouched_score`` (0.10) and vouches normally. An
    earlier revision scored those never-engaged accounts 0.0 and so silently
    disqualified 35 of 180 accounts (19.4%) in the measured population from
    ever vouching, buying nothing: the same population produced ZERO extra
    dropped candidates.

    Do not read this filter as Sybil resistance. It is worth precisely as much
    as ring/lineage detection: an alt whose engagement with its owner stays
    lopsided enough to miss the reciprocity test (measured: one upvote in plus
    one reply back) keeps clean received engagement and vouches like anyone
    else. The gate that actually stops that attack is the vouch COUNT in
    :func:`passes_second_degree` — the engager must be someone the viewer
    already follows.

    If ``graph_creds`` is empty (no data yet, Phase 0) this falls back to
    count-only: every in-network engager counts, matching pre-§8.2 behavior.
    """
    if not graph_creds:
        return in_network_engagers
    return frozenset(
        account
        for account in in_network_engagers
        if (cred := graph_creds.get(account)) is not None
        and cred.score >= vouch_graph_cred_floor
    )


def _ungated_lane_for(post: Post, viewer: ViewerProfile) -> CandidateSource | None:
    """The ungated, viewer-OPTED-IN lane this post already qualifies for, or
    ``None``. Used to demote a candidate whose second-degree vouch failed rather
    than dropping it — see the note in :func:`filter_eligible`.

    Admits nothing new: the branch requires an explicit act by the viewer
    (declaring an interest tag), and the returned lane still carries
    ``requires_author_floor``, so the author credibility check downstream is
    unchanged.

    ★ FULL TAG INTERSECTION, deliberately (ruling R3, 2026-08-04) — unlike
    ``exploration._interest_match``'s primary-tag-only test. This lane keeps
    ``requires_author_floor=True``, so tag-spray buys an attacker nothing here
    without also clearing the author's graph-cred floor; the exploration lane
    has no such backstop (it bypasses both the vouch gate and the author
    floor), which is why it gets the stricter test instead.
    """
    if viewer.interest_tags and set(post.tags) & viewer.interest_tags:
        return CandidateSource.OON_INTEREST
    return None


def filter_eligible(
    candidates: Iterable[Candidate],
    viewer: ViewerProfile,
    engager_index: Mapping[str, frozenset[str]],
    graph_creds: Mapping[str, GraphCred],
    thresholds: Thresholds,
    *,
    suppressed: frozenset[str] = frozenset(),
    show_nsfw: bool = False,
    popular: PopularConfig | None = None,
    lite_publishers: frozenset[str] = frozenset(),
) -> list[Candidate]:
    """Apply suppression, NSFW, mute, the second-degree gate (§8.1, §8.2), and
    the author graph-cred floor (§8.3) to a candidate pool.

    Suppression (§8.7), the NSFW preference, and the viewer's mute list apply to
    every candidate, regardless of source — a mute is a hard user preference and
    must drop a muted author even from an in-network candidate (see the loop
    below: the mute check sits OUTSIDE the ``requires_second_degree`` block). Only
    the second-degree gate and the author graph-cred floor apply solely to gated
    sources — in-network and viewer-opted-in (interest) candidates are exempt
    from those two (``source.requires_second_degree``).
    Missing graph-cred data never drops a candidate (Phase 0): both the vouch
    floor and the author floor fall back to permissive behavior when
    ``graph_creds`` is empty.

    An author absent from a *populated* ``graph_creds`` is likewise kept. That
    fail-open is no longer load-bearing, and that is the point: graph-cred's
    ``0.0`` band now means "caught self-dealing", so an author who is merely
    new scores ``min_vouched_score`` whether they are in the snapshot or not,
    and the one-vouch new-author on-ramp works the same either way. Previously
    the two disagreed — a newcomer who upvoted or commented on anyone before
    posting was in the snapshot at 0.0 and blocked here, while a newcomer who
    posted first was absent and passed — so participating first was punished.
    Measured on the harness with a weekly-batch snapshot taken before the
    debut vouch: the active newcomer reached 0/10 established viewers and the
    passive one 9/10; both now reach 9/10.
    """
    eligible: list[Candidate] = []
    for candidate in candidates:
        post = candidate.post
        if post.key in suppressed:
            continue
        if post.is_nsfw and not show_nsfw:
            continue
        if post.author in viewer.mutes:
            continue
        # ★ GLOBAL BAN (2026-08-08) — an operator blocklist, not a viewer
        # preference. It sits here, beside the mute check and OUTSIDE the
        # `requires_second_degree` block, for the same reason a mute does: a
        # ban that in-network or interest candidates could route around is not
        # a ban. See recsys/core/banned.py; the other half (their engagement
        # minting no breadth for anyone) is applied in `pipeline`.
        if is_banned(post.author):
            continue
        # ★★★ CONTAINER ROOTS ARE NEVER SHOWN, ANYWHERE (2026-08-09, owner:
        # "containers should not even be shown").
        #
        # A container is the rolling post other frontends file short-form
        # content INTO — `peak.snaps/snap-container-…`, `ecency.waves/waves-…`,
        # `leothreads/leothread-…` (InLeo), and our own `lumen-c-…`. As a post
        # it is an empty shell; its whole body is other people's comments. It
        # was found winning the popularity lane outright (112 commenters, the
        # most-discussed post on the chain that day), but the problem is not
        # lane-specific — it should not appear in ANY lane, so the exclusion
        # lives here with the ban and the mute rather than in `select_popular`.
        #
        # ★ WHAT IS DELIBERATELY *NOT* EXCLUDED: the posts INSIDE our own
        # containers. Every Lumen Lite post is a depth-1 comment under a
        # `lumen-c-…` root, so "hide anything inside a container" taken
        # literally would delete the entire lite product. Third-party container
        # children need no rule at all — `_top_level_or_lite` admits only
        # `parent_author = ''` OR our own lite posts, so a peak.snaps snap is
        # never sourced in the first place. Verified, not assumed.
        if popular is not None and is_container_post(post, popular, lite_publishers):
            continue
        # ★★ P1 (2026-08-05) — NEVER SHOW SOMEONE THEIR OWN POST IN DISCOVERY.
        #
        # There was no self-post exclusion anywhere in this path. Live-proven on
        # the real mirror by the 2026-08-05 council: `acidyo`'s own post ranked
        # **#1 in `acidyo`'s own discovery feed**.
        #
        # It is structural, not a fluke. `derive_interest_tags` reads an
        # account's OWN posting history, so a viewer's declared/derived tags are
        # by construction the tags they publish under; the interest lane then
        # sources posts by tag, so it sources theirs; and that lane is
        # viewer-opted-in, hence exempt from the second-degree gate. Every step
        # is working as intended and the composition is a bug.
        #
        # Placed with the mute check — OUTSIDE the `requires_second_degree`
        # block — because it must hold for EVERY source. A discovery feed
        # showing you your own writing is wrong whether it arrived via the
        # interest lane, popular padding, or someone you follow reblogging you.
        #
        # Comparison is on the RANKED identity, which is what `viewer.account`
        # also is: for a lite post `post.author` is the lite writer, not the
        # shared publisher account (see `LiteConfig`), so this works for both
        # tiers without special-casing.
        if post.author == viewer.account:
            continue
        if candidate.source.requires_second_degree:
            engagers = engager_index.get(post.key, frozenset()) & viewer.follows
            engagers = qualifying_engagers(engagers, graph_creds, thresholds.vouch_graph_cred_floor)
            if not passes_second_degree(candidate, engagers, thresholds.second_degree_min_engagers):
                # ★ DEMOTE, DO NOT DROP (2026-08-04). This was `continue`, and
                # that made ENGAGEMENT ITSELF A WEAPON.
                #
                # `merge_candidates` labels a post by its HIGHEST-priority source,
                # and OON_ENGAGED (1) outranks OON_INTEREST (3). So a post matching
                # a viewer's declared interest tag arrives ungated and is served —
                # until somebody the viewer follows engages it, at which point it
                # is re-labelled OON_ENGAGED, becomes gated, fails the vouch on the
                # ENGAGER's credibility, and is dropped. It was never re-tested
                # against the ungated lane it had already qualified for. (Measured
                # originally through the now-retired OON_COMMUNITY lane — subscribed
                # community, priority 2 — communities were removed as a lane
                # 2026-08-04, R1/R3; the mechanism and the numbers below are
                # unchanged for its OON_INTEREST successor.)
                #
                # Measured: one condemned account that any viewer follows, one
                # upvote, and an honest author goes from 10/10 opted-in viewers to
                # 0/10 — on ANY author, with no ring shape, no zero-audience
                # precondition, and the target never flagged. That is cheaper and
                # broader than the known rival-suppression bug, and the
                # suppression machinery is itself the weapon.
                #
                # The fix restores the lane the post already qualified for rather
                # than admitting anything new: the viewer must still have opted in
                # (declared the interest tag), and the demoted lane still carries
                # `requires_author_floor`, so a genuine self-dealing AUTHOR is
                # refused two lines below exactly as before. Only the vouch-COUNT
                # requirement — which this post never needed — is dropped.
                demoted = _ungated_lane_for(post, viewer)
                if demoted is None:
                    continue
                candidate = replace(candidate, source=demoted)
        # The author floor is a SEPARATE question from the vouch count (2026-08-01):
        # "has my network seen this" vs "is this author credible at all". A
        # discovery lane can reasonably skip the first while never skipping the
        # second — otherwise it either demands prior in-network engagement, which
        # new content cannot have, or it admits self-dealers.
        if candidate.source.requires_author_floor:
            cred = graph_creds.get(post.author)
            if cred is not None and cred.score < thresholds.graph_cred_floor:
                continue
        eligible.append(candidate)
    return eligible


__all__ = ["filter_eligible", "passes_second_degree", "qualifying_engagers"]
