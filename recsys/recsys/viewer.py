"""A9 — build a real :class:`~recsys.contracts.ViewerProfile` for a real Hive
account.

WHY THIS FILE EXISTS. Nothing outside tests and the measurement harness ever
constructed a ``ViewerProfile`` — there was no bridge from "a Hive account
name" to the object ``rank_feed`` actually consumes.

WHAT THIS BUILDS, per BUILD-ADJUDICATION-2026-08-04 / BUILDMAP-A A9:

* ``follows`` (A9.1) — ``hafsql.follows``, ``follower_name = account``.
  ``HafsqlGateway.follow_graph`` is NOT this: it returns the sub-graph
  induced by an account SET, for graph-cred, not one viewer's own list.
* ``mutes`` (A9.2) — see :func:`mutes_of`'s own docstring for the live
  schema verification this required.
* ``interest_tags`` (A9.3 / R12 part 2) — the sole interest substrate since
  communities were retired as a lane (R1/R3). For a RETURNING user this is
  DERIVED from their own posting + voting history (cold-start spec Lever
  B/D10) rather than demanded of them — see :func:`derive_interest_tags`.

WHY RAW SQL IN THIS MODULE INSTEAD OF NEW ``HafsqlGateway`` METHODS. This
builder does not own ``recsys/io/hafsql.py`` (another workstream is actively
editing it this phase). Per the build brief: "write the query in your own
module against the same connection [...] or report precisely what method is
needed." An earlier scaffold of this file took the second option — a
``ViewerGateway``/``ViewerStore`` ``Protocol`` pair whose methods
(``follows_of``, ``mutes_of``, ``authored_and_voted_tags_of``,
``declared_interest_tags``) nothing in the tree implements, so
``build_viewer_profile`` could never actually run. That is a real, reasonable
reading of the brief, but it leaves A9 — and therefore A10, which depends on
it — non-functional, and R8's acceptance bar requires an ACTUAL live request
to succeed. This version takes the first option instead: every query below
runs directly against ``HafsqlClient._fetch`` (verified live 2026-08-04, see
the SQL comments), which already gives it A4's pooling, retry/breaker and
``statement_timeout`` for free — "the same connection" the brief asks for,
not a second ad hoc one. ``_fetch`` is name-mangled private by convention,
not by enforcement; :class:`_FetchCapable` below is a narrow structural
``Protocol`` so this module depends on exactly the one method it needs and
stays testable against a plain fake with no real client at all.

R12 — THE TAGLESS-VIEWER RULING, restated for this module's part in it (see
``pipeline.gather_candidates``'s own comment for the other two-thirds):

  1. New signups: at least one interest tag mandatory at signup — a
     signup-API change OUTSIDE ``recsys/``, not built here.
  2. Returning Hive users: derive tags from history — THIS module,
     :func:`derive_interest_tags`.
  3. Defensive floor: a viewer who still arrives with no tags gets the
     popular fallback + a WARNING, never an empty feed or a crash — already
     live in ``pipeline.gather_candidates`` (do not regress it). This
     module's :func:`build_viewer_profile` adds a companion WARNING at the
     PROFILE-BUILD boundary so an operator sees *why* before the
     ranking-time symptom. ``tests/test_viewer.py`` proves a tagless
     ``ViewerProfile`` built here still reaches a non-empty feed through
     that path.

``store``/signup-time explicit picks (``recsys/db/schema.sql``'s
``viewer_profile.top_categories``): DECIDED, per A9.3's "decide and
document" instruction — nothing in ``recsys/db/store.py`` reads or writes
that table today (grep confirms no INSERT/UPDATE/SELECT anywhere in the
package), and R12 part 1 explicitly places signup-time tag capture outside
``recsys/`` (a frontend/signup-API concern). Building a read path against an
always-empty table would be dead code. Instead, :func:`build_viewer_profile`
accepts an optional ``explicit_interest_tags`` override: a caller that DOES
have a signup-time pick (from Lumen's own Postgres, however it gets there)
passes it straight through and derivation is skipped. Absent, tags are
derived from history for a returning user, or left empty for a declared new
one (R12 part 1's mandatory-tag signup gate is what should prevent that case
in steady state; part 3 is what protects the viewer if it happens anyway).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any, Protocol

from recsys.config import DEFAULT_SETTINGS, Settings
from recsys.contracts import ViewerProfile

logger = logging.getLogger("recsys.viewer")


class _FetchCapable(Protocol):
    """The one method this module needs from a gateway: a pooled, parameterized
    fetch. ``recsys.io.hafsql.HafsqlClient._fetch`` satisfies this structurally
    (Python does not enforce name-mangled privacy), and so does any test fake
    that defines the same method — no dependency on the concrete client type."""

    def _fetch(
        self, sql: str, params: dict[str, Any], *, timeout_ms: int | None = None
    ) -> list[tuple[Any, ...]]: ...


# ---------------------------------------------------------------------------
# SQL. Every query is parameterized (`%(name)s`) — no f-string values, no
# injection surface — matching the convention `recsys/io/hafsql.py` documents
# and enforces throughout.
# ---------------------------------------------------------------------------

# A9.1. `hafsql.follows` columns verified live 2026-08-04:
# (follower_id, following_id, block_num, follower_name, following_name) — no
# state/follow_type column, so this table alone cannot distinguish a mute
# (see `_SQL_MUTES_OF` below for where that distinction actually lives).
_SQL_FOLLOWS_OF = """
SELECT following_name
FROM hafsql.follows
WHERE follower_name = %(account)s
"""

# A9.2. `hafsql.mutes` verified live 2026-08-04: a DEDICATED table
# (muter_id, muted_id, block_num, muter_name, muted_name), confirmed non-empty
# on real accounts (acidyo: 210 rows, live). This is the correct source —
# `hafsql.follows` carries no mute/ignore state at all, so a query that tried
# to derive mutes from it (e.g. by an assumed `follow_type` column) would
# either error on a nonexistent column or silently return nothing forever.
_SQL_MUTES_OF = """
SELECT muted_name
FROM hafsql.mutes
WHERE muter_name = %(account)s
"""

# A9.3, own posts half. `tags` is jsonb (comments break #3's lesson — no `&&`
# array operator), `category` is the primary tag. `parent_author = ''` scopes
# to top-level posts only (a comment's "category" is inherited from its root
# and is not a deliberate topic choice by this account).
_SQL_OWN_POST_TAGS = """
SELECT tags, category
FROM hafsql.comments
WHERE author = %(account)s
  AND parent_author = ''
  AND deleted = false
ORDER BY created DESC
LIMIT %(limit)s
"""

# A9.3, voting-history half. Two queries, not one join: live-verified
# 2026-08-04, a direct join from `operation_effective_comment_vote_view` to
# `hafsql.comments` filtered only on `voter` timed out at the 15s statement
# timeout (the planner drives it from a `blocks`-scan nested loop). Filtering
# votes to a small, indexed, `voter`+`timestamp`-ordered page FIRST (measured
# ~1.3-1.9s live) and then looking up just those (author, permlink) pairs by
# an `unnest`-joined VALUES list (measured ~0.04s live) is the same two-step
# shape `HafsqlClient._hydrate` already uses for votes/comments/rebloggers —
# not a novel pattern, the same fix applied to a query this module owns.
_SQL_RECENT_VOTES_BY = """
SELECT author, permlink
FROM hafsql.operation_effective_comment_vote_view
WHERE voter = %(account)s
  AND "timestamp" >= %(since)s
ORDER BY "timestamp" DESC
LIMIT %(limit)s
"""

# Fast pre-check, live-measured 2026-08-04: a plain `WHERE voter = X LIMIT 1`
# with NO `ORDER BY`/`timestamp` bound resolves in ~0.03-0.05s REGARDLESS of
# whether the account has ever voted (tested repeatedly on a nonexistent
# voter and on real accounts) — the planner takes a different, cheap path
# once there is no ordering to satisfy. This is NOT the same query as
# `_SQL_RECENT_VOTES_BY` with the `ORDER BY`/`since` stripped; that shape was
# also trialled and still timed out (see the 14.9s outlier above). Used to
# skip the expensive windowed query entirely for an account that has never
# cast a single vote — live-verified: without this guard, exactly that case
# (a real never-voted account name) hit the FULL 15s statement timeout on
# `_SQL_RECENT_VOTES_BY` before falling back. A brand-new or vote-only-silent
# account is common, not an edge case, so paying up to 15s for a query
# guaranteed to return nothing is a real reliability problem this guard
# closes for the price of one cheap extra round trip on the accounts that DO
# have vote history.
_SQL_HAS_EVER_VOTED = """
SELECT 1
FROM hafsql.operation_effective_comment_vote_view
WHERE voter = %(account)s
LIMIT 1
"""

_SQL_TAGS_FOR_POST_PAIRS = """
SELECT c.tags, c.category
FROM hafsql.comments c
JOIN unnest(%(authors)s::text[], %(permlinks)s::text[]) AS w(author, permlink)
  ON c.author = w.author AND c.permlink = w.permlink
"""

DEFAULT_OWN_POST_LIMIT = 30
#: Live-measured 2026-08-04: `_SQL_RECENT_VOTES_BY` has no usable index on
#: `voter` alone (`EXPLAIN` shows a backward scan of `blocks` by `created_at`
#: with a per-block jsonb filter for the voter — see that query's own
#: comment) — cost scales with how far back in the window a match is found,
#: not with the account's activity. Trialled live: an active account (60-row
#: page) is consistently ~0.7s; a quieter one (`gtg`) ~4.0s; one outlier at
#: LIMIT=150 with no `since` bound hit 14.9s, a hair under the 15s statement
#: timeout. 60 was chosen as the largest LIMIT that stayed comfortably clear
#: of the timeout in every trial, including the quiet-account case — this is
#: a real operational constraint, not a magic number; see
#: `derive_interest_tags`'s own try/except for the defense-in-depth backstop
#: for whatever this measurement did not catch.
DEFAULT_VOTE_HISTORY_LIMIT = 60

#: How many derived tags describe one returning reader. ★ RAISED 6 -> 20
#: (2026-08-09), MEASURED, NOT GUESSED.
#:
#: WHY IT COULD NOT STAY AT 6. Six tags cannot describe what a person reads, and
#: the cost was not abstract: `interest_tags` is BOTH what the interest lane
#: sources on AND what the reserved newcomer seat matches against
#: (`core/exploration.py::_interest_match`). At 6, gtg's entire declared
#: vocabulary was witness jargon (`dev`, `fakenet`, `hbd`, `hive-160391`,
#: `witness-category`, `witness-update`) and his interest lane could fill only
#: 3 of 20 slots.
#:
#: ★★ THE CURVE, live HAFSQL, three real viewers, serial, 2026-08-09. Lane
#: composition is of the SERVED top 20; "seat" is whether the newcomer seat's
#: occupant matched a declared interest or came from option C's fallback.
#:
#:   k    lordbutterfly                     gtg                          steevc
#:        in/int/eng/exp  seat              in/int/eng/exp  seat         in/int/eng/exp  seat
#:    6    4/14/1/1  fallback                15/3/1/1  fallback           14/4/1/1  fallback
#:   10    6/12/1/1  fallback                15/3/1/1  fallback           14/4/1/1  fallback
#:   14    7/11/1/1  MATCHED (`ai`)           6/12/1/1 fallback           12/6/1/1  fallback
#:   20    7/11/1/1  MATCHED (`lumen`)        7/10/2/1 MATCHED (`ai`)     13/6/0/1  fallback
#:   30    7/11/1/1  MATCHED (21 tags max)    6/12/1/1 MATCHED            15/3/1/1  MATCHED (`blog`)
#:
#: WHAT THE CURVE SAYS, and it is not what was feared. The interest lane does
#: NOT run away as tags widen — the exploration seat is exactly 1/20 at every k
#: (its designed size), and the interest lane's share is NON-MONOTONIC: it peaks
#: near 14-20 and then DEGRADES (steevc 6 -> 3 slots from k=20 to k=30). The
#: mechanism is `HafsqlGateway.tag_posts`: one recency-ordered query with a FIXED
#: `limit` across all tags, so past a point extra tags spend that budget on
#: near-empty tags and thin the pool instead of widening it.
#:
#: ★★★ 20 IS THE CHOICE, AND HERE IS WHAT IT COSTS. Newcomer-seat interest
#: matches go 0/3 (at the shipped 6) -> 2/3; every viewer's interest lane is at
#: or near its peak; and it is the same breadth the signup picker already allows
#: (`MAX_INTERESTS = 20` in `apps/blog/lib/lite/interests/taxonomy.ts`), so a
#: derived reader and a declared one are described with comparable width.
#:
#: 30 was NOT taken even though it makes the seat match 3/3: it costs steevc half
#: his interest lane (6 -> 3 slots), and derivation admits progressively more
#: personal, near-unique tags as the cut widens — lordbutterfly's ranking at 21
#: already contains `but`, `do`, `it`, `smarter`. Those are not free: the score
#: side prices a tag by RARITY (`scoring.tag_rarity_weight`), and an unmeasured
#: tag scores 0.612 against `photography`'s 0.210, so a post that happens to be
#: filed under a reader's junk tag is scored as if it were highly discriminative.
#: The MAX (not sum) in `declared_interest_raw` bounds one post's gain; nothing
#: bounds how many junk tags a wide cut admits. That is the real ceiling here,
#: and it is why the number stops at 20 rather than at "as many as possible".
#:
#: Costs no extra query and no extra latency: derivation already fetches the
#: whole history and this only moves where the ranked list is cut (measured
#: ~6.2s for lordbutterfly at k=6 and at k=30 alike, dominated by the vote-history
#: read this module already caps at `_VOTE_HISTORY_TIMEOUT_MS`).
DEFAULT_MAX_INTEREST_TAGS = 20

#: Request-path bound for the vote-history read, in ms (2026-08-08).
#:
#: ★ THIS RESTORES A CAP THAT WAS DESIGNED FOR AND THEN SILENTLY LOST. The
#: comment at the `_SQL_RECENT_VOTES_BY` call site already states the intent —
#: "live-measured latency ranges ~0.7s-4s ... up to the full 15s statement
#: timeout" — i.e. this query was shipped ASSUMING `statement_timeout` would cut
#: it off. This deployment sets `HAFSQL_STATEMENT_TIMEOUT_MS=900000` (15 minutes,
#: deliberately, because the trust batch needs minutes), so that cap has not
#: existed for any request, and nothing was left to stop this query at all.
#:
#: MEASURED LIVE, 2026-08-08, the three launch viewers:
#:     steevc          0.81s   (60 rows)
#:     gtg             3.62s   (60 rows)
#:     lordbutterfly  27.21s   (15 ROWS)
#: The pathological case is a LIGHT voter, not a heavy one: the query has no
#: usable index on `voter` (see `DEFAULT_VOTE_HISTORY_LIMIT`), so a sparse
#: matcher scans far further before it can fill `limit`. That 27s was the whole
#: of lordbutterfly's residual ~38s request after the newness query was fixed —
#: on its own, 1.8x the frontend's entire 15s patience.
#:
#: 6s: comfortably above the healthy range (1.7x gtg's measured 3.62s), well
#: inside the page budget, and it fires on the pathological case. Exceeding it
#: raises into the try/except immediately below, which is a REAL degrade that
#: already exists and already logs loudly — own-posts-only tag derivation. That
#: is a genuine loss of personalisation for the affected viewer and is the
#: honest trade against a request nobody waits for: a thinner interest set
#: still serves a page, a 27s query does not.
_VOTE_HISTORY_TIMEOUT_MS = 6000

# An account's own posts are a much stronger interest signal than any single
# vote (writing about a topic vs. liking one post about it once); weighted
# accordingly rather than counted 1:1.
_OWN_POST_TAG_WEIGHT = 3.0
_VOTE_TAG_WEIGHT = 1.0


# ---------------------------------------------------------------------------
# ★★★ NON-TOPICAL TAGS — what derivation refuses to INFER as an interest
# (2026-08-08).
#
# THE DEFECT THIS CLOSES, measured on four real accounts on 2026-08-08 by
# running the derivation below unchanged against live HAFSQL:
#
#   melinda010100  ->  archon, pimp, pob, hive-125125, alive, oneup
#   steevc         ->  proofofbrain, teamuk, hive-176853, sportstalk, running, hive
#   lordbutterfly  ->  hive, contest, hive-140169, music, vibes, news
#   gtg            ->  hive, hive-160391, hbd, witness-category, dev, witness-update
#
# Five of melinda010100's six inferred "interests" are reward-token tribe tags.
# She is a photographer who runs a shadow-photography contest; `photography`
# (weight 32), `shadows` (26), `shadowphotos` (25) and `contest` (32) were all
# ranked BELOW `archon` (106) and got no slot at all. The profile did not say
# what she is interested in — it said which tokens her posts route rewards to.
# Three of the four accounts spent a slot on the bare string `hive`.
#
# This is not a scoring problem and no weight can fix it. `max_tags` is SIX, so
# every non-topical tag that wins a slot EVICTS a real one, and `interest_tags`
# is also what the interest LANE sources candidates by
# (`pipeline.gather_candidates` -> `HafsqlGateway.tag_posts`) — a tag that
# should never have been inferred does not merely mis-rank the pool, it decides
# what is IN it.
#
# ★ WHY THESE TAGS AND NOT A FREQUENCY CUTOFF. A pure "too common to be
# meaningful" rule is wrong in both directions, measured: `photography`
# (10.9% of root posts) and `life` (11.1%) are as common as `hive` (10.6%) and
# are perfectly good interests, while `hiveposh` (df 9 in 38,478) is rare and
# means only "cross-posted to Twitter". Frequency cannot see the difference
# because the difference is SEMANTIC. The rarity weight in
# `recsys.core.scoring.tag_rarity_weight` handles the frequency axis; this list
# handles the axis frequency cannot see, and the two are deliberately separate.
#
# ★★ THE REASONING IS THE FRONTEND'S, ALREADY MADE AND ALREADY SHIPPED. The
# signup interest picker (`apps/blog/lib/lite/interests/taxonomy.ts`) built its
# taxonomy from the same live tag counts and documents the same finding: "The
# highest-volume tags on Hive are NOT topics — they are REWARD-TOKEN TRIBE
# tags... Authors add them to route rewards, not to say what a post is ABOUT."
# Its survivors are honoured here: `splinterlands`, `spt`, `leofinance` and
# `actifit` are genuinely about one game / finance / activity and are NOT
# excluded. Nothing is imported across repos — only the reasoning, and every
# count below was re-measured against HAFSQL by this module's own build.
#
# ★★★ WHAT IS DELIBERATELY *NOT* HERE, and why each absence is a decision:
#
# * **Community ids (`hive-NNNNN`) are KEPT.** They are the single most
#   discriminative thing an account's history carries — `hive-176853` for
#   steevc, `hive-160391` for gtg, `hive-125125` for melinda010100 are each one
#   community with one subject, they are rare (so `tag_rarity_weight` scores
#   them near the top), and they are exactly the "not new to Hive, but new to
#   me" discovery vector the feed is short of. They are opaque to a human
#   READER, which is why the signup picker shows named topics instead — but
#   derivation is not asking anybody to read them, it is inferring, and the
#   picker itself resolves several of its named interests straight to community
#   ids (`hive-140635`, `hive-193816`, `hive-121744`), which is the frontend
#   stating that a community id IS a topic.
# * **Language tags (`spanish`, `kr`, `cn`, `deutsch`, `polish`) are KEPT**,
#   diverging from the picker on purpose. The picker excludes them because a
#   language pick would compete with topic picks for the same 20 slots, which
#   is a *product* argument about a hand-made choice. Here the question is only
#   "is this evidence of what this reader wants", and for someone whose history
#   is in Spanish it is very strong evidence.
# * **`life`, `blog`, `lifestyle` are KEPT.** They are thin, but they are
#   genuine content tags, the picker resolves its "Life & Personal" interest to
#   exactly them, and `tag_rarity_weight` already prices them near the floor
#   (`w(life) = 0.208`) without anyone having to adjudicate them.
#
# Counts are root posts / 30 days, live HAFSQL, measured 2026-08-08 (N =
# 38,478), and are kept so a later reader can tell a tag that was always thin
# from one that DIED.
_NON_TOPICAL_TAGS = frozenset(
    {
        # (1) The platform's own name, and its frontends/clients. A post tagged
        # with the app it was published from has said nothing about itself.
        "hive",  # 10.6%  — the namespace, worn by 1 in 9 root posts
        "ecency",  # 10.5%
        "waivio",  # 15.3%
        "inleo",  # 6.6%   — the LeoFinance frontend; `leofinance` (topical) stays
        "leo",  # 5.4%   — the LeoFinance token tag; `leofinance` stays
        "peakd",  # 0.25%
        "dbuzz",  # 0.18%
        "esteem",  # (dead; kept so a revival is caught)
        "hiveblog",
        # (2) Reward-token tribe tags — the picker's own enumeration, re-measured.
        # A post tagged `pob` can be about literally anything.
        "neoxian",  # 31.4%  — the single most common tag on the chain
        "pob",  # 17.3%
        "proofofbrain",  # 13.8%
        "cent",  # 12.2%
        "pimp",  # 9.5%
        "archon",  # 9.2%
        "palnet",  # 8.6%
        "alive",  # 8.0%
        "aliveandthriving",  # 5.2%
        "waiv",  # 7.3%
        "creativecoin",  # 7.7%
        "oneup",  # 6.1%
        "bbh",  # 6.1%
        "vyb",  # 5.3%
        "tribes",  # 4.6%   — literally the routing meta-tag
        "ctp",  # 4.2%
        "bee",  # 1.2%
        "thgaming",  # 1.2%
        "lassecash",  # 1.2%
        "slothbuzz",  # 1.1%
        "airhawk",  # 0.9%
        "bilpcoin",  # 0.9%
        "ash",  # 0.2%
        "upfundme",  # 0.16%
        "upme",  # 0.16%
        # (3) Curation-project routing tags. Added to be SEEN by a curator, not
        # to describe the post.
        "ocd",  # 4.0%
        "gems",  # 2.8%   — the OCD curation tag, not the mineral
        "qurator",  # 2.6%
        "appreciator",  # 2.6%
        "curangel",  # 1.9%
        "hl-exclusive",  # 1.3%
        "ocdb",  # 1.3%
        "curation",  # 1.2%
        "dreemport",
        # (4) Mechanical markers — a fact about how the post was published.
        "posh",  # 0.57%  — "proof of share": it was cross-posted to Twitter
        "hiveposh",  # 0.02%  — RARE, and therefore exactly the case a
        #           frequency rule would get backwards
        "burnpost",  # 0.9%   — a reward mechanic
    }
)


def _is_topical_tag(tag: str) -> bool:
    """Whether ``tag`` is evidence of what a reader is INTERESTED IN, as
    opposed to a fact about routing, rewards, curation or which app published
    the post. See :data:`_NON_TOPICAL_TAGS` for the full argument, including
    what is deliberately left in.

    Normalises case/whitespace: the live chain really does carry ``"Spanish "``
    alongside ``"spanish"``, and an exclusion that a stray capital defeats is
    not an exclusion."""
    return tag.strip().lower() not in _NON_TOPICAL_TAGS


def follows_of(gateway: _FetchCapable, account: str) -> frozenset[str]:
    """A9.1 — the accounts ``account`` itself follows (not the sub-graph
    ``HafsqlGateway.follow_graph`` returns, which is induced by a *set* of
    accounts and built for graph-cred, not for one viewer's own list)."""
    rows = gateway._fetch(_SQL_FOLLOWS_OF, {"account": account})
    return frozenset(row[0] for row in rows)


def mutes_of(gateway: _FetchCapable, account: str) -> frozenset[str]:
    """A9.2 — accounts ``account`` has muted. See the module-level SQL
    comment on ``_SQL_MUTES_OF`` for the live schema verification this
    required (the build brief explicitly warned not to assume)."""
    rows = gateway._fetch(_SQL_MUTES_OF, {"account": account})
    return frozenset(row[0] for row in rows)


def _extract_tags(tags_json: Sequence[str] | None, category: str | None) -> set[str]:
    out: set[str] = set()
    if tags_json:
        out.update(tag for tag in tags_json if tag)
    if category:
        out.add(category)
    return out


def derive_interest_tags(
    gateway: _FetchCapable,
    account: str,
    *,
    now: datetime,
    settings: Settings = DEFAULT_SETTINGS,
    own_post_limit: int = DEFAULT_OWN_POST_LIMIT,
    vote_history_limit: int = DEFAULT_VOTE_HISTORY_LIMIT,
    max_tags: int = DEFAULT_MAX_INTEREST_TAGS,
) -> frozenset[str]:
    """A9.3 / R12 part 2 — derive interest tags for a RETURNING Hive user
    from their own posting + voting history (cold-start spec Lever B/D10),
    instead of demanding them again at every login.

    Aggregates tag/category frequency across the account's recent top-level
    posts (weight :data:`_OWN_POST_TAG_WEIGHT`) and recent votes
    (weight :data:`_VOTE_TAG_WEIGHT`, windowed to
    ``settings.history.quality_prior_days`` — the same "enough events to beat
    Bernoulli noise" horizon the author-quality prior already uses, not a new
    tuning constant), and returns the top ``max_tags`` by weighted count.

    Returns an EMPTY frozenset for an account with no posting or voting
    history in the window (a genuinely fresh account, or one that has never
    interacted) — this is a real, expected state, not an error. The caller
    (:func:`build_viewer_profile`) logs it; R12 part 3's fallback (already
    live in ``pipeline.gather_candidates``) is what keeps the resulting feed
    non-empty.

    ★★★ NON-TOPICAL TAGS ARE DROPPED BEFORE THE TOP-N CUT (2026-08-08), NOT
    AFTER — see :data:`_NON_TOPICAL_TAGS` for the measurement that forced this
    and for what is deliberately kept. Filtering first is the whole point: the
    cut is only ``max_tags`` wide, so a reward-tribe tag that survives to the
    ranking EVICTS a real interest rather than merely sitting beside it
    (melinda010100 lost `photography`, `shadows`, `shadowphotos` and `contest`
    to `archon`, `pimp`, `pob`, `alive` and `oneup` this way). Filtering after
    the cut would return three tags instead of six and change nothing about
    which real interests were lost.

    ★ FILTERING CAN NEVER EMPTY THE RESULT. If every derived tag is
    non-topical, the UNFILTERED ranking is returned instead. An empty
    ``interest_tags`` is a real state with real consequences — R12 part 3's
    popular-fallback path, no interest lane, and the gate-exempt exploration
    lane's ``_interest_match`` refusing everything — and it must stay reserved
    for "this account has no history", never become something a curated list in
    this module can inflict on an account that does.
    """
    since = now - timedelta(days=settings.history.quality_prior_days)
    scores: dict[str, float] = {}

    own_rows = gateway._fetch(
        _SQL_OWN_POST_TAGS, {"account": account, "limit": own_post_limit}
    )
    for tags_json, category in own_rows:
        for tag in _extract_tags(tags_json, category):
            scores[tag] = scores.get(tag, 0.0) + _OWN_POST_TAG_WEIGHT

    # BEST-EFFORT, NOT LOAD-BEARING. `_SQL_RECENT_VOTES_BY` has no usable
    # index on `voter` alone (see `DEFAULT_VOTE_HISTORY_LIMIT`'s comment) and
    # live-measured latency ranges ~0.7s-4s for an account with real vote
    # history, up to the full 15s statement timeout for one that has never
    # voted at all. `_SQL_HAS_EVER_VOTED` (see its own comment) is a cheap
    # (~0.03-0.05s live) pre-check that skips the expensive query entirely
    # for that common case. This half of derivation must never be able to
    # fail the whole viewer-profile build regardless: on ANY exception here
    # (timeout, transient connection loss, ...) fall back to own-posts-only
    # tags, which are index-backed and reliably fast, and log loudly so an
    # operator can see the degrade rather than a silently thinner result.
    vote_rows: list[tuple[Any, ...]] = []
    try:
        has_voted = bool(gateway._fetch(_SQL_HAS_EVER_VOTED, {"account": account}))
        if has_voted:
            vote_rows = gateway._fetch(
                _SQL_RECENT_VOTES_BY,
                {"account": account, "since": since, "limit": vote_history_limit},
                timeout_ms=_VOTE_HISTORY_TIMEOUT_MS,
            )
    except Exception:
        logger.warning(
            "derive_interest_tags: %s's voting-history query failed/timed out — "
            "falling back to own-posts-only tag derivation for this build.",
            account,
            exc_info=True,
        )
        vote_rows = []

    if vote_rows:
        authors = [row[0] for row in vote_rows]
        permlinks = [row[1] for row in vote_rows]
        try:
            tag_rows = gateway._fetch(
                _SQL_TAGS_FOR_POST_PAIRS, {"authors": authors, "permlinks": permlinks}
            )
        except Exception:
            logger.warning(
                "derive_interest_tags: %s's voted-post tag lookup failed — "
                "falling back to own-posts-only tag derivation for this build.",
                account,
                exc_info=True,
            )
            tag_rows = []
        for tags_json, category in tag_rows:
            for tag in _extract_tags(tags_json, category):
                scores[tag] = scores.get(tag, 0.0) + _VOTE_TAG_WEIGHT

    if not scores:
        return frozenset()

    # Stable, deterministic tie-break (weight desc, then tag name asc) so two
    # runs over unchanged data always pick the same top-N — important for the
    # A10 "served order is IDENTICAL to a direct rank_feed() call" proof,
    # which depends on `interest_tags` (and therefore this function) being
    # reproducible, not just non-empty.
    topical = {tag: weight for tag, weight in scores.items() if _is_topical_tag(tag)}
    if not topical:
        logger.warning(
            "derive_interest_tags: every tag derived for %s is non-topical "
            "(reward-tribe / curation / frontend / namespace) — keeping the "
            "unfiltered ranking rather than handing back an empty interest set.",
            account,
        )
        topical = scores
    ranked = sorted(topical.items(), key=lambda kv: (-kv[1], kv[0]))
    return frozenset(tag for tag, _ in ranked[:max_tags])


def build_viewer_profile(
    account: str,
    gateway: _FetchCapable,
    *,
    now: datetime,
    settings: Settings = DEFAULT_SETTINGS,
    is_new: bool = False,
    explicit_interest_tags: frozenset[str] | None = None,
    explicit_follows: frozenset[str] | None = None,
    explicit_mutes: frozenset[str] | None = None,
) -> ViewerProfile:
    """A9.4 — build a real ``ViewerProfile`` for ``account`` from live Hive
    data (plus, optionally, a signup-time explicit pick — see the module
    docstring's ``explicit_interest_tags`` note).

    ★ B3 (2026-08-05) — ``explicit_follows`` / ``explicit_mutes`` exist for
    LUMEN LITE VIEWERS, who have no Hive account and therefore no chain-side
    follow or mute list at all. Their graph lives in Lumen's own store, so the
    CALLER supplies it. This deliberately follows ``LiteConfig``'s stated
    architecture ("the fix is ON-CHAIN, not cross-database — no join against
    Lumen's Postgres, no ingestion job"): recsys does not reach into another
    service's database, it accepts the state its caller already holds.

    ★★ ``None`` MEANS "ASK THE CHAIN"; ``frozenset()`` MEANS "SUPPLIED, AND
    GENUINELY EMPTY". Do not collapse these with a falsy check. A lite user who
    follows nobody is a real, common state (it is the state every lite user is
    in at signup), and it must NOT silently fall back to querying HAFSQL for an
    account name that does not exist on chain. This mirrors the convention
    ``explicit_interest_tags`` already established directly above.

    Note the asymmetry with ``interest_tags``: there is no derivation fallback
    for follows/mutes. A Hive viewer's follows come from the chain and a lite
    viewer's come from the caller — there is no third source to infer from.

    ``is_new`` is passed straight through to the ``ViewerProfile`` field of
    the same name and otherwise UNUSED for gating here, mirroring
    ``ViewerProfile.is_new``'s own contract: it is client-supplied and
    deliberately un-load-bearing (``pipeline.gather_candidates`` routes the
    gate-exempt interest lane on the unspoofable ``not viewer.follows``, not
    on this flag — see that function's own comment for why, and do not
    reintroduce a dependency on it here). It is used ONLY to decide whether
    this function bothers deriving tags at all: a caller who already knows
    the account is brand-new can skip two live queries that would return
    nothing anyway. Passing ``is_new=True`` for an account that turns out to
    have history is harmless (it just skips derivation), never unsafe.
    """
    follows = follows_of(gateway, account) if explicit_follows is None else explicit_follows
    mutes = mutes_of(gateway, account) if explicit_mutes is None else explicit_mutes

    if explicit_interest_tags is not None:
        interest_tags = explicit_interest_tags
    elif is_new:
        interest_tags = frozenset()
    else:
        interest_tags = derive_interest_tags(gateway, account, now=now, settings=settings)

    if not interest_tags:
        # Companion to the WARNING `pipeline.gather_candidates` already logs
        # at ranking time (R12 part 3) — this one fires at the PROFILE-BUILD
        # boundary, so an operator sees "derivation found nothing for this
        # account" as a distinct, earlier signal from "the interest lane
        # sourced nothing this request", rather than only the latter.
        logger.warning(
            "build_viewer_profile: %s has no interest_tags (is_new=%s, "
            "explicit_override=%s) — will rely on the popular-fallback path "
            "in gather_candidates (R12) rather than the interest lane.",
            account,
            is_new,
            explicit_interest_tags is not None,
        )

    return ViewerProfile(
        account=account,
        follows=follows,
        mutes=mutes,
        interest_tags=interest_tags,
        is_new=is_new,
    )


__all__ = [
    "DEFAULT_MAX_INTEREST_TAGS",
    "DEFAULT_OWN_POST_LIMIT",
    "DEFAULT_VOTE_HISTORY_LIMIT",
    "build_viewer_profile",
    "derive_interest_tags",
    "follows_of",
    "mutes_of",
]
