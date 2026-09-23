"""The per-viewer profile cache must not grow with the viewers seen since boot.

★ 2026-09-23. `_ViewerProfileCache` keeps a profile for `ttl_s` (300s) and
never serves one older than that, but it only ever dropped an entry when the
dict reached `max_entries` (10,000). Every distinct viewer since the process
started therefore kept a profile, follow set included, until ten thousand of
them had accumulated: part of the recsys process growing between restarts.

MUTANT: delete the `_prune_expired_locked` call in `_ViewerProfileCache.get`.
`test_a_day_of_distinct_viewers_stays_bounded` fails with 1440 entries (bound
6), and the control's "expired profile was pruned" assertion fails with 3.
"""
from __future__ import annotations

import pytest

from recsys.contracts import ViewerProfile
from recsys.service import app as service_app

TTL_S = 300.0


def _profile(account: str) -> ViewerProfile:
    follows = frozenset(f"{account}-follows-{i}" for i in range(50))
    return ViewerProfile(account=account, follows=follows)


def _cache_on_fake_clock(
    monkeypatch: pytest.MonkeyPatch, *, max_entries: int = 10_000
) -> tuple[service_app._ViewerProfileCache, list[float]]:
    clock = [10_000.0]
    monkeypatch.setattr(service_app.time, "monotonic", lambda: clock[0])
    return service_app._ViewerProfileCache(TTL_S, max_entries), clock


def test_a_day_of_distinct_viewers_stays_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """One new viewer a minute for a day: only the viewers of the last TTL can
    ever be served, so only they may be held."""
    cache, clock = _cache_on_fake_clock(monkeypatch)
    step_s = 60.0
    most = 0
    for i in range(1440):
        clock[0] += step_s
        account = f"viewer{i}"
        cache.get(account, builder=lambda a=account: _profile(a))
        most = max(most, len(cache))
    bound = int(TTL_S // step_s) + 1
    assert most <= bound, (
        f"viewer cache reached {most} entries (bound {bound}); expired profiles are never dropped"
    )


def test_a_live_profile_is_still_served_and_an_expired_one_rebuilt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CONTROL. Pruning must not drop what the cache still serves: a profile
    inside its TTL comes back without a rebuild, even after other viewers'
    stores have pruned around it; one past its TTL is rebuilt."""
    cache, clock = _cache_on_fake_clock(monkeypatch)
    builds: list[str] = []

    def builder(account: str) -> ViewerProfile:
        builds.append(account)
        return _profile(account)

    first = cache.get("alice", builder=lambda: builder("alice"))
    clock[0] += TTL_S - 1
    cache.get("bob", builder=lambda: builder("bob"))  # a store: runs the prune
    assert cache.get("alice", builder=lambda: builder("alice")) is first
    assert builds == ["alice", "bob"]

    clock[0] += 2  # alice is now past her TTL; bob is not
    cache.get("carol", builder=lambda: builder("carol"))
    assert len(cache) == 2, "alice's expired profile should have been pruned, bob's kept"
    rebuilt = cache.get("alice", builder=lambda: builder("alice"))
    assert rebuilt is not first
    assert builds == ["alice", "bob", "carol", "alice"]


def test_the_size_cap_still_applies_inside_one_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    """CONTROL. Pruning is by age; the `max_entries` guard still bounds a burst of
    distinct viewers that all fall inside one TTL."""
    cache, clock = _cache_on_fake_clock(monkeypatch, max_entries=3)
    for i in range(10):
        clock[0] += 1
        cache.get(f"v{i}", builder=lambda i=i: _profile(f"v{i}"))
        assert len(cache) <= 3
