"""SEEN-POST SUPPRESSION — the rule, the exemption, and the floor.

★★★ WHAT THESE TESTS ARE FOR, stated because this package has been burned by the
opposite four separate times: a feature that passes its own unit tests while
being STRUCTURALLY UNREACHABLE in the system that calls it.

So the load-bearing tests here are not the arithmetic ones. They are:

  * :func:`test_c5_exploration_seat_survives_suppression_end_to_end` — runs the
    WHOLE `rank_feed`, on the same fixture the exploration lane's own acceptance
    test uses, and proves the newcomer seat is still served when its post is deep
    into suppression range. It carries a NEGATIVE CONTROL in the same build (a
    merit post with the identical seen state IS suppressed), so it cannot pass
    because suppression silently did nothing.
  * :func:`test_flag_off_is_byte_identical` — contract C11, asserted on the
    returned list, not on a config read.
  * :func:`test_valve_floors_at_serve_limit` — the floor, proven to yield.
"""

from __future__ import annotations

import dataclasses
from datetime import timedelta

from recsys.config import (
    ExplorationConfig,
    FallbackConfig,
    PopularConfig,
    SeenConfig,
    Settings,
)
from recsys.contracts import Candidate, CandidateSource, Vote
from recsys.core.exploration import post_engagers
from recsys.core.seen import SeenState, resurrects, split_seen
from recsys.pipeline import TrustPolicy, rank_feed
from recsys.core.normalize import build_norm_context
from tests.fakes import EPOCH, FakeGateway, make_post, make_viewer, make_vote
from tests.test_pipeline import _explore_norm, _explore_world

NOW = EPOCH + timedelta(hours=1)
_PERMISSIVE = TrustPolicy.WARN
_ON = SeenConfig(enabled=True)


def _norm():
    samples = [float(i) for i in range(50)]
    return build_norm_context(samples, samples, samples)


def _cand(author: str, permlink: str, source: CandidateSource = CandidateSource.IN_NETWORK):
    return Candidate(post=make_post(author, permlink), source=source)


# --------------------------------------------------------------------------
# THE RULE
# --------------------------------------------------------------------------


def test_one_impression_is_not_suppressed() -> None:
    """The owner's design is TWICE, not once. X removes on first sight; we
    deliberately do not, because our supply is small enough that first-sight
    removal empties feeds."""
    pool = [_cand("alice", "a1")]
    seen = {"@alice/a1": SeenState(impressions=1, engagers_at_last_serve=0)}

    split = split_seen(pool, seen, _ON, {"@alice/a1": 0})

    assert [c.post.key for c in split.fresh] == ["@alice/a1"]
    assert split.repeats == []
    assert split.suppressed == 0


def test_two_impressions_with_no_growth_is_suppressed() -> None:
    pool = [_cand("alice", "a1")]
    seen = {"@alice/a1": SeenState(impressions=2, engagers_at_last_serve=4)}

    split = split_seen(pool, seen, _ON, {"@alice/a1": 4})

    assert split.fresh == []
    assert [c.post.key for c in split.repeats] == ["@alice/a1"]
    assert split.suppressed == 1
    assert split.resurrected == 0


def test_resurrection_absolute_arm() -> None:
    """Two distinct non-lite engagers is the smallest delta that cannot be bought
    inside `VoteSignalConfig.unknown_free` (1.0). One is not enough."""
    pool = [_cand("alice", "a1")]
    seen = {"@alice/a1": SeenState(impressions=2, engagers_at_last_serve=0)}

    one = split_seen(pool, seen, _ON, {"@alice/a1": 1})
    two = split_seen(pool, seen, _ON, {"@alice/a1": 2})

    assert one.suppressed == 1, "a +1 delta is inside the free budget and must not resurrect"
    assert two.resurrected == 1
    assert [c.post.key for c in two.fresh] == ["@alice/a1"]


def test_resurrection_relative_arm_prices_a_big_post_higher() -> None:
    """★ THE REASON THE RELATIVE ARM EXISTS. With an absolute-only rule a post at
    80 engagers resurrects on +2, which is noise at that scale — so the BIGGEST
    posts would resurrect constantly, reproducing the repetition this feature
    exists to remove on precisely the posts that repeat most today (the live
    118-impression post is a popular one)."""
    pool = [_cand("alice", "a1")]
    seen = {"@alice/a1": SeenState(impressions=2, engagers_at_last_serve=80)}

    # +2 clears the absolute arm but not ceil(0.25 * 80) = 20.
    assert split_seen(pool, seen, _ON, {"@alice/a1": 82}).suppressed == 1
    assert split_seen(pool, seen, _ON, {"@alice/a1": 100}).resurrected == 1


def test_baseline_re_arms_so_a_second_resurrection_costs_another_step() -> None:
    """★ THE STATELESS PROPERTY, asserted rather than described. The baseline is
    overwritten on every serve, so a post that resurrected at 10 engagers and was
    shown again is measured from 10 — not from its original 4."""
    pool = [_cand("alice", "a1")]

    first = {"@alice/a1": SeenState(impressions=2, engagers_at_last_serve=4)}
    assert split_seen(pool, first, _ON, {"@alice/a1": 10}).resurrected == 1

    # After that serve the aggregate re-armed the baseline to 10.
    rearmed = {"@alice/a1": SeenState(impressions=3, engagers_at_last_serve=10)}
    assert split_seen(pool, rearmed, _ON, {"@alice/a1": 12}).suppressed == 1, (
        "+2 on a baseline of 10 must NOT resurrect — ceil(0.25 * 10) = 3"
    )
    assert split_seen(pool, rearmed, _ON, {"@alice/a1": 13}).resurrected == 1


def test_unknown_baseline_does_not_suppress_and_is_counted_apart() -> None:
    """An unmeasurable rule must not silently become a strict one. It self-heals
    on the next serve, which writes a real baseline — and it is counted
    SEPARATELY so an operator can tell 'nothing grew' from 'nothing was
    measurable'."""
    pool = [_cand("alice", "a1")]
    seen = {"@alice/a1": SeenState(impressions=9, engagers_at_last_serve=None)}

    split = split_seen(pool, seen, _ON, {"@alice/a1": 0})

    assert [c.post.key for c in split.fresh] == ["@alice/a1"]
    assert split.baseline_unknown == 1
    assert split.resurrected == 0, "an unknown baseline is not a measured resurrection"
    assert split.suppressed == 0


def test_absent_engagers_now_also_fails_toward_showing() -> None:
    seen = {"@alice/a1": SeenState(impressions=5, engagers_at_last_serve=3)}
    assert resurrects(seen["@alice/a1"], None, _ON) is True


def test_a_lite_vote_cannot_resurrect_a_post() -> None:
    """★ FREE ENGAGEMENT MUST NOT BUY BACK AN IMPRESSION. `post_engagers` excludes
    lite votes by the same rule the need bands use; if it did not, a costless
    identity could turn suppression off for any post at will."""
    post = make_post(
        "alice",
        "a1",
        votes=[
            Vote(voter="lite1", rshares=0, timestamp=EPOCH, lite=True),
            Vote(voter="lite2", rshares=0, timestamp=EPOCH, lite=True),
            Vote(voter="lite3", rshares=0, timestamp=EPOCH, lite=True),
        ],
    )
    assert post_engagers(post) == set()

    pool = [Candidate(post=post, source=CandidateSource.IN_NETWORK)]
    seen = {"@alice/a1": SeenState(impressions=2, engagers_at_last_serve=0)}
    split = split_seen(pool, seen, _ON, {"@alice/a1": len(post_engagers(post))})
    assert split.suppressed == 1


def test_post_engagers_matches_engagement_received_for_one_post() -> None:
    """One body, two aggregations — the extraction must not have changed the rule."""
    from recsys.core.exploration import engagement_received

    post = make_post("alice", "a1", votes=[make_vote("bob"), make_vote("carol")])
    cand = Candidate(post=post, source=CandidateSource.IN_NETWORK)
    assert post_engagers(post) == engagement_received([cand])["alice"]


def test_repeats_come_back_least_shown_and_longest_ago_first() -> None:
    pool = [_cand("a", "1"), _cand("b", "2"), _cand("c", "3")]
    seen = {
        "@a/1": SeenState(impressions=5, engagers_at_last_serve=0, last_served_at=100.0),
        "@b/2": SeenState(impressions=2, engagers_at_last_serve=0, last_served_at=900.0),
        "@c/3": SeenState(impressions=2, engagers_at_last_serve=0, last_served_at=100.0),
    }

    split = split_seen(pool, seen, _ON, {k: 0 for k in ("@a/1", "@b/2", "@c/3")})

    assert [c.post.key for c in split.repeats] == ["@c/3", "@b/2", "@a/1"]


# --------------------------------------------------------------------------
# ★★★ CONTRACT C5 — THE EXPLORATION EXEMPTION
# --------------------------------------------------------------------------


def test_c5_exploration_source_is_never_suppressed_in_the_split() -> None:
    """The EXPLICIT half of the exemption (`core/seen.py`), independent of any
    call-site ordering."""
    pool = [
        _cand("newcomer", "debut", CandidateSource.EXPLORATION),
        _cand("alice", "a1", CandidateSource.IN_NETWORK),
    ]
    seen = {
        "@newcomer/debut": SeenState(impressions=40, engagers_at_last_serve=0),
        "@alice/a1": SeenState(impressions=40, engagers_at_last_serve=0),
    }

    split = split_seen(pool, seen, _ON, {"@newcomer/debut": 0, "@alice/a1": 0})

    assert [c.post.key for c in split.fresh] == ["@newcomer/debut"]
    assert [c.post.key for c in split.repeats] == ["@alice/a1"], (
        "the NEGATIVE CONTROL: an identically-seen merit post must be suppressed "
        "in the same call, or this test proves nothing about the exemption"
    )
    assert split.exempt == 1


def test_c5_exploration_seat_survives_suppression_end_to_end() -> None:
    """★★★ THE PROOF THAT THE EXEMPTION IS ACTUALLY REACHED.

    Not a unit test of `split_seen` — the whole of `rank_feed`, on the exact
    fixture the exploration lane's own acceptance test uses, with the
    suppression flag ARMED and the debut post 40 impressions deep with zero
    engagement growth (i.e. the rule would bury it forever, since a debut can
    never satisfy the resurrection arm).

    ★ WHY THIS TEST AND NOT A CODE-READ. The exemption's structural half is that
    `eligible_for_exploration` is handed the RAW candidate pool while the split
    runs on `filter_eligible`'s output. That is a property of two call sites 200
    lines apart in a function that has been re-ordered three times this month. A
    guarantee that depends on nobody moving a line is not a guarantee, and this
    test is what turns it into one.

    ★ THE NEGATIVE CONTROL IS INSIDE THE SAME BUILD. An established author's post
    is given the identical seen state and MUST disappear. Without it the test
    would pass just as happily if suppression were inert — which is the exact
    shape of the four unreachable-feature defects this package has already
    shipped.
    """
    gateway, viewer, on, _off = _explore_world()

    baseline = rank_feed(
        viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
        settings=on, trust_policy=_PERMISSIVE,
    )
    seat = on.exploration.position
    assert baseline[seat].post.key == "@newcomer/debut", (
        "fixture drift: the lane is not seating the debut, so this test cannot "
        "prove anything about exempting it"
    )
    # Pick a real merit post from the same build as the control.
    victim = next(
        sc.post.key for sc in baseline if sc.source is not CandidateSource.EXPLORATION
    )

    armed = dataclasses.replace(on, seen=_ON)
    seen = {
        "@newcomer/debut": SeenState(impressions=40, engagers_at_last_serve=0),
        victim: SeenState(impressions=40, engagers_at_last_serve=99),
    }
    ranked = rank_feed(
        viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
        settings=armed, trust_policy=_PERMISSIVE, seen=seen,
    )
    keys = [sc.post.key for sc in ranked]

    assert victim not in keys, (
        "NEGATIVE CONTROL FAILED: suppression did not fire at all, so the "
        "exemption below is untested"
    )
    assert "@newcomer/debut" in keys, (
        "C5 VIOLATED: the newcomer seat was suppressed. Resurrection keys on "
        "engagement GROWTH and a debut has none, so this buries every newcomer "
        "permanently after 2 impressions."
    )
    served = keys.index("@newcomer/debut")
    assert ranked[served].source is CandidateSource.EXPLORATION
    assert served == seat, "the seat must still be the reserved index, not a merit placement"


# --------------------------------------------------------------------------
# CONTRACT C11 — THE FLAG
# --------------------------------------------------------------------------


def test_flag_off_is_byte_identical() -> None:
    """★ ASSERTED ON THE RETURNED FEED, not on a config read. State that WOULD
    suppress most of the feed is supplied and must change nothing."""
    gateway, viewer, on, _off = _explore_world()

    before = rank_feed(
        viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
        settings=on, trust_policy=_PERMISSIVE,
    )
    seen = {
        sc.post.key: SeenState(impressions=40, engagers_at_last_serve=99) for sc in before
    }
    after = rank_feed(
        viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
        settings=on, trust_policy=_PERMISSIVE, seen=seen, serve_limit=30,
    )

    assert len(seen) > 5, "vacuous: the seen map must actually cover the feed"
    assert [sc.post.key for sc in after] == [sc.post.key for sc in before]
    assert [sc.score.final for sc in after] == [sc.score.final for sc in before]


def test_default_settings_have_suppression_off() -> None:
    assert Settings().seen.enabled is False


def test_empty_seen_map_suppresses_nothing_even_when_armed() -> None:
    gateway, viewer, on, _off = _explore_world()
    armed = dataclasses.replace(on, seen=_ON)

    before = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                       settings=on, trust_policy=_PERMISSIVE)
    after = rank_feed(viewer, gateway, _explore_norm(), now=NOW, since=EPOCH,
                      settings=armed, trust_policy=_PERMISSIVE, seen={})

    assert [sc.post.key for sc in after] == [sc.post.key for sc in before]


# --------------------------------------------------------------------------
# ★★★ THE STARVATION VALVE
# --------------------------------------------------------------------------


def _starved_world():
    """A viewer with a SMALL in-network pool and nothing else — the case the valve
    exists for. The popular lane and the fallback filler are switched off so the
    only thing that can rescue the feed is the valve itself; with them on, the
    padding would absorb the shortfall and the valve would never be exercised.
    """
    posts = [make_post(f"a{i:02d}", f"p{i}", created_min=i) for i in range(8)]
    gateway = FakeGateway(in_network=posts)
    viewer = make_viewer("me", follows=frozenset(f"a{i:02d}" for i in range(8)))
    settings = Settings(
        popular=PopularConfig(limit=0),
        fallback=FallbackConfig(min_feed_size=20),
        exploration=ExplorationConfig(slots_per_page=0),
        seen=_ON,
    )
    return gateway, viewer, settings, [f"@a{i:02d}/p{i}" for i in range(8)]


def test_valve_yields_before_the_feed_drops_below_the_floor() -> None:
    gateway, viewer, settings, keys = _starved_world()
    seen = {k: SeenState(impressions=3, engagers_at_last_serve=50) for k in keys}

    ranked = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        settings=settings, trust_policy=_PERMISSIVE, seen=seen, serve_limit=30,
    )

    assert len(ranked) == 8, (
        "every post was suppressed and the valve did not give them back — a "
        "reader would have been served an EMPTY feed"
    )


def test_valve_re_admits_least_shown_first() -> None:
    """★ THE FLOOR NEVER GOES BELOW `min_feed_size`, so to observe WHICH repeats
    come back the floor has to be lowered deliberately — `max(min_feed_size,
    serve_limit)` means a small `serve_limit` cannot shrink it. That is the
    property, not a fixture inconvenience: a 2-post request must still not be
    allowed to talk the guarantee down."""
    gateway, viewer, settings, keys = _starved_world()
    settings = dataclasses.replace(settings, fallback=FallbackConfig(min_feed_size=2))
    # All suppressed; the last two are the least-shown, so a floor that can only
    # take two must take exactly those.
    seen = {
        k: SeenState(impressions=9 if i < 6 else 2, engagers_at_last_serve=50)
        for i, k in enumerate(keys)
    }

    ranked = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        settings=settings, trust_policy=_PERMISSIVE, seen=seen, serve_limit=2,
    )

    assert {sc.post.key for sc in ranked} == {keys[6], keys[7]}


def test_a_small_serve_limit_cannot_talk_the_floor_below_one_screen() -> None:
    """The floor is `max(min_feed_size, serve_limit)`. A caller asking for 2 posts
    still gets the one-screen guarantee applied to the pool."""
    gateway, viewer, settings, keys = _starved_world()
    seen = {k: SeenState(impressions=9, engagers_at_last_serve=50) for k in keys}

    ranked = rank_feed(
        viewer, gateway, _norm(), now=NOW, since=EPOCH,
        settings=settings, trust_policy=_PERMISSIVE, seen=seen, serve_limit=2,
    )

    assert len(ranked) == 8, "min_feed_size (20) floors it; the whole pool comes back"


def test_floor_uses_serve_limit_when_it_exceeds_min_feed_size() -> None:
    """★ THE HALF THAT MATTERS. `min_feed_size` is 20 but the only caller asks for
    45 (a 30-post page at OVER_FETCH_RATIO 1.5). A 20-post floor would let a
    45-post request come back with 20 while every counter read 'floor honoured'."""
    posts = [make_post(f"a{i:02d}", f"p{i}", created_min=i) for i in range(30)]
    gateway = FakeGateway(in_network=posts)
    viewer = make_viewer("me", follows=frozenset(f"a{i:02d}" for i in range(30)))
    settings = Settings(
        popular=PopularConfig(limit=0),
        fallback=FallbackConfig(min_feed_size=20),
        exploration=ExplorationConfig(slots_per_page=0),
        seen=_ON,
    )
    seen = {
        f"@a{i:02d}/p{i}": SeenState(impressions=3, engagers_at_last_serve=50)
        for i in range(30)
    }

    at_20 = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=settings,
                      trust_policy=_PERMISSIVE, seen=seen, serve_limit=None)
    at_30 = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=settings,
                      trust_policy=_PERMISSIVE, seen=seen, serve_limit=30)

    assert len(at_20) == 20, "absent serve_limit the floor is min_feed_size"
    assert len(at_30) == 30, "a deeper served page must raise the floor with it"


def test_valve_does_not_fire_when_the_fresh_pool_is_deep_enough() -> None:
    """A valve that fires on ordinary traffic means the thresholds are wrong."""
    posts = [make_post(f"a{i:02d}", f"p{i}", created_min=i) for i in range(40)]
    gateway = FakeGateway(in_network=posts)
    viewer = make_viewer("me", follows=frozenset(f"a{i:02d}" for i in range(40)))
    settings = Settings(
        popular=PopularConfig(limit=0),
        exploration=ExplorationConfig(slots_per_page=0),
        seen=_ON,
    )
    # Only the first five are suppressed; 35 fresh remain, well over the floor.
    seen = {
        f"@a{i:02d}/p{i}": SeenState(impressions=4, engagers_at_last_serve=50)
        for i in range(5)
    }

    ranked = rank_feed(viewer, gateway, _norm(), now=NOW, since=EPOCH, settings=settings,
                       trust_policy=_PERMISSIVE, seen=seen, serve_limit=30)
    keys = {sc.post.key for sc in ranked}

    assert len(keys) == 35
    for i in range(5):
        assert f"@a{i:02d}/p{i}" not in keys


# --------------------------------------------------------------------------
# CONFIG GUARDS
# --------------------------------------------------------------------------


def test_config_refuses_a_zero_that_would_silently_disable_the_rule() -> None:
    import pytest

    with pytest.raises(ValueError, match="suppress_after_impressions"):
        SeenConfig(suppress_after_impressions=0)
    with pytest.raises(ValueError, match="resurrect_min_absolute"):
        SeenConfig(resurrect_min_absolute=0)
