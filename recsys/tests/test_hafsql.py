"""Import + structural tests for the HAFSQL gateway (§S7). INFRA-GATED: no
database is reachable here, so these tests only check that the module imports
without ``psycopg`` installed, that ``HafsqlClient`` structurally implements
every ``HafsqlGateway`` method, and that its SQL constants are real queries.
No connection is opened and no query is executed.
"""

from __future__ import annotations

from datetime import UTC, datetime
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
    "community_posts",
    "tag_posts",
    "engagement_edges",
    "stake_lineage",
    "second_degree_engagers",
    "follow_graph",
    "popular_posts",
    "suppressed_keys",
)

_SQL_CONSTANTS = (
    hafsql._SQL_IN_NETWORK_POSTS,
    hafsql._SQL_COMMUNITY_POSTS,
    hafsql._SQL_TAG_POSTS,
    hafsql._SQL_ENGAGED_OON_POSTS,
    hafsql._SQL_VOTES_FOR_POSTS,
    hafsql._SQL_COMMENTS_FOR_POSTS,
    hafsql._SQL_REBLOGGERS_FOR_POSTS,
    hafsql._SQL_REPUTATIONS_FOR_AUTHORS,
    hafsql._SQL_REPLY_EDGES,
    hafsql._SQL_UPVOTE_EDGES,
    hafsql._SQL_REBLOG_EDGES,
    hafsql._SQL_STAKE_LINEAGE,
    hafsql._SQL_SECOND_DEGREE_ENGAGERS,
    hafsql._SQL_FOLLOW_GRAPH,
    hafsql._SQL_POPULAR_POSTS,
    hafsql._SQL_AUTHOR_ENGAGEMENT,
    hafsql._SQL_SUPPRESSED_KEYS,
)


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
    assert "v.voter <> c.author" in sql  # self-vote buys no prior
    assert "rc.author <> c.author" in sql  # self-comment neither
    assert "r.account_name <> c.author" in sql  # self-reblog neither
    # per-author lineage/ring anti-join against the passed exclusion arrays,
    # scoped PER author (never a global exclusion that would strip an author's
    # honest engagers just because another author flagged them)
    assert "%(excl_authors)s" in sql
    assert "%(excl_accounts)s" in sql
    # one exclusion anti-join per engagement channel (3) PLUS the H05
    # eligibility/flooding NOT EXISTS against network_suppression (1) = 4.
    assert sql.count("NOT EXISTS") == 4
    assert sql.count("e.author = c.author") == 3  # exclusion anti-joins only


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
    """H05: a post already network-suppressed (§8.7) must never feed the
    pooled prior — flooding an author's window with suppressed posts cannot
    dilute or pad the aggregate."""
    sql = hafsql._SQL_AUTHOR_ENGAGEMENT
    assert "network_suppression" in sql
    assert "ns.suppressed" in sql
    assert "ns.author = c.author AND ns.permlink = c.permlink" in sql


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


def test_the_community_lane_is_deliberately_not_widened_for_lite() -> None:
    """A comment inherits its category from the container root, so lite posts sit
    in category `lumen` and can never match a `hive-*` community. Documented
    limitation of the container model, not an oversight — pinned so nobody
    'fixes' it by widening a query that cannot match."""
    assert "lite_publishers" not in hafsql._SQL_COMMUNITY_POSTS
    for sql in (hafsql._SQL_TAG_POSTS, hafsql._SQL_IN_NETWORK_POSTS,
                hafsql._SQL_ENGAGED_OON_POSTS, hafsql._SQL_POPULAR_POSTS):
        assert "lite_publishers" in sql
