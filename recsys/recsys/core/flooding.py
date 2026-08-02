"""Post-frequency cap for out-of-network discovery (§8.8).

Even after the second-degree gate (§8.1) and graph-cred floor (§8.3), a single
prolific OON author can still flood a viewer's feed with many posts in one
pull. This module trims each *gated* OON author down to a maximum candidate
count, so one account can't dominate the pool. In-network and viewer-opted-in
(``INTEREST_*``) sources are exempt — the viewer explicitly follows or picked
those, so volume there is never "flooding".

Pure filtering logic; imports nothing but ``recsys.contracts``.
"""

from __future__ import annotations

from collections.abc import Iterable

from recsys.contracts import Candidate


def cap_oon_flooding(candidates: Iterable[Candidate], max_per_author: int) -> list[Candidate]:
    """Cap each gated-OON author (``source.requires_second_degree``) to at
    most ``max_per_author`` candidates (§8.8). IN_NETWORK and ``INTEREST_*``
    sources are exempt — unlimited regardless of author.

    Input order is preserved; for a capped author, the first ``max_per_author``
    occurrences (in input order) are kept and the rest dropped. Deterministic:
    depends only on the input sequence, never on tie-breaking or shuffling.
    """
    kept: list[Candidate] = []
    seen_per_author: dict[str, int] = {}
    for candidate in candidates:
        # ★ Keyed on `requires_author_floor`, NOT `requires_second_degree`
        # (2026-08-01). This asks "is this an out-of-network lane" — the whole
        # point of an OON post-frequency cap — and that is exactly the set
        # `requires_author_floor` names. `requires_second_degree` used to name
        # the same set, so keying on it was correct until it stopped being a
        # lane classifier and became a per-lane DISCOVERY POLICY switch: the
        # moment `OON_INTEREST` was exempted from the vouch count (to make the
        # follow-cliff fix work at all), it silently left this cap too, and one
        # account could place unlimited posts in an established viewer's feed
        # (measured: 60 of 103 slots). Same defect shape as the POPULAR_FALLBACK
        # label split — one property serving two unrelated purposes, so changing
        # it for one silently changed the other.
        if not candidate.source.requires_author_floor:
            kept.append(candidate)
            continue
        author = candidate.post.author
        count = seen_per_author.get(author, 0)
        if count >= max_per_author:
            continue
        seen_per_author[author] = count + 1
        kept.append(candidate)
    return kept


__all__ = ["cap_oon_flooding"]
