"""Import + structural tests for the HAFSQL gateway (§S7). INFRA-GATED: no
database is reachable here, so these tests only check that the module imports
without ``psycopg`` installed, that ``HafsqlClient`` structurally implements
every ``HafsqlGateway`` method, and that its SQL constants are real queries.
No connection is opened and no query is executed.
"""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

import pytest

from recsys.config import HafsqlConfig, LiteConfig
from recsys.contracts import HafsqlGateway, Vote
from recsys.core.scoring import AuthorEngagement
from recsys.core.vote_signal import (
    _ORGANIC_VOTER_MIN_RSHARES,
    AttributedPost,
    VoterTrust,
)
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
    """The hydration queries must return WHO engaged, not bare counts.

    ★ 2026-08-10 (G5): the commenter grouped on is the RESOLVED identity, so
    this no longer pins `GROUP BY ... rc.author`. It pins that the query groups
    on the column the resolution produces — see
    `test_commenter_identity_is_resolved_the_same_way_the_poster_is` for the
    resolution itself and `tests/test_hafsql_sql.py` for the executed proof.
    """
    # The column grouped on must BE the resolved identity, not merely be called
    # `commenter`: asserting the alias alone stays green when the expression
    # behind it is reverted to `rc.author`, which is the whole G5 bug.
    assert f'{hafsql._engager_identity("rc")} AS commenter' in hafsql._SQL_COMMENTS_FOR_POSTS
    assert "GROUP BY parent_author, parent_permlink, commenter" in (
        hafsql._SQL_COMMENTS_FOR_POSTS
    )
    assert "DISTINCT" in hafsql._SQL_REBLOGGERS_FOR_POSTS
    assert "r.account_name" in hafsql._SQL_REBLOGGERS_FOR_POSTS


def test_popular_recall_is_conversation_and_self_excluded() -> None:
    """Recall must be attributed distinct identity, self-excluded, and must NOT
    contain a voter term.

    ★ 2026-08-09: this used to assert `COUNT(DISTINCT v.voter)` was PRESENT.
    Voters were 0.5 of the 1.3 total weight — 38% of what decided which posts
    the lane could even see — against an owner cap of 10% on vote influence.
    Stake now enters only in `select_popular`, at its 10% share, where it can be
    normalised against the pool (SQL cannot normalise, so rshares here would let
    one whale-voted post own recall).

    The self-exclusion half is UNCHANGED IN INTENT and still the point: a post
    must not buy a pool position with its author's own comments or reblogs.

    ★ 2026-08-10 (G5): it is no longer spelled `rc.author <> c.author`. That
    form compared CHAIN identities, and every lite writer shares one chain
    account, so it discarded the whole Lite tier's conversation as self-talk.
    Both sides now resolve through `_engager_identity` first. The assertion is
    written as "the resolved form is present AND the bare chain form is gone",
    because presence alone would still pass if someone re-added the old
    comparison alongside the new one — which would restore the bug.
    """
    sql = hafsql._SQL_POPULAR_POSTS
    resolved = hafsql._engager_identity("rc")
    assert f"COUNT(DISTINCT {resolved})" in sql  # distinct IDENTITIES, not COUNT(*)
    # self-comments buy no pool position — resolved identity vs resolved identity
    assert f"{resolved} <> {hafsql._engager_identity('c')}" in sql
    assert "rc.author <> c.author" not in sql, (
        "the chain-identity self-exclusion is the G5 bug: it reads every lite "
        "writer as the shared publisher account"
    )
    assert "COUNT(DISTINCT r.account_name)" in sql
    assert "r.account_name <> c.author" in sql  # self-reblogs neither
    # ★ The regression this test exists to prevent: votes creeping back into
    # recall. Asserted as ABSENCE, which is the only form that catches it.
    assert "v.voter" not in hafsql._POPULAR_ENGAGEMENT, (
        "votes must not decide popularity recall — they are capped at "
        "PopularConfig.payout_share in select_popular"
    )
    assert "rshares" not in hafsql._POPULAR_ENGAGEMENT


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
    # ★ 2026-08-08: the imported constant, for the reason above — and here it
    # matters more: this aggregate is `total_base`, which
    # `pooled_author_base` subtracts a PYTHON-computed `own_base` from, so a
    # divergence inflates the leave-one-out prior for every author.
    assert f"v.rshares > {_ORGANIC_VOTER_MIN_RSHARES:.0f}" in sql
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
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
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
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
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
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
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
        self: hafsql.HafsqlClient,
        sql: str,
        since: datetime,
        extra: Mapping[str, object] | None = None,
    ) -> dict[tuple[str, str], tuple[int, datetime | None]]:
        # `extra` carries the lite params (L1, 2026-08-05); this fixture has no
        # lite publishers configured, so it is always None here.
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
    the whole Lite tier's output to the container owner's organic score.

    ★★★ THIS TEST WAS VACUOUS UNTIL 2026-08-10 (ledger finding G4). It asserted
    three substrings — `AND NOT COALESCE(`, `, false)`, and the app-id clause —
    every one of which survives a mutation that makes the guard permanently
    inert (`false AND ...`). Mutating it left the suite BYTE-IDENTICAL. It now
    pins the WHOLE rendered predicate, so any change to what the guard tests
    changes this string; and the behavioural proof — the guard actually applied
    to rows, in a database — is
    `tests/test_hafsql_sql.py::test_a_lite_post_is_not_counted_as_a_comment_on_its_container`.
    """
    predicate = hafsql._LITE_CONTAINER_CHILD.format(t="rc.")
    assert f"AND NOT {predicate}" in hafsql._SQL_COMMENTS_FOR_POSTS
    # COALESCE(..., false) matters as much as the NOT: json_metadata is NULL on
    # ordinary comments, and NOT NULL is NULL, which Postgres filters out.
    assert predicate.startswith("COALESCE(") and predicate.endswith(", false)")
    # The container-prefix test is what separates a lite POST from a lite REPLY.
    assert "starts_with(rc.parent_permlink, %(lite_container_prefix)s)" in predicate
    # ...and one definition serves both layers, so recall and hydration cannot
    # disagree about what a comment is.
    assert f"AND NOT {predicate}" in hafsql._POPULAR_ENGAGEMENT


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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        calls.append("lite")
        return []

    def fail_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        return [("alice", "bob", 3, datetime(2026, 1, 1, 12, 0, 0))]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    # ★ `_edge_counts_slice`, not `_edge_counts` (2026-08-24). This test is
    # about coercing a NAIVE timestamp off one fetch, which is the single-query
    # path's job. `_edge_counts` now slices a long window and merges, so with a
    # stubbed `_fetch` returning the same row every call it would return the row
    # once per slice — this window spans three, and the assertion read 9 == 3.
    # That was the merge summing correctly, not a defect.
    counts = CLIENT._edge_counts_slice(
        hafsql._SQL_UPVOTE_EDGES, datetime(2026, 1, 1, tzinfo=UTC)
    )
    count, ts = counts[("alice", "bob")]
    assert count == 3
    assert ts is not None
    assert ts.tzinfo is UTC


def test_edge_counts_preserves_none_for_a_channel_with_no_interaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``None`` (no interaction of that kind between the pair) must stay
    ``None`` — only a PRESENT naive timestamp gets coerced."""

    def fake_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fail_fetch_recsys(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        seen.append((sql, params))
        return [("alice", "p1")]

    def fail_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        recsys_calls.append((sql, params))
        return [("farm", "suppressed-post")]

    def fake_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        mirror_calls.append(params)
        return [("solo", 3, 0.9)]

    def fail_fetch_recsys(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

        def execute(self, sql: str, params: dict[str, Any] | None = None) -> None:
            # `_fetch_via` re-asserts `statement_timeout` before every query
            # (2026-08-06: the mirror's pooler silently reverts a SET made at
            # connection creation). That SET must succeed; only the REAL query
            # raises, so this still tests exactly what it claims to.
            if sql.startswith("SET statement_timeout"):
                return
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        # `_hydrate` fans out into more `_fetch_lite` calls of its own
        # (votes/comments/rebloggers/reputation) — only the window-posts query
        # itself should return the row; everything else stays empty.
        return [row] if sql is hafsql._SQL_WINDOW_POSTS else []

    def fake_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        seen.append(params)
        return [("farm", 5, 2.7092)]

    def fail_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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

    def fake_fetch(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
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
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
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
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
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


def test_lite_config_from_env_defaults_to_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ QA RUN 2026-08-06: this asserted "off by default" while reading the
    AMBIENT environment, so it passed only on a machine with no lite variables
    set and failed the moment a developer exported one — which is exactly what
    happened the first time the service was pointed at a real lite database.
    A test whose result depends on the operator's shell is not a test of the
    default; it clears the variables it is making a claim about."""
    for name in (
        "LITE_PUBLISHER_ACCOUNTS",
        "LUMEN_LITE_DATABASE_URL",
        "LITE_FRONTEND_ACCOUNT_MAINNET",
        "LITE_FRONTEND_ACCOUNT_MIRRORNET",
        "LITE_FRONTEND_ACCOUNT_TESTNET",
    ):
        monkeypatch.delenv(name, raising=False)
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




# ---------------------------------------------------------------------------
# B4b (2026-08-05) — the pool bounds LIVE connections, not just retained ones.
#
# The 2026-08-05 council measured 30 concurrent borrows on max_size=5 producing
# 30 live connections, and 50 producing 50, against a SHARED third-party public
# mirror. `HAFSQL_POOL_MAX` gated only whether a RETURNED connection was kept in
# the idle list; `borrow()` opened a fresh one whenever idle was empty, with no
# check against max_size, no semaphore and no wait.
# ---------------------------------------------------------------------------


def test_concurrent_borrows_never_exceed_max_size() -> None:
    """★ THE BOUND. N threads borrow at once against a small pool; the number of
    physical connections ever opened must not exceed `max_size`. Pre-B4b this
    produced one connection per thread.

    Mutation-checked: deleting the `self._live < self._max_size` guard in
    `borrow()` makes `created` reach `THREADS` and this fails.
    """
    THREADS = 12
    MAX = 3
    created: list[_FakeConn] = []
    created_lock = threading.Lock()

    def connect() -> _FakeConn:
        conn = _FakeConn()
        with created_lock:
            created.append(conn)
        return conn

    pool = _pool(connect, min_size=1, max_size=MAX, acquire_timeout_s=5.0)
    barrier = threading.Barrier(THREADS)
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            barrier.wait(timeout=5)
            conn = pool.borrow()
            time.sleep(0.01)  # hold it, so contention is real
            pool.release(conn, healthy=True)
        except BaseException as exc:  # reported, not swallowed
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(THREADS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    assert not errors, f"borrowers failed: {errors!r}"
    assert len(created) <= MAX, (
        f"pool opened {len(created)} physical connections for {THREADS} concurrent "
        f"borrowers against max_size={MAX} — the bound is not being enforced"
    )


def test_borrow_times_out_rather_than_opening_an_unbounded_connection() -> None:
    """At capacity with nothing released, `borrow()` must FAIL — as the same
    `HafsqlUnavailableError` an operator already handles as a 503 — rather than
    quietly opening connection number max_size+1."""
    pool = _pool(lambda: _FakeConn(), min_size=1, max_size=1, acquire_timeout_s=0.05)
    held = pool.borrow()
    try:
        with pytest.raises(hafsql.HafsqlUnavailableError, match="pool exhausted"):
            pool.borrow()
    finally:
        pool.release(held, healthy=True)


def test_a_released_connection_unblocks_a_waiter() -> None:
    """The bound must not become a deadlock: a waiter blocked at capacity has to
    wake as soon as a slot frees, and reuse the returned connection rather than
    opening a new one."""
    created: list[_FakeConn] = []

    def connect() -> _FakeConn:
        conn = _FakeConn()
        created.append(conn)
        return conn

    pool = _pool(connect, min_size=1, max_size=1, acquire_timeout_s=5.0)
    first = pool.borrow()
    got: list[Any] = []

    def waiter() -> None:
        got.append(pool.borrow())

    t = threading.Thread(target=waiter)
    t.start()
    time.sleep(0.05)  # let it reach the wait
    assert not got, "waiter should still be blocked while the only slot is held"
    pool.release(first, healthy=True)
    t.join(timeout=5)
    assert got, "waiter was never woken after a release"
    assert len(created) == 1, "the released connection should have been reused"


def test_a_failed_connect_does_not_leak_its_slot() -> None:
    """A slot is claimed BEFORE the (unlocked) connect, so a failing connect has
    to hand it back — otherwise repeated failures silently retire the pool."""
    import psycopg

    def failing() -> _FakeConn:
        raise psycopg.OperationalError("nope")

    pool = _pool(failing, min_size=1, max_size=1, max_retries=0, acquire_timeout_s=0.05)
    for _ in range(3):
        with pytest.raises((psycopg.OperationalError, hafsql.HafsqlUnavailableError)):
            pool.borrow()
    # If the slot leaked, _live would be pinned at max_size and this would raise
    # "pool exhausted" instead of the connect error above.
    assert pool._live == 0


# ---------------------------------------------------------------------------
# L1 (2026-08-05) — edge destinations resolve to the lite writer.
# ---------------------------------------------------------------------------


def test_engagement_edges_resolves_destinations_when_lite_publishers_are_configured() -> None:
    """★★★ THE WIRING GATE. Every upvote, reply and reblog aimed at a lite
    writer used to be credited to the shared PUBLISHER account, because the edge
    queries took their destination from the raw on-chain `author` column and
    never called `_identity()` — the substitution post sourcing already used.

    Consequences of that one omission: a lite writer could never be vouched (no
    `graph_creds` entry keyed by their identity), a lite sock ring was invisible
    to ring detection, and the publisher accrued the graph-cred of every lite
    writer combined — a trust supernode growing with adoption.

    MUTANT: send the plain SQL when lite is configured. This fails.
    """
    captured: list[tuple[str, Mapping[str, object] | None]] = []

    def capture(
        self: hafsql.HafsqlClient,
        sql: str,
        since: datetime,
        extra: Mapping[str, object] | None = None,
    ) -> dict[tuple[str, str], tuple[int, datetime | None]]:
        captured.append((sql, extra))
        return {}

    client = hafsql.HafsqlClient(
        HafsqlConfig(),
        LiteConfig(publisher_accounts=frozenset({"lumen.pub"}), app_id="lumen/1.0"),
    )
    original = hafsql.HafsqlClient._edge_counts
    hafsql.HafsqlClient._edge_counts = capture  # type: ignore[method-assign]
    try:
        client.engagement_edges(datetime(2026, 1, 1, tzinfo=UTC))
    finally:
        hafsql.HafsqlClient._edge_counts = original  # type: ignore[method-assign]

    # ★ TWO, not three (2026-08-24): votes are no longer pulled into the graph
    # — owner ruling "VOTES ARE BOTED, ONLY COMMENTS AND REBLOGS". This count IS
    # the pin: if a third query reappears, votes are being fetched again.
    assert len(captured) == 2
    for sql, extra in captured:
        # ★ ROUND-3 COUNCIL (Seat 2): this used to assert only
        # `"lumen_user_id" in sql`, a substring check blind to a WEAKENED
        # predicate — a variant that resolved EVERY author's metadata, not just
        # a publisher's, still contains the string and still passed. That is the
        # lite trust boundary, so it is pinned properly now: resolution must be
        # gated on the publisher set AND on our own app id.
        assert "lumen_user_id" in sql, "edge destination is not resolved"
        assert "%(lite_publishers)s" in sql, (
            "resolution is not gated on the publisher set — any account could "
            "write its own destination via json_metadata"
        )
        assert "%(lite_app)s" in sql, "resolution is not gated on the app id"
        assert extra is not None
        assert extra["lite_publishers"] == ["lumen.pub"]
        assert extra["lite_app"] == "lumen/1.0"


def test_engagement_edges_keeps_the_plain_queries_when_lite_is_not_configured() -> None:
    """A non-lite deploy must pay nothing for this: same SQL, same plan, no
    extra binds. The lite branch could only ever match zero rows there."""
    captured: list[tuple[str, Mapping[str, object] | None]] = []

    def capture(
        self: hafsql.HafsqlClient,
        sql: str,
        since: datetime,
        extra: Mapping[str, object] | None = None,
    ) -> dict[tuple[str, str], tuple[int, datetime | None]]:
        captured.append((sql, extra))
        return {}

    client = hafsql.HafsqlClient(HafsqlConfig(), LiteConfig())
    original = hafsql.HafsqlClient._edge_counts
    hafsql.HafsqlClient._edge_counts = capture  # type: ignore[method-assign]
    try:
        client.engagement_edges(datetime(2026, 1, 1, tzinfo=UTC))
    finally:
        hafsql.HafsqlClient._edge_counts = original  # type: ignore[method-assign]

    # ★ NO VOTE QUERY (2026-08-24) — owner ruling "WE WONT PULL VOTES FOR THE
    # GRAPH, VOTES ARE BOTED, ONLY COMMENTS AND REBLOGS". This list IS the pin:
    # if `_SQL_UPVOTE_EDGES` reappears here, votes are being fetched again.
    assert [sql for sql, _ in captured] == [
        hafsql._SQL_REPLY_EDGES,
        hafsql._SQL_REBLOG_EDGES,
    ]
    assert hafsql._SQL_UPVOTE_EDGES not in [sql for sql, _ in captured]
    assert all(extra is None for _, extra in captured)


# ---------------------------------------------------------------------------
# THE LITE TRUST BOUNDARY — behavioural, not textual.
# ---------------------------------------------------------------------------


def _pg_or_skip():  # type: ignore[no-untyped-def]
    psycopg = pytest.importorskip("psycopg")
    cfg = HafsqlConfig()
    try:
        return psycopg.connect(
            host=cfg.host, port=cfg.port, dbname=cfg.dbname, user=cfg.user,
            password=cfg.password, connect_timeout=cfg.connect_timeout, autocommit=True,
        )
    except Exception as exc:  # a mirror outage is not our bug
        pytest.skip(f"no reachable PostgreSQL to execute against: {type(exc).__name__}: {exc}")


def test_only_a_publishers_post_may_redirect_its_engagement(monkeypatch) -> None:
    """★★★ THE LITE TRUST BOUNDARY, executed rather than pattern-matched.

    Round-3 condemned `assert "lumen_user_id" in sql` as a gate blind to a
    WEAKENED predicate — and round 4 found the lesson had been closed with
    ANOTHER substring gate: three mutants strip the publisher / app-id gating
    while every assertion still passes, because the strings survive elsewhere in
    the query. If that regressed, ANY Hive account could redirect the engagement
    it receives to an identity of its choosing by writing its own
    `json_metadata`.

    So this executes the SHIPPED constant against a real PostgreSQL with a CTE
    standing in for the chain tables, and feeds it the attack directly: two
    posts, one by a configured publisher and one by an ordinary account, BOTH
    carrying a `lumen_user_id`. Only the publisher's may resolve.

    MUTANT: drop the publisher gate, or the app-id gate, from the `lite` CTE.
    This fails — a substring assertion cannot.
    """
    prelude = """
    WITH comments(author, permlink, json_metadata) AS (VALUES
        -- a genuine lite post by a configured publisher
        ('lumen.pub', 'p-lite',  '{"app":"lumen/1.0","lumen_user_id":"01LITEWRITER"}'::jsonb),
        -- the SAME publisher posting through a DIFFERENT app, carrying a lumen
        -- id it must not be trusted for: catches a stripped app-id gate
        ('lumen.pub', 'p-other', '{"app":"peakd/1.0","lumen_user_id":"01WRONGAPP"}'::jsonb),
        -- an ordinary account trying to redirect its own engagement, and
        -- deliberately REUSING the publisher's permlink: catches a join that is
        -- no longer restricted to (author, permlink) pairs
        ('attacker',  'p-lite',  '{"app":"lumen/1.0","lumen_user_id":"01STOLEN"}'::jsonb)
    ),
    votes(voter, author, permlink, rshares, "timestamp") AS (VALUES
        ('fan', 'lumen.pub', 'p-lite',  1000, now()),
        ('fan', 'lumen.pub', 'p-other', 1000, now()),
        ('fan', 'attacker',  'p-lite',  1000, now())
    )
    """
    sql = hafsql._SQL_UPVOTE_EDGES_WITH_LITE
    # Point the shipped query at the stand-in tables without touching its logic.
    sql = sql.replace("hafsql.comments", "comments").replace(
        "hafsql.operation_effective_comment_vote_view", "votes"
    )
    # `WITH lite AS ...` becomes a second CTE in our own WITH chain.
    sql = prelude + "," + sql[len("WITH ") :]

    conn = _pg_or_skip()
    with conn, conn.cursor() as cur:
        cur.execute(
            sql,
            {
                "since": datetime(2020, 1, 1, tzinfo=UTC),
                "until": datetime(2099, 1, 1, tzinfo=UTC),
                "lite_publishers": ["lumen.pub"],
                "lite_app": "lumen/1.0",
            },
        )
        edges = {(row[0], row[1]): row[2] for row in cur.fetchall()}

    # Asserted as the WHOLE edge set with counts, not membership: a weakened
    # join misattributes or DUPLICATES an edge rather than inventing a new
    # destination, and a membership check cannot see either.
    assert edges == {
        ("fan", "01LITEWRITER"): 1,   # the genuine lite post resolves, once
        ("fan", "lumen.pub"): 1,      # the publisher's non-lite post stays the publisher's
        ("fan", "attacker"): 1,       # the attacker keeps their own edge
    }, (
        f"the lite trust boundary is not enforced: {edges}. "
        "'01STOLEN' present = any account can redirect its engagement; "
        "'01WRONGAPP' present = the app-id gate is off; "
        "a count of 2 = the join is no longer keyed on (author, permlink)."
    )


# ---------------------------------------------------------------------------
# ★★★ ROUND-5 COUNCIL (Seat 2): the trust boundary is enforced in THREE edge
# queries and only the UPVOTE one had an executed test. Four mutants stripping
# the publisher/app gating on the REPLY and REBLOG branches went uncaught — the
# round-4 rule ("a filter is not landed until it has run against every channel
# the producer writes") violated inside the fix written FOR that rule.
# ---------------------------------------------------------------------------

_LITE_ROWS = """
    comments(author, permlink, json_metadata) AS (VALUES
        ('lumen.pub', 'p-lite',  '{"app":"lumen/1.0","lumen_user_id":"01LITEWRITER"}'::jsonb),
        ('lumen.pub', 'p-other', '{"app":"peakd/1.0","lumen_user_id":"01WRONGAPP"}'::jsonb),
        ('attacker',  'p-lite',  '{"app":"lumen/1.0","lumen_user_id":"01STOLEN"}'::jsonb)
    )
"""

_REPLY_PRELUDE = f"""
    WITH {_LITE_ROWS},
    replies(author, parent_author, parent_permlink, "timestamp") AS (VALUES
        ('fan', 'lumen.pub', 'p-lite',  now()),
        ('fan', 'lumen.pub', 'p-other', now()),
        ('fan', 'attacker',  'p-lite',  now())
    )
"""

_REBLOG_PRELUDE = f"""
    WITH {_LITE_ROWS},
    reblogs(account_name, author, permlink, created_at) AS (VALUES
        ('fan', 'lumen.pub', 'p-lite',  now()),
        ('fan', 'lumen.pub', 'p-other', now()),
        ('fan', 'attacker',  'p-lite',  now())
    )
"""

_EXPECTED_EDGES = {
    ("fan", "01LITEWRITER"): 1,   # the genuine lite post resolves, once
    ("fan", "lumen.pub"): 1,      # the publisher's non-lite post stays theirs
    ("fan", "attacker"): 1,       # the attacker keeps their own edge
}


@pytest.mark.parametrize(
    ("constant", "prelude", "source_table"),
    [
        ("_SQL_REPLY_EDGES_WITH_LITE", _REPLY_PRELUDE, "hafsql.operation_comment_view"),
        ("_SQL_REBLOG_EDGES_WITH_LITE", _REBLOG_PRELUDE, "hafsql.reblogs"),
    ],
)
def test_every_lite_edge_query_enforces_the_publisher_boundary(
    constant: str, prelude: str, source_table: str
) -> None:
    """The same attack the upvote branch is tested against, applied to the other
    two channels: an ordinary account carrying a `lumen_user_id`, a publisher
    post through a FOREIGN app, and a permlink collision between them.

    MUTANT: strip the publisher gate or the app-id gate from either branch.
    This fails.
    """
    replacement = {"hafsql.operation_comment_view": "replies", "hafsql.reblogs": "reblogs"}
    sql = getattr(hafsql, constant)
    sql = sql.replace("hafsql.comments", "comments").replace(
        source_table, replacement[source_table]
    )
    sql = prelude + "," + sql[len("WITH ") :]

    conn = _pg_or_skip()
    with conn, conn.cursor() as cur:
        cur.execute(
            sql,
            {
                "since": datetime(2020, 1, 1, tzinfo=UTC),
                "until": datetime(2099, 1, 1, tzinfo=UTC),
                "lite_publishers": ["lumen.pub"],
                "lite_app": "lumen/1.0",
            },
        )
        edges = {(row[0], row[1]): row[2] for row in cur.fetchall()}

    assert edges == _EXPECTED_EDGES, (
        f"{constant} does not enforce the lite trust boundary: {edges}. "
        "'01STOLEN' present = any account can redirect its engagement; "
        "'01WRONGAPP' present = the app-id gate is off."
    )


# ---------------------------------------------------------------------------
# ★★★ SQL EXECUTABILITY (2026-08-08). Both of these exist because
# `_SQL_AUTHOR_FIRST_POST` shipped broken TWICE in one session, and `/health`
# stayed green through both:
#
#   1. it referenced `c.depth`, which `hafsql.comments` does not have — every
#      `/feed` became a 503;
#   2. fixed to use `_top_level_or_lite("c")`, it was still called through
#      `_fetch` rather than `_fetch_lite`, so the `%(lite_publishers)s` /
#      `%(lite_app)s` placeholders that helper bakes in were never bound and
#      psycopg raised `query parameter missing` — the reserved seat then
#      forfeited on every request, silently, because the lane's own degrade is
#      fail-closed.
#
# Neither is exotic and both are STRUCTURAL — they are visible in the module
# without a database, which is the only reason a unit test can catch them.
# ---------------------------------------------------------------------------


def _sql_constants() -> dict[str, str]:
    return {
        name: value
        for name, value in vars(hafsql).items()
        if name.startswith("_SQL_") and isinstance(value, str)
    }


def test_every_sql_constant_only_names_columns_the_other_queries_use() -> None:
    # A cheap structural stand-in for "does this parse against the real
    # schema": every `<alias>.<column>` reference in a `hafsql.comments` query
    # must be a column some OTHER, live-proven query already reads. `depth` was
    # invented by one query and existed nowhere else, which is exactly the shape
    # this catches.
    import re

    known: set[str] = set()
    for sql in _sql_constants().values():
        known.update(re.findall(r"\bc\.([a-z_]+)", sql))
    # `depth` must not be among them: no shipped query reads it, because the
    # column does not exist. Top-level-ness is `parent_author = ''`.
    assert "depth" not in known, (
        "a query references `c.depth`; hafsql.comments has no such column — "
        "top-level posts are `parent_author = ''` (see `_top_level_or_lite`)"
    )


def test_a_query_carrying_lite_placeholders_is_never_fetched_without_binding_them() -> None:
    # `_top_level_or_lite` / `_LITE_POST` bake `%(lite_publishers)s` and
    # `%(lite_app)s` into the SQL at import time. A method that passes such a
    # query to `_fetch` (rather than `_fetch_lite`, which binds them) raises
    # `query parameter missing` at runtime and nowhere earlier.
    import inspect

    source = inspect.getsource(hafsql)
    for name, sql in _sql_constants().items():
        if "lite_publishers" not in sql and "lite_app" not in sql:
            continue
        for call in (f"self._fetch({name}", f"self._fetch({name},"):
            assert call not in source, (
                f"{name} carries the lite placeholders but is passed to "
                f"`_fetch`; it must go through `_fetch_lite`, which binds them"
            )


# ---------------------------------------------------------------------------
# ★★★ THE 280-SECOND REQUEST (2026-08-08). `_SQL_AUTHOR_FIRST_POST` shipped as
# an unbounded `MIN(created)` keyed on a COALESCE identity and took **311s**
# against the real mirror for one `/feed`, turning a 30-45s request into 279.5s.
#
# WHAT WOULD ACTUALLY HAVE CAUGHT IT. Not a functional test — the query returned
# CORRECT answers, just 300 seconds late, so every assertion on its OUTPUT
# passed. Not a timing test either: unit fixtures are tiny, and a full-history
# scan over a 10-row fake is instant. The bug is only visible in the SQL's
# SHAPE, where it is completely unambiguous, so that is what these pin.
# ---------------------------------------------------------------------------


def test_no_comments_query_can_scan_the_table_unbounded() -> None:
    """Every `hafsql.comments` scan must be bounded by SOMETHING.

    Two bounds are legitimate and both appear in this module: a DATE predicate
    (`created >= %(since)s` and friends), or a keying on `%(lite_publishers)s`,
    which is a tiny configured set (one account per network).

    ★ THE PUBLISHER BOUND ONLY COUNTS WHEN IT IS CONJUNCTIVE, and getting that
    wrong is how the first version of this very test passed against the 311s
    query. `_top_level_or_lite` expands to `(parent_author = '' OR <lite...>)` —
    the `lite_publishers` equality is present, but it sits inside an OR whose
    OTHER disjunct, `parent_author = ''`, admits EVERY TOP-LEVEL POST EVER
    WRITTEN with no author restriction at all. A bound one side of an OR is not
    a bound. So: any query carrying that disjunct MUST also carry a date
    predicate; only a query whose publisher equality is the real gate may rely
    on it alone (the three `*_EDGES_WITH_LITE` queries).

    Unbounded means cost set by total chain volume rather than by what the
    caller asked for — it grows forever and no amount of asking for less helps.
    Measured on the query this test now catches: 25,744,001 index rows and
    11,036,504 buffer reads to return 972 identities, 311 seconds.
    """
    import re

    unbounded = []
    for name, sql in _sql_constants().items():
        if "hafsql.comments" not in sql:
            continue
        date_bounded = re.search(r"\bcreated\s*(?:>=|<=|<|>)", sql) is not None
        # The open disjunct: `parent_author = ''` admits the whole chain.
        admits_all_top_level = re.search(r"parent_author\s*=\s*''", sql) is not None
        publisher_bounded = (
            re.search(r"author\s*=\s*ANY\(%\(lite_publishers\)s\)", sql) is not None
            and not admits_all_top_level
        )
        if not (date_bounded or publisher_bounded):
            unbounded.append(name)
    assert not unbounded, (
        f"{unbounded} scan hafsql.comments unbounded: no date predicate, and no "
        "CONJUNCTIVE lite_publishers bound (a publisher term inside an OR with "
        "`parent_author = ''` bounds nothing). Cost is then set by total chain "
        "volume, not by the request — this is the shape that made /feed 279.5s."
    )


def test_author_first_post_is_sargable_on_the_author_column() -> None:
    """The identity COALESCE must never be the thing matched against
    `%(authors)s`.

    `COALESCE(json_metadata->>'lumen_user_id', author) = ANY(%(authors)s)`
    cannot be answered by any index on `author`, so Postgres abandons the
    per-author index and bitmap-scans every top-level post on the chain. Live
    `EXPLAIN`: `Bitmap Index Scan on
    hafsql_comments_table_parent_author_empty_deleted_id_idx`, 75,058,034 rows
    removed by recheck. The fix is two explicit sargable branches — an ORDINARY
    one keyed on `c.author = ANY(...)` and a LITE one bounded by the publisher
    set — which is the same rewrite `_SQL_AUTHOR_ENGAGEMENT` already carries.
    """
    import re

    sql = hafsql._SQL_AUTHOR_FIRST_POST
    assert not re.search(r"COALESCE\([^)]*\)\s*=\s*ANY\(%\(authors\)s\)", sql), (
        "the ranked-identity COALESCE is matched against %(authors)s — not "
        "sargable, so this scans the whole comments table (measured 311s)"
    )
    assert re.search(r"\bc\.author\s*=\s*ANY\(%\(authors\)s\)", sql), (
        "no sargable ORDINARY branch: the query must key on `c.author = "
        "ANY(%(authors)s)` so it can use hafsql_comments_table_author_created_idx"
    )
    # The lite branch must still resolve a lite writer to their OWN first lite
    # post — dropping it would make every lite newcomer inherit the shared
    # publisher account's age and be refused the lane on day one.
    assert "json_metadata->>'lumen_user_id' = ANY(%(authors)s)" in sql, (
        "no LITE branch keyed on the writer id: lite writers would resolve to "
        "the publisher account's history instead of their own first post"
    )


def test_author_first_post_scan_floor_tracks_the_configured_horizon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """MUTATION PROOF THAT THE BOUND IS LOAD-BEARING.

    The query is fast only because it may stop looking once an author is
    provably older than the caller's threshold. If the floor were hardcoded
    instead of derived from `horizon_days`, raising
    `ExplorationConfig.max_author_age_days` would silently keep refusing
    everyone the change was meant to admit — a config knob that reads as
    working and does nothing. Pin that the floor MOVES, and that it stays
    strictly OLDER than the horizon so boundary authors are decided by their
    real first post rather than by where the scan stopped.
    """
    seen: list[dict[str, Any]] = []

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        seen.append({**params, "timeout_ms": timeout_ms})
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    client = hafsql.HafsqlClient(HafsqlConfig())
    now = datetime(2026, 8, 8, tzinfo=UTC)

    for horizon in (30, 60):
        client.author_first_post(frozenset({"alice"}), horizon_days=horizon, now=now)

    floors = [call["floor"] for call in seen]
    assert floors[0] != floors[1], (
        "the scan floor did not move when horizon_days changed — it is "
        "hardcoded, so max_author_age_days is decorative"
    )
    for horizon, floor in zip((30, 60), floors, strict=True):
        age_days = (now - floor).days
        assert age_days > horizon, (
            f"scan floor is {age_days}d for a {horizon}d horizon; it must be "
            "STRICTLY older, or authors on the boundary are decided by the "
            "scan's edge instead of by their real first post"
        )


def test_author_first_post_is_bounded_by_a_request_scoped_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The lane read must carry its OWN timeout, far below the client-wide one.

    `HAFSQL_STATEMENT_TIMEOUT_MS` is 900_000 in this deployment and that is
    deliberate — the trust/author-prior BATCH legitimately runs for minutes, and
    lowering it globally is what stops the snapshot ever being written. But a
    900s bound on a REQUEST is not a timeout at all: nothing cut the 311s query
    off, and it was only found by raising a curl timeout until it completed.
    This read is worth exactly one slot of twenty, so it gets a bound it can
    actually hit, and exceeding it forfeits the seat while the page still
    serves.
    """
    seen: list[int | None] = []

    def fake_fetch_lite(
        self: hafsql.HafsqlClient,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[Any]:
        seen.append(timeout_ms)
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch_lite", fake_fetch_lite)
    client = hafsql.HafsqlClient(HafsqlConfig())
    client.author_first_post(frozenset({"alice"}), horizon_days=30)

    assert seen == [hafsql._FIRST_POST_TIMEOUT_MS], (
        "the newness read did not pass its own timeout, so it inherits the "
        "900s batch bound and can hang a request indefinitely"
    )
    assert client._statement_timeout_ms > hafsql._FIRST_POST_TIMEOUT_MS
    # Must also fire before the frontend gives up (15s) — otherwise the page has
    # already fallen back to trending by the time the guard trips.
    assert hafsql._FIRST_POST_TIMEOUT_MS < 15_000


def test_author_first_post_asks_nothing_when_the_predicate_is_off() -> None:
    """`max_author_age_days = 0` must cost NO round trip.

    It is the documented off-switch that reproduces the pre-2026-08-08 lane, and
    it is also the A/B that isolated this regression. If it still queried, the
    off-switch would not be an off-switch.
    """

    def fail(*_a: object, **_k: object) -> list[Any]:
        raise AssertionError("no query may run when the newness predicate is off")

    client = hafsql.HafsqlClient(HafsqlConfig())
    object.__setattr__(client, "_fetch_lite", fail)
    assert client.author_first_post(frozenset({"alice"}), horizon_days=0) == {}


def test_sim_recall_matches_production_weights() -> None:
    """The simulator's recall ordering must READ production's weights.

    ★ 2026-08-09. `measurement-harness/simworld.py::SimGateway.popular_posts`
    reimplements `_SQL_POPULAR_POSTS`'s ordering in Python, and its comment
    claimed the two "cannot drift apart silently". They drifted anyway: after
    recall moved to conversation-only, the sim still scored
    `0.5*voters + 0.3*comments + 0.5*reblogs`, recall overlap fell to 76/150,
    and every q11/q12 measurement of this lane was taken on a pool production
    never produces — including numbers that were written into config comments
    as evidence.

    A comment cannot enforce that. This can: both sides now read
    `POPULAR_RECALL_{COMMENT,REBLOG}_WEIGHT`, and this test fails if the sim
    stops importing them or production stops interpolating them.
    """
    import importlib.util
    from pathlib import Path

    from recsys.io.hafsql import (
        POPULAR_RECALL_COMMENT_WEIGHT,
        POPULAR_RECALL_REBLOG_WEIGHT,
    )

    # Production really interpolates the constants (not a retyped literal).
    assert f"{POPULAR_RECALL_COMMENT_WEIGHT} *" in hafsql._POPULAR_ENGAGEMENT
    assert f"{POPULAR_RECALL_REBLOG_WEIGHT} *" in hafsql._POPULAR_ENGAGEMENT
    # ★ 2026-08-10: this used to be `"{" not in ...`. G5's namespace guard
    # embeds a real regex quantifier (`{2,15}` in `_HIVE_NAME_ENVELOPE`), so a
    # bare brace is no longer evidence of anything. The invariant that was
    # actually meant is "no UNRENDERED f-string placeholder", and a placeholder
    # is a brace followed by an identifier — `{POPULAR_RECALL_...}`, `{t}` — never
    # by a digit. Checked that way it still catches the real regression and stops
    # tripping over legitimate SQL.
    assert not re.search(r"\{[A-Za-z_]", hafsql._POPULAR_ENGAGEMENT), (
        "unrendered placeholder in SQL"
    )

    # The sim imports them rather than hardcoding its own.
    sim_src = Path(__file__).resolve().parents[1] / "measurement-harness" / "simworld.py"
    src = sim_src.read_text()
    assert "POPULAR_RECALL_COMMENT_WEIGHT" in src, "sim no longer reads production's weights"
    assert "POPULAR_RECALL_REBLOG_WEIGHT" in src
    # And it must not have re-grown a voter term.
    scorer = src[src.index("def popular_posts") : src.index("def suppressed_keys")]
    # Code-level markers, not prose: the docstring legitimately DISCUSSES the
    # voter term it removed, and an assertion that trips on its own explanation
    # is a test nobody can write an honest comment near.
    assert "p.votes" not in scorer, "votes must not decide popularity recall"
    assert "_ORGANIC_VOTER_WEIGHT" not in scorer
    assert "rshares" not in scorer


# ── ★ the edge-window slicing (2026-08-24) ──────────────────────────────────


def test_edge_counts_slices_a_long_window_and_merges_exactly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ THE 90-DAY WALL IS A QUERY PLAN, NOT A LIMIT.

    Measured 2026-08-14 (`deploy/trust-batch-defaults.env`): a 365-day edge
    window "cannot complete at all (cancelled at 900s, and again at 3600s)",
    while 90 days finishes in 29.7s. So production runs `--since-days 90`, and
    MEASURED 2026-08-24 the live graph reaches back exactly 90 days — oldest
    `last_interaction` across 2,618,664 edges is 90 days, ZERO beyond 120. A
    relationship older than that is not decayed, it is ABSENT.

    Slicing keeps each query on the good plan. This pins the property that makes
    it safe: `COUNT(*)` and `MAX(timestamp)` are both decomposable over a
    partition, so slice-and-merge must equal one grouped query over the span.
    """
    calls: list[tuple[datetime, datetime]] = []

    def fake_fetch(self, sql, params, *, timeout_ms=None):
        calls.append((params["since"], params["until"]))
        return [("alice", "bob", 2, datetime(2026, 1, 1, 12, 0, 0))]

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    since = datetime.now(UTC) - timedelta(days=200)
    counts = CLIENT._edge_counts(hafsql._SQL_UPVOTE_EDGES, since)

    assert len(calls) == 3, f"expected 3 slices over 200 days at 90/slice, got {len(calls)}"
    # Counts SUM across slices — this is the merge doing its job.
    assert counts[("alice", "bob")][0] == 6

    # ★ The slices must be CONTIGUOUS and HALF-OPEN, or interactions are counted
    # twice or silently dropped — both permanent and both invisible.
    for (_, prev_until), (next_since, _) in zip(calls, calls[1:]):
        assert prev_until == next_since, "slice boundaries do not meet exactly"
    assert calls[0][0] == since, "the first slice must start at the requested since"


def test_a_window_within_one_slice_makes_exactly_one_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """At or under one slice this must collapse to a single query — byte-for-byte
    the behaviour before slicing existed, which is what makes the change safe to
    ship at today's 90-day production window."""
    calls: list[object] = []

    def fake_fetch(self, sql, params, *, timeout_ms=None):
        calls.append(params)
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    CLIENT._edge_counts(hafsql._SQL_UPVOTE_EDGES, datetime.now(UTC) - timedelta(days=30))
    assert len(calls) == 1


def test_the_slice_loop_always_advances(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ FOUND BY MUTATION, 2026-08-24 — and it did not fail an assertion, it HUNG.

    An edit making the slices overlap sent `_edge_counts` into an infinite loop:
    once `hi` clamps to the upper bound and `lo` sits just below it, a
    non-advancing step spins forever. That would run inside the weekly trust
    batch holding a mirror connection, and nothing at this layer times out — the
    cron's own retry never fires because the process never exits. A batch that
    never returns is worse than one that returns wrong.

    This pins the guard by driving the loop with a degenerate slice size.
    """
    calls: list[object] = []

    def fake_fetch(self, sql, params, *, timeout_ms=None):
        calls.append(params)
        if len(calls) > 50:  # a real infinite loop would blow past this
            raise AssertionError("slice loop did not advance")
        return []

    monkeypatch.setattr(hafsql.HafsqlClient, "_fetch", fake_fetch)
    from dataclasses import replace as _replace

    client = hafsql.HafsqlClient(_replace(CLIENT._config, edge_slice_days=1))
    client._edge_counts(hafsql._SQL_UPVOTE_EDGES, datetime.now(UTC) - timedelta(days=10))
    assert len(calls) <= 12, f"expected ~11 one-day slices, got {len(calls)}"
