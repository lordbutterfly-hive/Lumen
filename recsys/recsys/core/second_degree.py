"""Second-degree eligibility gate for out-of-network candidates
(§8.1, §8.2, §8.3, §8.7).

Pure filtering logic. Callers supply the engager index and graph-cred lookups
so this module stays free of any I/O; imports nothing but ``recsys.contracts``
and ``recsys.config``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from recsys.config import Thresholds
from recsys.contracts import Candidate, GraphCred, ViewerProfile


def passes_second_degree(
    candidate: Candidate, in_network_engagers: frozenset[str], min_engagers: int = 1
) -> bool:
    """Second-degree gate (§8.1): only un-opted-in OON discovery sources
    (``OON_ENGAGED`` / ``OON_ALS``) need enough in-network engagers; in-network
    and viewer-chosen community/interest lanes are exempt.

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


def filter_eligible(
    candidates: Iterable[Candidate],
    viewer: ViewerProfile,
    engager_index: Mapping[str, frozenset[str]],
    graph_creds: Mapping[str, GraphCred],
    thresholds: Thresholds,
    *,
    suppressed: frozenset[str] = frozenset(),
    show_nsfw: bool = False,
) -> list[Candidate]:
    """Apply suppression, NSFW, mute, the second-degree gate (§8.1, §8.2), and
    the author graph-cred floor (§8.3) to a candidate pool.

    Suppression (§8.7) and the NSFW preference apply to every candidate,
    regardless of source. The mute list, second-degree gate, and graph-cred
    floor apply only to gated sources — in-network and viewer-opted-in
    (community/interest) candidates are exempt (``source.requires_second_degree``).
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
        if candidate.source.requires_second_degree:
            engagers = engager_index.get(post.key, frozenset()) & viewer.follows
            engagers = qualifying_engagers(engagers, graph_creds, thresholds.vouch_graph_cred_floor)
            if not passes_second_degree(candidate, engagers, thresholds.second_degree_min_engagers):
                continue
            cred = graph_creds.get(post.author)
            if cred is not None and cred.score < thresholds.graph_cred_floor:
                continue
        eligible.append(candidate)
    return eligible


__all__ = ["filter_eligible", "passes_second_degree", "qualifying_engagers"]
