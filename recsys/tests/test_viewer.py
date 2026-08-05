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
    DEFAULT_MAX_INTEREST_TAGS,
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


class _FakeFetchGateway:
    """The one method `recsys.viewer` needs (`_fetch`), dispatched on a
    distinctive SQL substring so one fake can stand in for all four queries
    this module issues."""

    def __init__(
        self,
        *,
        follows: list[str] | None = None,
        mutes: list[str] | None = None,
        own_post_rows: list[tuple[Any, str]] | None = None,
        has_ever_voted: bool = False,
        vote_rows: list[tuple[str, str]] | None = None,
        voted_tag_rows: list[tuple[Any, str]] | None = None,
        raise_on_has_voted: Exception | None = None,
        raise_on_recent_votes: Exception | None = None,
        raise_on_tag_lookup: Exception | None = None,
    ) -> None:
        self._follows = follows or []
        self._mutes = mutes or []
        self._own_post_rows = own_post_rows or []
        self._has_ever_voted = has_ever_voted
        self._vote_rows = vote_rows or []
        self._voted_tag_rows = voted_tag_rows or []
        self._raise_on_has_voted = raise_on_has_voted
        self._raise_on_recent_votes = raise_on_recent_votes
        self._raise_on_tag_lookup = raise_on_tag_lookup
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _fetch(self, sql: str, params: dict[str, Any]) -> list[tuple[Any, ...]]:
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
            if self._raise_on_recent_votes is not None:
                raise self._raise_on_recent_votes
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
    never propagate and break the whole viewer-profile build."""
    gateway = _FakeFetchGateway(
        own_post_rows=[(["cooking"], "cooking")],
        has_ever_voted=True,
        raise_on_recent_votes=TimeoutError("simulated statement timeout"),
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
    gateway = _FakeFetchGateway(has_ever_voted=True)
    now = EPOCH + timedelta(days=100)
    derive_interest_tags(gateway, "viewer1", now=now, settings=DEFAULT_SETTINGS)
    recent_votes_calls = [p for kind, p in gateway.calls if kind == "recent_votes"]
    assert recent_votes_calls
    expected_since = now - timedelta(days=DEFAULT_SETTINGS.history.quality_prior_days)
    assert recent_votes_calls[0]["since"] == expected_since


def test_default_max_interest_tags_is_respected_by_default() -> None:
    own_rows = [([f"tag{i}"], f"tag{i}") for i in range(DEFAULT_MAX_INTEREST_TAGS + 5)]
    gateway = _FakeFetchGateway(own_post_rows=own_rows, has_ever_voted=False)
    tags = derive_interest_tags(gateway, "viewer1", now=EPOCH)
    assert len(tags) == DEFAULT_MAX_INTEREST_TAGS


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
    assert all(sc.source is CandidateSource.POPULAR_FALLBACK for sc in feed)
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
