"""L2 — Lumen Lite engagement: votes and reblogs cast by lite accounts.

★★★ WHY THIS EXISTS. A lite user (Gmail/BTC/EVM signup, no Hive keys) cannot
vote on chain: a Hive vote is attributed to the SIGNING account, so proxying one
through the frontend account would collapse every lite user into a single voter.
The app therefore records their engagement in its own Postgres —
``lumen_vote`` / ``lumen_reblog`` (`0009_engagement.sql`), whose own comment
states the intent: *"feeds the recsys/feed"*. That seam was built and never
consumed, so until now a lite user's likes changed nothing at all.

WHAT THIS IS ALLOWED TO DO, and the boundary that makes it safe:

* It feeds **post hydration only**. Lite engagement never reaches
  ``engagement_edges``, so it can never build graph-cred, never propagate vouch,
  never influence ring detection. Edges are chain-only, and chain actions cost
  RC and stake. A free identity writing into the trust graph is the "free vouch
  printer" this design exists to avoid.
* A lite vote enters as :attr:`recsys.contracts.Vote.lite`, which counts for
  ORGANIC BREADTH (a distinct person) and is excluded from the §4 STAKE signal
  entirely. See that field's own docstring for why, and
  ``core/vote_signal.py`` for both halves.
* Lite voters are unknown identities, so ``VoterTrust.credited_breadth``'s
  existing ``unknown_free`` budget bounds them — CONDITIONALLY, and the
  condition matters: the bound is ``unknown_free + unknown_per_vouched *
  (vouched engagers)``, so "50 lite accounts buy one unit" holds only with NO
  vouched engager on the post. With vouched engagers it grows (measured 31.0 at
  10 vouched, 300.0 with a follow graph). No new defence was invented for this; the
  one that already bounds funded alts does the work.

RETRACTION IS PART OF THE CONTRACT, not a later refinement. Both tables
soft-delete (``active = false``) and bump ``seq``. A vote that cannot be
withdrawn is a griefing tool, so every query here filters on ``active``.

DEGRADE. ``LiteConfig.engagement_dsn`` is optional. Absent, this module returns
nothing and says so once at WARNING — the same posture A15 network-suppression
takes for its own optional connection. It never raises into a feed request: a
lite datastore being unreachable must cost engagement signal, not the page.

``psycopg`` is imported lazily inside the functions that connect, matching
``recsys.io.hafsql``'s discipline, so importing this module never requires the
``io`` extra.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime

from recsys.config import LiteConfig
from recsys.contracts import Vote

logger = logging.getLogger(__name__)

PostKey = tuple[str, str]

#: Only positive weight counts. Hive convention is -10000..10000 and this
#: project's rule is unambiguous (`Vote`'s own docstring, rev 2.1): downvotes
#: never affect ranking. A lite downvote is recorded by the app for the user's
#: own feed hygiene; it is not a ranking input.
_MIN_WEIGHT = 0

# ★★★ THE KEY PREDICATE, and it is written this way because the obvious form is
# DEAD. `(target_author, target_permlink) = ANY(%(keys)s)` with a list of tuples
# raises, at bind time, against a real PostgreSQL:
#
#     FeatureNotSupported: input of anonymous composite types is not implemented
#
# It was shipped, and every test in `tests/test_lite_engagement.py` monkeypatched
# `_connect`, so the SQL had never touched a database — the EXACT defect this
# project has now hit four separate times ("the I/O layer had never executed
# once"), reproduced by the author of the fix for it. Worse, the broad `except`
# below would have swallowed it into a WARNING on every request, forever: L2
# would have been silently inert in production with a green test suite.
#
# `unnest` over two PARALLEL TEXT ARRAYS is the supported construct — psycopg
# binds `text[]` natively, so there is no anonymous composite anywhere. Verified
# by execution against a real PostgreSQL, and pinned by
# `test_the_shipped_sql_executes_against_a_real_postgres`, which runs THESE
# CONSTANTS rather than a copy.
_SQL_LITE_VOTES = """
SELECT target_author, target_permlink, voter_user_id, updated_at
FROM lumen_vote
WHERE active = true
  AND weight > %(min_weight)s
  AND (target_author, target_permlink) IN (
      SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[]))
"""

_SQL_LITE_REBLOGS = """
SELECT target_author, target_permlink, reblogger_user_id
FROM lumen_reblog
WHERE active = true
  AND (target_author, target_permlink) IN (
      SELECT * FROM unnest(%(authors)s::text[], %(permlinks)s::text[]))
"""


def _key_params(keys: list[PostKey]) -> dict[str, list[str]]:
    """Split `(author, permlink)` pairs into the two parallel arrays the SQL
    binds. Order is load-bearing — `unnest(a, b)` pairs them positionally — so
    both lists are built in ONE pass over the same sequence."""
    return {
        "authors": [author for author, _ in keys],
        "permlinks": [permlink for _, permlink in keys],
    }


def _connect(dsn: str):  # type: ignore[no-untyped-def]
    import psycopg

    return psycopg.connect(dsn, connect_timeout=10, autocommit=True)


def fetch_lite_votes(
    lite: LiteConfig, keys: Iterable[PostKey]
) -> Mapping[PostKey, list[Vote]]:
    """Lite votes for a page of posts, keyed by ``(author, permlink)``.

    The keys are CHAIN coordinates, which is what ``lumen_vote`` stores, so this
    works for a lite user voting an ordinary Hive author's post exactly as it
    does for one lite user voting another's. Returns ``{}`` — never raises —
    when the DSN is absent or the datastore is unreachable.
    """
    wanted = list(keys)
    if not wanted:
        return {}
    if not lite.engagement_enabled:
        logger.warning(
            "lite engagement: LiteConfig.engagement_dsn is unset — lite votes and "
            "reblogs are NOT being read, so lite users' engagement contributes "
            "nothing to ranking. Set LUMEN_LITE_DATABASE_URL to enable it."
        )
        return {}
    assert lite.engagement_dsn is not None
    out: dict[PostKey, list[Vote]] = {}
    try:
        with _connect(lite.engagement_dsn) as conn, conn.cursor() as cur:
            cur.execute(_SQL_LITE_VOTES, {**_key_params(wanted), "min_weight": _MIN_WEIGHT})
            for author, permlink, voter, updated_at in cur.fetchall():
                out.setdefault((author, permlink), []).append(
                    Vote(
                        voter=voter,
                        # Zero, never synthetic. A lite vote has no stake, and
                        # `Vote.lite` — not a fabricated magnitude — is what
                        # makes it count for breadth.
                        rshares=0,
                        timestamp=_as_aware(updated_at),
                        lite=True,
                    )
                )
    except Exception as exc:  # a feed request must not die for this
        logger.warning(
            "lite engagement: votes unavailable (%s: %s) — ranking continues "
            "WITHOUT lite engagement for this request",
            type(exc).__name__,
            exc,
        )
        return {}
    return out


def fetch_lite_rebloggers(
    lite: LiteConfig, keys: Iterable[PostKey]
) -> Mapping[PostKey, frozenset[str]]:
    """Lite rebloggers for a page of posts. Same degrade posture as votes."""
    wanted = list(keys)
    if not wanted or not lite.engagement_enabled:
        return {}
    assert lite.engagement_dsn is not None
    collected: dict[PostKey, set[str]] = {}
    try:
        with _connect(lite.engagement_dsn) as conn, conn.cursor() as cur:
            cur.execute(_SQL_LITE_REBLOGS, _key_params(wanted))
            for author, permlink, reblogger in cur.fetchall():
                collected.setdefault((author, permlink), set()).add(reblogger)
    except Exception as exc:
        logger.warning(
            "lite engagement: reblogs unavailable (%s: %s) — ranking continues "
            "WITHOUT lite reblogs for this request",
            type(exc).__name__,
            exc,
        )
        return {}
    return {key: frozenset(names) for key, names in collected.items()}


def _as_aware(value: datetime) -> datetime:
    """`lumen_vote.updated_at` is `timestamptz`, but a driver or a future
    migration could hand back a naive value, and a naive/aware subtraction
    raises `TypeError` deep in the decay maths — the exact break (#8) that once
    killed the whole weekly trust batch from the HAFSQL side."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


__all__ = ["fetch_lite_rebloggers", "fetch_lite_votes"]
