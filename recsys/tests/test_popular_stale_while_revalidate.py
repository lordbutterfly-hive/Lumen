"""A reader must never block on a popular-posts refill.

★ 2026-08-16. Fixing the cache KEY stopped this query running once a minute, but
the first reader after the TTL lapsed still blocked on it: measured 15.2s on a
live box after a 5 minute idle, against 1.42s warm. The data is global
popularity, identical for every viewer, and the TTL already declares that
minutes-old is fine, so a stale entry is served immediately and refreshed off
the request path.

MUTANT: delete the `if cached is not None:` stale-serve branch in
`popular_posts`. `test_stale_entry_is_served_without_blocking` fails.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from recsys.io.hafsql import HafsqlClient, HafsqlConfig

SINCE = datetime(2026, 8, 16, 12, 0, 0, tzinfo=timezone.utc)
SLOW_QUERY_S = 0.4


class _Client(HafsqlClient):
    """Real class, with only the network hop replaced. Everything under test
    (the lock, the key, the stale branch, the in-flight guard) is the shipped code."""

    def __init__(self, ttl: str, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HAFSQL_POPULAR_CACHE_TTL_S", ttl)
        super().__init__(HafsqlConfig.from_env(), None)
        self.query_count = 0
        self._query_started = threading.Event()

    def _fetch_lite(self, sql, params):  # type: ignore[override]
        self.query_count += 1
        self._query_started.set()
        time.sleep(SLOW_QUERY_S)
        return []

    def _hydrate(self, rows):  # type: ignore[override]
        return []


def test_first_call_blocks_because_there_is_nothing_to_serve(monkeypatch: pytest.MonkeyPatch) -> None:
    """CONTROL. A cold process has no stale entry, so it must still pay once.
    Without this, a change that simply returned [] on a miss would pass the
    test below while silently dropping the popular lane."""
    c = _Client("1", monkeypatch)
    t0 = time.monotonic()
    c.popular_posts(SINCE, 150)
    assert time.monotonic() - t0 >= SLOW_QUERY_S, "the very first call must actually query"
    assert c.query_count == 1


def test_stale_entry_is_served_without_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    c = _Client("1", monkeypatch)
    c.popular_posts(SINCE, 150)          # populate
    assert c.query_count == 1
    time.sleep(1.05)                      # let the 1s TTL lapse

    t0 = time.monotonic()
    c.popular_posts(SINCE, 150)           # stale: must return at once
    elapsed = time.monotonic() - t0
    assert elapsed < SLOW_QUERY_S / 2, (
        f"a stale read blocked for {elapsed:.3f}s; the reader is paying for the refill"
    )
    # and the refill really did happen, off the request path
    deadline = time.monotonic() + 5
    while c.query_count < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert c.query_count == 2, "the stale entry was served but never refreshed"


def test_concurrent_stale_reads_trigger_exactly_one_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    c = _Client("1", monkeypatch)
    c.popular_posts(SINCE, 150)
    time.sleep(1.05)

    threads = [threading.Thread(target=lambda: c.popular_posts(SINCE, 150)) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    deadline = time.monotonic() + 5
    while c.query_count < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    time.sleep(SLOW_QUERY_S + 0.3)
    assert c.query_count == 2, (
        f"{c.query_count - 1} refreshes fired for one key; eight readers must not "
        "each start their own query against a shared mirror"
    )


def test_a_different_window_is_a_different_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stale branch must not serve one window's answer for another's."""
    c = _Client("300", monkeypatch)
    c.popular_posts(SINCE, 150)
    c.popular_posts(SINCE + timedelta(hours=2), 150)
    assert c.query_count == 2


def test_a_rotated_bucket_still_answers_instantly(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ THE CASE THE FIRST FIX MISSED, AND THE LIVE RUN CAUGHT.

    `since` is rolling and the bucket is TTL-wide, so a reader who returns after
    the TTL lands on a bucket with NO entry. Serving "the stale value for this
    key" did nothing there: measured live, a read 330s after priming still cost
    9.75s. The newest answer for the same `limit` must be borrowed instead.

    MUTANT: delete the `if fallback is None:` scan in `popular_posts`. This fails.
    """
    c = _Client("1", monkeypatch)
    c.popular_posts(SINCE, 150)
    assert c.query_count == 1

    # A LATER `since` -> a different bucket -> a key that has never been seen.
    later = SINCE + timedelta(seconds=400)
    assert int(later.timestamp() // c._popular_cache_bucket_s) != int(
        SINCE.timestamp() // c._popular_cache_bucket_s
    ), "test setup is wrong: these must land in different buckets"

    t0 = time.monotonic()
    c.popular_posts(later, 150)
    elapsed = time.monotonic() - t0
    assert elapsed < SLOW_QUERY_S / 2, (
        f"a rotated bucket blocked for {elapsed:.3f}s; the reader is still paying"
    )


def test_a_borrowed_answer_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    """CONTROL. The cross-bucket borrow must not be unbounded, or an abandoned
    cache would be served forever. Past `_popular_max_stale_s` the reader waits."""
    c = _Client("1", monkeypatch)          # ttl 1s -> max stale 4s
    c.popular_posts(SINCE, 150)
    time.sleep(4.2)
    later = SINCE + timedelta(seconds=400)
    t0 = time.monotonic()
    c.popular_posts(later, 150)
    assert time.monotonic() - t0 >= SLOW_QUERY_S, "a too-old answer must not be borrowed"
