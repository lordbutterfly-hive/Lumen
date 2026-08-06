"""A10 — ``recsys.service.app`` tests.

Three groups:

1. OFFLINE — ``_TimerCache``, ``_ViewerProfileCache``, ``build_feed``'s error
   mapping, and the full HTTP layer (a real ``http.server`` bound to an
   ephemeral port, driven with fake gateways/hand-built contexts — no
   network dependency at all). Runs in the default ``pytest -q``.

2. RECSYS-DB-LIVE (``RECSYS_DATABASE_URL`` set) — ``_load_snapshot_fixed``
   against a real recsys Postgres, proving the cross-file ``built_at`` bug
   this builder found in ``recsys.db.store.load_snapshot`` (see
   ``recsys.service.app._load_snapshot_fixed``'s own docstring) is actually
   worked around here, not just described.

3. R8 LIVE (``RECSYS_LIVE_DB`` AND ``RECSYS_DATABASE_URL`` both set) — THE
   ACCEPTANCE TEST for BUILD-ADJUDICATION ruling R8, which rewrote A10's
   done-check from "curl returns 200" to four concrete assertions against a
   live request. Each is its own test function, all against ONE real,
   running ``recsys.service.app`` server backed by the real HAFSQL mirror
   and a real (if deliberately small — see the module-scoped fixture's own
   comment) trust snapshot built from real live data and persisted to a
   real recsys Postgres:

   - ``test_r8_feed_is_non_empty``
   - ``test_r8_every_score_is_in_0_1``
   - ``test_r8_served_order_is_identical_to_a_direct_rank_feed_call``
   - ``test_r8_fail_closed_fires_on_an_absent_snapshot``
   - ``test_r8_fail_closed_fires_on_a_stale_snapshot``
   - ``test_r8_norm_context_is_not_rebuilt_per_request`` (the OPERATIONAL
     CONSTRAINT proof, done against the real mirror where a rebuild would be
     visibly, measurably slow, not just theoretically wrong)
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from recsys.config import DEFAULT_SETTINGS, HafsqlConfig, LiteConfig, Settings
from recsys.contracts import GraphCred, NormContext, ViewerProfile
from recsys.core.normalize import build_norm_context
from recsys.db.store import ensure_schema, save_snapshot
from recsys.io import hafsql
from recsys.pipeline import (
    TrustPolicy,
    TrustSnapshot,
    _trust_is_fresh,
    build_trust_snapshot,
    rank_feed,
)
from recsys.service import app as service_app
from tests.fakes import EPOCH, FakeGateway, make_post, make_vote

_LIVE_MIRROR = os.environ.get("RECSYS_LIVE_DB")
_RECSYS_DSN = os.environ.get("RECSYS_DATABASE_URL")

_recsys_db_live = pytest.mark.skipif(
    not _RECSYS_DSN, reason="RECSYS_DATABASE_URL not set — recsys-DB suite opted out"
)
_r8_live = pytest.mark.skipif(
    not (_LIVE_MIRROR and _RECSYS_DSN),
    reason=(
        "R8 acceptance suite needs BOTH RECSYS_LIVE_DB (real HAFSQL mirror) and "
        "RECSYS_DATABASE_URL (real recsys Postgres) — opted out by default"
    ),
)


def _flat_norm(n: int = 100) -> NormContext:
    return build_norm_context([0.0] * n, [0.0] * n, [0.0] * n)


def _fresh_snapshot(*, built_at: datetime) -> TrustSnapshot:
    return TrustSnapshot(
        graph_creds={
            "alice": GraphCred(account="alice", score=0.5, follow_follower_ratio=1.0),
        },
        trusted_seeds=frozenset({"alice"}),
        built_at=built_at,
    )


class _FetchStubGateway(FakeGateway):
    """`FakeGateway` (already a full `HafsqlGateway`) plus the `_fetch`
    method `recsys.viewer` needs — the minimum to exercise `build_feed`
    end-to-end offline. Every `_fetch` call returns an empty result by
    default (a "no history" viewer); tests that need a specific
    `ViewerProfile` shape pass fields directly instead of relying on this."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.fetch_calls: list[str] = []

    def _fetch(self, sql: str, params: dict[str, Any]) -> list[tuple[Any, ...]]:
        self.fetch_calls.append(sql)
        return []


# ---------------------------------------------------------------------------
# _TimerCache
# ---------------------------------------------------------------------------


def test_timer_cache_warm_builds_once_and_exposes_the_value() -> None:
    calls = []

    def builder() -> str:
        calls.append(1)
        return "built"

    cache: service_app._TimerCache[str] = service_app._TimerCache("t", builder, refresh_s=9999)
    assert cache.value is None
    cache.warm()
    assert cache.value == "built"
    assert cache.build_count == 1
    assert len(calls) == 1


def test_timer_cache_warm_unguarded_propagates_the_exception() -> None:
    def failing_builder() -> str:
        raise RuntimeError("boom")

    cache: service_app._TimerCache[str] = service_app._TimerCache(
        "t", failing_builder, refresh_s=9999
    )
    with pytest.raises(RuntimeError, match="boom"):
        cache.warm(guard=False)
    assert cache.value is None
    assert cache.build_failures == 1


def test_timer_cache_warm_guarded_swallows_the_exception() -> None:
    def failing_builder() -> str:
        raise RuntimeError("boom")

    cache: service_app._TimerCache[str] = service_app._TimerCache(
        "t", failing_builder, refresh_s=9999
    )
    cache.warm(guard=True)  # must not raise
    assert cache.value is None
    assert cache.build_failures == 1


def test_timer_cache_background_refresh_updates_the_value_on_a_timer() -> None:
    counter = {"n": 0}

    def builder() -> int:
        counter["n"] += 1
        return counter["n"]

    cache: service_app._TimerCache[int] = service_app._TimerCache(
        "t", builder, refresh_s=0.05
    )
    cache.warm()
    assert cache.value == 1
    try:
        cache.start_background_refresh()
        time.sleep(0.3)
        assert cache.value is not None and cache.value > 1, (
            "background refresh should have rebuilt the value at least once in 0.3s "
            f"at a 0.05s refresh interval; build_count={cache.build_count}"
        )
    finally:
        cache.stop()


def test_timer_cache_background_refresh_keeps_last_known_good_on_failure() -> None:
    state = {"n": 0, "fail": False}

    def builder() -> int:
        state["n"] += 1
        if state["fail"]:
            raise RuntimeError("transient")
        return state["n"]

    cache: service_app._TimerCache[int] = service_app._TimerCache(
        "t", builder, refresh_s=0.05
    )
    cache.warm()
    first_value = cache.value
    assert first_value == 1
    state["fail"] = True
    try:
        cache.start_background_refresh()
        time.sleep(0.3)
        # Every refresh attempt since has failed -> value must be UNCHANGED,
        # never wiped to None or left corrupted by a partial build.
        assert cache.value == first_value
        assert cache.build_failures >= 1
    finally:
        cache.stop()


def test_timer_cache_stop_halts_further_refreshes() -> None:
    counter = {"n": 0}

    def builder() -> int:
        counter["n"] += 1
        return counter["n"]

    cache: service_app._TimerCache[int] = service_app._TimerCache(
        "t", builder, refresh_s=0.05
    )
    cache.warm()
    cache.start_background_refresh()
    time.sleep(0.15)
    cache.stop()
    count_at_stop = cache.build_count
    time.sleep(0.3)
    assert cache.build_count == count_at_stop, "no further builds after stop()"


# ---------------------------------------------------------------------------
# _ViewerProfileCache
# ---------------------------------------------------------------------------


def test_viewer_profile_cache_reuses_within_ttl() -> None:
    from recsys.contracts import ViewerProfile

    cache = service_app._ViewerProfileCache(ttl_s=9999, max_entries=100)
    calls = []

    def builder() -> ViewerProfile:
        calls.append(1)
        return ViewerProfile(account="alice")

    cache.get("alice", builder)
    cache.get("alice", builder)
    cache.get("alice", builder)
    assert len(calls) == 1
    assert len(cache) == 1


def test_viewer_profile_cache_rebuilds_after_ttl_expires() -> None:
    from recsys.contracts import ViewerProfile

    cache = service_app._ViewerProfileCache(ttl_s=0.05, max_entries=100)
    calls = []

    def builder() -> ViewerProfile:
        calls.append(1)
        return ViewerProfile(account="alice")

    cache.get("alice", builder)
    time.sleep(0.15)
    cache.get("alice", builder)
    assert len(calls) == 2


def test_viewer_profile_cache_separates_by_account() -> None:
    from recsys.contracts import ViewerProfile

    cache = service_app._ViewerProfileCache(ttl_s=9999, max_entries=100)
    cache.get("alice", lambda: ViewerProfile(account="alice"))
    cache.get("bob", lambda: ViewerProfile(account="bob"))
    assert len(cache) == 2


def test_viewer_profile_cache_evicts_when_full() -> None:
    from recsys.contracts import ViewerProfile

    cache = service_app._ViewerProfileCache(ttl_s=9999, max_entries=2)
    cache.get("alice", lambda: ViewerProfile(account="alice"))
    cache.get("bob", lambda: ViewerProfile(account="bob"))
    cache.get("carol", lambda: ViewerProfile(account="carol"))
    assert len(cache) == 2


# ---------------------------------------------------------------------------
# _load_snapshot_fixed — offline half (no DSN)
# ---------------------------------------------------------------------------


def test_load_snapshot_fixed_returns_none_with_no_dsn_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RECSYS_DATABASE_URL", raising=False)
    assert service_app._load_snapshot_fixed(None) is None


# ---------------------------------------------------------------------------
# build_feed — offline, against fakes
# ---------------------------------------------------------------------------


def _state_with(
    *,
    gateway: _FetchStubGateway,
    norm: NormContext | None,
    snapshot: TrustSnapshot | None,
    now: datetime,
    settings: Settings = DEFAULT_SETTINGS,
) -> service_app.ServiceState:
    norm_cache: service_app._TimerCache[NormContext] = service_app._TimerCache(
        "norm", lambda: norm, refresh_s=9999
    )
    snapshot_cache: service_app._TimerCache[TrustSnapshot | None] = service_app._TimerCache(
        "snapshot", lambda: snapshot, refresh_s=9999
    )
    if norm is not None:
        norm_cache.warm()
    else:
        # Simulate "still warming up" — value stays None without invoking a
        # builder that would otherwise just return None (indistinguishable
        # from "warmed to nothing"); tests assert on this state directly.
        pass
    snapshot_cache.warm()
    author_prior_cache = service_app.AuthorPriorCache("author_prior", lambda: {}, refresh_s=9999)
    author_prior_cache.warm()
    state = service_app.ServiceState(
        config=service_app.ServiceConfig(),
        settings=settings,
        gateway=gateway,  # type: ignore[arg-type]
        recsys_dsn=None,
        norm_cache=norm_cache,
        snapshot_cache=snapshot_cache,
        viewer_cache=service_app._ViewerProfileCache(ttl_s=9999, max_entries=1000),
        author_prior_cache=author_prior_cache,
    )
    state.now_fn = lambda: now
    return state


def test_build_feed_raises_norm_unavailable_when_norm_cache_is_empty() -> None:
    gateway = _FetchStubGateway()
    state = _state_with(gateway=gateway, norm=None, snapshot=None, now=EPOCH)
    with pytest.raises(service_app.FeedUnavailableError) as exc_info:
        service_app.build_feed(state, "alice")
    assert exc_info.value.kind == "norm_unavailable"


def test_build_feed_raises_trust_unavailable_when_snapshot_is_absent() -> None:
    gateway = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(gateway=gateway, norm=_flat_norm(), snapshot=None, now=EPOCH)
    with pytest.raises(service_app.FeedUnavailableError) as exc_info:
        service_app.build_feed(state, "alice")
    assert exc_info.value.kind == "trust_unavailable"


def test_build_feed_raises_trust_unavailable_when_snapshot_is_stale() -> None:
    stale = _fresh_snapshot(built_at=EPOCH - timedelta(days=400))
    trust_cfg = replace(DEFAULT_SETTINGS.trust, max_snapshot_age_days=14)
    settings = replace(DEFAULT_SETTINGS, trust=trust_cfg)
    gateway = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=stale, now=EPOCH, settings=settings
    )
    with pytest.raises(service_app.FeedUnavailableError) as exc_info:
        service_app.build_feed(state, "alice")
    assert exc_info.value.kind == "trust_unavailable"


def test_build_feed_refuses_a_stale_snapshot_before_touching_the_gateway() -> None:
    """★ B6 (2026-08-06 QA) — the FAIL_CLOSED refusal must cost NOTHING upstream.

    The two tests above only prove the 503 happens. It used to happen inside
    `rank_feed`, i.e. AFTER `build_viewer_profile` had already run its live
    HAFSQL queries — measured 33s of upstream work per request, thrown away.
    Under the exact condition the refusal exists for (trust batch stopped), the
    service was hammering a shared third-party mirror to produce 503s.

    This test gates the ORDER, which is the whole fix, by counting gateway
    queries. It is written to FAIL if the hoisted gate in `build_feed` is
    deleted: without it, `build_viewer_profile` runs and `fetch_calls` is
    non-empty.

    ★★ THE CONTROL IS THE POINT, and it is not decoration. "0 queries" is
    trivially true of a gateway nothing ever asks — a vacuous pass of exactly
    the class this project shipped twice (an assertion comparing two empty
    results, passing with the mechanism deleted). So the SAME gateway, the SAME
    viewer and the SAME call are run once more with only the snapshot's age
    changed, and that run MUST issue queries. The refusing arm is only
    meaningful because the serving arm proves the queries were there to skip.
    """
    trust_cfg = replace(DEFAULT_SETTINGS.trust, max_snapshot_age_days=14)
    settings = replace(DEFAULT_SETTINGS, trust=trust_cfg)

    stale = _fresh_snapshot(built_at=EPOCH - timedelta(days=400))
    refusing_gw = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(
        gateway=refusing_gw, norm=_flat_norm(), snapshot=stale, now=EPOCH, settings=settings
    )
    with pytest.raises(service_app.FeedUnavailableError) as exc_info:
        service_app.build_feed(state, "alice")
    assert exc_info.value.kind == "trust_unavailable"
    assert refusing_gw.fetch_calls == [], (
        "the trust refusal ran AFTER upstream work: build_feed issued "
        f"{len(refusing_gw.fetch_calls)} gateway quer(ies) before refusing. The "
        "FAIL_CLOSED gate must be hoisted above build_viewer_profile — a refusal "
        "that costs a live round-trip amplifies an outage onto a shared mirror."
    )

    # ---- CONTROL: same everything, fresh snapshot -> the queries DO happen ----
    fresh = _fresh_snapshot(built_at=EPOCH)
    serving_gw = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    serving_state = _state_with(
        gateway=serving_gw, norm=_flat_norm(), snapshot=fresh, now=EPOCH, settings=settings
    )
    service_app.build_feed(serving_state, "alice")
    assert serving_gw.fetch_calls, (
        "CONTROL FAILED — this viewer issues no gateway queries even when served, "
        "so the assertion above proves nothing about ordering. Fix the fixture "
        "before trusting this test."
    )


def test_build_feed_succeeds_with_fresh_snapshot_and_norm_scores_in_0_1() -> None:
    posts = [make_post(f"author{i}", f"p{i}", votes=[make_vote(f"voter{i}")]) for i in range(5)]
    gateway = _FetchStubGateway(popular=posts)
    fresh = _fresh_snapshot(built_at=EPOCH)
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=fresh, now=EPOCH + timedelta(days=1)
    )

    result = service_app.build_feed(state, "viewer1")

    assert result.scored, "expected a non-empty feed (followless viewer -> interest/popular lanes)"
    for sc in result.scored:
        assert 0.0 <= sc.score.final <= 1.0
        assert 0.0 <= sc.score.vote_norm <= 1.0
        assert 0.0 <= sc.score.rep_norm <= 1.0
        assert 0.0 <= sc.score.organic <= 1.0


def test_build_feed_uses_the_viewer_cache_not_rebuilding_per_call() -> None:
    posts = [make_post("author1", "p1")]
    gateway = _FetchStubGateway(popular=posts)
    fresh = _fresh_snapshot(built_at=EPOCH)
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=fresh, now=EPOCH + timedelta(days=1)
    )

    service_app.build_feed(state, "viewer1")
    fetch_calls_after_first = len(gateway.fetch_calls)
    service_app.build_feed(state, "viewer1")
    fetch_calls_after_second = len(gateway.fetch_calls)

    assert fetch_calls_after_second == fetch_calls_after_first, (
        "a second build_feed for the SAME viewer within the cache TTL must not "
        "re-run any of recsys.viewer's _fetch queries"
    )


class _TimeoutRaisingGateway(_FetchStubGateway):
    """Simulates the real operational finding (module docstring, and
    `build_feed`'s own comment): a gateway call inside `rank_feed` (here,
    `popular_posts`, reached via the tagless-viewer fallback path) can raise
    an unexpected error — live-reproduced as `author_engagement` hitting the
    15s statement timeout for a well-followed real account. `build_feed`
    must convert this to a clean, logged `FeedUnavailableError("upstream_error"`
    rather than letting it surface as an unclassified crash."""

    def popular_posts(self, since: datetime, limit: int) -> list[Any]:
        raise TimeoutError("simulated: canceling statement due to statement timeout")


def test_build_feed_maps_an_unexpected_gateway_error_to_upstream_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    gateway = _TimeoutRaisingGateway()
    fresh = _fresh_snapshot(built_at=EPOCH)
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=fresh, now=EPOCH + timedelta(days=1)
    )
    with pytest.raises(service_app.FeedUnavailableError) as exc_info:
        service_app.build_feed(state, "viewer1")
    assert exc_info.value.kind == "upstream_error"
    assert "TimeoutError" in exc_info.value.detail


def test_http_feed_upstream_error_is_503_not_500() -> None:
    state = _offline_state()
    state.gateway = _TimeoutRaisingGateway()
    with _RunningServer(state) as server:
        status, body = server.get("/feed?viewer=alice")
    assert status == 503
    assert body["error"] == "upstream_error"


# ---------------------------------------------------------------------------
# HTTP layer — real http.server, fake backing state, no network dependency.
# ---------------------------------------------------------------------------


class _RunningServer:
    def __init__(self, state: service_app.ServiceState) -> None:
        self.state = state
        self.server = service_app.make_server(state)
        self.server.timeout = 5
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> _RunningServer:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        host = "127.0.0.1" if host in ("0.0.0.0", "") else host
        return f"http://{host}:{port}"

    def get(self, path: str) -> tuple[int, dict[str, Any]]:
        url = self.base_url + path
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())


_UNSET = object()  # sentinel: distinguishes "use the default" from "explicitly None"


def _offline_state(
    *,
    now: datetime = EPOCH + timedelta(days=1),
    norm: NormContext | None | object = _UNSET,
    snapshot: TrustSnapshot | None | object = _UNSET,
    popular: list[Any] | None = None,
) -> service_app.ServiceState:
    gateway = _FetchStubGateway(popular=popular or [make_post("pop1", "p1")])
    resolved_norm = _flat_norm() if norm is _UNSET else norm
    resolved_snapshot = (
        _fresh_snapshot(built_at=EPOCH) if snapshot is _UNSET else snapshot
    )
    state = _state_with(
        gateway=gateway,
        norm=resolved_norm,  # type: ignore[arg-type]
        snapshot=resolved_snapshot,  # type: ignore[arg-type]
        now=now,
    )
    state.config = replace(state.config, host="127.0.0.1", port=0)
    return state


def test_http_feed_happy_path_returns_200_with_the_expected_shape() -> None:
    state = _offline_state()
    with _RunningServer(state) as server:
        status, body = server.get("/feed?viewer=alice")
    assert status == 200
    assert body["viewer"] == "alice"
    assert body["count"] == len(body["posts"])
    assert body["count"] > 0
    for post in body["posts"]:
        assert 0.0 <= post["score"]["final"] <= 1.0


def test_http_feed_missing_viewer_param_is_400() -> None:
    state = _offline_state()
    with _RunningServer(state) as server:
        status, body = server.get("/feed")
    assert status == 400
    assert body["error"] == "bad_request"


def test_http_feed_invalid_viewer_name_is_400() -> None:
    state = _offline_state()
    with _RunningServer(state) as server:
        status, body = server.get("/feed?viewer=" + "x" * 40)
    assert status == 400
    assert body["error"] == "bad_request"


def test_http_feed_absent_snapshot_is_503_not_500() -> None:
    state = _offline_state(snapshot=None)
    with _RunningServer(state) as server:
        status, body = server.get("/feed?viewer=alice")
    assert status == 503
    assert body["error"] == "trust_unavailable"


def test_http_feed_norm_not_ready_is_503() -> None:
    state = _offline_state()
    state.norm_cache = service_app._TimerCache("norm", lambda: None, refresh_s=9999)
    with _RunningServer(state) as server:
        status, body = server.get("/feed?viewer=alice")
    assert status == 503
    assert body["error"] == "norm_unavailable"


def test_http_health_reports_cache_state() -> None:
    state = _offline_state()
    with _RunningServer(state) as server:
        status, body = server.get("/health")
    assert status == 200
    assert body["status"] == "ok"
    assert body["norm"]["present"] is True
    assert body["trust_snapshot"]["present"] is True
    assert body["trust_snapshot"]["degraded"] is False


def test_http_unknown_route_is_404() -> None:
    state = _offline_state()
    with _RunningServer(state) as server:
        status, _body = server.get("/nonexistent")
    assert status == 404


def test_http_many_requests_do_not_rebuild_the_norm_context() -> None:
    """The OPERATIONAL CONSTRAINT proof, offline: `window_posts`/
    `build_window_norm` must be invoked once (the warm-up), never per
    request, however many requests land inside the refresh window."""
    build_calls = {"n": 0}

    def counting_builder() -> NormContext:
        build_calls["n"] += 1
        return _flat_norm()

    state = _offline_state()
    state.norm_cache = service_app._TimerCache("norm", counting_builder, refresh_s=9999)
    state.norm_cache.warm()
    assert build_calls["n"] == 1

    with _RunningServer(state) as server:
        for _ in range(10):
            status, _ = server.get("/feed?viewer=alice")
            assert status == 200

    assert build_calls["n"] == 1, (
        f"norm builder was invoked {build_calls['n']} times across 10 requests — "
        "it must be invoked exactly once (the warm-up), never per request"
    )


# ---------------------------------------------------------------------------
# _load_snapshot_fixed — recsys-DB-live half: proves the built_at fix.
# ---------------------------------------------------------------------------


@_recsys_db_live
def test_load_snapshot_fixed_applies_the_built_at_workaround() -> None:
    """The cross-file bug, proven end to end: `recsys.db.store.load_snapshot`
    leaves the INNER `TrustSnapshot.built_at` at `None` on every load (see
    `service_app._load_snapshot_fixed`'s docstring). This test persists a
    deliberately-stale snapshot and asserts the loader THIS module actually
    uses correctly reports it as stale — i.e. the workaround is applied, not
    just documented."""
    assert _RECSYS_DSN is not None
    ensure_schema(_RECSYS_DSN)
    import psycopg

    with psycopg.connect(_RECSYS_DSN, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE trust_snapshot_meta, graph_cred, ring_membership, "
            "als_model, trust_snapshot_edge"
        )

    stale_built_at = datetime.now(UTC) - timedelta(days=400)
    # `snapshot.built_at` itself is irrelevant here — `save_snapshot` takes the
    # persisted timestamp as its own `built_at=` kwarg, separate from the field.
    snapshot = _fresh_snapshot(built_at=EPOCH)
    save_snapshot(snapshot, built_at=stale_built_at, dsn=_RECSYS_DSN)

    loaded = service_app._load_snapshot_fixed(_RECSYS_DSN)
    assert loaded is not None
    assert loaded.built_at == stale_built_at, (
        "the loaded TrustSnapshot's OWN built_at field must carry the real "
        "persisted timestamp — this is exactly the field _trust_is_fresh reads"
    )
    assert _trust_is_fresh(loaded, now=datetime.now(UTC), max_age_days=14) is False


@_recsys_db_live
def test_load_snapshot_fixed_returns_none_when_nothing_persisted() -> None:
    assert _RECSYS_DSN is not None
    ensure_schema(_RECSYS_DSN)
    import psycopg

    with psycopg.connect(_RECSYS_DSN, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE trust_snapshot_meta, graph_cred, ring_membership, "
            "als_model, trust_snapshot_edge"
        )
    assert service_app._load_snapshot_fixed(_RECSYS_DSN) is None


# ---------------------------------------------------------------------------
# R8 — THE ACCEPTANCE TEST. One real server, real HAFSQL mirror, real
# (small) trust snapshot on a real recsys Postgres.
# ---------------------------------------------------------------------------


_R8_VIEWER = "acidyo"


@pytest.fixture(scope="module")
def r8_server() -> Any:
    """Builds one real `_FeedHTTPServer` — real pooled `HafsqlClient` against
    the live mirror, a real `NormContext` (via `window_posts`), and a REAL
    trust snapshot built from a genuinely small (2-minute) live engagement
    window and persisted to the real recsys Postgres this test controls.

    THE 2-MINUTE WINDOW, why: `build_trust_snapshot` calls
    `gateway.stake_lineage` once per account in the engagement-edge universe
    (~35ms/call live). Live-measured 2026-08-04: a 1-hour window already has
    4,202 accounts (~2.5 minutes of sequential stake_lineage calls); 2
    minutes of real edges has ~180 accounts (~6s). This snapshot is
    deliberately NOT a production-shaped weekly batch (`trust_days=365`) —
    it exists to give the SERVICE something real to load and serve, not to
    prove graph-cred's Sybil-resistance (that is A7/the trust batch's job,
    already built and tested elsewhere). `production=False` because a
    2-minute window is very unlikely to land any curated seed.
    """
    if not (_LIVE_MIRROR and _RECSYS_DSN):
        pytest.skip("R8 suite needs RECSYS_LIVE_DB and RECSYS_DATABASE_URL")

    ensure_schema(_RECSYS_DSN)
    import psycopg

    with psycopg.connect(_RECSYS_DSN, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE trust_snapshot_meta, graph_cred, ring_membership, "
            "als_model, trust_snapshot_edge"
        )

    gateway = hafsql.HafsqlClient(HafsqlConfig(), LiteConfig())
    try:
        gateway.stake_lineage(_R8_VIEWER)
    except Exception as exc:
        pytest.skip(f"HAFSQL mirror unreachable: {type(exc).__name__}: {exc}")

    now = datetime.now(UTC)
    snapshot = build_trust_snapshot(
        gateway, DEFAULT_SETTINGS, now=now, since=now - timedelta(minutes=2), production=False
    )
    assert snapshot.graph_creds and not snapshot.degraded, (
        "fixture precondition: the live 2-minute window must produce a usable "
        "(non-empty, non-degraded) snapshot — if this fails, widen the window"
    )
    save_snapshot(snapshot, built_at=now, dsn=_RECSYS_DSN)

    fixed_now = now  # the ONE `now` shared by the HTTP path and the direct comparison call
    cfg = service_app.ServiceConfig(
        host="127.0.0.1", port=0, norm_refresh_s=9999, snapshot_refresh_s=9999
    )
    state = service_app.ServiceState.build(config=cfg, recsys_dsn=_RECSYS_DSN)
    state.now_fn = lambda: fixed_now
    state.warm()
    assert state.norm_cache.value is not None
    assert state.snapshot_cache.value is not None

    # Memoize the gateway for the DURATION of this fixture only: two
    # independent live queries issued milliseconds apart are not literally
    # guaranteed atomic against a real, continuously-updating chain — wrap
    # so the "served order is IDENTICAL to a direct rank_feed() call" proof
    # compares against the SAME query results the HTTP-triggered call saw,
    # not a second live snapshot of a moving target. This affects only test
    # determinism; it changes nothing about what `build_feed`/`rank_feed`
    # themselves do.
    state.gateway = _MemoizingGateway(state.gateway)

    server = service_app.make_server(state)
    server.timeout = 30
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield _RunningServer.__new__(_RunningServer), server, state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)
        state.close()


class _MemoizingGateway:
    """Test-only wrapper: memoizes every gateway call by (method name, repr
    of args/kwargs) for the lifetime of one fixture. See `r8_server`'s own
    comment for why — this is a determinism aid for comparing two calls
    against a live, moving target, not a production caching strategy (A4's
    own request-scoped-lineage / TTL-popular-cache design is deliberately
    NOT this, and this wrapper is never used outside this test module).
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self._cache: dict[str, Any] = {}

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if not callable(attr):
            return attr

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            key = f"{name}:{args!r}:{sorted(kwargs.items())!r}"
            if key not in self._cache:
                self._cache[key] = attr(*args, **kwargs)
            return self._cache[key]

        return wrapper


def _r8_get(server: Any, path: str) -> tuple[int, dict[str, Any]]:
    host, port = server.server_address[:2]
    host = "127.0.0.1" if host in ("0.0.0.0", "") else host
    url = f"http://{host}:{port}{path}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


@pytest.fixture()
def r8_response(r8_server: Any) -> tuple[int, dict[str, Any]]:
    _, server, _state = r8_server
    return _r8_get(server, f"/feed?viewer={_R8_VIEWER}")


@_r8_live
def test_r8_feed_is_non_empty(r8_response: tuple[int, dict[str, Any]]) -> None:
    status, body = r8_response
    assert status == 200
    assert body["count"] > 0
    assert len(body["posts"]) > 0


@_r8_live
def test_r8_every_score_is_in_0_1(r8_response: tuple[int, dict[str, Any]]) -> None:
    _status, body = r8_response
    assert body["posts"], "fixture precondition: a non-empty feed to check scores on"
    for post in body["posts"]:
        score = post["score"]
        for key in ("vote_norm", "rep_norm", "organic", "final"):
            value = score[key]
            assert 0.0 <= value <= 1.0, f"{key}={value} out of [0, 1] for {post['key']}"


@_r8_live
def test_r8_served_order_is_identical_to_a_direct_rank_feed_call(r8_server: Any) -> None:
    """R8's central claim: the HTTP response's order must be IDENTICAL to a
    direct in-process `rank_feed()` call on the SAME inputs — not merely
    non-empty, not merely well-formed."""
    _, server, state = r8_server
    status, body = _r8_get(server, f"/feed?viewer={_R8_VIEWER}")
    assert status == 200
    served_keys = [post["key"] for post in body["posts"]]
    served_finals = [post["score"]["final"] for post in body["posts"]]

    # The exact ViewerProfile the server built for this request — cached, so
    # this MUST be a hit, never a fresh (and therefore non-identical) build.
    viewer = state.viewer_cache.get(
        _R8_VIEWER,
        builder=lambda: (_ for _ in ()).throw(
            AssertionError("viewer profile should already be cached from the HTTP request")
        ),
    )

    direct = rank_feed(
        viewer,
        state.gateway,
        state.norm_cache.value,
        now=state.now_fn(),
        settings=state.settings,
        snapshot=state.snapshot_cache.value,
        trust_policy=TrustPolicy.FAIL_CLOSED,
    )
    direct_keys = [sc.post.key for sc in direct]
    direct_finals = [sc.score.final for sc in direct]

    assert served_keys == direct_keys
    assert served_finals == direct_finals


@_r8_live
def test_r8_fail_closed_fires_on_an_absent_snapshot(r8_server: Any) -> None:
    _, server, state = r8_server
    original_snapshot_cache = state.snapshot_cache
    empty_cache: service_app._TimerCache[TrustSnapshot | None] = service_app._TimerCache(
        "snapshot", lambda: None, refresh_s=9999
    )
    empty_cache.warm()
    state.snapshot_cache = empty_cache
    try:
        status, body = _r8_get(server, f"/feed?viewer={_R8_VIEWER}")
    finally:
        state.snapshot_cache = original_snapshot_cache
    assert status == 503
    assert body["error"] == "trust_unavailable"


@_r8_live
def test_r8_fail_closed_fires_on_a_stale_snapshot(r8_server: Any) -> None:
    _, server, state = r8_server
    original_snapshot_cache = state.snapshot_cache
    stale = replace(
        original_snapshot_cache.value, built_at=datetime.now(UTC) - timedelta(days=400)
    )
    assert state.settings.trust.max_snapshot_age_days > 0
    stale_cache: service_app._TimerCache[TrustSnapshot | None] = service_app._TimerCache(
        "snapshot", lambda: stale, refresh_s=9999
    )
    stale_cache.warm()
    state.snapshot_cache = stale_cache
    try:
        status, body = _r8_get(server, f"/feed?viewer={_R8_VIEWER}")
    finally:
        state.snapshot_cache = original_snapshot_cache
    assert status == 503
    assert body["error"] == "trust_unavailable"


@_r8_live
def test_r8_norm_context_is_not_rebuilt_per_request(r8_server: Any) -> None:
    _, server, state = r8_server
    build_count_before = state.norm_cache.build_count
    for _ in range(5):
        status, _ = _r8_get(server, f"/feed?viewer={_R8_VIEWER}")
        assert status == 200
    assert state.norm_cache.build_count == build_count_before, (
        "5 live requests must not have triggered a NormContext rebuild — "
        "window_posts alone costs several seconds live, so a per-request "
        "rebuild would be trivially visible as request latency, not just wrong"
    )


@_r8_live
def test_r8_health_endpoint_reflects_the_real_snapshot_and_norm(r8_server: Any) -> None:
    _, server, _state = r8_server
    status, body = _r8_get(server, "/health")
    assert status == 200
    assert body["norm"]["present"] is True
    assert body["norm"]["vote_signal_samples"] >= DEFAULT_SETTINGS.norm.min_samples
    assert body["trust_snapshot"]["present"] is True
    assert body["trust_snapshot"]["degraded"] is False
    assert body["trust_snapshot"]["graph_creds"] > 0


def test_the_served_path_reads_the_warmed_prior_cache_and_never_the_gateway() -> None:
    """★ THE WIRING TEST. Without it, deleting
    `author_prior_cache=state.author_prior_cache.get` from `build_feed`'s
    `rank_feed` call passes the ENTIRE suite — 742 offline tests and 18 live —
    which is exactly how a built-and-wired feature silently does nothing.

    The property asserted is the one the work exists for: the author-pooled
    prior must be served from the warmed cache and `author_engagement` must NOT
    be reached on the request path. That query was measured exceeding the live
    15s statement timeout for a realistic candidate pool (150 busy authors →
    `QueryCanceled` at 16.1s); off the request path the same lookup is 0.042ms.

    Asserting "the cache was consulted" alone would be weaker — a call site
    could read the cache AND still fall through to the gateway. Both halves
    are checked.
    """
    gateway = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=_fresh_snapshot(built_at=EPOCH), now=EPOCH
    )

    consulted: list[frozenset[str]] = []
    real_get = state.author_prior_cache.get
    state.author_prior_cache.get = (  # type: ignore[method-assign]
        lambda authors: (consulted.append(authors), real_get(authors))[1]
    )
    gateway_calls: list[frozenset[str]] = []
    gateway.author_engagement = (  # type: ignore[method-assign]
        lambda authors, *a, **k: (gateway_calls.append(authors), {})[1]
    )

    service_app.build_feed(state, "alice")

    assert consulted, (
        "build_feed never consulted the warmed author-prior cache — the "
        "`author_prior_cache=` argument on rank_feed is missing"
    )
    assert not gateway_calls, (
        "build_feed reached gateway.author_engagement on the request path; that "
        "is the query measured to blow the 15s statement timeout"
    )


# ---------------------------------------------------------------------------
# B3 (2026-08-05) — Lumen Lite viewers can obtain a feed, and the signup
# interest picker finally reaches the ranker.
#
# Before this unit: `_ACCOUNT_RE` rejected every 26-char ULID, so
# `/feed?viewer=<lite-id>` returned 400 and the entire Lite tier was unable to
# get a feed at all; and `explicit_interest_tags` existed on
# `build_viewer_profile` with ZERO production callers, so signup picks could
# never influence a feed.
# ---------------------------------------------------------------------------

_LITE_ID = "01JB8XQ7K3F9N2VWXYZABCDEFG"  # 26 chars, Crockford base32


def test_valid_account_accepts_a_lite_ulid_and_still_accepts_hive_names() -> None:
    assert service_app._valid_account(_LITE_ID)
    assert service_app._valid_account("acidyo")
    assert service_app._viewer_is_lite(_LITE_ID)
    assert not service_app._viewer_is_lite("acidyo")


def test_valid_account_rejects_near_miss_lite_ids() -> None:
    """The lite alphabet is Crockford base32 — I, L, O and U are NOT in it, the
    id is exactly 26 chars, and it is uppercase. A near miss must not be waved
    through as a viewer we will then fail to profile."""
    assert not service_app._valid_account(_LITE_ID.lower())
    assert not service_app._valid_account(_LITE_ID[:-1])
    assert not service_app._valid_account(_LITE_ID + "Z")
    for bad in "ILOU":
        assert not service_app._valid_account(bad + _LITE_ID[1:]), bad


def test_csv_param_distinguishes_absent_from_empty() -> None:
    """★ THE VALUE-DOMAIN TEST. `None` means "derive it / ask the chain";
    an empty frozenset means "the caller supplied a list and it is empty".
    A falsy check would collapse these and silently derive tags for a caller
    who explicitly said they have none."""
    assert service_app._csv_param({}, "tags") is None
    assert service_app._csv_param({"tags": [","]}, "tags") == frozenset()
    assert service_app._csv_param({"tags": ["a,b"]}, "tags") == frozenset({"a", "b"})
    assert service_app._csv_param({"tags": [" a , b "]}, "tags") == frozenset({"a", "b"})


def test_a_lite_viewer_makes_ZERO_chain_queries() -> None:
    """★ THE LITE-PATH TEST. A ULID is not a Hive account, so `follows_of`,
    `mutes_of` and `derive_interest_tags` must never run for one — each would
    be a live round trip guaranteed to return nothing. `_FetchStubGateway`
    records every `_fetch`, so this asserts the absence directly rather than
    trusting the branch to be taken."""
    gateway = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=_fresh_snapshot(built_at=EPOCH), now=EPOCH
    )
    service_app.build_feed(state, _LITE_ID)
    assert gateway.fetch_calls == []


def test_a_hive_viewer_still_queries_the_chain() -> None:
    """The control for the test above — without it, a bug that skipped chain
    lookups for EVERY viewer would pass unnoticed."""
    gateway = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=_fresh_snapshot(built_at=EPOCH), now=EPOCH
    )
    service_app.build_feed(state, "alice")
    assert gateway.fetch_calls != []


def test_explicit_tags_and_follows_reach_the_viewer_profile() -> None:
    gateway = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=_fresh_snapshot(built_at=EPOCH), now=EPOCH
    )
    captured: list[ViewerProfile] = []
    real = service_app.build_viewer_profile

    def _spy(*args: Any, **kwargs: Any) -> ViewerProfile:
        profile = real(*args, **kwargs)
        captured.append(profile)
        return profile

    service_app.build_viewer_profile = _spy  # type: ignore[assignment]
    try:
        service_app.build_feed(
            state,
            _LITE_ID,
            explicit_interest_tags=frozenset({"photography"}),
            explicit_follows=frozenset({"alice", "bob"}),
        )
    finally:
        service_app.build_viewer_profile = real  # type: ignore[assignment]

    assert captured, "build_viewer_profile was never called"
    assert captured[0].interest_tags == frozenset({"photography"})
    assert captured[0].follows == frozenset({"alice", "bob"})


def test_per_request_tags_are_NOT_served_from_the_account_keyed_cache() -> None:
    """★ THE CACHE-BYPASS TEST, and the whole reason `build_feed` bypasses
    `viewer_cache` when explicit state is supplied. That cache is keyed on the
    ACCOUNT ALONE, so caching a profile built from per-request picks would
    serve the FIRST request's tags to every later request from the same viewer.
    Mutation-checked: routing these through `viewer_cache.get` makes the second
    assertion below fail."""
    gateway = _FetchStubGateway(popular=[make_post("pop1", "p1")])
    state = _state_with(
        gateway=gateway, norm=_flat_norm(), snapshot=_fresh_snapshot(built_at=EPOCH), now=EPOCH
    )
    captured: list[ViewerProfile] = []
    real = service_app.build_viewer_profile

    def _spy(*args: Any, **kwargs: Any) -> ViewerProfile:
        profile = real(*args, **kwargs)
        captured.append(profile)
        return profile

    service_app.build_viewer_profile = _spy  # type: ignore[assignment]
    try:
        service_app.build_feed(state, _LITE_ID, explicit_interest_tags=frozenset({"first"}))
        service_app.build_feed(state, _LITE_ID, explicit_interest_tags=frozenset({"second"}))
    finally:
        service_app.build_viewer_profile = real  # type: ignore[assignment]

    assert len(captured) == 2, "the second request was served from cache"
    assert captured[0].interest_tags == frozenset({"first"})
    assert captured[1].interest_tags == frozenset({"second"})


# ---------------------------------------------------------------------------
# B4c (2026-08-05) — the HTTP surface has controls.
#
# Before this: no auth, no rate limit, no concurrency cap, no per-connection
# read timeout, `?limit` silently ignored, and the 503 body echoed
# f"{type(exc).__name__}: {exc}" — which for a driver failure carries the
# upstream DB host and port — straight to the client.
# ---------------------------------------------------------------------------


def _get_with_headers(
    server: _RunningServer, path: str, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, Any]]:
    req = urllib.request.Request(server.base_url + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def _authed_state(**kwargs: Any) -> service_app.ServiceState:
    state = _offline_state(**kwargs)
    state.config = replace(state.config, api_token="s3cret-token")
    return state


def test_feed_requires_the_bearer_token_when_one_is_configured() -> None:
    state = _authed_state()
    with _RunningServer(state) as server:
        status, body = _get_with_headers(server, "/feed?viewer=alice")
    assert status == 401
    assert body == {"error": "unauthorized"}


def test_feed_accepts_the_correct_bearer_token() -> None:
    state = _authed_state()
    with _RunningServer(state) as server:
        status, _ = _get_with_headers(
            server, "/feed?viewer=alice", {"Authorization": "Bearer s3cret-token"}
        )
    assert status == 200


def test_feed_rejects_a_wrong_or_malformed_bearer_token() -> None:
    state = _authed_state()
    with _RunningServer(state) as server:
        for header in (
            {"Authorization": "Bearer wrong"},
            {"Authorization": "s3cret-token"},          # no scheme
            {"Authorization": "Basic s3cret-token"},    # wrong scheme
            {"Authorization": "Bearer "},
        ):
            status, _ = _get_with_headers(server, "/feed?viewer=alice", header)
            assert status == 401, header


def test_health_stays_reachable_without_a_token() -> None:
    """Container healthchecks and load balancers have no credentials, and
    /health exposes counters only — never feed content."""
    state = _authed_state()
    with _RunningServer(state) as server:
        status, body = _get_with_headers(server, "/health")
    assert status == 200
    assert body["status"] in ("ok", "starting")


def test_rate_limit_returns_429_once_the_window_budget_is_spent() -> None:
    state = _offline_state()
    state.config = replace(state.config, rate_limit_per_minute=3)
    with _RunningServer(state) as server:
        codes = [server.get("/feed?viewer=alice")[0] for _ in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3:] == [429, 429], codes


def test_limit_parameter_truncates_the_payload_and_count_agrees() -> None:
    """`?limit` was parsed nowhere — every caller got the full page regardless."""
    state = _offline_state(popular=[make_post(f"pop{i}", f"p{i}") for i in range(6)])
    with _RunningServer(state) as server:
        full_status, full_body = server.get("/feed?viewer=alice")
        status, body = server.get("/feed?viewer=alice&limit=2")
        bad_status, _ = server.get("/feed?viewer=alice&limit=0")
    assert full_status == 200 and status == 200
    assert len(body["posts"]) == 2
    assert body["count"] == 2, "count must describe the payload, not the full ranking"
    assert len(full_body["posts"]) >= len(body["posts"])
    assert bad_status == 400


def test_the_503_body_does_not_leak_upstream_error_text() -> None:
    """★ THE INFO-LEAK REGRESSION. `FeedUnavailableError.detail` is built from
    `str(exc)` on the underlying failure; for a driver error that carries the
    upstream DB host and port. It must reach the LOG, never the client."""
    state = _offline_state(snapshot=None)
    with _RunningServer(state) as server:
        status, body = server.get("/feed?viewer=alice")
    assert status == 503
    assert body["error"] == "trust_unavailable"
    assert "detail" not in body, f"503 body leaked upstream text: {body!r}"


def test_the_inflight_cap_sheds_rather_than_queues() -> None:
    """A bounded pool behind an unbounded thread pile-up is still an outage;
    over the cap the service must return 503 immediately."""
    state = _offline_state()
    state.config = replace(state.config, max_concurrent_requests=1)
    with _RunningServer(state) as server:
        # Exhaust the semaphore from outside so the next request must shed.
        assert server.server.inflight.acquire(blocking=False)
        try:
            status, body = server.get("/feed?viewer=alice")
        finally:
            server.server.inflight.release()
    assert status == 503
    assert body == {"error": "overloaded"}


def test_main_refuses_to_start_unauthenticated_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same posture as the seat secret: a control that is optional by default is
    a control nobody sets."""
    monkeypatch.setenv("RECSYS_PRODUCTION", "1")
    monkeypatch.setenv("LUMEN_EXPLORE_SEAT_SECRET", "ab" * 32)
    monkeypatch.delenv("RECSYS_API_TOKEN", raising=False)
    with pytest.raises(ValueError, match="RECSYS_API_TOKEN"):
        service_app.main()


# ---------------------------------------------------------------------------
# B5 (2026-08-05) — staleness is LOUD.
#
# The documented worst case before this: the weekly batch stops, 14 days pass,
# every /feed 503s under FAIL_CLOSED — and /health still returned "ok", the
# container healthcheck still passed, and the refusal path logged NOTHING. A
# total outage that nothing alerts on, preceded by two silent weeks.
# ---------------------------------------------------------------------------


def _stale_state() -> service_app.ServiceState:
    """A snapshot older than `max_snapshot_age_days` — the state a stopped
    weekly batch reaches on its own."""
    now = EPOCH + timedelta(days=400)
    state = _offline_state(now=now, snapshot=_fresh_snapshot(built_at=EPOCH))
    return state


def test_health_reports_degraded_and_not_serving_when_trust_is_stale() -> None:
    """★ THE HEADLINE REGRESSION. `status` used to be computed from the norm
    alone and never looked at the snapshot at all."""
    with _RunningServer(_stale_state()) as server:
        status, body = server.get("/health")
    assert status == 200, "health must stay reachable — it is how you SEE the outage"
    assert body["status"] == "degraded", body["status"]
    assert body["serving"] is False
    assert body["trust_snapshot"]["fresh"] is False
    assert body["trust_snapshot"]["present"] is True, (
        "'present' was always true for a six-month-old snapshot — which is "
        "exactly why it was never a health signal"
    )


def test_health_says_serving_when_trust_is_fresh() -> None:
    """Control: without it, a bug that reported `degraded` unconditionally
    would pass the test above."""
    with _RunningServer(_offline_state()) as server:
        _, body = server.get("/health")
    assert body["status"] == "ok"
    assert body["serving"] is True
    assert body["trust_snapshot"]["fresh"] is True


def test_the_stale_refusal_path_logs(caplog: pytest.LogCaptureFixture) -> None:
    """★ It refused every request while writing nothing to the server log, so
    the only evidence was client-side 503s."""
    state = _stale_state()
    with (
        caplog.at_level("ERROR", logger="recsys.service.app"),
        pytest.raises(service_app.FeedUnavailableError),
    ):
        service_app.build_feed(state, "alice")
    assert any("REFUSING every request" in r.getMessage() for r in caplog.records), (
        f"stale-trust refusal logged nothing: {[r.getMessage() for r in caplog.records]}"
    )


def test_health_and_serving_agree_on_the_same_clock() -> None:
    """`health_payload` used its own `datetime.now(UTC)` while the request path
    used `state.now_fn()`. Two clocks meant health could report ok while every
    request 503'd — the exact disagreement this task removes."""
    state = _stale_state()
    payload = service_app.health_payload(state)
    assert payload["serving"] is False
    with pytest.raises(service_app.FeedUnavailableError):
        service_app.build_feed(state, "alice")


# ---------------------------------------------------------------------------
# 2026-08-05 POST-CLOSEOUT COUNCIL — gates for the service-side fixes.
#
# Each test below names the MUTANT it catches. All four were verified by
# applying that mutant and watching only these tests fail.
# ---------------------------------------------------------------------------


def test_a_non_ascii_bearer_token_is_rejected_rather_than_crashing() -> None:
    """★★ Seat 3, verified. `secrets.compare_digest` raises TypeError the moment
    either side is a `str` containing non-ASCII — and this ran on
    UNAUTHENTICATED, attacker-supplied input, BEFORE the rate limiter. One
    request with an accented character killed the handler.

    MUTANT: compare the `str` values instead of encoding to bytes. The request
    then dies mid-connection instead of answering 401, and this fails.
    """
    state = _authed_state()
    with _RunningServer(state) as server:
        status, body = _get_with_headers(
            server, "/feed?viewer=alice", {"Authorization": "Bearer s3crét-tøken"}
        )
    assert status == 401
    assert body == {"error": "unauthorized"}


def test_unauthenticated_traffic_is_rate_limited_too() -> None:
    """★★ Seat 3, measured: 40 wrong-token requests produced 40x401 and 0x429,
    because auth ran BEFORE the limiter. An unauthenticated client could spend
    the server's threads for free — precisely what the limiter exists to stop.

    MUTANT: move `_authorized()` back in front of `rate_limiter.allow()`. Every
    code becomes 401 and this fails.
    """
    state = _authed_state()
    state.config = replace(state.config, rate_limit_per_minute=3)
    with _RunningServer(state) as server:
        codes = [
            _get_with_headers(
                server, "/feed?viewer=alice", {"Authorization": "Bearer wrong"}
            )[0]
            for _ in range(5)
        ]
    assert codes[:3] == [401, 401, 401], codes
    assert codes[3:] == [429, 429], codes


def test_healthcheck_probe_fails_when_the_service_cannot_serve() -> None:
    """★★ Seat 1 + Seat 3, verified. `/health` returns 200 unconditionally by
    design (so a stale batch stays diagnosable rather than fatal), which means a
    probe reading only the STATUS LINE reports a healthy container during a
    total serving outage — the exact failure B5 was built to make loud.

    MUTANT: have `probe()` return 0 on any HTTP 200 (i.e. ignore the body). The
    stale case then passes and this fails.
    """
    from recsys.service.healthcheck import probe

    with _RunningServer(_offline_state()) as server:
        assert probe(server.base_url + "/health") == 0
    with _RunningServer(_stale_state()) as server:
        assert probe(server.base_url + "/health") == 1


def test_healthcheck_probe_separates_unreachable_from_not_serving() -> None:
    """"Up but refusing to serve" and "process is gone" need different operator
    responses, and both look identical to a probe that only checks that
    something answered."""
    from recsys.service.healthcheck import probe

    assert probe("http://127.0.0.1:1/health", timeout=1.0) == 2


def test_a_non_ascii_api_token_is_refused_at_startup() -> None:
    """★★ ROUND-3 COUNCIL (Seat 2). The first crash fix made a legitimate
    non-ASCII token IMPOSSIBLE to authenticate with — headers arrive latin-1,
    the environment decodes UTF-8 — and the test asserted 401, which is
    indistinguishable from a wrong token, so it passed in both worlds.

    ★ The first version of THIS test called `main()`, which warms caches
    against the live mirror; inside the full suite it inherited another test's
    environment, missed the raise and spent 168 SECONDS booting a real service.
    A validation rule must be testable without starting a server.

    MUTANT: drop the `isascii()` check. This fails.
    """
    service_app.require_ascii_api_token(None)
    service_app.require_ascii_api_token("s3cret-token")
    with pytest.raises(ValueError, match="ASCII"):
        service_app.require_ascii_api_token("s3cr\u00e9t-token")


def test_startup_actually_applies_the_token_rule() -> None:
    """Behaviour is pinned above; this pins that `main()` still CONSULTS it —
    the reachability half, which is the half this project keeps dropping."""
    import inspect

    assert "require_ascii_api_token(" in inspect.getsource(service_app.main)


def test_a_lite_viewer_can_actually_mute_someone() -> None:
    """★★★ LAUNCH PUNCH LIST #2. `?mutes=` was parsed NOWHERE and a lite
    viewer's mute list was forced empty unconditionally, so muting somebody in
    the UI changed nothing and the exploration lane kept serving that author
    into position 13. Found by two councils running.

    A feature that silently does nothing is worse than an absent one — the user
    believes they acted.

    MUTANT: stop parsing `mutes`, or force the lite mute set empty again. This
    fails.
    """
    captured: list[ViewerProfile] = []
    real = service_app.build_viewer_profile

    def spy(*args: Any, **kwargs: Any) -> ViewerProfile:
        viewer = real(*args, **kwargs)
        captured.append(viewer)
        return viewer

    state = _offline_state()
    lite_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    with _RunningServer(state) as server:
        service_app.build_viewer_profile = spy  # type: ignore[assignment]
        try:
            status, _ = _get_with_headers(
                server, f"/feed?viewer={lite_id}&tags=photo&mutes=spammer,troll"
            )
        finally:
            service_app.build_viewer_profile = real  # type: ignore[assignment]

    assert status == 200
    assert captured, "the profile was served from cache — a per-request mute cannot apply"
    assert captured[-1].mutes == frozenset({"spammer", "troll"}), (
        f"a lite viewer's mutes never reached the ranker: {captured[-1].mutes}"
    )


def test_a_mute_list_is_never_served_from_another_requests_cache() -> None:
    """★★★ ROUND-5 COUNCIL (Seat 1): the first version of this used a LITE
    viewer, where the cache bypass is unconditional anyway (`tags_arg` and
    `follows_arg` are both forced non-None), so the `explicit_mutes is not None`
    clause could be DELETED with all 858 tests passing. An 18th mutant, uncaught.

    A HIVE viewer is the case where the clause is the only thing bypassing the
    cache — `viewer_cache` is keyed on ACCOUNT ALONE, so without it the first
    request's mute list is served to every later request from that viewer.

    MUTANT: drop `or explicit_mutes is not None`. This fails.
    """
    """`viewer_cache` is keyed on ACCOUNT ALONE, so a cached profile would serve
    the FIRST request's mute list to every later request from that viewer — a
    mute that works once and then silently stops."""
    captured: list[frozenset[str]] = []
    real = service_app.build_viewer_profile

    def spy(*args: Any, **kwargs: Any) -> ViewerProfile:
        viewer = real(*args, **kwargs)
        captured.append(viewer.mutes)
        return viewer

    state = _offline_state()
    with _RunningServer(state) as server:
        service_app.build_viewer_profile = spy  # type: ignore[assignment]
        try:
            # A HIVE account: nothing else forces the bypass here.
            _get_with_headers(server, "/feed?viewer=alice&mutes=first")
            _get_with_headers(server, "/feed?viewer=alice&mutes=second")
        finally:
            service_app.build_viewer_profile = real  # type: ignore[assignment]

    assert captured == [frozenset({"first"}), frozenset({"second"})], (
        f"the second request's mute list was served from cache: {captured}"
    )


def test_forwarded_for_is_ignored_unless_the_operator_declares_a_proxy() -> None:
    """★★★ PUNCH LIST #3. Trusting `X-Forwarded-For` by default would be a
    WORSE bug than the one it fixes: with no proxy in front, any client forges a
    fresh identity per request and bypasses the limiter entirely.

    MUTANT: read the header regardless of `trusted_proxy_hops`. This fails.
    """
    state = _offline_state()
    state.config = replace(state.config, rate_limit_per_minute=3, trusted_proxy_hops=0)
    with _RunningServer(state) as server:
        codes = [
            _get_with_headers(
                server, "/feed?viewer=alice", {"X-Forwarded-For": f"10.0.0.{i}"}
            )[0]
            for i in range(5)
        ]
    assert codes[:3] == [200, 200, 200], codes
    assert codes[3:] == [429, 429], (
        f"a forged X-Forwarded-For bypassed the rate limiter: {codes}"
    )


def test_behind_a_declared_proxy_each_client_gets_its_own_budget() -> None:
    """★★★ The bug itself: behind the reverse proxy this artifact documents,
    every client shares one peer address, so ONE unauthenticated caller spent
    the whole bucket and locked out every real user — measured by two councils
    (10 credential-free requests, then the CORRECT token gets 429).

    With one declared hop, the limiter keys on the address the proxy appended.

    MUTANT: key on the peer address anyway, or take the LEFTMOST (forgeable)
    entry. This fails.
    """
    state = _offline_state()
    state.config = replace(
        state.config,
        rate_limit_per_minute=2,
        trusted_proxy_hops=1,
        # ★ B10: the loopback peer these tests connect from must be a
        # DECLARED proxy, or X-Forwarded-For is ignored (and it should be).
        trusted_proxy_peers=("127.0.0.1",),
    )
    with _RunningServer(state) as server:
        noisy = [
            _get_with_headers(server, "/feed?viewer=alice", {"X-Forwarded-For": "203.0.113.9"})[0]
            for _ in range(4)
        ]
        victim = _get_with_headers(
            server, "/feed?viewer=alice", {"X-Forwarded-For": "198.51.100.7"}
        )[0]
    assert noisy[:2] == [200, 200] and noisy[2:] == [429, 429], noisy
    assert victim == 200, "one noisy client spent another client's budget"


def test_a_short_forwarded_chain_falls_back_to_the_peer_address() -> None:
    """Fewer hops than declared means the request did not come through the
    expected chain — trusting a short header would let a client shorten it on
    purpose and pick its own identity."""
    state = _offline_state()
    state.config = replace(
        state.config,
        rate_limit_per_minute=2,
        trusted_proxy_hops=2,
        # ★ B10: the loopback peer these tests connect from must be a
        # DECLARED proxy, or X-Forwarded-For is ignored (and it should be).
        trusted_proxy_peers=("127.0.0.1",),
    )
    with _RunningServer(state) as server:
        codes = [
            _get_with_headers(
                server, "/feed?viewer=alice", {"X-Forwarded-For": f"10.0.0.{i}"}
            )[0]
            for i in range(4)
        ]
    assert codes[2:] == [429, 429], f"a short forwarded chain was trusted: {codes}"


def test_a_client_cannot_forge_its_identity_by_prepending_to_the_chain() -> None:
    """★★★ THE POSITION IS THE WHOLE POINT, and a single-entry chain cannot see
    it — mutation testing caught that the first three tests here all used one
    entry, where leftmost and rightmost are the same address.

    `X-Forwarded-For` grows left-to-right: the client's own value first, then
    each proxy appends the address it SAW. So with one trusted proxy the only
    entry an upstream attacker cannot write is the LAST one. Reading the
    leftmost means the client picks its own rate-limit identity.

    Here two different real clients both send the same forged leading entry. If
    the limiter reads position 0 they share one budget and the second is denied
    by the first's traffic.

    MUTANT: `chain[0]` instead of `chain[-hops]`. This fails.
    """
    state = _offline_state()
    state.config = replace(
        state.config,
        rate_limit_per_minute=2,
        trusted_proxy_hops=1,
        # ★ B10: the loopback peer these tests connect from must be a
        # DECLARED proxy, or X-Forwarded-For is ignored (and it should be).
        trusted_proxy_peers=("127.0.0.1",),
    )
    with _RunningServer(state) as server:
        noisy = [
            _get_with_headers(
                server, "/feed?viewer=alice", {"X-Forwarded-For": "1.1.1.1, 203.0.113.9"}
            )[0]
            for _ in range(4)
        ]
        victim = _get_with_headers(
            server, "/feed?viewer=alice", {"X-Forwarded-For": "1.1.1.1, 198.51.100.7"}
        )[0]
    assert noisy[:2] == [200, 200] and noisy[2:] == [429, 429], noisy
    assert victim == 200, (
        "a client spent another client's budget by sending the same forged "
        "leading X-Forwarded-For entry — the limiter is reading a forgeable position"
    )


def test_forwarded_for_from_an_undeclared_peer_is_ignored() -> None:
    """★★★ B10 (2026-08-06 QA) — DECLARING HOPS IS NOT DECLARING WHO.

    `trusted_proxy_hops > 0` used to be sufficient on its own: `_client_identity`
    read `X-Forwarded-For` on the strength of a number in the config, without
    ever checking that the request arrived through a proxy. Anything that could
    reach the port directly — a sibling container, anything inside the VPC, the
    whole internet if the port is published — supplied the entire chain itself,
    INCLUDING the rightmost position the code calls unforgeable, and minted a
    fresh rate-limit bucket per request. The limiter is what bounds load onto a
    shared third-party mirror, so unlimited buckets means no limiter.

    Here the peer (loopback, where the test client actually connects from) is
    NOT in `trusted_proxy_peers`, so every request must fall back to the peer
    address and share one bucket, despite each carrying a distinct forged chain.

    MUTANT: drop the `_peer_is_trusted_proxy` guard in `_client_identity`. Then
    each forged header is its own bucket, nothing is ever throttled, and this
    fails.
    """
    state = _offline_state()
    state.config = replace(
        state.config,
        rate_limit_per_minute=2,
        trusted_proxy_hops=1,
        # A real proxy address that is NOT where these requests come from.
        trusted_proxy_peers=("10.9.9.9",),
    )
    with _RunningServer(state) as server:
        codes = [
            _get_with_headers(
                server, "/feed?viewer=alice", {"X-Forwarded-For": f"203.0.113.{i}"}
            )[0]
            for i in range(4)
        ]
    assert codes[:2] == [200, 200], codes
    assert codes[2:] == [429, 429], (
        "a caller that is NOT a declared proxy forged a fresh rate-limit bucket "
        f"per request by supplying X-Forwarded-For: {codes}. The peer address, "
        "not a config number, decides whether that header is heard."
    )


def test_a_declared_proxy_cidr_matches_the_peer() -> None:
    """★ B10 control, and it is what makes the test above non-vacuous.

    "Everything got throttled" is also what a totally broken forwarded-header
    path looks like. The SAME server, the SAME forged chains, differing only in
    whether the loopback peer is inside the declared CIDR — and here it is, so
    the two clients get SEPARATE budgets. Without this arm, the assertion above
    would pass just as happily if `X-Forwarded-For` had stopped working
    altogether.
    """
    state = _offline_state()
    state.config = replace(
        state.config,
        rate_limit_per_minute=2,
        trusted_proxy_hops=1,
        trusted_proxy_peers=("127.0.0.0/8",),  # CIDR form, contains 127.0.0.1
    )
    with _RunningServer(state) as server:
        noisy = [
            _get_with_headers(server, "/feed?viewer=alice", {"X-Forwarded-For": "203.0.113.9"})[0]
            for _ in range(4)
        ]
        victim = _get_with_headers(
            server, "/feed?viewer=alice", {"X-Forwarded-For": "198.51.100.7"}
        )[0]
    assert noisy[:2] == [200, 200] and noisy[2:] == [429, 429], noisy
    assert victim == 200, (
        "CONTROL FAILED — the peer is inside the declared CIDR, so X-Forwarded-For "
        "must be honoured and each client must get its own budget. If this is 429, "
        "the forwarded path is broken and the test above proves nothing."
    )


def test_hops_without_declared_peers_is_refused_at_construction() -> None:
    """★ B10. The precondition is ENFORCED, not documented.

    A comment saying "bind to localhost or firewall the port" is exactly the
    shape of control this project has now lost three times (the seat secret, the
    API token, the lite DSN). An operator who sets hops because they added a
    proxy, and does not know this field exists, must not get a silently
    forgeable limiter — they get a startup error naming the fix.
    """
    with pytest.raises(ValueError, match="RECSYS_TRUSTED_PROXY_PEERS"):
        service_app.ServiceConfig(trusted_proxy_hops=1)

    # hops=0 needs no peers — the safe default must stay constructible.
    assert service_app.ServiceConfig().trusted_proxy_hops == 0

    # An unparseable entry is refused too: a typo that matched nothing would
    # silently degrade to the shared-bucket outage punch list #3 fixed.
    with pytest.raises(ValueError, match="not an IP or CIDR"):
        service_app.ServiceConfig(trusted_proxy_hops=1, trusted_proxy_peers=("proxy.internal",))


def test_a_never_built_snapshot_reads_as_starting_not_degraded() -> None:
    """★★★ PUNCH LIST #4. A snapshot that has NEVER existed is a COLD START;
    one that exists and has aged out is DEGRADATION. Both refuse to serve, but
    collapsed into "degraded" every first deploy reported UNHEALTHY forever —
    the weekly batch is deliberately unscheduled in the shipped compose file, so
    a fresh install has no snapshot by construction and an operator sees a fault
    that is not there.

    MUTANT: drop the `snapshot is None` branch. This fails.
    """
    state = _offline_state(snapshot=None)
    payload = service_app.health_payload(state)
    assert payload["status"] == "starting", payload
    assert payload["serving"] is False
    assert payload["not_serving_reason"] == "starting"

    stale = service_app.health_payload(_stale_state())
    assert stale["status"] == "degraded", "a stale snapshot is not a cold start"
    assert stale["not_serving_reason"] == "degraded"


def test_the_probe_honours_a_total_deadline_against_a_dribbling_server() -> None:
    """★ TIMING-SENSITIVE — DO NOT RUN THIS IN PARALLEL. Round-5 Seat 2 measured
    that under a 4-way parallel run this test and its socket siblings can report
    a FALSE PASS on a mutated tree: the deadline they assert is wall-clock, and
    contention moves it. That seat only caught it because its harness carried a
    no-op control that must report MISSED. The shipped suite runs serially, so
    this is a caveat for anyone adding xdist, not a live defect.

    ★★★ PUNCH LIST #8. `urlopen(timeout=)` bounds each SOCKET OPERATION, not
    the call, so a server that sends one byte at a time resets it forever — the
    probe was measured hanging ~20s against a documented 4s. A guarantee that
    is not enforced is not a guarantee.

    MUTANT: drop the worker-thread deadline. This fails (it takes ~4x longer
    than the deadline and the assertion on elapsed time fires).
    """
    import socket
    import threading as _threading
    import time as _time

    from recsys.service.healthcheck import probe

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    stop = _threading.Event()

    def dribble() -> None:
        try:
            conn, _ = listener.accept()
            with conn:
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
                while not stop.is_set():
                    try:
                        conn.sendall(b"x")
                    except OSError:
                        return
                    _time.sleep(0.4)
        except OSError:
            return

    server = _threading.Thread(target=dribble, daemon=True)
    server.start()
    try:
        started = _time.monotonic()
        code = probe(f"http://127.0.0.1:{port}/health", timeout=1.0)
        elapsed = _time.monotonic() - started
    finally:
        stop.set()
        listener.close()

    assert code == 2, f"a dribbling server should read as unreachable, got {code}"
    assert elapsed < 4.0, f"the probe ignored its own deadline: {elapsed:.1f}s"


def test_repeated_forwarded_for_header_lines_are_joined_not_truncated() -> None:
    """★★★ ROUND-5 COUNCIL (Seat 3). `headers.get()` returns only the FIRST
    occurrence, and a client can send `X-Forwarded-For` on several lines. RFC
    7230 §3.2.2 makes repeated fields equivalent to one comma-joined field — so
    reading the first line alone lets a client SHORTEN the chain it is judged
    on: put its own line first, and the proxy's real entry lands in a second
    line this code never saw.

    Both clients below send an identical FIRST line and differ only in the
    second, which is where the proxy's entry lives. If the lines are not joined
    they are indistinguishable and share one budget.

    MUTANT: `self.headers.get("X-Forwarded-For", "")`. This fails.
    """
    import http.client
    import urllib.parse

    state = _offline_state()
    state.config = replace(
        state.config,
        rate_limit_per_minute=2,
        trusted_proxy_hops=1,
        # ★ B10: the loopback peer these tests connect from must be a
        # DECLARED proxy, or X-Forwarded-For is ignored (and it should be).
        trusted_proxy_peers=("127.0.0.1",),
    )

    def get_two_lines(server: _RunningServer, second: str) -> int:
        # ★ `urllib` MERGES repeated headers into one line, so the first version
        # of this test could not send the shape it was written for and passed
        # with the mutant applied. `http.client`'s putheader emits genuinely
        # separate lines, which is what a client would do.
        parsed = urllib.parse.urlparse(server.base_url)
        conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
        try:
            conn.putrequest("GET", "/feed?viewer=alice")
            conn.putheader("X-Forwarded-For", "1.1.1.1")
            conn.putheader("X-Forwarded-For", second)
            conn.endheaders()
            return conn.getresponse().status
        finally:
            conn.close()

    with _RunningServer(state) as server:
        noisy = [get_two_lines(server, "203.0.113.9") for _ in range(4)]
        victim = get_two_lines(server, "198.51.100.7")

    assert noisy[:2] == [200, 200] and noisy[2:] == [429, 429], noisy
    assert victim == 200, (
        "two clients differing only in a SECOND X-Forwarded-For line shared one "
        "rate-limit budget — the header lines are not being joined"
    )
