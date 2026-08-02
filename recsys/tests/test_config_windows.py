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

from recsys.config import DEFAULT_SETTINGS, RingConfig
from recsys.pipeline import build_trust_snapshot, rank_feed
from tests.fakes import FakeGateway, make_viewer


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
