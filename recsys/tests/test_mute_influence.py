"""A muted or blocked account must not shape this viewer's feed AT ALL.

★ THE OWNER'S REQUIREMENT, verbatim (2026-08-24): "who i mute or block needs to
disappear regardless of me talking to them, a lot of commenting on their posts."

Hiding a muted account's POSTS was already absolute — `filter_eligible` drops
them for every source. What was NOT closed is their INFLUENCE. Muting is a
request to stop hearing from someone, and a muted account choosing which posts
enter your pool, vouching strangers into your feed, or minting score for what
you DO see is all still hearing from them. Two decorrelated council agents found
the same paths independently.

★ THESE ASSERT ON BEHAVIOUR, NOT ON SOURCE TEXT. The first version of this file
grepped `inspect.getsource` for the fix strings — which proves a string exists,
not that the call carries it. A recording gateway captures what each query was
actually ASKED for, so a refactor that keeps the text and breaks the wiring
still fails.

THE IRREDUCIBLE RESIDUAL, stated so nobody over-claims: a muted account's
engagement still feeds the GLOBAL trust graph (graph-cred, ring detection, the
norm sample). Those are viewer-independent by construction — `compute_graph_cred`
takes no viewer — and a per-viewer mute cannot enter them without becoming a
cross-viewer write, the channel class this package forbids.
"""

from __future__ import annotations

from datetime import timedelta

from recsys.config import DEFAULT_SETTINGS
from recsys.pipeline import gather_candidates
from tests.fakes import EPOCH, FakeGateway, make_post, make_viewer

MUTED = "noisy"
KEPT = "wanted"


class _RecordingGateway(FakeGateway):
    """Captures the author set every source query was actually asked for."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.in_network_asked: list[frozenset[str]] = []
        self.engaged_asked: list[frozenset[str]] = []

    def in_network_posts(self, follows, since, limit):
        self.in_network_asked.append(frozenset(follows))
        return super().in_network_posts(follows, since, limit)

    def engaged_oon_posts(self, follows, since, limit):
        self.engaged_asked.append(frozenset(follows))
        return super().engaged_oon_posts(follows, since, limit)


def _gather(mutes):
    viewer = make_viewer("me", follows=frozenset({MUTED, KEPT}), mutes=frozenset(mutes))
    gw = _RecordingGateway(in_network=[make_post(KEPT, "p1")])
    gather_candidates(viewer, gw, EPOCH, 50, DEFAULT_SETTINGS)
    return gw


def test_a_muted_follow_does_not_curate_the_oon_engaged_lane() -> None:
    """OON_ENGAGED is 'posts my follows engaged with'. A muted account the viewer
    ALSO follows was still choosing what entered the pool — their posts
    vanished, their taste did not."""
    gw = _gather({MUTED})
    assert gw.engaged_asked, "the engaged-OON lane was never queried"
    for asked in gw.engaged_asked:
        assert MUTED not in asked, (
            "a muted follow was still used to source the engaged-OON lane — "
            "they can pull posts into a feed they were muted out of"
        )
        assert KEPT in asked, "the unmuted follow was dropped too — over-filtered"


def test_a_muted_follow_does_not_spend_the_in_network_recall_budget() -> None:
    """Their posts were fetched and then discarded by `filter_eligible`, so each
    one displaced a wanted follow's post from the recall `limit` before scoring
    ever ran."""
    gw = _gather({MUTED})
    assert gw.in_network_asked, "the in-network lane was never queried"
    for asked in gw.in_network_asked:
        assert MUTED not in asked
        assert KEPT in asked


def test_with_nothing_muted_both_follows_are_still_sourced() -> None:
    """The control. Without it the two tests above would also pass if the code
    simply stopped sourcing follows at all."""
    gw = _gather(set())
    assert gw.in_network_asked and gw.engaged_asked
    for asked in gw.in_network_asked + gw.engaged_asked:
        assert {MUTED, KEPT} <= asked, (
            "an unmuted follow went missing — the subtraction is over-reaching"
        )


def test_a_muted_follow_is_not_a_voucher_and_mints_no_score() -> None:
    """The two remaining paths run inside `rank_feed`/`_score`, which need a
    full harness. Pinned here at the call boundary: `second_degree_engagers` is
    asked for follows-minus-mutes, and the vote exclusion set carries mutes.

    ★ The owner's phrase "a lot of commenting on their posts" is exactly this:
    a muted account's comments and upvotes were raising the organic and vote
    signal of every post the viewer WAS shown — the 'invisible promoter'
    position the global-ban note describes, held by someone the viewer asked
    never to see again.
    """
    import inspect

    from recsys import pipeline

    rank = inspect.getsource(pipeline.rank_feed)
    score = inspect.getsource(pipeline._score)
    # Boundary assertions, explicitly weaker than the behavioural ones above —
    # noted so no one mistakes them for proof of the running behaviour.
    assert "viewer.follows - viewer.mutes" in rank, "vouch set still includes muted follows"
    assert "| viewer.mutes" in score, "muted engagement still mints breadth"
    assert "personal_for=viewer.follows - viewer.mutes" in score, (
        "a muted follow still receives the personal rshares premium"
    )


def test_a_muted_account_does_not_weight_the_popular_seat() -> None:
    """★ THE OWNER RULED THIS COLLISION (2026-08-24).

    The popularity lane is deliberately impersonal — it shows what Hive is
    talking about, not what this viewer chose — and the owner also said muted
    accounts disappear "regardless." Those two rulings collide exactly here,
    and the owner ruled the mute wins.

    The seat stays impersonal: MEMBERSHIP is still chain-wide engagement. Only
    the WEIGHTING drops a muted account's comments and reblogs, so they cannot
    pick the one popular post this viewer is shown.
    """
    import inspect

    from recsys import pipeline

    src = inspect.getsource(pipeline.gather_candidates)
    marker = src.find("_popular_excluded")
    assert marker != -1
    block = src[marker : marker + 3000]
    assert "| viewer.mutes" in block, (
        "a muted account still weights which popular post this viewer is shown"
    )


def test_a_banned_author_cannot_take_the_exploration_seat() -> None:
    """★★★ A BAN A LANE CAN ROUTE AROUND IS NOT A BAN (2026-08-24).

    `filter_eligible` refuses banned authors, but the exploration lane is built
    from the RAW gathered pool and never passes through it — the P1 note beside
    this guard states that hazard exactly, and it had been applied to mutes and
    self-posts but NOT to bans. A full `rank_feed` simulation served a banned
    author at position 14.

    Live exposure was bounded by the lane's own `max_author_age_days` newness
    gate, so it reached banned accounts YOUNGER than that horizon — precisely
    the freshly-banned troll the list is maintained for, handed the most
    prominent reserved slot on the page.
    """
    import os

    import recsys.core.banned as banned_mod
    from recsys.config import DEFAULT_SETTINGS
    from recsys.contracts import Candidate, CandidateSource
    from recsys.core.exploration import eligible_for_exploration
    from tests.fakes import EPOCH, make_post, make_viewer

    prev = os.environ.get("RECSYS_BANNED_AUTHORS")
    os.environ["RECSYS_BANNED_AUTHORS"] = "troll"
    try:
        banned_mod.banned_authors.cache_clear()
        cands = [
            Candidate(post=make_post("troll", "p1"), source=CandidateSource.OON_INTEREST),
            Candidate(post=make_post("honest", "p2"), source=CandidateSource.OON_INTEREST),
        ]
        pool = eligible_for_exploration(
            cands,
            make_viewer("me"),
            now=EPOCH,
            graph_creds={},
            suppressed=frozenset(),
            show_nsfw=False,
            config=DEFAULT_SETTINGS.exploration,
            # Both authors must clear the lane's NEWNESS gate, or they drop as
            # `newness_unavailable` and the test passes for the wrong reason —
            # which is exactly what happened on the first writing.
            author_first_post={"troll": EPOCH, "honest": EPOCH},
        )
        authors = {c.post.author for c in pool}
        assert "troll" not in authors, (
            "a BANNED author is eligible for the reserved exploration seat — "
            "the lane routes around the ban filter by construction"
        )
        # Non-vacuous: the honest newcomer must still be eligible, or this test
        # would also pass if the lane simply stopped producing anything.
        assert "honest" in authors, "the lane produced nothing — test is vacuous"
    finally:
        if prev is None:
            os.environ.pop("RECSYS_BANNED_AUTHORS", None)
        else:
            os.environ["RECSYS_BANNED_AUTHORS"] = prev
        banned_mod.banned_authors.cache_clear()


def test_a_container_root_cannot_take_the_exploration_seat() -> None:
    """★ THE THIRD GUARD OF THIS CLASS THE EXPLORATION LANE HAS NEEDED.

    `filter_eligible` excludes container roots (second_degree.py) and so does
    `select_popular` (popular.py) — but this lane sources from the RAW pool and
    passes through neither, which is exactly why the mute check and the ban
    check both had to be re-implemented inside it. A container root is a rolling
    bucket holding other people's lite posts, not something written to be read;
    handing one the most prominent reserved slot on the page would serve
    plumbing as content.

    Found by audit, 2026-08-24 — and notably it appeared nowhere in this file's
    otherwise unusually thorough list of its own known gaps.
    """
    from recsys.config import DEFAULT_SETTINGS
    from recsys.contracts import Candidate, CandidateSource
    from recsys.core.exploration import eligible_for_exploration
    from tests.fakes import EPOCH, make_post, make_viewer

    # A real shipped marker pair, not an invented one: author AND prefix must
    # both match, which is the point of `container_markers`.
    pub, prefix = DEFAULT_SETTINGS.popular.container_markers[0]
    container = make_post(pub, f"{prefix}0001")
    normal = make_post("newcomer", "p1")
    cands = [
        Candidate(post=container, source=CandidateSource.OON_INTEREST),
        Candidate(post=normal, source=CandidateSource.OON_INTEREST),
    ]
    pool = eligible_for_exploration(
        cands,
        make_viewer("me"),
        now=EPOCH,
        graph_creds={},
        suppressed=frozenset(),
        show_nsfw=False,
        config=DEFAULT_SETTINGS.exploration,
        popular=DEFAULT_SETTINGS.popular,
        lite_publishers=frozenset(),
        author_first_post={pub: EPOCH, "newcomer": EPOCH},
    )
    authors = {c.post.author for c in pool}
    assert pub not in authors, "a container ROOT is eligible for the reserved seat"
    # Non-vacuous: a genuine newcomer must still get through.
    assert "newcomer" in authors, "the lane produced nothing — test is vacuous"
