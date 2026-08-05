"""A5.2 — ``recsys.norm_builder`` tests.

Offline group (no marker) exercises the pure aggregation logic against a
minimal in-memory fake that implements only ``window_posts`` — deliberately
NOT ``tests.fakes.FakeGateway`` (which predates A5 and has no ``window_posts``
method at all; adding one there risks colliding with another builder's
concurrent edits to that shared fixture file, so this module defines its own
narrow fake instead).

Live group (``@pytest.mark.live``, gated on ``RECSYS_LIVE_DB``) proves the
whole thing end to end against the real HAFSQL mirror: a real
``HafsqlClient.window_posts`` call, hydrated, producing a ``NormContext``
whose three sample tuples are each ``>= settings.norm.min_samples`` and
sorted ascending — the exact shape ``rank_feed`` requires before it will rank
anything (see ``pipeline.rank_feed``'s own ``min_samples`` gate).
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from recsys.config import DEFAULT_SETTINGS, HafsqlConfig, LiteConfig
from recsys.contracts import Post
from recsys.core.vote_signal import independent_vote_signal
from recsys.io import hafsql
from recsys.norm_builder import build_window_norm
from tests.fakes import EPOCH, make_post, make_vote

_live = pytest.mark.skipif(
    not os.environ.get("RECSYS_LIVE_DB"),
    reason="RECSYS_LIVE_DB not set — live-mirror suite opted out (offline by default)",
)


class _FakeWindowGateway:
    """The one method `build_window_norm` needs — nothing else."""

    def __init__(self, posts: list[Post]) -> None:
        self._posts = posts
        self.last_since: datetime | None = None
        self.last_limit: int | None = None

    def window_posts(self, since: datetime, limit: int) -> list[Post]:
        self.last_since = since
        self.last_limit = limit
        return list(self._posts)[:limit]


# ---------------------------------------------------------------------------
# Offline
# ---------------------------------------------------------------------------


def test_build_window_norm_produces_sorted_samples_matching_post_count() -> None:
    posts = [
        make_post(
            author=f"author{i}",
            permlink=f"p{i}",
            author_reputation=float(i),
            votes=[make_vote(voter=f"voter{i}", rshares=10_000_000 * (i + 1))],
        )
        for i in range(5)
    ]
    gateway = _FakeWindowGateway(posts)
    now = EPOCH + timedelta(days=1)

    norm = build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    assert len(norm.vote_signal_samples) == 5
    assert len(norm.reputation_samples) == 5
    assert len(norm.organic_samples) == 5
    assert list(norm.vote_signal_samples) == sorted(norm.vote_signal_samples)
    assert list(norm.reputation_samples) == sorted(norm.reputation_samples)
    assert list(norm.organic_samples) == sorted(norm.organic_samples)
    # Every post's own author_reputation is present in the sample (exactly
    # what the raw reputation collector is supposed to do — no transformation).
    assert set(norm.reputation_samples) == {float(i) for i in range(5)}


def test_build_window_norm_defaults_since_from_sourcing_freshness_days() -> None:
    gateway = _FakeWindowGateway([])
    now = datetime(2026, 6, 15, tzinfo=UTC)

    build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    expected_since = now - timedelta(days=DEFAULT_SETTINGS.history.sourcing_freshness_days)
    assert gateway.last_since == expected_since


def test_build_window_norm_explicit_since_overrides_the_default() -> None:
    gateway = _FakeWindowGateway([])
    now = datetime(2026, 6, 15, tzinfo=UTC)
    explicit_since = now - timedelta(days=1)

    build_window_norm(gateway, DEFAULT_SETTINGS, now=now, since=explicit_since)

    assert gateway.last_since == explicit_since


def test_build_window_norm_empty_window_returns_empty_norm_context() -> None:
    gateway = _FakeWindowGateway([])
    now = EPOCH

    norm = build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    assert norm.vote_signal_samples == ()
    assert norm.reputation_samples == ()
    assert norm.organic_samples == ()


def test_build_window_norm_vote_signal_matches_the_authoritative_function_directly() -> None:
    """Pin: the sample this builder feeds `NormContext.vote_signal_samples`
    with is EXACTLY `independent_vote_signal` on the same post/exclusion
    shape `pipeline._score` scores real candidates with (module docstring's
    "lockstep" requirement) — not a reimplementation that happens to agree
    today."""
    post = make_post(
        author="alice",
        votes=[
            make_vote(voter="bob", rshares=50_000_000),
            make_vote(voter="alice", rshares=999_000_000),  # self-vote, excluded
        ],
    )
    gateway = _FakeWindowGateway([post])
    now = EPOCH

    norm = build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    from recsys.contracts import VoteExclusions

    expected = independent_vote_signal(post, VoteExclusions(author="alice"))
    assert norm.vote_signal_samples == (expected,)


# ---------------------------------------------------------------------------
# Live
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def live_client() -> hafsql.HafsqlClient:
    c = hafsql.HafsqlClient(HafsqlConfig(), LiteConfig())
    try:
        c.stake_lineage("acidyo")
    except Exception as exc:
        pytest.skip(f"HAFSQL mirror unreachable: {type(exc).__name__}: {exc}")
    return c


@_live
def test_build_window_norm_live_meets_min_samples_and_is_sorted(
    live_client: hafsql.HafsqlClient,
) -> None:
    now = datetime.now(UTC)
    norm = build_window_norm(live_client, DEFAULT_SETTINGS, now=now)

    min_samples = DEFAULT_SETTINGS.norm.min_samples
    assert len(norm.vote_signal_samples) >= min_samples, (
        f"only {len(norm.vote_signal_samples)} vote-signal samples — rank_feed's own "
        f"min_samples={min_samples} gate would refuse to rank against this"
    )
    assert len(norm.reputation_samples) >= min_samples
    assert len(norm.organic_samples) >= min_samples
    assert list(norm.vote_signal_samples) == sorted(norm.vote_signal_samples)
    assert list(norm.reputation_samples) == sorted(norm.reputation_samples)
    assert list(norm.organic_samples) == sorted(norm.organic_samples)
