"""B1-P (2026-08-15) — the DURABLE exploration serve log.

★★★ WHAT THIS FILE HAS TO PROVE, and why each proof is shaped the way it is.

The standing feed-balance ruling (2026-08-08 §3/§4/§7) blocks any newcomer
increase until the serve log is persisted, and names the failure precisely:
*"`ExplorationServeLog` is an in-process dict — a restart is a total amnesty,
replicas do not share it, and `graduated()` refunds the whole budget on one
comment."* So the gates here are exactly those three sentences, plus the two
traps that make a naive persistence layer worse than none:

1. **the restart** — a NEW log object against the SAME store must see the old
   counts, and the mutant (no store) must fail;
2. **the replicas** — two logs, one store, one budget;
3. **`merge()` is not enough** — it carries counts only, so a restore through it
   reloads every author with `_seen = 0` and re-creates graduation design #1
   (measured: one author taking 288 of 300 slots). Pinned as a real assertion,
   not a comment;
4. **the refill window survives** — otherwise a reloaded author sits inside a
   window that never elapses and is exiled instead of refilled;
5. **an unreachable store never reaches a feed request** — it degrades to the
   historic in-process behaviour, which fails OPEN.

★ AND THE HONEST LIMIT OF THIS FILE, stated where a reader will see it rather
than in a report: `MemoryServeLogStore` below is a SECOND implementation of the
refill rule, so on its own it proves the LOG, not the SQL. This package has
shipped SQL that never touched a database four separate times, every time
because the tests monkeypatched the connection. Two things answer that here:
`test_the_memory_store_and_postgres_agree_step_for_step` runs the identical
scenario table through both implementations, and
`test_the_shipped_sql_executes_against_a_real_postgres` runs the SHIPPED
CONSTANTS. Both skip — loudly, with the reason — unless
`RECSYS_SERVE_LOG_TEST_DSN` names a database it is allowed to write to.

★ WHAT HAS ALREADY BEEN RUN, so the next reader knows exactly how much of that
warning still applies. On 2026-08-15 all five shipped statements
(`SQL_CREATE_TABLE`'s column definitions, `SQL_CREATE_INDEX`, `SQL_RECORD`,
`SQL_LOAD`, `SQL_DELETE`, `SQL_PRUNE`) were executed against the live
PostgreSQL 16 (`lumen-b12-pg`, database `lite`) with the table created as a
SESSION-TEMP one — so nothing durable was created, no existing row was touched,
and `lumen_feed_served` was verified unchanged at 8,508 rows afterwards. All six
refill scenarios in `_SCENARIOS` produced the values the Python reference
produces, including the two that carry the type-inference risk (a NULL clock,
and lifetime mode leaving `window_start` NULL).

So the SQL is NOT unexecuted code. What is still unproven is the store's own
CONNECTION path — the real `CREATE TABLE IF NOT EXISTS` against a permanent
schema, the statement timeout, the breaker, the held connection — which is what
these two tests cover and what `RECSYS_SERVE_LOG_TEST_DSN` is for.
"""

from __future__ import annotations

import logging
import os

import pytest

from recsys.serve_log import ExplorationServeLog
from recsys.serve_log_store import (
    DSN_ENV,
    ENABLE_ENV,
    LITE_DSN_ENV,
    SQL_CREATE_INDEX,
    SQL_CREATE_TABLE,
    SQL_DELETE,
    SQL_LOAD,
    SQL_PRUNE,
    SQL_RECORD,
    PostgresServeLogStore,
    ServeRow,
    store_from_env,
)

WINDOW_S = 7 * 86400.0
_TEST_DSN_ENV = "RECSYS_SERVE_LOG_TEST_DSN"
#: Every author this file writes carries this prefix so the Postgres tests can
#: clean up after themselves without touching a row they did not create.
_PREFIX = "pytest-serve-log-"


class MemoryServeLogStore:
    """A `ServeLogStore` that keeps rows in a dict — the DURABLE SUBSTRATE.

    Read the object lifetimes carefully, because they are the test design: the
    STORE is the database and outlives everything; an `ExplorationServeLog` is
    ONE PROCESS. "Restart the service" is therefore "throw the log away and
    build a new one against the same store", which is exactly what the shipped
    code does at boot.

    The refill branch below is transcribed from `serve_log_store.SQL_RECORD`,
    which is transcribed from `ExplorationServeLog.record`. Three copies of one
    rule is two too many, and the differential test in this file exists because
    of it.
    """

    def __init__(
        self,
        *,
        retention_s: float = 30 * 86400.0,
        fail: bool = False,
    ) -> None:
        self.rows: dict[str, ServeRow] = {}
        self._retention_s = retention_s
        #: Simulates an unreachable store: every method answers "no" the way the
        #: real one does after its `except` — `None`, never an exception.
        self.fail = fail
        self.loads = 0

    @property
    def retention_s(self) -> float:
        return self._retention_s

    def load(self) -> dict[str, ServeRow] | None:
        self.loads += 1
        if self.fail:
            return None
        return dict(self.rows)

    def record(
        self, author: str, *, seen: int, now: float | None, window_s: float
    ) -> ServeRow | None:
        if self.fail:
            return None
        existing = self.rows.get(author)
        if existing is None:
            row = ServeRow(
                author=author,
                count=1,
                window_start=now if (window_s > 0 and now is not None) else None,
                seen=seen,
            )
        elif (
            window_s > 0
            and now is not None
            and (existing.window_start is None or now - existing.window_start >= window_s)
        ):
            row = ServeRow(author=author, count=1, window_start=now, seen=seen)
        else:
            row = ServeRow(
                author=author,
                count=existing.count + 1,
                window_start=existing.window_start,
                seen=seen,
            )
        self.rows[author] = row
        return row

    def delete(self, author: str) -> None:
        if self.fail:
            return
        self.rows.pop(author, None)


# ---------------------------------------------------------------------------
# 1. THE RESTART — blocker 2 of the 2026-08-08 ruling.
# ---------------------------------------------------------------------------


def test_a_restart_no_longer_resets_the_budget() -> None:
    """★★★ THE HEADLINE GATE.

    "A restart is a total amnesty on every serve count" is the sentence the
    ruling blocks the newcomer increase on. This is that sentence, executed.

    MUTANT: build the second log with `store=None` — the second half of this
    test asserts the mutant, so a persistence layer that quietly stopped working
    could not pass by accident.
    """
    store = MemoryServeLogStore()

    first_process = ExplorationServeLog(store=store)
    for _ in range(3):
        first_process.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    assert first_process.counts(now=1000.0, window_s=WINDOW_S) == {"newcomer": 3}

    del first_process  # deploy

    second_process = ExplorationServeLog(store=store)
    assert second_process.counts(now=1000.0, window_s=WINDOW_S) == {"newcomer": 3}, (
        "the budget did not survive a restart — this is the amnesty the "
        "2026-08-08 ruling blocks the newcomer increase on"
    )

    # The mutant, asserted rather than described: with no store the amnesty is
    # exactly what happens, which is what this whole module exists to end.
    assert ExplorationServeLog(store=None).counts(now=1000.0, window_s=WINDOW_S) == {}


def test_two_replicas_share_one_budget() -> None:
    """"Replicas do not share it, so the effective budget is
    `max_serves_per_author * replicas`" — the second clause of the same ruling
    sentence. Two logs, one store, one budget.

    `reload_interval_s=0` makes the convergence immediate; in production it is
    60s, which is noise against a 7-day window.
    """
    store = MemoryServeLogStore()
    pod_a = ExplorationServeLog(store=store, reload_interval_s=0.0)
    pod_b = ExplorationServeLog(store=store, reload_interval_s=0.0)

    pod_a.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    pod_a.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)

    assert pod_b.counts(now=1000.0, window_s=WINDOW_S) == {"newcomer": 2}, (
        "pod B cannot see pod A's serves, so a two-pod deployment silently "
        "doubles this ranking bound"
    )
    # And the third serve — charged by the OTHER pod — is the author's last.
    pod_b.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    assert pod_a.counts(now=1000.0, window_s=WINDOW_S) == {"newcomer": 3}


# ---------------------------------------------------------------------------
# 2. THE THREE MAPS — why `merge()` was never enough.
# ---------------------------------------------------------------------------


def test_the_graduation_baseline_survives_a_restart() -> None:
    """★★★ THE TRAP A COUNTS-ONLY RESTORE WALKS INTO.

    `graduated()` returns authors whose engager count has GROWN SINCE THEIR LAST
    SERVE, and "since their last serve" lives in `_seen`. Restore counts alone
    and every author reloads at `seen = 0`, so anyone with any engagement at all
    graduates immediately — which is design #1 in `graduated`'s own docstring,
    the one measured at ONE AUTHOR TAKING 288 OF 300 SLOTS.

    Here the author had 2 engagers when their slot was spent and still has 2.
    They must NOT graduate.
    """
    store = MemoryServeLogStore()
    before = ExplorationServeLog(store=store)
    before.record(["newcomer"], {"newcomer": 2}, now=1000.0, window_s=WINDOW_S)
    del before

    after = ExplorationServeLog(store=store)
    assert after.graduated({"newcomer": 2}) == [], (
        "a restart refunded a budget that was never earned — the reloaded "
        "baseline is wrong"
    )
    # And real growth still graduates, so the guard is not simply stuck shut.
    assert after.graduated({"newcomer": 3}) == ["newcomer"]


def test_merge_alone_cannot_do_this_job() -> None:
    """The seam `serve_log.py` promised persistence through, shown falling short.

    Not a criticism of `merge()` — it does exactly what it says. It is here so
    the next person who reads "merge() exists so a caller CAN persist and
    restore" does not implement durability with it and re-open graduation.
    """
    counts_only = ExplorationServeLog(store=None)
    counts_only.merge({"newcomer": 1})
    assert counts_only.graduated({"newcomer": 2}) == ["newcomer"], (
        "expected the counts-only restore to spuriously graduate; if this ever "
        "stops being true, the note in serve_log.py's header needs rewriting"
    )


def test_the_refill_window_survives_a_restart() -> None:
    """`serve_window_days` is what makes this budget a chance rather than an
    exile (+71-101% newcomer reach, measured 2026-08-06). It lives in
    `_window_start`, so it has to round-trip too — and in BOTH directions:

    * inside the window, a restarted process must still see the author as spent;
    * past the window, a restarted process must still refill them.

    A restore that dropped `window_start` gets the second one wrong in the
    cruellest way: `record` treats an absent start as "no window recorded", so
    the author reads as spent forever from the log's point of view while
    `counts()` never expires them.
    """
    store = MemoryServeLogStore()
    first = ExplorationServeLog(store=store)
    first.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    del first

    second = ExplorationServeLog(store=store)
    # One hour later: still inside the 7-day window, still spent.
    assert second.counts(now=1000.0 + 3600, window_s=WINDOW_S) == {"newcomer": 1}
    # Eight days later: the window has elapsed, the budget reads as fresh.
    assert second.counts(now=1000.0 + 8 * 86400, window_s=WINDOW_S) == {"newcomer": 0}


def test_a_serve_after_the_window_elapses_starts_a_fresh_window_durably() -> None:
    """The refill's write side, across a restart: the second serve must OPEN a
    new window at 1, not increment to 2."""
    store = MemoryServeLogStore()
    first = ExplorationServeLog(store=store)
    first.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    del first

    second = ExplorationServeLog(store=store)
    later = 1000.0 + 8 * 86400
    second.record(["newcomer"], {"newcomer": 0}, now=later, window_s=WINDOW_S)
    assert second.counts(now=later, window_s=WINDOW_S) == {"newcomer": 1}
    assert store.rows["newcomer"].window_start == later


def test_lifetime_mode_leaves_no_window_start_behind() -> None:
    """★ `serve_window_days = 0` (lifetime cap) must not persist a window start.

    The in-process log never records one in that mode. If the store wrote `now`
    anyway, a later config change to a windowed budget would read the author as
    being INSIDE a window that began in the lifetime era and increment where the
    in-process log would have reset to 1 — a silent divergence between two
    behaviours that are supposed to be byte-identical.
    """
    store = MemoryServeLogStore()
    log = ExplorationServeLog(store=store)
    log.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=0.0)
    assert store.rows["newcomer"].window_start is None


# ---------------------------------------------------------------------------
# 3. GRADUATION IS WRITTEN THROUGH.
# ---------------------------------------------------------------------------


def test_clear_is_written_through_or_graduation_is_undone_by_the_next_reload() -> None:
    """A graduation that only cleared the local dict would be reversed by the
    next reload, silently re-retiring an author who had earned their budget
    back. That failure is invisible: the author simply stops appearing."""
    store = MemoryServeLogStore(retention_s=30 * 86400.0)
    log = ExplorationServeLog(store=store, reload_interval_s=0.0)
    log.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    assert "newcomer" in store.rows

    log.clear("newcomer")
    assert "newcomer" not in store.rows
    assert log.counts(now=1000.0, window_s=WINDOW_S) == {}
    # And a fresh process agrees.
    assert ExplorationServeLog(store=store).counts(now=1000.0, window_s=WINDOW_S) == {}


# ---------------------------------------------------------------------------
# 4. DEGRADE — an optional store must never reach a feed request.
# ---------------------------------------------------------------------------


def test_an_unreachable_store_degrades_to_the_historic_in_process_behaviour() -> None:
    """The direction matters and it is deliberate: this fails OPEN (authors
    become eligible again), which is what the lane did before durability existed
    and is the correct direction for a discovery lane. What it must never do is
    raise — `record` runs inside `rank_feed`."""
    store = MemoryServeLogStore(fail=True)
    log = ExplorationServeLog(store=store)
    log.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    log.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    assert log.counts(now=1000.0, window_s=WINDOW_S) == {"newcomer": 2}
    log.clear("newcomer")
    assert log.counts(now=1000.0, window_s=WINDOW_S) == {}


def test_a_reload_never_lowers_a_count_that_failed_to_write() -> None:
    """★ The subtle one. While the store is down the local count is AHEAD of the
    durable one. A reload that adopted the stale durable value wholesale would
    hand a free extra slot to whoever was being served during the outage — a
    fail-OPEN on the one counter whose entire job is to fail SHUT."""
    store = MemoryServeLogStore()
    log = ExplorationServeLog(store=store, reload_interval_s=0.0)
    log.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)

    store.fail = True  # the store goes away mid-session
    log.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    assert log.counts(now=1000.0, window_s=WINDOW_S) == {"newcomer": 2}

    store.fail = False  # …and comes back, still holding the stale 1
    assert log.counts(now=1000.0, window_s=WINDOW_S) == {"newcomer": 2}, (
        "the reload lowered a count the store never managed to persist"
    )


def test_a_retention_shorter_than_the_budget_window_is_reported(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A store that prunes rows faster than the budget forgives them is a
    SILENT AMNESTY wearing a configuration. Logged at ERROR rather than raised:
    refusing to start over a retention setting would take the feed down for a
    durability problem."""
    store = MemoryServeLogStore(retention_s=86400.0)  # 1 day vs a 7-day window
    log = ExplorationServeLog(store=store)
    with caplog.at_level(logging.ERROR, logger="recsys.serve_log"):
        log.record(["newcomer"], {"newcomer": 0}, now=1000.0, window_s=WINDOW_S)
    assert any("RETENTION" in r.getMessage() for r in caplog.records), caplog.text


# ---------------------------------------------------------------------------
# 5. THE SWITCH — off by default, loud when misconfigured.
# ---------------------------------------------------------------------------


def test_the_flag_is_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """C7: everything new ships behind a flag, default OFF, byte-identical when
    off. With the flag unset there is no store at all — not a store pointed at
    nothing, no store — so not one query is issued."""
    monkeypatch.delenv(ENABLE_ENV, raising=False)
    monkeypatch.setenv(LITE_DSN_ENV, "postgresql://never/used")
    assert store_from_env() is None
    assert ExplorationServeLog()._store is None


def test_the_flag_on_with_no_dsn_is_loud_not_silent(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """"Persistence is on" and "persistence is silently off" produce identical
    feeds, and only one of them is what the operator asked for. This package has
    shipped that exact ambiguity before."""
    monkeypatch.setenv(ENABLE_ENV, "1")
    monkeypatch.delenv(DSN_ENV, raising=False)
    monkeypatch.delenv(LITE_DSN_ENV, raising=False)
    with caplog.at_level(logging.ERROR, logger="recsys.serve_log_store"):
        assert store_from_env() is None
    assert any(ENABLE_ENV in r.getMessage() for r in caplog.records), caplog.text


def test_an_explicit_store_of_none_never_consults_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ The sentinel earns its keep here. Every unit test, measurement panel and
    harness attack constructs `ExplorationServeLog()` or passes `store=None`; if
    those two were indistinguishable, a suite run on a machine with the deploy
    environment loaded would start writing to a production DSN."""
    monkeypatch.setenv(ENABLE_ENV, "1")
    monkeypatch.setenv(LITE_DSN_ENV, "postgresql://never/used")
    assert ExplorationServeLog(store=None)._store is None


# ---------------------------------------------------------------------------
# 6. THE SQL. Skipped — loudly — unless a writable test DSN is named.
# ---------------------------------------------------------------------------

#: The scenario table both implementations are run through. Each row is
#: `(label, [(seen, now, window_s), ...], expected_count, expected_window_start)`
#: where `expected_window_start` is a callable over the step list so the
#: lifetime/refill cases can express "None" and "the last reset's clock".
_SCENARIOS: list[tuple[str, list[tuple[int, float | None, float]], int, float | None]] = [
    ("first serve, windowed", [(0, 1000.0, WINDOW_S)], 1, 1000.0),
    ("first serve, lifetime", [(0, 1000.0, 0.0)], 1, None),
    (
        "three inside one window",
        [(0, 1000.0, WINDOW_S), (0, 2000.0, WINDOW_S), (1, 3000.0, WINDOW_S)],
        3,
        1000.0,
    ),
    (
        "the window elapses and the budget refills at 1",
        [(0, 1000.0, WINDOW_S), (0, 1000.0 + 8 * 86400, WINDOW_S)],
        1,
        1000.0 + 8 * 86400,
    ),
    (
        "lifetime mode never refills",
        [(0, 1000.0, 0.0), (0, 1000.0 + 400 * 86400, 0.0)],
        2,
        None,
    ),
    (
        "a null clock cannot open a window",
        [(0, None, WINDOW_S), (0, None, WINDOW_S)],
        2,
        None,
    ),
]


def _run_scenario(store: object, author: str, steps: list[tuple[int, float | None, float]]):
    row = None
    for seen, now, window_s in steps:
        row = store.record(author, seen=seen, now=now, window_s=window_s)  # type: ignore[attr-defined]
    return row


def _pg_store() -> PostgresServeLogStore:
    dsn = os.environ.get(_TEST_DSN_ENV)
    if not dsn:
        pytest.skip(
            f"{_TEST_DSN_ENV} is not set, so the SHIPPED SQL in "
            "recsys/serve_log_store.py has NOT been executed. This project has "
            "shipped never-executed SQL four times; run "
            f"`{_TEST_DSN_ENV}=postgresql://... pytest tests/test_serve_log_store.py` "
            "against a database you are allowed to write to before trusting it."
        )
    pytest.importorskip("psycopg")
    return PostgresServeLogStore(dsn)


def _pg_cleanup(store: PostgresServeLogStore) -> None:
    # `_run` is private; the test owns the rows it wrote and cleaning them up
    # through the same connection is cheaper than a second client.
    store._run(
        "DELETE FROM recsys_exploration_serve WHERE author LIKE %(prefix)s",
        {"prefix": _PREFIX + "%"},
        fetch="none",
    )


def test_the_shipped_sql_executes_against_a_real_postgres() -> None:
    """★★★ THE GATE THAT HAS BEEN MISSING FOUR TIMES IN THIS PACKAGE.

    Runs the SHIPPED CONSTANTS — `SQL_CREATE_TABLE`, `SQL_CREATE_INDEX`,
    `SQL_RECORD`, `SQL_LOAD`, `SQL_DELETE`, `SQL_PRUNE` — not a copy, against a
    real server. It proves syntax and parameter BINDING, which is what has
    failed every previous time (`(a, b) = ANY(%(keys)s)` raising
    `FeatureNotSupported: input of anonymous composite types is not
    implemented`, swallowed into a WARNING on every request forever).

    MUTANT: break any placeholder name or the `ON CONFLICT` target. This fails.
    """
    store = _pg_store()
    author = _PREFIX + "sql"
    try:
        assert store.load() is not None, "the store could not even read its table"
        row = store.record(author, seen=0, now=1000.0, window_s=WINDOW_S)
        assert row == ServeRow(author=author, count=1, window_start=1000.0, seen=0)
        row = store.record(author, seen=2, now=2000.0, window_s=WINDOW_S)
        assert row == ServeRow(author=author, count=2, window_start=1000.0, seen=2)
        loaded = store.load()
        assert loaded is not None and loaded[author].count == 2
        store.delete(author)
        loaded = store.load()
        assert loaded is not None and author not in loaded
        # The prune statement binds too — with a huge retention it deletes
        # nothing, which is the point: this asserts the SQL runs, not that it
        # removes anybody's rows.
        store._run(SQL_PRUNE, {"retention_s": 10_000 * 86400.0}, fetch="none")
        for statement in (SQL_CREATE_TABLE, SQL_CREATE_INDEX, SQL_LOAD, SQL_RECORD, SQL_DELETE):
            assert statement.strip(), "a shipped statement is empty"
    finally:
        _pg_cleanup(store)
        store.close()


@pytest.mark.parametrize(
    ("label", "steps", "expected_count", "expected_window"),
    _SCENARIOS,
    ids=[s[0] for s in _SCENARIOS],
)
def test_the_memory_store_and_postgres_agree_step_for_step(
    label: str,
    steps: list[tuple[int, float | None, float]],
    expected_count: int,
    expected_window: float | None,
) -> None:
    """★★★ THE DIFFERENTIAL GATE.

    The refill rule now exists in three places: `ExplorationServeLog.record`
    (Python), `SQL_RECORD` (SQL), and `MemoryServeLogStore.record` (this file's
    reference). Three copies of one rule is two too many, and a divergence would
    show up as a budget that behaves differently in production than in every
    test — the worst possible shape.

    So the same scenarios run through both stores and must agree exactly.

    ALSO RUNS THE MEMORY STORE ALONE when no DSN is configured, because the
    expectations are pinned literals rather than "whatever the other one did" —
    a differential test that skips entirely when one side is missing proves
    nothing about the side that is present.
    """
    memory = MemoryServeLogStore()
    author = _PREFIX + label.replace(" ", "-")[:40]
    mem_row = _run_scenario(memory, author, steps)
    assert mem_row is not None
    assert (mem_row.count, mem_row.window_start) == (expected_count, expected_window)

    if not os.environ.get(_TEST_DSN_ENV):
        pytest.skip(
            f"{_TEST_DSN_ENV} unset — the memory reference passed, but SQL_RECORD "
            "has not been compared against it. See this module's docstring."
        )
    store = _pg_store()
    try:
        _pg_cleanup(store)
        pg_row = _run_scenario(store, author, steps)
        assert pg_row is not None
        assert (pg_row.count, pg_row.window_start) == (mem_row.count, mem_row.window_start), (
            f"SQL_RECORD and the reference disagree on '{label}' — one of the "
            "three copies of the refill rule has drifted"
        )
    finally:
        _pg_cleanup(store)
        store.close()


def test_constructor_counts_are_not_lost_when_a_store_is_attached() -> None:
    """★ A reload replaces all three maps with durable truth, which would
    silently discard anything the constructor was handed. Folded back with
    `merge`'s MAX rule instead — and NOT written through, because seeding is a
    harness convenience and persisting it would mass-charge authors nobody
    served."""
    store = MemoryServeLogStore()
    ExplorationServeLog(store=store).record(
        ["known"], {"known": 0}, now=1000.0, window_s=WINDOW_S
    )

    seeded = ExplorationServeLog({"known": 5, "seeded-only": 2}, store=store)
    assert seeded.counts() == {"known": 5, "seeded-only": 2}
    assert "seeded-only" not in store.rows, "a seeded count was charged to the store"
