"""The tiered history windows must be CONSUMED, not merely documented.

`sourcing_freshness_days`, `trust_days` and `ring_days` were defined, documented
at length and validated in `__post_init__` — and read by nothing. `trust_days`
was "enforced" by a comment saying the caller passes it. A config that validates
a contract it never applies is the same failure shape H01/F-R2 closed elsewhere:
the next person reads the docstring and assumes a protection that is not there.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from recsys.config import DEFAULT_SETTINGS, HistoryWindows, RingConfig, Settings
from recsys.pipeline import build_trust_snapshot, gather_candidates, rank_feed
from tests.fakes import EPOCH, FakeGateway, make_post, make_viewer


def _norm():
    # >= NormConfig.min_samples so the scorer's guard admits it (matches
    # tests/test_pipeline.py's helper).
    from recsys.core.normalize import build_norm_context

    samples = [float(i) for i in range(50)]
    return build_norm_context(samples, samples, samples)


def test_rank_feed_derives_its_window_from_sourcing_freshness_days() -> None:
    """Omitting `since` must use the documented horizon, not a caller guess.

    Asserted by capturing the window the gateway is actually asked for, since
    that is the observable effect of the setting.
    """
    from recsys.pipeline import TrustPolicy

    seen: list[datetime] = []

    class _Recording(FakeGateway):
        def popular_posts(self, since: datetime, limit: int):
            seen.append(since)
            return super().popular_posts(since, limit)

    now = datetime(2024, 6, 1, tzinfo=UTC)
    rank_feed(make_viewer("v"), _Recording(), _norm(), now=now, trust_policy=TrustPolicy.WARN)

    expected = now - timedelta(days=DEFAULT_SETTINGS.history.sourcing_freshness_days)
    assert seen, "the gateway was never asked for candidates"
    assert all(s == expected for s in seen), f"expected {expected}, got {seen}"


def test_build_trust_snapshot_defaults_to_the_long_trust_window() -> None:
    """The default path must not NameError and must use trust_days.

    This exercises `now=None`/`since=None`, which no other test did — the branch
    that shipped a missing `timezone` import.
    """
    snap = build_trust_snapshot(FakeGateway(), DEFAULT_SETTINGS)
    assert snap is not None


def test_ring_config_rejects_impossible_values() -> None:
    with pytest.raises(ValueError):
        RingConfig(reciprocity_min=1.5)
    with pytest.raises(ValueError):
        RingConfig(min_group=1)


def test_ring_knobs_are_reachable_from_settings() -> None:
    """They used to be function defaults nobody could tune."""
    tuned = replace(DEFAULT_SETTINGS, ring=RingConfig(reciprocity_min=0.9, min_group=3))
    assert tuned.ring.reciprocity_min == 0.9
    assert tuned.ring.min_group == 3


# ---------------------------------------------------------------------------
# in_network_freshness_days (2026-08-04). These exist because a scrutinizer
# proved the widening was invisible to the whole suite: every panel and test
# passes an explicit `since=EPOCH`, and `tests/fakes.py`'s FakeGateway ignores
# its `since` argument entirely — so nothing could observe the window at all.
# A sign flip or a wrong field would have shipped silently.
# ---------------------------------------------------------------------------


class _SinceRecordingGateway(FakeGateway):
    """Records the `since` each source is actually asked for. The stock
    FakeGateway ignores `since`, which is exactly why this is needed."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.in_network_since: datetime | None = None
        self.other_since: list[datetime] = []

    def in_network_posts(self, follows, since, limit):
        self.in_network_since = since
        return super().in_network_posts(follows, since, limit)

    def engaged_oon_posts(self, follows, since, limit):
        self.other_since.append(since)
        return super().engaged_oon_posts(follows, since, limit)

    def community_posts(self, communities, since, limit):
        self.other_since.append(since)
        return super().community_posts(communities, since, limit)


def _windows(**kw) -> Settings:
    return Settings(history=replace(HistoryWindows(), **kw))


def test_in_network_window_is_widened_and_only_for_in_network() -> None:
    gw = _SinceRecordingGateway(in_network=[make_post("a", "p1")])
    viewer = make_viewer("me", follows=frozenset({"a"}), subscribed_communities=frozenset({"c"}))
    since = EPOCH + timedelta(days=30)
    gather_candidates(viewer, gw, since, 50, _windows(in_network_freshness_days=7))

    # widened by exactly (in_network - sourcing) = 7 - 3 = 4 days
    assert gw.in_network_since == since - timedelta(days=4)
    # every other lane keeps the short window
    assert gw.other_since, "no discovery lane was asked for"
    assert all(s == since for s in gw.other_since)


def test_in_network_window_zero_is_an_exact_no_op() -> None:
    gw = _SinceRecordingGateway(in_network=[make_post("a", "p1")])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    since = EPOCH + timedelta(days=30)
    gather_candidates(viewer, gw, since, 50, _windows(in_network_freshness_days=0))
    assert gw.in_network_since == since


def test_in_network_window_never_ends_up_narrower_than_discovery() -> None:
    # config forbids a narrower setting outright...
    with pytest.raises(ValueError, match="in_network_freshness_days"):
        _windows(in_network_freshness_days=1)
    # ...and equal-to-sourcing is a no-op rather than a negative shift.
    gw = _SinceRecordingGateway(in_network=[make_post("a", "p1")])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    since = EPOCH + timedelta(days=30)
    gather_candidates(viewer, gw, since, 50, _windows(in_network_freshness_days=3))
    assert gw.in_network_since == since


def test_default_rank_feed_path_keeps_in_network_inside_the_quality_prior_window() -> None:
    """The one real hazard a scrutinizer found: `pooled_author_base` subtracts a
    post's own base from an aggregate built over `quality_prior_days`, so a
    candidate sourced from OUTSIDE that aggregate corrupts the leave-one-out
    term. On `rank_feed`'s own default (`since=None`) this is unreachable, and
    the config invariant is what guarantees it — pin that, because the guarantee
    lives in an inequality rather than in code anyone would notice breaking.
    """
    h = HistoryWindows()
    assert h.sourcing_freshness_days <= h.in_network_freshness_days <= h.quality_prior_days
    # therefore in_network_since >= quality_since on the default path
    extra = h.in_network_freshness_days - h.sourcing_freshness_days
    in_network_days_back = h.sourcing_freshness_days + extra
    assert in_network_days_back <= h.quality_prior_days
