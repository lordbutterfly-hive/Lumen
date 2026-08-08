"""End-to-end: does sustained engagement actually move a feed?

THE FINDING THIS CLOSES. Measured on the shipped build, a viewer who engaged
topic-B content for 30 consecutive rounds saw topic-B's share of their top-20 go
0.0500 -> 0.0500. Bit identical. The system was BIMODAL: structural changes
(follow / subscribe / edit interests) moved a feed instantly and completely,
while engagement — the signal every modern feed is built on — moved it by
literally zero.

These tests pin both halves:
  * with the channel OFF (the shipped default) the feed must be unchanged, so
    enabling it is an explicit, measurable decision rather than a silent drift;
  * with it ON the response must be CONTINUOUS — more engagement, more share —
    not a step function.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import EngagementEdge, ViewerProfile
from recsys.core.normalize import build_norm_context
from recsys.pipeline import TrustPolicy, TrustSnapshot, rank_feed
from tests.fakes import EPOCH, FakeGateway, make_post

NOW = EPOCH + timedelta(days=1)


def _norm():
    samples = [float(i) for i in range(50)]
    return build_norm_context(samples, samples, samples)


def _world():
    """Two topics, equal quality, equal supply — so any shift is preference."""
    posts = []
    for i in range(30):
        posts.append(make_post(author=f"a{i}", permlink=f"a{i}", category="alpha", tags=("alpha",)))
        posts.append(make_post(author=f"b{i}", permlink=f"b{i}", category="beta", tags=("beta",)))
    viewer = ViewerProfile(
        account="me",
        follows=frozenset({f"a{i}" for i in range(30)} | {f"b{i}" for i in range(30)}),
    )
    return viewer, FakeGateway(in_network=posts)


def _beta_share(weight: float, rounds: int) -> float:
    viewer, gateway = _world()
    edges = [
        EngagementEdge(src="me", dst=f"b{i % 30}", upvotes=1, last_interaction=EPOCH)
        for i in range(rounds)
    ]
    settings = replace(
        DEFAULT_SETTINGS,
        weights=replace(DEFAULT_SETTINGS.weights, organic_viewer=weight),
    )
    feed = rank_feed(
        viewer,
        gateway,
        _norm(),
        now=NOW,
        since=EPOCH,
        settings=settings,
        snapshot=TrustSnapshot(edges=tuple(edges)),
        trust_policy=TrustPolicy.WARN,
    )
    top = feed[:20]
    return sum(1 for sc in top if sc.post.category == "beta") / len(top)


def test_disabled_by_default_the_feed_does_not_drift() -> None:
    """The shipped default must reproduce the old behaviour exactly."""
    baseline = _beta_share(0.0, 0)
    assert _beta_share(0.0, 30) == baseline
    assert _beta_share(0.0, 60) == baseline


def test_enabled_sustained_engagement_moves_the_feed() -> None:
    """★ The finding: this measured +0.0000 before the channel existed."""
    before = _beta_share(0.3, 0)
    after = _beta_share(0.3, 30)
    assert after > before, "30 rounds of consistent engagement moved nothing"
    assert after - before >= 0.25, f"drift {after - before:+.4f} is not meaningful"


def test_the_response_is_continuous_not_a_step() -> None:
    """Bimodality was the defect — the curve must rise with engagement."""
    shares = [_beta_share(0.3, r) for r in (0, 5, 15, 30)]
    assert shares == sorted(shares), f"non-monotonic response: {shares}"
    assert len(set(shares)) > 2, f"looks like a step function, not a curve: {shares}"


def test_a_stronger_weight_produces_a_stronger_response() -> None:
    """The knob must actually be a knob."""
    weak = _beta_share(0.1, 15)
    strong = _beta_share(0.5, 15)
    assert strong >= weak


def test_sustained_engagement_all_but_captures_the_feed_at_w_0_3() -> None:
    """★ HONEST CAVEAT, pinned deliberately rather than left as a surprise.

    At w=0.3 a viewer who only ever engages one topic ends up with a top-20 that
    is that topic and nothing else but the reserved exploration seat. That is a
    filter bubble, and it is the cost side of this channel: the diversity
    re-ranker shapes composition and cannot introduce a subject the pool's
    ranking has already buried.

    ★★ MOVED 1.0 -> 0.95 BY OPTION C (2026-08-09), WHICH IS THE MEASUREMENT THIS
    TEST WAS PINNED FOR. Its previous docstring said in as many words: "there is
    still no exploration lane injecting anything the viewer has not already shown
    interest in ... recorded as a KNOWN PROPERTY so that adding exploration can
    be measured against it." This viewer declares NO interest tags at all, so
    under the mandatory-match rule `_interest_match` refused every candidate and
    the seat forfeited — total capture. With the fallback
    (`ExplorationConfig.interest_fallback`) the seat fills from eligible
    newcomers instead, and exactly ONE of twenty slots is now something the
    viewer never engaged. One slot is the whole bound: `slots_per_page = 1`, so
    this is the lane's designed size, not a leak."""
    assert _beta_share(0.3, 30) == 0.95
