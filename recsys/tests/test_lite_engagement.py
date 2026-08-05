"""L2 (2026-08-05) — engagement cast BY Lumen Lite accounts.

A lite user has no Hive keys, so their votes live in the app's own Postgres
(`lumen_vote` / `lumen_reblog`) and never touch a chain. That seam was built by
the frontend — its migration comment says "feeds the recsys/feed" — and had no
consumer, so until now a lite user's likes changed nothing at all.

The whole design is one boundary, and these tests exist to hold it:

* a lite vote counts as a PERSON in the organic breadth term,
* it is excluded from the §4 STAKE term entirely,
* it is bounded by the SAME `unknown_free` budget that already bounds funded
  alts, so N lite accounts do not buy N breadth,
* and it never reaches the trust graph, so it can never confer vouch.

Each test names the mutant it catches; every one was applied and shown to fail.
"""

from __future__ import annotations

from dataclasses import fields as fields_of
from datetime import UTC, datetime
from typing import Any

import pytest

from recsys.config import LiteConfig
from recsys.contracts import Vote, VoteExclusions
from recsys.core.vote_signal import (
    AttributedPost,
    VoterTrust,
    independent_organic_engagement,
    independent_vote_signal,
)
from recsys.io import lite_engagement
from tests.fakes import make_post

_EPOCH = datetime(2026, 1, 1, tzinfo=UTC)
_CHAIN_RSHARES = 50_000_000  # comfortably above the organic dust floor (1e7)


def _post(votes: list[Vote]) -> AttributedPost:
    """Build on `make_post` so this stays in step with the Post contract rather
    than re-listing its fields — dataclasses.replace cannot change the class, so
    the fields are copied from the built instance."""
    base = make_post("alice", "p1")
    return AttributedPost(
        **{f.name: getattr(base, f.name) for f in fields_of(base) if f.name != "votes"},
        votes=tuple(votes),
    )


def _lite_vote(name: str) -> Vote:
    return Vote(voter=name, rshares=0, timestamp=_EPOCH, lite=True)


def _chain_vote(name: str) -> Vote:
    return Vote(voter=name, rshares=_CHAIN_RSHARES, timestamp=_EPOCH)


# ---------------------------------------------------------------------------
# Scoring semantics — the two halves of the boundary.
# ---------------------------------------------------------------------------


def test_a_lite_vote_counts_as_a_person_in_the_organic_term() -> None:
    """A lite vote carries no rshares, so the dust floor would drop it. But the
    floor exists to discard votes too small to matter on a STAKE signal, and
    this term measures PEOPLE. A real person with no chain stake is not dust.

    MUTANT: drop `vote.lite or` from the organic voter filter. This fails.
    """
    exclusions = VoteExclusions(author="alice")
    without = independent_organic_engagement(_post([]), exclusions.excluded())
    with_lite = independent_organic_engagement(_post([_lite_vote("01LITE")]), exclusions.excluded())
    assert with_lite > without


def test_a_lite_vote_is_excluded_from_the_stake_signal_entirely() -> None:
    """★★ THE LOAD-BEARING HALF. `independent_vote_signal` returns
    `log_compress(raw) * (1 + log10(1 + breadth))` — breadth MULTIPLIES stake
    magnitude. Admitting a free vote for breadth alone would let lite accounts
    AMPLIFY a whale's stake-weighted vote, which is worse than letting them add
    their own and is the exact inversion of this project's thesis.

    MUTANT: remove `not vote.lite` from the `kept` filter. The lite vote then
    multiplies the whale's magnitude and this fails.
    """
    exclusions = VoteExclusions(author="alice")
    whale_only = independent_vote_signal(_post([_chain_vote("whale")]), exclusions)
    whale_plus_lite = independent_vote_signal(
        _post([_chain_vote("whale"), _lite_vote("01LITE")]), exclusions
    )
    assert whale_plus_lite == whale_only

    # ★★ AND THE CASE THAT ACTUALLY REACHES THE GUARD. The assertion above
    # passes even with `not vote.lite` deleted, because the reader sets
    # rshares=0 and `rshares > 0` already drops it — mutation testing caught
    # that this test was pinning nothing, exactly the "gate that cannot fail"
    # defect this codebase keeps producing. Its own author included.
    #
    # What `not vote.lite` genuinely defends is a PRODUCER BUG: any future
    # change that gives a lite vote a non-zero magnitude — a migration adding a
    # weight-derived rshares, a second reader, a test fixture — must STILL not
    # move the stake signal. That invariant is the point, so it is pinned with
    # a lite vote that carries stake it should never have had.
    rogue = Vote(voter="01ROGUE", rshares=_CHAIN_RSHARES, timestamp=_EPOCH, lite=True)
    assert independent_vote_signal(_post([_chain_vote("whale"), rogue]), exclusions) == whale_only
    assert independent_vote_signal(_post([rogue]), exclusions) == 0.0


def test_a_post_with_only_lite_votes_has_no_stake_signal_at_all() -> None:
    """Not merely "less" — none. There is no stake behind it."""
    exclusions = VoteExclusions(author="alice")
    assert independent_vote_signal(_post([_lite_vote("01A"), _lite_vote("01B")]), exclusions) == 0.0


def test_fifty_lite_accounts_buy_the_unknown_budget_not_fifty() -> None:
    """★★★ THE SYBIL BOUND, and the reason no new defence was invented for lite
    engagement: lite voters are UNKNOWN identities, so `credited_breadth`'s
    existing `unknown_free` budget — the one that already stops funded alts —
    bounds them unchanged.

    MUTANT: exempt lite voters from the trust budget. This fails.
    """
    exclusions = VoteExclusions(author="alice")
    trust = VoterTrust(vouched=frozenset(), unknown_free=1.0, unknown_per_vouched=0.0)
    one = independent_organic_engagement(
        _post([_lite_vote("01A")]), exclusions.excluded(), trust=trust
    )
    fifty = independent_organic_engagement(
        _post([_lite_vote(f"01{i:02d}") for i in range(50)]), exclusions.excluded(), trust=trust
    )
    assert fifty == one, "50 free accounts bought more breadth than 1 — the budget is not applied"


def test_a_lite_voter_who_is_excluded_still_does_not_count() -> None:
    """Self-vote / lineage / ring exclusion applies to lite voters exactly as it
    does to chain voters — the flag changes the SIGNAL a vote feeds, never
    whether the identity filters apply."""
    exclusions = VoteExclusions(author="alice", ring_members=frozenset({"01RING"}))
    scored = independent_organic_engagement(_post([_lite_vote("01RING")]), exclusions.excluded())
    assert scored == independent_organic_engagement(_post([]), exclusions.excluded())


# ---------------------------------------------------------------------------
# The reader — retraction, downvotes, and the degrade posture.
# ---------------------------------------------------------------------------


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

    def __enter__(self) -> _FakeConn:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self._rows, self._sink)


def _reader(rows: list[tuple[Any, ...]], monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    sink: dict[str, Any] = {}
    monkeypatch.setattr(lite_engagement, "_connect", lambda dsn: _FakeConn(rows, sink))
    return sink


def test_the_reader_filters_retracted_and_negative_votes_in_sql(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ Retraction is part of the contract, not a later refinement: both tables
    soft-delete with `active = false`. A vote that cannot be withdrawn is a
    griefing tool. Downvotes never affect ranking (`Vote`'s own rev-2.1 rule).

    MUTANT: drop either predicate from the SQL. This fails.
    """
    sink = _reader([], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    lite_engagement.fetch_lite_votes(cfg, [("alice", "p1")])
    assert "active = true" in sink["sql"]
    assert "weight > %(min_weight)s" in sink["sql"]
    assert sink["params"]["min_weight"] == 0


def test_the_reader_marks_every_vote_it_produces_as_lite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A row that came back unflagged would silently enter the STAKE term with
    rshares 0 — harmless arithmetically, and a lie in the data model.

    MUTANT: construct the Vote without `lite=True`. This fails.
    """
    _reader([("alice", "p1", "01VOTER", _EPOCH)], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    out = lite_engagement.fetch_lite_votes(cfg, [("alice", "p1")])
    votes = out[("alice", "p1")]
    assert [v.lite for v in votes] == [True]
    assert votes[0].rshares == 0, "a synthetic magnitude is exactly what this design refuses"
    assert votes[0].timestamp.tzinfo is not None


def test_no_dsn_degrades_to_nothing_rather_than_raising() -> None:
    """The DSN is optional. Absent, lite engagement is simply not read — a
    WARNING and an empty result, never a crash, and never a silent pretence
    that there was no engagement."""
    assert lite_engagement.fetch_lite_votes(LiteConfig(), [("alice", "p1")]) == {}
    assert lite_engagement.fetch_lite_rebloggers(LiteConfig(), [("alice", "p1")]) == {}


def test_an_unreachable_datastore_costs_signal_not_the_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ A feed request must not die because a secondary datastore is down.

    MUTANT: let the exception propagate. This fails.
    """

    def boom(dsn: str) -> None:
        raise OSError("connection refused")

    monkeypatch.setattr(lite_engagement, "_connect", boom)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    assert lite_engagement.fetch_lite_votes(cfg, [("alice", "p1")]) == {}
    assert lite_engagement.fetch_lite_rebloggers(cfg, [("alice", "p1")]) == {}


# ---------------------------------------------------------------------------
# The wiring — proven at the SERVED POST, not at the module boundary.
# ---------------------------------------------------------------------------


def test_hydration_merges_lite_votes_into_the_post_it_serves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★★★ THE WIRING GATE, and it is deliberately end-to-end through the real
    `_hydrate`.

    This project's signature defect is a mechanism that works in isolation while
    the pipeline never calls it — it happened three times in one session, and
    every time the unit test passed. So this asserts on the POST THAT COMES OUT,
    with the real merge code in the path: chain votes preserved, lite votes
    appended and flagged, lite rebloggers unioned into the attribution.

    `_hydrate` is the single choke point every post-returning method passes
    through, which is why the merge lives there — no lane can be forgotten.

    MUTANT: delete the `_merge_lite_engagement` call from `_hydrate`. This fails
    while every other test in this file still passes.
    """
    from recsys.config import HafsqlConfig
    from recsys.io import hafsql

    key = ("alice", "p1")
    client = hafsql.HafsqlClient(
        HafsqlConfig(),
        LiteConfig(publisher_accounts=frozenset({"lumen.pub"}), engagement_dsn="postgresql://x"),
    )
    monkeypatch.setattr(
        hafsql.HafsqlClient, "_votes_for_posts", lambda self, a, p: {key: [_chain_vote("whale")]}
    )
    monkeypatch.setattr(hafsql.HafsqlClient, "_comments_for_posts", lambda self, a, p: {})
    monkeypatch.setattr(
        hafsql.HafsqlClient, "_rebloggers_for_posts", lambda self, a, p: {key: ("bob",)}
    )
    monkeypatch.setattr(hafsql.HafsqlClient, "_reputations_for_authors", lambda self, a: {})
    monkeypatch.setattr(
        lite_engagement, "fetch_lite_votes", lambda cfg, keys: {key: [_lite_vote("01LITE")]}
    )
    monkeypatch.setattr(
        lite_engagement, "fetch_lite_rebloggers", lambda cfg, keys: {key: frozenset({"01RB"})}
    )

    row = ("alice", "p1", "photography", _EPOCH, ["photography"], None)
    posts = client._hydrate([row])

    assert len(posts) == 1
    post = posts[0]
    voters = {v.voter: v.lite for v in post.votes}
    assert voters == {"whale": False, "01LITE": True}, (
        "lite engagement never reached the served post — the merge is not wired"
    )
    # ★ ROUND-4: lite rebloggers live in their OWN field. Merged into
    # `rebloggers` they were indistinguishable bare names, and the need bands
    # counted free reblogs at full value — one free lite reblog bought a sock
    # 93% of the new-writer lane. Chain and lite must stay separable.
    assert set(post.rebloggers) == {"bob"}, "a lite reblogger was merged into the chain field"
    assert set(post.lite_rebloggers) == {"01RB"}


def test_hydration_is_untouched_when_no_lite_dsn_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A deploy without the app database must pay nothing here — not a failed
    connection, not a slow one: the reader is never called at all."""
    from recsys.config import HafsqlConfig
    from recsys.io import hafsql

    key = ("alice", "p1")
    called: list[str] = []
    client = hafsql.HafsqlClient(HafsqlConfig(), LiteConfig())
    monkeypatch.setattr(
        hafsql.HafsqlClient, "_votes_for_posts", lambda self, a, p: {key: [_chain_vote("whale")]}
    )
    monkeypatch.setattr(hafsql.HafsqlClient, "_comments_for_posts", lambda self, a, p: {})
    monkeypatch.setattr(hafsql.HafsqlClient, "_rebloggers_for_posts", lambda self, a, p: {})
    monkeypatch.setattr(hafsql.HafsqlClient, "_reputations_for_authors", lambda self, a: {})
    monkeypatch.setattr(
        lite_engagement,
        "fetch_lite_votes",
        lambda cfg, keys: called.append("votes") or {},  # type: ignore[func-returns-value]
    )

    posts = client._hydrate([("alice", "p1", "photography", _EPOCH, ["photography"], None)])
    assert [v.voter for v in posts[0].votes] == ["whale"]
    assert called == [], "the lite reader was consulted with no DSN configured"


# ---------------------------------------------------------------------------
# Reachability — the config path must exist in PRODUCTION, not just in tests.
# ---------------------------------------------------------------------------


def test_settings_from_env_populates_lite_so_the_fixes_are_reachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★★★ THE REACHABILITY GATE.

    `Settings.lite` was always the empty default, and nothing read
    `LUMEN_LITE_DATABASE_URL`, so BOTH lite fixes were unreachable in
    production: L1's discovery fix is gated on `settings.lite.enabled`, and
    L2's reader is gated on the DSN. That is the identical shape of the
    2026-08-04 defect where `ExplorationConfig.from_env` was referenced only
    inside its own error message and the keyed seat could never receive a key —
    a fix that passes every test and does nothing where it matters.

    MUTANT: drop `lite=LiteConfig.from_env()` from `Settings.from_env`. This
    fails.
    """
    from recsys.config import Settings

    monkeypatch.setenv("LITE_PUBLISHER_ACCOUNTS", "lumen.pub")
    monkeypatch.setenv("LUMEN_LITE_DATABASE_URL", "postgresql://lite")
    settings = Settings.from_env()
    assert settings.lite.publisher_accounts == frozenset({"lumen.pub"})
    assert settings.lite.enabled, "L1 lite-author discovery cannot fire"
    assert settings.lite.engagement_dsn == "postgresql://lite"
    assert settings.lite.engagement_enabled, "L2 lite engagement cannot be read"


def test_the_hafsql_fallback_resolves_the_engagement_dsn_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`HafsqlClient` built without an explicit `lite=` falls back to the
    environment. That fallback used to know only about publishers, so a deploy
    could source lite POSTS while silently never reading lite ENGAGEMENT.

    MUTANT: have `_lite_config_from_env` return `LiteConfig(publisher_accounts=...)`
    directly again instead of delegating. This fails.
    """
    from recsys.io import hafsql

    monkeypatch.setenv("LITE_PUBLISHER_ACCOUNTS", "lumen.pub")
    monkeypatch.setenv("LUMEN_LITE_DATABASE_URL", "postgresql://lite")
    resolved = hafsql._lite_config_from_env()
    assert resolved.publisher_accounts == frozenset({"lumen.pub"})
    assert resolved.engagement_dsn == "postgresql://lite"


def test_lite_stays_off_when_the_environment_says_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OFF by default is the rollout contract — resolving from the environment
    must not switch anything on by itself."""
    from recsys.config import Settings

    for name in (
        "LITE_PUBLISHER_ACCOUNTS",
        "LUMEN_LITE_DATABASE_URL",
        "LITE_FRONTEND_ACCOUNT_MAINNET",
        "LITE_FRONTEND_ACCOUNT_MIRRORNET",
        "LITE_FRONTEND_ACCOUNT_TESTNET",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = Settings.from_env()
    assert not settings.lite.enabled
    assert not settings.lite.engagement_enabled


# ---------------------------------------------------------------------------
# ROUND-3 COUNCIL — the gates that would have caught what shipped broken.
# ---------------------------------------------------------------------------


def test_the_shipped_sql_executes_against_a_real_postgres() -> None:
    """★★★ THE GATE THAT WAS MISSING, and its absence is the whole story.

    The first version of these queries used
    `(target_author, target_permlink) = ANY(%(keys)s)`. Against a real
    PostgreSQL that raises at bind time:

        FeatureNotSupported: input of anonymous composite types is not implemented

    Every other test in this file monkeypatches `_connect`, so the SQL had
    NEVER TOUCHED A DATABASE — the same defect that once left this project's
    entire I/O layer unexecuted, reproduced inside the fix for it. And the broad
    `except` in the reader would have swallowed it into a WARNING on every
    request, so L2 would have been silently inert in production with a green
    suite.

    This runs the SHIPPED CONSTANTS — not a copy — against a real server, with
    a CTE standing in for the app's tables, so it proves parameter BINDING and
    syntax, which is exactly what failed. Skips (never fails) when the mirror is
    unreachable: this is about our SQL, not their uptime.

    MUTANT: restore the tuple-`ANY` predicate. This fails.
    """
    psycopg = pytest.importorskip("psycopg")
    from recsys.config import HafsqlConfig

    cfg = HafsqlConfig()
    votes_prelude = (
        "WITH lumen_vote(target_author, target_permlink, voter_user_id, "
        "weight, active, updated_at) AS (VALUES "
        "('alice','p1','01VOTER', 10000, true, now()), "
        "('bob','p2','01OTHER', 10000, true, now())) "
    )
    reblogs_prelude = (
        "WITH lumen_reblog(target_author, target_permlink, reblogger_user_id, active) "
        "AS (VALUES ('alice','p1','01RB', true)) "
    )
    keys = lite_engagement._key_params([("alice", "p1")])
    try:
        conn = psycopg.connect(
            host=cfg.host, port=cfg.port, dbname=cfg.dbname, user=cfg.user,
            password=cfg.password, connect_timeout=cfg.connect_timeout, autocommit=True,
        )
    except Exception as exc:  # unreachable mirror is not our bug
        pytest.skip(f"no reachable PostgreSQL to bind against: {type(exc).__name__}: {exc}")
    with conn, conn.cursor() as cur:
        cur.execute(
            votes_prelude + lite_engagement._SQL_LITE_VOTES,
            {**keys, "min_weight": lite_engagement._MIN_WEIGHT},
        )
        rows = cur.fetchall()
        assert [(r[0], r[1], r[2]) for r in rows] == [("alice", "p1", "01VOTER")], rows
        cur.execute(reblogs_prelude + lite_engagement._SQL_LITE_REBLOGS, keys)
        assert cur.fetchall() == [("alice", "p1", "01RB")]


def test_a_lite_downvote_adds_no_organic_breadth() -> None:
    """★ Seat 2: the producer-bug guard was pinned on the STAKE side and left
    unpinned on the ORGANIC side. The reader filters `weight > 0` in SQL, so it
    never emits one — but "the current producer doesn't do that" is exactly the
    reasoning that has been wrong twice in this project today.

    MUTANT: count lite votes in organic breadth regardless of sign. This fails.
    """
    exclusions = VoteExclusions(author="alice")
    down = Vote(voter="01DOWN", rshares=-5, timestamp=_EPOCH, lite=True)
    assert independent_organic_engagement(
        _post([down]), exclusions.excluded()
    ) == independent_organic_engagement(_post([]), exclusions.excluded())


def test_the_trust_batch_resolves_lite_from_the_environment() -> None:
    """★★★ Seat 2: `run_batch` is the ONLY production caller of
    `engagement_edges`, and it hardcoded `lite = LiteConfig()`, so L1 — the fix
    whose own doc called it "THE FINDING THAT MATTERED MOST" — could never
    execute in production. Unreachable at the moment of shipping, again.

    MUTANT: hardcode `LiteConfig()` back. This fails.
    """
    import inspect

    from recsys.jobs import trust_batch

    source = inspect.getsource(trust_batch.main)
    assert "LiteConfig.from_env()" in source, (
        "the weekly batch does not resolve lite config — L1 cannot run in production"
    )


def test_the_deploy_artifact_passes_lite_configuration_to_both_services() -> None:
    """★ Seat 3 + Seat 2: `LUMEN_LITE_DATABASE_URL` reached NO container, and
    the batch — which is where the trust graph is actually built — was passed no
    `LITE_*` at all. Config that exists in code and not in the artifact is the
    same defect as config with no reader.
    """
    import pathlib

    compose = (pathlib.Path(__file__).resolve().parent.parent / "deploy" / "compose.recsys.yml")
    text = compose.read_text()
    feed, batch = text.split("recsys-trust-batch:", 1)
    assert "LUMEN_LITE_DATABASE_URL:" in feed, "the feed service cannot read lite engagement"
    assert "LITE_PUBLISHER_ACCOUNTS:" in batch, (
        "the trust batch cannot see lite publishers — L1 is inert where the graph is built"
    )



def test_a_lite_reblog_never_moves_the_need_band() -> None:
    """★★★ ROUND-4 COUNCIL (Seat 1). The lite-vote fix covered VOTES only.
    Rebloggers were merged into `AttributedPost.rebloggers` as bare names with
    nothing to filter on, so `engagement_received` counted free reblogs at FULL
    value and the round-3 headline reproduced byte-for-byte on the other half of
    the same feature: 3 lite reblogs took a debut from rank 13 seen by 3 viewers
    to rank 33 seen by 0, and ONE free lite reblog bought a sock 93% of the
    new-writer lane.

    ★ The lesson this round supplies, and it is not round 3's: a value-domain
    change must be audited at every consumer of the VALUE, not every consumer of
    the TYPE. `Vote.lite` was traced to three consumers of `Vote`. The fourth
    consumer of "a free identity" receives a plain `str`.

    MUTANT: merge `lite_rebloggers` back into `rebloggers`. This fails.
    """
    from recsys.contracts import Candidate, CandidateSource
    from recsys.core.exploration import engagement_received
    from recsys.core.vote_signal import AttributedPost

    base = make_post("newcomer", "p1")
    fields = {f.name: getattr(base, f.name) for f in fields_of(base)}
    post = AttributedPost(**fields, rebloggers=("chainfan",), lite_rebloggers=("01LITERB",))
    received = engagement_received([Candidate(post=post, source=CandidateSource.IN_NETWORK)])
    assert received == {"newcomer": {"chainfan"}}, (
        f"a free lite reblog reached the need band: {received}"
    )


def test_a_lite_reblog_still_counts_as_a_person_for_merit() -> None:
    """The other half of the same rule: excluded from the need bands is NOT
    excluded from everything. A lite reblog is a real person's endorsement and
    counts for organic breadth, bounded by `unknown_free` like any unknown."""
    from recsys.core.vote_signal import AttributedPost

    base = make_post("newcomer", "p1")
    fields = {f.name: getattr(base, f.name) for f in fields_of(base)}
    exclusions = VoteExclusions(author="newcomer")
    plain = AttributedPost(**fields)
    with_lite = AttributedPost(**fields, lite_rebloggers=("01LITERB",))
    assert independent_organic_engagement(
        with_lite, exclusions.excluded()
    ) > independent_organic_engagement(plain, exclusions.excluded())


def test_a_failing_lite_store_trips_a_breaker_instead_of_being_retried_forever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★★★ PUNCH LIST #5. The lite datastore is a THIRD database and had none of
    the protections the HAFSQL client grew — no statement timeout, no breaker,
    a fresh connection per call, twice per hydrate across five call sites.
    Measured by a council at ~6s added per request when it is slow.

    A secondary signal source must never spend a feed request's whole budget.

    MUTANT: remove the breaker check, or stop recording failures. This fails —
    the connect count keeps climbing.
    """
    lite_engagement.reset_breaker()
    attempts: list[int] = []

    def boom(dsn: str) -> None:
        attempts.append(1)
        raise OSError("connection refused")

    monkeypatch.setattr(lite_engagement, "_connect", boom)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    for _ in range(10):
        assert lite_engagement.fetch_lite_votes(cfg, [("alice", "p1")]) == {}
    assert len(attempts) == 3, (
        f"the lite store was dialled {len(attempts)} times while down — the "
        "breaker never opened"
    )
    lite_engagement.reset_breaker()


def test_a_recovered_lite_store_closes_the_breaker(monkeypatch: pytest.MonkeyPatch) -> None:
    """Degrading to 'no lite engagement' is a real cost, so the breaker must let
    go as soon as the store is healthy again — a success resets the count."""
    lite_engagement.reset_breaker()
    _reader([("alice", "p1", "01VOTER", _EPOCH)], monkeypatch)
    cfg = LiteConfig(engagement_dsn="postgresql://x")
    assert lite_engagement.fetch_lite_votes(cfg, [("alice", "p1")])
    assert not lite_engagement._breaker_is_open(0.0)
    lite_engagement.reset_breaker()


def test_the_lite_connection_sets_a_statement_timeout() -> None:
    """A connect timeout says nothing about a query that hangs AFTER
    connecting, which is the shape that cost ~6s per request."""
    import inspect

    source = inspect.getsource(lite_engagement._connect)
    assert "statement_timeout" in source
    assert "connect_timeout=_CONNECT_TIMEOUT_S" in source
