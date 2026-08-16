"""The popular-posts cache key must not rotate faster than its own TTL.

★ 2026-08-16. `since` is a rolling `now - window`, and the key bucketed it at a
hard-coded 60s while the TTL defaulted to 300s. The entry stayed live and stayed
correct; nothing could look it up again after the minute turned. Every request
in a new minute paid the full query — 5.9s by this method's own docstring, and
5.96s measured live on /topics/photography for a viewer with seen history.

MUTANT: restore `self._popular_cache_bucket_s = 60`. `test_bucket_is_at_least_ttl`
fails, and so does the two-call hit test at the default TTL.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from recsys.io.hafsql import HafsqlClient, HafsqlConfig


def _client(monkeypatch: pytest.MonkeyPatch, ttl: str) -> HafsqlClient:
    monkeypatch.setenv("HAFSQL_POPULAR_CACHE_TTL_S", ttl)
    return HafsqlClient(HafsqlConfig.from_env(), None)


def test_bucket_is_at_least_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    """A key that rotates before the TTL expires makes the TTL dead code."""
    for ttl in ("60", "300", "900"):
        client = _client(monkeypatch, ttl)
        assert client._popular_cache_bucket_s >= client._popular_cache_ttl_s, (
            f"TTL {ttl}s but the cache key rotates every "
            f"{client._popular_cache_bucket_s}s — entries expire by key, never by TTL"
        )


def test_two_requests_a_minute_apart_share_a_cache_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real access pattern: a rolling `since`, two requests 90s apart.

    Before the fix these landed in different buckets and the second re-queried.
    """
    client = _client(monkeypatch, "300")
    now = datetime(2026, 8, 16, 12, 0, 0, tzinfo=timezone.utc)
    later = now + timedelta(seconds=90)

    def key_for(ts: datetime) -> tuple[int, int]:
        return (int(ts.timestamp() // client._popular_cache_bucket_s), 150)

    assert key_for(now) == key_for(later), (
        "two requests 90s apart produced different cache keys, so the second "
        "paid the full popular_posts query"
    )


def test_a_gap_beyond_the_ttl_still_rotates(monkeypatch: pytest.MonkeyPatch) -> None:
    """CONTROL. The fix must not make the cache immortal: past the TTL the key
    is allowed to move on, otherwise this test would pass on a bucket of any
    size including infinity."""
    client = _client(monkeypatch, "300")
    now = datetime(2026, 8, 16, 12, 0, 0, tzinfo=timezone.utc)
    much_later = now + timedelta(seconds=3600)

    def key_for(ts: datetime) -> tuple[int, int]:
        return (int(ts.timestamp() // client._popular_cache_bucket_s), 150)

    assert key_for(now) != key_for(much_later)
