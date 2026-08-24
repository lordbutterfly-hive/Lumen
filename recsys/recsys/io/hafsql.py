"""HAFSQL/Postgres gateway (§S7, Appendix B) — the only module that talks to a
database. Importing this module must never require ``psycopg``; the driver is
imported lazily inside :meth:`HafsqlClient._connect` so the pure scoring core
stays importable without the ``io`` extra installed. Live queries run against
the public mirror ``hafsql-sql.mahdiyari.info`` and were verified 2026-08-04
against the real mirror (see ``tests/test_hafsql_live.py``).

★ A15 — a SECOND, optional connection. ``network_suppression`` (§8.7) is
recsys's own table (``recsys/db/schema.sql``); it lives in recsys's own
Postgres, not the read-only HAFSQL mirror, and the mirror creds cannot create
it or cross-database-join into it (no ``dblink``/FDW available to
``hafsql_public``). Per BUILD-ADJUDICATION-2026-08-04 ruling R9 / A15 option 1,
``HafsqlClient`` therefore holds a second, OPTIONAL DSN
(``RECSYS_DATABASE_URL``, or the ``recsys_dsn`` constructor kwarg) for the
recsys DB. ``suppressed_keys`` queries it directly; ``author_engagement``'s
flooding guard (H05) does a SECOND ROUND TRIP — fetch this window's suppressed
keys from the recsys DB, then anti-join them into the mirror query via a bound
``unnest`` array, since a single cross-database SQL join is not possible. If
the DSN is absent (unset), suppression degrades to "nothing suppressed" with a
loud, one-time WARNING — never a crash. ``recsys/config.py`` is owned by
another workstream this phase, so there is no ``RecsysDbConfig`` yet; when one
lands, thread its DSN through the ``recsys_dsn`` kwarg here rather than
changing this module again.

★ A5 — ``window_posts``. The missing NormContext sample source: no gateway
method previously returned "all posts in a window" without an
engagement-ordering bias (``popular_posts`` is ``ORDER BY engagement DESC``,
which would push every real score toward the bottom of the percentile range —
see ``_SQL_WINDOW_POSTS``).

★ A11 — the author-pooled engagement prior (``_SQL_AUTHOR_ENGAGEMENT``) now
matches and groups on ``_identity(c)`` (the ranked identity — the lite writer
where present, else the chain author) instead of the bare chain ``c.author``,
so a Lumen Lite author's prior is no longer structurally empty. The internal
exclusion anti-join (``e.author = c.author``) and the vote/comment/reblog join
keys are UNCHANGED — those correctly stay on the chain identity, since votes
are only ever recorded against the on-chain publisher account.

★ A12 — ``second_degree_engagers``/``suppressed_keys`` accept an optional
``chain_authors`` map (``Post.key -> chain_author``, build with
``chain_author_map``) so a lite post's RANKED key resolves to the CHAIN
identity for the query while the result stays keyed on the ranked identity —
see ``_resolve_post_keys``.

★ A13 — the lite publisher account list, absent a ``LiteConfig.from_env`` in
``recsys/config.py`` (owned by another workstream this phase — see the A15 DSN
note above for the identical situation), is read straight from the
environment as a fallback when ``HafsqlClient`` is constructed with no
explicit ``lite=`` — see ``_lite_config_from_env``.

★★★ G5 (2026-08-10) — SELF-EXCLUSION RESOLVES THE COMMENTER, NOT JUST THE
POSTER. ``_POPULAR_ENGAGEMENT`` and ``_SQL_COMMENTS_FOR_POSTS`` excluded
self-engagement on the CHAIN identity (``rc.author <> c.author``). Every lite
writer publishes through one shared publisher account, so a lite post and every
lite reply to it are all ``hbd-temp``: the rule read them as one person talking
to themselves and discarded them, and a post popular purely inside Lumen could
not reach the popularity lane at all. Both queries now resolve the commenter
through :func:`_engager_identity` — the same substitution :func:`_identity`
already made on the POST side, under the same ``publisher_accounts`` trust gate
— and compare resolved identity against resolved identity. Rebloggers are
deliberately untouched: ``hafsql.reblogs`` carries no ``json_metadata``, so
there is no attribution to resolve (see ``_POPULAR_ENGAGEMENT``'s note).

★★★ PERF — ``author_engagement`` (``_SQL_AUTHOR_ENGAGEMENT``) is
``pipeline._author_priors``'s hot path (every request, 80% of the composite
score). Live-measured to time out (>15s, up to 58s containerised) against a
real well-followed account. Rewritten 2026-08-04 to remove two proven-live
cost drivers (a non-sargable row filter forcing a network-wide scan, and an
unnecessary ``hafd.blocks`` join hidden inside two HAFSQL views) — see the
long comment directly above ``_SQL_AUTHOR_ENGAGEMENT`` for the EXPLAIN
findings, before/after numbers, and the residual STRUCTURAL finding (a
high-post-volume candidate set still exceeds the timeout after the rewrite;
this remains a request-path cache/architecture question for whoever owns
``recsys/pipeline.py``, not a query-shape one).
"""

from __future__ import annotations

import contextlib
import logging
import math
import os
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from recsys.config import (
    LITE_FRONTEND_ACCOUNT_ENVS,
    LITE_PUBLISHER_ACCOUNTS_ENV,
    HafsqlConfig,
    LiteConfig,
    PopularConfig,
)
from recsys.contracts import Candidate, CandidateSource, EngagementEdge, Post, Vote
from recsys.core.scoring import AuthorEngagement
from recsys.core.vote_signal import (
    _ORGANIC_VOTER_MIN_RSHARES,
    AttributedPost,
    VoterTrust,
)

# ★★★ THE FLOOR IS IMPORTED, NOT RETYPED (2026-08-08). Both queries below
# used to hardcode `10000000`, with a comment claiming they "mirror
# recsys.core.vote_signal._ORGANIC_VOTER_MIN_RSHARES". They stopped
# mirroring it the moment that constant moved 1e7 -> 3.184e9 (0.31 HP -> 100
# HP) on 2026-08-08, and nothing anywhere cross-checked the two.
#
# WHY THAT IS NOT COSMETIC. `_SQL_AUTHOR_ENGAGEMENT` computes
# `AuthorEngagement.total_base`, and `scoring.pooled_author_base` subtracts
# the post's OWN base — computed in PYTHON, at the new floor — from it:
# `loo = (total_base - own_base) / others`. With SQL counting voters above
# 1e7 and Python counting voters above 3.184e9, `own_base` shrinks while
# `total_base` does not, so the leave-one-out mean is inflated for every
# author on every request — and `pooled_author_base`'s clamp only guards the
# NEGATIVE direction, so nothing catches it. The author-pooled prior is the
# quality percentile, which is 80% of the composite.
#
# Interpolated as an integer literal: Postgres would take `3.184e+09` as a
# float and the comparison would still work, but a float literal in a
# hot-path predicate invites a cast that defeats the index on `rshares`.
_VOTER_MIN_RSHARES_SQL = f"{_ORGANIC_VOTER_MIN_RSHARES:.0f}"

if TYPE_CHECKING:
    import psycopg

logger = logging.getLogger("recsys.io.hafsql")

# A15: the recsys DB's own DSN. Absent by default (no ``RecsysDbConfig`` exists
# yet in ``recsys/config.py`` — see the module docstring); read straight from
# the environment so this module needs no change once that config lands.
_RECSYS_DSN_ENV = "RECSYS_DATABASE_URL"

# A13: the lite publisher account list, read the same way as _RECSYS_DSN_ENV
# above (no ``LiteConfig.from_env`` exists yet in ``recsys/config.py`` — see
# the module docstring). Two sources, both consulted:
#
#   1. ``LITE_PUBLISHER_ACCOUNTS`` — a comma-separated list, for an operator
#      who wants to name the account(s) explicitly on the recsys side.
#   2. The FRONTEND's own env vars (``frontend/apps/blog/lib/lite/config.ts``):
#      ``LITE_FRONTEND_ACCOUNT_{MAINNET,MIRRORNET,TESTNET}`` — the single
#      Hive account that is the on-chain author for every proxy post, one per
#      network. Reading the SAME names here (rather than inventing a
#      recsys-only one) is the whole point of A13: one source of truth, no
#      value to keep in sync by hand.
#
# This process has no network selector of its own — ``HafsqlConfig`` talks to
# exactly one HAFSQL mirror — so all three frontend vars are read and every
# non-empty one is folded in; ``publisher_accounts`` is a SET, so a deploy
# that exports more than one network's var by accident gains an inert extra
# trust entry, never loses the one it needed.
# ★ Re-exported from `recsys.config`, which is now the single resolver
# (`LiteConfig.from_env`). Kept as module names so this file's own docstrings
# and tests keep working.
_LITE_PUBLISHER_ACCOUNTS_ENV = LITE_PUBLISHER_ACCOUNTS_ENV
_LITE_FRONTEND_ACCOUNT_ENVS: tuple[str, ...] = LITE_FRONTEND_ACCOUNT_ENVS


def _lite_config_from_env() -> LiteConfig:
    """A13: build a :class:`LiteConfig` from the environment.

    ★ Now a thin delegation to :meth:`LiteConfig.from_env` (2026-08-05). It used
    to own a second copy of the publisher-resolution rules and knew nothing
    about the engagement DSN, so `LUMEN_LITE_DATABASE_URL` was read nowhere and
    L2 could never switch on. Two env readers that can disagree is how a config
    path rots; there is one now.

    Absent every source -> the empty frozenset -> lite OFF, identical to
    ``LiteConfig()``'s own default (pinned by
    ``test_lite_sourcing_is_OFF_until_publishers_are_named``); this function is
    a FALLBACK consulted only when ``HafsqlClient`` is constructed with no
    explicit ``lite=`` argument, never a change to that default itself."""
    return LiteConfig.from_env()

# A4: connection-pool / operational-hardening tunables. Kept as env-read
# defaults (not ``HafsqlConfig`` fields — that file is owned by another
# workstream this phase) so ``HafsqlClient`` can be constructed with sane
# behaviour today and re-wired to real config fields later with no interface
# change; every one is also an explicit constructor kwarg.
_ENV_DEFAULTS: dict[str, str] = {
    "HAFSQL_POOL_MIN": "1",
    "HAFSQL_POOL_MAX": "5",
    "HAFSQL_STATEMENT_TIMEOUT_MS": "15000",
    "HAFSQL_MAX_RETRIES": "3",
    "HAFSQL_RETRY_BACKOFF_S": "0.2",
    "HAFSQL_BREAKER_THRESHOLD": "5",
    "HAFSQL_BREAKER_COOLDOWN_S": "30",
    # B4b (2026-08-05). How long `borrow()` will WAIT for a pool slot before
    # giving up. Before this existed there was no waiting and no bound at all —
    # `borrow()` opened a fresh physical connection whenever the idle list was
    # empty, so N concurrent requests opened N connections to a SHARED
    # third-party mirror (measured: 50 -> 50). Timing out is the correct
    # failure: it surfaces as the same `HafsqlUnavailableError` -> 503 an
    # operator already handles, instead of silently exhausting someone else's
    # database and getting the deployment banned.
    "HAFSQL_POOL_ACQUIRE_TIMEOUT_S": "10",
    "RECSYS_DB_POOL_MIN": "1",
    "RECSYS_DB_POOL_MAX": "3",
    "HAFSQL_POPULAR_CACHE_TTL_S": "300",
}


def _env_int(name: str) -> int:
    return int(os.environ.get(name, _ENV_DEFAULTS[name]))


def _env_float(name: str) -> float:
    return float(os.environ.get(name, _ENV_DEFAULTS[name]))


class HafsqlUnavailableError(RuntimeError):
    """Raised when the circuit breaker (ruling R7) is open: too many
    consecutive CONNECTION failures in a row. Fails the request loudly and
    immediately rather than hanging through another round of retries against a
    database that is provably down."""


def _as_aware(ts: datetime) -> datetime:
    """HAFSQL break #8: several timestamp columns
    (``operation_effective_comment_vote_view.timestamp``,
    ``reblogs.created_at``) are Postgres ``timestamp WITHOUT time zone`` and
    come back from psycopg as naive ``datetime``s even though the session
    timezone is UTC (verified live 2026-08-04). Every consumer downstream
    compares against a tz-aware ``now`` (``pipeline.py:293``, ``graph_cred.py:
    125``, ``ring.py:58``, ``als.py:127``) — a naive/aware subtraction raises
    ``TypeError``. Coerce once, at the boundary, rather than trusting every
    caller to remember. Takes a required (non-``None``) value; callers that
    may see ``None`` (no interaction of that kind) check it themselves."""
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)

# Reputation display formula (Appendix B: "the reputation-int->display constant
# 9*log10(raw)-56"; CombFlow documents a past bug from getting this wrong).
# Equivalent to hivemind's `(max(log10(|raw|) - 9, 0)) * 9 + 25`, signed.
_REP_LOG_FLOOR = 9.0
_REP_SCALE = 9.0
_REP_BASE = 25.0

# author, permlink, category, created, tags, lite_author
# ``lite_author`` is `json_metadata->>'lumen_user_id'` and is NULL for every
# ordinary Hive post. It is trusted only because the SQL that selects it also
# requires the chain author to be a configured Lumen publisher — see
# `_LITE_POST` and `LiteConfig`.
_PostRow = tuple[str, str, str, datetime, "list[str] | None", "str | None"]

# A Lumen Lite post: a depth-1 comment published by a configured publisher
# account under its own container, carrying the writer's id in json_metadata.
# Both the author AND the parent must be publishers — json_metadata is
# attacker-controlled, so the claim is only honoured inside our own containers.
# With `lite_publishers` empty, `= ANY('{}')` is false and lite sourcing is off.
_LITE_POST = """(
    {t}author = ANY(%(lite_publishers)s)
    AND {t}parent_author = ANY(%(lite_publishers)s)
    AND {t}json_metadata->>'app' = %(lite_app)s
    AND {t}json_metadata->>'lumen_user_id' IS NOT NULL
)"""


def _top_level_or_lite(alias: str = "") -> str:
    """`parent_author = ''` widened to also admit our own lite posts."""
    t = f"{alias}." if alias else ""
    return f"({t}parent_author = '' OR {_LITE_POST.format(t=t)})"


def _identity(alias: str = "") -> str:
    """The author identity RANKING uses: the lite writer where present, else the
    chain author.

    ★ THE ROW LOOKUP still keys on the chain author — votes, comments and
    reblogs are all stored on chain against the publisher account + permlink, so
    `(author, permlink)` is what any hydration query must join on. What is
    substituted is every IDENTITY the ranker compares or counts: the post's
    author here, and (G5, 2026-08-10) the COMMENTER on the other side of a
    self-exclusion — see :func:`_engager_identity`. The pre-G5 wording of this
    docstring ("hydration still keys on the chain author") was read as "so
    hydration never resolves an identity", which is how the self-exclusion below
    ended up comparing a lite writer against the shared publisher account."""
    t = f"{alias}." if alias else ""
    return f"COALESCE({t}json_metadata->>'lumen_user_id', {t}author)"


#: ★★★ G1 — A LITE IDENTITY MAY NOT LOOK LIKE A HIVE ACCOUNT (2026-08-10).
#:
#: THE RISK. `_engager_identity` substitutes a string taken out of
#: `json_metadata` for an account name, and that string then keys engagement.
#: If it could equal a REAL Hive account's name, engagement would pool into that
#: account — someone else's `total_base`, someone else's ranked identity, spam
#: filed under `@blocktrades/…`. Nothing downstream can tell the two apart.
#:
#: WHAT THE FRONTEND ACTUALLY DOES, checked before writing this rather than
#: assumed (`frontend/apps/blog/lib/lite/`):
#:   * `publisher/footer.ts:23` writes `lumen_user_id: p.userId`, and `userId`
#:     is the row's `lumen_user.user_id` — a server-minted ULID from `ids.ts`
#:     (26 chars, UPPERCASE Crockford base32, `crypto.randomBytes` entropy). It
#:     is NEVER user-chosen, so the name a signup picks does not reach this key
#:     at all. Verified against 210 live rows: every one matches that shape.
#:   * The chosen DISPLAY name is separately checked against Hive's namespace at
#:     signup completion — `auth/auth-service.ts:221-235` refuses `exists` and
#:     FAILS CLOSED on `api_error` — plus format/reserved-term vetting in
#:     `names/vetting.ts`.
#: So the collision is not reachable through the signup flow today.
#:
#: WHY THE CHECK IS HERE ANYWAY. "Not reachable today" is a property of another
#: repo's code that recsys does not verify and cannot see change. This turns it
#: into an invariant recsys enforces itself, and it costs one regex over a
#: publisher-authored row. It also bounds the damage of a compromised publisher
#: key: that key can still publish, but it cannot make its output rank as
#: someone else's account.
#:
#: THE ENVELOPE, not the exact grammar. Every valid Hive account name is 3-16
#: characters of lowercase letters/digits/dots/dashes starting with a letter, so
#: this pattern matches a SUPERSET of the Hive namespace. Rejecting a superset is
#: the safe direction — some strings that are not valid Hive names are refused
#: too, and refusal means "fall back to the chain author", i.e. the pre-G5
#: behaviour, never a spoof. A 26-character uppercase ULID cannot match.
_HIVE_NAME_ENVELOPE = "^[a-z][a-z0-9.-]{2,15}$"


def _engager_identity(alias: str = "") -> str:
    """The identity of whoever ENGAGED (commented), resolved the same way
    :func:`_identity` resolves the identity of whoever POSTED.

    ★★★ G5 (2026-08-10, owner's rule: *"every lite post AND every lite comment
    carries its author's attribution inside the post itself — you rank off
    that, that is your separator"*).

    THE DEFECT THIS CLOSES. Self-engagement was excluded with a bare
    `rc.author <> c.author`, i.e. on CHAIN identity. Every lite writer publishes
    through ONE shared publisher account, so a lite post and every lite reply to
    it are all `hbd-temp` and the rule read them as one person talking to
    themselves. Measured against the real mirror before the fix, on real
    mainnet rows: `hbd-temp/lumen-01kzcp8a6p9eyaa5h0qp9vxf4y` (writer
    `01KZCNA1SFDK4VZ8MZNTK190Z9`) carries one on-chain reply from a DIFFERENT
    lite writer (`01KZCNB1W1VHCJ6W1NGJMGHHFW`) and `_POPULAR_ENGAGEMENT`
    returned **0.0**; `_SQL_COMMENTS_FOR_POSTS` returned **zero rows**. A post
    popular purely inside Lumen could not reach the popularity lane at all.

    ★★★ THE TRUST GATE IS KEPT, AND IT IS NOT THE SAME PREDICATE AS
    `_LITE_POST`. `json_metadata` is attacker-controlled, so the embedded claim
    is honoured ONLY when the chain author is a configured publisher account
    (`LiteConfig`'s boundary, `recsys/config.py`) — this is STRICTLY NARROWER
    than :func:`_identity`'s bare COALESCE, never wider. What it deliberately
    does NOT require is `parent_author` also being a publisher, which
    `_LITE_POST` does: that condition identifies a lite POST (a child of one of
    our own containers), and a lite COMMENT's parent is whatever it replied to —
    a real Hive post more often than not (15 of the 17 lite replies on mainnet
    today). Requiring it would leave the resolution inert in exactly the case
    lite users engage with Hive content. The gate that matters is unchanged:
    only OUR account can author a row whose `author` is OUR account.

    ★★★ AND THE NAMESPACE CHECK (G1's other half — see
    :data:`_HIVE_NAME_ENVELOPE`). A claimed identity that COULD be a real Hive
    account name is refused and the row falls back to its chain author.

    With no publishers configured (`lite_publishers = '{}'`), `= ANY('{}')` is
    false for every row, the CASE always falls through to `{t}author`, and this
    is byte-for-byte the pre-G5 chain identity."""
    t = f"{alias}." if alias else ""
    return f"""CASE WHEN {t}author = ANY(%(lite_publishers)s)
                     AND {t}json_metadata->>'app' = %(lite_app)s
                     AND {t}json_metadata->>'lumen_user_id' IS NOT NULL
                     AND {t}json_metadata->>'lumen_user_id' !~ '{_HIVE_NAME_ENVELOPE}'
                THEN {t}json_metadata->>'lumen_user_id'
                ELSE {t}author END"""

#: The permlink prefix of one of OUR OWN rolling containers. Imported from
#: `PopularConfig` rather than retyped, so the SQL that identifies a container
#: child and `recsys.core.popular.is_container_post` (which drops containers
#: from the lane) can never disagree about what a container is —
#: `test_container_prefix_is_the_one_popular_config_declares` fails if they
#: drift. Read off the DEFAULT instance deliberately: `HafsqlClient` is not
#: given a `PopularConfig` (threading a whole config through for one string is a
#: larger interface change than the drift it would prevent), and the prefix is a
#: fact about what the publisher writes on chain (`publisher/permlink.ts`,
#: `publisher/container.ts`), not a per-deploy tunable.
_LITE_CONTAINER_PREFIX = PopularConfig().lumen_container_prefix

# ★★★ A LITE POST IS NOT A COMMENT ON ITS CONTAINER (G4/G5, 2026-08-10).
#
# A lite post is stored on chain as a depth-1 comment under one of our rolling
# containers, so a naive comment count credits the whole Lite tier's output to
# the container. This predicate is what identifies such a row, and it is defined
# ONCE and used TWICE — `_SQL_COMMENTS_FOR_POSTS` (hydration) and
# `_POPULAR_ENGAGEMENT` (recall) — because those two layers disagreeing about
# what counts as a comment is precisely the class of defect this module keeps
# hitting.
#
# ★ THE CONTAINER-PREFIX TEST IS LOAD-BEARING, AND IS NEW (2026-08-10). Before
# G5 this predicate stopped at "author AND parent_author are both publishers",
# which is ALSO true of a lite reply to a lite post — both sides are the shared
# publisher account. So every cross-lite reply was discarded as if it were a
# lite post being miscounted as a comment: on the real mirror,
# `_SQL_COMMENTS_FOR_POSTS` returned ZERO rows for
# `hbd-temp/lumen-01kzcp8a6p9eyaa5h0qp9vxf4y`, which has exactly one such reply.
# The parent's permlink is what separates the two: a lite POST's parent is a
# container (`lumen-c-<ulid>`), a lite REPLY's parent is a post
# (`lumen-<ulid>`). Verified on chain 2026-08-10: 74 container children, 2
# cross-lite replies, 15 replies to ordinary Hive posts.
#
# COALESCE is load-bearing for a reason unrelated to any of the above:
# `json_metadata` is NULL on plenty of ordinary comments, `NULL->>'app'` is
# NULL, and `NOT NULL` is NULL — which Postgres treats as not-true and FILTERS
# THE ROW OUT. Without it, enabling lite would silently drop a publisher's own
# metadata-less comments from every comment count. Three-valued logic, failing
# toward data loss.
_LITE_CONTAINER_CHILD = """COALESCE(
    {t}author = ANY(%(lite_publishers)s)
    AND {t}parent_author = ANY(%(lite_publishers)s)
    AND {t}json_metadata->>'app' = %(lite_app)s
    AND starts_with({t}parent_permlink, %(lite_container_prefix)s)
  , false)"""

# H05: with no trust snapshot, the breadth budget in _SQL_AUTHOR_ENGAGEMENT
# must never bind — an effectively-infinite unknown_free reproduces the
# pre-H05 raw-distinct-count query for the honest Phase-0 no-snapshot default.
_UNBUDGETED_UNKNOWN_FREE = 1e18

# ---------------------------------------------------------------------------
# SQL — post listings (hafsql.comments; parent_author == '' is a top-level
# post, §3.0; community == category for community-filed posts, on-chain).
# ---------------------------------------------------------------------------

_SQL_IN_NETWORK_POSTS = f"""
SELECT author, permlink, category, created, tags,
       json_metadata->>'lumen_user_id'
FROM hafsql.comments
WHERE {_top_level_or_lite()}
  AND deleted = false
  AND {_identity()} = ANY(%(authors)s)
  AND created >= %(since)s
ORDER BY created DESC
LIMIT %(limit)s
"""

_SQL_TAG_POSTS = f"""
SELECT author, permlink, category, created, tags,
       json_metadata->>'lumen_user_id'
FROM hafsql.comments
WHERE {_top_level_or_lite()}
  AND deleted = false
  -- break #3 (verified live 2026-08-04): `hafsql.comments.tags` is `jsonb`,
  -- not `text[]` — `&&` has no jsonb overload. `?|` (jsonb "any of these keys
  -- exist") is the jsonb equivalent of array overlap for a flat string array.
  AND tags ?| %(tags)s::text[]
  AND created >= %(since)s
ORDER BY created DESC
LIMIT %(limit)s
"""

# Out-of-network posts an in-network account engaged with (vote, reblog, or
# reply) — the raw pool for the second-degree gate (§8.1).
_SQL_ENGAGED_OON_POSTS = f"""
SELECT DISTINCT c.author, c.permlink, c.category, c.created, c.tags,
       c.json_metadata->>'lumen_user_id'
FROM hafsql.comments c
WHERE {_top_level_or_lite("c")}
  AND c.deleted = false
  AND {_identity("c")} <> ALL(%(follows)s)
  AND c.created >= %(since)s
  AND (
    EXISTS (
        SELECT 1 FROM hafsql.operation_effective_comment_vote_view v
        WHERE v.author = c.author AND v.permlink = c.permlink
          AND v.voter = ANY(%(follows)s)
          AND v.rshares > 0  -- a DOWNVOTE must not vouch an OON post into the feed
    )
    OR EXISTS (
        SELECT 1 FROM hafsql.reblogs r
        WHERE r.author = c.author AND r.permlink = c.permlink
          AND r.account_name = ANY(%(follows)s)
    )
    OR EXISTS (
        SELECT 1 FROM hafsql.operation_comment_view rc
        WHERE rc.parent_author = c.author AND rc.parent_permlink = c.permlink
          AND rc.author = ANY(%(follows)s)
    )
  )
ORDER BY c.created DESC
LIMIT %(limit)s
"""

# ---------------------------------------------------------------------------
# SQL — per-post hydration, batched over a page of (author, permlink) keys via
# a parallel-array unnest join (no per-row round trips, no f-string values).
# ---------------------------------------------------------------------------

_SQL_VOTES_FOR_POSTS = """
SELECT v.author, v.permlink, v.voter, v.rshares, v.timestamp
FROM hafsql.operation_effective_comment_vote_view v
WHERE (v.author, v.permlink) IN (
    SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
)
"""

# Per-commenter attribution (§6): WHO commented and how many times — not a
# bare count. The commenter identity is the one the organic term filters through
# the same exclusion set as votes; summing the per-commenter counts recovers
# the display comment total, so one grouped query serves both.
#
# ★★★ G5 (2026-08-10): the commenter is the RESOLVED identity
# (`_engager_identity`) — the lite writer named inside the comment where the
# chain author is one of our publishers, else the chain author, byte-identical
# to the old `rc.author` for every ordinary Hive comment and whenever no
# publisher is configured. Before this, every lite writer's comment arrived as
# the single name `hbd-temp`, so five lite users discussing a post hydrated as
# ONE commenter and `select_popular`'s crowd terms (`credited_breadth` and the
# log spread) both saw a crowd of one.
#
# The inner SELECT exists only so the resolution is written once instead of
# being repeated verbatim in the GROUP BY; Postgres flattens it.
_SQL_COMMENTS_FOR_POSTS = f"""
SELECT parent_author, parent_permlink, commenter, COUNT(*)
FROM (
  SELECT rc.parent_author, rc.parent_permlink,
         {_engager_identity("rc")} AS commenter
  FROM hafsql.operation_comment_view rc
  WHERE rc.parent_author <> ''
    -- A lite post is a POST that happens to be stored as a comment; counting it
    -- here credited every lite writer's work to the container's owner. A lite
    -- REPLY is not that and must survive — see `_LITE_CONTAINER_CHILD` for why
    -- the container-prefix test is what separates them, and for why the
    -- COALESCE is load-bearing.
    AND NOT {_LITE_CONTAINER_CHILD.format(t="rc.")}
    AND (rc.parent_author, rc.parent_permlink) IN (
      SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
    )
) attributed
GROUP BY parent_author, parent_permlink, commenter
"""

# Per-reblogger attribution (§6): DISTINCT identities, same rationale.
_SQL_REBLOGGERS_FOR_POSTS = """
SELECT DISTINCT r.author, r.permlink, r.account_name
FROM hafsql.reblogs r
WHERE (r.author, r.permlink) IN (
    SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
)
"""

_SQL_REPUTATIONS_FOR_AUTHORS = """
SELECT account_name, reputation
FROM hafsql.reputations
WHERE account_name = ANY(%(authors)s)
"""

# ---------------------------------------------------------------------------
# SQL — RealGraph engagement edges (§8.3). Mentions and client-side telemetry
# (profile visits, post opens, revisits, dwell) are Phase-1 signals with no
# HAFSQL source and are left at their zero defaults here.
# ---------------------------------------------------------------------------

_SQL_REPLY_EDGES = """
SELECT author, parent_author, COUNT(*), MAX(timestamp)
FROM hafsql.operation_comment_view
WHERE parent_author <> ''
  AND author <> parent_author
  -- break #6 (verified live 2026-08-04, kills the whole weekly trust batch):
  -- `hafsql.operation_comment_view` has no `created` column at all — it is
  -- `timestamp` (`timestamp WITHOUT time zone`; naive, hence _as_aware below).
  AND timestamp >= %(since)s
    AND timestamp < %(until)s
GROUP BY author, parent_author
"""

_SQL_UPVOTE_EDGES = """
SELECT voter, author, COUNT(*), MAX(timestamp)
FROM hafsql.operation_effective_comment_vote_view
WHERE rshares > 0
  AND voter <> author
  AND timestamp >= %(since)s
    AND timestamp < %(until)s
GROUP BY voter, author
"""

# ---------------------------------------------------------------------------
# ★★★ L1 (2026-08-05) — EDGE DESTINATIONS RESOLVE TO THE LITE WRITER.
#
# THE BUG. The three queries above take the DESTINATION of every engagement
# edge from the raw on-chain `author`/`parent_author` column. A lite post is
# published by a shared PUBLISHER account with the writer's id in
# `json_metadata->>'lumen_user_id'`, so every upvote, reply and reblog aimed at
# a lite writer was credited to the publisher instead. Consequences, all
# following from that one substitution being absent:
#
#   * `graph_creds` never contained an entry keyed by a lite identity, so a
#     lite writer could NEVER be vouched, could never leave the unknown tier,
#     and was permanently ineligible for anything gated on trust.
#   * A lite sock ring was invisible to ring detection for the same reason —
#     every one of its edges pointed at the publisher, not at its members.
#   * The publisher account accrued the graph-cred of EVERY lite writer
#     combined: an accidental trust supernode that grows with adoption. Live
#     check 2026-08-05: 10 lite posts on mainnet, 9 distinct writers, ONE
#     publisher (`hbd-temp`) — small today, which is exactly why this is
#     cheaper to fix now than after volume.
#
# `_identity()` (above) already exists for precisely this substitution and is
# already used for post SOURCING; only these edge queries never called it. Its
# docstring's "hydration still keys on the chain author" was right about vote
# ROWS and wrong as a conclusion about edge ENDPOINTS.
#
# SCOPE, deliberately: DESTINATION only. The SOURCE stays the on-chain account.
# Resolving sources belongs to L2 and is NOT symmetric with this — inbound
# engagement is paid for in RC and stake by a real Hive account, while a lite
# user's own engagement is free (`lumen_vote`, off chain), so crediting it at
# face value would be a free vouch printer. See, under
# `/mnt/o/LUMEN-DOCS/algo-tests/COUNCIL-2026-08-05-POSTCLOSEOUT/`,
# `SCOPE-LITE-ENGAGEMENT-SIGNAL-2026-08-05.md`.
#
# SHAPE: a UNION of the plain branch (rows NOT authored by a publisher, byte
# for byte the predicate above) and a lite branch (publisher-authored rows,
# joined to the post for its metadata). The plain query above is still used
# verbatim when no publishers are configured, so a non-lite deploy pays nothing
# and keeps its measured plan. The lite branch is bounded by `lite_publishers`,
# a set of one account in practice.
#
# Self-engagement stays excluded by the UNRESOLVED `voter <> author` predicate,
# which is the correct test: a publisher voting a post it published is caught
# there before resolution, and a lite user cannot vote on chain at all.
# ---------------------------------------------------------------------------

_SQL_UPVOTE_EDGES_WITH_LITE = """
WITH lite AS MATERIALIZED (
    -- Every post authored by a lite publisher, with the writer's id where the
    -- provenance check passes. Bounded by the number of lite posts (10 on
    -- mainnet today), and MATERIALIZED deliberately: inlined, Postgres pushes
    -- this into the join and the reblog variant measured **197.6s** for a
    -- 6-hour window against **0.0s** materialised. The weekly trust batch runs
    -- a 365-day window.
    -- Publisher posts that are NOT lite (or carry no writer id) are still
    -- included, with a NULL `uid`, so the COALESCE below resolves them back to
    -- the publisher rather than the row being dropped by a non-matching join.
    SELECT author, permlink,
           CASE WHEN json_metadata->>'app' = %(lite_app)s
                THEN json_metadata->>'lumen_user_id' END AS uid
    FROM hafsql.comments
    WHERE author = ANY(%(lite_publishers)s)
)
SELECT voter, dst, COUNT(*), MAX(ts) FROM (
    SELECT v.voter AS voter, v.author AS dst, v.timestamp AS ts
    FROM hafsql.operation_effective_comment_vote_view v
    WHERE v.rshares > 0
      AND v.voter <> v.author
      AND v.timestamp >= %(since)s
    AND v.timestamp < %(until)s
      AND NOT (v.author = ANY(%(lite_publishers)s))
    UNION ALL
    SELECT v.voter AS voter, COALESCE(l.uid, v.author) AS dst, v.timestamp AS ts
    FROM hafsql.operation_effective_comment_vote_view v
    JOIN lite l ON l.author = v.author AND l.permlink = v.permlink
    WHERE v.rshares > 0
      AND v.voter <> v.author
      AND v.timestamp >= %(since)s
    AND v.timestamp < %(until)s
) e
GROUP BY voter, dst
"""

_SQL_REPLY_EDGES_WITH_LITE = """
WITH lite AS MATERIALIZED (
    -- Every post authored by a lite publisher, with the writer's id where the
    -- provenance check passes. Bounded by the number of lite posts (10 on
    -- mainnet today), and MATERIALIZED deliberately: inlined, Postgres pushes
    -- this into the join and the reblog variant measured **197.6s** for a
    -- 6-hour window against **0.0s** materialised. The weekly trust batch runs
    -- a 365-day window.
    -- Publisher posts that are NOT lite (or carry no writer id) are still
    -- included, with a NULL `uid`, so the COALESCE below resolves them back to
    -- the publisher rather than the row being dropped by a non-matching join.
    SELECT author, permlink,
           CASE WHEN json_metadata->>'app' = %(lite_app)s
                THEN json_metadata->>'lumen_user_id' END AS uid
    FROM hafsql.comments
    WHERE author = ANY(%(lite_publishers)s)
)
SELECT src, dst, COUNT(*), MAX(ts) FROM (
    SELECT r.author AS src, r.parent_author AS dst, r.timestamp AS ts
    FROM hafsql.operation_comment_view r
    WHERE r.parent_author <> ''
      AND r.author <> r.parent_author
      AND r.timestamp >= %(since)s
    AND r.timestamp < %(until)s
      AND NOT (r.parent_author = ANY(%(lite_publishers)s))
    UNION ALL
    SELECT r.author AS src, COALESCE(l.uid, r.parent_author) AS dst, r.timestamp AS ts
    FROM hafsql.operation_comment_view r
    JOIN lite l ON l.author = r.parent_author AND l.permlink = r.parent_permlink
    WHERE r.parent_author <> ''
      AND r.author <> r.parent_author
      AND r.timestamp >= %(since)s
    AND r.timestamp < %(until)s
) e
GROUP BY src, dst
"""

_SQL_REBLOG_EDGES_WITH_LITE = """
WITH lite AS MATERIALIZED (
    -- Every post authored by a lite publisher, with the writer's id where the
    -- provenance check passes. Bounded by the number of lite posts (10 on
    -- mainnet today), and MATERIALIZED deliberately: inlined, Postgres pushes
    -- this into the join and the reblog variant measured **197.6s** for a
    -- 6-hour window against **0.0s** materialised. The weekly trust batch runs
    -- a 365-day window.
    -- Publisher posts that are NOT lite (or carry no writer id) are still
    -- included, with a NULL `uid`, so the COALESCE below resolves them back to
    -- the publisher rather than the row being dropped by a non-matching join.
    SELECT author, permlink,
           CASE WHEN json_metadata->>'app' = %(lite_app)s
                THEN json_metadata->>'lumen_user_id' END AS uid
    FROM hafsql.comments
    WHERE author = ANY(%(lite_publishers)s)
)
SELECT src, dst, COUNT(*), MAX(ts) FROM (
    SELECT b.account_name AS src, b.author AS dst, b.created_at AS ts
    FROM hafsql.reblogs b
    WHERE b.account_name <> b.author
      AND b.created_at >= %(since)s
    AND b.created_at < %(until)s
      AND NOT (b.author = ANY(%(lite_publishers)s))
    UNION ALL
    SELECT b.account_name AS src, COALESCE(l.uid, b.author) AS dst, b.created_at AS ts
    FROM hafsql.reblogs b
    JOIN lite l ON l.author = b.author AND l.permlink = b.permlink
    WHERE b.account_name <> b.author
      AND b.created_at >= %(since)s
    AND b.created_at < %(until)s
) e
GROUP BY src, dst
"""

_SQL_REBLOG_EDGES = """
SELECT account_name, author, COUNT(*), MAX(created_at)
FROM hafsql.reblogs
WHERE account_name <> author
  AND created_at >= %(since)s
    AND created_at < %(until)s
GROUP BY account_name, author
"""

# ★★★ _SQL_STAKE_LINEAGE DELETED 2026-08-05 (B2). It read `hafsql.delegations`
# in three UNION branches: inbound delegators, outbound delegatees, and
# "siblings" (everyone else funded by anyone who funded the author). Two of the
# three were writable by any stranger with RC, because Hive delegation requires
# no consent from the delegatee — and the sibling branch grouped whole honest
# onboarding cohorts together with no attacker present. See
# `recsys.pipeline._lineage_for` for the full rationale and the measured damage.
# Do not reinstate this query; a replacement must be a relation the SUBJECT
# consented to.

# ---------------------------------------------------------------------------
# SQL — second-degree engager index (§8.1): which of the viewer's `follows`
# voted, replied to, or reblogged each OON post key. Batched over a page of
# (author, permlink) keys via the same parallel-array unnest join as the
# hydration queries above.
# ---------------------------------------------------------------------------

_SQL_SECOND_DEGREE_ENGAGERS = """
SELECT author, permlink, engager FROM (
    SELECT v.author, v.permlink, v.voter AS engager
    FROM hafsql.operation_effective_comment_vote_view v
    WHERE (v.author, v.permlink) IN (
        SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
    )
      AND v.voter = ANY(%(follows)s)
      AND v.rshares > 0  -- a followed account's DOWNVOTE is not a second-degree vouch
    UNION
    SELECT rc.parent_author AS author, rc.parent_permlink AS permlink, rc.author AS engager
    FROM hafsql.operation_comment_view rc
    WHERE (rc.parent_author, rc.parent_permlink) IN (
        SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
    )
      AND rc.author = ANY(%(follows)s)
    UNION
    SELECT r.author, r.permlink, r.account_name AS engager
    FROM hafsql.reblogs r
    WHERE (r.author, r.permlink) IN (
        SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
    )
      AND r.account_name = ANY(%(follows)s)
) engagements
"""

# Follow graph (§8.3): follower -> followee edges, restricted to the given
# account set (graph-cred only needs the sub-graph induced by the accounts
# already involved in the engagement edges it's scoring).
_SQL_FOLLOW_GRAPH = """
SELECT follower_name, following_name
FROM hafsql.follows
WHERE follower_name = ANY(%(accounts)s)
  AND following_name = ANY(%(accounts)s)
"""

# A5: the NormContext sample source (§4) — ALL (top-level + lite) posts in a
# window, ordered by RECENCY ONLY. Deliberately NOT `_SQL_POPULAR_POSTS`'s
# shape: that query's `ORDER BY <engagement> DESC` exists to PICK a fallback
# pool, and reusing it as the norm sample would bias the percentile
# distribution upward (the sample would already skew toward high engagement)
# and push every real candidate's score toward the bottom of [0, 1] — see
# `recsys.io.hafsql`'s module docstring and `normalize.py`'s saturation note.
#
# RETURN ALL, NOT A SAMPLE — but this is safe ONLY at the window sizes
# actually in use today, and the reason is NOT what the row count alone
# suggests. Live-verified 2026-08-04 (this builder), THE ROW FETCH ITSELF is
# cheap and near-flat with window size: 3d ~3,760 posts/0.2-0.55s, 7d ~8,887
# posts/0.55s. But `window_posts` also HYDRATES every row (votes, comments,
# rebloggers, reputations — see `_hydrate`), and hydration cost is dominated
# by TOTAL VOTE VOLUME across the window, not post/author count:
#
#     3d:  3,760 posts -> full hydrate() ~8.8s   (measured via window_posts()
#     7d:  8,887 posts -> _votes_for_posts ALONE pulls 1,231,239 vote rows and
#          takes ~19.5s by itself (comments 1.3s, rebloggers 1.4s, reps 0.1s)
#          -> the DEFAULT 15s statement_timeout CANCELS the query
#          (`psycopg.errors.QueryCanceled`) before it returns at all.
#
# So a 7-day call to this method, as shipped, TIMES OUT. The 3-day default
# (`HistoryWindows.sourcing_freshness_days`) is the one that has actually been
# measured safe, with headroom (8.8s of 15s) but not a lot. This is why
# sampling was rejected in favour of returning everything: a random/unbiased
# SAMPLE (e.g. `TABLESAMPLE`/`ORDER BY random() LIMIT n`) still has to
# HYDRATE whatever it draws, so it does not fix the actual bottleneck (vote
# volume) unless the sample is drawn small enough to matter — at which point
# it is no longer "the whole window" and reintroduces exactly the estimation
# noise §4's percentile ranking exists to average out. The real mitigation is
# the one A5.2 already calls for: build this ONCE per window on a timer/cache
# (never per-request), and re-measure before ever widening the window this is
# called with past 3 days, or before raising `HAFSQL_STATEMENT_TIMEOUT_MS` to
# paper over a wider one — the underlying cost does not go away, it just stops
# being visible as a timeout.
_SQL_WINDOW_POSTS = f"""
SELECT c.author, c.permlink, c.category, c.created, c.tags,
       c.json_metadata->>'lumen_user_id'
FROM hafsql.comments c
WHERE {_top_level_or_lite("c")}
  AND c.deleted = false
  AND c.created >= %(since)s
ORDER BY c.created DESC
LIMIT %(limit)s
"""

# Popular-posts fallback (§13.5b): recent top-level posts ranked by the same
# ATTRIBUTED distinct-identity signal the organic term scores (§6) — distinct
# non-self voters above the organic voter floor (now IMPORTED from
# recsys.core.vote_signal._ORGANIC_VOTER_MIN_RSHARES rather than retyped —
# see `_VOTER_MIN_RSHARES_SQL`), distinct non-self
# commenters, and distinct non-self rebloggers, weighted 0.5/0.3/0.5 to match
# the organic weights. Deliberately NOT payout/net_rshares (so the fallback
# isn't "trending" reimplemented) and NEVER the raw self-farmable counters
# (total comment count, total reblog count, self-votes included) that the
# attribution fix declares untrustworthy — the fallback pool must not be
# orderable by the very signals scoring refuses to trust.
#
# This ORDER BY is a COARSE PRE-FETCH ONLY. Stake-lineage and ring exclusion
# need the weekly trust snapshot, which this query cannot see, so a
# lineage/ring farm can still inflate this self-excluded distinct count. That
# is why the authoritative exclusion is applied downstream, NOT here: the
# pipeline re-orders the fetched pool by the FULL §8.4 exclusion set
# (recsys.pipeline._order_by_full_exclusion) before selecting padding, and
# re-scores the selected padding under the same exclusions. What SQL enforces
# cheaply — self-exclusion, distinctness, the chain-dust floor — bounds which
# posts are fetched; the snapshot-dependent lineage/ring exclusion decides
# which survive. Both layers use identical weights and thresholds so the
# pre-fetch never contradicts the authoritative pass, only widens it.
#: How many rows ONE author may occupy in the popularity RECALL set.
_POPULAR_MAX_PER_AUTHOR = 2

#: ★★★ THE RECALL WEIGHTS, EXPORTED (2026-08-09). These exist as named
#: constants for ONE reason: `measurement-harness/simworld.py` reimplements this
#: ordering in Python, its comment claimed it "mirrors production exactly...
#: so the two cannot drift apart silently", and it drifted anyway — after the
#: 2026-08-09 rebuild the sim still scored `0.5*voters + 0.3*comments +
#: 0.5*reblogs` while production scored conversation only. Recall overlap fell
#: to 76/150, so every harness measurement of this lane was taken on a pool
#: production never produces. A shared constant plus
#: `test_sim_recall_matches_production_weights` is what makes the claim true
#: instead of aspirational.
POPULAR_RECALL_COMMENT_WEIGHT = 0.6
POPULAR_RECALL_REBLOG_WEIGHT = 0.4

#: ★★★ RECALL IS THE CONVERSATION (2026-08-09, owner: "popular lane needs to
#: come from comments and reblogs"). This was
#: `0.5*voters + 0.3*commenters + 0.5*rebloggers` — voters were 0.5 of 1.3, i.e.
#: 38% of what decided which posts the lane could even SEE, against an owner cap
#: of 10% on vote influence. Stake now enters only in `select_popular`, at its
#: 10% share, where it can be normalised against the pool; SQL cannot normalise,
#: so putting rshares here would have let one whale-voted post dominate recall.
#:
#: 0.6/0.4 mirrors `PopularConfig.comment_share` so recall and selection agree
#: about what "leading the conversation" means. Still distinct-identity counts,
#: still self-excluded; the trust budget and reputation tilt are applied in
#: Python, which is the only place they exist.
#: ★★★ G5 — RECALL RESOLVES THE COMMENTER, AND IT HAS TO BE HERE (2026-08-10).
#:
#: This expression IS the recall ordering: `_SQL_POPULAR_POSTS` cuts the pool to
#: `%(limit)s` rows (150 in production) by it, in SQL, before a single row is
#: hydrated. Lite engagement otherwise enters only in `_merge_lite_engagement`,
#: i.e. AFTER hydration — so a post popular purely inside Lumen was filtered out
#: before anything downstream could score it. Resolving anywhere but here fixes
#: nothing for this lane.
#:
#: TWO CHANGES, both on the comment term:
#:   1. `COUNT(DISTINCT rc.author)` -> `COUNT(DISTINCT <resolved>)`: five lite
#:      writers are five commenters, not one publisher account counted once.
#:   2. `rc.author <> c.author` -> resolved-vs-resolved: a lite writer is still
#:      excluded from their own post (measured: the self-reply on
#:      `lumen-01kzj5nrawppr44wrhj49zfsh8` stays excluded), while a reply from a
#:      DIFFERENT lite writer now counts.
#:
#: ★ BOTH SIDES USE THE GATED `_engager_identity`, NOT `_identity`, AND THE
#: DIFFERENCE IS A HOLE THIS NEARLY OPENED (caught by measurement, 2026-08-10).
#: `_identity` is a BARE COALESCE with no provenance check — `_SQL_POPULAR_POSTS`
#: partitions on it and `_build_post` ranks on it, a looseness this module
#: already flags as out of scope. Using it on the POST side of a self-exclusion
#: is different in kind: any account could put a `lumen_user_id` in its own
#: post's `json_metadata`, and the comparison `rc.author <> COALESCE(claim, ...)`
#: would then be true for the author's OWN comments — self-engagement counted,
#: no publisher, no lite deploy required. Measured with `lite_publishers='{}'`
#: (lite fully OFF) the loose form scored a lumen-shaped post 0.6 where the
#: pre-G5 query scored 0.0. Gated on both sides, a non-publisher post resolves
#: to `c.author` on both sides and the predicate is byte-for-byte the old one.
#: Plus the container-child exclusion the hydration query already had. That is
#: NOT optional here: `rc.author <> c.author` used to exclude a container's own
#: children incidentally (both sides are the publisher), and resolving the
#: commenter removes that accident — without the explicit predicate a rolling
#: container would count every lite post filed into it as a distinct commenter
#: and top the recall ordering outright.
#:
#: ★ THE REBLOG TERM IS DELIBERATELY UNCHANGED, and this is a finding, not an
#: omission. `hafsql.reblogs` has no `json_metadata` column at all (columns:
#: account_id, account_name, post_id, author, permlink, block_num, created_at),
#: so a reblogger carries no embedded attribution and there is nothing to
#: resolve — `r.account_name` can only ever hold a real Hive account. Lite
#: reblogs are not on chain: they live in the Lumen app's own Postgres and enter
#: through `_merge_lite_engagement` as `lite_rebloggers`, kept structurally
#: apart from chain rebloggers on purpose (`AttributedPost.lite_rebloggers`).
#: Resolving `r.account_name` against `_identity(c)` would therefore be a no-op
#: for lite posts (a Hive account name can never equal a ULID) while WEAKENING
#: the real guard it replaces — the publisher self-reblogging its own container
#: child would stop being excluded. So it stays on the chain identity, which for
#: this column is the resolved identity.
_POPULAR_ENGAGEMENT = f"""    {POPULAR_RECALL_COMMENT_WEIGHT} * (
           SELECT COUNT(DISTINCT {_engager_identity("rc")})
           FROM hafsql.operation_comment_view rc
           WHERE rc.parent_author = c.author AND rc.parent_permlink = c.permlink
             AND {_engager_identity("rc")} <> {_engager_identity("c")}
             AND NOT {_LITE_CONTAINER_CHILD.format(t="rc.")})
    + {POPULAR_RECALL_REBLOG_WEIGHT} * (SELECT COUNT(DISTINCT r.account_name)
             FROM hafsql.reblogs r
             WHERE r.author = c.author AND r.permlink = c.permlink
               AND r.account_name <> c.author)"""

# ★★★ PER-AUTHOR RECALL CAP (2026-08-08) — `%(per_author)s` rows per author,
# applied BEFORE the LIMIT. Without it this recall set is capturable and no
# amount of care in the selection step can save it.
#
# THE ATTACK, priced. `recsys.core.popular.select_popular` re-scores whatever
# this query returns under the request's own `VoterTrust` budget, so a farm with
# no vouched engagers is stuck near raw breadth ~1.3 against an honest
# chain-topper's ~20 and CANNOT out-select it. But selection can only rank what
# recall handed it. Hive allows a root post every 5 minutes — 864 per 3-day
# window — so one author publishing enough posts that each clears the LAST place
# in this ORDER BY evicts every honest post from the recall set, and the lane
# then selects the best of a farm-only list. `cap_oon_flooding` does not help:
# it runs on the MERGED candidate pool, i.e. after selection, so it trims what is
# SERVED (3 per author) and never what is RECALLED — 2 authors would still fill
# `DiversityConfig.popular_per_page`.
#
# `ROW_NUMBER() OVER (PARTITION BY identity ORDER BY <engagement> DESC)` bounds
# each author's share of the recall set directly, so filling it requires
# `source_limit / per_author` DISTINCT authors rather than one prolific account.
# Partitioned on the RANKED identity (`_identity`), not the chain author, or a
# shared Lumen publisher account would be capped as if it were one writer.
_SQL_POPULAR_POSTS = f"""
SELECT author, permlink, category, created, tags, lumen_user_id FROM (
  SELECT c.author, c.permlink, c.category, c.created, c.tags,
         c.json_metadata->>'lumen_user_id' AS lumen_user_id,
         ROW_NUMBER() OVER (
             PARTITION BY {_identity("c")}
             ORDER BY ({_POPULAR_ENGAGEMENT}) DESC, c.created DESC
         ) AS author_rank,
         ({_POPULAR_ENGAGEMENT}) AS engagement
  FROM hafsql.comments c
  WHERE {_top_level_or_lite("c")}
    AND c.deleted = false
    AND c.created >= %(since)s
) ranked
WHERE author_rank <= %(per_author)s
ORDER BY engagement DESC, created DESC
LIMIT %(limit)s
"""

# ★★★ AUTHOR FIRST-POST AGGREGATE (2026-08-08) — the NEWNESS predicate the
# exploration lane never had. One grouped MIN over the same identity the ranker
# uses, exactly the shape `_SQL_AUTHOR_ENGAGEMENT` already runs.
#
# WHY IT EXISTS. `eligible_for_exploration` bands authors on
# `engagement_received` — the UNENGAGED — and reads no author age at all. Its
# own docstring concedes the gap: "This does NOT make the lane new-author-only;
# that needs an author-age or graph-cred-absence condition, which both councils
# flagged as the real v1.0 gap." On Hive the unengaged are mostly DOWNVOTED
# VETERANS, and measured across 5 real viewers the reserved seat went to
# `tdvtv` (created 2020-12-17, 28,777 posts), `darkflame` (2016, 15,552 posts),
# `sadcorp` (1,233 posts, reputation -40.8bn), `alexwo` (947 posts, reputation
# -843bn) and `toluwanispecial` (768 posts) — exactly one genuine debut
# (`liza-amin`, 3 posts) in the whole sample.
#
# ★★★ PERF — THE 280-SECOND REQUEST (2026-08-08, SAME DAY, live-measured).
#
# The version above shipped this morning as a bare grouped MIN with NO date
# bound and the COALESCE identity on the left of `= ANY(...)`. Measured on the
# real mirror with the 972-identity candidate set a live `/feed` actually
# produces: **311 SECONDS**. It is the whole of the ~280s `/feed?viewer=
# lordbutterfly` regression (30-45s -> 279.5s) — the frontend gives up at 15s,
# so every cold viewer got the trending fallback instead of a ranked feed.
#
# `EXPLAIN (ANALYZE, BUFFERS)` named TWO independent, additive causes — the
# exact pair `_SQL_AUTHOR_ENGAGEMENT` below already documents, re-made here:
#
#   1. NOT SARGABLE. `COALESCE(json_metadata->>'lumen_user_id', author) =
#      ANY(%(authors)s)` cannot be answered by any index on `author`, so
#      Postgres fell back to `hafsql_comments_table_parent_author_empty_
#      deleted_id_idx` — i.e. EVERY TOP-LEVEL POST ON HIVE, ALL HISTORY:
#      25,744,001 index rows, 75,058,034 removed by recheck, 25,030,577 removed
#      by filter, 11,036,504 buffer reads — to keep 58,073. The cost is set by
#      total chain volume and grows forever, no matter how few authors are asked
#      about.
#   2. NO DATE BOUND. `MIN(created)` over all history must touch every post an
#      author ever made, and one candidate on this chain has 28,777. Fixing (1)
#      ALONE still measured 191s: sargable is necessary and NOT sufficient.
#
# ★ THE TRAP IN THE OBVIOUS FIX, and why this query is shaped the way it is.
# Simply adding `AND c.created >= <floor>` to the grouped MIN is FAST (0.8s) and
# WRONG: inside a window, `MIN(created)` returns a veteran's first post OF THAT
# MONTH, so every still-active 2016 account reports as a debut. Measured on the
# same 972 identities: 505 authors classified NEW against a true 86. That is the
# newness predicate inverted into a veterans-only lane — strictly worse than the
# bug it was added to fix, and it would have looked like it was working.
#
# ★ WHAT IS ACTUALLY ASKED. The consumer
# (`recsys.core.exploration.eligible_for_exploration`) only ever evaluates
# `first_post >= now - max_author_age_days`. So the question is not "when did
# this author first post" but "**does this author have any post older than the
# threshold**" — and that flips an unbounded AGGREGATE into a bounded EXISTENCE
# check, which can stop at the FIRST row it finds instead of reading a whole
# history. That is the entire fix:
#
#   * `windowed`  — the bounded, sargable MIN over the last `%(floor)s` days,
#     split into the same two SARGABLE branches `_SQL_AUTHOR_ENGAGEMENT` uses (an
#     ORDINARY branch keyed on `c.author = ANY(...)`, disjoint via
#     `lumen_user_id IS NULL`, and a LITE branch bounded by the tiny
#     `%(lite_publishers)s` set). Every candidate author posted inside the
#     sourcing window by construction, so this resolves all of them.
#   * the two `NOT EXISTS` anti-joins — drop any identity with even one
#     top-level post STRICTLY BEFORE the floor. `EXPLAIN` confirms these run as
#     `Index Scan using hafsql_comments_table_author_created_idx` with
#     `(author = <identity> AND created < floor)`, one early-terminating probe
#     per identity.
#
# For every identity this query RETURNS, `first_post` is therefore the author's
# TRUE first post, not a windowed artefact — by construction they have nothing
# before the floor. An identity that IS old is simply absent, which the caller
# already treats as "refuse the seat" (fail-closed), so the returned verdict is
# byte-identical to the unbounded query's.
#
# ★ THE FLOOR MUST STAY STRICTLY OLDER THAN THE THRESHOLD, and it is passed in
# (`%(floor)s`) rather than hardcoded here, derived by the caller from
# `ExplorationConfig.max_author_age_days` + `_FIRST_POST_FLOOR_MARGIN_DAYS`. If
# the floor ever equalled the threshold, authors sitting exactly on the boundary
# would be decided by the floor instead of by their real first post, and raising
# `max_author_age_days` in config without widening the scan would silently make
# the lane refuse everyone it was just widened to admit — the SQL bound and the
# predicate it serves must not be able to drift apart.
#
# MEASURED, same 972 identities, same mirror, same session:
#     unbounded (as shipped)  311.4s / 159.1s      <- the regression
#     naive date floor          0.8s   BUT 505 false debuts vs 86 true
#     THIS QUERY                4.5s cold, 0.25s warm; 0.72s cold on a
#                               56%-different author set
# and the NEW-set is IDENTICAL to the exact unbounded reference: 88 vs 88, zero
# false-new, zero false-old, zero timestamp mismatches (see
# `test_author_first_post_is_bounded_and_sargable`, which pins the SHAPE so this
# cannot regress to a full scan again without failing a test).
_SQL_AUTHOR_FIRST_POST = """
WITH windowed AS (
    -- ORDINARY branch: sargable on `hafsql_comments_table_author_created_idx`
    -- (author, created). MUST stay a direct `c.author = ANY(...)` equality —
    -- a COALESCE expression here is what cost 311s. `lumen_user_id IS NULL`
    -- keeps this branch disjoint from the LITE branch below.
    SELECT c.author::text AS identity, c.created AS created
    FROM hafsql.comments c
    WHERE c.author = ANY(%(authors)s)
      AND c.created >= %(floor)s
      AND c.parent_author = ''
      AND c.deleted = false
      AND c.json_metadata->>'lumen_user_id' IS NULL
    UNION ALL
    -- LITE branch: same provenance check as `_LITE_POST` (both `author` AND
    -- `parent_author` must be a configured publisher), so a lite writer keys on
    -- their OWN first lite post and never inherits the shared publisher
    -- account's history. `lite_publishers` is tiny, so this stays cheap.
    SELECT c.json_metadata->>'lumen_user_id' AS identity, c.created AS created
    FROM hafsql.comments c
    WHERE c.author = ANY(%(lite_publishers)s)
      AND c.parent_author = ANY(%(lite_publishers)s)
      AND c.json_metadata->>'app' = %(lite_app)s
      AND c.json_metadata->>'lumen_user_id' = ANY(%(authors)s)
      AND c.created >= %(floor)s
      AND c.deleted = false
),
first_in_window AS (
    SELECT identity, MIN(created) AS first_post FROM windowed GROUP BY identity
)
SELECT f.identity, f.first_post
FROM first_in_window f
WHERE NOT EXISTS (
        SELECT 1 FROM hafsql.comments o
        WHERE o.author = f.identity
          AND o.created < %(floor)s
          AND o.parent_author = ''
          AND o.deleted = false
          AND o.json_metadata->>'lumen_user_id' IS NULL
      )
  AND NOT EXISTS (
        SELECT 1 FROM hafsql.comments l
        WHERE l.author = ANY(%(lite_publishers)s)
          AND l.parent_author = ANY(%(lite_publishers)s)
          AND l.json_metadata->>'app' = %(lite_app)s
          AND l.json_metadata->>'lumen_user_id' = f.identity
          AND l.created < %(floor)s
          AND l.deleted = false
      )
"""

#: How much OLDER than ``ExplorationConfig.max_author_age_days`` the SQL scan
#: floor sits. The floor must be strictly older than the threshold the caller
#: tests, so that an author sitting on the boundary is decided by their real
#: first post and not by where the scan happened to stop. One day is enough and
#: costs nothing — the scan is bounded by the anti-join, not by this width.
_FIRST_POST_FLOOR_MARGIN_DAYS = 1

#: Request-path bound for the newness read, in ms. NOT the global
#: ``HAFSQL_STATEMENT_TIMEOUT_MS`` (900s in this deployment, and deliberately so:
#: the trust/author-prior BATCH legitimately runs for minutes, and lowering the
#: global is what makes the snapshot never get written — see `_fetch_via`).
#: A batch may take minutes; a REQUEST may not, and before this the request path
#: had no bound that could ever fire.
#:
#: 8s, chosen against measurements rather than taste: the query costs 0.25s warm
#: and 4.5s on a cold mirror cache, so this is ~32x the steady-state cost and
#: still clears the observed cold case; it is well inside the frontend's 15s
#: patience, so the lane can forfeit and the PAGE STILL SERVES; and it is far
#: below the mirror role's own 45s `statement_timeout`, so ours always fires
#: first and we degrade on our own terms instead of being cancelled upstream.
#: Exceeding it raises, `recsys.pipeline` catches, and the seat forfeits — the
#: degrade this predicate already documents, now reached in bounded time instead
#: of by hanging.
#:
#: ★ WHY ONLY THIS READ, AND NOT EVERY REQUEST-PATH QUERY — stated so the gap is
#: a decision on the record rather than an oversight. A timeout is only an
#: improvement where the caller has somewhere to go when it fires. This read
#: does: `recsys.pipeline` wraps it, the seat forfeits, and the page still
#: serves 20 items. The other request-path reads (`in_network_posts`,
#: `tag_posts`, `engaged_oon_posts`, `second_degree_engagers`) have NO such
#: degrade — a raise there propagates and `build_feed` turns it into a 503. On a
#: cold mirror those legitimately run for seconds (`window_posts` alone is
#: measured at ~8.8s), so bounding them at this value today would convert
#: "slow page" into "no page", which is strictly worse for a launch.
#:
#: The right order is: give each sourcing read an explicit degrade (serve the
#: lanes that answered, log the one that did not), THEN bound it. Until that
#: exists they stay on the client-wide bound, and this constant is the mechanism
#: (`_fetch(..., timeout_ms=)`) already in place to do it in one line each.
_FIRST_POST_TIMEOUT_MS = 8000

# Author-pooled engagement prior (§6): one grouped aggregate per candidate
# author over the window. For each of an author's top-level window posts, the
# same ATTRIBUTED distinct-identity signal the organic term scores —
# 0.5*distinct voters above the chain-dust floor + 0.3*distinct commenters +
# 0.5*distinct rebloggers (weights/threshold mirror
# recsys.core.vote_signal._ORGANIC_*_WEIGHT and _ORGANIC_VOTER_MIN_RSHARES) —
# log-compressed exactly as post_base_engagement does, then SUMmed:
# AuthorEngagement.total_base is that sum, posts the count.
#
# ★★★ PERF (2026-08-04, this builder). MEASURED PROBLEM: this is the hot-path
# query `pipeline._author_priors` runs on EVERY request (own_base is 80% of
# the composite score via the organic term). Live-measured against the real
# mirror, the query AS IT SHIPPED had two independent, additive cost drivers —
# found via `EXPLAIN (ANALYZE, BUFFERS)`, not guessed:
#
#   1. The old FROM-clause predicate — `_top_level_or_lite(c)` admitting a row,
#      then `{_identity(c)} = ANY(%(authors)s)` FILTERING it — is not sargable:
#      `COALESCE(json_metadata->>'lumen_user_id', author)` cannot be answered
#      by any index on `author` alone, so Postgres had to bitmap-scan every
#      top-level post NETWORK-WIDE in the window and post-filter down to the
#      requested authors. Measured: for a real 47-account follow list (45d
#      window), this pulled 57,619 rows to keep 202 — a ~200ms FIXED tax on
#      every call, independent of how few authors were actually asked for,
#      and it gets worse as total network posting volume grows over time.
#   2. Each per-post credit subquery (`credited_voters`/`credited_commenters`)
#      selected from `hafsql.operation_effective_comment_vote_view` /
#      `operation_comment_view` — both PUBLIC HAFSQL views that unconditionally
#      JOIN to `hafd.blocks` to compute a `timestamp` column (via a `Memoize`
#      node caching `operation_id_to_block_num`). Neither view's `timestamp`
#      output is ever selected by this query — Postgres cannot prune the join
#      because it is expressed as a function call
#      (`hb.num = hafd.operation_id_to_block_num(o.id)`), not a declared FK, so
#      it can't prove the join is loss-free and drops it. Measured: for that
#      same 47-account case, this join alone accounted for 153,688 of the
#      query's 285,092 total buffer touches (54%) and ~81% of wall time.
#
#   TOGETHER, on a REALISTIC well-followed account (`blocktrades`, 47 follows —
#   the exact account+follow-count this module's own docstring cites for the
#   58s containerised measurement), these two costs are what pushed a
#   sub-second query into double-digit seconds under cold cache / container
#   network conditions, and would time out entirely (>15s) the moment the
#   follow list included even a modestly busier author.
#
#   THE FIX, both live-verified via `EXPLAIN (ANALYZE, BUFFERS)` +
#   `REPEATABLE READ`-pinned byte-identical output vs. the pre-fix query on
#   real mainnet data (see `tests/test_hafsql_live.py`):
#     (a) split row admission into a UNION ALL of two SARGABLE branches — an
#         ORDINARY branch keyed on `c.author = ANY(%(authors)s) AND c.created
#         >= %(since)s` (uses `hafsql_comments_table_author_created_idx`
#         directly) for posts with no `lumen_user_id`, and a LITE branch keyed
#         on `c.author = ANY(%(lite_publishers)s)` (a tiny, bounded set) for
#         genuine lite posts — instead of one row filter that has to inspect
#         every row's metadata before it can be excluded;
#     (b) bypass `operation_effective_comment_vote_view` /
#         `operation_comment_view` and read `hafd.operations` directly for the
#         vote/comment credit subqueries (`hafd.operation_id_to_type_id(id) =
#         72` / `= 1`), which still uses the exact same
#         `hafsql_author_permlink_idx` / `hafsql_parent_author_parent_permlink_idx`
#         these views would have used, minus the blocks join neither result
#         needs. `hafsql.reblogs` is untouched — its own EXPLAIN shows no
#         comparable join waste (it is already built off indexed
#         `hivemind_app` tables, not a raw `hafd.operations` decode).
#
#   MEASURED, blocktrades/47-follows/45d (repeated on a warm mirror cache;
#   run-to-run variance on the shared public mirror was real — see the test
#   file for the range observed): ~1.3-3.1s before -> ~0.9-1.6s after, with
#   the network-wide-scan component alone dropping from ~200ms to ~6ms
#   (`Index Scan using hafsql_comments_table_author_created_idx`, not
#   `Bitmap Heap Scan` over the whole window) and the vote-credit subplan's
#   buffer usage dropping from 189,295 to 35,608 (81% fewer).
#
#   ★ WHAT THIS DOES **NOT** FIX — THE STRUCTURAL FLOOR. Both fixes above cut
#   FIXED/CONSTANT-FACTOR waste; neither changes the fact that this query is
#   still, fundamentally, one correlated subquery PER CANDIDATE POST. Its cost
#   is bounded below by total vote/comment row volume across every window post
#   by every candidate author — exactly the same shape of bottleneck
#   `window_posts`'s own docstring already documents for a DIFFERENT query.
#   Live-measured: a candidate-author set built from the 150 most prolific
#   posters network-wide in the window (14,464 candidate posts, ~1.4M matching
#   vote rows — a stand-in for what `pipeline._author_priors` actually
#   receives, since it is called with `eligible` UNION `filler` from the FULL
#   candidate pool, not a raw follow list, and that pool's sourcing can pull in
#   high-frequency posters) still took ~21-36s even with BOTH fixes above
#   applied — a batched single-join rewrite (aggregate once instead of once
#   per post) only brought that to ~28s, still over the 15s budget. **A query
#   rewrite alone cannot bound this** — see `HafsqlClient.author_engagement`'s
#   docstring and the build report for the architectural recommendation
#   (cache/build this on the SAME timer basis as `popular_posts`, since it is a
#   per-author WINDOW aggregate, not a per-viewer quantity).
#
#   ★ A NARROWER TRUST SURFACE, side effect of fix (a) — flagged, not hidden.
#   `_identity()` used bare `COALESCE(json_metadata->>'lumen_user_id', author)`
#   with NO check that the row is a genuine lite post (`_LITE_POST` requires
#   BOTH `author` and `parent_author` to be configured lite publishers before
#   trusting that key — `json_metadata` is attacker-controlled, per this
#   module's own A13/A11 notes). The ORDINARY branch below requires
#   `lumen_user_id IS NULL`; only the LITE branch (same provenance check as
#   `_LITE_POST`) admits a `lumen_user_id`-keyed identity. This means an
#   ordinary top-level post (NOT inside a real lite-publisher container) that
#   carries a crafted `lumen_user_id` in its `json_metadata` — nothing
#   legitimate ever sets that key outside Lumen's own lite-posting flow, but
#   nothing stops a hand-built `comment_operation` from doing so — no longer
#   has its engagement pooled under the spoofed identity here. The PRE-EXISTING
#   loose behaviour (no provenance check) is unchanged in `_SQL_IN_NETWORK_POSTS`
#   and `_SQL_ENGAGED_OON_POSTS`, which still call bare `_identity()`/
#   `_top_level_or_lite()` — same latent gap, out of THIS builder's scope
#   (`hafsql.py` owns the query, not the identity-trust policy), reported here
#   for whoever owns `_identity()` to decide whether to tighten the other two
#   call sites the same way. No real lite content exists on mainnet yet, so
#   this had zero effect on any measured result above or in the regression
#   pins in `tests/test_hafsql_live.py` (verified byte-identical either way on
#   real data — the divergence is theoretical/adversarial-input-only).
#
# Every engager is filtered through the FULL §8.4 exclusion set, so an author
# cannot farm their own pooled prior with self-engagement, delegation-tied
# alts or a reciprocal ring (the input the earlier self-exclusion-ONLY
# aggregate left unguarded). Self-exclusion is the static `<> cp.author`
# predicate. Stake-lineage and ring identities are snapshot-dependent and
# invisible to SQL, so — exactly as the vote signal derives them per request
# and hands them to independent_organic_engagement — the caller passes them in
# as parallel (author, excluded_account) arrays and each per-post distinct
# count anti-joins its own author's excluded set. Empty arrays (no snapshot)
# degrade to self-exclusion only.
#
# H05 (2026-07-22): exclusion alone still left the breadth term un-budgeted —
# an author's OTHER window posts could be farmed by unknown-tier sock upvotes
# that pass every §8.4 exclusion (a funded alt is not the author, not lineage,
# not a reciprocal ring), inflating total_base and, through the leave-one-out
# mean, the pooled organic prior (organic 0->1.0, proven). Each channel's
# distinct-identity count is now split into vouched (`vn`, full credit) and
# unknown (`un`, budgeted) via `FILTER`, and credited exactly as
# recsys.core.vote_signal.VoterTrust.credited_breadth does:
# `vn + LEAST(un, unknown_free + unknown_per_vouched * vn)`. `%(vouched)s` is
# the same vouched-account set the pipeline derives from graph-cred
# (`recsys.pipeline._voter_trust`); `%(unknown_free)s` / `%(unknown_per_vouched)s`
# are `VoteSignalConfig.unknown_free` / `.unknown_per_vouched`. With no trust
# snapshot the caller passes `vouched=[]`, `unknown_free=1e18`,
# `unknown_per_vouched=0` — the budget never binds and the query collapses
# to the pre-H05 raw distinct count, so ONE query serves both cases (see
# `HafsqlClient.author_engagement`).
#
# Also new in H05: an eligibility/flooding join. A post already suppressed
# by network_suppression (§8.7) never feeds the prior — flooding an author's
# window with empty/suppressed posts cannot dilute or pad the aggregate.
# FLOODING with genuinely engaged posts is bounded structurally elsewhere: the
# per-post budget above caps credit WITHIN a post, and the leave-one-out MEAN
# (pooled_author_base, dividing by posts - 1) averages across posts, so
# padding with low/no-engagement posts dilutes toward the noise floor rather
# than accumulating.
#
# ★ A15 (2026-08-04): the suppression check below is NOT a live join against
# `network_suppression` — that table does not exist on the HAFSQL mirror this
# query runs against (verified live: `UndefinedTable`), and a single SQL
# statement cannot join across two separate Postgres instances without an FDW
# the read-only mirror creds cannot install. `HafsqlClient.author_engagement`
# does a SECOND ROUND TRIP instead: it fetches this window's suppressed
# (author, permlink) pairs for `%(authors)s` from the recsys DB FIRST, then
# binds them here as parallel arrays and anti-joins via `unnest`, exactly the
# same shape as the `excl_authors`/`excl_accounts` exclusion arrays above. If
# the recsys DB has no configured DSN, the caller passes empty arrays and this
# clause matches nothing — i.e. suppression degrades to "nothing suppressed"
# (a loud WARNING is logged where the arrays are built), never a crash.
#
# own_base (the scorer, per candidate) and total_base (here) now carry the
# SAME two guards — §8.4 exclusion and the VoterTrust breadth budget — so they
# are consistent; pooled_author_base's leave-one-out clamp is pure
# defense-in-depth (aggregate/hydration skew), not the primary budget-residual
# absorber it was before this fix — see recsys.core.scoring.AuthorPriorGateway.
#
# break #5 (verified live 2026-08-04): `LOG(10, 1 + <double precision>)` has
# no `(integer, double precision)` overload in Postgres. Cast the argument to
# `numeric` — `LOG(numeric, numeric)` is the overload that exists.
#
# A11 (2026-08-04): the identity GROUP BY key is the RANKED identity — the
# lite writer's `lumen_user_id` where present, else the chain author — instead
# of the bare chain `author`. Before this fix a lite writer's identity never
# equalled any `hafsql.comments.author` value, so `author = ANY(%(authors)s)`
# matched zero rows for every lite author, always — their pooled quality prior
# (80% of the composite, via the organic term) was structurally empty. The PERF
# rewrite above (2026-08-04) restructured how this is computed (a UNION ALL of
# an ordinary branch and a lite branch, each producing an `identity` column)
# but the RESULT is unchanged: every real-Hive-author row's identity still
# collapses to exactly `author`, byte-identical to pre-A11/pre-PERF behaviour
# (live-verified — see `tests/test_hafsql_live.py`).
#
# UNCHANGED, deliberately (ruling: widening the row filter must not touch
# either) — both stay on the CHAIN identity, which is correct:
#   * the `e.author = cp.author` exclusion anti-joins (x3): the caller's
#     `excluded` map is keyed however IT keys authors; changing this here
#     without a matching caller-side change would silently misalign it —
#     out of scope for this fix, left for whoever wires lite priors through
#     `recsys.pipeline`.
#   * every `v.author = cp.author` / `rc.parent_author = cp.author` /
#     `r.author = cp.author` HYDRATION join key: votes/comments/reblogs are
#     always recorded on chain against the PUBLISHER account + permlink,
#     never against a `lumen_user_id` (which cannot appear in a `voter`/
#     `author` column at all — it isn't a Hive account).
#
# ★ KNOWN RESIDUAL GAP, same root cause as A12, not fixed here (out of this
# unit's stated scope — the MUST-NOT-CHANGE above forbids touching the
# exclusion anti-join, and the A15 suppression round trip below only has an
# `authors` list to work with, not a per-post chain-identity map): the H05
# suppression anti-join (`s.author = cp.author` further below) and the A15
# first round trip (`_SQL_SUPPRESSED_BY_AUTHORS`, keyed on whatever identity
# the caller passes as `authors`) both resolve against the CHAIN author. Once
# a caller passes a lite identity in `authors` (which this fix is what makes
# useful), a suppressed lite post will NOT be excluded from that lite author's
# pooled prior — see the build report.
_SQL_AUTHOR_ENGAGEMENT = f"""
WITH candidate_posts AS (
    -- ORDINARY branch: sargable on `hafsql_comments_table_author_created_idx`
    -- (author, created) — see the PERF note above for why this must stay a
    -- direct `author = ANY(...)` equality rather than a COALESCE expression.
    -- `lumen_user_id IS NULL` (not just "the lite branch below overlaps") is
    -- what keeps this branch and the LITE branch below disjoint.
    SELECT c.author::text AS author, c.permlink::text AS permlink,
           c.author::text AS identity
    FROM hafsql.comments c
    WHERE c.author = ANY(%(authors)s)
      AND c.parent_author = ''
      AND c.deleted = false
      AND c.created >= %(since)s
      AND c.json_metadata->>'lumen_user_id' IS NULL
    UNION ALL
    -- LITE branch: same provenance check as `_LITE_POST` (both `author` AND
    -- `parent_author` must be a configured lite publisher — see the PERF
    -- note's "narrower trust surface" paragraph above for why bare
    -- `_identity()`'s looser COALESCE is not reused here). `lite_publishers`
    -- is a tiny, bounded set (one account per network in practice — see A13),
    -- so this branch stays cheap even though it cannot use the
    -- (author, created) index the ordinary branch uses.
    SELECT c.author::text AS author, c.permlink::text AS permlink,
           c.json_metadata->>'lumen_user_id' AS identity
    FROM hafsql.comments c
    WHERE c.author = ANY(%(lite_publishers)s)
      AND c.parent_author = ANY(%(lite_publishers)s)
      AND c.json_metadata->>'app' = %(lite_app)s
      AND c.json_metadata->>'lumen_user_id' = ANY(%(authors)s)
      AND c.deleted = false
      AND c.created >= %(since)s
)
SELECT cp.identity AS author,
       COUNT(*) AS posts,
       SUM(LOG(10, (1 + (
           0.5 * (
               SELECT vn + LEAST(un, %(unknown_free)s + %(unknown_per_vouched)s * vn)
               FROM (
                   SELECT
                       COUNT(DISTINCT v.voter)
                           FILTER (WHERE v.voter = ANY(%(vouched)s)) AS vn,
                       COUNT(DISTINCT v.voter)
                           FILTER (WHERE NOT (v.voter = ANY(%(vouched)s))) AS un
                   FROM (
                       -- PERF: `hafd.operations` directly, NOT
                       -- `hafsql.operation_effective_comment_vote_view` — the
                       -- view's unconditional join to `hafd.blocks` (for a
                       -- `timestamp` column this subquery never selects) is
                       -- the single largest cost driver measured above. Same
                       -- row set either way (live-verified byte-identical
                       -- output) since the view is an unfiltered INNER JOIN.
                       SELECT ((o.body_binary::jsonb -> 'value') ->> 'voter') AS voter,
                              ((o.body_binary::jsonb -> 'value') ->> 'rshares')::numeric AS rshares
                       FROM hafd.operations o
                       WHERE hafd.operation_id_to_type_id(o.id) = 72  -- effective_comment_vote
                         AND ((o.body_binary::jsonb -> 'value') ->> 'author') = cp.author
                         AND ((o.body_binary::jsonb -> 'value') ->> 'permlink') = cp.permlink
                   ) v
                   WHERE v.rshares > {_VOTER_MIN_RSHARES_SQL} AND v.voter <> cp.author
                     AND NOT EXISTS (
                         SELECT 1 FROM unnest(%(excl_authors)s::text[],
                                              %(excl_accounts)s::text[]) AS e(author, account)
                         WHERE e.author = cp.author AND e.account = v.voter)
               ) credited_voters
           )
         + 0.3 * (
               SELECT vn + LEAST(un, %(unknown_free)s + %(unknown_per_vouched)s * vn)
               FROM (
                   SELECT
                       COUNT(DISTINCT rc.author)
                           FILTER (WHERE rc.author = ANY(%(vouched)s)) AS vn,
                       COUNT(DISTINCT rc.author)
                           FILTER (WHERE NOT (rc.author = ANY(%(vouched)s))) AS un
                   FROM (
                       -- PERF: `hafd.operations` directly, NOT
                       -- `hafsql.operation_comment_view` — same rationale as
                       -- the votes subquery above (smaller effect here since
                       -- comment volume per post is far lower than vote
                       -- volume, but the same waste, so the same fix).
                       SELECT ((o2.body_binary::jsonb -> 'value') ->> 'author') AS author
                       FROM hafd.operations o2
                       WHERE hafd.operation_id_to_type_id(o2.id) = 1  -- comment
                         AND ((o2.body_binary::jsonb -> 'value') ->> 'parent_author')
                             = cp.author
                         AND ((o2.body_binary::jsonb -> 'value') ->> 'parent_permlink')
                             = cp.permlink
                   ) rc
                   WHERE rc.author <> cp.author
                     AND NOT EXISTS (
                         SELECT 1 FROM unnest(%(excl_authors)s::text[],
                                              %(excl_accounts)s::text[]) AS e(author, account)
                         WHERE e.author = cp.author AND e.account = rc.author)
               ) credited_commenters
           )
         + 0.5 * (
               SELECT vn + LEAST(un, %(unknown_free)s + %(unknown_per_vouched)s * vn)
               FROM (
                   SELECT
                       COUNT(DISTINCT r.account_name)
                           FILTER (WHERE r.account_name = ANY(%(vouched)s)) AS vn,
                       COUNT(DISTINCT r.account_name)
                           FILTER (WHERE NOT (r.account_name = ANY(%(vouched)s))) AS un
                   FROM hafsql.reblogs r
                   WHERE r.author = cp.author AND r.permlink = cp.permlink
                     AND r.account_name <> cp.author
                     AND NOT EXISTS (
                         SELECT 1 FROM unnest(%(excl_authors)s::text[],
                                              %(excl_accounts)s::text[]) AS e(author, account)
                         WHERE e.author = cp.author AND e.account = r.account_name)
               ) credited_rebloggers
           )
       ))::numeric)) AS total_base
FROM candidate_posts cp
WHERE NOT EXISTS (
    -- A15: suppressed-key exclusion via a bound array, not a live table join —
    -- see the module-level comment above this query. Applied once, after the
    -- UNION ALL, since suppression keys are absolute (author, permlink) pairs
    -- regardless of which branch admitted the row.
    SELECT 1 FROM unnest(%(supp_authors)s::text[],
                         %(supp_permlinks)s::text[]) AS s(author, permlink)
    WHERE s.author = cp.author AND s.permlink = cp.permlink
)
GROUP BY cp.identity
"""

# Which of `authors`' posts are network-suppressed (§8.7), for the SECOND
# round trip `author_engagement` makes against the recsys DB (A15) before it
# queries the mirror — see the comment above `_SQL_AUTHOR_ENGAGEMENT`.
_SQL_SUPPRESSED_BY_AUTHORS = """
SELECT author, permlink
FROM network_suppression
WHERE suppressed = true
  AND author = ANY(%(authors)s)
"""

# Network suppression (§8.7) — recsys's own report-processing table
# (``recsys/db/schema.sql``), not a HAFSQL view: which of a page of post keys
# have crossed the weighted-flag threshold. Runs against the SECOND (recsys
# DB) connection (A15) — this table does not exist on the HAFSQL mirror.
_SQL_SUPPRESSED_KEYS = """
SELECT author, permlink
FROM network_suppression
WHERE suppressed = true
  AND (author, permlink) IN (
    SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[])
  )
"""


def _reputation_display(raw: int) -> float:
    """hivemind-equivalent raw→display reputation (Appendix B constant)."""
    if raw == 0:
        return _REP_BASE
    sign = 1.0 if raw > 0 else -1.0
    magnitude = max(math.log10(abs(raw)) - _REP_LOG_FLOOR, 0.0)
    return sign * (magnitude * _REP_SCALE + _REP_BASE)


def _latest(*timestamps: datetime | None) -> datetime | None:
    """The most recent of several optional timestamps, or ``None``."""
    present = [t for t in timestamps if t is not None]
    return max(present) if present else None


def _resolve_post_keys(
    post_keys: frozenset[str], chain_authors: Mapping[str, str] | None
) -> tuple[list[str], list[str], dict[tuple[str, str], str]]:
    """A12: parse ranked ``Post.key`` strings into parallel (author, permlink)
    arrays for a batched ``unnest`` join, resolving each key to its CHAIN
    author when ``chain_authors`` supplies one.

    A lite post's ranked identity is the writer (``@u_7f3c9a/permlink``), but
    votes/comments/reblogs — and any §8.7 suppression report — are recorded on
    chain against the shared PUBLISHER account the post is actually stored
    under. Proven (build report): the pre-fix parse yields
    ``(['u_7f3c9a'], [...])`` and matches zero rows, always — a lite post
    arriving via ``OON_ENGAGED`` could never clear the vouch gate, and
    moderation could never suppress one. ``chain_authors`` maps
    ``Post.key -> chain_author``; a key absent from it (every ordinary Hive
    post) resolves to the author parsed straight out of the key — the
    pre-A12 behaviour, unchanged.

    Also returns the reverse ``(resolved_author, permlink) -> original key``
    map, so the caller can key its result back onto the RANKED identity:
    ``filter_eligible`` (``core/second_degree.py``) and the engager-index
    lookup both look up by ``post.key``, which stays the lite writer's key
    throughout — only the QUERY goes out under the chain author."""
    chain_authors = chain_authors or {}
    authors: list[str] = []
    permlinks: list[str] = []
    reverse: dict[tuple[str, str], str] = {}
    for key in post_keys:
        ranked_author, _, permlink = key.removeprefix("@").partition("/")
        author = chain_authors.get(key, ranked_author)
        authors.append(author)
        permlinks.append(permlink)
        reverse[(author, permlink)] = key
    return authors, permlinks, reverse


def _split_keys(post_keys: frozenset[str]) -> tuple[list[str], list[str]]:
    """Parse ``Post.key`` strings (``"@author/permlink"``) into parallel
    author/permlink arrays for a batched ``unnest`` join. Thin wrapper over
    :func:`_resolve_post_keys` with no chain-identity resolution — kept for
    callers (and the existing test pin) that only need the plain parse."""
    authors, permlinks, _ = _resolve_post_keys(post_keys, None)
    return authors, permlinks


def chain_author_map(posts: Iterable[Post]) -> dict[str, str]:
    """A12: build the ``Post.key -> chain_author`` mapping
    ``second_degree_engagers``/``suppressed_keys`` need to resolve a lite
    post's ranked key back to the identity chain rows are actually recorded
    against. Skips ordinary Hive posts (``chain_author`` unset, or equal to
    the ranked ``author`` — never true today, but kept as a defensive no-op)
    since an absent entry already resolves correctly by falling through to
    the key's own parsed author (see :func:`_resolve_post_keys`).

    Callers (``recsys.pipeline``) should build this once per candidate batch
    and pass it as ``chain_authors=`` — see the build report for the exact
    call sites (``pipeline.py:545`` for ``suppressed_keys``, ``:1340`` for
    ``second_degree_engagers``) that still need wiring; this function exists
    so that wiring is a one-line change at each site."""
    return {
        post.key: post.chain_author
        for post in posts
        if post.chain_author and post.chain_author != post.author
    }


def _build_post(
    row: _PostRow,
    votes_by_key: dict[tuple[str, str], list[Vote]],
    comments_by_key: dict[tuple[str, str], dict[str, int]],
    rebloggers_by_key: dict[tuple[str, str], tuple[str, ...]],
    reputation_by_author: dict[str, int],
    lite_rebloggers_by_key: dict[tuple[str, str], tuple[str, ...]] | None = None,
) -> Post:
    """Map one ``hafsql.comments`` row plus its hydrated side-tables to an
    :class:`AttributedPost`. ``children``/``reblog_count`` are DERIVED from the
    attribution maps (total comments, distinct rebloggers), so the display
    counters and the scored identities can never disagree."""
    author, permlink, category, created, tags, lite_author = row
    # Hydration LOOKS UP by the CHAIN identity — votes, comments and reblogs are
    # all recorded against the publisher account + permlink on chain, so
    # `(author, permlink)` is the only key that matches a row. The IDENTITIES
    # inside those rows are a separate question: the post's own author is
    # substituted below, and (G5) `comments_by_key`'s commenter keys already
    # arrive resolved from `_SQL_COMMENTS_FOR_POSTS`, so `commenters` names lite
    # writers individually rather than the one publisher account they share.
    key = (author, permlink)
    community = category if category.startswith("hive-") else None
    tag_tuple = tuple(tags or ())
    comment_counts = comments_by_key.get(key, {})
    rebloggers = rebloggers_by_key.get(key, ())
    # ★ A lite writer has no Hive account and therefore no reputation. Taking
    # the publisher's would be wrong in both directions: every lite user would
    # free-ride on a shared score they did not earn, and one bad lite post would
    # drag down every other lite user at once. They get the same neutral display
    # reputation Hive gives a brand-new account, which is what they are.
    reputation_raw = 0 if lite_author else reputation_by_author.get(author, 0)
    return AttributedPost(
        author=lite_author or author,
        permlink=permlink,
        category=category,
        community=community,
        created=created,
        children=sum(comment_counts.values()),
        reblog_count=len(rebloggers) + len((lite_rebloggers_by_key or {}).get(key, ())),
        author_reputation=_reputation_display(reputation_raw),
        tags=tag_tuple,
        votes=tuple(votes_by_key.get(key, ())),
        is_nsfw=any(tag.lower() == "nsfw" for tag in tag_tuple),
        commenters=tuple(sorted(comment_counts)),
        rebloggers=rebloggers,
        lite_rebloggers=(lite_rebloggers_by_key or {}).get(key, ()),
        # A12: the CHAIN identity, carried alongside the ranked one only when
        # they differ (a lite post) — `None` for every ordinary Hive post,
        # where `author` already IS the chain identity. See
        # `_resolve_post_keys`/`chain_author_map` for where this is read.
        chain_author=author if lite_author else None,
    )


class _ConnPool:
    """A minimal thread-safe pool of ``psycopg`` connections to ONE DSN target.

    A4.1 asked for ``psycopg_pool.ConnectionPool``; that means a new PyPI
    dependency, which means editing ``pyproject.toml``, which this builder
    does not own (file-ownership boundary — flagged in the build report). This
    is a small hand-rolled equivalent scoped to exactly what's measured as the
    problem (604 connections/request): borrow-reuse-release, autocommit (so a
    statement error never poisons the session — verified live: a failed query
    followed by a good one on the same autocommit connection succeeds), and a
    ``statement_timeout`` set once per physical connection at creation. When
    a real ``RecsysDbConfig``/pool-sized ``HafsqlConfig`` lands, this class can
    be swapped for ``psycopg_pool`` with no change to ``HafsqlClient`` callers.

    Ruling R7 — bounded retry + circuit breaker, CONNECTION failures only:
    ``psycopg.connect()`` raising ``OperationalError`` is retried up to
    ``max_retries`` times with linear backoff. A STATEMENT error (bad SQL,
    ``UndefinedTable``, ...) happens inside ``cur.execute()``, never inside
    this class's retry loop, so it is never retried — exactly R7's
    distinction. After ``breaker_threshold`` consecutive connect failures the
    breaker OPENS: further borrows raise :class:`HafsqlUnavailableError`
    immediately — fail loudly rather than hang through more retries against a
    database that is provably down — until ``breaker_cooldown_s`` elapses,
    at which point one probe connection is allowed through (half-open).
    """

    def __init__(
        self,
        connect: Callable[[], psycopg.Connection[Any]],
        *,
        min_size: int,
        max_size: int,
        max_retries: int,
        retry_backoff_s: float,
        breaker_threshold: int,
        breaker_cooldown_s: float,
        acquire_timeout_s: float | None = None,
    ) -> None:
        self._connect = connect
        self._min_size = max(0, min_size)
        self._max_size = max(1, max_size)
        self._max_retries = max(0, max_retries)
        self._retry_backoff_s = retry_backoff_s
        self._breaker_threshold = max(1, breaker_threshold)
        self._breaker_cooldown_s = breaker_cooldown_s
        self._acquire_timeout_s = (
            acquire_timeout_s
            if acquire_timeout_s is not None
            else _env_float("HAFSQL_POOL_ACQUIRE_TIMEOUT_S")
        )

        self._lock = threading.Lock()
        #: ★ B4b — capacity signal. Waiters block here when every slot is in
        #: use; `release`/`closeall`/a failed open all notify.
        self._cond = threading.Condition(self._lock)
        self._idle: list[psycopg.Connection[Any]] = []
        #: ★ B4b — PHYSICAL connections currently in existence (idle + checked
        #: out). This, not `len(self._idle)`, is what `max_size` now bounds.
        #: Before B4b `max_size` gated only whether a RETURNED connection was
        #: kept, so it capped reuse and never capped concurrency.
        self._live = 0
        #: ★ B4b — breaker state is mutated from `_connect_with_retry`, which
        #: deliberately runs OUTSIDE `_lock` (a blocking connect must not hold
        #: the capacity lock). It therefore needs its own mutex: previously
        #: `_consecutive_failures` was incremented unguarded and the breaker was
        #: observed opening after anywhere from 5 to 12 failures under
        #: concurrency instead of the configured threshold.
        self._breaker_lock = threading.Lock()
        self._consecutive_failures = 0
        self._breaker_opened_at: float | None = None
        #: Instrumentation for A4's own "before/after" measurement — total
        #: physical connections ever opened by this pool.
        self.connections_opened = 0
        # `min_size` pre-warming happens on first BORROW, never at __init__ —
        # HafsqlClient is constructed all over the offline test suite with no
        # intent of ever touching the network; eagerly connecting here would
        # turn every such construction into a real (and likely failing)
        # network call. This flag makes the one-time warm-up idempotent.
        self._warmed = False

    def _breaker_is_open(self) -> bool:
        with self._breaker_lock:
            if self._breaker_opened_at is None:
                return False
            if time.monotonic() - self._breaker_opened_at >= self._breaker_cooldown_s:
                self._breaker_opened_at = None  # cooldown elapsed: half-open, probe once
                self._consecutive_failures = 0
                return False
            return True

    def _record_failure(self) -> bool:
        """Count one connect failure. Returns True if that tripped the breaker.

        ★ B4b — the increment, the threshold comparison and the trip must be ONE
        atomic step. Unguarded, concurrent failures interleave between the `+= 1`
        and the compare, so the breaker was observed opening after 5..12
        failures against a configured threshold of 5.
        """
        with self._breaker_lock:
            self._consecutive_failures += 1
            if self._consecutive_failures < self._breaker_threshold:
                return False
            self._breaker_opened_at = time.monotonic()
            failures = self._consecutive_failures
        logger.error(
            "hafsql: circuit breaker OPEN after %d consecutive connection failures",
            failures,
        )
        return True

    def _connect_with_retry(self) -> psycopg.Connection[Any]:
        import psycopg

        if self._breaker_is_open():
            raise HafsqlUnavailableError(
                "circuit breaker open — too many consecutive connection failures"
            )
        attempt = 0
        while True:
            try:
                conn = self._connect()
            except psycopg.OperationalError:
                if self._record_failure():
                    raise HafsqlUnavailableError(
                        "circuit breaker open — too many consecutive connection failures"
                    ) from None
                attempt += 1
                if attempt > self._max_retries:
                    raise
                time.sleep(self._retry_backoff_s * attempt)
                continue
            else:
                with self._breaker_lock:
                    self._consecutive_failures = 0
                self.connections_opened += 1
                return conn

    def borrow(self) -> psycopg.Connection[Any]:
        """Hand out a pooled connection, opening one only if the pool is below
        ``max_size``, and WAITING (not opening) when it is at capacity.

        ★ B4b (2026-08-05). This used to fall straight through to
        ``_connect_with_retry()`` whenever the idle list was empty, with no
        check against ``max_size``, no semaphore and no wait — so
        ``HAFSQL_POOL_MAX`` bounded only how many connections were RETAINED,
        never how many existed. Measured: 30 concurrent borrows on
        ``max_size=5`` produced 30 live connections, and 50 produced 50 —
        against a shared third-party public mirror, i.e. one traffic spike away
        from exhausting somebody else's database.
        """
        deadline = time.monotonic() + self._acquire_timeout_s
        with self._cond:
            while True:
                while self._idle:
                    conn = self._idle.pop()
                    if not conn.closed:
                        return conn
                    # Dead idle connection (e.g. server-side timeout). It no
                    # longer exists physically, so free its slot before looking
                    # at the next one.
                    self._live -= 1
                if self._live < self._max_size:
                    self._live += 1  # claim the slot BEFORE releasing the lock
                    needs_warm_up = not self._warmed
                    self._warmed = True
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise HafsqlUnavailableError(
                        f"connection pool exhausted: {self._max_size} in use and none "
                        f"released within {self._acquire_timeout_s}s"
                    )
                self._cond.wait(remaining)
        # Connect OUTSIDE the lock — a blocking network call must never hold the
        # capacity mutex, or one slow connect stalls every other borrower.
        try:
            conn = self._connect_with_retry()
        except BaseException:
            self._free_slot()  # never leak the claimed slot on failure
            raise
        if needs_warm_up and self._min_size > 1:
            self._warm_up()
        return conn

    def _free_slot(self) -> None:
        with self._cond:
            self._live -= 1
            self._cond.notify()

    def _warm_up(self) -> None:
        """Open up to ``min_size - 1`` extra idle connections (the borrow that
        triggered this already holds the first one) so the pool has a real
        floor after its first use, rather than growing one connection at a
        time under load. Best-effort: a failure here must not fail the
        caller's already-in-hand connection from the triggering ``borrow()``.
        """
        for _ in range(self._min_size - 1):
            # B4b: warm-up connections are real physical connections and must
            # claim a slot like any other, or pre-warming would itself overshoot
            # the bound this method's own `max_size` check was meant to keep.
            with self._cond:
                if self._live >= self._max_size:
                    return
                self._live += 1
            try:
                conn = self._connect_with_retry()
            except Exception:
                self._free_slot()
                logger.warning(
                    "hafsql: pool warm-up to min_size=%d stopped early", self._min_size
                )
                return
            with self._cond:
                if len(self._idle) < self._max_size:
                    self._idle.append(conn)
                    self._cond.notify()
                    continue
            self._free_slot()
            with contextlib.suppress(Exception):
                conn.close()
            return

    def release(self, conn: psycopg.Connection[Any], *, healthy: bool) -> None:
        with self._cond:
            if healthy and not conn.closed and len(self._idle) < self._max_size:
                # Still live, now reusable: the slot stays claimed, but a waiter
                # can take this exact connection off the idle list.
                self._idle.append(conn)
                self._cond.notify()
                return
            # About to be closed -> the slot is genuinely freed.
            self._live -= 1
            self._cond.notify()
        if not conn.closed:
            with contextlib.suppress(Exception):
                conn.close()

    def closeall(self) -> None:
        with self._cond:
            idle, self._idle = self._idle, []
            self._live -= len(idle)
            self._cond.notify_all()
        for conn in idle:
            with contextlib.suppress(Exception):
                conn.close()


class HafsqlClient:
    """Concrete ``HafsqlGateway`` backed by the public HAFSQL Postgres mirror,
    plus (A15) an optional second connection to recsys's own DB for
    ``network_suppression``. See the module docstring for both."""

    def __init__(
        self,
        config: HafsqlConfig,
        lite: LiteConfig | None = None,
        *,
        recsys_dsn: str | None = None,
        pool_min: int | None = None,
        pool_max: int | None = None,
        statement_timeout_ms: int | None = None,
        max_retries: int | None = None,
        retry_backoff_s: float | None = None,
        breaker_threshold: int | None = None,
        breaker_cooldown_s: float | None = None,
        recsys_pool_min: int | None = None,
        recsys_pool_max: int | None = None,
    ) -> None:
        self._config = config
        # Lumen Lite reachability. An explicit `lite=` kwarg always wins,
        # including an explicitly-passed `LiteConfig()` (empty) — that is a
        # caller deliberately turning lite off, not "unset". Only when NOTHING
        # is passed (`None`, the default) does construction fall back to A13's
        # environment reader, which itself defaults to empty/OFF absent both
        # env sources — so every existing bare `HafsqlClient(HafsqlConfig())`
        # call stays off in an unconfigured environment, and gains lite
        # automatically the moment ops sets the frontend's own env var, with
        # no other code change (the "one source of truth" A13 asks for).
        self._lite = lite if lite is not None else _lite_config_from_env()

        # A15: the recsys DB DSN. Explicit kwarg wins; otherwise read from the
        # environment (no `RecsysDbConfig` exists yet — see module docstring).
        # Absent (falsy) is a supported, permanent-until-configured state, not
        # an error: every suppression path degrades to "nothing suppressed"
        # with a WARNING, logged once here rather than once per request.
        self._recsys_dsn = recsys_dsn if recsys_dsn is not None else os.environ.get(
            _RECSYS_DSN_ENV
        )
        if not self._recsys_dsn:
            logger.warning(
                "hafsql: %s is not set — network suppression (§8.7) is "
                "DISABLED; suppressed_keys() returns nothing and "
                "author_engagement()'s flooding guard cannot see suppressed "
                "posts. Set %s to enable it.",
                _RECSYS_DSN_ENV,
                _RECSYS_DSN_ENV,
            )

        # A4: pool + statement_timeout + retry/breaker tunables. Explicit
        # kwargs win; otherwise env, so this is usable standalone today and
        # re-wireable to real HafsqlConfig/RecsysDbConfig fields later.
        self._statement_timeout_ms = (
            statement_timeout_ms
            if statement_timeout_ms is not None
            else _env_int("HAFSQL_STATEMENT_TIMEOUT_MS")
        )
        _max_retries = max_retries if max_retries is not None else _env_int("HAFSQL_MAX_RETRIES")
        _retry_backoff_s = (
            retry_backoff_s if retry_backoff_s is not None else _env_float("HAFSQL_RETRY_BACKOFF_S")
        )
        _breaker_threshold = (
            breaker_threshold
            if breaker_threshold is not None
            else _env_int("HAFSQL_BREAKER_THRESHOLD")
        )
        _breaker_cooldown_s = (
            breaker_cooldown_s
            if breaker_cooldown_s is not None
            else _env_float("HAFSQL_BREAKER_COOLDOWN_S")
        )

        self._pool = _ConnPool(
            self._connect,
            min_size=pool_min if pool_min is not None else _env_int("HAFSQL_POOL_MIN"),
            max_size=pool_max if pool_max is not None else _env_int("HAFSQL_POOL_MAX"),
            max_retries=_max_retries,
            retry_backoff_s=_retry_backoff_s,
            breaker_threshold=_breaker_threshold,
            breaker_cooldown_s=_breaker_cooldown_s,
        )
        self._recsys_pool = _ConnPool(
            self._recsys_connect,
            min_size=(
                recsys_pool_min if recsys_pool_min is not None else _env_int("RECSYS_DB_POOL_MIN")
            ),
            max_size=(
                recsys_pool_max if recsys_pool_max is not None else _env_int("RECSYS_DB_POOL_MAX")
            ),
            max_retries=_max_retries,
            retry_backoff_s=_retry_backoff_s,
            breaker_threshold=_breaker_threshold,
            breaker_cooldown_s=_breaker_cooldown_s,
        )

        # A4.4: popular_posts is viewer-independent (`since, limit` only), so
        # it is safe to cache across requests — unlike the retired stake_lineage, which was
        # per-viewer-relevant delegation state and MUST stay request-scoped
        # (that relation is gone entirely as of B2 2026-08-05).
        self._popular_cache_lock = threading.Lock()
        self._popular_cache: dict[tuple[int, int], tuple[float, list[Post]]] = {}
        # Keys with a background refresh in flight. Guarded by _popular_cache_lock.
        self._popular_refreshing: set[tuple[int, int]] = set()
        self._popular_cache_ttl_s = _env_float("HAFSQL_POPULAR_CACHE_TTL_S")
        # How old a borrowed answer from a NEIGHBOURING bucket may be before a
        # reader is made to wait for a real one. Four TTLs: long enough that an
        # idle process still answers instantly, short enough that a genuinely
        # abandoned cache is not served for hours.
        self._popular_max_stale_s = self._popular_cache_ttl_s * 4
        # Cache-key bucket width: requests within the same bucket share a
        # result. Must stay well under the sourcing freshness window (days),
        # which this module cannot see (`settings` lives in config.py) — a
        # constant well under any plausible window (hours) is a safe default.
        #
        # ★★★ IT MUST ALSO BE >= THE TTL, OR THE TTL IS UNREACHABLE (2026-08-16).
        #
        # `since` is a ROLLING timestamp (now - window), so bucketing it at 60s
        # rotated the cache KEY every minute while the TTL said 300s. The entry
        # was still live and still correct; nothing could ever look it up again.
        # Every request that arrived in a new minute therefore paid the full
        # query, which this method's own docstring measures at 5.9s.
        #
        # Measured on this box 2026-08-16, /topics/photography signed in:
        # a viewer with seen history 5.96s vs a viewer without 1.40s — the
        # difference is that suppression causes a shortfall, the shortfall calls
        # `_fallback_filler` -> `popular_fallback` -> here, and here always missed.
        #
        # Deriving the bucket from the TTL makes the two agree by construction,
        # so tuning `HAFSQL_POPULAR_CACHE_TTL_S` cannot silently re-open the gap.
        # A bucket at least as wide as the TTL means a hit is at most TTL old —
        # exactly what the TTL already promises. A miss still queries with the
        # caller's exact `since`; bucketing only ever affects the KEY.
        self._popular_cache_bucket_s = max(60, int(self._popular_cache_ttl_s))

        # A15/logging hygiene: warn about the missing recsys DSN once per
        # process at construction (above); track whether we've ALSO warned
        # at first actual use, so a client built once and reused for many
        # requests doesn't spam one WARNING per request forever, but a
        # caller who only greps logs around the failing request still sees it.
        self._warned_missing_recsys_dsn_on_use = False

    def _warn_missing_recsys_dsn_once(self) -> None:
        if not self._warned_missing_recsys_dsn_on_use:
            self._warned_missing_recsys_dsn_on_use = True
            logger.warning(
                "hafsql: network suppression query skipped — %s is not set",
                _RECSYS_DSN_ENV,
            )

    def _connect(self) -> psycopg.Connection[Any]:
        """Open a HAFSQL mirror connection. ``psycopg`` is imported lazily so
        this module is importable without the driver installed."""
        import psycopg

        conn = psycopg.connect(
            host=self._config.host,
            port=self._config.port,
            dbname=self._config.dbname,
            user=self._config.user,
            password=self._config.password,
            connect_timeout=self._config.connect_timeout,
            autocommit=True,
        )
        with conn.cursor() as cur:
            cur.execute(f"SET statement_timeout = {int(self._statement_timeout_ms)}")
        return conn

    def _recsys_connect(self) -> psycopg.Connection[Any]:
        """Open a connection to recsys's own DB (A15). Only ever called when
        ``self._recsys_dsn`` is truthy — callers must check first."""
        import psycopg

        assert self._recsys_dsn is not None  # narrows for mypy; caller-checked
        conn = psycopg.connect(self._recsys_dsn, connect_timeout=self._config.connect_timeout,
                                autocommit=True)
        with conn.cursor() as cur:
            cur.execute(f"SET statement_timeout = {int(self._statement_timeout_ms)}")
        return conn

    def _lite_params(self) -> dict[str, Any]:
        """Bound into EVERY query, including the ones that do not source lite
        content — `_SQL_COMMENTS_FOR_POSTS` needs them to EXCLUDE lite posts
        from a container's comment count and (G5) to RESOLVE lite commenters,
        and psycopg raises on an unbound placeholder rather than ignoring it.
        A key no query references is simply not consumed, which is why this can
        stay one dict for all of them."""
        return {
            "lite_publishers": sorted(self._lite.publisher_accounts),
            "lite_app": self._lite.app_id,
            "lite_container_prefix": _LITE_CONTAINER_PREFIX,
        }

    def _fetch_lite(
        self, sql: str, params: dict[str, Any], *, timeout_ms: int | None = None
    ) -> list[tuple[Any, ...]]:
        return self._fetch(sql, {**params, **self._lite_params()}, timeout_ms=timeout_ms)

    def _fetch(
        self, sql: str, params: dict[str, Any], *, timeout_ms: int | None = None
    ) -> list[tuple[Any, ...]]:
        """Execute one parameterized, read-only query against the HAFSQL
        mirror, on a pooled connection, and return all rows.

        ``timeout_ms`` overrides the client-wide
        ``HAFSQL_STATEMENT_TIMEOUT_MS`` FOR THIS QUERY ONLY. It exists because
        one process runs two workloads with opposite deadlines: the trust /
        author-prior BATCH may legitimately run for minutes (lowering the global
        is what stops the snapshot ever being written), while a REQUEST-PATH
        read must fail long before the frontend gives up. A per-call bound is
        the only way to hold both without a second client."""
        return self._fetch_via(self._pool, sql, params, timeout_ms=timeout_ms)

    def _fetch_recsys(self, sql: str, params: dict[str, Any]) -> list[tuple[Any, ...]]:
        """Execute one parameterized, read-only query against the recsys DB
        (A15), on its own pooled connection. Returns ``[]`` without opening a
        connection when no DSN is configured — the caller decides whether
        that absence is worth a WARNING (some callers, like
        ``suppressed_keys``, already logged one; others build an exclusion
        list where empty is silently the correct degrade)."""
        if not self._recsys_dsn:
            return []
        return self._fetch_via(self._recsys_pool, sql, params)

    def _fetch_via(
        self,
        pool: _ConnPool,
        sql: str,
        params: dict[str, Any],
        *,
        timeout_ms: int | None = None,
    ) -> list[tuple[Any, ...]]:
        import psycopg

        conn = pool.borrow()
        healthy = True
        try:
            with conn.cursor() as cur:
                # ★★★ RE-ASSERT statement_timeout PER QUERY (2026-08-06), not
                # once per physical connection as `_ConnPool` documents.
                #
                # FOUND BY RUNNING THE TRUST BATCH, and it is invisible any other
                # way. The public HAFSQL mirror sits behind a CONNECTION POOLER,
                # and `hafsql_public` carries a role-level
                # `statement_timeout=45s`. A `SET` issued at connection creation
                # is silently REVERTED once the connection goes idle — measured
                # directly: `SET statement_timeout = 900000` reads back as
                # `15min`, then reads back as `45s` after a 40s idle gap, and the
                # next long query is cancelled at exactly 45s.
                #
                # The batch's symptom was bizarre until this was understood: its
                # FIRST edge query survived 10m25s (it ran immediately after
                # connect, so the SET still held) while its SECOND died at 45s
                # (it ran after the first, i.e. after an idle gap, so the SET was
                # gone). Same process, same configured timeout, different
                # outcome — which reads like flakiness and is not.
                #
                # Re-asserting here costs one trivial round-trip per query and
                # makes `HAFSQL_STATEMENT_TIMEOUT_MS` mean what it says against a
                # pooled upstream. Without it the setting is decorative: a batch
                # that needs minutes silently gets 45 seconds and no trust
                # snapshot is ever written, so /feed FAIL_CLOSEs forever.
                #
                # ★ A PER-CALL `timeout_ms` OVERRIDES THE CLIENT-WIDE ONE, and
                # must be applied HERE for the same reason the re-assert exists
                # at all: the pooled upstream reverts whatever was set earlier,
                # so a bound applied anywhere but immediately before the query
                # is decorative. Connections are shared, so the override must
                # never leak to the next borrower — it does not, because every
                # query re-asserts its own value on the line below before it
                # runs, and a connection is only reused through this same path.
                effective_timeout_ms = (
                    self._statement_timeout_ms if timeout_ms is None else timeout_ms
                )
                cur.execute(f"SET statement_timeout = {int(effective_timeout_ms)}")
                cur.execute(sql, params)
                return cur.fetchall()
        except psycopg.OperationalError:
            # includes QueryCanceled (statement_timeout fired) — connection
            # may be compromised; don't return it to the pool. A plain
            # programming/data error (bad SQL, UndefinedTable, ...) does NOT
            # poison an autocommit session (verified live) and is re-raised
            # with `healthy` left True, so the connection is still reused.
            healthy = False
            raise
        finally:
            pool.release(conn, healthy=healthy)

    def _votes_for_posts(
        self, authors: list[str], permlinks: list[str]
    ) -> dict[tuple[str, str], list[Vote]]:
        rows = self._fetch_lite(_SQL_VOTES_FOR_POSTS, {"authors": authors, "permlinks": permlinks})
        grouped: dict[tuple[str, str], list[Vote]] = {}
        for author, permlink, voter, rshares, timestamp in rows:
            grouped.setdefault((author, permlink), []).append(
                # break #7 (verified live 2026-08-04, crashes at normalize.py:27
                # — log_compress does `abs(rshares) / floor` and Decimal/float
                # raises TypeError): `rshares` is Postgres `numeric`, so psycopg
                # returns `decimal.Decimal`, but `Vote.rshares` is `int` and
                # nothing coerced it. Cast at the boundary, once.
                # `timestamp` is also naive (`timestamp WITHOUT time zone`,
                # verified live) — coerce it too, at the same boundary, for the
                # same reason `_edge_counts` below must: every consumer that
                # will ever diff a HAFSQL timestamp against `now` assumes aware.
                Vote(voter=voter, rshares=int(rshares), timestamp=_as_aware(timestamp))
            )
        return grouped

    def _comments_for_posts(
        self, authors: list[str], permlinks: list[str]
    ) -> dict[tuple[str, str], dict[str, int]]:
        """Per-post commenter attribution: ``{key: {commenter: comment_count}}``.

        ★ G5: ``commenter`` is the RESOLVED identity — a lite writer's
        ``lumen_user_id`` when the comment was published through a configured
        publisher account, else the chain author. The dict KEY is still the
        chain ``(author, permlink)``, which is what the rows are stored under.
        """
        rows = self._fetch_lite(
            _SQL_COMMENTS_FOR_POSTS, {"authors": authors, "permlinks": permlinks}
        )
        grouped: dict[tuple[str, str], dict[str, int]] = {}
        for author, permlink, commenter, count in rows:
            grouped.setdefault((author, permlink), {})[commenter] = count
        return grouped

    def _rebloggers_for_posts(
        self, authors: list[str], permlinks: list[str]
    ) -> dict[tuple[str, str], tuple[str, ...]]:
        """Per-post reblogger attribution: ``{key: (distinct account names)}``."""
        rows = self._fetch_lite(
            _SQL_REBLOGGERS_FOR_POSTS, {"authors": authors, "permlinks": permlinks}
        )
        grouped: dict[tuple[str, str], set[str]] = {}
        for author, permlink, account in rows:
            grouped.setdefault((author, permlink), set()).add(account)
        return {key: tuple(sorted(accounts)) for key, accounts in grouped.items()}

    def reputations_for(self, accounts: Sequence[str]) -> dict[str, float]:
        """DISPLAY reputation (the 25-75 scale people see) for any identity set.

        ★ 2026-08-09: the popularity lane weights each commenter/reblogger by
        reputation (owner's ">=60 rep" rule), and those identities are not the
        authors of the posts being scored, so `_reputations_for_authors` could
        not answer for them.

        ★★★ RETURNS DISPLAY, NOT RAW — and this is the whole reason the method
        exists rather than the caller using `_reputations_for_authors` directly.
        `hafsql.reputations.reputation` is the RAW integer, which runs to
        billions; a caller comparing it against 60 would find EVERY account
        above the bar, making the tilt a uniform constant that cancels out of a
        relative score entirely. The owner's rule would have been decoration.
        `_reputation_display` is the hivemind-equivalent transform, and the
        number 60 only means anything on that scale.

        Empty input short-circuits, so an unhydrated pool costs no round trip.
        """
        names = list({a for a in accounts if a})
        if not names:
            return {}
        return {
            name: _reputation_display(raw)
            for name, raw in self._reputations_for_authors(names).items()
        }

    def _reputations_for_authors(self, authors: list[str]) -> dict[str, int]:
        rows = self._fetch_lite(_SQL_REPUTATIONS_FOR_AUTHORS, {"authors": authors})
        return dict(rows)

    def _hydrate(self, rows: list[tuple[Any, ...]]) -> list[Post]:
        """Batch-fetch votes/commenters/rebloggers/reputation for a page of
        posts — comment and reblog identity included, so every hydrated post is
        an :class:`AttributedPost` the organic term can exclusion-filter."""
        if not rows:
            return []
        authors = [row[0] for row in rows]
        permlinks = [row[1] for row in rows]
        votes = self._votes_for_posts(authors, permlinks)
        comments = self._comments_for_posts(authors, permlinks)
        rebloggers = self._rebloggers_for_posts(authors, permlinks)
        reputations = self._reputations_for_authors(list(dict.fromkeys(authors)))
        lite_rebloggers: dict[tuple[str, str], tuple[str, ...]] = {}
        self._merge_lite_engagement(
            votes, lite_rebloggers, list(zip(authors, permlinks, strict=True))
        )
        return [
            _build_post(row, votes, comments, rebloggers, reputations, lite_rebloggers)
            for row in rows
        ]

    def _merge_lite_engagement(
        self,
        votes: dict[tuple[str, str], list[Vote]],
        lite_rebloggers: dict[tuple[str, str], tuple[str, ...]],
        keys: list[tuple[str, str]],
    ) -> None:
        """★★★ L2 (2026-08-05) — fold in engagement cast by LITE accounts.

        Done HERE, in `_hydrate`, because it is the single choke point every
        post-returning method already passes through, so every lane picks lite
        engagement up at once and none can be forgotten. (This project's
        recurring defect is a mechanism wired in one path and silently missing
        from another; one choke point is the structural answer to that.)

        Lite engagement is confined to hydration on purpose — it never reaches
        `engagement_edges`, so free identities can never build graph-cred or
        confer vouch. See `recsys.io.lite_engagement` and `Vote.lite`.

        Mutates in place, additively: a lite vote is appended to whatever chain
        votes the post already has, never replacing them, and a lite reblogger
        is unioned into the attributed set. Both no-op when the DSN is unset.
        """
        if not self._lite.engagement_enabled:
            return
        from recsys.io import lite_engagement

        for key, lite_votes in lite_engagement.fetch_lite_votes(self._lite, keys).items():
            votes.setdefault(key, []).extend(lite_votes)
        for key, names in lite_engagement.fetch_lite_rebloggers(self._lite, keys).items():
            # ★ ROUND-4: into `lite_rebloggers`, NEVER merged into `rebloggers`.
            # Merged, they were indistinguishable bare names and the need bands
            # counted free reblogs at full value — see `AttributedPost`.
            lite_rebloggers[key] = tuple(sorted(names))

    def in_network_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Post]:
        """Recent top-level posts by followed accounts (§7)."""
        if not follows:
            return []
        # break #1 (verified live 2026-08-04): `_SQL_IN_NETWORK_POSTS` bakes in
        # `_top_level_or_lite()`'s `%(lite_publishers)s`/`%(lite_app)s`
        # placeholders at import time — they must be bound even with lite off,
        # or psycopg raises `query parameter missing`. Must be `_fetch_lite`.
        rows = self._fetch_lite(
            _SQL_IN_NETWORK_POSTS, {"authors": list(follows), "since": since, "limit": limit}
        )
        return self._hydrate(rows)

    def engaged_oon_posts(
        self, follows: frozenset[str], since: datetime, limit: int
    ) -> list[Candidate]:
        """Out-of-network posts an in-network account voted, reblogged, or replied
        to — the second-degree engagement pool (§8.1)."""
        if not follows:
            return []
        # break #2 (verified live 2026-08-04): same cause as break #1 above.
        rows = self._fetch_lite(
            _SQL_ENGAGED_OON_POSTS, {"follows": list(follows), "since": since, "limit": limit}
        )
        return [
            Candidate(post=post, source=CandidateSource.OON_ENGAGED)
            for post in self._hydrate(rows)
        ]

    def tag_posts(self, tags: frozenset[str], since: datetime, limit: int) -> list[Post]:
        """Recent posts carrying any of the given tags (§13.1)."""
        if not tags:
            return []
        rows = self._fetch_lite(
            _SQL_TAG_POSTS, {"tags": list(tags), "since": since, "limit": limit}
        )
        return self._hydrate(rows)

    def window_posts(self, since: datetime, limit: int) -> list[Post]:
        """A5: ALL (top-level + lite) posts created since ``since``, ordered by
        RECENCY ONLY — the :class:`~recsys.contracts.NormContext` sample
        source. See ``_SQL_WINDOW_POSTS`` for why this must not be
        engagement-ordered like ``popular_posts``.

        ★ COST IS NOT FLAT WITH WINDOW SIZE, and the row count alone
        understates it — see ``_SQL_WINDOW_POSTS`` for the measured breakdown.
        The row fetch is cheap at any window tested (3d/7d both well under
        1s); HYDRATION (this method always hydrates, via ``_hydrate``) is
        dominated by total VOTE volume in the window, and a live 7-day call
        (~8,887 posts, 1.23M votes) TIMES OUT under the default
        ``statement_timeout`` (~19.5s in ``_votes_for_posts`` alone, against a
        15s default). Only a 3-day window has been measured to complete
        (~8.8s). Call this from a cached/periodic builder (A5.2), never
        per-request, and re-measure before widening the window it is called
        with."""
        rows = self._fetch_lite(_SQL_WINDOW_POSTS, {"since": since, "limit": limit})
        return self._hydrate(rows)

    def engagement_edges(self, since: datetime) -> list[EngagementEdge]:
        """Directed RealGraph engagement summary since ``since`` (§8.3).

        ★ L1 (2026-08-05): with lite publishers configured, edge DESTINATIONS
        resolve through `lumen_user_id` so a lite writer accrues their own
        graph-cred instead of donating it to the publisher account. Sources are
        deliberately NOT resolved — see the SQL block's own comment.
        """
        lite_params = (
            {
                "lite_publishers": sorted(self._lite.publisher_accounts),
                "lite_app": self._lite.app_id,
            }
            if self._lite.enabled
            else None
        )
        reply_sql = _SQL_REPLY_EDGES_WITH_LITE if lite_params else _SQL_REPLY_EDGES
        upvote_sql = _SQL_UPVOTE_EDGES_WITH_LITE if lite_params else _SQL_UPVOTE_EDGES
        reblog_sql = _SQL_REBLOG_EDGES_WITH_LITE if lite_params else _SQL_REBLOG_EDGES
        replies = self._edge_counts(reply_sql, since, lite_params)
        upvotes = self._edge_counts(upvote_sql, since, lite_params)
        reblogs = self._edge_counts(reblog_sql, since, lite_params)
        keys = sorted(set(replies) | set(upvotes) | set(reblogs))
        edges = []
        for src, dst in keys:
            r_count, r_ts = replies.get((src, dst), (0, None))
            u_count, u_ts = upvotes.get((src, dst), (0, None))
            b_count, b_ts = reblogs.get((src, dst), (0, None))
            # The reverse pair's own timestamp — dst's reply BACK to src — must
            # feed last_interaction too, or a fresh reply-back gets decayed on
            # the stale forward reply's date (§8.3 recency bug).
            rb_count, rb_ts = replies.get((dst, src), (0, None))
            edges.append(
                EngagementEdge(
                    src=src,
                    dst=dst,
                    replies=r_count,
                    reply_backs=rb_count,
                    upvotes=u_count,
                    reblogs=b_count,
                    last_interaction=_latest(r_ts, u_ts, b_ts, rb_ts),
                )
            )
        return edges

    def _edge_counts(
        self,
        sql: str,
        since: datetime,
        extra: Mapping[str, object] | None = None,
    ) -> dict[tuple[str, str], tuple[int, datetime | None]]:
        """`_edge_counts` over a window split into slices, results merged.

        ★★★ WHY THIS EXISTS — THE 90-DAY WALL IS A QUERY PLAN, NOT A LIMIT.
        `deploy/trust-batch-defaults.env`, measured 2026-08-14: a 365-day edge
        window "cannot complete at all (cancelled at 900s, and again at 3600s)
        — the planner flips from a per-block Nested Loop to a Merge Join that
        index-scans every comment operation ever made. 90 days completed in
        29.7s." So production runs `--since-days 90`, and the LIVE interaction
        graph reaches back exactly 90 days: measured 2026-08-24, the oldest
        `last_interaction` across all 2,618,664 edges is 90 days, and there are
        ZERO edges beyond 120. A relationship older than that is not decayed,
        it is ABSENT.
        
        Each slice is small enough to keep the good plan. Measured on the live
        mirror, reply edges: 0-90d 655,908 rows / 24.2s, 90-180d 983,069 /
        30.8s, 180-270d 1,609,930 / 21.0s — where the single unchunked query
        never finished at all.

        ★ WHY NOT AN ACCUMULATOR. A running decayed total (the pattern X uses)
        was specced and killed by three independent reviews. It would store
        PRE-DECAYED counts into fields that four consumers still decay at read
        time (`graph_cred`, `ring`, `als`, `viewer_affinity`), halving the
        effective half-life forever; it would erode the integer self-dealing
        SCALE gate (`min_ring_self_dealing_events`) purely by aging, making
        trust cheaper to keep; and its own recovery path reuses the windowed
        query, so every rebuild would reset to 90 days anyway. Chunking keeps
        the graph a PURE FUNCTION OF THE CHAIN — no watermark, no fold, no
        drift, no concurrent-run race, integers stay integers, and bans stay
        retroactive. See ACCUMULATOR-SPEC.md for the full verdict.

        ★ IDENTICAL RESULTS, NOT MERELY SIMILAR. Counts sum and timestamps take
        the max, which is exactly what one grouped query over the whole span
        computes — `COUNT(*)` and `MAX(timestamp)` are both decomposable over a
        partition. The slices are half-open and contiguous, so no interaction is
        counted twice or missed. With a window at or under one slice this makes
        exactly one query with an effectively-unbounded upper bound, which is
        byte-for-byte today's behaviour.
        """
        slice_days = self._config.edge_slice_days
        now_ts = datetime.now(UTC)
        # ★ THE NEWEST SLICE KEEPS AN OPEN TOP. The queries had no upper bound
        # before this change, so rows written while the query runs were included;
        # a far horizon on the final slice preserves that exactly. Slice
        # BOUNDARIES are measured against `now_ts`, not the horizon — using the
        # horizon made a 90-day window span 91 days and issue TWO queries, which
        # silently broke the property that today's production window is a single
        # query byte-for-byte.
        horizon = now_ts + timedelta(days=1)
        # ★ WHOLE DAYS, not a raw timedelta. `now_ts` is sampled here while the
        # caller sampled its own `now` moments earlier, so a nominally 90-day
        # window is 90 days plus microseconds — enough to tip a `<=` comparison
        # and issue two queries where production expects one.
        if slice_days <= 0 or (now_ts - since).days <= slice_days:
            return self._edge_counts_slice(sql, since, extra, horizon)

        merged: dict[tuple[str, str], tuple[int, datetime | None]] = {}
        lo = since
        while lo < now_ts:
            hi = min(lo + timedelta(days=slice_days), now_ts)
            # ★ NEVER LOOP WITHOUT ADVANCING (2026-08-24). Found by mutation:
            # an edit that made the slices overlap did not fail an assertion, it
            # HUNG — once `hi` clamps to `top` and `lo` sits below it, a
            # non-advancing step spins forever, inside the weekly trust batch,
            # holding a mirror connection. A batch that never returns is worse
            # than one that returns wrong: nothing times out at this layer and
            # the cron's own retry never fires because the process never exits.
            if hi <= lo:
                break
            # The final slice takes the open horizon, every earlier one its own
            # exact upper bound, so the slices stay contiguous and half-open.
            until = horizon if hi >= now_ts else hi
            for key, (count, ts) in self._edge_counts_slice(sql, lo, extra, until).items():
                prev_count, prev_ts = merged.get(key, (0, None))
                merged[key] = (prev_count + count, _latest(prev_ts, ts))
            lo = hi
        return merged

    def _edge_counts_slice(
        self,
        sql: str,
        since: datetime,
        extra: Mapping[str, object] | None = None,
        until: datetime | None = None,
    ) -> dict[tuple[str, str], tuple[int, datetime | None]]:
        params: dict[str, object] = {
            "since": since,
            "until": until if until is not None else datetime.now(UTC) + timedelta(days=1),
        }
        if extra:
            params.update(extra)
        rows = self._fetch(sql, params)
        # break #8 (verified live 2026-08-04): `operation_effective_comment_
        # vote_view.timestamp` and `reblogs.created_at` are naive (`timestamp
        # WITHOUT time zone`); `EngagementEdge.last_interaction` is compared
        # against a tz-aware `now` downstream (pipeline.py:293, graph_cred.py:
        # 125, ring.py:58, als.py:127) and a naive/aware subtraction raises
        # `TypeError`. `operation_comment_view.timestamp` (reply edges, break
        # #6) is naive too — same fix applies to all three edge queries here.
        return {
            (src, dst): (count, _as_aware(last_ts) if last_ts is not None else None)
            for src, dst, count, last_ts in rows
        }

    # ★★★ `stake_lineage` REMOVED 2026-08-05 (B2), along with
    # `_SQL_STAKE_LINEAGE`. Hive's `delegate_vesting_shares` needs no consent
    # from the delegatee, so this query returned an ATTACKER-WRITABLE relation
    # and the algorithm must not be able to fetch it at all — the method is
    # deleted rather than left returning empty, so no future caller can
    # accidentally reintroduce the input. Full rationale, with the measured
    # damage and why no other funding relation replaces it, is on
    # `recsys.pipeline._lineage_for`, which is now the single seam for a
    # consent-bearing identity relation.

    def second_degree_engagers(
        self,
        post_keys: frozenset[str],
        follows: frozenset[str],
        *,
        chain_authors: Mapping[str, str] | None = None,
    ) -> dict[str, frozenset[str]]:
        """For each OON post key, which of the viewer's ``follows`` voted,
        replied to, or reblogged it (§8.1) — the engager index the
        second-degree gate checks vouches against.

        A12: ``chain_authors`` (``Post.key -> chain_author``, build with
        :func:`chain_author_map`) resolves a lite post's ranked key to the
        chain identity votes/replies/reblogs are actually recorded against
        before querying; the returned dict is keyed back onto the ORIGINAL
        (ranked) key, so ``filter_eligible``'s
        ``engager_index.get(post.key)`` (``core/second_degree.py``) needs no
        change. ``None`` (the default) is byte-identical to the pre-A12
        behaviour."""
        if not post_keys or not follows:
            return {}
        authors, permlinks, reverse = _resolve_post_keys(post_keys, chain_authors)
        rows = self._fetch(
            _SQL_SECOND_DEGREE_ENGAGERS,
            {"authors": authors, "permlinks": permlinks, "follows": list(follows)},
        )
        grouped: dict[str, set[str]] = {}
        for author, permlink, engager in rows:
            ranked_key = reverse.get((author, permlink), f"@{author}/{permlink}")
            grouped.setdefault(ranked_key, set()).add(engager)
        return {key: frozenset(engagers) for key, engagers in grouped.items()}

    def follow_graph(self, accounts: frozenset[str]) -> dict[str, frozenset[str]]:
        """follower -> followees among ``accounts`` (§8.3), for graph-cred."""
        if not accounts:
            return {}
        rows = self._fetch_lite(_SQL_FOLLOW_GRAPH, {"accounts": list(accounts)})
        grouped: dict[str, set[str]] = {}
        for follower, following in rows:
            grouped.setdefault(follower, set()).add(following)
        return {follower: frozenset(followees) for follower, followees in grouped.items()}

    def _refresh_popular_posts(self, key: tuple[int, int], since: datetime, limit: int) -> None:
        """Off-request refill for :meth:`popular_posts`. Never raises into a caller:
        it runs on a daemon thread with no one to catch it, and a failed refresh
        must leave the existing stale entry in place rather than clear it."""
        try:
            rows = self._fetch_lite(
                _SQL_POPULAR_POSTS,
                {"since": since, "limit": limit, "per_author": _POPULAR_MAX_PER_AUTHOR},
            )
            posts = self._hydrate(rows)
            with self._popular_cache_lock:
                self._popular_cache[key] = (time.monotonic(), posts)
        except Exception:
            logger.exception("popular_posts: background refresh failed; serving the stale entry")
        finally:
            with self._popular_cache_lock:
                self._popular_refreshing.discard(key)

    def popular_posts(self, since: datetime, limit: int) -> list[Post]:
        """Community-popular fallback for the fully-cold viewer (§13.5b), ranked
        by our own positive-engagement signals — never payout indexing.

        A4.4: viewer-independent (no viewer argument) and on the hot path for
        almost every request (`_fallback_filler`'s early-out is `len(eligible)
        >= top_k=200`) — measured 5.9s per call live. Cached process-wide,
        keyed on ``since`` bucketed to a coarse granularity (so requests whose
        ``since`` differs only by the microseconds between two `now()` calls
        still hit) and ``limit``, with a TTL well under any plausible sourcing
        window. A cache MISS still queries with the caller's exact ``since``,
        never the bucketed one — bucketing only affects the cache KEY."""
        bucket = int(since.timestamp() // self._popular_cache_bucket_s)
        key = (bucket, limit)
        now = time.monotonic()
        with self._popular_cache_lock:
            cached = self._popular_cache.get(key)
            if cached is not None and now - cached[0] < self._popular_cache_ttl_s:
                return cached[1]
            # ★★★ STALE-WHILE-REVALIDATE: A READER MUST NEVER PAY FOR A REFILL
            # (2026-08-16, owner).
            #
            # Fixing the cache KEY earlier today stopped this query running once a
            # minute, but it did not change who pays when it does run: the unlucky
            # request that arrives first after the TTL lapses still blocked on the
            # full query. Measured on this box the same day: warm calls 1.42s /
            # 1.42s / 1.82s, then a single call after a 5 minute idle took 15.2s.
            # One reader eating 15s so everyone else gets 1.4s is not a trade this
            # data justifies -- it is global popularity, identical for every
            # viewer, and the TTL already declares that minutes-old is acceptable.
            #
            # So a stale entry is SERVED immediately and refreshed off the request
            # path. `_popular_refreshing` guards against N concurrent readers each
            # starting their own refresh for the same key; the winner clears it in
            # `finally` so a failed refresh cannot wedge the key forever (the next
            # reader simply tries again, still on stale data meanwhile).
            #
            # Absent entirely (cold process, first ever call) still blocks: there is
            # nothing stale to serve, and returning empty would silently drop the
            # popular lane rather than make someone wait once.
            # ★ THE KEY ROTATES, SO "STALE" IS USUALLY A DIFFERENT KEY (2026-08-16,
            # second pass, caught by measuring rather than by the unit tests).
            #
            # `since` is rolling and the bucket is TTL-wide, so after idling past
            # the TTL a reader lands on a bucket that has NO entry at all. Serving
            # "the stale value for this key" therefore did nothing in the case it
            # was written for: measured live, a read 330s after priming still cost
            # 9.75s. The unit tests missed it because they reuse one key.
            #
            # What is actually wanted is the newest answer for this LIMIT, whatever
            # bucket produced it. The data is global popularity over a multi-day
            # window: a neighbouring bucket differs by minutes of `since` on a
            # window measured in days, which is far inside what the TTL already
            # declares acceptable. `_popular_max_stale_s` bounds how old that
            # borrowed answer may be, so an idle process cannot serve something
            # from hours ago forever.
            fallback = cached
            if fallback is None:
                newest_ts, newest_posts = -1.0, None
                for (b, lim), (ts, posts) in self._popular_cache.items():
                    if lim == limit and ts > newest_ts:
                        newest_ts, newest_posts = ts, posts
                if newest_posts is not None and now - newest_ts < self._popular_max_stale_s:
                    fallback = (newest_ts, newest_posts)
            if fallback is not None:
                if key not in self._popular_refreshing:
                    self._popular_refreshing.add(key)
                    threading.Thread(
                        target=self._refresh_popular_posts,
                        args=(key, since, limit),
                        name=f"popular-refresh-{bucket}-{limit}",
                        daemon=True,
                    ).start()
                return fallback[1]
        # ★ 2026-08-08: `per_author` bounds ONE author's share of the recall
        # set — see `_SQL_POPULAR_POSTS`'s note. 2, so filling a 150-row recall
        # needs 75 distinct authors rather than one account posting every five
        # minutes. Not 1: a genuinely huge day for one author (a post and its
        # follow-up) is real and should not be silently halved.
        rows = self._fetch_lite(
            _SQL_POPULAR_POSTS,
            {"since": since, "limit": limit, "per_author": _POPULAR_MAX_PER_AUTHOR},
        )
        posts = self._hydrate(rows)
        with self._popular_cache_lock:
            self._popular_cache[key] = (now, posts)
        return posts

    def author_first_post(
        self, authors: frozenset[str], *, horizon_days: int, now: datetime | None = None
    ) -> dict[str, datetime]:
        """First-post date for each of ``authors`` that is NEWER than
        ``horizon_days`` — the NEWNESS predicate
        (:data:`_SQL_AUTHOR_FIRST_POST`, 2026-08-08).

        Keyed on the RANKED identity, like :meth:`author_engagement`, so a Lumen
        Lite writer's ``lumen_user_id`` resolves to their first LITE post rather
        than to the shared publisher account's history — otherwise every lite
        newcomer would inherit the publisher's age and be refused the lane on
        day one. That is why the query keeps two explicit branches instead of
        one COALESCE: see :data:`_SQL_AUTHOR_FIRST_POST`.

        ``horizon_days`` MUST be the caller's
        :attr:`~recsys.config.ExplorationConfig.max_author_age_days`. The scan
        floor is derived from it (plus
        :data:`_FIRST_POST_FLOOR_MARGIN_DAYS`), so the SQL bound and the
        predicate it feeds cannot drift apart — passing a smaller value here
        than the caller tests against would silently refuse authors the config
        says are eligible. ``<= 0`` means the predicate is off and there is
        nothing to ask.

        ★ RETURNS ONLY THE NEW. An author with any top-level post older than the
        floor is deliberately ABSENT rather than carrying an old timestamp: the
        query proves oldness with an early-terminating existence check instead
        of aggregating a full history, which is what takes this from 311s to
        0.25s. Absence already means "refuse the seat" to the caller
        (fail-closed), so the served verdict is unchanged — live-verified
        identical to the unbounded query on 972 real identities.

        ★ BOUNDED IN TIME. Runs under :data:`_FIRST_POST_TIMEOUT_MS`, not the
        900s client-wide batch bound, so a slow mirror forfeits ONE SLOT in
        bounded time instead of hanging a whole page — see
        :meth:`_fetch`.
        """
        if not authors or horizon_days <= 0:
            return {}
        floor = (now or datetime.now(UTC)) - timedelta(
            days=horizon_days + _FIRST_POST_FLOOR_MARGIN_DAYS
        )
        # `_fetch_lite`, not `_fetch`: the query carries the
        # `%(lite_publishers)s` / `%(lite_app)s` placeholders, so psycopg raises
        # `query parameter missing` unless they are bound — the same trap
        # `author_engagement` documents at its own call site.
        rows = self._fetch_lite(
            _SQL_AUTHOR_FIRST_POST,
            {"authors": list(authors), "floor": floor},
            timeout_ms=_FIRST_POST_TIMEOUT_MS,
        )
        return {
            str(identity): _as_aware(first) for identity, first in rows if first is not None
        }

    def author_engagement(
        self,
        authors: frozenset[str],
        since: datetime,
        excluded: Mapping[str, frozenset[str]] | None = None,
        *,
        trust: VoterTrust | None = None,
    ) -> dict[str, AuthorEngagement]:
        """Author-pooled window aggregate (§6), §8.4-exclusion-filtered AND
        (H05) breadth-budgeted (``_SQL_AUTHOR_ENGAGEMENT``).

        ``authors`` is matched against the RANKED identity (A11: a lite
        writer's ``lumen_user_id`` where present, else the chain author, via
        ``_identity(c)``) — pass whatever identity ``Post.author`` carries for
        the posts in question, the same identity ``pooled_author_base``/
        ``organic_quality_raw`` score against, not necessarily a real Hive
        account name.

        ``excluded`` maps each author to the identities (stake lineage + ring +
        self) whose engagement must NOT count toward that author's pooled prior;
        the query anti-joins each author's voters/commenters/rebloggers against
        their own set, so no author can inflate ``total_base`` with the same
        alts/ring the vote signal already discounts on ``own_base``. ``None`` (or
        an author absent from it) applies self-exclusion only. Authors with no
        window post are simply absent from the result, which the caller reads as
        "no prior".

        ``trust`` (H05) is the SAME :class:`~recsys.core.vote_signal.VoterTrust`
        the scorer builds per request (``recsys.pipeline._voter_trust``); its
        ``vouched``/``unknown_free``/``unknown_per_vouched`` are passed to the
        query so each window post's surviving voters/commenters/rebloggers are
        credited ``vouched + budgeted(unknown)`` — exactly
        :meth:`~recsys.core.vote_signal.VoterTrust.credited_breadth` — BEFORE
        being summed into ``total_base``. Without exclusion alone, an author's
        OTHER window posts could still be farmed by unknown-tier sock upvotes
        that pass every §8.4 exclusion; this closes that. ``trust=None`` (no
        trust snapshot) sends ``vouched=[]``, an effectively-infinite
        ``unknown_free`` and ``unknown_per_vouched=0`` so the budget clause
        never binds and the query collapses to the raw distinct count — the
        same one query serves both the trusted and no-snapshot cases. See
        :class:`recsys.core.scoring.AuthorPriorGateway`."""
        if not authors:
            return {}
        excl_authors: list[str] = []
        excl_accounts: list[str] = []
        for author, accounts in (excluded or {}).items():
            for account in accounts:
                if account == author:
                    continue  # self is already excluded by the `<> c.author` predicate
                excl_authors.append(author)
                excl_accounts.append(account)
        if trust is None:
            vouched: list[str] = []
            unknown_free: float = _UNBUDGETED_UNKNOWN_FREE
            unknown_per_vouched: float = 0.0
        else:
            vouched = list(trust.vouched)
            unknown_free = trust.unknown_free
            unknown_per_vouched = trust.unknown_per_vouched
        # A15: FIRST round trip, to the recsys DB — which of these authors'
        # posts are already suppressed (§8.7)? See the comment above
        # `_SQL_AUTHOR_ENGAGEMENT` for why this cannot be a single query. No
        # DSN configured -> empty arrays -> the mirror query's anti-join
        # matches nothing -> "nothing suppressed", the documented degrade.
        if self._recsys_dsn:
            supp_rows = self._fetch_recsys(_SQL_SUPPRESSED_BY_AUTHORS, {"authors": list(authors)})
        else:
            self._warn_missing_recsys_dsn_once()
            supp_rows = []
        supp_authors = [row[0] for row in supp_rows]
        supp_permlinks = [row[1] for row in supp_rows]
        # SECOND round trip, to the mirror — the actual aggregate. A11: now
        # `_fetch_lite`, not `_fetch` — `_top_level_or_lite(c)` bakes in the
        # `%(lite_publishers)s`/`%(lite_app)s` placeholders at import time
        # (the same class of bug as A2 breaks #1/#2), so they must be bound
        # even with lite off or psycopg raises `query parameter missing`.
        rows = self._fetch_lite(
            _SQL_AUTHOR_ENGAGEMENT,
            {
                "authors": list(authors),
                "since": since,
                "excl_authors": excl_authors,
                "excl_accounts": excl_accounts,
                "vouched": vouched,
                "unknown_free": unknown_free,
                "unknown_per_vouched": unknown_per_vouched,
                "supp_authors": supp_authors,
                "supp_permlinks": supp_permlinks,
            },
        )
        return {
            author: AuthorEngagement(posts=int(posts), total_base=float(total_base or 0.0))
            for author, posts, total_base in rows
        }

    def suppressed_keys(
        self, post_keys: frozenset[str], *, chain_authors: Mapping[str, str] | None = None
    ) -> frozenset[str]:
        """Subset of ``post_keys`` under network suppression (§8.7).

        A15: ``network_suppression`` lives in the recsys DB (A15's own second
        connection), not the HAFSQL mirror. No DSN configured -> nothing is
        ever reported suppressed (a WARNING is logged once, not a crash) —
        the documented degrade until the recsys DB is wired up.

        A12: ``chain_authors`` (``Post.key -> chain_author``, build with
        :func:`chain_author_map`) resolves a lite post's ranked key to the
        chain identity a §8.7 report is actually filed against (the publisher
        account, not the writer) before querying, and the returned set is
        keyed back onto the ORIGINAL (ranked) key — ``filter_eligible``'s
        ``post.key in suppressed`` (``core/second_degree.py``) needs no
        change. ``None`` (the default) is byte-identical to the pre-A12
        behaviour."""
        if not post_keys:
            return frozenset()
        if not self._recsys_dsn:
            self._warn_missing_recsys_dsn_once()
            return frozenset()
        authors, permlinks, reverse = _resolve_post_keys(post_keys, chain_authors)
        rows = self._fetch_recsys(
            _SQL_SUPPRESSED_KEYS, {"authors": authors, "permlinks": permlinks}
        )
        return frozenset(
            reverse.get((author, permlink), f"@{author}/{permlink}") for author, permlink in rows
        )
