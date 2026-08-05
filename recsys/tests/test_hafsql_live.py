"""A3 — live-DB smoke test against the real HAFSQL mirror.

WHY THIS FILE EXISTS: ``tests/test_hafsql.py`` asserts SQL strings are
non-empty and never executes one (see its own module docstring). That is how
8 hard breaks (bad column names, a jsonb/array operator mismatch, a missing
numeric cast, a ``Decimal``/``int`` mismatch, naive-vs-aware datetimes, and
two missing-lite-params bugs — see ``recsys/io/hafsql.py``'s per-query "break
#N" comments) survived every gate for as long as the I/O layer had never been
executed once. This file calls every ``HafsqlGateway`` method — plus
``author_engagement``, which is not part of the Protocol's typed surface but
is exercised the same way — against the real, public HAFSQL mirror, so a
future regression that only shows up at execution time (a renamed column, a
changed operator, a type the driver stopped coercing) fails CI instead of
shipping silently again.

GATING: skipped, not failed, whenever ``RECSYS_LIVE_DB`` is unset OR the
mirror is unreachable within a short timeout — so the default, offline
``pytest -q`` run stays exactly as fast and network-free as it was before
this file existed. Opt in with::

    RECSYS_LIVE_DB=1 pytest -q -m live

NOTE ON ``pyproject.toml``: A3's map also calls for (a) registering a ``live``
pytest marker and a ``-m live`` Makefile/CI target, and (b) adding
``psycopg[binary]>=3.1`` to the ``dev`` extra. Both live in ``pyproject.toml``,
which this builder does not own this phase (file-ownership boundary — see the
build report). The ``@pytest.mark.live`` marker below works today without
registration (pytest just emits an unregistered-marker warning, not a
failure); the module-level ``skipif`` is what actually gates execution, so
CI correctness does not depend on the registration landing first.

A15 (network_suppression, second DB connection): this file's mirror-only
tests never touch it. A SEPARATE, independently-gated block at the bottom
(``RECSYS_DATABASE_URL``) exercises the real second-connection path — skipped
on its own if that DSN is not set, so the base live suite above does not
require standing up a second database.

A5/A11/A12 (2026-08-04, this builder): three more sections below.
``window_posts`` (A5) is live-timed and live-sized against the real mirror.
``author_engagement`` (A11) gets a regression pin (an ordinary account's
result is unchanged) plus a lite-turned-on execution proof. A12's key
resolution gets an end-to-end proof built from REAL on-chain data.

★ CORRECTED 2026-08-05: Lite posting HAS launched — 10 lite posts are on
mainnet, published 2026-07-27 by `hbd-temp`, carrying 9 distinct
`lumen_user_id` values. What is still true, and is why the synthetic-shape
proofs below remain synthetic, is that **no Hive account has ever voted,
replied to or reblogged one of them**, so no ENGAGED lite post can be pulled
off the live mirror. The L1 section at the bottom of this file measures that
directly rather than assuming it.
"""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime, timedelta

import pytest

from recsys.config import HafsqlConfig, LiteConfig
from recsys.io import hafsql

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.environ.get("RECSYS_LIVE_DB"),
        reason="RECSYS_LIVE_DB not set — live-mirror suite opted out (offline by default)",
    ),
]

# A known-active, high-post-volume mainnet account (verified live 2026-08-04:
# 37+ top-level posts in a 45-day window, hundreds of votes per post) — gives
# every query below a realistic non-empty result to assert shape on, not just
# "did not raise".
_ACTIVE_ACCOUNT = "acidyo"
_SINCE_3D = lambda: datetime.now(UTC) - timedelta(days=3)  # noqa: E731
_SINCE_45D = lambda: datetime.now(UTC) - timedelta(days=45)  # noqa: E731
_LIMIT = 25


@pytest.fixture(scope="module")
def client() -> hafsql.HafsqlClient:
    c = hafsql.HafsqlClient(HafsqlConfig(), LiteConfig())
    # Fail the whole module fast (as a skip, not a hard failure — the mirror
    # being briefly unreachable is an infra blip, not a code regression) if
    # even a trivial query can't get through within the connect timeout.
    try:
        c.follow_graph(frozenset({_ACTIVE_ACCOUNT}))
    except Exception as exc:  # any failure here means "can't reach it"
        pytest.skip(f"HAFSQL mirror unreachable: {type(exc).__name__}: {exc}")
    return c


# ---------------------------------------------------------------------------
# One assertion per A2 fix, individually pinned so a regression in any single
# one is attributable rather than lost in a general "something broke".
# ---------------------------------------------------------------------------


def test_in_network_posts_and_engaged_oon_posts_do_not_raise_programming_error(
    client: hafsql.HafsqlClient,
) -> None:
    """breaks #1/#2: missing lite params (`ProgrammingError`)."""
    posts = client.in_network_posts(frozenset({_ACTIVE_ACCOUNT}), _SINCE_3D(), _LIMIT)
    assert isinstance(posts, list)
    candidates = client.engaged_oon_posts(frozenset({_ACTIVE_ACCOUNT}), _SINCE_3D(), _LIMIT)
    assert isinstance(candidates, list)


def test_tag_posts_returns_at_least_one_row(client: hafsql.HafsqlClient) -> None:
    """break #3: `jsonb && text[]` had no operator (`UndefinedFunction`).
    "photography" is a high-volume tag on Hive — real activity every day."""
    posts = client.tag_posts(frozenset({"photography"}), _SINCE_3D(), _LIMIT)
    assert len(posts) >= 1
    for post in posts:
        assert post.author and post.permlink


def test_engagement_edges_returns_edges_with_every_last_interaction_aware(
    client: hafsql.HafsqlClient,
) -> None:
    """break #6 (`UndefinedColumn: created`) + break #8 (naive timestamps):
    a 1-hour window on live mainnet always has upvote activity."""
    edges = client.engagement_edges(datetime.now(UTC) - timedelta(hours=1))
    assert len(edges) >= 1
    for edge in edges:
        if edge.last_interaction is not None:
            assert edge.last_interaction.tzinfo is not None, (
                f"naive last_interaction on edge {edge.src}->{edge.dst}"
            )


def test_hydrated_vote_rshares_are_real_ints_never_decimal_or_bool(
    client: hafsql.HafsqlClient,
) -> None:
    """break #7: Postgres `numeric` -> `decimal.Decimal` unless coerced, and
    `bool` is technically an `int` subclass in Python so a naive isinstance
    check could pass on the wrong type — check both explicitly."""
    posts = client.in_network_posts(frozenset({_ACTIVE_ACCOUNT}), _SINCE_3D(), 5)
    posts_with_votes = [p for p in posts if p.votes]
    assert posts_with_votes, "expected at least one recent post with votes to check"
    checked = 0
    for post in posts_with_votes:
        for vote in post.votes:
            assert isinstance(vote.rshares, int)
            assert not isinstance(vote.rshares, bool)
            assert vote.timestamp.tzinfo is not None
            checked += 1
    assert checked > 0


def test_author_engagement_does_not_raise_undefined_function(
    client: hafsql.HafsqlClient,
) -> None:
    """break #5: `LOG(10, <double precision>)` had no overload
    (`UndefinedFunction`)."""
    result = client.author_engagement(frozenset({_ACTIVE_ACCOUNT}), _SINCE_45D())
    assert _ACTIVE_ACCOUNT in result
    engagement = result[_ACTIVE_ACCOUNT]
    assert engagement.posts > 0
    assert engagement.total_base >= 0.0


# ---------------------------------------------------------------------------
# Every remaining HafsqlGateway method, for completeness (A3's mandate: call
# EVERY method, not just the ones a numbered break touched).
# ---------------------------------------------------------------------------


def test_stake_lineage_is_gone_from_the_live_client(client: hafsql.HafsqlClient) -> None:
    """B2 (2026-08-05): the delegation relation was removed, not neutered — a
    stranger could write it (Hive delegation needs no consent from the
    delegatee). Pinned against the LIVE client too, so a reintroduction cannot
    slip in behind a mirror-only code path."""
    assert not hasattr(client, "stake_lineage")


def test_second_degree_engagers_does_not_raise(client: hafsql.HafsqlClient) -> None:
    posts = client.in_network_posts(frozenset({_ACTIVE_ACCOUNT}), _SINCE_3D(), 5)
    if not posts:
        pytest.skip("no recent posts to build a post-key set from")
    keys = frozenset(p.key for p in posts)
    result = client.second_degree_engagers(keys, frozenset({_ACTIVE_ACCOUNT}))
    assert isinstance(result, dict)


def test_follow_graph_does_not_raise(client: hafsql.HafsqlClient) -> None:
    result = client.follow_graph(frozenset({_ACTIVE_ACCOUNT, "steemit"}))
    assert isinstance(result, dict)


def test_popular_posts_returns_plausible_shape(client: hafsql.HafsqlClient) -> None:
    posts = client.popular_posts(_SINCE_3D(), _LIMIT)
    assert len(posts) >= 1
    for post in posts:
        assert post.author and post.permlink
        assert post.created.tzinfo is not None


# ---------------------------------------------------------------------------
# A5 — window_posts: the NormContext sample source.
#
# Live sizing (this builder, 2026-08-04), row fetch only: 3d = 3,770 posts /
# 1,673 authors in 0.074s (count) / 0.201s (full row fetch); 7d = 8,884 posts
# / 2,223 authors in 0.073s / 0.152s — closely matching BUILDMAP-A's own
# 3,753/1,668 and 8,882/2,224 (small live-data drift between measurements
# expected).
#
# ★ BUT the row count is not the real cost — `window_posts` always HYDRATES,
# and hydration is dominated by total VOTE volume, not post count. Measured
# via the ACTUAL shipped method (this file's own test below, run twice):
# `window_posts(3d)` completes in ~8.8s (3,759-3,760 posts). A follow-up
# measurement AT 7 DAYS (via a raised `statement_timeout_ms`, since the
# default cancels it) found `_votes_for_posts` alone pulls 1,231,239 vote rows
# for 8,887 posts and takes ~19.5s by itself — so `window_posts(7d)`, AS
# SHIPPED, TIMES OUT under the default 15s `statement_timeout`
# (`psycopg.errors.QueryCanceled`). Only the 3-day window
# (`HistoryWindows.sourcing_freshness_days`'s actual default) has been
# measured to complete, with real but not huge headroom (8.8s of 15s). See
# `recsys/io/hafsql.py`'s `_SQL_WINDOW_POSTS`/`window_posts` docstrings for
# the full breakdown and why this argues for caching the result rather than
# widening the window or the timeout.
# ---------------------------------------------------------------------------


def test_window_posts_returns_the_whole_recency_ordered_window(
    client: hafsql.HafsqlClient,
) -> None:
    since = datetime.now(UTC) - timedelta(days=3)
    t0 = time.monotonic()
    posts = client.window_posts(since, 50_000)
    elapsed = time.monotonic() - t0
    print(
        f"\nA5 window_posts(3d, hydrated): {len(posts)} posts, "
        f"{len({p.author for p in posts})} distinct authors, {elapsed:.3f}s"
    )
    # Loose floor, not the exact live count (which drifts with real chain
    # activity between measurements) — the map's own 3,753 and this builder's
    # 3,770 both clear it comfortably.
    assert len(posts) >= 1000
    assert len({p.author for p in posts}) >= 500
    for post in posts:
        assert post.author and post.permlink
        assert post.created.tzinfo is not None
    # A5's defining property: recency order, not engagement order.
    createds = [p.created for p in posts]
    assert createds == sorted(createds, reverse=True)


def test_window_posts_includes_lite_posts_on_the_same_terms_live(
    client: hafsql.HafsqlClient,
) -> None:
    """★ CORRECTED 2026-08-05: lite content DOES now exist on mainnet — 10
    posts, published 2026-07-27 by `hbd-temp`, 9 distinct `lumen_user_id`s.
    This test still uses a deliberately non-existent publisher, because what it
    pins is that the LITE BRANCH executes live WITH NOBODY MATCHING — the
    same class of proof A2 breaks #1/#2 required
    (`_top_level_or_lite` bakes in `%(lite_publishers)s`/`%(lite_app)s` at
    import time, so a missing bind crashes even when nobody matches)."""
    client_with_lite = hafsql.HafsqlClient(
        HafsqlConfig(),
        LiteConfig(publisher_accounts=frozenset({"this-account-does-not-post-lite"})),
    )
    posts = client_with_lite.window_posts(datetime.now(UTC) - timedelta(days=1), 1000)
    assert isinstance(posts, list)


# ---------------------------------------------------------------------------
# A11 — the author-pooled prior now matches the RANKED identity
# (`_identity(c)`), not the bare chain author, so a lite author's prior is no
# longer structurally empty. No real lite content exists on mainnet yet, so
# the live proof is (a) a regression pin — an ordinary account's result is
# BYTE-IDENTICAL to before, since `_identity(c)` collapses to `c.author` for
# every post with no `lumen_user_id` — and (b) an execution proof that the
# query's now-live lite branch (`_fetch_lite`, not `_fetch`) does not crash.
# ---------------------------------------------------------------------------


def test_author_engagement_matches_a_real_author_unchanged(
    client: hafsql.HafsqlClient,
) -> None:
    """Regression pin: A11 widened the match to `_identity(c)`, which for any
    REAL Hive author (no `lumen_user_id` on their posts) is exactly
    `c.author` — this proves the widening did not change the ordinary case."""
    result = client.author_engagement(frozenset({_ACTIVE_ACCOUNT}), _SINCE_45D())
    assert _ACTIVE_ACCOUNT in result
    assert result[_ACTIVE_ACCOUNT].posts > 0
    assert result[_ACTIVE_ACCOUNT].total_base >= 0.0


def test_author_engagement_executes_with_lite_turned_on(client: hafsql.HafsqlClient) -> None:
    """A11 switched the mirror round trip from `_fetch` to `_fetch_lite`, so
    the query now ALWAYS binds lite_publishers/lite_app — the same class of
    bug A2 fixed for in_network_posts/engaged_oon_posts (`ProgrammingError:
    query parameter missing`). Turn lite ON with a placeholder publisher that
    owns no real content, so the WHERE clause's lite branch is live but always
    false, and prove the query still executes end to end."""
    client_with_lite = hafsql.HafsqlClient(
        HafsqlConfig(),
        LiteConfig(publisher_accounts=frozenset({"this-account-does-not-post-lite"})),
    )
    result = client_with_lite.author_engagement(frozenset({_ACTIVE_ACCOUNT}), _SINCE_45D())
    assert _ACTIVE_ACCOUNT in result
    assert result[_ACTIVE_ACCOUNT].posts > 0


# ---------------------------------------------------------------------------
# PERF (2026-08-04, this builder) — `author_engagement` was measured as the
# top operational risk before real traffic: `pipeline._author_priors` calls it
# on EVERY request (own_base is 80% of the composite score via the organic
# term), and it was measured PAST the 15s default `HAFSQL_STATEMENT_TIMEOUT_MS`
# for a single well-followed real account, and up to 58s in one containerised
# run against a 47-follow account. See the long PERF comment directly above
# `_SQL_AUTHOR_ENGAGEMENT` in `recsys/io/hafsql.py` for the
# `EXPLAIN (ANALYZE, BUFFERS)` findings (an unneeded `hafd.blocks` join hidden
# inside two HAFSQL views, and a non-sargable row filter forcing a
# network-wide scan) and the query rewrite that fixes both.
#
# This section pins BOTH halves of that finding live, end-to-end through the
# real `HafsqlClient.author_engagement` method (not a raw SQL string):
#   1. the realistic case (a real account's follow list, at the ACTUAL
#      quality_prior_days=45 window `pipeline._author_priors` uses) now
#      completes comfortably inside the timeout, repeatedly;
#   2. the residual STRUCTURAL finding — a high-post-volume candidate set
#      still exceeds the timeout even after the rewrite, because the query
#      remains fundamentally one correlated subquery per candidate post,
#      bounded below by total vote/comment row volume — stays true and stays
#      PROVEN, so a future change cannot silently claim "fully fixed" without
#      evidence, and a future regression (back toward the pre-rewrite shape)
#      is caught even on the light, realistic case.
# ---------------------------------------------------------------------------

# `blocktrades` follows exactly 47 accounts (live-fetched from
# `hafsql.follows WHERE follower_name = 'blocktrades'`, 2026-08-04) — the SAME
# account and follow-count this module's own PERF comment cites for the
# original 58s containerised measurement. Hardcoded (not re-fetched per test
# run) for determinism: the point is to pin the QUERY's performance
# characteristic against a fixed, realistic candidate-author set, not to
# track blocktrades' current follow list day to day.
_WELL_FOLLOWED_ACCOUNT_FOLLOWS = frozenset(
    {
        "dantheman", "bavak", "smooth", "dan", "ned", "complexring", "arhag",
        "acidyo", "gtg", "opheliafu", "papa-pepper", "timsaid", "lordvader",
        "ats-david", "aaronkoenig", "markrmorrisjr", "michelle.gent", "verbal-d",
        "everittdmickey", "steemsports", "johnjgeddes", "fibra59", "tarazkp",
        "mobbs", "suesa", "grocko", "snowmachine", "abigail-dantes", "wolfeblog",
        "atopy", "zest", "jeunebug", "creativetruth", "magik4283", "agorise",
        "redheadroadtrip", "andablackwidow", "blockchainstudio", "engrave",
        "theycallmedan", "steem.marketing", "ngc1559", "hbd.funder", "mtyszczak",
        "ilysarazom", "thebeedevs", "worldmappin",
    }
)
assert len(_WELL_FOLLOWED_ACCOUNT_FOLLOWS) == 47

# Generous regression ceiling, not a tight performance target: repeated live
# measurement (this builder, 2026-08-04) put the REWRITTEN query at ~0.9-1.6s
# for this exact account/window on a warm mirror cache, with observed
# run-to-run variance up to ~3.1s under load (the mirror is a shared public
# server). 10s leaves real headroom below the 15s statement_timeout — and
# below the pre-rewrite shape's cost, which this builder measured at 35s for
# a candidate set only ~3x this one's post count (150 busy authors / 14,464
# posts vs. this account's 8 active authors / 202 posts) — while still being
# tight enough to catch a genuine regression back toward that shape.
_PERF_CEILING_S = 10.0


def test_author_engagement_completes_well_inside_the_timeout_for_a_realistic_account(
    client: hafsql.HafsqlClient,
) -> None:
    """PERF acceptance criterion: a realistic well-followed account's
    candidate set, at the ACTUAL `HistoryWindows.quality_prior_days` window
    (45 days — not the shorter `sourcing_freshness_days` window some other
    gateway methods use), completes comfortably inside the 15s default
    `HAFSQL_STATEMENT_TIMEOUT_MS`, REPEATEDLY (run twice in a row, per the
    acceptance criterion — not just once, since a cold-cache/first-call
    penalty would otherwise hide behind a single warm measurement)."""
    since = datetime.now(UTC) - timedelta(days=45)
    result: dict[str, object] = {}
    for attempt in range(2):
        t0 = time.monotonic()
        result = client.author_engagement(_WELL_FOLLOWED_ACCOUNT_FOLLOWS, since)  # type: ignore[assignment]
        elapsed = time.monotonic() - t0
        print(
            f"\nPERF author_engagement(47 real follows, 45d) attempt {attempt}: "
            f"{elapsed:.3f}s, {len(result)} authors with priors"
        )
        assert elapsed < _PERF_CEILING_S, (
            f"author_engagement took {elapsed:.3f}s on attempt {attempt} — "
            f"expected well under the {_PERF_CEILING_S}s regression ceiling "
            f"(and under the 15s statement_timeout) for a realistic "
            f"47-follow, 45-day candidate set"
        )
    # Not just fast — still CORRECT: a real, prolific account in the window
    # must still surface a real, positive prior (acidyo posts prolifically
    # and is one of the 47 follows above).
    assert "acidyo" in result
    assert result["acidyo"].posts > 0  # type: ignore[attr-defined]
    assert result["acidyo"].total_base > 0.0  # type: ignore[attr-defined]


@pytest.mark.skipif(
    not os.environ.get("RECSYS_LIVE_DB_SLOW"),
    reason="RECSYS_LIVE_DB_SLOW not set — the structural-floor diagnostic "
    "(~20-35s live) is opted OUT of the default live suite so a routine "
    "`RECSYS_LIVE_DB=1 pytest -m live` run stays fast; set it to re-verify "
    "the architectural finding below",
)
def test_author_engagement_structural_floor_persists_for_a_busy_candidate_set(
    client: hafsql.HafsqlClient,
) -> None:
    """PERF's residual, most important finding: the query rewrite fixes FIXED
    overhead (an unneeded blocks join, a non-sargable network-wide scan) but
    does NOT change the query's fundamental shape — one correlated subquery
    per candidate post, cost bounded below by total vote/comment row volume
    across every window post by every candidate author.

    `pipeline._author_priors` is called with `eligible` UNION `filler` from
    the FULL candidate pool (see `recsys/pipeline.py` around `quality_since`),
    not a raw follow list — and that pool's sourcing (popular-posts padding,
    tag/engaged-OON expansion) can pull in high-frequency posters. Simulate
    that with the real network's own busiest posters over the window (a
    stand-in this builder used for the 35s/28s/21-36s measurements cited in
    the PERF comment in `recsys/io/hafsql.py`) and prove the timeout is STILL
    at real risk — so nobody reads the rewrite above as having solved this
    case, and a future change that actually solves it (or regresses further)
    shows up here rather than silently.

    This is why `HafsqlClient.author_engagement` remains, as documented, an
    architectural candidate for the SAME cache/timer basis as `popular_posts`
    (`HAFSQL_POPULAR_CACHE_TTL_S`) rather than a per-request computation."""
    import psycopg

    since = datetime.now(UTC) - timedelta(days=45)
    conn = psycopg.connect(
        host=client._config.host,
        port=client._config.port,
        dbname=client._config.dbname,
        user=client._config.user,
        password=client._config.password,
        connect_timeout=client._config.connect_timeout,
        autocommit=True,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT author FROM hafsql.comments_table
                WHERE parent_author = '' AND deleted = false AND created >= %s
                GROUP BY author ORDER BY count(*) DESC LIMIT 150
                """,
                (since,),
            )
            busy_authors = frozenset(row[0] for row in cur.fetchall())
    finally:
        conn.close()
    if len(busy_authors) < 100:
        pytest.skip(
            "fewer than 100 distinct busy authors found live — network "
            "activity too low right now to stress-test the structural floor"
        )

    # PART 1 — the exact production failure mode. `client` (the module
    # fixture) uses the same 15s default `HAFSQL_STATEMENT_TIMEOUT_MS` a real
    # deployment would, so this call does not just run "slowly" — Postgres
    # itself cancels it (`psycopg.errors.QueryCanceled`), exactly the failure
    # `pipeline._author_priors` would hit in production for this shape of
    # candidate set. Live-verified (this builder, 2026-08-04): still true
    # after the rewrite.
    t0 = time.monotonic()
    with pytest.raises(psycopg.errors.QueryCanceled):
        client.author_engagement(busy_authors, since)
    elapsed = time.monotonic() - t0
    print(
        f"\nPERF author_engagement({len(busy_authors)} busy authors, 45d) "
        f"under the REAL 15s statement_timeout: QueryCanceled after "
        f"{elapsed:.3f}s"
    )
    # Confirms Postgres actually ran into its own statement_timeout (~15s),
    # not some unrelated fast client-side failure (bad DSN, auth, etc.).
    assert elapsed > 10.0, (
        f"QueryCanceled fired after only {elapsed:.3f}s — too fast to be the "
        f"real 15s statement_timeout; investigate before trusting this test"
    )

    # PART 2 — how long it ACTUALLY takes to completion, measured by
    # deliberately raising the timeout on a SEPARATE client (never do this in
    # production — see the PERF comment's architectural recommendation).
    # Restates the finding as a live assertion: even once allowed to finish,
    # this candidate-author shape is NOT comfortably inside the normal
    # budget. If this assertion starts failing (i.e. the call finishes
    # faster than `_PERF_CEILING_S`), that is GOOD NEWS — a further
    # optimization or the architectural fix landed — but it should be a
    # deliberate, reviewed change to this test's expectation and to the PERF
    # comment in recsys/io/hafsql.py, not a silent surprise.
    generous_client = hafsql.HafsqlClient(
        HafsqlConfig(), LiteConfig(), statement_timeout_ms=90_000
    )
    t0 = time.monotonic()
    result = generous_client.author_engagement(busy_authors, since)
    elapsed = time.monotonic() - t0
    print(
        f"PERF author_engagement({len(busy_authors)} busy authors, 45d) "
        f"with statement_timeout raised to 90s: completed in {elapsed:.3f}s, "
        f"{len(result)} authors with priors"
    )
    assert elapsed > _PERF_CEILING_S, (
        f"busy-set author_engagement finished in {elapsed:.3f}s (<= "
        f"{_PERF_CEILING_S}s) even under a relaxed timeout — if a real fix "
        f"landed, update this test's expectation and the PERF comment in "
        f"recsys/io/hafsql.py to match (don't just loosen or delete this "
        f"assertion)"
    )


# ---------------------------------------------------------------------------
# A12 — the Post.key / chain-identity mismatch. ★ CORRECTED 2026-08-05: lite
# posting HAS launched (10 posts on mainnet by `hbd-temp`), but none has ever
# been voted, replied to or reblogged, so this still cannot pull a genuine
# ENGAGED lite post off the live mirror. Instead it builds the SAME shape a
# real one would have: a SYNTHETIC ranked identity (standing in for a
# `lumen_user_id`) substituted over a REAL on-chain post with REAL live
# engagement, exactly what `_build_post` does for an actual lite post (only
# the identity is fabricated; the (author, permlink) coordinates, the vote,
# and the voter are all genuine live rows). This proves the resolution
# round-trips against the live mirror: the query goes out under the CHAIN
# author, and the result comes back keyed under the RANKED (lite-shaped) key
# — exactly what `filter_eligible`'s `engager_index.get(post.key)`
# (`core/second_degree.py`) requires.
# ---------------------------------------------------------------------------


def test_a_lite_shaped_key_resolves_against_the_real_chain_identity(
    client: hafsql.HafsqlClient,
) -> None:
    posts = client.in_network_posts(frozenset({_ACTIVE_ACCOUNT}), _SINCE_3D(), 10)
    # ★ Pick a voter the GATE would actually credit, not merely the first one
    # (fixed 2026-08-05). This took `post.votes[0].voter` and went red against
    # live data the day the chain moved under it: that slot happened to hold
    # `mk-sports-token` with **rshares 0**, and `second_degree_engagers`
    # correctly refuses a zero-weight vote as a vouch — 417 of that post's 432
    # voters resolved fine. The product was right and the fixture was wrong,
    # which is the failure mode a live test against a moving chain invites.
    candidates = [
        (p, v.voter)
        for p in posts
        for v in p.votes
        if v.rshares > 0
    ]
    if not candidates:
        pytest.skip("no recent post with a positive-rshares voter to build a proof from")
    post, real_voter = candidates[0]
    fake_lite_key = f"@u_test_lite_a12/{post.permlink}"
    chain_authors = {fake_lite_key: post.author}

    resolved = client.second_degree_engagers(
        frozenset({fake_lite_key}), frozenset({real_voter}), chain_authors=chain_authors
    )
    assert fake_lite_key in resolved, (
        f"chain-identity resolution failed: queried {post.author!r} for "
        f"{fake_lite_key!r} but got nothing back"
    )
    assert real_voter in resolved[fake_lite_key]

    # Without resolution the SAME call must find nothing — the fake ranked
    # author "u_test_lite_a12" never appears as a `voter`/`author` on chain
    # (it isn't a Hive account), which is exactly the A12 bug this fix closes.
    unresolved = client.second_degree_engagers(
        frozenset({fake_lite_key}), frozenset({real_voter}), chain_authors=None
    )
    assert unresolved == {}


def test_suppressed_keys_does_not_raise_even_without_a_recsys_dsn(
    client: hafsql.HafsqlClient,
) -> None:
    """A15: with no RECSYS_DATABASE_URL, this degrades to "nothing
    suppressed" rather than crashing — the documented fallback, exercised
    here against whatever the process environment actually has (may or may
    not include the recsys DSN; either way it must not raise)."""
    result = client.suppressed_keys(frozenset({f"@{_ACTIVE_ACCOUNT}/does-not-exist"}))
    assert isinstance(result, frozenset)


# ---------------------------------------------------------------------------
# A4 regression tripwire: one realistic sequence of gateway calls must open a
# SMALL, bounded number of physical connections, not one per query. This is
# the entire point of A4 — see the build report for the measured 604 -> 1
# result on a larger, synthetic-author simulation.
# ---------------------------------------------------------------------------


def test_a_realistic_call_sequence_opens_only_a_few_physical_connections(
    client: hafsql.HafsqlClient,
) -> None:
    before = client._pool.connections_opened
    follows = frozenset({_ACTIVE_ACCOUNT, "steemit"})
    since = _SINCE_3D()
    client.in_network_posts(follows, since, 10)
    client.engaged_oon_posts(follows, since, 10)
    client.tag_posts(frozenset({"photography"}), since, 10)
    client.window_posts(since, 10)
    client.popular_posts(since, 10)
    client.follow_graph(follows)
    client.engagement_edges(datetime.now(UTC) - timedelta(hours=1))
    client.author_engagement(follows, _SINCE_45D())
    for account in (_ACTIVE_ACCOUNT, "steemit"):
        client.follow_graph(frozenset({account}))
        client.follow_graph(frozenset({account}))  # deliberately repeated
    after = client._pool.connections_opened
    opened_this_test = after - before
    # ~14 query calls above; pre-A4 each opened its own connection (1:1). A
    # pool with default max_size=5 should never need more than a handful even
    # under contention, and a single-threaded sequential caller like this
    # test should converge on ONE reused connection.
    assert opened_this_test <= 5, (
        f"expected pooling to bound connections opened to <=5 for ~14 calls, "
        f"got {opened_this_test} — pooling may have regressed"
    )


# ---------------------------------------------------------------------------
# A15, second connection: only runs when RECSYS_DATABASE_URL is ALSO set.
# Independently gated (not folded into the `client` fixture above) so the
# base mirror suite never requires standing up a second database.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.environ.get("RECSYS_DATABASE_URL"),
    reason="RECSYS_DATABASE_URL not set — A15 second-connection suite opted out",
)
class TestNetworkSuppressionSecondConnection:
    """Exercises the REAL second connection (A15), not the no-DSN degrade
    path (that's covered offline in test_hafsql.py and live above via the
    default-environment `suppressed_keys` call)."""

    @pytest.fixture()
    def client_with_recsys(self) -> hafsql.HafsqlClient:
        return hafsql.HafsqlClient(
            HafsqlConfig(), LiteConfig(), recsys_dsn=os.environ["RECSYS_DATABASE_URL"]
        )

    def test_suppressed_keys_queries_the_real_recsys_db(
        self, client_with_recsys: hafsql.HafsqlClient
    ) -> None:
        result = client_with_recsys.suppressed_keys(
            frozenset({f"@{_ACTIVE_ACCOUNT}/does-not-exist-either"})
        )
        assert isinstance(result, frozenset)

    def test_author_engagement_completes_the_second_round_trip(
        self, client_with_recsys: hafsql.HafsqlClient
    ) -> None:
        result = client_with_recsys.author_engagement(
            frozenset({_ACTIVE_ACCOUNT}), _SINCE_45D()
        )
        assert _ACTIVE_ACCOUNT in result


# ---------------------------------------------------------------------------
# L1 (2026-08-05) — lite edge resolution, against the real mirror.
#
# ★ The module docstring above says no real Lumen Lite content exists on
# mainnet. That is now STALE: measured 2026-08-05, 10 lite posts exist,
# published 2026-07-27 by ONE publisher account (`hbd-temp`), carrying 9
# distinct `lumen_user_id` values.
# ---------------------------------------------------------------------------

_LIVE_LITE_PUBLISHER = "hbd-temp"


def test_lite_posts_on_mainnet_carry_a_resolvable_writer_identity() -> None:
    """The resolution SOURCE is real data, not a hypothesis: publisher-authored
    posts carry a 26-char ULID in `json_metadata.lumen_user_id`, which is what
    the edge queries' `lite` CTE maps a permlink to."""
    import psycopg

    from recsys.config import HafsqlConfig

    cfg = HafsqlConfig()
    with (
        psycopg.connect(
            host=cfg.host, port=cfg.port, dbname=cfg.dbname,
            user=cfg.user, password=cfg.password, connect_timeout=cfg.connect_timeout,
            autocommit=True,
        ) as conn,
        conn.cursor() as cur,
    ):
        cur.execute(
            "SELECT json_metadata->>'lumen_user_id' FROM hafsql.comments "
            "WHERE author = %(pub)s AND json_metadata->>'app' = %(app)s "
            "AND json_metadata->>'lumen_user_id' IS NOT NULL LIMIT 5",
            {"pub": _LIVE_LITE_PUBLISHER, "app": "lumen/1.0"},
        )
        ids = [row[0] for row in cur.fetchall()]
    assert ids, "no lite posts found on mainnet — re-check the publisher account"
    assert all(len(i) == 26 for i in ids), ids


def test_lite_edge_queries_execute_and_do_not_disturb_non_lite_edges() -> None:
    """★ THE NON-REGRESSION PROOF, on real data. With lite publishers
    configured, the edge sets must be IDENTICAL to the plain queries' for every
    pair that has nothing to do with lite — the lite branch adds resolution, it
    does not perturb the existing graph.

    ★★ HONEST LIMIT, recorded rather than papered over: end-to-end resolution
    (a Hive account's vote crediting a LITE WRITER instead of the publisher)
    **cannot be demonstrated on mainnet today, because no Hive account has ever
    voted, replied to or reblogged a lite post.** Measured 2026-08-05: the only
    vote on any `hbd-temp` post is on a non-lite permlink. What is proven here
    is that the queries execute against the real schema (the break class that
    once killed the entire weekly trust batch) and that they are equivalent
    everywhere else. The remaining step is pinned offline in
    `tests/test_hafsql.py`'s wiring gates.

    Also a PERFORMANCE pin. The first version of the reblog variant joined
    `hafsql.comments` inline and measured **197.6s for a 6-hour window** — the
    trust batch runs 365 days. `MATERIALIZED` on the bounded CTE took it to
    ~1.1s. If this test starts timing out, that is what regressed.
    """
    since = datetime.now(UTC) - timedelta(hours=6)
    plain = hafsql.HafsqlClient(HafsqlConfig(), LiteConfig())
    with_lite = hafsql.HafsqlClient(
        HafsqlConfig(),
        LiteConfig(publisher_accounts=frozenset({_LIVE_LITE_PUBLISHER}), app_id="lumen/1.0"),
    )

    # ★ The mirror is a MOVING TARGET: `since` is fixed but the chain is not, so
    # two sequential reads of the same window legitimately differ by whatever
    # arrived between them. The first version of this test compared them raw and
    # failed on exactly that — `only_in_plain` EMPTY, `only_in_lite` carrying
    # five pairs that all landed mid-test. The second version retried until two
    # reads agreed, and simply never did: Hive is busy enough that the test
    # SKIPPED every run. A gate that cannot run is this project's signature
    # defect and must not be added by the fix for one.
    #
    # So: compare only the SETTLED part of the window — pairs whose most recent
    # interaction predates the test itself. Anything arriving during the test
    # necessarily carries a newer timestamp and drops out of both sides.
    settled_before = datetime.now(UTC) - timedelta(minutes=15)

    def settled(client: hafsql.HafsqlClient) -> dict[tuple[str, str], tuple[int, int, int]]:
        return {
            (e.src, e.dst): (e.upvotes, e.replies, e.reblogs)
            for e in client.engagement_edges(since)
            if e.last_interaction is not None and e.last_interaction <= settled_before
        }

    a = settled(plain)
    b = settled(with_lite)
    assert len(a) > 100, f"only {len(a)} settled edges — window or mirror problem, not a verdict"

    # ★★ THIRD ITERATION OF THIS COMPARISON, and the reason is worth recording.
    # v1 compared the two reads raw and failed on mirror drift. v2 retried until
    # two plain reads agreed and SKIPPED every run, because Hive never settles.
    # v3 compared only edges whose last interaction predates the test — which is
    # stable when run alone (3/3) and in its own file (4/4) but STILL failed
    # intermittently in the full live suite, because a pair that receives NEW
    # engagement between the two reads moves OUT of the settled window for the
    # second one. The set is stable; membership of it is not.
    #
    # So the assertion is now on the SHARED pairs — where a real divergence
    # would show as a count mismatch — plus a bound on how much churn is
    # tolerated. A systematic difference (the lite branch dropping or
    # duplicating edges) fails; a handful of pairs aging across the boundary
    # mid-test does not. A gate that cries wolf on a live chain gets ignored,
    # which is worse than not having it.
    # ★ WHAT THIS TEST CANNOT DO, measured rather than assumed: corrupting the
    # lite branch outright (every destination replaced with a constant) is NOT
    # caught here, because no Hive account has ever engaged a lite post, so that
    # branch emits ZERO rows against live data. Its semantics are covered by
    # `tests/test_hafsql.py::test_only_a_publishers_post_may_redirect_its_engagement`,
    # which supplies its own rows via a CTE and DOES catch that mutant. This
    # test's job is narrower and worth stating: the SQL executes against the
    # real schema, and the plain branch is unperturbed.
    shared = set(a) & set(b)
    mismatched = {key: (a[key], b[key]) for key in shared if a[key] != b[key]}
    assert not mismatched, (
        f"the lite branch changed {len(mismatched)} edges it must not touch: "
        f"{dict(list(mismatched.items())[:5])}"
    )
    churn = len(set(a) ^ set(b))
    assert churn <= max(5, len(a) // 100), (
        f"{churn} of {len(a)} edge pairs differ between the two reads — that is "
        f"more than live drift explains. only_in_plain="
        f"{sorted(set(a) - set(b))[:5]} only_in_lite={sorted(set(b) - set(a))[:5]}"
    )
