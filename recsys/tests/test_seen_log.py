"""``recsys.io.seen_log`` — the reader side of seen-post suppression (C8/C9),
and its L1 (RECSYS-LATENCY-BUILD-MAP-2026-09-06) pooled-connection rewrite.

No existing test file covered this module's own I/O layer before this one —
``tests/test_seen.py`` exercises ``recsys.core.seen`` (the pure suppression
logic) only. Offline group (no marker) exercises every function against a
minimal fake, following the exact pattern ``tests/test_lite_engagement.py``
already uses for the sibling reader in the same package.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from recsys.config import LiteConfig
from recsys.io import seen_log

_EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


class _FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]], sink: dict[str, Any]) -> None:
        self._rows, self._sink = rows, sink

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: dict[str, Any]) -> None:
        self._sink["sql"] = sql
        self._sink["params"] = params

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class _FakeConn:
    def __init__(self, rows: list[tuple[Any, ...]], sink: dict[str, Any]) -> None:
        self._rows, self._sink = rows, sink
        self.closed = False

    def __enter__(self) -> _FakeConn:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self._rows, self._sink)

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_seen_local_pool() -> Any:
    """L1: the pool is a module-level dict keyed by dsn, and every test here
    uses the same placeholder dsn — see the identical fixture in
    ``test_lite_engagement.py`` for the full reasoning."""
    seen_log.reset_local_pool()
    yield
    seen_log.reset_local_pool()


def _reader(rows: list[tuple[Any, ...]], monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    sink: dict[str, Any] = {}
    monkeypatch.setattr(seen_log, "_connect", lambda dsn: _FakeConn(rows, sink))
    return sink


# ---------------------------------------------------------------------------
# fetch_seen — the SQL contract and the degrade posture.
# ---------------------------------------------------------------------------


def test_no_dsn_degrades_to_nothing_rather_than_raising() -> None:
    assert seen_log.fetch_seen(LiteConfig(), "alice", window_days=7) == {}


def test_empty_viewer_short_circuits_with_no_query(monkeypatch: pytest.MonkeyPatch) -> None:
    sink = _reader([], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    assert seen_log.fetch_seen(cfg, "", window_days=7) == {}
    assert sink == {}, "an empty viewer must never reach the query"


def test_the_reader_builds_seen_state_from_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    _reader([("@alice/p1", 2, 5, 1767225600.0)], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    out = seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    state = out["@alice/p1"]
    assert state.impressions == 2
    assert state.engagers_at_last_serve == 5
    assert state.last_served_at == 1767225600.0


def test_a_null_engagers_baseline_stays_none_not_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    """NULL means 'we could not tell', which must never collapse into 'zero
    engagement' — that is the strictest possible reading of the least
    reliable data, and it is what makes resurrection meaningful at all."""
    _reader([("@alice/p1", 1, None, 1767225600.0)], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    out = seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    assert out["@alice/p1"].engagers_at_last_serve is None


def test_a_row_with_no_ranked_key_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    _reader([(None, 1, 1, 1767225600.0), ("@alice/p1", 1, 1, 1767225600.0)], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    out = seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    assert list(out.keys()) == ["@alice/p1"]


def test_an_unreachable_datastore_costs_signal_not_the_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(dsn: str) -> None:
        raise OSError("connection refused")

    monkeypatch.setattr(seen_log, "_connect", boom)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    assert seen_log.fetch_seen(cfg, "viewer1", window_days=7) == {}


def test_a_failing_store_trips_the_breaker(monkeypatch: pytest.MonkeyPatch) -> None:
    seen_log.reset_breaker()
    attempts: list[int] = []

    def boom(dsn: str) -> None:
        attempts.append(1)
        raise OSError("connection refused")

    monkeypatch.setattr(seen_log, "_connect", boom)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    for _ in range(10):
        assert seen_log.fetch_seen(cfg, "viewer1", window_days=7) == {}
    assert len(attempts) == seen_log._BREAKER_THRESHOLD, (
        f"the store was dialled {len(attempts)} times while down — the breaker never opened"
    )
    seen_log.reset_breaker()


def test_a_recovered_store_closes_the_breaker(monkeypatch: pytest.MonkeyPatch) -> None:
    seen_log.reset_breaker()
    _reader([], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    assert seen_log.fetch_seen(cfg, "viewer1", window_days=7) == {}
    assert not seen_log._breaker_is_open(0.0)
    seen_log.reset_breaker()


# ---------------------------------------------------------------------------
# L1 (2026-09-06) — pooled loopback connections and RECSYS_LOCAL_POOL.
# ---------------------------------------------------------------------------


def test_local_pool_flag_defaults_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECSYS_LOCAL_POOL", raising=False)
    assert seen_log._local_pool_enabled() is True


@pytest.mark.parametrize("off_value", ["0", "false", "no", "off"])
def test_local_pool_flag_kill_switch_values(
    off_value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RECSYS_LOCAL_POOL", off_value)
    assert seen_log._local_pool_enabled() is False


def test_pooling_opens_one_connection_for_many_fetches(monkeypatch: pytest.MonkeyPatch) -> None:
    connects: list[str] = []

    class _Cursor:
        def __enter__(self) -> _Cursor:
            return self

        def __exit__(self, *exc: object) -> bool:
            return False

        def execute(self, sql: str, params: dict[str, Any]) -> None:
            pass

        def fetchall(self) -> list[tuple[Any, ...]]:
            return []

    class _Conn:
        def __init__(self) -> None:
            self.closed = False

        def cursor(self) -> _Cursor:
            return _Cursor()

        def close(self) -> None:
            self.closed = True

    def counting_connect(dsn: str):  # type: ignore[no-untyped-def]
        connects.append(dsn)
        return _Conn()

    monkeypatch.setattr(seen_log, "_connect", counting_connect)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    for _ in range(5):
        seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    # RECSYS_LOCAL_POOL_MIN default is 2 (review fix, 2026-09-06), so the
    # first borrow also pre-warms one extra idle connection.
    assert len(connects) == 2, f"expected 2 pooled connections for 5 fetches, got {len(connects)}"


def test_local_pool_flag_off_opens_one_connection_per_fetch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECSYS_LOCAL_POOL", "off")
    connects: list[str] = []

    def counting_connect(dsn: str):  # type: ignore[no-untyped-def]
        connects.append(dsn)
        return _FakeConn([], {})

    monkeypatch.setattr(seen_log, "_connect", counting_connect)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    for _ in range(3):
        seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    assert len(connects) == 3, (
        f"expected one connect per fetch with pooling off, got {len(connects)}"
    )


def test_pool_connect_drops_tls_but_direct_connect_is_untouched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_dsns: list[str] = []

    def recording_connect(dsn: str):  # type: ignore[no-untyped-def]
        seen_dsns.append(dsn)
        return _FakeConn([], {})

    monkeypatch.setattr(seen_log, "_connect", recording_connect)
    cfg = LiteConfig(engagement_dsn="postgresql://user:pw@127.0.0.1:5432/lumen_lite")

    seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    assert seen_dsns
    assert all("sslmode=disable" in dsn for dsn in seen_dsns)

    conn = seen_log._connect("postgresql://user:pw@example.com:5432/db")
    assert isinstance(conn, _FakeConn)
    assert seen_dsns[-1] == "postgresql://user:pw@example.com:5432/db"


def test_sslmode_disable_is_never_applied_to_a_non_loopback_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_dsns: list[str] = []

    def recording_connect(dsn: str):  # type: ignore[no-untyped-def]
        seen_dsns.append(dsn)
        return _FakeConn([], {})

    monkeypatch.setattr(seen_log, "_connect", recording_connect)
    cfg = LiteConfig(engagement_dsn="postgresql://user:pw@db.example.com:5432/lumen_lite")

    seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    assert seen_dsns
    assert all("sslmode" not in dsn for dsn in seen_dsns)
    assert all(dsn == cfg.engagement_dsn for dsn in seen_dsns)


def test_sslmode_disable_never_overrides_an_explicit_sslmode_even_on_loopback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_dsns: list[str] = []

    def recording_connect(dsn: str):  # type: ignore[no-untyped-def]
        seen_dsns.append(dsn)
        return _FakeConn([], {})

    monkeypatch.setattr(seen_log, "_connect", recording_connect)
    cfg = LiteConfig(
        engagement_dsn="postgresql://user:pw@127.0.0.1:5432/lumen_lite?sslmode=require"
    )

    seen_log.fetch_seen(cfg, "viewer1", window_days=7)
    assert seen_dsns
    assert all(dsn == cfg.engagement_dsn for dsn in seen_dsns)


def test_pool_exhaustion_falls_back_to_a_direct_connect_not_to_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from recsys.io import hafsql

    seen_log.reset_local_pool()

    class _ExhaustedPool:
        def borrow(self):  # type: ignore[no-untyped-def]
            raise hafsql.PoolExhaustedError("pool exhausted: 16 in use and none released")

    monkeypatch.setattr(seen_log, "_get_pool", lambda dsn: _ExhaustedPool())

    direct_connects: list[str] = []

    def counting_connect(dsn: str):  # type: ignore[no-untyped-def]
        direct_connects.append(dsn)
        return _FakeConn([("@alice/p1", 2, 5, 1767225600.0)], {})

    monkeypatch.setattr(seen_log, "_connect", counting_connect)
    cfg = LiteConfig(engagement_dsn="postgresql://x")

    out = seen_log.fetch_seen(cfg, "viewer1", window_days=7)

    assert direct_connects == ["postgresql://x"]
    assert out, "the fallback connect must still deliver real rows, not {}"


def test_breaker_open_does_not_take_the_direct_connect_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★★★ SECOND REVIEW FIX (2026-09-06). See `lite_engagement`'s identical
    test's own docstring: a breaker-open failure (`HafsqlUnavailableError`,
    not the `PoolExhaustedError` subclass genuine exhaustion raises) must
    fast-fail, never fall back to a direct connect against a database the
    breaker just proved is down."""
    from recsys.io import hafsql

    seen_log.reset_local_pool()

    class _BreakerOpenPool:
        def borrow(self):  # type: ignore[no-untyped-def]
            raise hafsql.HafsqlUnavailableError(
                "circuit breaker open — too many consecutive connection failures"
            )

    monkeypatch.setattr(seen_log, "_get_pool", lambda dsn: _BreakerOpenPool())

    direct_connects: list[str] = []

    def counting_connect(dsn: str):  # type: ignore[no-untyped-def]
        direct_connects.append(dsn)
        return _FakeConn([("@alice/p1", 2, 5, 1767225600.0)], {})

    monkeypatch.setattr(seen_log, "_connect", counting_connect)
    cfg = LiteConfig(engagement_dsn="postgresql://x")

    out = seen_log.fetch_seen(cfg, "viewer1", window_days=7)

    assert direct_connects == [], "breaker-open must fast-fail, never fall back to a direct connect"
    assert out == {}, "breaker-open must degrade to no suppression state for this call"
    seen_log.reset_local_pool()


def test_local_pool_size_env_falls_back_to_the_default_on_a_bad_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECSYS_LOCAL_POOL_MAX", "not-a-number")
    assert seen_log._int_env_or_default("RECSYS_LOCAL_POOL_MAX", 16) == 16


def test_a_query_error_does_not_wedge_the_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    seen_log.reset_breaker()
    conns_opened: list[bool] = []

    class _Cursor:
        def __init__(self, should_raise: bool) -> None:
            self._should_raise = should_raise

        def __enter__(self) -> _Cursor:
            return self

        def __exit__(self, *exc: object) -> bool:
            return False

        def execute(self, sql: str, params: dict[str, Any]) -> None:
            if self._should_raise:
                raise OSError("boom")

        def fetchall(self) -> list[tuple[Any, ...]]:
            return []

    class _Conn:
        def __init__(self, should_raise: bool) -> None:
            self.closed = False
            self._should_raise = should_raise

        def cursor(self) -> _Cursor:
            return _Cursor(self._should_raise)

        def close(self) -> None:
            self.closed = True

    def connect(dsn: str):  # type: ignore[no-untyped-def]
        should_raise = not conns_opened
        conns_opened.append(True)
        return _Conn(should_raise)

    monkeypatch.setattr(seen_log, "_connect", connect)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    assert seen_log.fetch_seen(cfg, "viewer1", window_days=7) == {}
    assert seen_log.fetch_seen(cfg, "viewer1", window_days=7) == {}
    assert len(conns_opened) == 2, "the failed connection must not be reused from idle"
    seen_log.reset_breaker()


def test_the_seen_connection_actually_enforces_a_statement_timeout() -> None:
    """Same live proof `test_lite_engagement.py` runs for its own `_connect`
    — executed against a real reachable Postgres if one is configured for the
    live suite, skipped otherwise."""
    psycopg = pytest.importorskip("psycopg")
    from recsys.config import HafsqlConfig

    cfg = HafsqlConfig()
    dsn = (
        f"host={cfg.host} port={cfg.port} dbname={cfg.dbname} "
        f"user={cfg.user} password={cfg.password}"
    )
    try:
        conn = seen_log._connect(dsn)
    except Exception as exc:
        pytest.skip(f"no reachable PostgreSQL: {type(exc).__name__}: {exc}")
    with conn, conn.cursor() as cur, pytest.raises(psycopg.errors.QueryCanceled):
        cur.execute("SELECT pg_sleep(8)")
