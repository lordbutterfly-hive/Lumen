"""A9 — ``recsys.viewer`` tests.

Offline group (no marker) exercises every function against a minimal
in-memory ``_FakeFetchGateway`` that dispatches on a substring of the SQL —
deliberately a NEW, narrow fake defined in this file rather than an addition
to the shared ``tests/fakes.py`` (which predates A9, has no ``_fetch``
method, and is under concurrent edit by another builder this phase — adding
to it risks a collision with work this builder does not have visibility
into).

Live group (``@pytest.mark.live`` / ``RECSYS_LIVE_DB``) proves the whole
thing against the real HAFSQL mirror, including the two operational
findings this builder made while building it (see the module docstrings on
``recsys.viewer`` for the full detail):

  * the voting-history sub-query has no usable index on ``voter`` alone and
    is measured live at up to the full 15s statement timeout for an account
    that has never voted — guarded by a cheap existence pre-check
    (``_SQL_HAS_EVER_VOTED``), proven here to turn a ~15s call into a
    sub-second one for a real never-voted account name;
  * R12's tagless-viewer floor: a ``ViewerProfile`` built here with
    genuinely no derivable history still reaches a NON-EMPTY feed through
    ``pipeline.gather_candidates``'s popular-fallback path — proven with a
    real ``rank_feed`` call, not just an empty-set assertion on the profile.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from recsys.config import DEFAULT_SETTINGS, HafsqlConfig, LiteConfig
from recsys.contracts import CandidateSource
from recsys.io import hafsql
from recsys.pipeline import TrustPolicy, rank_feed
from recsys.viewer import (
    _SQL_RECENT_VOTES_BY_V2,
    _VOTE_HISTORY_TIMEOUT_MS,
    DEFAULT_MAX_INTEREST_TAGS,
    _vote_history_v2_enabled,
    build_viewer_profile,
    derive_interest_tags,
    follows_of,
    mutes_of,
)
from tests.fakes import EPOCH, FakeGateway, make_post

_live = pytest.mark.skipif(
    not os.environ.get("RECSYS_LIVE_DB"),
    reason="RECSYS_LIVE_DB not set — live-mirror suite opted out (offline by default)",
)


#: Far past every test's `since` window (all of them sit within a few
#: hundred days of `EPOCH`, imported below), used to stamp the V2 fake's
#: synthesized `"timestamp"` column so every EXISTING `vote_rows` fixture
#: (a list of plain (author, permlink) pairs, written before Q1 existed)
#: survives Q1's now-default-on rewrite unchanged: those fixtures are
#: testing own-post-vs-vote WEIGHTING, capping, tie-breaks, and the
#: failure/degrade paths — not Q1's own since-filter, which gets its own
#: dedicated tests below — so they must never be silently filtered out by
#: a since-window comparison they were never written to satisfy.
_FAR_FUTURE_NAIVE = datetime(2999, 1, 1)


class _FakeFetchGateway:
    """The one method `recsys.viewer` needs (`_fetch`), dispatched on a
    distinctive SQL substring so one fake can stand in for all four queries
    this module issues (five since Q1 added `_SQL_RECENT_VOTES_BY_V2`)."""

    def __init__(
        self,
        *,
        follows: list[str] | None = None,
        mutes: list[str] | None = None,
        own_post_rows: list[tuple[Any, str]] | None = None,
        has_ever_voted: bool = False,
        vote_rows: list[tuple[str, str]] | None = None,
        vote_rows_v2: list[tuple[str, str, datetime]] | None = None,
        voted_tag_rows: list[tuple[Any, str]] | None = None,
        raise_on_has_voted: Exception | None = None,
        raise_on_recent_votes: Exception | None = None,
        raise_on_recent_votes_v2_only: Exception | None = None,
        raise_on_tag_lookup: Exception | None = None,
    ) -> None:
        self._follows = follows or []
        self._mutes = mutes or []
        self._own_post_rows = own_post_rows or []
        self._has_ever_voted = has_ever_voted
        self._vote_rows = vote_rows or []
        #: Q1 (2026-09-06): explicit (author, permlink, timestamp) rows for
        #: tests that exercise the V2 SQL's OWN since-filter directly. `None`
        #: (the default) falls back to `_vote_rows` stamped at
        #: `_FAR_FUTURE_NAIVE` — see that constant's own docstring.
        self._vote_rows_v2 = vote_rows_v2
        self._voted_tag_rows = voted_tag_rows or []
        self._raise_on_has_voted = raise_on_has_voted
        self._raise_on_recent_votes = raise_on_recent_votes
        #: Fires ONLY for the V2 (`ORDER BY id DESC`) SQL, never V1 — models
        #: a STRUCTURAL V2-only failure (e.g. `UndefinedColumn: id`) so a
        #: test can prove V1 still succeeds as the fallback. `raise_on_
        #: recent_votes` above fires for BOTH shapes and cannot express this.
        self._raise_on_recent_votes_v2_only = raise_on_recent_votes_v2_only
        self._raise_on_tag_lookup = raise_on_tag_lookup
        self.calls: list[tuple[str, dict[str, Any]]] = []
        #: SQL text of the last call of each kind — additive, so it does not
        #: disturb any existing `gateway.calls == [...]` assertion (those
        #: check the 2-tuple `calls` list, unchanged).
        self.last_sql: dict[str, str] = {}

    def _fetch(
        self, sql: str, params: dict[str, Any], *, timeout_ms: int | None = None
    ) -> list[tuple[Any, ...]]:
        if "FROM hafsql.follows" in sql:
            self.calls.append(("follows", params))
            return [(f,) for f in self._follows]
        if "FROM hafsql.mutes" in sql:
            self.calls.append(("mutes", params))
            return [(m,) for m in self._mutes]
        if "LIMIT 1" in sql and "operation_effective_comment_vote_view" in sql:
            self.calls.append(("has_ever_voted", params))
            if self._raise_on_has_voted is not None:
                raise self._raise_on_has_voted
            return [(1,)] if self._has_ever_voted else []
        if "operation_effective_comment_vote_view" in sql:
            self.calls.append(("recent_votes", params))
            self.last_sql["recent_votes"] = sql
            if self._raise_on_recent_votes is not None:
                raise self._raise_on_recent_votes
            if "ORDER BY id DESC" in sql:
                if self._raise_on_recent_votes_v2_only is not None:
                    raise self._raise_on_recent_votes_v2_only
                if self._vote_rows_v2 is not None:
                    return list(self._vote_rows_v2)
                return [(a, p, _FAR_FUTURE_NAIVE) for a, p in self._vote_rows]
            return list(self._vote_rows)
        if "unnest(" in sql:
            self.calls.append(("tag_lookup", params))
            if self._raise_on_tag_lookup is not None:
                raise self._raise_on_tag_lookup
            return list(self._voted_tag_rows)
        if "FROM hafsql.comments" in sql:
            self.calls.append(("own_posts", params))
            return list(self._own_post_rows)
        raise AssertionError(f"_FakeFetchGateway: unrecognized SQL: {sql!r}")


# ---------------------------------------------------------------------------
# follows_of / mutes_of
# ---------------------------------------------------------------------------


def test_follows_of_returns_the_followed_set() -> None:
    gateway = _FakeFetchGateway(follows=["alice", "bob"])
    assert follows_of(gateway, "viewer1") == frozenset({"alice", "bob"})
    assert gateway.calls == [("follows", {"account": "viewer1"})]


def test_follows_of_empty() -> None:
    gateway = _FakeFetchGateway()
    assert follows_of(gateway, "viewer1") == frozenset()


def test_mutes_of_returns_the_muted_set_from_the_dedicated_mutes_table() -> None:
    """A9.2 pin: mutes come from `hafsql.mutes` (a DIFFERENT table from
    `hafsql.follows`), per this module's own live-verified finding that
    `hafsql.follows` carries no follow_type/state column at all."""
    gateway = _FakeFetchGateway(mutes=["spammer1", "spammer2"])
    assert mutes_of(gateway, "viewer1") == frozenset({"spammer1", "spammer2"})
    assert gateway.calls == [("mutes", {"account": "viewer1"})]


# ---------------------------------------------------------------------------
# derive_interest_tags
# ---------------------------------------------------------------------------


def test_derive_interest_tags_weighs_own_posts_above_votes() -> None:
    """An own-post tag (weight 3.0, one occurrence) must outrank a
    vote-derived tag that appears more often but at weight 1.0 each, as long
    as the arithmetic still favors it — proves the weighting is actually
    applied, not just present in a comment."""
    gateway = _FakeFetchGateway(
        own_post_rows=[(["photography"], "photography")],
        has_ever_voted=True,
        vote_rows=[("author2", "p1"), ("author3", "p2")],
        voted_tag_rows=[(["gaming"], "gaming"), (["gaming"], "gaming")],
    )
    tags = derive_interest_tags(gateway, "viewer1", now=EPOCH + timedelta(days=1))
    # photography: 1 own post * weight 3.0 = 3.0
    # gaming: 2 votes * weight 1.0 = 2.0
    assert tags == frozenset({"photography", "gaming"})


def test_derive_interest_tags_caps_at_max_tags_deterministically() -> None:
    own_rows = [([f"tag{i}"], f"tag{i}") for i in range(10)]
    gateway = _FakeFetchGateway(own_post_rows=own_rows, has_ever_voted=False)
    tags = derive_interest_tags(
        gateway, "viewer1", now=EPOCH + timedelta(days=1), max_tags=3
    )
    assert len(tags) == 3
    # All ties at weight 3.0 -> deterministic alphabetical tie-break.
    assert tags == frozenset({"tag0", "tag1", "tag2"})


def test_derive_interest_tags_returns_empty_for_no_history() -> None:
    gateway = _FakeFetchGateway(has_ever_voted=False)
    assert derive_interest_tags(gateway, "brandnew", now=EPOCH) == frozenset()


def test_derive_interest_tags_skips_the_expensive_vote_query_when_never_voted() -> None:
    """A9.2/reliability finding: `_SQL_HAS_EVER_VOTED` must gate
    `_SQL_RECENT_VOTES_BY` — the whole point of the pre-check is to never run
    the expensive query for an account that has never voted."""
    gateway = _FakeFetchGateway(has_ever_voted=False)
    derive_interest_tags(gateway, "viewer1", now=EPOCH)
    kinds = [kind for kind, _ in gateway.calls]
    assert "has_ever_voted" in kinds
    assert "recent_votes" not in kinds


def test_derive_interest_tags_survives_a_failing_vote_history_query(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Reliability finding: `_SQL_RECENT_VOTES_BY` is measured live to
    sometimes hit the statement timeout even past the existence guard (a
    quiet-but-not-zero account). This must degrade to own-posts-only tags,
    never propagate and break the whole viewer-profile build.

    Raises the REAL `psycopg.errors.QueryCanceled` a statement-timeout
    actually produces (not a generic `TimeoutError`) — since the FOURTH
    REVIEW FIX (2026-09-06) distinguishes `psycopg.OperationalError` from a
    structural V2 failure by TYPE, a fake modelling this with the wrong
    exception class would wrongly latch `_v2_disabled_for_process` as a side
    effect and leak state into whichever test runs next."""
    import psycopg

    gateway = _FakeFetchGateway(
        own_post_rows=[(["cooking"], "cooking")],
        has_ever_voted=True,
        raise_on_recent_votes=psycopg.errors.QueryCanceled("simulated statement timeout"),
    )
    with caplog.at_level(logging.WARNING, logger="recsys.viewer"):
        tags = derive_interest_tags(gateway, "viewer1", now=EPOCH + timedelta(days=1))
    assert tags == frozenset({"cooking"})
    assert "voting-history query failed" in caplog.text


def test_derive_interest_tags_survives_a_failing_tag_lookup_query(
    caplog: pytest.LogCaptureFixture,
) -> None:
    gateway = _FakeFetchGateway(
        own_post_rows=[(["cooking"], "cooking")],
        has_ever_voted=True,
        vote_rows=[("author2", "p1")],
        raise_on_tag_lookup=RuntimeError("simulated connection loss"),
    )
    with caplog.at_level(logging.WARNING, logger="recsys.viewer"):
        tags = derive_interest_tags(gateway, "viewer1", now=EPOCH + timedelta(days=1))
    assert tags == frozenset({"cooking"})
    assert "voted-post tag lookup failed" in caplog.text


def test_derive_interest_tags_survives_the_has_ever_voted_precheck_itself_failing() -> None:
    gateway = _FakeFetchGateway(
        own_post_rows=[(["cooking"], "cooking")],
        raise_on_has_voted=TimeoutError("simulated"),
    )
    tags = derive_interest_tags(gateway, "viewer1", now=EPOCH + timedelta(days=1))
    assert tags == frozenset({"cooking"})


def test_derive_interest_tags_windows_votes_by_quality_prior_days() -> None:
    """★ Q1-UPDATED (2026-09-06). With `RECSYS_VOTE_HISTORY_V2` default ON,
    `quality_prior_days` no longer reaches the mirror as a `since` SQL
    parameter (`_SQL_RECENT_VOTES_BY_V2` carries none — see its own
    comment) — the window is now enforced client-side against the id-ordered
    page's own timestamp column. This proves that FILTER instead of the SQL
    parameter it replaced: an in-window vote must still reach the tag lookup
    and an out-of-window one must not, using the exact `quality_prior_days`
    boundary this test always pinned.
    """
    now = EPOCH + timedelta(days=100)
    window_days = DEFAULT_SETTINGS.history.quality_prior_days
    inside = (now - timedelta(days=window_days - 1)).replace(tzinfo=None)
    outside = (now - timedelta(days=window_days + 1)).replace(tzinfo=None)
    gateway = _FakeFetchGateway(
        has_ever_voted=True,
        vote_rows_v2=[("author_in", "p_in", inside), ("author_out", "p_out", outside)],
        voted_tag_rows=[(["kept"], "kept")],
    )
    derive_interest_tags(gateway, "viewer1", now=now, settings=DEFAULT_SETTINGS)
    tag_lookup_calls = [p for kind, p in gateway.calls if kind == "tag_lookup"]
    assert tag_lookup_calls, "the in-window vote must still reach the tag lookup"
    assert tag_lookup_calls[0]["authors"] == ["author_in"], (
        "a vote older than quality_prior_days must be dropped client-side, "
        "and one inside it must survive"
    )


def test_derive_interest_tags_windows_votes_by_quality_prior_days_with_v2_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pre-2026-09-06 behaviour (`since` as a SQL parameter) must still
    work byte-for-byte with the kill switch set — this is the regression
    protection for an operator who has to revert Q1."""
    monkeypatch.setenv("RECSYS_VOTE_HISTORY_V2", "off")
    gateway = _FakeFetchGateway(has_ever_voted=True)
    now = EPOCH + timedelta(days=100)
    derive_interest_tags(gateway, "viewer1", now=now, settings=DEFAULT_SETTINGS)
    recent_votes_calls = [p for kind, p in gateway.calls if kind == "recent_votes"]
    assert recent_votes_calls
    expected_since = now - timedelta(days=DEFAULT_SETTINGS.history.quality_prior_days)
    assert recent_votes_calls[0]["since"] == expected_since
    assert "ORDER BY id DESC" not in gateway.last_sql["recent_votes"]


def test_default_max_interest_tags_is_respected_by_default() -> None:
    own_rows = [([f"tag{i}"], f"tag{i}") for i in range(DEFAULT_MAX_INTEREST_TAGS + 5)]
    gateway = _FakeFetchGateway(own_post_rows=own_rows, has_ever_voted=False)
    tags = derive_interest_tags(gateway, "viewer1", now=EPOCH)
    assert len(tags) == DEFAULT_MAX_INTEREST_TAGS


# ---------------------------------------------------------------------------
# Q1 (RECSYS-LATENCY-BUILD-MAP-2026-09-06) — the voter-index vote-history
# rewrite, and its RECSYS_VOTE_HISTORY_V2 flag.
# ---------------------------------------------------------------------------


def test_vote_history_v2_sql_orders_by_id_with_no_since_predicate() -> None:
    """The whole point of the rewrite: no `timestamp`/`since` predicate (that
    is what forces the blocks-backward scan — see the SQL's own comment),
    ordered by `id` instead so the voter index can be walked directly."""
    sql = _SQL_RECENT_VOTES_BY_V2
    assert "ORDER BY id DESC" in sql
    assert "since" not in sql
    assert '"timestamp"' in sql, "the timestamp column must still be SELECTed for the Python filter"
    assert "%(account)s" in sql and "%(limit)s" in sql


def test_vote_history_v2_flag_defaults_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECSYS_VOTE_HISTORY_V2", raising=False)
    assert _vote_history_v2_enabled() is True


@pytest.mark.parametrize("off_value", ["0", "false", "no", "off", "FALSE", "Off"])
def test_vote_history_v2_flag_kill_switch_values(
    off_value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RECSYS_VOTE_HISTORY_V2", off_value)
    assert _vote_history_v2_enabled() is False


@pytest.mark.parametrize("on_value", ["1", "true", "yes", "on", "anything-else"])
def test_vote_history_v2_flag_stays_on_for_anything_not_a_kill_value(
    on_value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same fail-safe polarity as `RECSYS_RING_DETECTION`: only the named
    off-values disable it, so a typo cannot silently reinstate the slow
    query — it keeps the fix armed instead."""
    monkeypatch.setenv("RECSYS_VOTE_HISTORY_V2", on_value)
    assert _vote_history_v2_enabled() is True


def test_derive_interest_tags_v2_uses_the_id_ordered_sql_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RECSYS_VOTE_HISTORY_V2", raising=False)
    gateway = _FakeFetchGateway(has_ever_voted=True)
    derive_interest_tags(gateway, "viewer1", now=EPOCH + timedelta(days=1))
    assert "ORDER BY id DESC" in gateway.last_sql["recent_votes"]
    recent_votes_calls = [p for kind, p in gateway.calls if kind == "recent_votes"]
    assert "since" not in recent_votes_calls[0], (
        "V2 must not send a since parameter — the window is enforced client-side"
    )


def test_derive_interest_tags_v2_returns_all_in_window_rows_when_fewer_than_limit() -> None:
    """The map's own equivalence argument: with fewer than `limit` votes
    inside the window, V2 (id-ordered, no since predicate) must return
    every one of them — identical to what the old since-bounded query would
    have returned."""
    now = EPOCH + timedelta(days=1)
    gateway = _FakeFetchGateway(
        has_ever_voted=True,
        vote_rows_v2=[("a1", "p1", now.replace(tzinfo=None))],
        voted_tag_rows=[(["onlytag"], "onlytag")],
    )
    tags = derive_interest_tags(gateway, "viewer1", now=now)
    assert tags == frozenset({"onlytag"})


def test_derive_interest_tags_v2_survives_a_failing_vote_history_query(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Q1 must not weaken the existing reliability contract — a failing V2
    query degrades to own-posts-only tags exactly like V1 did."""
    import psycopg

    gateway = _FakeFetchGateway(
        own_post_rows=[(["cooking"], "cooking")],
        has_ever_voted=True,
        raise_on_recent_votes=psycopg.errors.QueryCanceled("simulated statement timeout"),
    )
    with caplog.at_level(logging.WARNING, logger="recsys.viewer"):
        tags = derive_interest_tags(gateway, "viewer1", now=EPOCH + timedelta(days=1))
    assert tags == frozenset({"cooking"})
    assert "voting-history query failed" in caplog.text


def test_derive_interest_tags_v2_handles_an_aware_timestamp_correctly() -> None:
    """★★★ REVIEW FIX (2026-09-06). The mirror's `timestamp` column is
    documented naive, but if it were ever returned AWARE (schema drift, a
    driver change), comparing it against a naive `since` used to raise
    `TypeError` and fall through to the blanket outer `except`, degrading to
    own-posts-only. The comparison now normalizes either side to naive
    first, so an aware timestamp is handled CORRECTLY — no crash, no
    fallback needed, no lost vote-derived interest."""
    now = EPOCH + timedelta(days=1)
    gateway = _FakeFetchGateway(
        has_ever_voted=True,
        vote_rows_v2=[("a1", "p1", now.astimezone(UTC))],  # AWARE, still in-window
        voted_tag_rows=[(["fromv2"], "fromv2")],
    )
    tags = derive_interest_tags(gateway, "viewer1", now=now)
    assert tags == frozenset({"fromv2"})


def test_derive_interest_tags_v2_falls_back_to_v1_on_a_structural_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """★★★ REVIEW FIX (2026-09-06). A failure INSIDE the V2 fetch itself
    (e.g. `UndefinedColumn: id` if the mirror's view ever loses that column)
    must fall back to the V1 query, not straight to own-posts-only — V1 is
    still index-backed and correct, just the query Q1 was built to replace."""
    from recsys import viewer as viewer_module

    viewer_module._reset_v2_disabled_for_process_for_tests()
    now = EPOCH + timedelta(days=1)
    gateway = _FakeFetchGateway(
        has_ever_voted=True,
        raise_on_recent_votes_v2_only=RuntimeError("simulated UndefinedColumn: id"),
        vote_rows=[("a2", "p2")],  # what V1 returns once V2 fails and falls back
        voted_tag_rows=[(["fromv1"], "fromv1")],
    )
    with caplog.at_level(logging.ERROR, logger="recsys.viewer"):
        tags = derive_interest_tags(gateway, "viewer1", now=now)
    assert tags == frozenset({"fromv1"}), "V1's rows must be used once V2 fails structurally"
    assert "failed structurally" in caplog.text
    recent_votes_calls = [kind for kind, _ in gateway.calls if kind == "recent_votes"]
    assert len(recent_votes_calls) == 2, "must attempt V2 once, then V1 once, not give up early"


def test_derive_interest_tags_v2_structural_failure_logs_error_only_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from recsys import viewer as viewer_module

    viewer_module._reset_v2_disabled_for_process_for_tests()
    now = EPOCH + timedelta(days=1)

    def _gateway() -> _FakeFetchGateway:
        return _FakeFetchGateway(
            has_ever_voted=True,
            raise_on_recent_votes_v2_only=RuntimeError("simulated UndefinedColumn: id"),
            vote_rows=[("a2", "p2")],
            voted_tag_rows=[(["fromv1"], "fromv1")],
        )

    with caplog.at_level(logging.ERROR, logger="recsys.viewer"):
        derive_interest_tags(_gateway(), "viewer1", now=now)
        derive_interest_tags(_gateway(), "viewer2", now=now)

    error_records = [r for r in caplog.records if "failed structurally" in r.message]
    assert len(error_records) == 1, (
        f"expected exactly ONE error log for the process, got {len(error_records)}"
    )
    viewer_module._reset_v2_disabled_for_process_for_tests()


def test_v2_disabled_for_process_latch_survives_a_second_call_to_a_fresh_gateway() -> None:
    """★★★ FOURTH REVIEW FIX (2026-09-06). Before this fix, `use_v1` was a
    fresh local recomputed from `_vote_history_v2_enabled()` on EVERY call,
    so the "disable V2 for the process" the ERROR log already claimed was
    never actually enforced: a second, unrelated request still attempted V2
    first, on its own gateway, even though the first request had already
    proven V2 structurally broken THIS process.

    The gateway used for the SECOND call deliberately does NOT set
    `raise_on_recent_votes_v2_only` — if the latch did not hold and V2 were
    attempted again, it would SUCCEED (this is not a repeat-failure test).
    Proof the latch held is therefore behavioural, not just "no crash": the
    second call must make exactly ONE `recent_votes` query, using the V1 SQL
    shape (no `ORDER BY id DESC`), never touching V2 at all.
    """
    from recsys import viewer as viewer_module

    viewer_module._reset_v2_disabled_for_process_for_tests()
    now = EPOCH + timedelta(days=1)

    first_gateway = _FakeFetchGateway(
        has_ever_voted=True,
        raise_on_recent_votes_v2_only=RuntimeError("simulated UndefinedColumn: id"),
        vote_rows=[("a2", "p2")],
        voted_tag_rows=[(["fromv1"], "fromv1")],
    )
    derive_interest_tags(first_gateway, "viewer1", now=now)
    assert viewer_module._v2_disabled_for_process is True, (
        "the first call's structural failure must set the process-wide latch"
    )

    # A FRESH gateway, V2-capable (no raise_on_recent_votes_v2_only) — if the
    # latch is honoured, this gateway's V2 SQL must never even be tried.
    second_gateway = _FakeFetchGateway(
        has_ever_voted=True,
        vote_rows=[("a3", "p3")],
        voted_tag_rows=[(["fromv1again"], "fromv1again")],
    )
    tags = derive_interest_tags(second_gateway, "viewer2", now=now)

    assert tags == frozenset({"fromv1again"})
    recent_votes_calls = [kind for kind, _ in second_gateway.calls if kind == "recent_votes"]
    assert len(recent_votes_calls) == 1, (
        f"expected exactly ONE recent_votes query (V1 only, V2 skipped by the "
        f"latch), got {len(recent_votes_calls)}"
    )
    assert "ORDER BY id DESC" not in second_gateway.last_sql["recent_votes"], (
        "the latch must skip V2 entirely on the second call, not attempt it "
        "and merely tolerate success — the SQL actually run must be V1's"
    )
    viewer_module._reset_v2_disabled_for_process_for_tests()


# ---------------------------------------------------------------------------
# build_viewer_profile
# ---------------------------------------------------------------------------


def test_build_viewer_profile_assembles_all_fields() -> None:
    gateway = _FakeFetchGateway(
        follows=["alice"],
        mutes=["spammer"],
        own_post_rows=[(["art"], "art")],
        has_ever_voted=False,
    )
    profile = build_viewer_profile("viewer1", gateway, now=EPOCH)
    assert profile.account == "viewer1"
    assert profile.follows == frozenset({"alice"})
    assert profile.mutes == frozenset({"spammer"})
    assert profile.interest_tags == frozenset({"art"})
    assert profile.is_new is False


def test_build_viewer_profile_is_new_skips_derivation_entirely() -> None:
    gateway = _FakeFetchGateway(own_post_rows=[(["art"], "art")], has_ever_voted=True)
    profile = build_viewer_profile("fresh", gateway, now=EPOCH, is_new=True)
    assert profile.interest_tags == frozenset()
    assert profile.is_new is True
    kinds = [kind for kind, _ in gateway.calls]
    assert "own_posts" not in kinds
    assert "has_ever_voted" not in kinds


def test_build_viewer_profile_explicit_override_skips_derivation() -> None:
    gateway = _FakeFetchGateway(own_post_rows=[(["art"], "art")], has_ever_voted=True)
    profile = build_viewer_profile(
        "viewer1", gateway, now=EPOCH, explicit_interest_tags=frozenset({"chess"})
    )
    assert profile.interest_tags == frozenset({"chess"})
    kinds = [kind for kind, _ in gateway.calls]
    assert "own_posts" not in kinds


def test_build_viewer_profile_logs_a_warning_when_tags_end_up_empty(
    caplog: pytest.LogCaptureFixture,
) -> None:
    gateway = _FakeFetchGateway()
    with caplog.at_level(logging.WARNING, logger="recsys.viewer"):
        profile = build_viewer_profile("brandnew", gateway, now=EPOCH)
    assert profile.interest_tags == frozenset()
    assert "no interest_tags" in caplog.text


def test_build_viewer_profile_no_warning_when_tags_are_present(
    caplog: pytest.LogCaptureFixture,
) -> None:
    gateway = _FakeFetchGateway(own_post_rows=[(["art"], "art")], has_ever_voted=False)
    with caplog.at_level(logging.WARNING, logger="recsys.viewer"):
        build_viewer_profile("viewer1", gateway, now=EPOCH)
    assert "no interest_tags" not in caplog.text


# ---------------------------------------------------------------------------
# R12's own done-check: a tagless ViewerProfile built by THIS module must
# still reach a non-empty feed via pipeline.gather_candidates's popular
# fallback — not just "interest_tags == frozenset()", the actual downstream
# behaviour.
# ---------------------------------------------------------------------------


def test_a_tagless_profile_from_this_builder_still_gets_a_non_empty_feed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fetch_gateway = _FakeFetchGateway()  # no follows, no posts, never voted
    now = EPOCH + timedelta(days=1)
    profile = build_viewer_profile("blank", fetch_gateway, now=now)
    assert profile.interest_tags == frozenset()
    assert not profile.follows

    popular = [make_post(f"pop{i}", f"p{i}") for i in range(30)]
    rank_gateway = FakeGateway(popular=popular)

    with caplog.at_level(logging.WARNING, logger="recsys.pipeline"):
        feed = rank_feed(
            profile,
            rank_gateway,
            _flat_norm(),
            now=now,
            since=EPOCH,
            trust_policy=TrustPolicy.WARN,
        )

    assert feed, "a tagless ViewerProfile built by recsys.viewer must never reach an empty feed"
    # ★ 2026-08-08: the invariant is "never empty, and served from a POPULARITY
    # source". The across-Hive popularity lane (`CandidateSource.OON_POPULAR`)
    # can also carry this feed when it is enabled — and when it does, it is a
    # strict improvement for exactly this audience, since `OON_POPULAR` carries
    # `requires_author_floor` and `POPULAR_FALLBACK` does not. It ships OFF
    # (`PopularConfig.limit = 0`), so today the fallback is what answers; both
    # are accepted here so this test pins the INVARIANT rather than the setting.
    # ★ 2026-08-09: `EXPLORATION` added when `PopularConfig.limit` went 0 -> 25.
    # Measured on this exact fixture: 24 `OON_POPULAR` / 5 `POPULAR_FALLBACK` /
    # 1 `EXPLORATION` in 30. The newcomer seat could not claim its slot before
    # because the pool was starved and the fallback filled every position; a
    # sourced popularity lane leaves room for it.
    #
    # The invariant this pins is NOT "popularity sources only" — it is that
    # nothing requiring a RELATIONSHIP the viewer does not have may reach a
    # tagless profile. `EXPLORATION` qualifies: it is the gate-exempt newcomer
    # seat, keyed on nobody's follows or interests. `IN_NETWORK`,
    # `OON_ENGAGED`, `OON_INTEREST` and `OON_ALS` all still fail this assertion,
    # which is the part worth keeping strict.
    assert all(
        sc.source
        in (
            CandidateSource.POPULAR_FALLBACK,
            CandidateSource.OON_POPULAR,
            CandidateSource.EXPLORATION,
        )
        for sc in feed
    )
    assert "no interest_tags" in caplog.text


def _flat_norm() -> Any:
    from recsys.core.normalize import build_norm_context

    return build_norm_context([0.0] * 60, [0.0] * 60, [0.0] * 60)


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


_ACTIVE_ACCOUNT = "acidyo"
_NEVER_VOTED_ACCOUNT = "zzzznonexistentaccountzzzz12345"


@_live
def test_follows_of_live_returns_a_non_empty_set_for_an_active_account(
    live_client: hafsql.HafsqlClient,
) -> None:
    follows = follows_of(live_client, _ACTIVE_ACCOUNT)
    assert len(follows) > 0


@_live
def test_mutes_of_live_returns_a_non_empty_set_for_an_active_account(
    live_client: hafsql.HafsqlClient,
) -> None:
    mutes = mutes_of(live_client, _ACTIVE_ACCOUNT)
    assert len(mutes) > 0


@_live
def test_derive_interest_tags_live_returns_something_for_an_active_account(
    live_client: hafsql.HafsqlClient,
) -> None:
    tags = derive_interest_tags(live_client, _ACTIVE_ACCOUNT, now=datetime.now(UTC))
    assert len(tags) > 0
    assert len(tags) <= DEFAULT_MAX_INTEREST_TAGS


@_live
def test_build_viewer_profile_live_end_to_end(live_client: hafsql.HafsqlClient) -> None:
    now = datetime.now(UTC)
    profile = build_viewer_profile(_ACTIVE_ACCOUNT, live_client, now=now)
    assert profile.account == _ACTIVE_ACCOUNT
    assert len(profile.follows) > 0
    assert len(profile.mutes) > 0
    assert len(profile.interest_tags) > 0


@_live
def test_never_voted_account_resolves_fast_not_at_the_statement_timeout(
    live_client: hafsql.HafsqlClient,
) -> None:
    """The reliability finding, proven live end to end: without the
    `_SQL_HAS_EVER_VOTED` guard, this exact call previously took ~15-16s
    (hit the statement timeout on `_SQL_RECENT_VOTES_BY`, then fell back).
    With the guard it must resolve in a small fraction of that."""
    now = datetime.now(UTC)
    t0 = time.monotonic()
    profile = build_viewer_profile(_NEVER_VOTED_ACCOUNT, live_client, now=now)
    elapsed = time.monotonic() - t0
    assert profile.interest_tags == frozenset()
    assert elapsed < 5.0, (
        f"build_viewer_profile for a never-voted account took {elapsed:.1f}s — the "
        "_SQL_HAS_EVER_VOTED guard should have kept this well under the 15s "
        "statement timeout the un-guarded query hits"
    )


# ---------------------------------------------------------------------------
# ★★★ THE VOTE-HISTORY READ MUST BE BOUNDED (2026-08-08).
#
# `_SQL_RECENT_VOTES_BY` has no usable index on `voter`, and the call site's own
# comment shipped assuming `statement_timeout` would cut it off ("up to the full
# 15s statement timeout"). This deployment runs
# HAFSQL_STATEMENT_TIMEOUT_MS=900000 for the trust batch, so that cap never
# existed for a request. Live-measured the day this was found: 27.21s for
# lordbutterfly — from FIFTEEN rows — which alone was 1.8x the frontend's whole
# 15s patience.
# ---------------------------------------------------------------------------


def test_the_vote_history_read_carries_its_own_request_scoped_timeout() -> None:
    """Pinned on the ASK, because no assertion on the RESULT can see it.

    A missing bound produces correct tags, just far too late — which is exactly
    how it survived until someone timed a live request.
    """
    seen: list[tuple[str, int | None]] = []

    class TimeoutRecordingGateway(_FakeFetchGateway):
        def _fetch(
            self, sql: str, params: dict[str, Any], *, timeout_ms: int | None = None
        ) -> list[tuple[Any, ...]]:
            if "operation_effective_comment_vote_view" in sql and "LIMIT 1" not in sql:
                seen.append(("recent_votes", timeout_ms))
            return super()._fetch(sql, params, timeout_ms=timeout_ms)

    gateway = TimeoutRecordingGateway(
        has_ever_voted=True,
        vote_rows=[("alice", "p1")],
        voted_tag_rows=[(None, "photography")],
    )
    derive_interest_tags(gateway, "someone", now=EPOCH + timedelta(days=1))

    assert seen == [("recent_votes", _VOTE_HISTORY_TIMEOUT_MS)], (
        "the unindexed vote-history query ran with no request-scoped bound; it "
        "then inherits the 900s batch timeout and can hang a whole page"
    )
    # Must leave room for the rest of the page inside the frontend's patience.
    assert _VOTE_HISTORY_TIMEOUT_MS < 15_000


def test_a_timed_out_vote_history_still_yields_tags_from_own_posts() -> None:
    """The bound is only safe because the degrade is REAL.

    Timing out must cost personalisation, never the page: derivation falls back
    to own-post tags (index-backed and reliably fast) and logs loudly.
    """
    import psycopg

    gateway = _FakeFetchGateway(
        own_post_rows=[(None, "photography"), (None, "photography")],
        has_ever_voted=True,
        raise_on_recent_votes=psycopg.errors.QueryCanceled("statement timeout"),
    )
    tags = derive_interest_tags(gateway, "someone", now=EPOCH + timedelta(days=1))
    assert "photography" in tags, (
        "a timed-out vote-history read wiped the viewer's interests entirely; "
        "it must degrade to own-post tags, not to nothing"
    )
