"""The popular-posts cache must not grow with the clock.

★ 2026-09-23. `popular_posts` keys its cache on `since` bucketed to 300s, and
`since` moves forward with time, so every five minutes the popular lane ran
added a new key and nothing ever removed one. One entry is 150 hydrated posts
with their vote lists (measured at 25.2 MB in the live container), which made
the entries a steady contributor to the recsys process growing from ~0.4 GB to
5.7 GB over four days.

MUTANT: delete the `_prune_popular_locked` calls in `popular_posts` /
`_refresh_popular_posts`. `test_a_day_of_buckets_stays_bounded` fails with 288
entries.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pytest

from recsys.io import hafsql as hafsql_module
from recsys.io.hafsql import HafsqlClient, HafsqlConfig

SINCE = datetime(2026, 9, 23, 0, 0, 0, tzinfo=timezone.utc)


class _Client(HafsqlClient):
    """Real class, network replaced. The cache, key, stale branch and pruning are the shipped code."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HAFSQL_POPULAR_CACHE_TTL_S", "300")
        super().__init__(HafsqlConfig.from_env(), None)
        self.query_count = 0

    def _fetch_lite(self, sql, params, *, timeout_ms=None):  # type: ignore[override]
        self.query_count += 1
        return []

    def _hydrate(self, rows, *, timeout_ms=None):  # type: ignore[override]
        return [object()]


def _drain_refreshes(c: _Client) -> None:
    deadline = time.time() + 5
    while time.time() < deadline:
        with c._popular_cache_lock:
            if not c._popular_refreshing:
                return
        time.sleep(0.005)
    raise AssertionError("a background refresh never finished")


def test_a_day_of_buckets_stays_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    c = _Client(monkeypatch)
    clock = [10_000.0]
    monkeypatch.setattr(hafsql_module.time, "monotonic", lambda: clock[0])
    most = 0
    for i in range(288):  # one day of 5-minute buckets
        clock[0] += 300
        c.popular_posts(SINCE + timedelta(seconds=300 * i), 150)
        _drain_refreshes(c)
        most = max(most, len(c._popular_cache))
    bound = int(c._popular_max_stale_s // c._popular_cache_bucket_s) + 1
    assert most <= bound, f"cache reached {most} entries (bound {bound}); old buckets are never dropped"
    assert len(c._popular_cache) <= bound


def test_a_servable_stale_entry_survives_pruning(monkeypatch: pytest.MonkeyPatch) -> None:
    """CONTROL. Pruning must not drop what the stale-while-revalidate path still
    serves: an entry younger than max stale must remain and be returned."""
    c = _Client(monkeypatch)
    clock = [10_000.0]
    monkeypatch.setattr(hafsql_module.time, "monotonic", lambda: clock[0])
    first = c.popular_posts(SINCE, 150)
    clock[0] += c._popular_cache_ttl_s + 1          # stale, but well inside max stale
    served = c.popular_posts(SINCE + timedelta(seconds=300), 150)
    assert served is first, "a servable stale entry was not served"
    _drain_refreshes(c)
    assert c.query_count == 2  # the one blocking miss plus one background refresh
