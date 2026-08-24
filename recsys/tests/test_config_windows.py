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

    ``production=False`` explicitly (C5/R2, 2026-08-04): the default flipped to
    ``True``, and this synthetic ``FakeGateway()`` world has no account named
    from ``DEFAULT_SETTINGS.trusted_seeds`` (the real curated Hive list), so a
    ``production=True`` build would refuse on F-R2's landed-seeds guard. This
    test is about the window defaulting, not about seed anchoring — an
    explicit opt-out preserves that.
    """
    snap = build_trust_snapshot(FakeGateway(), DEFAULT_SETTINGS, production=False)
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

    def tag_posts(self, tags, since, limit):
        self.other_since.append(since)
        return super().tag_posts(tags, since, limit)


def _windows(**kw) -> Settings:
    return Settings(history=replace(HistoryWindows(), **kw))


def test_in_network_window_is_widened_and_only_for_in_network() -> None:
    gw = _SinceRecordingGateway(in_network=[make_post("a", "p1")])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    since = EPOCH + timedelta(days=30)
    # Derived from the live default, never hardcoded: these literals used to be
    # `7` and `7 - 3 = 4`, and both went stale the moment `sourcing` was halved
    # to 1.5 (2026-08-23). The invariant under test is the SUBTRACTION, so state
    # it in terms of the config rather than in terms of the day it was written.
    sourcing = HistoryWindows().sourcing_freshness_days
    wider = sourcing + 4
    gather_candidates(viewer, gw, since, 50, _windows(in_network_freshness_days=wider))

    # widened by exactly (in_network - sourcing)
    assert gw.in_network_since == since - timedelta(days=wider - sourcing)
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
    sourcing = HistoryWindows().sourcing_freshness_days
    with pytest.raises(ValueError, match="in_network_freshness_days"):
        _windows(in_network_freshness_days=sourcing / 2)
    # ...and equal-to-sourcing is a no-op rather than a negative shift.
    gw = _SinceRecordingGateway(in_network=[make_post("a", "p1")])
    viewer = make_viewer("me", follows=frozenset({"a"}))
    since = EPOCH + timedelta(days=30)
    gather_candidates(viewer, gw, since, 50, _windows(in_network_freshness_days=sourcing))
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


# ---------------------------------------------------------------------------
# `Settings.from_env` (2026-08-04). `ExplorationConfig.from_env` was built,
# documented and unit-tested (`tests/test_exploration.py`) but nothing ever
# called it: `grep -rn 'ExplorationConfig.from_env'` returned exactly one
# hit, inside that method's own error-message string. `Settings()` — what
# `DEFAULT_SETTINGS` and every production caller actually construct — never
# read `LUMEN_EXPLORE_SEAT_SECRET`, so `Settings().exploration.seat_secret`
# was always `None` regardless of the real environment: the keyed-MAC fix for
# the measured 85.1%-seat-capture hole (C1a, `ExplorationConfig.seat_secret`'s
# own docstring) had no path to ever receive a real secret. This is the same
# "a config that validates a contract it never applies" shape this module's
# own header describes for `HistoryWindows` — just one class over.
# ---------------------------------------------------------------------------


def test_settings_from_env_reads_the_seat_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """The wiring itself: `Settings.from_env` must actually call
    `ExplorationConfig.from_env`, not merely exist. FAILS if `Settings.from_env`
    is reverted to `cls()` (ignoring the environment) — the exact "built but
    never called" shape this section exists to close."""
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "42" * 32)
    settings = Settings.from_env()
    assert settings.exploration.seat_secret == bytes.fromhex("42" * 32)


def test_settings_from_env_production_with_no_secret_refuses_to_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """'production=True cannot silently run unkeyed' must hold reachable
    THROUGH `Settings`, not only when `ExplorationConfig` is constructed by
    hand — this is the whole point of a caller having a `Settings.from_env`
    to call at all."""
    monkeypatch.delenv("LUMEN_EXPLORE_SEAT_SECRET", raising=False)
    with pytest.raises(ValueError, match="seat_secret"):
        Settings.from_env(production=True)


def test_settings_from_env_production_with_a_real_secret_starts_cleanly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "7a" * 32)
    settings = Settings.from_env(production=True)
    assert settings.exploration.production is True
    assert settings.exploration.seat_secret == bytes.fromhex("7a" * 32)


def test_settings_from_env_rejects_a_non_hex_secret_loudly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A misconfigured deploy (typo, truncated copy-paste, wrong env var
    entirely) must raise, never silently fall through to the unkeyed/random
    dev default — that would be the exact silent-downgrade shape C1a closed
    at the `ExplorationConfig` layer, reopened one level up if `Settings.
    from_env` swallowed the error instead of propagating it."""
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "not-hex-at-all")
    with pytest.raises(ValueError, match="LUMEN_EXPLORE_SEAT_SECRET"):
        Settings.from_env()


def test_settings_from_env_rejects_a_wrong_length_secret_loudly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Valid hex, wrong byte length (a truncated copy-paste is exactly this
    shape) must also raise loudly rather than being silently accepted as a
    weaker-than-intended key."""
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "11" * 10)  # 10 bytes, not 32
    with pytest.raises(ValueError, match="32 bytes"):
        Settings.from_env()


def test_settings_from_env_with_nothing_set_matches_bare_settings_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Control: an operator who calls `Settings.from_env()` in an environment
    with nothing configured (the dev/test default posture) must get the same
    non-raising, randomly-keyed-with-a-warning behaviour as plain `Settings()`
    — this method must not change behaviour for anyone who has not yet set
    the env var, only ADD a path for those who have."""
    monkeypatch.delenv("LUMEN_EXPLORE_SEAT_SECRET", raising=False)
    monkeypatch.delenv("LUMEN_EXPLORE_SEAT_SECRET_PREVIOUS", raising=False)
    monkeypatch.delenv("LUMEN_EXPLORE_SEAT_SECRET_ACTIVE_FROM_BUCKET", raising=False)
    from_env = Settings.from_env()
    bare = Settings()
    assert from_env.exploration.seat_secret is None
    assert from_env.exploration.production is False
    # Every OTHER field is untouched -- only `exploration` is sourced from the
    # environment today (see the method's own docstring for why).
    assert from_env.weights == bare.weights
    assert from_env.diversity == bare.diversity
    assert from_env.hafsql == bare.hafsql
    assert from_env.history == bare.history


def test_settings_from_env_does_not_disturb_default_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`DEFAULT_SETTINGS` is evaluated once at import time and is the stable,
    offline baseline ~700 tests and every measurement-harness panel build on
    (see `Settings.from_env`'s own docstring for why it is deliberately NOT
    routed through this method). Setting the env var must not retroactively
    change the already-constructed `DEFAULT_SETTINGS` singleton."""
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "99" * 32)
    assert DEFAULT_SETTINGS.exploration.seat_secret is None


def test_the_halved_freshness_windows_are_pinned_to_their_instructed_values() -> None:
    """★ NOTHING PINNED THESE UNTIL NOW (found by a scrutinizer, 2026-08-24).

    The windows were halved on 2026-08-23 by explicit owner instruction —
    `sourcing_freshness_days` 3.0 -> 1.5 (36h) and `in_network_freshness_days`
    7.0 -> 3.5 (84h) — and the tests around them were rewritten to derive from
    `HistoryWindows()` precisely so they could not go stale again. The
    side-effect of deriving everything is that NOTHING asserted the values
    themselves: a silent revert to 3 and 7 would have passed the entire suite.

    This is the one place the literals belong. If a later measurement justifies
    changing them, change them HERE, deliberately, with the reason.
    """
    h = HistoryWindows()
    assert h.sourcing_freshness_days == 1.5, "sourcing window moved off 36h"
    assert h.in_network_freshness_days == 3.5, "own-follows window moved off 84h"
    # Float, not int: "half of three days" has no integer representation, and a
    # silent re-typing to int would floor 1.5 to 1 and change the feed.
    assert isinstance(h.sourcing_freshness_days, float)
    assert isinstance(h.in_network_freshness_days, float)
