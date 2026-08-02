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

from hashlib import blake2b

from recsys.config import DiversityConfig
from recsys.contracts import Post, ScoredCandidate


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


def _topic_affinities(scored: list[ScoredCandidate]) -> dict[str, float]:
    """Per-topic-key viewer affinity in ``[0, 1]``, inferred from the pool.

    Affinity = the key's share of the pool's TOTAL final-score mass (all
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
    """
    mass: dict[str, float] = {}
    for candidate in scored:
        key = _topic_key(candidate.post)
        mass[key] = mass.get(key, 0.0) + max(candidate.score.final, 0.0)
    total = sum(mass.values())
    if total <= 0.0:
        return dict.fromkeys(mass, 0.0)
    return {key: value / total for key, value in mass.items()}


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
) -> float:
    """Diversity-discounted score: author penalty times the interest-aware
    topic penalty (§3.4). The author penalty is never affinity-scaled."""
    return (
        candidate.score.final
        * _pen(author_placed, author_decay, author_floor)
        * _pen(
            topic_placed,
            _attenuate(topic_decay, topic_affinity),
            _attenuate(topic_floor, topic_affinity),
        )
    )



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
    tie_break_seed: str = "",
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
    """
    affinities = _topic_affinities(scored)
    # ★ Hoisted out of the selection loop (2026-08-01). `_tie_break` is a blake2b
    # digest and the loop below is O(n^2) — computing it per candidate per pass
    # hashed each post up to n times and measured 2.02x slower than the string
    # compare it replaced. It depends only on (seed, post.key), both loop
    # invariants, so one pass over the pool is exactly equivalent.
    tie_breaks = {sc.post.key: _tie_break(tie_break_seed, sc.post.key) for sc in scored}
    remaining = list(scored)
    author_counts: dict[str, int] = {}
    topic_counts: dict[str, int] = {}
    result: list[ScoredCandidate] = []
    while remaining:
        best_index = 0
        best_rank: tuple[float, str] | None = None
        for index, candidate in enumerate(remaining):
            author_placed = author_counts.get(candidate.post.author, 0)
            topic_key = _topic_key(candidate.post)
            topic_placed = topic_counts.get(topic_key, 0)
            effective = _effective_score(
                candidate,
                author_placed,
                topic_placed,
                author_decay,
                author_floor,
                topic_decay,
                topic_floor,
                topic_affinity_strength * affinities.get(topic_key, 0.0),
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
        result.append(chosen)
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
) -> list[ScoredCandidate]:
    """Author + interest-aware topic diversity re-rank then truncate to
    ``diversity.top_k`` (§3.4)."""
    diversified = diversity_rerank(
        scored,
        author_decay=diversity.author_decay,
        author_floor=diversity.author_floor,
        topic_decay=diversity.topic_decay,
        topic_floor=diversity.topic_floor,
        topic_affinity_strength=diversity.topic_affinity_strength,
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
