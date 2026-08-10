"""EXECUTED SQL tests for the HAFSQL gateway — the guards, actually run.

WHY THIS FILE EXISTS. ``tests/test_hafsql.py`` says so itself: "no database is
reachable here... No connection is opened and no query is executed." That is how
eight hard I/O breaks shipped once, and it is also why several of this module's
SQL guards were found to be **vacuously tested** on 2026-08-09: mutating
``_SQL_COMMENTS_FOR_POSTS``'s lite-exclusion to be permanently inert, or
``_SQL_POPULAR_POSTS``'s per-author flooding cap to ``OR TRUE``, left the whole
suite BYTE-IDENTICAL, because every assertion about them was a substring check
on the query text. A substring cannot tell you what a query does.

``tests/test_hafsql_live.py`` executes queries, but against the real public
mirror — so it can only assert on whatever mainnet happens to contain, which is
the wrong instrument for a guard that needs a specific adversarial row to exist.
This file is the third thing: the PRODUCTION SQL constants, imported and run
verbatim, against a Postgres holding a small ``hafsql`` schema this file builds
and controls completely. Nothing here is retyped SQL — every query under test is
``hafsql._SQL_*`` itself, so a change to the module is a change to what runs.

GATING: skipped, not failed, unless ``RECSYS_TEST_PG_DSN`` names a reachable
Postgres the test may create a schema in. The default offline ``pytest -q`` run
stays network-free. Opt in with::

    RECSYS_TEST_PG_DSN=postgresql://qa:qa@127.0.0.1:55433/recsys pytest -q tests/test_hafsql_sql.py

Everything is created inside a ``hafsql`` schema in a throwaway TEMPORARY-scoped
transaction per test (``ROLLBACK`` at teardown), so it cannot leave residue in
whatever database is pointed at.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from recsys.io import hafsql

_DSN = os.environ.get("RECSYS_TEST_PG_DSN")

pytestmark = pytest.mark.skipif(
    not _DSN,
    reason="RECSYS_TEST_PG_DSN not set — executed-SQL suite opted out (offline by default)",
)

# The publisher account and app id every lite row below is published under. One
# account, many writers — the whole shape G5 is about.
PUB = "pub"
APP = "lumen/1.0"

# 26-char uppercase Crockford ULIDs, the real shape of `lumen_user.user_id`
# (`frontend/apps/blog/lib/lite/ids.ts`). Deliberately NOT short lowercase
# strings: the namespace guard rejects anything that could be a Hive account
# name, and a test whose fixtures dodge that would prove nothing about it.
U_A = "01ZZZZZZZZAAAAAAAAAAAAAAAA"
U_B = "01ZZZZZZZZBBBBBBBBBBBBBBBB"
U_C = "01ZZZZZZZZCCCCCCCCCCCCCCCC"
U_D = "01ZZZZZZZZDDDDDDDDDDDDDDDD"

NOW = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
SINCE = NOW - timedelta(days=3)

_SCHEMA = """
CREATE SCHEMA hafsql;

-- Column names and types mirror the real mirror (verified live 2026-08-10 via
-- information_schema); only the columns these queries read are declared.
CREATE TABLE hafsql.comments (
    author           varchar,
    permlink         varchar,
    parent_author    varchar,
    parent_permlink  varchar,
    created          timestamptz,
    tags             jsonb,
    category         varchar,
    json_metadata    jsonb,
    deleted          boolean DEFAULT false
);
CREATE TABLE hafsql.operation_comment_view (
    author           text,
    permlink         text,
    parent_author    text,
    parent_permlink  text,
    json_metadata    jsonb
);
CREATE TABLE hafsql.reblogs (
    account_name     varchar,
    author           varchar,
    permlink         varchar,
    created_at       timestamp
);
"""


def _meta(uid: str | None = None, app: str | None = APP) -> str | None:
    """A json_metadata literal. ``None`` means the column is NULL, which is the
    common case on ordinary Hive comments and the reason every lite predicate
    has to be COALESCE-wrapped."""
    if uid is None and app is None:
        return None
    parts = []
    if app is not None:
        parts.append(f'"app": "{app}"')
    if uid is not None:
        parts.append(f'"lumen_user_id": "{uid}"')
    return "{" + ", ".join(parts) + "}"


@pytest.fixture()
def db() -> Iterator[Any]:
    psycopg = pytest.importorskip("psycopg")
    try:
        conn = psycopg.connect(_DSN, connect_timeout=5)
    except Exception as exc:  # unreachable database is an infra blip, not a failure
        pytest.skip(f"RECSYS_TEST_PG_DSN unreachable: {type(exc).__name__}: {exc}")
    try:
        conn.execute(_SCHEMA)
        _seed(conn)
        yield conn
    finally:
        conn.rollback()  # the schema and every row go with it
        conn.close()


#: Every row gets its own `created`, one minute apart, so the recall query's
#: `ORDER BY engagement DESC, created DESC` never has to break a tie between two
#: posts with identical timestamps — an order that is arbitrary is an order no
#: assertion can honestly be written against.
_CLOCK = [0]


def _next_created() -> datetime:
    _CLOCK[0] += 1
    return NOW - timedelta(hours=2) + timedelta(minutes=_CLOCK[0])


def _post(
    conn: Any,
    author: str,
    permlink: str,
    parent_author: str = "",
    parent_permlink: str = "",
    uid: str | None = None,
    app: str | None = None,
) -> None:
    conn.execute(
        """INSERT INTO hafsql.comments
           (author, permlink, parent_author, parent_permlink, created, tags,
            category, json_metadata, deleted)
           VALUES (%s, %s, %s, %s, %s, '[]'::jsonb, 'general', %s::jsonb, false)""",
        (author, permlink, parent_author, parent_permlink, _next_created(),
         _meta(uid, app)),
    )


def _comment(
    conn: Any,
    author: str,
    permlink: str,
    parent_author: str,
    parent_permlink: str,
    uid: str | None = None,
    app: str | None = None,
) -> None:
    """A row in BOTH tables: on chain a comment is a `comments` row and an
    operation. The two queries under test read different ones, and a fixture
    that populated only one would silently make one of them untestable."""
    _post(conn, author, permlink, parent_author, parent_permlink, uid, app)
    conn.execute(
        """INSERT INTO hafsql.operation_comment_view
           (author, permlink, parent_author, parent_permlink, json_metadata)
           VALUES (%s, %s, %s, %s, %s::jsonb)""",
        (author, permlink, parent_author, parent_permlink, _meta(uid, app)),
    )


def _seed(conn: Any) -> None:
    """The world. Every row exists to make exactly one assertion possible."""
    # --- our own container, and three lite POSTS filed into it ---------------
    _post(conn, PUB, "lumen-c-1", "", "general", app=APP)          # the container (root)
    _comment(conn, PUB, "lumen-p1", PUB, "lumen-c-1", uid=U_A, app=APP)  # lite POST by A
    _comment(conn, PUB, "lumen-p2", PUB, "lumen-c-1", uid=U_B, app=APP)  # lite POST by B
    _comment(conn, PUB, "lumen-p3", PUB, "lumen-c-1", uid=U_C, app=APP)  # lite POST by C

    # --- an ordinary Hive post -----------------------------------------------
    _post(conn, "alice", "hive-post", "", "general")

    # --- conversation on the lite post P1 ------------------------------------
    # a DIFFERENT lite writer replies -> must count as one commenter (B)
    _comment(conn, PUB, "lumen-r1", PUB, "lumen-p1", uid=U_B, app=APP)
    # the SAME lite writer replies to their own post -> must NOT count
    _comment(conn, PUB, "lumen-r2", PUB, "lumen-p1", uid=U_A, app=APP)
    # a real Hive account replies -> must count
    _comment(conn, "bob", "r-bob-1", PUB, "lumen-p1")

    # --- the namespace attack, kept on its OWN post ---------------------------
    # A claim shaped like a REAL Hive account name. It must never key engagement
    # as `alice`. Isolated here so P1's arithmetic above stays a clean 2-and-1.
    _comment(conn, PUB, "lumen-r9", PUB, "lumen-p3", uid="alice", app=APP)

    # --- conversation on the ordinary Hive post ------------------------------
    # three DIFFERENT lite writers -> three commenters, not one `pub`
    _comment(conn, PUB, "lumen-r4", "alice", "hive-post", uid=U_A, app=APP)
    _comment(conn, PUB, "lumen-r5", "alice", "hive-post", uid=U_B, app=APP)
    _comment(conn, PUB, "lumen-r6", "alice", "hive-post", uid=U_C, app=APP)
    _comment(conn, "bob", "r-bob-2", "alice", "hive-post")
    # The author's own reply. `_SQL_COMMENTS_FOR_POSTS` deliberately does NOT
    # self-exclude (the caller's `excluded_for` does, per post, with the ring and
    # ban sets folded in); `_POPULAR_ENGAGEMENT` does, because SQL is where the
    # recall order is decided. Both behaviours are asserted below.
    _comment(conn, "alice", "r-self", "alice", "hive-post")

    # --- reblogs -------------------------------------------------------------
    conn.execute(
        "INSERT INTO hafsql.reblogs (account_name, author, permlink, created_at)"
        " VALUES ('carol', %s, 'lumen-p1', %s), (%s, %s, 'lumen-p1', %s)",
        (PUB, NOW, PUB, PUB, NOW),  # carol: counts; pub reblogging its own: excluded
    )

    # --- a flooder, for the per-author recall cap -----------------------------
    for i in range(5):
        _post(conn, "flood", f"flood-{i}")
        for j, who in enumerate(("f1", "f2", "f3")):
            _comment(conn, who, f"fc-{i}-{j}", "flood", f"flood-{i}")


def _lite(on: bool) -> dict[str, Any]:
    return {
        "lite_publishers": [PUB] if on else [],
        "lite_app": APP,
        "lite_container_prefix": hafsql._LITE_CONTAINER_PREFIX,
    }


def _commenters(conn: Any, keys: list[tuple[str, str]], *, lite: bool) -> dict[str, dict[str, int]]:
    rows = conn.execute(
        hafsql._SQL_COMMENTS_FOR_POSTS,
        {
            "authors": [k[0] for k in keys],
            "permlinks": [k[1] for k in keys],
            **_lite(lite),
        },
    ).fetchall()
    out: dict[str, dict[str, int]] = {}
    for author, permlink, commenter, count in rows:
        out.setdefault(f"{author}/{permlink}", {})[commenter] = count
    return out


_ENGAGEMENT = f"""
SELECT c.author || '/' || c.permlink, ({hafsql._POPULAR_ENGAGEMENT})
FROM hafsql.comments c
"""


def _engagement(conn: Any, *, lite: bool) -> dict[str, float]:
    rows = conn.execute(_ENGAGEMENT, _lite(lite)).fetchall()
    return {key: float(value) for key, value in rows}


def _recall(conn: Any, *, lite: bool, limit: int = 50, per_author: int | None = None) -> list[str]:
    rows = conn.execute(
        hafsql._SQL_POPULAR_POSTS,
        {
            "since": SINCE,
            "limit": limit,
            "per_author": hafsql._POPULAR_MAX_PER_AUTHOR if per_author is None else per_author,
            **_lite(lite),
        },
    ).fetchall()
    return [f"{r[0]}/{r[1]}" for r in rows]


# ---------------------------------------------------------------------------
# G5 — self-exclusion resolves the commenter
# ---------------------------------------------------------------------------


def test_a_reply_from_a_DIFFERENT_lite_writer_counts(db: Any) -> None:
    """THE FINDING, executed. `pub/lumen-p1` (writer A) carries a reply from
    writer B and one from `bob`. A and B are both the chain account `pub`, so
    the pre-G5 `rc.author <> c.author` read B's reply as the author talking to
    himself and threw it away.

    Arithmetic, so the number means something: 0.6 per distinct commenter, 0.4
    per distinct reblogger. Reblogs are `carol` (counts) and `pub` reblogging its
    own post (excluded) = 0.4 either way."""
    before = _engagement(db, lite=False)["pub/lumen-p1"]
    assert before == pytest.approx(1 * 0.6 + 0.4), "pre-G5: only `bob` survives"

    after = _engagement(db, lite=True)["pub/lumen-p1"]
    assert after == pytest.approx(2 * 0.6 + 0.4), "B's reply must now count too"


def test_a_lite_writer_replying_to_their_OWN_post_is_still_excluded(db: Any) -> None:
    """The other half, and the one a careless fix breaks. `lumen-p1` carries
    THREE replies — from B, from A (the author), and from bob — and must score
    TWO commenters, not three. Resolved-vs-resolved is what keeps A out;
    resolving only the commenter would make this a self-promotion printer."""
    scored = (_engagement(db, lite=True)["pub/lumen-p1"] - 0.4) / 0.6
    assert scored == pytest.approx(2.0), "the author's own reply must not count"
    # And the identity really is present in the underlying rows — i.e. the 2 is
    # an exclusion, not an absence.
    assert U_A in _commenters(db, [(PUB, "lumen-p1")], lite=True)["pub/lumen-p1"]


def test_five_lite_writers_are_five_commenters_not_one_publisher(db: Any) -> None:
    """`alice/hive-post` carries replies from three lite writers, bob, and alice
    herself. Before G5 the three lite writers collapsed into the single name
    `pub`, so every crowd measure downstream saw one account where there were
    three."""
    before = _commenters(db, [("alice", "hive-post")], lite=False)["alice/hive-post"]
    assert set(before) == {PUB, "bob", "alice"}, "pre-G5: every lite writer is one account"
    assert before[PUB] == 3, "three distinct writers, one name, counted as repeat comments"

    after = _commenters(db, [("alice", "hive-post")], lite=True)["alice/hive-post"]
    assert set(after) == {U_A, U_B, U_C, "bob", "alice"}
    assert sum(after.values()) == sum(before.values()), (
        "the DISPLAY comment total is a row count and must not move — only who "
        "those rows are attributed to changes"
    )


def test_the_post_author_is_excluded_from_RECALL_but_not_from_hydration(db: Any) -> None:
    """Two different jobs, deliberately. `_POPULAR_ENGAGEMENT` decides the recall
    ORDER, so it must self-exclude in SQL. `_SQL_COMMENTS_FOR_POSTS` reports WHO
    commented, and the caller (`select_popular`'s `excluded_for`) removes the
    author along with their ring and the ban set — a query that pre-removed the
    author would hide a row that pass has to see."""
    hydrated = _commenters(db, [("alice", "hive-post")], lite=True)["alice/hive-post"]
    assert "alice" in hydrated
    # 5 commenters in the rows, 4 credited by recall: alice's own is dropped.
    assert _engagement(db, lite=True)["alice/hive-post"] == pytest.approx(4 * 0.6)


def test_resolution_happens_in_the_RECALL_query_not_only_in_hydration(db: Any) -> None:
    """Order matters (FIX 2 §3): `_SQL_POPULAR_POSTS` cuts the pool to `limit`
    rows in SQL, BEFORE anything is hydrated and before lite engagement is
    merged. So the recall ORDER itself has to move when a lite post gains a lite
    reply, or a lite-popular post is discarded before anything can score it.

    Proven by changing only the data: `lumen-p2` starts below `lumen-p1` and
    overtakes it once three more lite writers reply to it (3 * 0.6 = 1.8 against
    p1's 2 * 0.6 + 0.4 = 1.6)."""
    assert _recall(db, lite=True).index("pub/lumen-p1") < _recall(db, lite=True).index(
        "pub/lumen-p2"
    )
    _comment(db, PUB, "lumen-r7", PUB, "lumen-p2", uid=U_A, app=APP)
    _comment(db, PUB, "lumen-r8", PUB, "lumen-p2", uid=U_C, app=APP)
    _comment(db, PUB, "lumen-ra", PUB, "lumen-p2", uid=U_D, app=APP)
    after = _recall(db, lite=True)
    assert after.index("pub/lumen-p2") < after.index("pub/lumen-p1"), (
        "recall must respond to lite conversation, or the lane can never see it"
    )


# ---------------------------------------------------------------------------
# G1 — the namespace guard
# ---------------------------------------------------------------------------


def test_a_lumen_user_id_shaped_like_a_hive_account_is_refused(db: Any) -> None:
    """`lumen-r9` claims `lumen_user_id = "alice"`, a real Hive account. Honoured,
    it would pool engagement into someone else's identity — someone else's
    ranked author, someone else's prior. It must fall back to the chain author
    instead: refused, never spoofed, and never silently dropped either."""
    got = _commenters(db, [(PUB, "lumen-p3")], lite=True)["pub/lumen-p3"]
    assert "alice" not in got, "a claimed identity may never be a real Hive account name"
    assert PUB in got, "the refused claim must fall back to the chain author, not vanish"


def test_the_namespace_envelope_covers_every_possible_hive_account_name() -> None:
    """The guard is a REGEX ENVELOPE, so its correctness is a property of the
    pattern, not of any row. Every valid Hive account name is 3-16 chars of
    lowercase letters/digits/dots/dashes starting with a letter; all of those
    must be refused, and a real ULID must not be."""
    import re

    envelope = re.compile(hafsql._HIVE_NAME_ENVELOPE)
    for name in ("alice", "blocktrades", "a1b", "hive.blog", "some-user", "a" * 16):
        assert envelope.match(name), f"{name} is a possible Hive account and must be refused"
    for uid in (U_A, U_B, U_C, U_D, "01KZCNB1W1VHCJ6W1NGJMGHHFW"):
        assert not envelope.match(uid), f"{uid} is a ULID and must be honoured"


# ---------------------------------------------------------------------------
# G4 — a lite POST is not a comment on its container (and a lite REPLY is)
# ---------------------------------------------------------------------------


def test_a_lite_post_is_not_counted_as_a_comment_on_its_container(db: Any) -> None:
    """★ THE GUARD THE LEDGER FOUND VACUOUS. Two lite posts are filed into
    `pub/lumen-c-1`. Counted as comments they would credit the whole Lite tier's
    output to the container — and, post-G5, would resolve to distinct writers
    and hand the container the top of the recall ordering."""
    assert _commenters(db, [(PUB, "lumen-c-1")], lite=True) == {}
    assert _engagement(db, lite=True)["pub/lumen-c-1"] == 0.0


def test_a_lite_REPLY_to_a_lite_post_is_NOT_swallowed_by_that_guard(db: Any) -> None:
    """The half the guard used to get wrong, and the direct cause of the
    measured `commenter count = 1`. A lite reply to a lite post has the
    publisher on BOTH sides, exactly like a lite post does — only the parent's
    permlink separates them (`lumen-c-` = container, else a post)."""
    assert U_B in _commenters(db, [(PUB, "lumen-p1")], lite=True)["pub/lumen-p1"]


def test_a_publishers_metadata_less_comment_is_not_dropped(db: Any, ) -> None:
    """Three-valued logic, failing toward data loss: `NULL->>'app'` is NULL and
    `NOT NULL` is NULL, which Postgres filters out. Without the COALESCE,
    turning lite on would silently delete the publisher's own ordinary comments
    from every comment count."""
    _comment(db, PUB, "plain-1", "alice", "hive-post")  # json_metadata IS NULL
    assert PUB in _commenters(db, [("alice", "hive-post")], lite=True)["alice/hive-post"]


# ---------------------------------------------------------------------------
# G3 — the per-author recall cap
# ---------------------------------------------------------------------------


def test_one_author_cannot_fill_the_recall_set(db: Any) -> None:
    """★ THE OTHER GUARD THE LEDGER FOUND VACUOUS — its own comment calls it
    "THE ATTACK, priced" and mutating it to `OR TRUE` left the suite
    byte-identical. `flood` publishes 5 posts, each with 3 commenters, which
    out-scores every other post here. At most `per_author` may be recalled."""
    for cap in (1, 2, 3):
        recalled = _recall(db, lite=True, per_author=cap)
        mine = [k for k in recalled if k.startswith("flood/")]
        assert len(mine) == cap, f"per_author={cap} admitted {len(mine)} rows from one author"
    # And the cap is what keeps the honest posts in the set at all: uncapped, the
    # flooder's five posts take every slot below the top one.
    assert "pub/lumen-p1" in _recall(db, lite=True, limit=4, per_author=1)
    assert "pub/lumen-p1" not in _recall(db, lite=True, limit=4, per_author=99)


def test_the_cap_partitions_on_the_RANKED_identity_not_the_chain_account(db: Any) -> None:
    """Three lite writers share one chain account. Partitioned on `c.author` the
    cap would treat the whole Lite tier as a single flooder and admit two lite
    posts network-wide, no matter how many people wrote them."""
    recalled = _recall(db, lite=True, per_author=hafsql._POPULAR_MAX_PER_AUTHOR)
    lite_posts = [k for k in recalled if k.startswith(f"{PUB}/lumen-p")]
    assert len(lite_posts) == 3 > hafsql._POPULAR_MAX_PER_AUTHOR, (
        "each lite writer gets their own share of the recall set"
    )


# ---------------------------------------------------------------------------
# The no-lite regression: publishers unset must be byte-identical to pre-G5
# ---------------------------------------------------------------------------


def test_with_no_publishers_every_identity_is_the_chain_account(db: Any) -> None:
    """`LiteConfig` defaults to no publishers, so this is what almost every
    deploy runs. `= ANY('{}')` is false for every row, so the CASE falls through
    to the chain author and the queries are the pre-G5 ones."""
    off = _commenters(db, [(PUB, "lumen-p1"), ("alice", "hive-post")], lite=False)
    assert set(off["alice/hive-post"]) == {PUB, "bob", "alice"}
    # p1's lite replies all arrive as `pub` — one name for two writers.
    assert set(off["pub/lumen-p1"]) == {PUB, "bob"}
    # ...and `pub` IS p1's chain author, so recall self-excludes it: 1 commenter.
    assert _engagement(db, lite=False)["pub/lumen-p1"] == pytest.approx(0.6 + 0.4)
    # The container guard does not depend on lite being on either: with no
    # publishers the children are simply the author's own comments on their own
    # post, which recall already excludes.
    assert _engagement(db, lite=False)["pub/lumen-c-1"] == 0.0


def test_the_container_prefix_is_the_one_popular_config_declares() -> None:
    """`recsys.core.popular.is_container_post` drops containers from the lane on
    `PopularConfig.lumen_container_prefix`; this SQL identifies a container CHILD
    on the same string. Two places deciding what a container is, from one
    constant — this test is what makes that true rather than aspirational."""
    from recsys.config import PopularConfig

    assert hafsql._LITE_CONTAINER_PREFIX == PopularConfig().lumen_container_prefix
