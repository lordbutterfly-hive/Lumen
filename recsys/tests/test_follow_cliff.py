"""The follow-cliff: a viewer's declared interests must survive their first follow.

MEASURED BEFORE THE FIX (council member A): a viewer who picked photography saw
20/20 on-interest posts in their top 20 while followless. After following ONE
account their candidate pool collapsed from 60 to 3, on-interest share went to
0/20, and 17 of the 20 slots were global-popularity padding emitted under an
INTEREST_TAG label — so the feed both lost the interests and lied about it.

CAUSE: `gather_candidates` appended the interest lane only `if not viewer.follows`
and the in-network lanes only `if viewer.follows`. Mutually exclusive.

FIX: the lane is unconditional; the follow graph changes the candidates' TRUST
CLASS (gate-exempt INTEREST_* while followless, gated OON_INTEREST once a graph
exists) rather than switching the lane off.
"""

from __future__ import annotations

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import CandidateSource, Post, ViewerProfile
from recsys.core.coldstart import established_interest_candidates, interest_candidates
from tests.fakes import EPOCH, make_post


def _post(author: str, permlink: str, community: str = "hive-photo") -> Post:
    """Reuse the shared factory so this test tracks Post's real shape."""
    return make_post(
        author=author,
        permlink=permlink,
        community=community,
        category="photography",
        tags=("photography",),
    )


class _Gateway:
    """Minimal gateway: serves the interest lane's two reads."""

    def __init__(self, posts: list[Post]) -> None:
        self._posts = posts

    def community_posts(self, communities, since, limit):
        return list(self._posts) if communities else []

    def tag_posts(self, tags, since, limit):
        return list(self._posts) if tags else []


def _viewer(follows: frozenset[str]) -> ViewerProfile:
    return ViewerProfile(
        account="newbie",
        follows=follows,
        interest_tags=frozenset({"photography"}),
        interest_communities=frozenset({"hive-photo"}),
    )


def test_interests_still_produce_candidates_after_the_first_follow() -> None:
    """The regression itself: one follow must not zero the interest lane."""
    posts = [_post(f"a{i}", f"p{i}") for i in range(60)]
    gateway = _Gateway(posts)

    followless = interest_candidates(
        _viewer(frozenset()), gateway, EPOCH, limit=100, cfg=DEFAULT_SETTINGS.cold_start
    )
    established = established_interest_candidates(
        _viewer(frozenset({"someone"})), gateway, EPOCH, limit=100
    )

    assert len(followless) == 60
    assert len(established) == 60, (
        "acquiring a follow must not discard the viewer's declared interests"
    )


def test_trust_class_changes_with_the_follow_graph_not_the_lane() -> None:
    """Followless -> gate-exempt. With a graph -> gated.

    This is what keeps the fix from widening the gate-exempt surface: an
    established viewer's interest content still has to clear the AUTHOR
    graph-cred floor, so self-dealers and ring members cannot ride the lane in.

    ★ It does NOT have to clear the second-degree VOUCH COUNT, and requiring it
    was the original fix's defect (measured 2026-08-01, see the end-to-end test
    below): that gate passes a post only if someone the viewer already follows
    engaged it, which is the exact predicate OON_ENGAGED selects on. New interest
    content from an author outside the viewer's network can never satisfy it, so
    the lane produced 60 candidates and 0 feed slots. "Is the author credible"
    and "has my network seen this" are different questions; only the first one
    belongs on a discovery lane.
    """
    posts = [_post("a", "p")]
    gateway = _Gateway(posts)

    cold = interest_candidates(
        _viewer(frozenset()), gateway, EPOCH, limit=10, cfg=DEFAULT_SETTINGS.cold_start
    )
    warm = established_interest_candidates(
        _viewer(frozenset({"someone"})), gateway, EPOCH, limit=10
    )

    assert all(c.source.requires_second_degree is False for c in cold)
    assert all(c.source.requires_author_floor is False for c in cold)
    assert all(c.source is CandidateSource.OON_INTEREST for c in warm)
    assert all(c.source.requires_second_degree is False for c in warm)
    assert all(c.source.requires_author_floor is True for c in warm), (
        "established interest content must still refuse low-cred authors"
    )


def test_a_viewer_with_no_interests_gets_nothing_from_either_lane() -> None:
    """Guard against the opposite failure: the lane must not invent candidates.

    An empty interest set means the viewer never picked anything, and both reads
    return [] on an empty set — the lane must stay empty rather than falling
    through to something broader.
    """
    posts = [_post("a", "p")]
    gateway = _Gateway(posts)
    blank = ViewerProfile(account="blank", follows=frozenset({"someone"}))

    assert established_interest_candidates(blank, gateway, EPOCH, limit=10) == []


# ── ★ end to end, because the boundary test passed while the feed did not ─────

def _e2e_on_interest(follows: frozenset[str]) -> tuple[int, int]:
    """Run the real pipeline and count on-interest posts in the visible feed.

    THE REASON THIS EXISTS. The first version of this fix was verified at the
    CANDIDATE-GENERATION boundary — `established_interest_candidates` returned 60
    candidates, so the lane "worked". End to end it was a total no-op: every one
    of those 60 was dropped by `filter_eligible`, and the feed the user actually
    sees was 0/20 on-interest with 17/20 popularity padding — the exact numbers
    the fix was written to eliminate. A lane is not fixed until content reaches
    the feed; assert on the feed.
    """
    from datetime import timedelta

    from recsys.core.normalize import build_norm_context
    from recsys.pipeline import TrustPolicy, rank_feed
    from tests.fakes import FakeGateway

    on = [
        make_post(author=f"ph{i}", permlink=f"ph{i}", community="hive-photo",
                  category="photography", tags=("photography",))
        for i in range(60)
    ]
    mine = [
        make_post(author="friend", permlink=f"f{i}", category="other", tags=("other",))
        for i in range(3)
    ]
    pop = [
        make_post(author=f"pop{i}", permlink=f"pop{i}", category="other", tags=("other",))
        for i in range(30)
    ]
    gateway = FakeGateway(in_network=mine, popular=pop, community=on, tag=on)
    viewer = ViewerProfile(
        account="me",
        follows=follows,
        interest_tags=frozenset({"photography"}),
        interest_communities=frozenset({"hive-photo"}),
    )
    samples = [float(i) for i in range(50)]
    feed = rank_feed(
        viewer, gateway, build_norm_context(samples, samples, samples),
        now=EPOCH + timedelta(days=1), since=EPOCH, trust_policy=TrustPolicy.WARN,
    )
    top = feed[:20]
    return sum(1 for sc in top if sc.post.category == "photography"), len(top)


def test_the_first_follow_does_not_empty_the_feed_of_interest_content() -> None:
    """★ THE REGRESSION, measured where the user experiences it.

    Before the lane existed:      0/20 on-interest after the first follow.
    With the lane but gated:      0/20 — candidates generated, none survived.
    """
    cold_hits, cold_n = _e2e_on_interest(frozenset())
    warm_hits, warm_n = _e2e_on_interest(frozenset({"friend"}))
    assert cold_hits == cold_n, "a followless viewer should see their interests"
    assert warm_hits > 0, "the first follow emptied the feed of interest content again"
    assert warm_hits >= warm_n // 2, (
        f"only {warm_hits}/{warm_n} on-interest after one follow — the lane is "
        "generating candidates that do not survive eligibility"
    )
