"""Import + structural tests for the HAFSQL gateway (§S7). INFRA-GATED: no
database is reachable here, so these tests only check that the module imports
without ``psycopg`` installed, that ``HafsqlClient`` structurally implements
every ``HafsqlGateway`` method, and that its SQL constants are real queries.
No connection is opened and no query is executed.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

import pytest

from recsys.config import HafsqlConfig
from recsys.contracts import HafsqlGateway, Vote
from recsys.core.scoring import AuthorEngagement
from recsys.core.vote_signal import AttributedPost, VoterTrust
from recsys.io import hafsql

CLIENT: Final = hafsql.HafsqlClient(HafsqlConfig())

# Static structural-conformance check: mypy verifies HafsqlClient satisfies
# the HafsqlGateway Protocol without a runtime isinstance check (the Protocol
# isn't @runtime_checkable).
_AS_GATEWAY: HafsqlGateway = CLIENT

_GATEWAY_METHODS = (
    "in_network_posts",
    "engaged_oon_posts",
    "tag_posts",
    "window_posts",
    "engagement_edges",
    "second_degree_engagers",
    "follow_graph",
    "popular_posts",
    "suppressed_keys",
)

_SQL_CONSTANTS = (
    hafsql._SQL_IN_NETWORK_POSTS,
    hafsql._SQL_TAG_POSTS,
    hafsql._SQL_ENGAGED_OON_POSTS,
    hafsql._SQL_VOTES_FOR_POSTS,
    hafsql._SQL_COMMENTS_FOR_POSTS,
    hafsql._SQL_REBLOGGERS_FOR_POSTS,
    hafsql._SQL_REPUTATIONS_FOR_AUTHORS,
    hafsql._SQL_REPLY_EDGES,
    hafsql._SQL_UPVOTE_EDGES,
    hafsql._SQL_REBLOG_EDGES,
    hafsql._SQL_SECOND_DEGREE_ENGAGERS,
    hafsql._SQL_FOLLOW_GRAPH,
    hafsql._SQL_POPULAR_POSTS,
    hafsql._SQL_AUTHOR_ENGAGEMENT,
    hafsql._SQL_SUPPRESSED_KEYS,
    hafsql._SQL_WINDOW_POSTS,
)

# A13's env-driven LiteConfig fallback (`_lite_config_from_env`) and A15's
# `RECSYS_DATABASE_URL` fallback both read `os.environ` directly the moment
# `HafsqlClient(HafsqlConfig())` is constructed with no explicit `lite=`/
# `recsys_dsn=`. Without clearing them, a developer's own exported
# `LITE_PUBLISHER_ACCOUNTS`/`LITE_FRONTEND_ACCOUNT_*`/`RECSYS_DATABASE_URL`
# could silently flip `lite`/`recsys_dsn` on for every bare construction in
# this file and make an unrelated test fail (or worse, pass) for a reason
# that has nothing to do with the code under test. Every test that wants one
# of these ON sets it explicitly within its own body (monkeypatch stacks on
# top of this baseline and undoes at teardown either way).
_ENV_VARS_TO_ISOLATE = (
    hafsql._LITE_PUBLISHER_ACCOUNTS_ENV,
    *hafsql._LITE_FRONTEND_ACCOUNT_ENVS,
    hafsql._RECSYS_DSN_ENV,
)


@pytest.fixture(autouse=True)
def _no_ambient_lite_or_recsys_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _ENV_VARS_TO_ISOLATE:
        monkeypatch.delenv(name, raising=False)


def test_module_imports_without_psycopg() -> None:
    """Importing recsys.io.hafsql must not require psycopg to be installed."""
    assert hafsql.HafsqlClient is not None


def test_client_constructs_from_default_config() -> None:
    client = hafsql.HafsqlClient(HafsqlConfig())
    assert client._config == HafsqlConfig()


def test_every_gateway_method_is_callable() -> None:
    for name in _GATEWAY_METHODS:
        assert callable(getattr(CLIENT, name)), f"{name} is not callable"


def test_sql_constants_are_non_empty_queries() -> None:
    for sql in _SQL_CONSTANTS:
        text = sql.strip()
        assert text, "SQL constant must not be empty"
        assert "SELECT" in text.upper(), "SQL constant must be a query"


def test_hydration_helpers_use_parameterized_placeholders() -> None:
    """Every query interpolates values via psycopg params, never f-strings."""
    for sql in _SQL_CONSTANTS:
        assert "%(" in sql, "query must use named psycopg parameters"


def test_split_keys_parses_post_key_format() -> None:
    authors, permlinks = hafsql._split_keys(frozenset({"@alice/my-post"}))
    assert authors == ["alice"]
    assert permlinks == ["my-post"]


def test_second_degree_engagers_empty_inputs_short_circuit() -> None:
    """Empty ``post_keys`` or ``follows`` must return {} without a query."""
    assert CLIENT.second_degree_engagers(frozenset(), frozenset({"bob"})) == {}
    assert CLIENT.second_degree_engagers(frozenset({"@alice/p1"}), frozenset()) == {}


def test_follow_graph_empty_accounts_short_circuits() -> None:
    assert CLIENT.follow_graph(frozenset()) == {}


def test_suppressed_keys_empty_post_keys_short_circuits() -> None:
    assert CLIENT.suppressed_keys(frozenset()) == frozenset()


def test_build_post_sets_is_nsfw_from_nsfw_tag() -> None:
    row = ("alice", "p1", "hive-onboarding",
           datetime(2026, 1, 1, tzinfo=UTC), ["hive", "nsfw"], None)
    post = hafsql._build_post(row, {}, {}, {}, {})
    assert post.is_nsfw is True


def test_build_post_is_nsfw_false_without_nsfw_tag() -> None:
    row = ("alice", "p1", "hive-onboarding",
           datetime(2026, 1, 1, tzinfo=UTC), ["hive", "art"], None)
    post = hafsql._build_post(row, {}, {}, {}, {})
    assert post.is_nsfw is False


def test_build_post_is_nsfw_false_when_tags_missing() -> None:
    row = ("alice", "p1", "hive-onboarding", datetime(2026, 1, 1, tzinfo=UTC), None, None)
    post = hafsql._build_post(row, {}, {}, {}, {})
    assert post.is_nsfw is False


# ---------------------------------------------------------------------------
# Attribution hydration (§6 rebuild): every hydrated post carries per-account
# commenter/reblogger identity, and the display counters are DERIVED from it.
# ---------------------------------------------------------------------------


def test_build_post_attaches_commenter_and_reblogger_identity() -> None:
    row = ("alice", "p1", "photo", datetime(2026, 1, 1, tzinfo=UTC), ["photo"], None)
    post = hafsql._build_post(
        row,
        {},
        {("alice", "p1"): {"carol": 2, "bob": 1}},
        {("alice", "p1"): ("dave", "erin")},
        {},
    )
    assert isinstance(post, AttributedPost)
    assert post.commenters == ("bob", "carol")  # distinct, sorted
    assert post.children == 3  # total comments, not distinct commenters
    assert post.rebloggers == ("dave", "erin")
    assert post.reblog_count == 2


def test_build_post_without_engagement_has_empty_attribution() -> None:
    row = ("alice", "p1", "photo", datetime(2026, 1, 1, tzinfo=UTC), ["photo"], None)
    post = hafsql._build_post(row, {}, {}, {}, {})
    assert isinstance(post, AttributedPost)
    assert post.commenters == ()
    assert post.rebloggers == ()
    assert post.children == 0
    assert post.reblog_count == 0


def test_attribution_queries_group_by_identity() -> None:
    """The hydration queries must return WHO engaged, not bare counts."""
    assert "rc.author" in hafsql._SQL_COMMENTS_FOR_POSTS
    assert "GROUP BY rc.parent_author, rc.parent_permlink, rc.author" in (
        hafsql._SQL_COMMENTS_FOR_POSTS
    )
    assert "DISTINCT" in hafsql._SQL_REBLOGGERS_FOR_POSTS
    assert "r.account_name" in hafsql._SQL_REBLOGGERS_FOR_POSTS


def test_popular_posts_ordering_is_attributed_and_self_excluded() -> None:
    """Cross-fix contradiction (council finding 4): the fallback pool must be
    ordered by attributed distinct identity with self-engagement excluded —
    never by the raw self-farmable counters scoring refuses to trust."""
    sql = hafsql._SQL_POPULAR_POSTS
    assert "COUNT(DISTINCT v.voter)" in sql
    assert "v.voter <> c.author" in sql  # self-votes buy no pool position
    assert "COUNT(DISTINCT rc.author)" in sql  # distinct commenters, not COUNT(*)
    assert "rc.author <> c.author" in sql  # self-comments neither
    assert "COUNT(DISTINCT r.account_name)" in sql
    assert "r.account_name <> c.author" in sql  # self-reblogs neither
    assert "v.rshares > 10000000" in sql  # chain-dust votes neither


def test_vote_vouch_queries_ignore_downvotes() -> None:
    """F-R5 #1: a DOWNVOTE by a followed account must not vouch an out-of-network
    post into the feed. Both vote-sourced vouch paths — the engaged-OON pool and
    the second-degree engager index — must keep only positive-rshares votes,
    matching ``independent_vote_signal``'s ``vote.rshares > 0`` filter. Without
    this, a followed account's downvote surfaces the downvoted post."""
    assert "v.rshares > 0" in hafsql._SQL_ENGAGED_OON_POSTS
    assert "v.rshares > 0" in hafsql._SQL_SECOND_DEGREE_ENGAGERS


# ---------------------------------------------------------------------------
# Author-pooled prior aggregate (§6): §8.4-exclusion-filtered so an author
# cannot inflate total_base with self-engagement, delegation-tied alts, or a
# ring. Self-exclusion is static SQL; lineage/ring identities are passed in
# per author and anti-joined against each author's own set.
# ---------------------------------------------------------------------------


def test_author_engagement_sql_applies_full_exclusion_and_attribution() -> None:
    """The pooled-prior aggregate must count the SAME attributed distinct
    identities the organic term scores — self-excluded AND anti-joined per
    author against the passed lineage/ring set (§8.4) — never a raw counter."""
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    assert "COUNT(DISTINCT v.voter)" in sql
    assert "COUNT(DISTINCT rc.author)" in sql
    assert "COUNT(DISTINCT r.account_name)" in sql
    assert "v.rshares > 10000000" in sql  # chain-dust floor (mirrors organic)
    assert "v.voter <> cp.author" in sql  # self-vote buys no prior
    assert "rc.author <> cp.author" in sql  # self-comment neither
    assert "r.account_name <> cp.author" in sql  # self-reblog neither
    # per-author lineage/ring anti-join against the passed exclusion arrays,
    # scoped PER author (never a global exclusion that would strip an author's
    # honest engagers just because another author flagged them)
    assert "%(excl_authors)s" in sql
    assert "%(excl_accounts)s" in sql
    # one exclusion anti-join per engagement channel (3) PLUS the H05
    # eligibility/flooding NOT EXISTS against network_suppression (1) = 4.
    assert sql.count("NOT EXISTS") == 4
    assert sql.count("e.author = cp.author") == 3  # exclusion anti-joins only


def test_author_engagement_sql_applies_the_voter_trust_breadth_budget() -> None:
    """H05: exclusion alone leaves BREADTH un-budgeted — unknown-tier socks
    that pass every §8.4 exclusion could still farm an author's OTHER window
    posts. Each channel must split vouched/unknown via FILTER and credit
    ``vouched + LEAST(unknown, unknown_free + unknown_per_vouched * vouched)``
    — exactly ``VoterTrust.credited_breadth`` — before summing."""
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    assert "%(vouched)s" in sql
    assert "%(unknown_free)s" in sql
    assert "%(unknown_per_vouched)s" in sql
    assert sql.count("FILTER (WHERE") == 6  # vouched_n + unknown_n, x3 channels
    assert sql.count("LEAST(") == 3  # one budget clamp per channel
    # the budget is keyed on each channel's OWN identity column, not a
    # different channel's (e.g. commenters must not be gated by voter
    # membership in `vouched`)
    assert "v.voter = ANY(%(vouched)s)" in sql
    assert "rc.author = ANY(%(vouched)s)" in sql
    assert "r.account_name = ANY(%(vouched)s)" in sql


def test_author_engagement_sql_excludes_suppressed_posts() -> None:
    """H05 + A15: a post already network-suppressed (§8.7) must never feed the
    pooled prior — flooding an author's window with suppressed posts cannot
    dilute or pad the aggregate.

    A15 (2026-08-04): `network_suppression` lives in the recsys DB, not the
    HAFSQL mirror this query runs against — the mirror has no such table
    (live-verified: `UndefinedTable`), and a single SQL statement cannot join
    across two separate Postgres instances. So the exclusion is no longer a
    live table reference inside this query; it is a bound array, populated by
    a SEPARATE round trip to the recsys DB before this query runs (see
    `test_author_engagement_fetches_suppression_from_the_recsys_db` and
    `HafsqlClient.author_engagement`). The invariant this test used to pin —
    suppressed posts never feed the prior — is unchanged; only the SQL shape
    that enforces it changed, because the old shape could never have executed
    against the real mirror (this was break #4 / A2 item 4)."""
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    assert "network_suppression" not in sql  # would crash on the mirror: no such table
    assert "%(supp_authors)s" in sql
    assert "%(supp_permlinks)s" in sql
    assert "s.author = cp.author AND s.permlink = cp.permlink" in sql
    # still exactly 4 NOT EXISTS clauses (3 exclusion anti-joins + 1
    # suppression anti-join) and still 3 (not 4) `e.author = cp.author` —
    # the suppression clause uses its own alias `s`, not `e`, so it must not
    # accidentally satisfy (or double-count against) the exclusion assertions
    # in test_author_engagement_sql_applies_full_exclusion_and_attribution.
    assert sql.count("NOT EXISTS") == 4
    assert sql.count("e.author = cp.author") == 3


def test_author_engagement_flattens_excluded_and_maps_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No DB: stub _fetch to capture the params author_engagement builds and to
    return aggregate rows, then assert the exclusion flattening + row mapping.
    Self is dropped from the arrays (already handled by ``<> c.author``); each
    remaining excluded account is paired with ITS OWN author key."""
    seen: list[tuple[str, dict[str, Any]]] = []

    def fake_fetch(
        self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]
    ) -> list[tuple[Any, ...]]:
        seen.append((sql, params))
        return [("farm", 5, 2.7092), ("steady", 5, 1.5051)]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    result = CLIENT.author_engagement(
        frozenset({"farm", "steady"}),
        datetime(2026, 1, 1, tzinfo=UTC),
        excluded={
            "farm": frozenset({"alt1", "alt2", "farm"}),  # 'farm' = self, dropped
            "steady": frozenset({"steady"}),  # only self -> contributes nothing
        },
    )
    sql_seen, params = seen[0]
    assert sql_seen is hafsql._SQL_AUTHOR_ENGAGEMENT
    assert set(params["authors"]) == {"farm", "steady"}
    pairs = sorted(zip(params["excl_authors"], params["excl_accounts"], strict=True))
    assert pairs == [("farm", "alt1"), ("farm", "alt2")]
    assert result["farm"] == AuthorEngagement(posts=5, total_base=2.7092)
    assert result["steady"] == AuthorEngagement(posts=5, total_base=1.5051)
    # No `trust` passed (the default) -> the breadth budget must never bind:
    # empty vouched set, an effectively-infinite unknown_free, zero slope. The
    # query then collapses to the pre-H05 raw distinct count.
    assert params["vouched"] == []
    assert params["unknown_free"] == hafsql._UNBUDGETED_UNKNOWN_FREE
    assert params["unknown_per_vouched"] == 0.0


def test_author_engagement_threads_the_voter_trust_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """H05: a ``trust`` snapshot must reach the query as the SAME
    vouched/unknown_free/unknown_per_vouched the scorer applies to own_base —
    not reconstructed, not defaulted away."""
    seen: list[dict[str, Any]] = []

    def fake_fetch(
        self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]
    ) -> list[tuple[Any, ...]]:
        seen.append(params)
        return [("farm", 5, 1.2)]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    trust = VoterTrust(
        vouched=frozenset({"h1", "h2"}), unknown_free=1.0, unknown_per_vouched=2.0
    )
    CLIENT.author_engagement(
        frozenset({"farm"}), datetime(2026, 1, 1, tzinfo=UTC), trust=trust
    )
    params = seen[0]
    assert set(params["vouched"]) == {"h1", "h2"}
    assert params["unknown_free"] == 1.0
    assert params["unknown_per_vouched"] == 2.0


def test_author_engagement_no_exclusion_sends_empty_arrays(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``excluded=None`` (no trust snapshot) is self-exclusion only: the arrays
    are empty, the anti-join matches nothing, behaviour degrades honestly."""
    seen: list[dict[str, Any]] = []

    def fake_fetch(
        self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]
    ) -> list[tuple[Any, ...]]:
        seen.append(params)
        return [("solo", 3, 0.9)]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    CLIENT.author_engagement(frozenset({"solo"}), datetime(2026, 1, 1, tzinfo=UTC))
    assert seen[0]["excl_authors"] == []
    assert seen[0]["excl_accounts"] == []
    assert seen[0]["vouched"] == []


def test_author_engagement_empty_authors_short_circuits() -> None:
    assert CLIENT.author_engagement(frozenset(), datetime(2026, 1, 1, tzinfo=UTC)) == {}


def test_engagement_edges_reply_back_uses_own_timestamp(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression (§8.3): a fresh reply-back must not be decayed by the stale
    forward reply's timestamp — ``last_interaction`` must pick up the reverse
    pair's own ``MAX(created)``, not just the forward pair's. No DB: the
    private ``_edge_counts`` fetch step is stubbed so no connection opens."""
    old_ts = datetime(2026, 1, 1, tzinfo=UTC)
    new_ts = datetime(2026, 6, 1, tzinfo=UTC)

    def fake_edge_counts(
        self: hafsql.HafsqlClient, sql: str, since: datetime
    ) -> dict[tuple[str, str], tuple[int, datetime | None]]:
        if sql == hafsql._SQL_REPLY_EDGES:
            return {("alice", "bob"): (1, old_ts), ("bob", "alice"): (1, new_ts)}
        return {}

    monkeypatch.setattr(hafsql.HafsqlClient, "_edge_counts", fake_edge_counts)
    edges = CLIENT.engagement_edges(old_ts)
    edge = next(e for e in edges if e.src == "alice" and e.dst == "bob")
    assert edge.reply_backs == 1
    assert edge.last_interaction == new_ts


# ---------------------------------------------------------------------------
# Lumen Lite reachability. Lite posts are depth-1 comments published by a shared
# frontend account under a rolling container, so before this the whole Lite tier
# was invisible to ranking AND was inflating the publisher's comment count.
# ---------------------------------------------------------------------------


def test_a_lite_post_is_ranked_as_its_WRITER_not_as_the_publisher() -> None:
    """The chain author is the shared publisher account. Ranking must use the
    writer, or every lite user's engagement collapses onto one account and every
    real lite user scores zero."""
    row = ("lumen-publisher", "lumen-01k", "lumen",
           datetime(2026, 1, 1, tzinfo=UTC), ["photo"], "u_alice")
    post = hafsql._build_post(row, {}, {}, {}, {"lumen-publisher": 9_000_000_000})
    assert post.author == "u_alice"


def test_hydration_still_keys_on_the_CHAIN_identity() -> None:
    """Votes, comments and reblogs are recorded on chain against the publisher
    account + permlink. Substituting the author before the lookup would silently
    zero every lite post's engagement."""
    chain_key = ("lumen-publisher", "lumen-01k")
    row = ("lumen-publisher", "lumen-01k", "lumen",
           datetime(2026, 1, 1, tzinfo=UTC), ["photo"], "u_alice")
    post = hafsql._build_post(
        row, {chain_key: [Vote(voter="bob", rshares=100, timestamp=datetime(2026,1,1,tzinfo=UTC))]},
        {chain_key: {"carol": 2}},
        {chain_key: ("dave",)}, {},
    )
    assert post.author == "u_alice"
    assert post.commenters == ("carol",)
    assert post.rebloggers == ("dave",)
    assert len(post.votes) == 1


def test_a_lite_writer_does_not_inherit_the_publishers_reputation() -> None:
    """Otherwise every lite user free-rides on a shared score they did not earn,
    and one bad lite post drags down every other lite user at once."""
    hive_row = ("alice", "p1", "photo", datetime(2026, 1, 1, tzinfo=UTC), ["photo"], None)
    lite_row = ("lumen-publisher", "lumen-01k", "lumen",
                datetime(2026, 1, 1, tzinfo=UTC), ["photo"], "u_alice")
    reps = {"alice": 9_000_000_000, "lumen-publisher": 9_000_000_000}

    hive_post = hafsql._build_post(hive_row, {}, {}, {}, reps)
    lite_post = hafsql._build_post(lite_row, {}, {}, {}, reps)

    assert lite_post.author_reputation == hafsql._reputation_display(0)
    assert lite_post.author_reputation < hive_post.author_reputation


def test_lite_sourcing_is_OFF_until_publishers_are_named() -> None:
    """The trust boundary. `json_metadata` is attacker-controlled — anyone can
    publish a comment claiming `app = lumen/1.0` and any writer id. The claim is
    only honoured inside a container owned by a CONFIGURED publisher, and with no
    publishers configured the predicate is dead, so this change is inert until
    someone deliberately turns it on."""
    from recsys.config import LiteConfig

    assert LiteConfig().enabled is False
    assert LiteConfig().publisher_accounts == frozenset()
    assert LiteConfig(publisher_accounts=frozenset({"lumen-publisher"})).enabled is True

    off = hafsql.HafsqlClient(HafsqlConfig())._lite_params()
    assert off["lite_publishers"] == []

    on = hafsql.HafsqlClient(
        HafsqlConfig(), LiteConfig(publisher_accounts=frozenset({"b", "a"}))
    )._lite_params()
    assert on["lite_publishers"] == ["a", "b"]      # sorted -> deterministic SQL
    assert on["lite_app"] == "lumen/1.0"


def test_the_trust_boundary_requires_BOTH_author_and_parent_to_be_publishers() -> None:
    """A lite post lives in OUR container, published by OUR account. Requiring
    only one side would let anyone comment under a container (or claim our app id
    on their own post) and be ranked as whatever writer they named."""
    predicate = hafsql._LITE_POST.format(t="")
    assert "author = ANY(%(lite_publishers)s)" in predicate
    assert "parent_author = ANY(%(lite_publishers)s)" in predicate
    assert "json_metadata->>'app' = %(lite_app)s" in predicate


def test_a_lite_post_is_not_counted_as_a_comment_on_its_container() -> None:
    """It is a POST that happens to be stored as a comment. Counting it credited
    the whole Lite tier's output to the container owner's organic score."""
    # COALESCE(..., false) matters as much as the NOT: json_metadata is NULL on
    # ordinary comments, and NOT NULL is NULL, which Postgres filters out.
    assert "AND NOT COALESCE(" in hafsql._SQL_COMMENTS_FOR_POSTS
    assert ", false)" in hafsql._SQL_COMMENTS_FOR_POSTS
    assert "rc.json_metadata->>'app' = %(lite_app)s" in hafsql._SQL_COMMENTS_FOR_POSTS


# ---------------------------------------------------------------------------
# A2 — the 8 live I/O breaks, all reproduced and fixed against the real
# mirror 2026-08-04 (see the build report). Offline pins for each SQL-shape
# fix; the actual crash/no-crash proof is `tests/test_hafsql_live.py` (A3).
# ---------------------------------------------------------------------------


def test_in_network_posts_and_engaged_oon_posts_use_fetch_lite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """breaks #1/#2 (live: ``ProgrammingError: query parameter missing:
    lite_app, lite_publishers``): both queries bake in lite placeholders at
    IMPORT time via ``_top_level_or_lite()``, so both must bind them via
    ``_fetch_lite`` even with lite fully off."""
    calls: list[str] = []

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        calls.append("lite")
        return []

    def fail_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        raise AssertionError("must call _fetch_lite (missing lite params otherwise)")

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fail_fetch)
    since = datetime(2026, 1, 1, tzinfo=UTC)
    CLIENT.in_network_posts(frozenset({"alice"}), since, 5)
    CLIENT.engaged_oon_posts(frozenset({"alice"}), since, 5)
    assert calls == ["lite", "lite"]


def test_tag_posts_sql_uses_the_jsonb_any_operator() -> None:
    """break #3 (live: ``UndefinedFunction: operator does not exist: jsonb &&
    unknown``): ``hafsql.comments.tags`` is ``jsonb``, not ``text[]`` — ``&&``
    has no jsonb overload. ``?|`` (any of these keys/elements exist) does."""
    assert "tags ?| %(tags)s::text[]" in hafsql._SQL_TAG_POSTS
    assert "tags &&" not in hafsql._SQL_TAG_POSTS


def test_reply_edges_sql_uses_timestamp_not_the_nonexistent_created_column() -> None:
    """break #6 (live: ``UndefinedColumn: column "created" does not exist`` —
    kills the whole weekly trust batch): ``hafsql.operation_comment_view`` has
    no ``created`` column; it is ``timestamp``."""
    assert "MAX(timestamp)" in hafsql._SQL_REPLY_EDGES
    assert "timestamp >= %(since)s" in hafsql._SQL_REPLY_EDGES
    # the OLD, broken clauses must be gone from the actual SQL (not merely
    # from the explanatory comment, which legitimately still says "created"
    # while describing the bug this fixes)
    assert "MAX(created)" not in hafsql._SQL_REPLY_EDGES
    assert "created >= %(since)s" not in hafsql._SQL_REPLY_EDGES


def test_author_engagement_sql_casts_the_log_argument_to_numeric() -> None:
    """break #5 (live: ``UndefinedFunction: function log(integer, double
    precision) does not exist``): no ``(int, double precision)`` overload of
    ``LOG`` exists; casting the argument to ``numeric`` picks the overload
    that does (verified live)."""
    assert "LOG(10, (1 + (" in hafsql._SQL_AUTHOR_ENGAGEMENT
    assert "::numeric)) AS total_base" in hafsql._SQL_AUTHOR_ENGAGEMENT


def test_votes_for_posts_coerces_decimal_rshares_and_naive_timestamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """break #7 (live: ``TypeError: unsupported operand type(s) for /:
    'decimal.Decimal' and 'float'``, surfacing at ``normalize.py:27``'s
    ``log_compress``): Postgres ``numeric`` comes back as ``Decimal``, but
    ``Vote.rshares`` is ``int`` and nothing coerced it. The vote ``timestamp``
    is also naive (break #8's cause) and must be coerced at the same
    boundary."""

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        return [
            ("alice", "p1", "bob", Decimal("12345678900"), datetime(2026, 1, 1, 12, 0, 0)),
        ]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    grouped = CLIENT._votes_for_posts(["alice"], ["p1"])
    vote = grouped[("alice", "p1")][0]
    assert isinstance(vote.rshares, int)
    assert not isinstance(vote.rshares, Decimal)
    assert vote.rshares == 12345678900
    assert vote.timestamp.tzinfo is UTC


def test_edge_counts_coerces_naive_last_interaction_to_aware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """break #8 (live: ``operation_effective_comment_vote_view.timestamp`` and
    ``reblogs.created_at`` are ``timestamp WITHOUT time zone`` — verified
    naive on real rows): every consumer compares against a tz-aware ``now``
    and a naive/aware subtraction raises ``TypeError``."""

    def fake_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        return [("alice", "bob", 3, datetime(2026, 1, 1, 12, 0, 0))]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    counts = CLIENT._edge_counts(hafsql._SQL_UPVOTE_EDGES, datetime(2026, 1, 1, tzinfo=UTC))
    count, ts = counts[("alice", "bob")]
    assert count == 3
    assert ts is not None
    assert ts.tzinfo is UTC


def test_edge_counts_preserves_none_for_a_channel_with_no_interaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``None`` (no interaction of that kind between the pair) must stay
    ``None`` — only a PRESENT naive timestamp gets coerced."""

    def fake_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        return [("alice", "bob", 0, None)]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    counts = CLIENT._edge_counts(hafsql._SQL_UPVOTE_EDGES, datetime(2026, 1, 1, tzinfo=UTC))
    assert counts[("alice", "bob")] == (0, None)


def test_as_aware_adds_utc_to_a_naive_timestamp() -> None:
    naive = datetime(2026, 1, 1, 12, 0, 0)
    aware = hafsql._as_aware(naive)
    assert aware.tzinfo is UTC
    assert aware.replace(tzinfo=None) == naive


def test_as_aware_leaves_an_already_aware_timestamp_unchanged() -> None:
    aware_in = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
    assert hafsql._as_aware(aware_in) is aware_in


# ---------------------------------------------------------------------------
# A15 — network_suppression lives in a SECOND, optional connection to the
# recsys DB (BUILD-ADJUDICATION-2026-08-04 ruling R9). Absent -> "nothing
# suppressed" + a one-time WARNING, never a crash.
# ---------------------------------------------------------------------------


def test_client_without_a_recsys_dsn_warns_once_at_construction(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("RECSYS_DATABASE_URL", raising=False)
    with caplog.at_level("WARNING", logger="recsys.io.hafsql"):
        client = hafsql.HafsqlClient(HafsqlConfig())
    assert client._recsys_dsn is None
    assert any("RECSYS_DATABASE_URL" in r.message for r in caplog.records)


def test_client_recsys_dsn_kwarg_wins_over_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECSYS_DATABASE_URL", "postgresql://from-env/db")
    client = hafsql.HafsqlClient(HafsqlConfig(), recsys_dsn="postgresql://explicit/db")
    assert client._recsys_dsn == "postgresql://explicit/db"


def test_client_recsys_dsn_falls_back_to_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECSYS_DATABASE_URL", "postgresql://from-env/db")
    client = hafsql.HafsqlClient(HafsqlConfig())
    assert client._recsys_dsn == "postgresql://from-env/db"


def test_suppressed_keys_degrades_to_empty_without_a_recsys_dsn(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("RECSYS_DATABASE_URL", raising=False)

    def fail_fetch_recsys(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        raise AssertionError("must not attempt a connection with no DSN configured")

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_recsys", fail_fetch_recsys)
    client = hafsql.HafsqlClient(HafsqlConfig())
    with caplog.at_level("WARNING", logger="recsys.io.hafsql"):
        result = client.suppressed_keys(frozenset({"@alice/p1"}))
    assert result == frozenset()
    assert any(
        "RECSYS_DATABASE_URL" in r.message or "suppress" in r.message.lower()
        for r in caplog.records
    )


def test_suppressed_keys_queries_the_recsys_db_when_a_dsn_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No live DB here: stub ``_fetch_recsys`` and assert it — never
    ``_fetch`` (the HAFSQL mirror, which has no such table) — is what
    ``suppressed_keys`` calls once a DSN is configured."""
    seen: list[tuple[str, dict[str, Any]]] = []

    def fake_fetch_recsys(
        self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]
    ) -> list[Any]:
        seen.append((sql, params))
        return [("alice", "p1")]

    def fail_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        raise AssertionError("suppressed_keys must not query the HAFSQL mirror")

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_recsys", fake_fetch_recsys)
    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fail_fetch)
    client = hafsql.HafsqlClient(HafsqlConfig(), recsys_dsn="postgresql://fake/dsn")
    result = client.suppressed_keys(frozenset({"@alice/p1"}))
    assert result == frozenset({"@alice/p1"})
    sql_seen, params = seen[0]
    assert sql_seen is hafsql._SQL_SUPPRESSED_KEYS
    assert params == {"authors": ["alice"], "permlinks": ["p1"]}


def test_author_engagement_fetches_suppression_from_the_recsys_db_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A15: ``author_engagement`` must do the recsys-DB round trip FIRST, then
    bind the result into the mirror query as ``supp_authors``/
    ``supp_permlinks`` — a live cross-database join is not possible."""
    recsys_calls: list[tuple[str, dict[str, Any]]] = []
    mirror_calls: list[dict[str, Any]] = []

    def fake_fetch_recsys(
        self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]
    ) -> list[Any]:
        recsys_calls.append((sql, params))
        return [("farm", "suppressed-post")]

    def fake_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        mirror_calls.append(params)
        return [("farm", 5, 2.7092)]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_recsys", fake_fetch_recsys)
    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    client = hafsql.HafsqlClient(HafsqlConfig(), recsys_dsn="postgresql://fake/dsn")
    result = client.author_engagement(frozenset({"farm"}), datetime(2026, 1, 1, tzinfo=UTC))

    assert len(recsys_calls) == 1
    recsys_sql, recsys_params = recsys_calls[0]
    assert recsys_sql is hafsql._SQL_SUPPRESSED_BY_AUTHORS
    assert recsys_params["authors"] == ["farm"]

    assert len(mirror_calls) == 1
    assert mirror_calls[0]["supp_authors"] == ["farm"]
    assert mirror_calls[0]["supp_permlinks"] == ["suppressed-post"]
    assert result["farm"] == AuthorEngagement(posts=5, total_base=2.7092)


def test_author_engagement_degrades_suppression_to_empty_without_a_dsn(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("RECSYS_DATABASE_URL", raising=False)
    mirror_calls: list[dict[str, Any]] = []

    def fake_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        mirror_calls.append(params)
        return [("solo", 3, 0.9)]

    def fail_fetch_recsys(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        raise AssertionError("must not attempt the recsys DB with no DSN configured")

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_recsys", fail_fetch_recsys)
    client = hafsql.HafsqlClient(HafsqlConfig())
    with caplog.at_level("WARNING", logger="recsys.io.hafsql"):
        client.author_engagement(frozenset({"solo"}), datetime(2026, 1, 1, tzinfo=UTC))
    assert mirror_calls[0]["supp_authors"] == []
    assert mirror_calls[0]["supp_permlinks"] == []


# ---------------------------------------------------------------------------
# A4.1/R7 — the hand-rolled connection pool: reuse, retry-on-connect-failure-
# only, and the circuit breaker. No DB needed — exercised against a fake
# `connect` callable.
# ---------------------------------------------------------------------------


class _FakeConn:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


def _pool(connect: Any, **overrides: Any) -> hafsql._ConnPool:
    kwargs: dict[str, Any] = {
        "min_size": 1,
        "max_size": 2,
        "max_retries": 0,
        "retry_backoff_s": 0.0,
        "breaker_threshold": 5,
        "breaker_cooldown_s": 30.0,
    }
    kwargs.update(overrides)
    return hafsql._ConnPool(connect, **kwargs)


def test_pool_warms_up_to_min_size_on_first_borrow_not_at_construction() -> None:
    """`min_size` must not be a dead parameter: it pre-warms the idle pool the
    first time it is actually used, never at `_ConnPool.__init__` — many
    offline tests construct a `HafsqlClient` (which constructs a pool) with no
    intent of ever touching the network, and eager-at-construction warm-up
    would turn every one of those into a real, likely-failing connection."""
    created: list[_FakeConn] = []

    def connect() -> _FakeConn:
        conn = _FakeConn()
        created.append(conn)
        return conn

    pool = _pool(connect, min_size=3, max_size=5)
    assert len(created) == 0  # nothing opened yet — pool object alone is inert

    first = pool.borrow()
    assert len(created) == 3  # the borrowed connection + 2 pre-warmed idle spares
    assert pool.connections_opened == 3

    # the 2 spares must be genuinely reusable, not just opened and discarded
    second = pool.borrow()
    third = pool.borrow()
    assert {id(first), id(second), id(third)} == {id(c) for c in created}
    assert pool.connections_opened == 3  # no 4th connection needed


def test_pool_does_not_warm_up_when_min_size_is_1() -> None:
    created: list[_FakeConn] = []

    def connect() -> _FakeConn:
        conn = _FakeConn()
        created.append(conn)
        return conn

    pool = _pool(connect, min_size=1, max_size=5)
    pool.borrow()
    assert len(created) == 1


def test_pool_reuses_a_released_healthy_connection() -> None:
    created: list[_FakeConn] = []

    def connect() -> _FakeConn:
        conn = _FakeConn()
        created.append(conn)
        return conn

    pool = _pool(connect)
    conn1 = pool.borrow()
    pool.release(conn1, healthy=True)
    conn2 = pool.borrow()
    assert conn2 is conn1
    assert len(created) == 1
    assert pool.connections_opened == 1


def test_pool_discards_an_unhealthy_connection_on_release() -> None:
    created: list[_FakeConn] = []

    def connect() -> _FakeConn:
        conn = _FakeConn()
        created.append(conn)
        return conn

    pool = _pool(connect)
    conn1 = pool.borrow()
    pool.release(conn1, healthy=False)
    assert conn1.closed is True
    conn2 = pool.borrow()
    assert conn2 is not conn1
    assert len(created) == 2


def test_fetch_via_does_not_retry_a_statement_error() -> None:
    """R7: retry is scoped to ``connect()`` only. A statement error (bad SQL,
    ``UndefinedTable``, ...) happens inside ``cur.execute()`` — outside the
    pool's retry loop entirely — so ``pool.borrow()`` is called exactly ONCE
    per fetch regardless of what the query itself raises."""
    import psycopg

    borrow_calls = {"n": 0}

    class _Cursor:
        def __enter__(self) -> _Cursor:
            return self

        def __exit__(self, *exc: object) -> bool:
            return False

        def execute(self, sql: str, params: dict[str, Any]) -> None:
            raise psycopg.errors.UndefinedTable("boom")

        def fetchall(self) -> list[Any]:
            return []

    class _Conn:
        closed = False

        def cursor(self) -> _Cursor:
            return _Cursor()

    class _StubPool:
        def borrow(self) -> _Conn:
            borrow_calls["n"] += 1
            return _Conn()

        def release(self, conn: _Conn, *, healthy: bool) -> None:
            pass

    client = hafsql.HafsqlClient(HafsqlConfig())
    with pytest.raises(psycopg.errors.UndefinedTable):
        client._fetch_via(_StubPool(), "SELECT 1", {})  # type: ignore[arg-type]
    assert borrow_calls["n"] == 1


def test_pool_retries_connection_failures_up_to_max_retries() -> None:
    import psycopg

    attempts = {"n": 0}

    def flaky_connect() -> _FakeConn:
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise psycopg.OperationalError("simulated connection failure")
        return _FakeConn()

    pool = _pool(flaky_connect, max_retries=3, breaker_threshold=10)
    conn = pool.borrow()
    assert attempts["n"] == 3
    assert isinstance(conn, _FakeConn)


def test_pool_gives_up_after_max_retries_exhausted() -> None:
    import psycopg

    attempts = {"n": 0}

    def always_fails() -> _FakeConn:
        attempts["n"] += 1
        raise psycopg.OperationalError("simulated: db unreachable")

    pool = _pool(always_fails, max_retries=2, breaker_threshold=100)
    with pytest.raises(psycopg.OperationalError):
        pool.borrow()
    assert attempts["n"] == 3  # 1 initial + 2 retries


def test_pool_circuit_breaker_opens_after_threshold_and_fails_fast() -> None:
    """R7: after enough CONSECUTIVE connect failures, the breaker opens and
    further borrows fail immediately (HafsqlUnavailableError) without calling
    connect() again — fail loudly rather than hang through more retries."""
    import psycopg

    attempts = {"n": 0}

    def always_fails() -> _FakeConn:
        attempts["n"] += 1
        raise psycopg.OperationalError("simulated: db unreachable")

    pool = _pool(always_fails, max_retries=1, breaker_threshold=2, breaker_cooldown_s=60.0)
    with pytest.raises(hafsql.HafsqlUnavailableError):
        pool.borrow()
    attempts_after_first_borrow = attempts["n"]
    assert attempts_after_first_borrow >= 2

    with pytest.raises(hafsql.HafsqlUnavailableError):
        pool.borrow()
    assert attempts["n"] == attempts_after_first_borrow  # no new connect() calls


def test_pool_circuit_breaker_half_opens_after_cooldown() -> None:
    import psycopg

    calls = {"n": 0}

    def connect() -> _FakeConn:
        calls["n"] += 1
        if calls["n"] == 1:
            raise psycopg.OperationalError("first call fails")
        return _FakeConn()

    pool = _pool(connect, max_retries=0, breaker_threshold=1, breaker_cooldown_s=30.0)
    with pytest.raises(hafsql.HafsqlUnavailableError):
        pool.borrow()
    assert pool._breaker_opened_at is not None
    # Simulate cooldown elapsed without a real sleep.
    pool._breaker_opened_at = time.monotonic() - 31.0
    conn = pool.borrow()  # half-open probe: connect() is retried and succeeds
    assert isinstance(conn, _FakeConn)
    assert calls["n"] == 2


# ---------------------------------------------------------------------------
# B2 (2026-08-05) — stake_lineage is GONE. The three memoization tests that
# lived here pinned a query that no longer exists.
# ---------------------------------------------------------------------------


def test_stake_lineage_is_structurally_absent() -> None:
    """★ ANTI-REINSTATEMENT TEST. Hive `delegate_vesting_shares` needs no
    consent from the delegatee, so this relation let any stranger with RC edit
    another author's exclusion set (measured: organic percentile 0.79 -> 0.07,
    top-20 slots 15 -> 0). It was deleted rather than neutered, so that a future
    caller cannot quietly reintroduce the input.

    This asserts the ABSENCE holds at three layers at once — the SQL, the
    client, and the gateway protocol. See `recsys.pipeline._lineage_for` for
    the rationale and for where a CONSENT-BEARING replacement would attach."""
    assert not hasattr(hafsql, "_SQL_STAKE_LINEAGE")
    assert not hasattr(hafsql.HafsqlClient, "stake_lineage")
    assert "stake_lineage" not in dir(HafsqlGateway)
    assert "delegations" not in "".join(_SQL_CONSTANTS)


# ---------------------------------------------------------------------------
# A4.4 — popular_posts is viewer-independent (`since, limit` only) and
# cacheable process-wide; on the hot path for almost every request.
# ---------------------------------------------------------------------------


def test_popular_posts_caches_within_the_bucket_and_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        calls["n"] += 1
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    client = hafsql.HafsqlClient(HafsqlConfig())
    since = datetime(2026, 1, 1, tzinfo=UTC)
    client.popular_posts(since, 10)
    client.popular_posts(since, 10)
    assert calls["n"] == 1


def test_popular_posts_cache_key_ignores_sub_bucket_jitter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two calls whose ``since`` differs only by the gap between two ``now()``
    calls must still hit the same cache entry, or the cache never fires in
    practice — every real caller recomputes ``since`` per request."""
    calls = {"n": 0}

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        calls["n"] += 1
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    client = hafsql.HafsqlClient(HafsqlConfig())
    since1 = datetime(2026, 1, 1, 12, 0, 0, 123456, tzinfo=UTC)
    since2 = since1 + timedelta(milliseconds=50)
    client.popular_posts(since1, 10)
    client.popular_posts(since2, 10)
    assert calls["n"] == 1


def test_popular_posts_cache_misses_on_a_different_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        calls["n"] += 1
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    client = hafsql.HafsqlClient(HafsqlConfig())
    since = datetime(2026, 1, 1, tzinfo=UTC)
    client.popular_posts(since, 10)
    client.popular_posts(since, 20)
    assert calls["n"] == 2


# ---------------------------------------------------------------------------
# A5 — `window_posts`: the missing NormContext sample source. Must NOT be
# engagement-ordered like `popular_posts` (that would bias the percentile
# sample upward), and must include lite posts on the same terms as every
# other lane. Live sizing/timing proof is `tests/test_hafsql_live.py`.
# ---------------------------------------------------------------------------


def test_window_posts_sql_orders_by_recency_only() -> None:
    """The defining property of A5: `ORDER BY created DESC`, nothing else —
    no engagement subquery anywhere in the ORDER BY (contrast
    `_SQL_POPULAR_POSTS`, which orders by a weighted attributed-engagement
    expression)."""
    sql = hafsql._SQL_WINDOW_POSTS
    assert "ORDER BY c.created DESC" in sql
    assert "ORDER BY (" not in sql  # `_SQL_POPULAR_POSTS`'s engagement-weighted shape


def test_window_posts_sql_has_no_engagement_subqueries() -> None:
    """Reusing `_SQL_POPULAR_POSTS`'s shape would pull in three correlated
    per-post engagement subqueries — exactly what A5 exists to avoid, both for
    bias (see the module comment above `_SQL_WINDOW_POSTS`) and for cost."""
    sql = hafsql._SQL_WINDOW_POSTS
    assert "COUNT(DISTINCT" not in sql
    assert sql.count("SELECT") == 1  # one flat query, no correlated subqueries


def test_window_posts_sql_includes_lite_posts_on_the_same_terms() -> None:
    """A5's own requirement: lite posts must be included on the same terms as
    every other lane — `_top_level_or_lite`, not a bare `parent_author = ''`."""
    sql = hafsql._SQL_WINDOW_POSTS
    assert "parent_author = ''" in sql  # inside _top_level_or_lite's OR
    assert "lite_publishers" in sql
    assert "lite_app" in sql
    assert "deleted = false" in sql
    assert "created >= %(since)s" in sql


def test_window_posts_calls_fetch_lite_with_since_and_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, dict[str, Any]]] = []

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        seen.append((sql, params))
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    since = datetime(2026, 1, 1, tzinfo=UTC)
    result = CLIENT.window_posts(since, 500)
    assert result == []
    sql_seen, params = seen[0]
    assert sql_seen is hafsql._SQL_WINDOW_POSTS
    assert params == {"since": since, "limit": 500}


def test_window_posts_hydrates_the_rows_it_fetches(monkeypatch: pytest.MonkeyPatch) -> None:
    row = ("alice", "p1", "photo", datetime(2026, 1, 1, tzinfo=UTC), ["photo"], None)

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        # `_hydrate` fans out into more `_fetch_lite` calls of its own
        # (votes/comments/rebloggers/reputation) — only the window-posts query
        # itself should return the row; everything else stays empty.
        return [row] if sql is hafsql._SQL_WINDOW_POSTS else []

    def fake_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    posts = CLIENT.window_posts(datetime(2026, 1, 1, tzinfo=UTC), 500)
    assert len(posts) == 1
    assert posts[0].author == "alice"
    assert posts[0].permlink == "p1"


# ---------------------------------------------------------------------------
# A11 — the author-pooled prior matches/groups on the RANKED identity (the
# lite writer's `lumen_user_id` where present, else the chain author), not
# the bare chain author, so a lite author's prior is no longer structurally
# empty. The exclusion anti-join and the vote/comment/reblog hydration join
# keys stay on the chain identity — unchanged, on purpose (pinned by the
# existing `test_author_engagement_sql_applies_full_exclusion_and_attribution`,
# which still asserts `e.author = cp.author` x3 and is untouched by this unit).
#
# PERF (2026-08-04, this builder) restructured HOW the ranked identity is
# computed — a `UNION ALL` of an ordinary branch (`identity = c.author`,
# sargable on `(author, created)`) and a lite branch (`identity =
# c.json_metadata->>'lumen_user_id'`, gated on genuine lite-publisher
# provenance) — instead of one `COALESCE(...)` row filter. The tests below
# were rewritten for the new shape; the INVARIANT they pin (A11: a lite
# writer's identity is reachable; a real Hive author's identity is exactly
# their chain author) is unchanged, and is additionally proven end-to-end
# (not just via SQL-text matching) by
# `test_author_engagement_matches_a_lite_identity_end_to_end` and the live
# regression pins in `tests/test_hafsql_live.py`.
# ---------------------------------------------------------------------------


def test_author_engagement_sql_matches_the_ranked_identity_not_bare_author() -> None:
    """A11's defining property, preserved across the PERF rewrite: a row whose
    `identity` is a lite writer's `lumen_user_id` must be reachable via
    `%(authors)s` — not just a bare `c.author = ANY(...)` gate, which is the
    literal shape that made a lite writer's identity match zero rows, always."""
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    # the LITE branch matches on the ranked (lumen_user_id) identity...
    assert "c.json_metadata->>'lumen_user_id' = ANY(%(authors)s)" in sql
    # ...and the ORDINARY branch explicitly excludes lumen_user_id-bearing rows
    # (PERF's "narrower trust surface" note: only a GENUINE lite post, gated
    # the same way `_LITE_POST` gates it, may substitute the ranked identity),
    # so the two branches partition disjointly rather than double-counting.
    assert "c.json_metadata->>'lumen_user_id' IS NULL" in sql
    assert "c.author = ANY(%(authors)s)" in sql  # the ordinary branch's own gate


def test_author_engagement_sql_selects_and_groups_by_the_ranked_identity() -> None:
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    # the CTE projects `identity` as the chain author for the ordinary branch...
    assert "c.author::text AS identity" in sql
    # ...and as the lumen_user_id for the lite branch...
    assert "c.json_metadata->>'lumen_user_id' AS identity" in sql
    # ...and the outer aggregate selects/groups by THAT column, not a bare author.
    assert "SELECT cp.identity AS author," in sql
    assert sql.rstrip().endswith("GROUP BY cp.identity")
    assert "GROUP BY c.author" not in sql
    assert "GROUP BY cp.author" not in sql


def test_author_engagement_sql_widens_the_row_filter_with_top_level_or_lite() -> None:
    """The pre-PERF single-query OR-shape (`_top_level_or_lite`) is gone —
    admission is now a `UNION ALL` of two SARGABLE branches that together
    admit exactly the same rows: ordinary top-level posts, and genuine lite
    posts gated the same way `_LITE_POST` gates them (both `author` and
    `parent_author` must be a configured lite publisher)."""
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    assert "UNION ALL" in sql
    assert "c.parent_author = ''" in sql  # ordinary branch: top-level only
    assert "c.author = ANY(%(lite_publishers)s)" in sql  # lite branch: publisher...
    assert "c.parent_author = ANY(%(lite_publishers)s)" in sql  # ...container too
    assert "c.json_metadata->>'app' = %(lite_app)s" in sql


def test_author_engagement_sql_exclusion_and_hydration_joins_stay_on_chain_author() -> None:
    """MUST-NOT-CHANGE (A11's own scope note, still true after the PERF
    rewrite): the exclusion anti-join and the vote/comment/reblog hydration
    join predicates stay on the chain identity (`cp.author`/`cp.permlink`,
    fed by the CTE's `author`/`permlink` columns, which are ALWAYS the chain
    author+permlink regardless of branch — see the CTE definition) — a
    vote/comment/reblog is only ever recorded on chain against the publisher
    account, never against a `lumen_user_id` (not a Hive account at all).
    This is the same invariant
    `test_author_engagement_sql_applies_full_exclusion_and_attribution` pins;
    restated here under A11's own name so a future change to either query
    shape trips both."""
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    assert sql.count("e.author = cp.author") == 3
    # votes/comments read `hafd.operations` directly (PERF: bypasses the
    # blocks-joining views) but the join KEY is unchanged — chain author +
    # permlink, matched against the CTE's `cp.author`/`cp.permlink`.
    assert "((o.body_binary::jsonb -> 'value') ->> 'author') = cp.author" in sql
    assert "((o.body_binary::jsonb -> 'value') ->> 'permlink') = cp.permlink" in sql
    assert "((o2.body_binary::jsonb -> 'value') ->> 'parent_author')" in sql
    assert "((o2.body_binary::jsonb -> 'value') ->> 'parent_permlink')" in sql
    assert "WHERE r.author = cp.author AND r.permlink = cp.permlink" in sql


def test_author_engagement_now_calls_fetch_lite(monkeypatch: pytest.MonkeyPatch) -> None:
    """A11: `_top_level_or_lite(c)` bakes in the lite placeholders at import
    time (the same class of bug A2 breaks #1/#2 fixed elsewhere), so the
    mirror round trip must go through `_fetch_lite`, not the bare `_fetch`."""
    seen: list[dict[str, Any]] = []

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        seen.append(params)
        return [("farm", 5, 2.7092)]

    def fail_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        raise AssertionError(
            "author_engagement must call _fetch_lite (missing lite params otherwise)"
        )

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fail_fetch)
    result = CLIENT.author_engagement(frozenset({"farm"}), datetime(2026, 1, 1, tzinfo=UTC))
    assert result["farm"] == AuthorEngagement(posts=5, total_base=2.7092)
    assert seen[0]["authors"] == ["farm"]


def test_author_engagement_matches_a_lite_identity_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A11's acceptance shape: querying for a `lumen_user_id`-style identity
    (never a real chain author) must return a row — proving the WHERE clause
    genuinely matches it, not just that the SQL text contains the right
    fragment. No DB: stub `_fetch_lite` to simulate what the live mirror would
    return for a row whose `_identity(c)` evaluates to the lite identity."""
    seen: list[dict[str, Any]] = []

    def fake_fetch_lite(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        seen.append(params)
        assert "u_7f3c9a" in params["authors"]
        return [("u_7f3c9a", 3, 1.2345)]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    result = CLIENT.author_engagement(
        frozenset({"u_7f3c9a"}), datetime(2026, 1, 1, tzinfo=UTC)
    )
    assert result["u_7f3c9a"] == AuthorEngagement(posts=3, total_base=1.2345)


# ---------------------------------------------------------------------------
# A12 — `Post.key` is structurally unmatchable by `second_degree_engagers`/
# `suppressed_keys` for a lite post: the ranked key carries the lite writer's
# identity, but votes/comments/reblogs/suppression reports are recorded on
# chain against the publisher account. `_resolve_post_keys`/`chain_author_map`
# fix the QUERY side while `Post.key` keeps ranking on the lite identity.
# ---------------------------------------------------------------------------


def test_build_post_sets_chain_author_for_a_lite_post() -> None:
    row = ("lumen-publisher", "lumen-01k", "lumen",
           datetime(2026, 1, 1, tzinfo=UTC), ["photo"], "u_alice")
    post = hafsql._build_post(row, {}, {}, {}, {})
    assert post.author == "u_alice"           # ranked identity, unchanged by A12
    assert post.chain_author == "lumen-publisher"
    assert post.key == "@u_alice/lumen-01k"   # A12 does NOT touch `.key`


def test_build_post_leaves_chain_author_none_for_an_ordinary_hive_post() -> None:
    row = ("alice", "p1", "photo", datetime(2026, 1, 1, tzinfo=UTC), ["photo"], None)
    post = hafsql._build_post(row, {}, {}, {}, {})
    assert post.author == "alice"
    assert post.chain_author is None


def test_chain_author_map_includes_only_posts_whose_chain_author_differs() -> None:
    lite_row = ("lumen-publisher", "lumen-01k", "lumen",
                datetime(2026, 1, 1, tzinfo=UTC), ["photo"], "u_alice")
    hive_row = ("alice", "p1", "photo", datetime(2026, 1, 1, tzinfo=UTC), ["photo"], None)
    lite_post = hafsql._build_post(lite_row, {}, {}, {}, {})
    hive_post = hafsql._build_post(hive_row, {}, {}, {}, {})

    mapping = hafsql.chain_author_map([lite_post, hive_post])

    assert mapping == {"@u_alice/lumen-01k": "lumen-publisher"}
    assert hive_post.key not in mapping


def test_resolve_post_keys_with_no_chain_authors_matches_split_keys() -> None:
    """`chain_authors=None` (or empty) must be byte-identical to the pre-A12
    parse — the exact pin `_split_keys` itself already carries."""
    keys = frozenset({"@alice/my-post"})
    authors, permlinks, reverse = hafsql._resolve_post_keys(keys, None)
    assert authors == ["alice"]
    assert permlinks == ["my-post"]
    assert reverse == {("alice", "my-post"): "@alice/my-post"}

    authors2, permlinks2 = hafsql._split_keys(keys)
    assert (authors2, permlinks2) == (authors, permlinks)


def test_resolve_post_keys_substitutes_the_chain_author_when_provided() -> None:
    lite_key = "@u_7f3c9a/re-lumen-c-01H-abc"
    authors, permlinks, reverse = hafsql._resolve_post_keys(
        frozenset({lite_key}), {lite_key: "lumen-publisher"}
    )
    assert authors == ["lumen-publisher"]  # queries the CHAIN author
    assert permlinks == ["re-lumen-c-01H-abc"]
    # reverse map lets the caller key its RESULT back onto the ranked key
    assert reverse == {("lumen-publisher", "re-lumen-c-01H-abc"): lite_key}


def test_resolve_post_keys_only_substitutes_keys_present_in_the_map() -> None:
    """A mixed batch (some lite, some ordinary Hive posts) must resolve each
    key independently — an ordinary post's key is untouched even when other
    keys in the same batch ARE substituted."""
    lite_key = "@u_7f3c9a/lite-post"
    hive_key = "@alice/hive-post"
    authors, _permlinks, reverse = hafsql._resolve_post_keys(
        frozenset({lite_key, hive_key}), {lite_key: "lumen-publisher"}
    )
    assert set(authors) == {"lumen-publisher", "alice"}
    assert reverse[("lumen-publisher", "lite-post")] == lite_key
    assert reverse[("alice", "hive-post")] == hive_key


def test_second_degree_engagers_resolves_chain_authors_and_reverse_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A12's end-to-end proof, offline: the query goes out under the CHAIN
    author, and the returned engager index is keyed on the ORIGINAL (ranked,
    lite-shaped) key — exactly what `filter_eligible`'s
    `engager_index.get(post.key)` (`core/second_degree.py`) looks up."""
    seen: list[dict[str, Any]] = []
    lite_key = "@u_7f3c9a/re-lumen-c-01H-abc"

    def fake_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        seen.append(params)
        return [("lumen-publisher", "re-lumen-c-01H-abc", "bob")]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    result = CLIENT.second_degree_engagers(
        frozenset({lite_key}),
        frozenset({"bob"}),
        chain_authors={lite_key: "lumen-publisher"},
    )
    assert seen[0]["authors"] == ["lumen-publisher"]  # queried under the CHAIN author
    assert result == {lite_key: frozenset({"bob"})}    # keyed on the RANKED key


def test_second_degree_engagers_without_chain_authors_is_unaffected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`chain_authors=None` (the default) must be byte-identical to the
    pre-A12 behaviour — every existing caller is unaffected until it opts in."""
    seen: list[dict[str, Any]] = []

    def fake_fetch(self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]) -> list[Any]:
        seen.append(params)
        return [("alice", "p1", "bob")]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    result = CLIENT.second_degree_engagers(frozenset({"@alice/p1"}), frozenset({"bob"}))
    assert seen[0]["authors"] == ["alice"]
    assert result == {"@alice/p1": frozenset({"bob"})}


def test_suppressed_keys_resolves_chain_authors_and_reverse_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict[str, Any]] = []
    lite_key = "@u_7f3c9a/re-lumen-c-01H-abc"

    def fake_fetch_recsys(
        self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]
    ) -> list[Any]:
        seen.append(params)
        return [("lumen-publisher", "re-lumen-c-01H-abc")]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_recsys", fake_fetch_recsys)
    client = hafsql.HafsqlClient(HafsqlConfig(), recsys_dsn="postgresql://fake/dsn")
    result = client.suppressed_keys(
        frozenset({lite_key}), chain_authors={lite_key: "lumen-publisher"}
    )
    assert seen[0]["authors"] == ["lumen-publisher"]
    assert result == frozenset({lite_key})  # a suppressed lite post IS suppressible now


def test_suppressed_keys_without_chain_authors_is_unaffected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_fetch_recsys(
        self: hafsql.HafsqlClient, sql: str, params: dict[str, Any]
    ) -> list[Any]:
        return [("alice", "p1")]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_recsys", fake_fetch_recsys)
    client = hafsql.HafsqlClient(HafsqlConfig(), recsys_dsn="postgresql://fake/dsn")
    result = client.suppressed_keys(frozenset({"@alice/p1"}))
    assert result == frozenset({"@alice/p1"})


# ---------------------------------------------------------------------------
# A13 — lite config wiring. `LiteConfig.publisher_accounts` has no
# `from_env` in `recsys/config.py` (owned by another workstream this phase),
# so `_lite_config_from_env` reads the SAME env vars the frontend uses
# (`frontend/apps/blog/lib/lite/config.ts`) plus one recsys-side override, and
# `HafsqlClient.__init__` consults it as a fallback whenever `lite=` is not
# explicitly passed.
# ---------------------------------------------------------------------------


def test_lite_config_from_env_defaults_to_off() -> None:
    assert hafsql._lite_config_from_env() == hafsql.LiteConfig()
    assert hafsql._lite_config_from_env().enabled is False


def test_lite_config_from_env_reads_the_explicit_recsys_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LITE_PUBLISHER_ACCOUNTS", "lumen-publisher")
    cfg = hafsql._lite_config_from_env()
    assert cfg.publisher_accounts == frozenset({"lumen-publisher"})
    assert cfg.enabled is True


def test_lite_config_from_env_reads_a_comma_separated_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LITE_PUBLISHER_ACCOUNTS", " lumen-a , lumen-b ,, lumen-c")
    cfg = hafsql._lite_config_from_env()
    assert cfg.publisher_accounts == frozenset({"lumen-a", "lumen-b", "lumen-c"})


def test_lite_config_from_env_reads_the_frontends_mainnet_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The SAME env var name the frontend reads
    (`frontend/apps/blog/lib/lite/config.ts:16`) — the whole point of A13's
    "one source of truth"."""
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_MAINNET", "lumen-frontend-main")
    cfg = hafsql._lite_config_from_env()
    assert cfg.publisher_accounts == frozenset({"lumen-frontend-main"})


def test_lite_config_from_env_reads_mirrornet_and_testnet_vars_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_MIRRORNET", "lumen-mirror")
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_TESTNET", "lumen-test")
    cfg = hafsql._lite_config_from_env()
    assert cfg.publisher_accounts == frozenset({"lumen-mirror", "lumen-test"})


def test_lite_config_from_env_merges_every_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LITE_PUBLISHER_ACCOUNTS", "lumen-explicit")
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_MAINNET", "lumen-main")
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_TESTNET", "lumen-main")  # dup, must not duplicate
    cfg = hafsql._lite_config_from_env()
    assert cfg.publisher_accounts == frozenset({"lumen-explicit", "lumen-main"})


def test_client_with_no_explicit_lite_falls_back_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """The A13 acceptance shape: a bare `HafsqlClient(HafsqlConfig())` — the
    exact call every existing caller in this codebase makes — picks up lite
    automatically the moment ops sets the frontend's own env var, no other
    code change required."""
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_MAINNET", "lumen-publisher")
    client = hafsql.HafsqlClient(HafsqlConfig())
    assert client._lite.enabled is True
    assert client._lite.publisher_accounts == frozenset({"lumen-publisher"})
    assert client._lite_params()["lite_publishers"] == ["lumen-publisher"]


def test_client_with_no_env_and_no_explicit_lite_stays_off() -> None:
    client = hafsql.HafsqlClient(HafsqlConfig())
    assert client._lite.enabled is False
    assert client._lite_params()["lite_publishers"] == []


def test_client_explicit_lite_config_wins_over_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """An EXPLICITLY passed `LiteConfig()` (even the empty default) means the
    caller deliberately chose lite-off; A13's env fallback must not override
    a deliberate choice — only a wholly-omitted `lite=` argument consults it."""
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_MAINNET", "lumen-publisher")
    client = hafsql.HafsqlClient(HafsqlConfig(), hafsql.LiteConfig())
    assert client._lite.enabled is False


def test_client_explicit_lite_config_kwarg_is_used_verbatim_even_with_env_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LITE_FRONTEND_ACCOUNT_MAINNET", "lumen-env-account")
    explicit = hafsql.LiteConfig(publisher_accounts=frozenset({"lumen-explicit-account"}))
    client = hafsql.HafsqlClient(HafsqlConfig(), explicit)
    assert client._lite.publisher_accounts == frozenset({"lumen-explicit-account"})


