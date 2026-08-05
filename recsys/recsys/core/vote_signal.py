"""Independent engagement signals (§4, §6, §8.4).

Two computations live here:

* :func:`independent_vote_signal` — raw stake weight discounted for
  exclusion, then rewarded for the breadth of distinct independent voters.
* :func:`independent_organic_engagement` — the engagement term of the
  organic signal (§6), computed from ATTRIBUTED identity only: distinct
  independent voters, distinct independent commenters, and distinct
  independent rebloggers, all filtered through the same exclusion set
  (author / stake-lineage / ring, §8.4).

Commenter and reblogger identity is on-chain (HAFSQL
``operation_comment_view.author`` and ``reblogs.account_name``);
:class:`AttributedPost` is the contract that carries it, and
``recsys.io.hafsql`` hydrates it per post. The bare ``Post.children`` /
``Post.reblog_count`` counters are display metadata only — they are never
scored, because a count with no identity cannot be exclusion-filtered and is
therefore self-farmable for free. (The previous design capped those counts
per independent voter instead of attributing them; the cap was defeated by
1-3 sock-puppet upvotes and mis-billed ~9% of honest posts. Attribution is
the fix, not a tighter cap.)
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from recsys.config import DEFAULT_SETTINGS, ScoreWeights, VoteSignalConfig
from recsys.contracts import Post, VoteExclusions
from recsys.core.normalize import log_compress

# Default unknown-voter breadth budget (§4/§8.4, funded-alt hardening 2026-07-22).
# See :class:`VoterTrust`. DERIVED from ``recsys.config.VoteSignalConfig`` so the
# dataclass default and the configured runtime value can never diverge: previously
# these were hard-coded 2.0 while ``VoteSignalConfig.unknown_free`` was 1.0 (its
# documented tightest-correct newcomer floor), so any bare ``VoterTrust(vouched=...)``
# silently ran a looser 2.0 budget than the pipeline threads. config.py is the single
# source of truth; these mirror it structurally.
_VOTE_SIGNAL_DEFAULTS = VoteSignalConfig()
_DEFAULT_UNKNOWN_FREE = _VOTE_SIGNAL_DEFAULTS.unknown_free
_DEFAULT_UNKNOWN_PER_VOUCHED = _VOTE_SIGNAL_DEFAULTS.unknown_per_vouched

# Organic-engagement weights (§6). Votes are weighted low here because their
# magnitude is already the 10% vote bucket's job (avoid double-counting).
# All three weights now multiply DISTINCT INDEPENDENT PEOPLE, never raw event
# counts: one person commenting ten times is one commenter, exactly as one
# voter voting twice is one voter in the vote signal's breadth term.
# ★ Moved to `ScoreWeights.organic_{voter,reply,reblog}_breadth` (2026-08-01) so
# they can be swept and rolled back without a code edit — see that config block
# for the measured contradiction between this layer's view of a comment and the
# trust layer's. The names are kept here only as the documented defaults; nothing
# reads them.
_ORGANIC_VOTER_WEIGHT = 0.5
_ORGANIC_REBLOG_WEIGHT = 0.5
_ORGANIC_REPLY_WEIGHT = 0.3
# A vote whose |rshares| sits at or below log_compress's floor (== the §4
# NormConfig.rshares_floor default) registers zero stake-weight on the vote
# signal; such chain-dust votes carry no organic breadth either, so a
# zero-stake throwaway's vote mints nothing. Any real vote from even a ~1 HP
# account (~5e8 rshares) clears this by orders of magnitude.
_ORGANIC_VOTER_MIN_RSHARES = 1e7


@dataclass(frozen=True)
class VoterTrust:
    """Graph-cred-weighted breadth control (§4/§8.4, funded-alt hardening).

    The breadth terms below reward the count of DISTINCT independent identities.
    Left un-weighted, that count is bought one-for-one by funded sock-puppet
    alts: each fresh account is a distinct identity, clears the chain-dust floor
    with ~0.5 HP, writes no delegation row (so stake-lineage misses it) and — as
    a one-directional ``alt -> author`` star — never forms the reciprocal edge
    ring detection needs. All three §8.4 exclusions therefore pass it through,
    and N alts buy N breadth. This bundle closes that by splitting identities
    into two tiers using the weekly graph-cred snapshot:

    * **vouched** — accounts in ``vouched`` (graph-cred strictly above the
      engaged/unknown boundary, ``GraphCredConfig.min_vouched_score``): an
      account others have genuinely engaged. Each carries full breadth.
    * **unknown** — everyone else (graph-cred at exactly the unknown floor, or
      absent from the snapshot). A brand-new account with no received
      engagement lives here, and so does a funded alt. Their breadth is
      **budgeted**, not zeroed: a post's unknown identities contribute at most
      ``unknown_free + unknown_per_vouched * (vouched count)``.

    Why a budget and not a ban — THE newcomer invariant this project already
    broke once and undid: a genuine new user's first upvote MUST still count.
    ``unknown_free >= 1`` guarantees at least that many unknown identities are
    always credited, so a post carrying only newcomer votes (a new author in a
    fresh community) still earns breadth for the first ``unknown_free`` of them.
    A funded-alt swarm hits the same ceiling — 10 bare alts buy ``unknown_free``
    breadth, not 10 — because with no vouched voter the budget never grows.
    ``unknown_per_vouched`` lets a genuinely popular post (many vouched voters)
    absorb proportionally more real newcomers without penalty; it does nothing
    for the bare-alt attack (zero vouched → budget is exactly ``unknown_free``).

    ``vouched`` is derived once per request by the pipeline from
    ``TrustSnapshot.graph_creds``; ``None`` trust (the default everywhere) means
    "no snapshot, credit every identity in full" — the pre-2026-07-22 behaviour,
    which is what the frozen §4 norm sample is built on.
    """

    vouched: frozenset[str]
    unknown_free: float = _DEFAULT_UNKNOWN_FREE
    unknown_per_vouched: float = _DEFAULT_UNKNOWN_PER_VOUCHED

    def credited_breadth(self, identities: frozenset[str]) -> float:
        """Breadth credit for a set of distinct, already-exclusion-filtered
        identities: every vouched one in full, plus unknowns up to the budget.

        Monotone non-decreasing in the identity set (adding an identity never
        lowers the credit), so the breadth terms keep their "more independent
        people never hurts" guarantee for honest posts.
        """
        vouched_n = len(identities & self.vouched)
        unknown_n = len(identities) - vouched_n
        budget = self.unknown_free + self.unknown_per_vouched * vouched_n
        return vouched_n + min(float(unknown_n), budget)


@dataclass(frozen=True)
class AttributedPost(Post):
    """A :class:`Post` carrying per-account engagement attribution (§6).

    ``commenters`` / ``rebloggers`` are the distinct account names behind
    ``children`` / ``reblog_count``. Constructed by ``recsys.io.hafsql``
    (identity is aggregated per account in SQL, so hydration cost is one
    grouped query each — no per-event rows). Defined beside the computation
    that consumes it because ``contracts.py`` is owned by another workstream
    this phase; it subclasses :class:`Post`, so every existing consumer of
    ``Post`` handles it unchanged.

    A plain :class:`Post` (no attribution) scores zero comment/reblog
    engagement by design — counts without identity are untrusted input, and
    absence of data must degrade toward silence, never toward free credit.
    """

    commenters: tuple[str, ...] = ()
    rebloggers: tuple[str, ...] = ()
    #: ★★★ ROUND-4 COUNCIL (Seat 1) — LITE rebloggers, kept SEPARATE from
    #: `rebloggers` rather than merged into it.
    #:
    #: The lite-vote fix carried a `Vote.lite` flag, so every consumer could
    #: filter it. Lite REBLOGGERS were merged into the plain tuple as bare
    #: names, with nothing to filter on — so the need bands counted them at full
    #: value and the round-3 headline reproduced byte-for-byte on the other half
    #: of the same feature: **3 lite reblogs took a debut from rank 13 seen by
    #: 3 viewers to rank 33 seen by 0**, and one free lite reblog bought a sock
    #: 93% of the new-writer lane.
    #:
    #: Separate field, same rule as votes: counted as PEOPLE for organic breadth
    #: (bounded by `unknown_free`, since a lite identity is unknown), and
    #: invisible to the need bands, which decide who is "unheard" and must never
    #: move on engagement that costs nothing.
    lite_rebloggers: tuple[str, ...] = ()


def independent_vote_signal(
    post: Post, exclusions: VoteExclusions, *, trust: VoterTrust | None = None
) -> float:
    """Breadth-weighted independent vote signal (§4, §8.4).

    Keeps only positive-``rshares`` votes whose voter is not in
    ``exclusions.excluded()`` (self-vote, stake-lineage, ring). Rewards the
    number of distinct kept voters on top of raw log-compressed magnitude, so
    many small independent voters outrank one large non-independent stake.
    Returns ``0.0`` when no votes survive the exclusion.

    ``trust`` graph-cred-weights the breadth term (:class:`VoterTrust`): funded
    sock-puppet alts are distinct voters that slip all three exclusions, so an
    un-weighted distinct-voter count is bought one-for-one. With ``trust``, the
    breadth is ``vouched + budgeted(unknown)`` instead of the raw distinct
    count. ``None`` (default) is the pre-hardening raw count — the behaviour the
    frozen §4 norm sample is built on. The stake magnitude (``raw``) is
    untouched: a real 0.5 HP vote still contributes its real, log-compressed
    rshares; only the *breadth multiplier*, the Sybil lever, is budgeted.
    """
    excluded = exclusions.excluded()
    # ★★★ L2 (2026-08-05) — LITE VOTES ARE EXCLUDED FROM THIS TERM ENTIRELY, in
    # both halves, and the reason is the shape of the formula rather than a
    # policy preference. The return is
    # `log_compress(raw) * (1 + log10(1 + breadth))`: breadth MULTIPLIES stake
    # magnitude. A lite vote carries no rshares, so admitting it for breadth
    # alone would let free accounts AMPLIFY a whale's stake-weighted vote —
    # strictly worse than letting them add their own, and the exact inversion of
    # what this project exists to prevent.
    #
    # This is the §4 stake signal; it stays purely about stake. Lite voters are
    # counted as people in the ORGANIC breadth term below
    # (`organic_attributed_breadth`), which is where "how many distinct humans
    # engaged" belongs and where the `unknown_free` budget already bounds them.
    kept = [
        vote
        for vote in post.votes
        if vote.rshares > 0 and not vote.lite and vote.voter not in excluded
    ]
    if not kept:
        return 0.0
    raw = sum(vote.rshares for vote in kept)
    voters = frozenset(vote.voter for vote in kept)
    breadth = len(voters) if trust is None else trust.credited_breadth(voters)
    return log_compress(raw) * (1.0 + math.log10(1 + breadth))


class AttributionMissingError(TypeError):
    """A plain :class:`Post` reached attributed scoring where an
    :class:`AttributedPost` was required (§6). Raised only when
    ``require_attribution`` is set, so a data-plumbing failure that dropped
    commenter/reblogger identity surfaces LOUDLY instead of masquerading as a
    post with a genuinely low (zero) comment/reblog signal. An
    ``AttributedPost`` with empty ``commenters``/``rebloggers`` is NOT an error
    — that is a real observation of a post nobody discussed, and it scores its
    honest zero."""


def independent_organic_engagement(
    post: Post,
    excluded: frozenset[str],
    *,
    trust: VoterTrust | None = None,
    require_attribution: bool = False,
    weights: ScoreWeights | None = None,
) -> float:
    """Attributed independent-engagement term of the organic signal (§6).

    Three breadth counts, each of DISTINCT accounts with ``excluded``
    (author + stake-lineage + ring members, §8.4) removed — comments and
    reblogs pass through exactly the same identity filter votes always did:

    * **voters** — positive ``rshares`` above the chain-dust floor
      (``_ORGANIC_VOTER_MIN_RSHARES``): a vote too small to register any
      stake-weight on the vote signal vouches no organic breadth either;
    * **commenters** — ``AttributedPost.commenters`` minus ``excluded``, so a
      self-comment, a lineage alt's comment, or a ring member's comment
      counts for nothing regardless of volume;
    * **rebloggers** — ``AttributedPost.rebloggers``, same filter.

    Weighted sum: ``0.5*voters + 0.3*commenters + 0.5*rebloggers``.

    What this buys over the retired per-voter cap: there is no unattributed
    credit left to unlock, so sock-puppet upvotes no longer convert farmed
    comment/reblog counts into score — each additional non-excluded identity
    buys one bounded increment, making the attack cost linear in distinct
    on-chain accounts (each of which is visible evidence for ring/lineage
    detection) instead of constant. And an honestly-discussed post with many
    real commenters and few voters receives full credit for every distinct
    commenter — there is no cap to bind on honest content.

    A plain :class:`Post` without attribution contributes zero comment and
    reblog breadth: ``children`` / ``reblog_count`` are never scored. When
    ``require_attribution`` is set, that same plain post instead raises
    :class:`AttributionMissingError` — in production every scored post is
    hydrated as an :class:`AttributedPost`, so a bare :class:`Post` there is a
    dropped-identity plumbing failure that must fail loud, not degrade to a
    quiet low score.

    ``trust`` graph-cred-weights each breadth count (:class:`VoterTrust`): the
    per-channel credit is ``vouched + budgeted(unknown)`` rather than the raw
    distinct count, so funded alts (all in the unknown tier) cannot buy breadth
    one-for-one. ``None`` (default) is the raw count the frozen §4 norm sample
    is built on. Applied per channel so the three weights (0.5 / 0.3 / 0.5)
    still apply to distinct people; a single alt doing all three actions still
    only ever fills each channel's unknown budget, never mints unbounded credit.
    """
    if require_attribution and not isinstance(post, AttributedPost):
        raise AttributionMissingError(
            f"{post.key}: engagement attribution is missing (plain Post, not "
            "AttributedPost). Comment/reblog identity was never hydrated — a "
            "data-plumbing failure, not a low-engagement post. Refusing to "
            "score it as a silent zero."
        )
    # ★★★ L2 (2026-08-05) — a LITE vote counts as a distinct person here even
    # though it carries no rshares. The dust floor exists to drop votes too
    # small to mean anything on a STAKE-weighted signal; a lite vote is not a
    # dust vote, it is a real person with no chain stake at all, and this term
    # measures people rather than stake. Excluded from the §4 stake term above,
    # counted here — and only ever as an UNKNOWN identity, so
    # `trust.credited_breadth` applies the budget below. ★★ It is
    # `unknown_free + unknown_per_vouched * (vouched engagers)` — NOT a flat
    # 1.0. 50 lite accounts buy one unit only when no vouched engager is on the
    # post; with vouched engagers the budget grows (measured 31.0 at 10 vouched,
    # 300.0 with a follow graph). Stated conditionally because the unconditional
    # version was disproved and then repeated for two more rounds.
    voters = frozenset(
        vote.voter
        for vote in post.votes
        if ((vote.lite and vote.rshares >= 0) or vote.rshares > _ORGANIC_VOTER_MIN_RSHARES)
        # ★ ROUND-3 COUNCIL (Seat 2): `vote.lite` alone admitted a lite
        # DOWNVOTE as positive breadth. The reader filters `weight > 0` in SQL
        # so it cannot produce one today — but the identical producer-bug guard
        # was already considered necessary on the stake side, and leaving the
        # organic side unguarded is the asymmetry that gets found later.
        # Downvotes never affect ranking (`Vote`, rev 2.1).
        and vote.voter not in excluded
    )
    commenters: frozenset[str] = frozenset()
    rebloggers: frozenset[str] = frozenset()
    if isinstance(post, AttributedPost):
        commenters = frozenset(post.commenters) - excluded
        # Lite rebloggers count as people here — the same treatment a lite VOTE
        # gets — and land in the unknown tier, so `credited_breadth` budgets
        # them. They are excluded from the need bands, not from merit.
        rebloggers = frozenset(post.rebloggers) | frozenset(post.lite_rebloggers)
        rebloggers -= excluded
    if trust is None:
        voter_breadth: float = len(voters)
        commenter_breadth: float = len(commenters)
        reblogger_breadth: float = len(rebloggers)
    else:
        voter_breadth = trust.credited_breadth(voters)
        commenter_breadth = trust.credited_breadth(commenters)
        reblogger_breadth = trust.credited_breadth(rebloggers)
    # `None` means "the shipped weights", so every existing caller — including
    # the frozen harness — keeps the exact value the §4 norm sample is built on.
    w = weights if weights is not None else DEFAULT_SETTINGS.weights
    return (
        w.organic_voter_breadth * voter_breadth
        + w.organic_reply_breadth * commenter_breadth
        + w.organic_reblog_breadth * reblogger_breadth
    )
