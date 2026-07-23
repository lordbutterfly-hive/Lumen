"""Tests for the independent vote signal (§4, §8.4) and the ATTRIBUTED
organic engagement term (§6): distinct independent voters, commenters and
rebloggers, all filtered through the same exclusion set."""

from __future__ import annotations

import math
from dataclasses import replace

import pytest

from recsys.contracts import VoteExclusions
from recsys.core.normalize import log_compress
from recsys.core.vote_signal import (
    AttributedPost,
    AttributionMissingError,
    VoterTrust,
    independent_organic_engagement,
    independent_vote_signal,
)
from tests.fakes import make_post, make_vote


def make_attributed_post(
    *,
    commenters: tuple[str, ...] = (),
    rebloggers: tuple[str, ...] = (),
    comments_per_commenter: int = 1,
    **kwargs: object,
) -> AttributedPost:
    """An :class:`AttributedPost` whose display counters are derived from the
    attribution, mirroring how ``recsys.io.hafsql._build_post`` constructs it."""
    base = make_post(**kwargs)  # type: ignore[arg-type]
    return AttributedPost(
        **{
            **{f: getattr(base, f) for f in base.__dataclass_fields__},
            "children": len(commenters) * comments_per_commenter,
            "reblog_count": len(rebloggers),
        },
        commenters=commenters,
        rebloggers=rebloggers,
    )


def test_self_vote_excluded() -> None:
    post = make_post(author="alice", votes=[make_vote(voter="alice", rshares=5_000_000_000)])
    exclusions = VoteExclusions(author="alice")
    assert independent_vote_signal(post, exclusions) == 0.0


def test_lineage_excluded() -> None:
    post = make_post(author="alice", votes=[make_vote(voter="bob", rshares=5_000_000_000)])
    exclusions = VoteExclusions(author="alice", lineage=frozenset({"bob"}))
    assert independent_vote_signal(post, exclusions) == 0.0


def test_ring_excluded() -> None:
    post = make_post(author="alice", votes=[make_vote(voter="carol", rshares=5_000_000_000)])
    exclusions = VoteExclusions(author="alice", ring_members=frozenset({"carol"}))
    assert independent_vote_signal(post, exclusions) == 0.0


def test_downvotes_never_count() -> None:
    post = make_post(author="alice", votes=[make_vote(voter="bob", rshares=-5_000_000_000)])
    exclusions = VoteExclusions(author="alice")
    assert independent_vote_signal(post, exclusions) == 0.0


def test_empty_votes_is_zero() -> None:
    post = make_post(author="alice", votes=[])
    exclusions = VoteExclusions(author="alice")
    assert independent_vote_signal(post, exclusions) == 0.0


def test_all_kinds_of_exclusion_combined_is_zero() -> None:
    post = make_post(
        author="alice",
        votes=[
            make_vote(voter="alice", rshares=1_000_000_000),
            make_vote(voter="bob", rshares=2_000_000_000),
            make_vote(voter="carol", rshares=3_000_000_000),
        ],
    )
    exclusions = VoteExclusions(
        author="alice",
        lineage=frozenset({"bob"}),
        ring_members=frozenset({"carol"}),
    )
    assert independent_vote_signal(post, exclusions) == 0.0


def test_more_distinct_voters_beats_equal_raw_sum() -> None:
    exclusions = VoteExclusions(author="alice")
    narrow = make_post(
        author="alice",
        permlink="narrow",
        votes=[make_vote(voter="v1", rshares=2_000_000_000)],
    )
    wide = make_post(
        author="alice",
        permlink="wide",
        votes=[
            make_vote(voter="v1", rshares=1_000_000_000),
            make_vote(voter="v2", rshares=1_000_000_000),
        ],
    )
    assert independent_vote_signal(wide, exclusions) > independent_vote_signal(narrow, exclusions)


def test_matches_formula_exactly() -> None:
    post = make_post(
        author="alice",
        votes=[
            make_vote(voter="v1", rshares=6_000_000_000),
            make_vote(voter="v2", rshares=4_000_000_000),
        ],
    )
    exclusions = VoteExclusions(author="alice")
    expected = log_compress(10_000_000_000) * (1.0 + math.log10(1 + 2))
    assert math.isclose(independent_vote_signal(post, exclusions), expected)


def test_duplicate_voter_counts_once_toward_breadth() -> None:
    exclusions = VoteExclusions(author="alice")
    post = make_post(
        author="alice",
        votes=[
            make_vote(voter="v1", rshares=1_000_000_000, minutes=0),
            make_vote(voter="v1", rshares=1_000_000_000, minutes=1),
        ],
    )
    expected = log_compress(2_000_000_000) * (1.0 + math.log10(1 + 1))
    assert math.isclose(independent_vote_signal(post, exclusions), expected)


# ---------------------------------------------------------------------------
# independent_organic_engagement — attributed identity only (§6 rebuild).
#
# RULED-BEHAVIOR CHANGE (this fix round): the per-independent-voter cap on
# unattributed counts is RETIRED — it was defeated by 1-3 sock-puppet upvotes
# and clipped ~9% of honest posts. Comment/reblog engagement now counts ONLY
# via attributed distinct identity (AttributedPost.commenters/.rebloggers)
# passed through the same exclusion set as votes; the bare children /
# reblog_count counters are display metadata and never score. The two
# cap-formula tests below were UPDATED accordingly (not weakened: the new
# assertions are strictly harder on the attacker — farmed counts now buy
# zero, not "zero until a sock vote unlocks the cap").
# ---------------------------------------------------------------------------


def test_organic_engagement_self_farmed_counts_alone_are_worthless() -> None:
    # The q5b spam vector: 60 self-comments + 20 self-reblogs, zero votes.
    # Unattributed counters never score, and the attributed identities all
    # resolve to the excluded author.
    unattributed = make_post(author="spammer", children=60, reblog_count=20, votes=[])
    assert independent_organic_engagement(unattributed, frozenset({"spammer"})) == 0.0
    attributed = make_attributed_post(
        author="spammer",
        commenters=("spammer",),
        rebloggers=("spammer",),
        comments_per_commenter=60,
    )
    assert independent_organic_engagement(attributed, frozenset({"spammer"})) == 0.0


def test_organic_engagement_sock_votes_no_longer_unlock_farmed_counts() -> None:
    # THE defeat of the old cap: 1-3 sock-puppet upvotes used to restore the
    # farmed counts to full (bit-identical-to-pre-fix) strength. Now a sock
    # vote buys exactly its own 0.5 breadth unit — the farmed counters stay
    # worthless because there is no unattributed credit left to unlock.
    for socks in (1, 3, 10):
        votes = [make_vote(voter=f"sock{i}", rshares=500_000_000) for i in range(socks)]
        post = make_post(author="spammer", children=60, reblog_count=20, votes=votes)
        got = independent_organic_engagement(post, frozenset({"spammer"}))
        assert math.isclose(got, 0.5 * socks)


def test_organic_engagement_excluded_voters_do_not_count() -> None:
    # Self-votes, stake-lineage and ring votes are not "independent voters".
    post = make_post(
        author="spammer",
        children=60,
        reblog_count=20,
        votes=[
            make_vote(voter="spammer", rshares=1_000_000_000),
            make_vote(voter="puppet", rshares=1_000_000_000),
        ],
    )
    excluded = frozenset({"spammer", "puppet"})
    assert independent_organic_engagement(post, excluded) == 0.0


def test_organic_engagement_commenters_and_rebloggers_pass_vote_exclusions() -> None:
    # Comments and reblogs are filtered through the SAME exclusion set as
    # votes: author, stake-lineage and ring identities contribute nothing;
    # the independent identities count once each.
    post = make_attributed_post(
        author="alice",
        commenters=("alice", "lineage-alt", "ring-member", "honest-1", "honest-2"),
        rebloggers=("ring-member", "honest-1"),
    )
    excluded = frozenset({"alice", "lineage-alt", "ring-member"})
    got = independent_organic_engagement(post, excluded)
    assert math.isclose(got, 0.3 * 2 + 0.5 * 1)


def test_organic_engagement_many_commenters_few_voters_full_credit() -> None:
    # The old cap's 8.9% false-positive case: genuinely discussed post, many
    # real commenters, one voter. Attribution gives every distinct commenter
    # full credit — nothing binds.
    post = make_attributed_post(
        author="author",
        commenters=tuple(f"c{i}" for i in range(10)),
        comments_per_commenter=2,  # 20 comments total; multiplicity buys nothing
        votes=[make_vote(voter="v0", rshares=1_000_000_000)],
    )
    got = independent_organic_engagement(post, frozenset({"author"}))
    assert math.isclose(got, 0.5 * 1 + 0.3 * 10)


def test_organic_engagement_honest_popular_post_counts_every_identity() -> None:
    # A genuinely popular post: every distinct independent voter, commenter
    # and reblogger counts, weighted 0.5 / 0.3 / 0.5.
    voters = [make_vote(voter=f"v{i}", rshares=1_000_000_000) for i in range(20)]
    post = make_attributed_post(
        author="author",
        commenters=tuple(f"c{i}" for i in range(8)),
        rebloggers=tuple(f"r{i}" for i in range(5)),
        votes=voters,
    )
    got = independent_organic_engagement(post, frozenset({"author"}))
    assert math.isclose(got, 0.5 * 20 + 0.3 * 8 + 0.5 * 5)


def test_organic_engagement_duplicate_commenter_counts_once() -> None:
    # One person commenting many times is ONE commenter — same principle as
    # the vote signal's distinct-voter breadth.
    once = make_attributed_post(author="a", commenters=("bob",), comments_per_commenter=1)
    sixty = make_attributed_post(author="a", commenters=("bob",), comments_per_commenter=60)
    assert independent_organic_engagement(once, frozenset({"a"})) == (
        independent_organic_engagement(sixty, frozenset({"a"}))
    )


def test_organic_engagement_chain_dust_votes_carry_no_breadth() -> None:
    # A vote below the log-compress floor (1e7 rshares) registers zero stake
    # weight on the vote signal; it vouches no organic breadth either, so a
    # zero-stake throwaway's vote mints nothing.
    post = make_post(author="a", votes=[make_vote(voter="dust", rshares=1_000_000)])
    assert independent_organic_engagement(post, frozenset({"a"})) == 0.0
    real = make_post(author="a", votes=[make_vote(voter="one-hp", rshares=500_000_000)])
    assert independent_organic_engagement(real, frozenset({"a"})) == 0.5


def test_organic_engagement_downvotes_do_not_vouch() -> None:
    post = make_post(
        author="spammer",
        children=60,
        reblog_count=20,
        votes=[make_vote(voter="critic", rshares=-1_000_000_000)],
    )
    assert independent_organic_engagement(post, frozenset({"spammer"})) == 0.0


def test_organic_engagement_monotonic_in_independent_breadth() -> None:
    # More distinct independent voters never lowers the engagement term.
    post_counts = {"children": 60, "reblog_count": 20}
    prev = -1.0
    for n in range(0, 12):
        voters = [make_vote(voter=f"v{i}", rshares=1_000_000_000) for i in range(n)]
        post = make_post(author="author", votes=voters, **post_counts)
        got = independent_organic_engagement(post, frozenset({"author"}))
        assert got > prev
        prev = got


def test_organic_engagement_plain_post_counts_are_display_only() -> None:
    # A Post without attribution scores zero comment/reblog engagement no
    # matter what its counters claim: counts without identity cannot be
    # exclusion-filtered, so they are untrusted input.
    plain = make_post(author="a", children=500, reblog_count=200, votes=[])
    assert independent_organic_engagement(plain, frozenset({"a"})) == 0.0


def test_attributed_post_is_a_post() -> None:
    # AttributedPost must flow through every Post consumer unchanged.
    post = make_attributed_post(author="alice", commenters=("bob",))
    assert post.key == "@alice/p1"
    assert replace(post, permlink="p2").key == "@alice/p2"


# ---------------------------------------------------------------------------
# VoterTrust — graph-cred-weighted breadth budget (§8.4 funded-alt hardening).
#
# The breadth terms reward the count of DISTINCT independent identities. Funded
# sock-puppet alts are distinct accounts that slip self / stake-lineage / ring
# exclusion, so an un-weighted count is bought one-for-one. VoterTrust splits
# identities into vouched (graph-cred above the engaged/unknown boundary) and
# unknown (a funded alt OR a genuine newcomer), and budgets the unknown tier.
# ---------------------------------------------------------------------------


FREE = 1.0  # matches VoteSignalConfig.unknown_free default (the newcomer floor)
SLOPE = 2.0  # matches VoteSignalConfig.unknown_per_vouched default


def _trust(*vouched: str, free: float = FREE, slope: float = SLOPE) -> VoterTrust:
    return VoterTrust(vouched=frozenset(vouched), unknown_free=free, unknown_per_vouched=slope)


def test_credited_breadth_all_vouched_is_full_count() -> None:
    # Every identity is genuinely engaged -> no budget binds, full breadth.
    trust = _trust("a", "b", "c")
    assert trust.credited_breadth(frozenset({"a", "b", "c"})) == 3.0


def test_credited_breadth_bare_alts_are_capped_at_unknown_free() -> None:
    # THE funded-alt fix: 3 vs 10 vs 20 all-unknown identities credit the SAME
    # unknown_free budget, because with no vouched voter the budget never grows.
    trust = _trust()  # nobody vouched
    for n in (3, 10, 20):
        alts = frozenset(f"alt{i}" for i in range(n))
        assert trust.credited_breadth(alts) == FREE  # not n — alt count buys nothing


def test_credited_breadth_newcomer_first_vote_counts() -> None:
    # THE newcomer invariant: a single unknown newcomer's vote is credited in
    # full (>= 1 by unknown_free), never zeroed.
    trust = _trust()
    assert trust.credited_breadth(frozenset({"newcomer"})) == 1.0


def test_credited_breadth_vouched_expand_the_unknown_budget() -> None:
    # A genuinely popular post (vouched voters) absorbs proportionally more real
    # newcomers: budget = unknown_free + slope * vouched_count.
    trust = _trust("v1", "v2")  # 2 vouched
    ids = frozenset({"v1", "v2"} | {f"new{i}" for i in range(10)})
    # vouched 2 + min(10 unknown, 1 + 2*2 = 5) = 2 + 5 = 7
    assert trust.credited_breadth(ids) == 7.0


def test_credited_breadth_is_monotonic() -> None:
    # Adding an identity never lowers the credit (honest "more people never
    # hurts" guarantee survives the budget).
    trust = _trust("v1")
    prev = -1.0
    ids: set[str] = set()
    for i in range(8):
        ids.add(f"x{i}")
        got = trust.credited_breadth(frozenset(ids) | {"v1"})
        assert got >= prev
        prev = got


def test_organic_engagement_trust_budgets_funded_alt_swarm() -> None:
    # 10 funded alts, each doing vote+comment+reblog, all in the unknown tier.
    # Per channel the credit is capped at unknown_free, so the whole swarm buys
    # (0.5 + 0.3 + 0.5) * unknown_free, NOT (0.5+0.3+0.5)*10.
    alts = tuple(f"alt{i}" for i in range(10))
    post = make_attributed_post(
        author="spammer",
        commenters=alts,
        rebloggers=alts,
        votes=[make_vote(voter=a, rshares=500_000_000) for a in alts],  # 0.5 HP each
    )
    got = independent_organic_engagement(post, frozenset({"spammer"}), trust=_trust())
    assert got == pytest.approx((0.5 + 0.3 + 0.5) * FREE)
    # ... and 3 alts credit the SAME amount: the attack does not scale.
    alts3 = tuple(f"alt{i}" for i in range(3))
    post3 = make_attributed_post(
        author="spammer", commenters=alts3, rebloggers=alts3,
        votes=[make_vote(voter=a, rshares=500_000_000) for a in alts3],
    )
    assert independent_organic_engagement(post3, frozenset({"spammer"}), trust=_trust()) == got


def test_organic_engagement_trust_none_is_the_unweighted_count() -> None:
    # The frozen §4 norm sample is built with trust=None; it must be the exact
    # pre-hardening raw distinct count.
    alts = tuple(f"alt{i}" for i in range(10))
    post = make_attributed_post(
        author="spammer", commenters=alts, rebloggers=alts,
        votes=[make_vote(voter=a, rshares=500_000_000) for a in alts],
    )
    assert independent_organic_engagement(post, frozenset({"spammer"})) == pytest.approx(
        0.5 * 10 + 0.3 * 10 + 0.5 * 10
    )


def test_organic_engagement_trust_credits_vouched_voters_in_full() -> None:
    # A genuinely popular honest post: 12 vouched voters all count, no budget
    # binds — the fix does not punish real engagement.
    voters = [make_vote(voter=f"v{i}", rshares=1_000_000_000) for i in range(12)]
    post = make_post(author="author", votes=voters)
    trust = _trust(*[f"v{i}" for i in range(12)])
    assert independent_organic_engagement(post, frozenset({"author"}), trust=trust) == 0.5 * 12


def test_vote_signal_trust_caps_sockpuppet_breadth_multiplier() -> None:
    # The stake magnitude still counts (real 0.5 HP rshares), but the breadth
    # MULTIPLIER is budgeted: 10 unknown alts give the same breadth as free=1.
    alts = [make_vote(voter=f"alt{i}", rshares=500_000_000) for i in range(10)]
    post = make_post(author="spammer", votes=alts)
    excl = VoteExclusions(author="spammer")
    raw = sum(v.rshares for v in alts)
    trusted = independent_vote_signal(post, excl, trust=_trust())
    assert trusted == pytest.approx(log_compress(raw) * (1.0 + math.log10(1 + FREE)))
    # untrusted (norm-sample path) keeps the raw distinct-voter breadth of 10
    untrusted = independent_vote_signal(post, excl)
    assert untrusted == pytest.approx(log_compress(raw) * (1.0 + math.log10(1 + 10)))
    assert trusted < untrusted


# ---------------------------------------------------------------------------
# require_attribution — fail LOUD on a dropped-identity plumbing failure (§6).
# ---------------------------------------------------------------------------


def test_require_attribution_raises_on_plain_post() -> None:
    # In production every scored post is hydrated as an AttributedPost; a bare
    # Post reaching the organic term means comment/reblog identity was dropped —
    # a plumbing failure that must fail loud, not score a silent zero.
    plain = make_post(author="a", children=60, reblog_count=20, votes=[])
    with pytest.raises(AttributionMissingError, match="attribution is missing"):
        independent_organic_engagement(plain, frozenset({"a"}), require_attribution=True)


def test_require_attribution_allows_attributed_post_even_when_empty() -> None:
    # An AttributedPost with no commenters/rebloggers is a real "nobody
    # discussed this" observation, not a failure — it scores its honest zero.
    empty = make_attributed_post(author="a", commenters=(), rebloggers=())
    assert independent_organic_engagement(empty, frozenset({"a"}), require_attribution=True) == 0.0


def test_require_attribution_default_off_keeps_lenient_plain_post_behaviour() -> None:
    # Default (harness/unit fixtures pass plain Posts) is unchanged: plain Post
    # scores zero comment/reblog signal, no raise.
    plain = make_post(author="a", children=60, reblog_count=20, votes=[])
    assert independent_organic_engagement(plain, frozenset({"a"})) == 0.0
