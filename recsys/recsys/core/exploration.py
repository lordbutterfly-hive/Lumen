"""Exploration lane (§4.3 of the cold-start spec, build item B12).

THE PROBLEM IT SOLVES. A brand-new author is not blocked — they are outscored.
Measured: a post published this instant with no engagement and no author history
scores exactly `organic_recency` (0.10) against a window median around 0.46, i.e.
the 3rd-4th percentile, BY CONSTRUCTION. 80% of the composite is a measure of
attention already received and the other 20% (vote, reputation) is also
incumbency, so no weight tuning reaches the first page. Sweeping
`organic_recency` 0.1 -> 2.0 was measured to cost nDCG at every step while still
leaving a followed author's fresh post at 0/40 first-page reach.

The one thing that works is a RESERVED SLOT, and that is what this is.

WHY IT IS SEPARATE FROM THE UNCHOSEN-LANE CAP. Capping `OON_ENGAGED` fixed the
follow curve (defect ratio 0.395 -> 1.071) and broke new-author discovery
(10/10 -> 0/10) because that lane is simultaneously the crowding problem AND the
only route a newcomer had into an established feed. Measured over the whole cap
ladder, no single value serves both — readers and new writers need two
mechanisms, not one dial. This is the second mechanism.

THE BUDGET IS DELIBERATELY TINY — 1 slot per 20-post page, 5% of impressions.
Justification is external and measured: YouTube's production fresh/tail slot cost
-0.12% overall dwell against +2.52% fresh-content interactions and +5.5%
small-provider dwell (Wang et al., KDD 2023); TikTok's manual heating ran ~1-2%
of daily views; Meta's live backlash arrived at tens-of-percent unconnected
content. The spec's instruction is explicit: start at 1 slot, never 2.

THE SYBIL POSTURE. This lane is an explicit, budgeted, defended bypass of the
second-degree vouch — the gate still governs the other ~95% of the feed. It does
NOT take the author graph-cred floor, deliberately: a brand-new author is below
every floor by construction, which is the entire point. Its defences are instead:

  * proven-self-dealing exclusion — an author whose graph-cred has been zeroed
    for PROVEN self-dealing (``score <= 0.0``) is never eligible. ★ CHANGED
    2026-08-04 (C4): this used to be raw ring-flag exclusion
    (``post.author in ring_members``), and it was measured to let an attacker
    turn SUPPRESSION into a GAIN — two reusable sock accounts can get an
    honest new author ring-flagged with zero votes/comments/reblogs of their
    own, and the raw flag alone then closed this very lane to the victim
    (60/60 viewers -> 0/60) while the attacker's own share of the exploration
    budget rose 0.2% -> 27.3%. ``cred.score <= 0.0`` is the narrower, PROVEN
    band :func:`~recsys.pipeline._fallback_filler` already uses for the same
    purpose; a ring-flagged author with genuine outside engagement now keeps
    the lane. A RESIDUAL stays open and is not closed by this change: a
    genuinely ZERO-audience victim can still be floored to 0.0 by a 2-account
    reciprocal star (documented at ``graph_cred.py``, a fix attempted and
    reverted 2026-08-01) and so still loses this lane — no predicate reachable
    from here closes that half, since the underlying score is already 0.0
    before this function ever sees the post; it needs the graph-cred floor
    itself fixed, not this exclusion rule;
  * a per-author cap, bounding how much ONE author can occupy: at most 3 posts
    in the pool, and at most ONE promotion per feed. Note what this does NOT do
    — it cannot stop a farm converting ACCOUNT COUNT into slots, because every
    new sock gets its own fresh budget. That threat needed a PER-FEED lane
    ceiling instead (``ExplorationConfig.max_slots_per_feed``, C2a) — the
    per-author cap alone bounded nothing about account count, only posts per
    account. The wording here used to claim ring exclusion covered it; ring
    exclusion cannot see an account-count farm by construction either, because
    such a farm has no reason to form a reciprocal ring;
  * interest targeting, so a slot is spent on someone the viewer plausibly wants;
  * self-deal exclusion, which is what catches the SOLO farmer no other defence
    here can see (see :func:`_is_self_dealt`);
  * bounded impressions — the boost pays reach, never score and never cred,
    which is the cold-start spec's own model for exactly this ambiguity;
  * a per-feed lane ceiling (``ExplorationConfig.max_slots_per_feed``, C2a,
    2026-08-04) — see :func:`insert_exploration`. Bounds the LANE'S SIZE, but
    ★ CORRECTED (C2c, 2026-08-04): this is NOT "the only mechanism here that
    actually prices an account-count farm", as this docstring used to claim.
    It caps the lane's total *size* per feed, not a farm's *share* of that
    size — a farm with enough distinct sock authors still fills 100% of the
    (now smaller) 3-slot budget, because the per-author cap only blocks the
    SAME author twice and C2a has no notion of "these accounts are related".
    Measured (`A4_slot_sweep.py`), scaling to 20 ground socks: 83.6% of the
    entire exploration budget, 0 ring-flagged — the account-count farm this
    lane's own docstring warns is invisible to ring detection;
  * a per-farm lineage bound (``insert_exploration``'s ``lineage`` parameter,
    C2c, 2026-08-04) — the mechanism that actually prices SHARE. Bulk accounts
    still share a creation/funding lineage on-chain even when they share
    nothing else, so grouping by that lineage and enforcing at most one
    promotion per lineage group per feed prices ACCOUNT COUNT directly, where
    the per-author cap and the per-feed ceiling both structurally cannot. See
    :func:`insert_exploration` for the mechanism and its cost to honest
    friend-funded newcomers.

GRADUATION IS NOT ON THAT LIST ANY MORE, and the change is worth stating
plainly rather than quietly dropping the bullet. The spec's rule was "leaves the
pool on the first QUALIFYING vouch", and its Sybil justification was that a ring
upvoting its own boosted post must not be able to graduate it into the normal
lanes. Graduation is now POSITIONAL (2026-08-04, see :func:`insert_exploration`
for the measurement that forced it), so that clause is gone — but the threat it
named never needed it. Outranking the slot is not a promotion INTO anything: a
pick already at or above the slot is simply skipped, keeps whatever rank it
earned on its own, and stops consuming the budget. The lane cannot launder a
ring's votes into reach it did not already have, and the ring itself is excluded
by the first bullet regardless.

NOT IMPLEMENTED, and honestly — BOTH gaps trace to the same missing serving log
(spec item B11), and neither is a small caveat:

  * The per-post SERVE cap (~100 serves) does not exist. Nothing counts
    impressions, so no post is ever retired early on FUTILITY — having been
    shown repeatedly and earned nothing is not a state this package can observe.
    (`ExplorationConfig.rotation_hours` covers the other half of what the cap
    was for — one post monopolising a given viewer's seat — by moving the seat
    on a clock. It is not a substitute for futility retirement.) The remaining
    bound is the age cap, and that window is NOT the 7 days
    `max_age_days` advertises, for anyone but the viewer's own follows: every
    OON/tag/interest query applies `AND created >= since` in SQL, and
    `since` defaults to `history.sourcing_freshness_days` (3 days). Only
    IN_NETWORK gets the wider `in_network_freshness_days`. So for a stranger's
    post — the lane's entire audience — the effective cap is
    min(sourcing_freshness_days, max_age_days) = 3 days, and `max_age_days` is
    unreachable. Nothing cross-validates the two, so raising one silently does
    nothing. This makes the real exposure SMALLER than documented, not larger.
  * `max_posts_per_author_epoch` is NOT epoch-scoped despite its name. It is
    evaluated inside a single call, over a set already narrowed to the 7-day
    freshness window, so what it actually enforces is "at most 3 of this
    author's posts in THIS request's rotation" — a concurrency cap, not the
    spec's 3-posts-per-30-day budget. There is no persisted count anywhere in
    `recsys/`. A prolific author can therefore keep 3 posts in flight
    indefinitely and cycle far more than 3 through any real 30-day window. The
    name is kept so it still matches the spec field it implements — the
    shortfall is recorded here rather than papered over by renaming it.
    (An earlier edit retracted this bullet's "favours whoever posts most often"
    warning on the grounds that the key had become least-heard-first. That
    retraction was WRONG and is itself retracted: the need key's second
    component was the recency of the author's newest post, so inside a need tier
    posting more often still bought precedence — measured, a
    posting-hourly author beat a quiet one with identical zero engagement. The
    within-tier recency tie-break has since been replaced by the keyed shuffle
    below, which is what actually removes it, and only while rotation is on.)

Both are Sybil-relevant, so the lane's real bound today is the per-request
concurrency cap plus ring detection plus self-deal exclusion, NOT the budget the
spec describes. B11 is the prerequisite for closing either.
"""

from __future__ import annotations

import bisect
import hashlib
import logging
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timedelta

from recsys.config import ExplorationConfig
from recsys.contracts import (
    Candidate,
    CandidateSource,
    GraphCred,
    Post,
    ScoredCandidate,
    ViewerProfile,
)

logger = logging.getLogger("recsys.exploration")

#: ★ C8 (2026-08-04): band edges for the "how much attention has this author
#: already received" key — see :func:`_need_tier`.
#:
#: ★★ CORRECTED (2026-08-04, same day, caught by the coordinator's end-to-end
#: tests before ship). The literal BUILDMAP-C reading, `(0, 3, 8, 20)`, puts
#: 0, 1 AND 2 distinct engagers all in band 0 — which means a GENUINE
#: newcomer (0 engagers) ties with an author who already has one or two real
#: readers, and the keyed shuffle then picks ARBITRARILY between them.
#: Measured on `tests/test_pipeline.py::_explore_world` (1 newcomer + 25
#: established authors, each established author holding 2 distinct voters):
#: the pool head became `est22, est00, est24, ...` — the newcomer was NOT
#: first, and the debut served at position 25, not the reserved slot at 13.
#: `test_exploration_reaches_the_served_feed_end_to_end` and
#: `test_the_lane_costs_the_rest_of_the_served_feed_nothing` failed 5/5 runs,
#: deterministically. That is this lane's PRIMARY case — "nobody has read
#: this person at all" is exactly the state the reserved seat exists to
#: serve — so a band scheme that erodes it is a regression, not a hardening.
#:
#: FIX: zero is its OWN band, `(0, 1, 3, 8, 20)`. Band 0 is now EXACTLY
#: `{0}` — a genuinely zero-engagement author is never diluted by ANY
#: engagement, however small — and coarsening (the actual C8 goal: make a
#: one-identity nudge insufficient to cross a band) applies only from band 1
#: upward, i.e. to authors who already have SOME audience. Band 1 is `{1,
#: 2}`, band 2 is `[3, 8)`, band 3 is `[8, 20)`, band 4 is `[20, inf)`.
#:
#: ★ HONEST RESIDUAL, stated plainly rather than hidden (per the coordinator's
#: explicit instruction: "if zero-as-its-own-band weakens the demotion
#: defence at the 0->1 boundary specifically, say so honestly rather than
#: trading the newcomer away for it — the newcomer case wins that tie").
#: Making band 0 exactly `{0}` means a SINGLE distinct engager is again
#: enough to move an account OUT of band 0 — the same single-identity power
#: C8 exists to remove, narrowly reopened at this one boundary. Concretely:
#: one griefer commenting once on each of N rivals who otherwise have ZERO
#: engagement still moves every one of them from band 0 to band 1, and an
#: attacker whose own post is ALSO untouched (0 engagers) keeps band 0 to
#: themselves and wins the slot — see
#: `test_residual_one_identity_can_still_move_a_rival_out_of_the_zero_only_band`
#: in the test module, which PINS this as accepted behaviour, not a bug.
#: The coarsening C8 was built for still holds everywhere ABOVE band 0: an
#: author who already has at least one real engager needs enough MORE
#: distinct identities to reach the next band edge, not just one, to be
#: pushed out of their band — see
#: `test_c8_one_identity_cannot_demote_a_rival_that_already_has_a_baseline_audience`.
#: This is a real, honest trade, not a full close — the same posture this
#: module already takes for the C4 residual (a documented gap, not a silent
#: one).
#:
#: No :class:`~recsys.config.ExplorationConfig` field threads a different
#: value through yet — see this module's build report for what
#: config.py/pipeline.py would need to wire one through. Kept as a
#: module-level default rather than inline in the function signature so a
#: test (or a future config field) can reference the SAME shipped value
#: instead of retyping the tuple.
#: ★★★ THE 3-ENGAGER DEAD ZONE — CLOSED 2026-08-06 (punch list item 6). The
#: history below is kept because two of the three attempts were wrong in ways
#: worth not repeating, and because the reason this took three days is a lesson
#: about gates, not about band edges. Read to the end before changing this tuple.
#:
#: THE DEFECT. `_need_tier` used to put 0 engagers in tier 0, 1-2 in tier 1, and
#: **3+ in tier 2**, while merit needs roughly 4 vouched engagers to carry an
#: author. So an author who earned their THIRD engager dropped to a tier that
#: never wins the reserved slot, and was not yet carried on merit: measured reach
#: 10 -> 0, which is worse than having no engagement at all. Earning support made
#: you disappear.
#:
#: It also means ZERO ENGAGEMENT IS AN EXCLUSIVE TOP BAND, which is the property
#: the account-count farm is built on.
#:
#: TRIED, MEASURED, AND REVERTED IN ONE PIECE — merging the low bands to
#: `(0, 4, 8, 20)` so "unheard" spans up to the merit threshold:
#:   * 13/13 panels stayed green;
#:   * the farm attack IMPROVED on every axis — farm share 70.0% -> 66.7%,
#:     distinct honest reached 5.0 -> 6.0 (no socks) and 1.0 -> 1.3 (20 socks);
#:   * and it broke EIGHT tests that pin the current tiering, five of them
#:     end-to-end pipeline behaviour.
#:
#: Reverted rather than pushed through: a ranking change whose blast radius is
#: eight behavioural tests is its own measured pass, not a punch-list slot — and
#: this lane has produced a regression from three of its last five changes. The
#: numbers above say the merge is probably right; they do not say it is safe.
#: ★★★ SHIPPED 2026-08-06 — `(0,1,4,8,20)`, and WHY THE BLOCKER WAS NOT REAL.
#:
#: This is round-5 Seat 3's variant, and it is strictly better than the
#: `(0,4,8,20)` merge above: it closes the dead zone (3 engagers stay in band 1
#: instead of dropping to band 2 while merit needs ~4) AND keeps band 0
#: exclusive to genuine zero-engagement newcomers. The merge's farm
#: "improvement" came FROM destroying that band — the gain and the regression
#: were one mechanism, so band edges could not buy one without the other.
#:
#: IT WAS APPLIED, MEASURED, AND BACKED OUT ONCE (2026-08-05), because
#: `mutate_panels.py --panel q11_follow_curve.py` reported:
#:
#:     (0,1,3,8,20)  ->  3 CAUGHT, 0 MISSED
#:     (0,1,4,8,20)  ->  1 caught, 2 MISSED
#:
#: and that was read as "the shifted lane composition stops q11's world
#: exercising `unchosen_max_share`/`unchosen_max_per_page`, so the panel can no
#: longer fail when they are deleted." Backing out was the right call on the
#: evidence available: trading a real product bug for a silent loss of evidence
#: is the wrong trade on a project whose signature failure is gates that pass
#: while the thing is broken.
#:
#: ★ THAT DIAGNOSIS WAS WRONG, and re-measuring it directly is what finally
#: shipped this (2026-08-06). Both numbers reproduce exactly; the explanation
#: does not survive contact with the curves behind them:
#:
#:   * The caps are exercised just as hard under the new bands. Deleting the cap
#:     still moves q11's curve by -0.036 at n=12 and -0.044 at n=20.
#:   * The lane composition barely moved AT ALL. Baseline and mutant curves under
#:     the two band settings differ by ~0.0004 at every follow count.
#:   * What actually flipped:
#:
#:         cap-off mutant, n=20, old bands:  0.5494  vs threshold 0.54950 -> CAUGHT
#:         cap-off mutant, n=20, new bands:  0.5495  vs threshold 0.54950 -> MISSED
#:
#: A margin of ONE TEN-THOUSANDTH, at one follow count, on a tolerance of 0.015.
#: q11's `ACCEPTED_CURVE` had gone stale — the system had improved 0.02-0.04
#: above it at six of eight points — and that stale headroom was quietly
#: absorbing the entire effect of deleting the mechanism. The band change did not
#: remove coverage. It nudged a number by 0.0001 across a line it was already
#: sitting on. **The coverage this "blocker" was protecting did not exist.**
#:
#: Re-anchoring `ACCEPTED_CURVE` to the measured current baseline (UPWARD — a
#: tightening, see the long note at that constant) restores the gate honestly:
#: the same two mutants now fail at THREE follow counts by up to 0.044, 2-3x the
#: tolerance instead of 0.7% of it. Then this shipped.
#:
#: THE LESSON, which is worth more than the tuple: a gate reported CAUGHT for
#: months while its true margin was 0.0001. "3 CAUGHT, 0 MISSED" is not evidence
#: of coverage unless somebody has looked at the MARGIN. A pass and a coincidence
#: are indistinguishable from the outside — exactly the failure mode the
#: mutation harness exists to prevent, reappearing one level up, inside the
#: harness's own reference values.
#:
#: Verified at ship: 869 tests pass, 14/14 panels exit 0, panel mutation gate
#: 11 CAUGHT / 0 MISSED / 7 DECLARED, farm attack unchanged, and the two
#: boundary pins in `tests/test_exploration.py` inverted deliberately (they were
#: pinning the bug).
DEFAULT_NEED_BANDS: tuple[int, ...] = (0, 1, 4, 8, 20)


def _rotation_key(author: str, bucket: int, secret: bytes) -> bytes:
    """Per-author, per-bucket shuffle key for the reserved seat.

    Independent of who else is in the tier — that independence is the point; see
    the rotation comment in :func:`eligible_for_exploration`.

    ★ KEYED, NOT UNKEYED (C1a, 2026-08-04 — CRITICAL FIX). This used to be a
    bare ``blake2b(f"{bucket}:{author}")`` with no key at all — computable by
    ANYONE, for any future ``bucket`` (a pure function of the wall clock), for
    a name that does not even need to exist yet. Measured
    (`A1_namegrind.py`, `A13_setcover_e2e.py`): 6 accounts + ~92,546 offline
    hashes (~0.08s) held the reserved seat in 613/720 (bucket, viewer) cells —
    85.1% — against 60 honest silent rivals, with ZERO votes, comments,
    reblogs, or ring flags, and the cost barely rose with the size of the
    honest field. The lowest-hashing name held the seat for EVERY VIEWER
    SIMULTANEOUSLY, ground entirely offline before the account was even
    registered.

    ``secret`` makes this a MAC (``blake2b``'s own ``key=`` parameter), not a
    salt prefixed into the message — prefixing is a weaker, different
    construction (it does not use the hash's dedicated keying input, and it is
    the kind of thing a later edit "simplifies" back into `msg = secret +
    payload`, silently reopening length-extension-adjacent confusion). Without
    the secret an attacker cannot even EVALUATE this function to grind
    against, which is the whole point — see
    :class:`~recsys.config.ExplorationConfig.seat_secret` for where the key
    comes from, :func:`_resolve_seat_secret` for how it is picked per call,
    and :func:`_dev_fallback_secret` for the never-silently-unkeyed dev path.

    No default: a caller must always supply a real key, so this can never be
    called accidentally in its old, vulnerable shape.
    """
    return hashlib.blake2b(f"{bucket}:{author}".encode(), key=secret, digest_size=8).digest()


# ★ Per-process dev-mode fallback (C1a). Populated lazily, at most once per
# process, the first time `_resolve_seat_secret` needs a key and none was
# configured. Deliberately module-level (NOT re-generated per
# `ExplorationConfig` instance): the config is frequently rebuilt per-request
# from defaults, and a key that changed on every construction would make the
# "stable inside a bucket" rotation property untestable and, worse, would look
# like a working feature in dev while silently proving nothing about
# production, where the deploy-time secret genuinely is constant. Matches the
# "generated per-process" wording in the field's own docstring exactly.
# ★★ A FIXED, PUBLICLY-KNOWN DEV KEY — NOT `secrets.token_bytes` (2026-08-04).
#
# The first implementation generated a random 32 bytes per process. That is the
# safer-SOUNDING choice and it was the wrong one, for a reason measured rather
# than argued: it made the WHOLE MEASUREMENT HARNESS non-reproducible. Two runs
# of `q1_personalization.py` in separate processes, same PYTHONHASHSEED, same
# world, produced different output digests — while the world, `graph_creds` and
# even the ALS factor matrices were proven bit-identical across those same runs,
# so the divergence entered HERE and nowhere else. A build agent independently
# hit the same symptom and attributed it to numpy/BLAS non-determinism; that was
# a plausible guess and it was wrong.
#
# This project's panels are its only evidence. A harness that cannot reproduce
# its own numbers cannot accept or reject a change, which is most of what this
# codebase does.
#
# The security property is unchanged. What the keyed MAC must stop is an
# attacker GRINDING NAMES OFFLINE against a key they can compute. A fixed dev
# key is still a key — `_rotation_key` is never unkeyed — and production still
# REFUSES to start without a real secret (`__post_init__`, plus the defensive
# re-check in `_resolve_seat_secret`). Nobody is defended by a DEV key being
# secret: dev has no attackers and no users. Reproducibility is worth more.
_DEV_FALLBACK_SECRET = b"lumen-dev-seat-secret-not-for-prod-0000000000000"[:32]
_DEV_FALLBACK_WARNED = False


def _dev_fallback_secret() -> bytes:
    """The FIXED dev key, used only when ``ExplorationConfig.production`` is
    False and no ``seat_secret`` was configured. Never returned in production —
    ``__post_init__`` refuses that combination before this can be reached.

    Logs once per process rather than once per call: the warning's job is to
    tell an operator this deployment has no real secret, not to spam.
    """
    global _DEV_FALLBACK_WARNED
    if not _DEV_FALLBACK_WARNED:
        logger.warning(
            "exploration seat secret absent; using the FIXED dev key so runs "
            "stay reproducible. NEVER production — set LUMEN_EXPLORE_SEAT_SECRET."
        )
        _DEV_FALLBACK_WARNED = True
    return _DEV_FALLBACK_SECRET


def _resolve_seat_secret(config: ExplorationConfig, bucket: int) -> bytes:
    """The MAC key to use for ``bucket`` (C1a): picks between
    ``config.seat_secret`` and ``config.previous_seat_secret`` across a
    rotation rollover, and applies the dev-mode fallback when nothing was
    configured at all.

    ``bucket < config.seat_secret_active_from_bucket`` (and a
    ``previous_seat_secret`` was actually supplied) resolves to the OLD
    secret, so every replica agrees on which key covers which bucket
    regardless of when any one of them redeployed — see
    ``seat_secret_active_from_bucket``'s docstring for why that matters.
    Everything at or after the activation bucket, or with no rollover in
    progress at all (``seat_secret_active_from_bucket == 0``, the default),
    resolves to the current secret.
    """
    if config.seat_secret is None:
        if config.production:
            # Defense in depth only — `ExplorationConfig.__post_init__`
            # already refuses `production=True` with no `seat_secret`, so a
            # config that reaches here with both true has bypassed its own
            # validation (e.g. mutated after construction via `object.
            # __setattr__`, since the dataclass is frozen). Refuse rather than
            # silently hand back an unkeyed or per-process-random result.
            raise ValueError(
                "ExplorationConfig.production=True with no seat_secret at "
                "resolution time — refusing to rank with an unkeyed or "
                "per-process-random reserved seat."
            )
        return _dev_fallback_secret()
    if config.previous_seat_secret is not None and bucket < config.seat_secret_active_from_bucket:
        return config.previous_seat_secret
    return config.seat_secret


def seat_secret_fingerprint(secret: bytes) -> str:
    """8-hex-char SHA-256 prefix of a seat secret — safe to put in a log line
    so an operator can confirm two replicas agree without ever writing the
    secret itself anywhere (C1a: "log a SHA-256 prefix of 8 hex chars if an
    operator needs to confirm two replicas agree")."""
    return hashlib.sha256(secret).hexdigest()[:8]


def _need_tier(n: int, bands: Sequence[int]) -> int:
    """Which band ``n`` — a count of DISTINCT engager identities a post's
    author has already received (see the ``received`` accumulation in
    :func:`eligible_for_exploration`) — falls into.

    ★ C8 (2026-08-04). Before this, the sort/rotation keys below used the
    exact count directly, and that count is an attacker-writable field: ANYONE
    can comment on a rival's post, and every DISTINCT commenter adds exactly
    +1. Measured (`A10c_reach_correct.py`): 2 accounts + 3 comments per rival
    took an attacker from best position 33 / page1 0/60 to 13 / 60/60 against
    20 rivals — because the exact count let one identity's single comment on
    EVERY rival demote all of them simultaneously, for one fixed cost that
    does not scale with the number of victims.

    Banding removes the "exactly 1 distinct engager is a meaningfully
    different state from 0" property THAT MATTERS — that made a single
    reusable comment enough to demote an author who already has some
    audience: with the shipped :data:`DEFAULT_NEED_BANDS` =
    ``(0, 1, 3, 8, 20)``, an author sitting at 1 or 2 distinct engagers needs
    enough MORE identities to reach the next edge (3), not just one, before
    they leave that band — so a lone identity commenting once on a rival who
    already has one real reader no longer moves that rival to a worse band.

    ★★ ZERO IS ITS OWN BAND, DELIBERATELY (corrected 2026-08-04, same day,
    caught by the coordinator's end-to-end pipeline tests before ship — see
    :data:`DEFAULT_NEED_BANDS` for the measured regression this fixes). The
    first cut of this band used the literal BUILDMAP-C edges, `(0, 3, 8,
    20)`, which put 0, 1 AND 2 distinct engagers all in the SAME bottom band
    — silently merging a genuinely NEVER-engaged newcomer with an author who
    already has one or two real readers, so the keyed shuffle picked between
    them arbitrarily. That is the lane's PRIMARY case (a zero-audience debut
    is exactly who the reserved seat exists to serve), so eroding it is a
    regression dressed as a hardening. Putting 0 in a band of its own,
    `{0}`, restores an unconditional top priority for true newcomers,
    independent of how the higher bands are drawn.

    HONEST LIMIT, stated plainly. Two distinct ones now, not one:

    1. Per BUILDMAP-C's own ruling on this unit: *banding raises the price,
       it does not close the attack.* For any band above 0, a fixed number
       of reusable identities (however many are needed to reach the next
       edge from an author's CURRENT count) still demotes an unlimited
       number of rivals for that one fixed one-time cost — the underlying
       problem (an inferred "has this been heard" signal built from
       attacker-writable engagement, rather than a served-impression FACT)
       is not fixed by any choice of band edges. Closing it needs the
       serving log (spec item B11).
    2. NEW, from making 0 exclusive: a SINGLE distinct engager is again
       enough to move an account OUT of band 0 specifically (0 -> 1 crosses
       a boundary by construction, since band 0 is now exactly one count
       wide). One griefer touching N rivals who otherwise have zero
       engagement still moves every one of them out of band 0 for that one
       account — see
       ``test_residual_one_identity_can_still_move_a_rival_out_of_the_zero_only_band``.
       This is an accepted, deliberate trade: the alternative is re-merging
       0 with 1-2, which is the regression this correction exists to
       reverse. The newcomer case wins the tie.

    Uses ``bisect.bisect_right`` so a count exactly ON a band edge (e.g. `n=3`
    with edges `(..., 3, ...)`) counts as being IN that band, not the one
    below it — matching the ordinary reading of "3-7 is a band". ``bands``
    must start at (or below) 0 and be sorted ascending, which
    :data:`DEFAULT_NEED_BANDS` satisfies; ``max(..., 0)`` is defense-in-depth
    against a caller-supplied ``bands`` that does not start at 0, so this can
    never return a negative tier and silently invert the ordering.
    """
    return max(bisect.bisect_right(bands, n) - 1, 0)


def _interest_match(post: Post, viewer: ViewerProfile) -> bool:
    """Whether the post falls inside something the viewer explicitly asked for.

    Interest-TARGETED by design (the spec follows Trial-Reels' cold-audience-by-
    interest policy): an exploration slot is a scarce, unearned impression, and
    spending it on content the viewer has shown no interest in is how a fresh
    lane becomes the thing users complain about.

    ★★★ THIS IS NOW A PREFERENCE, NOT A GATE (2026-08-09). It still decides WHO
    GETS THE SEAT whenever any newcomer matches; it no longer decides whether
    the seat exists. Measured live, requiring it forfeited the slot for every
    viewer on every request — 136 new authors / 3 days across 91 categories, 91
    of 91 outside three real viewers' interest sets combined. See
    :func:`eligible_for_exploration`'s split and
    :attr:`~recsys.config.ExplorationConfig.interest_fallback`.

    ★ PRIMARY TAG ONLY, NOT a full tag intersection (2026-08-04, ruling R3) —
    a hard release dependency, not a style choice. This lane is the single most
    exposed surface in the system: it bypasses BOTH the second-degree vouch
    gate and the author graph-cred floor
    (``CandidateSource.EXPLORATION.requires_second_degree`` and
    ``.requires_author_floor`` are both ``False``), so nothing else stands
    between a candidate and the viewer. A full ``set(post.tags) &
    viewer.interest_tags`` test was measured to be exactly the attack this lane
    cannot afford: one sock tagged with all 12 topics reached 60/60 viewers on
    page 1, because with enough tags on one post "matches an interest" stopped
    filtering anything. Testing only ``post.category`` — the post's ONE primary
    / filed tag, still attacker-chosen but not attacker-multipliable within a
    single post — closes that.

    ``second_degree._ungated_lane_for`` deliberately keeps the full
    intersection: that lane still carries ``requires_author_floor``, so
    tag-spray buys an attacker nothing there without also clearing the
    author's graph-cred floor. Two different rules for two differently
    defended lanes.
    """
    return bool(post.category and post.category in viewer.interest_tags)


def _is_self_dealt(post: Post) -> bool:
    """Whether the post's own author appears among its engagers.

    ★ Added 2026-08-04 after the lane was MEASURED handing its slot to a
    spammer. The threat this closes is the one every other defence here misses:
    a SOLO self-farmer. `q5b` publishes 3 posts, each claiming 60 comments and
    20 reblogs, every one of them by the author. Against the lane's stated
    defences that account is invisible —

      * the proven-self-dealt exclusion (C4, ``graph_creds[author].score <=
        0.0``) needs SCALE or a repeated pattern to zero an account
        (`GraphCredConfig.min_ring_self_dealing_events`); one account acting
        alone produces neither, so its own graph-cred entry — if it has one at
        all — is not zeroed by this route;
      * the per-author epoch budget is 3 posts, and it published exactly 3;
      * `graph_creds` has no entry for it at all, exactly like a real newcomer,
        so no cred band and no floor can tell the two apart;
      * it is genuinely interest-matched and genuinely fresh.

    Measured, it therefore took the recency rotation's first slot and landed at
    position 13 in an ESTABLISHED viewer's feed — a self-farmed post with zero
    real engagement placed on the first page, by the discovery lane, for a
    viewer whose vouch gate had correctly excluded it everywhere else.

    Self-attribution is what separates the two: a genuine newcomer's debut has
    no engagers at all, while the farm's entire engagement is its own author.
    The rule is therefore NOT "has engagement" (that would exclude the newcomer
    whose first post earned two real comments) and NOT "credited engagement is
    zero" (which is also true of the honest newcomer). It is precisely: the
    author is engaging with themselves.

    This is §8.4's existing self-exclusion applied to eligibility rather than to
    score. Losing the exploration slot is the whole penalty — self-promotion is
    not otherwise punished, and every other lane treats the post exactly as
    before.

    LIMITS, stated honestly. A farmer who spends a SECOND account to do the
    commenting defeats this — but two mutually-engaging accounts are a ring,
    which `detect_rings` covers, and it costs them an account per post. A plain
    :class:`Post` carries counters with no identity, so self-dealing is
    invisible and this returns False; that is the same fail-toward-silence
    posture as `independent_vote_signal`, and it is why production must hydrate
    attribution. Votes are checked too, so a self-upvote alone is enough.
    """
    author = post.author
    if any(v.voter == author for v in post.votes):
        return True
    commenters: tuple[str, ...] = getattr(post, "commenters", ())
    rebloggers: tuple[str, ...] = getattr(post, "rebloggers", ())
    return author in commenters or author in rebloggers


def engagement_received(candidates: Iterable[Candidate]) -> dict[str, set[str]]:
    """Distinct identities that have engaged each author, for the need bands.

    ★ Extracted 2026-08-05 so the SERVE LOG's `clear()` and the need bands use
    ONE definition of "has this author been heard". A second, hand-copied rule
    would drift, and this project has already shipped that exact failure twice.

    ★★★ LITE VOTES ARE EXCLUDED (round-3 council, Seat 1, measured). Need bands
    govern the new-writer lane, so an unfiltered lite vote counted FULL VALUE
    and UNBOUNDED here while being capped at 0.5 (breadth) and 0 (stake) for
    merit. The consequence was backwards and severe: a lite reader LIKING a
    newcomer's post PUSHED THEM OUT of the lane — 0-1 lite likes: rank 13, seen
    by 10/10 viewers; 3 lite likes: rank 33, seen by 0/10; 4 CHAIN votes: rank
    10, 10/10 (merit carries them out, lite never does). Latent while L1/L2
    could not reach production, LIVE the moment that was fixed. Free engagement
    must not move the band that decides who is unheard — it is exactly the
    signal an attacker gets for nothing.
    """
    received: dict[str, set[str]] = {}
    for candidate in candidates:
        post = candidate.post
        received.setdefault(post.author, set()).update(post_engagers(post))
    return received


def post_engagers(post: Post) -> set[str]:
    """Distinct identities that have engaged ONE post — voters, commenters and
    rebloggers, minus the author, lite excluded.

    ★ EXTRACTED FROM :func:`engagement_received` 2026-08-15, NOT COPIED, and the
    distinction is the whole reason this function exists. Seen-suppression's
    resurrection rule needs the engager count PER POST; the need bands and the
    serve log need it PER AUTHOR (the union across everything they have written).
    Those are two different aggregations of ONE rule, and hand-copying the rule to
    get the second aggregation is precisely how this package's two previous
    "engagement" definitions drifted apart — a failure `pipeline.py` names at its
    `engagement_counts` construction ("two computations of how many people
    engaged this author that could disagree is precisely how the previous two
    designs broke"). One body, two callers.

    ★★★ LITE VOTES STAY EXCLUDED, and here that is load-bearing in a new way. A
    resurrection is a post earning its way back into a reader's feed. If a lite
    vote counted, a costless identity could resurrect any suppressed post at
    will — free engagement buying back the most valuable thing the ranker has,
    which is a second impression. The measured consequence of counting them in
    the need bands is recorded above ("3 lite likes: rank 33, seen by 0/10"); the
    consequence here would be a suppression rule an attacker turns off.
    """
    engagers = {v.voter for v in post.votes if not v.lite}
    engagers.update(getattr(post, "commenters", ()))
    engagers.update(getattr(post, "rebloggers", ()))
    engagers.discard(post.author)
    return engagers


def eligible_for_exploration(
    candidates: Iterable[Candidate],
    viewer: ViewerProfile,
    *,
    now: datetime,
    graph_creds: Mapping[str, GraphCred],
    suppressed: frozenset[str],
    show_nsfw: bool,
    config: ExplorationConfig,
    bucket: int = 0,
    need_bands: tuple[int, ...] = DEFAULT_NEED_BANDS,
    serves: Mapping[str, int] | None = None,
    author_first_post: Mapping[str, datetime] | None = None,
) -> list[Candidate]:
    """The exploration pool: posts that could not get in on merit and should be
    given one bounded chance to.

    ``candidates`` is the WHOLE gathered pool, not the posts that failed
    eligibility.

    ★ That distinction was a real bug on the first build (2026-08-04). Sourcing
    from the failed set looked elegant — "posts that could not get in" — and was
    wrong: the spec's condition is *0 qualifying vouches*, not *failed the
    gate*. A brand-new author's post very often PASSES eligibility (the
    cold-start `INTEREST_*` lanes are gate-exempt, and one friendly vouch clears
    the second-degree gate) and then simply loses on score, which is the entire
    problem this lane exists to solve. Sourcing from failures skipped exactly
    those posts. Measured with the failed-set version: a cold viewer's feed put
    the newcomer's three debut posts at positions 99, 106 and 108 — present,
    unreachable, and never once given the reserved slot.

    GRADUATION IS NOT APPLIED HERE. The spec's rule was "0 qualifying vouches",
    and it is gone (2026-08-04) — a vouch does not make a post rank, so ejecting
    on the first one dropped a newcomer from position 13 to ~115 among the
    voucher's own followers. :func:`insert_exploration` graduates positionally
    instead: a pick already at or above the slot is skipped without spending it.
    Because the pool is drawn from everything, that same check is also what stops
    a post being shown twice.

    Every remaining condition is required: fresh enough, author not PROVEN
    self-dealt (``graph_creds[author].score <= 0.0``; see the C4 note below),
    not self-dealt on THIS post (:func:`_is_self_dealt`), viewer-safe
    (mute/suppressed/NSFW), genuinely new (``config.max_author_age_days``), and
    inside the author's per-request post cap. Ordering is a deterministic
    round-robin over authors — least-heard first, newest-first within an
    author — so the scarce slot goes to whoever needs it most and the same
    inputs always yield the same order.

    ★ THE INTEREST MATCH IS A PREFERENCE, NOT A REQUIREMENT (2026-08-09, option
    C, owner's choice). Candidates matching the viewer's declared interests
    (:func:`_interest_match`) are the pool whenever there is at least one; when
    there is none, the pool is the remaining eligible newcomers rather than
    nothing, because 91 of 91 live newcomer categories fell outside three real
    viewers' interests combined and the seat was forfeiting for everybody. The
    two sets are never merged — see the split in the loop below, and
    :attr:`~recsys.config.ExplorationConfig.interest_fallback` for the switch
    that restores the mandatory rule byte-for-byte.

    ★ ``graph_creds`` REPLACES raw ring-flag exclusion (C4, 2026-08-04). The
    lane used to drop any ``post.author in ring_members``, and that was
    measured to let an attacker convert SUPPRESSION into a GAIN: two reusable
    sock accounts can get an honest new author ring-flagged (with zero votes,
    comments or reblogs of their own — a false positive `detect_rings`
    already documents), and the raw flag alone then closed this lane to the
    victim — 60/60 viewers down to 0/60 — while the attacker's own share of
    the exploration budget rose from 0.2% to 27.3%. Excluding on the PROVEN
    self-dealt band (``score <= 0.0``, the same bar
    :func:`~recsys.pipeline._fallback_filler` already uses) instead of the
    raw flag keeps the proven self-dealer out while leaving a ring-flagged
    author with genuine outside engagement in the lane. An author absent from
    ``graph_creds`` entirely (a true newcomer, or the pre-hardening no-snapshot
    case) is NOT excluded — fail-open, the same posture the graph-cred floor
    takes everywhere else in this package.

    RESIDUAL, stays open: a genuinely ZERO-audience victim can still be
    floored to exactly 0.0 by a 2-account reciprocal star (documented at
    ``graph_cred.py``; a fix was attempted and reverted 2026-08-01) and so
    still loses this lane — nothing reachable from this function can tell
    that victim apart from a real self-dealer, because the score is already
    0.0 by the time this function sees it. Closing it needs the underlying
    graph-cred floor fixed, not a smarter predicate here.

    ``bucket`` is the caller's clock bucket — ``int(now.timestamp()) //
    (rotation_hours * 3600)``, computed in ``rank_feed``. It rotates the seat
    among EQUALLY-needy authors so one post cannot occupy a given viewer's slot
    for days on end; 0 disables it. See the comment at the
    rotation itself for why it is confined to a need tier, and
    :attr:`~recsys.config.ExplorationConfig.rotation_hours` for what it does and
    does not substitute for. ★ The rotation's shuffle key is now SECRET-KEYED
    (C1a) — see :func:`_rotation_key` and
    :class:`~recsys.config.ExplorationConfig.seat_secret` — so unlike every
    other input here, resolving it can raise (a misconfigured production
    deployment) or emit a warning (an unconfigured dev one); see
    :func:`_resolve_seat_secret`.

    ``need_bands`` (C8, 2026-08-04) coarsens the "how much attention has this
    author already received" key used below into bands, rather than an exact
    distinct-identity count — see the block comment above ``received`` for why
    the exact count is itself an attacker-writable field, and
    :func:`_need_tier` for the banding. Defaults to
    :data:`DEFAULT_NEED_BANDS`; a caller may pass a different set of band
    edges, but the module default is what production ships with today because
    no config field threads one through yet — see this module's build report.
    """
    if config.slots_per_page <= 0:
        return []
    cutoff = now - timedelta(days=config.max_age_days)
    # How much attention has each author ALREADY received in this window? Used
    # to order the rotation by need (see below). Accumulated over every input
    # candidate, before any filtering, so an author's footprint counts even
    # through posts that are themselves ineligible.
    #
    # ★ DISTINCT ENGAGER IDENTITIES, never raw counters (fixed 2026-08-04, found
    # by the adversary council). The first version summed
    # `len(votes) + children + reblog_count`, and its docstring only reasoned
    # about SELF-inflation — "inflating your own counts sorts you later". The
    # real hole is the opposite: `children` is incremented by ANYONE who
    # comments, so the key was a field the attacker writes on the VICTIM.
    # Measured, one griefer account commenting 5 times on a newcomer's posts
    # moved them from slot 13 (page 1) to slot 53 (page 3) for every viewer —
    # cost, one account and 15 comments at Hive's 3-second interval.
    #
    # It had a blameless twin that is worse: those 5 comments could just as
    # easily be 5 genuine readers, so the newcomer was demoted from the
    # discovery lane BY THE LANE'S OWN SUCCESS.
    #
    # Counting distinct identities caps any single griefer's contribution at +1,
    # so demoting someone now costs one account per unit of harm rather than one
    # comment. The author is excluded so self-engagement cannot be used to
    # manufacture "need" downward either.
    #
    # ★ CORRECTED, C8 (2026-08-04): "one account per unit of harm" UNDERSTATED
    # the hole. `received` here still counts EXACT distinct identities, and the
    # sort/rotation below groups authors by that exact count — which means ONE
    # account is also one unit of harm PER RIVAL, reusable across every rival in
    # the pool for the same one-time cost. Measured (`A10c_reach_correct.py`): 1
    # account + 60 comments (a few per rival) took the attacker from best
    # position 33 to 13 while flooring 20 rivals simultaneously — not "costs an
    # account", but "costs an account, once, no matter how many victims". The
    # exact count is turned into a BAND (:func:`_need_tier`, ``need_bands``)
    # below specifically to raise this for anyone who already has SOME
    # audience: an author sitting at 1-2 distinct engagers needs more than one
    # more identity to leave that band. Zero is its own exclusive band (see
    # `DEFAULT_NEED_BANDS`'s docstring for why a coordinator-caught regression
    # made this necessary), so a genuinely NEVER-engaged newcomer is never
    # diluted by even one real reader — but the flip side, stated honestly, is
    # that a single identity CAN still move an untouched rival out of that
    # zero-only band (0 -> 1 always crosses it). This does not close the
    # vector — see :func:`_need_tier`'s docstring for the full honest limit.
    received: dict[str, set[str]] = {}
    # ★ B1 (2026-08-05). `{}` when the caller supplies no log, which makes every
    # serve-log branch below inert and reproduces pre-B1 behaviour exactly — the
    # many callers that rerank a pool in isolation (unit tests, panels that are
    # not measuring this lane) are deliberately unaffected.
    served_counts: Mapping[str, int] = serves or {}
    fresh: list[Candidate] = []
    # ★ Option C's second bucket — eligible newcomers the viewer never named the
    # topic of. Used ONLY if `fresh` ends up empty; see the split below.
    off_interest: list[Candidate] = []
    # ★★★ WHY THE LANE IS EMPTY, PER REASON (2026-08-08).
    #
    # Every `continue` below produces the same observable outcome — no pick, the
    # seat forfeits, the page still serves 20 items — whether the cause is "no
    # newcomer posted today" (correct) or "the newness lookup is down"
    # (an outage). The 2026-08-08 build reported the seat "correctly forfeits"
    # for two real viewers while the lookup behind it was taking 311 SECONDS,
    # and nothing in the output could have distinguished the two. These counters
    # are what make an empty lane state its own cause.
    drops: Counter[str] = Counter()
    candidates = list(candidates)
    received = engagement_received(candidates)
    for candidate in candidates:
        post = candidate.post
        # ★ VIEWER-SAFETY FILTERS (added 2026-08-04). These are NOT redundant
        # with `filter_eligible`, and assuming they were is how the lane shipped
        # broken. This function is handed the RAW gathered `candidates`, on
        # purpose — the pool must contain posts that lose on score, and
        # `filter_eligible`'s output has already had the second-degree gate
        # applied, which would re-impose exactly the gate this lane exists to
        # bypass. The cost of taking the raw set is that every OTHER protection
        # `filter_eligible` applies is skipped too, and the first build skipped
        # all of them.
        #
        # Measured, with a cold viewer who had MUTED an author: that author's
        # posts landed at position 13 — the reserved slot — in the feed of the
        # very viewer who muted them. A mute is an unconditional promise to the
        # reader, and the discovery lane was quietly overriding it. Suppressed
        # posts and NSFW leaked by the same route.
        # ★★★ B1 / SERVING LOG (2026-08-05) — RETIRE ON FUTILITY.
        #
        # An author who has already been given `max_serves_per_author` reserved
        # slots and STILL has no engagement leaves the lane. This is the one
        # bound here keyed on something the attacker cannot control: they choose
        # whether to post and whether to engage, but not whether the system
        # already served them.
        #
        # Measured before this existed: 20 accounts that each posted once and
        # did nothing else took 100% of every served exploration slot
        # (`attacks/exploration_capture.py`). Retiring on serves makes an
        # identity worth a bounded number of slots instead of an unbounded
        # position, which is what prices ACCOUNT COUNT.
        if (
            config.max_serves_per_author > 0
            and served_counts.get(post.author, 0) >= config.max_serves_per_author
        ):
            drops["served_out"] += 1
            continue
        if post.author in viewer.mutes:
            drops["muted"] += 1
            continue
        # ★★ P1 (2026-08-05) — and the SELF-POST exclusion belongs here for
        # exactly the reason the mute check above does: this lane sources from
        # the RAW gathered pool, deliberately bypassing `filter_eligible`, so a
        # guard added there does NOT cover this path. Fixing only
        # `second_degree.filter_eligible` would have left a viewer's own post
        # able to take the reserved seat at position 13 — the most prominent
        # slot on the page — which is a louder version of the same bug.
        if post.author == viewer.account:
            drops["own_post"] += 1
            continue
        if post.key in suppressed:
            drops["suppressed"] += 1
            continue
        if post.is_nsfw and not show_nsfw:
            drops["nsfw"] += 1
            continue
        if post.created < cutoff:
            drops["stale"] += 1
            continue
        # ★ C4 (2026-08-04): PROVEN self-dealing (graph-cred zeroed), not the
        # raw ring flag — see the docstring above for the measured attack this
        # replaces (`A5_suppression_compose.py`: 2 socks flag 100/100 victims
        # and gain the seat instead of merely griefing).
        # ★★★ THE NEWNESS PREDICATE (2026-08-08) — the gap this module's own
        # docstring has conceded since the lane shipped: "This does NOT make the
        # lane new-author-only; that needs an author-age or graph-cred-absence
        # condition, which both councils flagged as the real v1.0 gap."
        #
        # WHY IT IS NOT OPTIONAL ONCE THE SEAT IS PROMINENT. Every condition
        # above selects for the UNENGAGED, and on Hive the unengaged are
        # overwhelmingly DOWNVOTED VETERANS rather than debuts. Measured across
        # 5 real viewers (2026-08-08) the reserved seat went to `tdvtv` (created
        # 2020-12-17, 28,777 posts), `darkflame` (2016, 15,552 posts), `sadcorp`
        # (1,233 posts, reputation -40.8bn), `alexwo` (947 posts, -843bn) and
        # `toluwanispecial` (768 posts) — one genuine debut in the sample.
        #
        # FAIL-CLOSED: an author whose first-post date is unknown is refused.
        # Fail-open would treat every author the lookup missed as a debut, which
        # is exactly the state this predicate exists to detect. An empty lane
        # then FORFEITS the seat (`insert_exploration` returns the feed
        # unchanged), which returns the slot to merit content — the honest
        # outcome when there is no newcomer to show.
        #
        # ★ THE TWO REFUSALS ARE COUNTED SEPARATELY (2026-08-08), because they
        # mean opposite things and produce the identical served output.
        # `newness_unavailable` is the lookup being absent or broken — an
        # OUTAGE. `not_new` is the predicate doing its job on a real veteran.
        # Collapsing them is what lets a dead lane read as "correctly forfeits".
        if config.max_author_age_days > 0:
            if author_first_post is None:
                drops["newness_unavailable"] += 1
                continue
            first = author_first_post.get(post.author)
            if first is None or first < now - timedelta(days=config.max_author_age_days):
                drops["not_new"] += 1
                continue
        cred = graph_creds.get(post.author)
        if cred is not None and cred.score <= 0.0:
            drops["self_dealt_cred"] += 1
            continue
        if _is_self_dealt(post):
            drops["self_dealt_post"] += 1
            continue
        # ★★★ OPTION C (2026-08-09) — PREFER AN INTEREST MATCH, FALL BACK TO ANY
        # ELIGIBLE NEWCOMER RATHER THAN FORFEIT THE SEAT.
        #
        # Every OTHER filter above has already run at this point, so `off_interest`
        # holds candidates that are viewer-safe, fresh, genuinely new by
        # `max_author_age_days`, not self-dealt, not served out — newcomers the
        # viewer simply never named the topic of.
        #
        # WHY THE OLD RULE HAD TO CHANGE, measured on the live chain: 136
        # genuinely new authors posted in 3 days across 91 distinct categories,
        # and 91 of 91 fell outside all three test viewers' interest sets
        # COMBINED. The gate was not targeting the seat, it was deleting it — for
        # every viewer, on every request — while the lane's own logging reported
        # "correctly forfeits", which is exactly the ambiguity the `drops`
        # counters above were added to end.
        #
        # RE-MEASURED HERE, live, 2026-08-09, with the mandatory rule still on
        # (`interest_fallback = False`), derived tags at k = 14: for `gtg` 13 of
        # 653 candidates survived every filter above and 13 of 13 then failed
        # this one; for `steevc`, 19 of 884 survived and 19 of 19 failed. Both
        # seats forfeited. Neither number is a shortage of newcomers — it is the
        # match rate being zero.
        #
        # ★ THE PREFERENCE IS ABSOLUTE (see `ExplorationConfig.interest_fallback`).
        # `off_interest` is used ONLY when `fresh` is empty — never merged into
        # it. A merged pool would let `seat_order`'s score key hand the seat to a
        # non-matching post over a matching one, i.e. re-open the tag-breadth
        # pressure ruling R3 closed by restricting `_interest_match` to the
        # primary tag. Off-interest content competes only with other off-interest
        # content, and only when the alternative is an empty seat.
        if not _interest_match(post, viewer):
            drops["no_interest_match"] += 1
            off_interest.append(candidate)
            continue
        fresh.append(candidate)

    interest_matched = len(fresh)
    if not fresh and off_interest and config.interest_fallback:
        # ★ SAY WHICH KIND OF SEAT THIS IS, EVERY TIME. The served output is
        # identical whether the occupant was interest-matched or a fallback, and
        # the fallback RATE is the number that says whether J1/J2's wider interest
        # vocabulary is working. INFO, not DEBUG: it is one line per request on a
        # lane that is 1 of 20 slots, and it is the only place the distinction
        # exists at all.
        logger.info(
            "exploration: NO interest-matched newcomer for %s (%d eligible "
            "newcomers, all off-interest) — filling the reserved seat from them "
            "rather than forfeiting it. Viewer declared %d interest tags.",
            viewer.account,
            len(off_interest),
            len(viewer.interest_tags),
        )
        fresh = off_interest

    # ★ AN EMPTY LANE MUST SAY WHY. WARNING, not DEBUG: the seat is 1 of 20
    # slots and forfeiting it is a real (if bounded) loss of the newcomer
    # on-ramp, so an operator should see the reason without turning anything on.
    # `newness_unavailable` dominating means the lookup is broken and the lane
    # is DEAD, which is an incident; `not_new` dominating means the predicate is
    # working and the pool genuinely held no debut, which is not.
    #
    # ★ `no_interest_match` now means "counted, and offered as fallback" rather
    # than "dropped" whenever `interest_fallback` is on and nothing matched — the
    # counter still records how the pool was reached, which is what an operator
    # reading this line needs.
    if not fresh and candidates:
        logger.warning(
            "exploration: pool EMPTY after filtering %d candidates — the "
            "reserved seat forfeits. Drops by reason: %s",
            len(candidates),
            dict(drops.most_common()) or "{}",
        )
    elif fresh and not interest_matched:
        logger.debug(
            "exploration: seat pool for %s is %d off-interest newcomer(s) "
            "(fallback).",
            viewer.account,
            len(fresh),
        )

    # Per-author epoch budget, then round-robin. Sorting by (author, -created)
    # first makes both steps deterministic regardless of input order.
    fresh.sort(key=lambda c: (c.post.author, -c.post.created.timestamp(), c.post.key))
    by_author: dict[str, list[Candidate]] = {}
    for candidate in fresh:
        held = by_author.setdefault(candidate.post.author, [])
        if len(held) < config.max_posts_per_author_epoch:
            held.append(candidate)

    # ★★ AUTHORS ARE ROTATED LEAST-HEARD FIRST (2026-08-04, both councils).
    #
    # The key used to be post recency alone, and RECENCY IS NOT NEWNESS. Nothing
    # in this function ever tested whether an author was actually new — the
    # conditions are fresh + unvouched + interest-matched + not-ring +
    # not-self-dealt, all of which an ESTABLISHED author's quiet recent post
    # satisfies just as well. So the lane built for new writers was ordering its
    # scarce slot by who posted most recently, which is uncorrelated with need
    # and is the single most attacker-controlled variable in the system.
    #
    # Measured, cold viewer, simworld seed 7 — the pool's first five authors by
    # the old key, with the engagement each had already received:
    #     a-photo-04  0.6h  received 27
    #     a-photo-08  2.5h  received 53
    #     a-photo-02  4.7h  received 22
    #     a-photo-01  5.3h  received 27
    #     newbie-author 6.0h received  0   <- 5th, purely for being 1.3h older
    # Slot 13 went to `a-photo-02`, an established author with 7 posts and 11
    # votes received; the newcomer took slot 33 — page 2. Of 20 pool authors, 19
    # had received engagement and exactly ONE was a genuine newcomer.
    #
    # Ordering by received engagement ascending costs nothing and is not a new
    # gate: established authors simply sort last, and the previous recency key
    # is kept as the tie-break, so among equally-unheard authors behaviour is
    # unchanged. Sybil-neutral by construction — a sock has 0 received and
    # already sorted first under recency, so this takes nothing from the
    # defences and gives a farm nothing new. Note the incentive direction:
    # inflating your own engagement counts sorts you LATER, never earlier.
    #
    # This does NOT make the lane new-author-only; that needs an author-age or
    # graph-cred-absence condition, which both councils flagged as the real
    # v1.0 gap. It makes the ORDERING serve need instead of clock.
    # The spec's phrase is "deterministic rotation WEIGHTED BY RECENCY"; the
    # first build implemented the rotation and dropped the weighting, ordering
    # authors by name. Measured, that made the lane useless in exactly its
    # target case: 60 authors were eligible in the sim world, the slot budget
    # reached ~10 of them, and they were allocated in alphabetical order — so
    # `a-photo-00`, an ESTABLISHED author who merely had one unvouched post,
    # took every slot and `newbie-author` never got one. The newcomer stayed at
    # positions 99/106/108, unchanged from having no exploration lane at all.
    #
    # It was also a free Sybil handle: with alphabetical order, renaming
    # yourself `aaa-` bought the scarce slot outright. Recency is not gameable
    # in the same way — everyone can post now, and the per-author epoch budget
    # is what actually bounds a farm.
    rotated: list[Candidate] = []
    # ★ BANDED, not the exact distinct-identity count (C8, 2026-08-04) — see
    # :func:`_need_tier` and the comment above `received` for why the exact
    # count let one reusable identity demote every rival in the pool for one
    # fixed cost. `need_bands[0]` is 0 by construction (see `_need_tier`'s
    # docstring), so a genuine zero-engagement newcomer is unaffected by this
    # change; only the boundary AT WHICH engagement starts to matter moves.
    authors = sorted(
        by_author,
        key=lambda a: (
            _need_tier(len(received.get(a, ())), need_bands),
            # ★ B1 (2026-08-05): within a need tier, an author the system has
            # ALREADY served ranks below one it has not. Need bands answer "how
            # unheard is this author" from engagement they receive — which a
            # sock suppresses by doing nothing — so two accounts can be equally
            # "unheard" while one has already had three page-one placements.
            # Serve count breaks that tie on observed fact, and it is why a farm
            # can no longer hold the lane simply by being numerous: each sock
            # sinks as it is spent.
            # ★★ ROUND-3 COUNCIL (Seat 2, verified). This tie-break is part of
            # B1 and was left LIVE when the serve budget was turned off, so
            # "max_serves_per_author=0 restores the pre-B1 behaviour exactly"
            # was false: the log still recorded, and ordering still flipped with
            # serve counts at the shipped default. A half-revert is its own bug.
            # 0 now means OFF in both halves — the count and the ordering.
            (served_counts.get(a, 0) if config.max_serves_per_author > 0 else 0),
            -by_author[a][0].post.created.timestamp(),
            a,
        ),
    )
    # ★★ CLOCK ROTATION, APPLIED WITHIN EACH NEED TIER ONLY (2026-08-04).
    #
    # The problem it solves is not fairness between authors, it is REPETITION
    # for the reader. Nothing counts serves (that needs the B11 serving log), so
    # a post that earns nothing keeps the seat for its whole eligibility window,
    # and since the pipeline has no randomness the same viewer meets the same
    # newcomer in the same seat on every refresh for days.
    #
    # WHY WITHIN A TIER AND NOT ACROSS THE WHOLE LIST. Rotating the sorted list
    # outright would hand the scarce seat to an author who has already been
    # heard, destroying the least-heard-first ordering that is the only reason
    # the lane reaches its target at all. Authors are therefore grouped by their
    # need key — the number of DISTINCT accounts that have engaged them — and
    # only equally-needy authors trade places. Need order between tiers is
    # exactly as before.
    #
    # The consequence worth stating: an author who is UNIQUELY the neediest sits
    # alone in their tier, so rotation is a no-op for them and they keep the
    # seat. That is the correct behaviour — with one genuine newcomer and
    # nineteen established authors in the pool, the newcomer should not lose
    # page one to a clock.
    #
    # ★★★ THE ORDER IS A PER-AUTHOR KEYED SHUFFLE, NOT AN INDEX ROTATION —
    # and the difference is the whole property (rewritten 2026-08-04 after a
    # scrutiny pass).
    #
    # The first version did `offset = bucket % len(tier)` and sliced. That makes
    # the seat a function of TIER SIZE, so anything that changes the size of the
    # tier re-rolls the seat MID-BUCKET — including events that could not
    # previously touch the head at all. Measured over 5,500 events per cell: an
    # OLDER post arriving moved the seat 85% of the time (0% before rotation
    # existed), and the tail member simply ageing out moved it 76% (also 0%
    # before). Ageout is continuous on a live site, so "stable inside a bucket,
    # a viewer cannot refresh-reroll" — the property this setting exists to
    # deliver — was false in exactly the conditions it has to hold under. It
    # also handed a farmer a lever: publishing or withholding a debut post
    # changes `len(tier)` and therefore selects the seat's occupant, at a moment
    # of the attacker's choosing.
    #
    # Keying each author independently removes the coupling: an author's
    # position depends on (their name, the bucket) and on nothing about who else
    # is in the tier, so members can arrive and leave without disturbing the
    # order of the rest. The seat then changes only when the bucket turns, or
    # when a genuinely better-placed candidate appears — which is a real change
    # in the candidate set, not an artifact.
    #
    # `blake2b`, not `hash()`: builtin string hashing is randomised per process,
    # and this package has just spent a session removing exactly that class of
    # nondeterminism from the measurement harness. Reintroducing it here — on
    # the serving path, where two replicas must agree — would be worse.
    #
    # This also retires the within-tier recency tie-break, deliberately. That
    # key ordered equally-unheard authors by who posted most recently, which
    # gave a prolific author standing precedence over a quiet one at identical
    # need; the shuffle removes it. Recency still orders an author's OWN posts
    # (see `by_author` above) and still decides the tie when rotation is off.
    if config.rotation_hours > 0 and bucket:
        # ★ C1a: resolved ONCE per call, not per author — a single MAC key
        # covers the whole shuffle for this (viewer-request, bucket), exactly
        # as it must for every author to land in one consistent order. May
        # raise (misconfigured production) or warn-and-fall-back (unconfigured
        # dev); see `_resolve_seat_secret`.
        secret = _resolve_seat_secret(config, bucket)
        # ★ Grouped by the same BANDED key as the sort above (C8) — the tier
        # grouping and the sort key must agree, or rotation could shuffle
        # together authors the sort just told apart (or vice versa).
        tiers: dict[int, list[str]] = {}
        for author in authors:
            tiers.setdefault(_need_tier(len(received.get(author, ())), need_bands), []).append(
                author
            )
        authors = []
        for _, tier in sorted(tiers.items()):
            # ★★★ SERVE COUNT IS THE PRIMARY KEY INSIDE THE TIER, MAC IS THE
            # SHUFFLE (fixed 2026-08-15). THIS BLOCK USED TO SORT BY THE MAC
            # ALONE, WHICH SILENTLY DISCARDED B1'S ORDERING HALF.
            #
            # The sort at the top of this section is
            # `(need_tier, served_count, -created, name)`. This block then
            # rebuilt `authors` from scratch, re-grouping by `_need_tier` ONLY
            # and re-sorting each group by `_rotation_key`. The `served_count`
            # component of the first sort therefore had NO EFFECT ON THE FINAL
            # ORDER under the shipped defaults (`rotation_hours = 6`, bucket
            # non-zero in production) — the whole intent recorded 60 lines above
            # ("an author the system has ALREADY served ranks below one it has
            # not … each sock sinks as it is spent") was inert, and only the
            # serve CAP still did anything. The other place that key survives is
            # `seat_order`'s `serves` tie-break, and `seat_order` ships OFF
            # (`seat_by_score = False`), so nothing anywhere sank a spent
            # author.
            #
            # This is the same "half-revert of B1" the round-3 council caught
            # once already (the ordering left live while the cap was off);
            # rotation reintroduced it from the other side. LIVE SYMPTOM, and it
            # is the reason this is a defect rather than a tidy-up: one newcomer
            # post held one reader's seat **66 times between 2026-08-13 01:01:41
            # and 2026-08-14 01:01:42 — exactly 24h, four whole rotation
            # periods, one occupant** (`lumen_feed_served`, read-only), while
            # that viewer's entire exploration history was 2 distinct posts
            # across 67 rows.
            #
            # WHY IT IS SAFE TO PUT SERVES FIRST INSIDE THE TIER. The MAC is a
            # keyed TOTAL ORDER over the tier and it stays exactly that among
            # equally-spent authors, so C1a's property is untouched: an attacker
            # without `LUMEN_EXPLORE_SEAT_SECRET` still cannot evaluate the
            # function to grind names, and the seat is still stable inside a
            # bucket (serve counts change only when the system serves, which is
            # not a refresh-reroll the viewer can drive). What changes is that
            # being served now COSTS you position, which is the entire point of
            # counting serves.
            #
            # ★ GATED ON THE SAME SWITCH AS THE SORT ABOVE. `0 now means OFF in
            # both halves — the count and the ordering` is a rule this file
            # already states and had already broken once; re-arming the ordering
            # under a different condition than the cap would break it a third
            # time.
            authors.extend(
                sorted(
                    tier,
                    key=lambda a: (
                        (served_counts.get(a, 0) if config.max_serves_per_author > 0 else 0),
                        _rotation_key(a, bucket, secret),
                    ),
                )
            )
    for depth in range(config.max_posts_per_author_epoch):
        for author in authors:
            # `posts`, not `bucket` — the parameter of that name is the clock
            # bucket, and the local was shadowing it.
            posts = by_author[author]
            if depth < len(posts):
                rotated.append(
                    Candidate(post=posts[depth].post, source=CandidateSource.EXPLORATION)
                )
    return rotated


def seat_order(
    pool: Sequence[ScoredCandidate],
    engagement_counts: Mapping[str, int],
    *,
    serves: Mapping[str, int] | None = None,
    need_bands: tuple[int, ...] = DEFAULT_NEED_BANDS,
    enabled: bool = True,
) -> list[ScoredCandidate]:
    """Re-order an already-need-ordered exploration pool so the RESERVED SEAT
    goes to the BEST-SCORING candidate inside the neediest band, instead of to
    whichever equally-needy author the keyed lottery happened to draw.

    ★ WHY (2026-08-08, owner: "the highest ranked one has an assured top 10
    slot — make sure that doesn't break the ranking"). The seat is now spliced
    into the TOP TEN (``ExplorationConfig.position``), where it is far more
    visible and far more expensive. Under the old ordering the occupant was
    picked by need tier and then by :func:`_rotation_key`, i.e. uniformly at
    random among equally-unheard authors — measured live, that put a 0.351 post
    among 0.52-0.57 neighbours. Choosing the strongest member of the same band
    costs the lane nothing (the band, not the score, is what makes this the
    new-author lane) and is what makes a top-10 seat defensible.

    ★★ THE NEED TIER STAYS THE PRIMARY KEY, AND THAT IS NOT NEGOTIABLE. Sorting
    the pool by score OUTRIGHT is a bug this lane has already shipped once
    (2026-08-04, recorded at the ``_score(explore_pool, ...)`` call site in
    ``recsys.pipeline.rank_feed``): the pool contains ESTABLISHED authors too —
    every condition in :func:`eligible_for_exploration` is satisfied by a
    well-known author's quiet recent post — so "highest-scoring in the pool"
    resolves to an incumbent and the newcomer sinks below sixty of them. Sorting
    within the BAND is the opposite operation: band 0 is exactly the
    zero-distinct-engager authors, so the winner is still by construction
    someone nobody has heard, only now the best of them.

    Ordering key is ``(depth, need_tier, serves, -final, original index)``:

    * ``depth`` — which of that author's posts this is (0 = their newest). The
      pool from :func:`eligible_for_exploration` is depth-major so every author
      gets one shot before anyone gets a second; re-sorting without this key
      would let one author's third post outrank another author's first.
    * ``need_tier`` — unchanged, and identical to the sort/rotation grouping
      :func:`eligible_for_exploration` already applies (:func:`_need_tier` over
      ``engagement_counts``, the SAME map ``rank_feed`` feeds the serve log, so
      there is only one definition of "has this author been heard" in play).
    * ``serves`` — B1's serve-count tie-break, and it MUST sit ABOVE the score
      or this function is a half-revert of B1. That mechanism's own comment in
      :func:`eligible_for_exploration` says why in as many words: "two accounts
      can be equally unheard while one has already had three page-one
      placements", and leaving half of B1 live while overriding the other half
      is the exact bug the round-3 council caught last time. ``None`` (the
      caller's signal that ``max_serves_per_author`` is 0, i.e. the budget is
      OFF) drops this key entirely — 0 means off in BOTH halves here too.
    * ``-final`` — the new key.
    * the original index — so the keyed-MAC order (:func:`_rotation_key`)
      survives as the TIE-BREAK, and the whole sort is total and deterministic.

    ★★★ WHAT THIS COSTS, MEASURED AND STATED PLAINLY RATHER THAN DISCOVERED
    LATER. The MAC still orders the pool that arrives here and still decides
    exact ties, but a continuous score rarely ties, so as a SEAT LOTTERY the MAC
    is now largely inert. Two consequences, one benign and one real:

    * The name-grinding attack it closed (C1a: 6 accounts + ~92,546 offline
      hashes held the seat in 85.1% of (bucket, viewer) cells) is *not*
      reopened — grinding a name buys nothing when names no longer order the
      band. This removes the seat's dependence on the name entirely, which is
      strictly stronger than keying it. Measured on
      ``attacks/exploration_capture.py``: every column is BYTE-IDENTICAL with
      this on and off (farm share 70.0% at 20 socks, 100% at 100, distinct
      honest reached 5.3 with no socks) — the farm owns the whole leading band
      either way, so which member of it wins changes nothing.
    * **THE SEAT STOPS ROTATING.** Within band 0 every author has zero
      engagement by definition, so ``final`` there is carried almost entirely by
      the additive freshness bonus (``ScoreWeights.organic_recency``) — the
      freshest debut wins, and unlike a lottery it keeps winning. Measured
      (``measurement-harness/attacks/seat_freshness.py``: 6 zero-engagement debuts aged 1-66h, 8
      consecutive 6-hour buckets): the lottery spread the seat over 4 distinct
      newcomers; score-ordering gave all 8 buckets to the 1-hour-old post. That
      is the "a posting-hourly author beats a quiet one at identical need"
      preference this module's docstring records, returning in a new place.
      What bounds it is B1, which is why ``serves`` is a key above: an author is
      sunk in this ordering as they are served and then leaves the lane at
      ``max_serves_per_author`` (3) per ``serve_window_days`` (7). So the
      freshest post holds the seat for THREE SERVES PLATFORM-WIDE, not for a
      clock bucket — with the log wired the same probe gives 3 distinct
      occupants over the same 8 buckets instead of 1. Posting more often can
      win a GIVEN seat more often; it still cannot win more seats per account
      per week.

    ``enabled=False`` returns the input order unchanged — byte-identical to the
    pre-2026-08-08 lane — which is what
    :attr:`~recsys.config.ExplorationConfig.seat_by_score` switches, and what
    every measurement taken before that date reproduces against.
    """
    if not enabled:
        return list(pool)
    served: Mapping[str, int] = serves or {}
    seen: dict[str, int] = {}
    keyed: list[tuple[int, int, int, float, int, ScoredCandidate]] = []
    for index, candidate in enumerate(pool):
        author = candidate.post.author
        depth = seen.get(author, 0)
        seen[author] = depth + 1
        tier = _need_tier(engagement_counts.get(author, 0), need_bands)
        keyed.append((depth, tier, served.get(author, 0), -candidate.score.final,
                      index, candidate))
    keyed.sort(key=lambda row: row[:5])
    return [row[5] for row in keyed]


def insert_exploration(
    ranked: Sequence[ScoredCandidate],
    pool: Sequence[ScoredCandidate],
    config: ExplorationConfig,
    *,
    lineage: Mapping[str, frozenset[str]] | None = None,
    ceiling: int | None = None,
) -> list[ScoredCandidate]:
    """Splice exploration picks into an already-ranked feed at a fixed position.

    Inserted AFTER re-ranking, never scored against the rest: the whole point is
    that this content cannot win on score. Placement is one slot per page at
    ``config.position`` — deep enough not to displace the head, shallow enough
    to actually be seen.

    ★ "NEVER DISPLACES ANYTHING" WAS FALSE and is corrected here (2026-08-04).
    Within this function nothing is dropped — a fresh pick grows the list by one
    and a promotion is length-neutral. But `rank_feed` truncates to
    `settings.diversity.top_k` immediately after calling this, and neither the
    growth nor the shift is accounted for there, so at the boundary the marginal
    tail item falls outside the cut. Nothing validates `top_k` against
    `page_size`/`position`, so a caller who sets `top_k` with no headroom past
    the deepest exploration-touched page loses one item per pick.

    That is not a bug to fix, it is what RESERVING a slot means — the reserved
    content has to come from somewhere, and the displaced item is the weakest
    one on the page. It was simply described wrongly. Under the shipped defaults
    (`top_k=200`, `page_size=20`, filler padding keeping eligible+filler <=
    top_k) a single pick does not reach the boundary at all.

    If the pool is empty the feed is returned unchanged.

    ★ A pick already present in ``ranked`` is PROMOTED, not skipped — it is
    removed from wherever it landed and placed in the reserved slot. This was
    the second bug in this build (2026-08-04). The first version de-duplicated
    against the feed, which sounded right and made the lane a no-op in its
    central case: measured, a cold viewer's feed already contained the
    newcomer's three debut posts at positions 99, 106 and 108, so every one of
    them was "already present", the pool emptied, and nothing was ever promoted.
    Being in the feed at position 99 is indistinguishable from being absent.

    A post is only promoted if it currently sits DEEPER than the slot; one
    already ahead of it is left alone rather than demoted. Nothing is ever
    dropped — items shift, so a feed only grows or reorders.

    ★ PER-FEED LANE CEILING (``config.max_slots_per_feed``, C2a, 2026-08-04).
    Without it the ceiling on ONE feed was ``slots_per_page * pages`` — 1 * 10
    = 10 on the shipped 200-post/20-per-page feed — which lets account COUNT
    convert directly into slots: `A4_slot_sweep.py` measured 10 ground socks
    taking 75.5% of every exploration slot on the platform, 20 taking 83.6%,
    with 0 ring flags (an account-count farm has no reason to form a
    reciprocal ring, so ring/self-dealing exclusion cannot see it at all — see
    the module docstring's Sybil-posture list). This bounds the LANE'S SIZE
    directly, independent of how many pages the caller's ``top_k`` spans.

    THE TRADE, stated plainly: an honest newcomer cohort competing for the
    same feed gets ``max_slots_per_feed`` seats instead of the old
    page-count-scaled ceiling — 3 instead of 10 at shipped defaults, a 70%
    cut in per-feed exploration impressions. This does nothing to a farm's
    SHARE of the lane, only its absolute per-feed take; it must ship alongside
    the tag-breadth pricing on ``_interest_match`` (already primary-tag-only,
    see its docstring) rather than as the sole defense, or new-author reach is
    cut for no matching gain against a farm that also controls its own tags.

    ★ PER-FARM LINEAGE BOUND (``lineage``, C2c, 2026-08-04). ``max_slots_per_feed``
    caps the lane's total SIZE per feed but has no notion that two DIFFERENT
    authors might be the same farm — an account-count farm converts sock count
    directly into feed share even under a 3-slot ceiling, because each sock is
    a distinct author and the per-author check above only ever compares one
    author to itself. Measured (`A4_slot_sweep.py`): 20 ground socks took
    **83.6%** of the ENTIRE exploration budget with **0** ring flags — an
    account-count farm has no reciprocal edge for ring detection to see by
    construction, and it needs no shared post, tag or self-vote for the
    per-post/per-author defenses to miss either.

    ``lineage`` maps an author to the OTHER authors sharing its
    creation/funding lineage (Hive `account_create` / `create_claimed_account`
    creator, plus delegation ties — the same relation
    :func:`~recsys.pipeline._lineage_for` already builds as
    the RETIRED ``gateway.stake_lineage`` (removed 2026-08-05, B2 — see
    :func:`recsys.pipeline._lineage_for`; callers now always pass an empty map,
    so this cap is INERT and the parameter is kept only as the seam for a
    consent-bearing replacement); see this module's build report for the
    wiring this needs from the pipeline/IO owners). Bulk accounts share a
    creator or funding wallet on-chain even when they share nothing else this
    lane can see, so this is the only mechanism in reach that actually prices
    ACCOUNT COUNT.

    The dedup check just above is generalised, not duplicated: with no
    ``lineage`` supplied (the default — ``None``, resolved to ``{}`` below),
    an author's lineage GROUP is just ``{that author}``, so the check reduces
    algebraically to exactly the old author-only comparison and every existing
    caller is bit-for-bit unaffected. Supplying ``lineage`` widens the group a
    pick is compared against to its known siblings, so at most ONE promotion
    happens per lineage group per feed — the same positional "already placed
    at or above the slot" scan that already enforces one-per-author, applied
    to a wider identity set. The lookup is checked in BOTH directions
    (``pick`` against a placed post's group, AND the placed post's author
    against ``pick``'s group) because ``stake_lineage`` is not guaranteed
    symmetric for every edge shape (see its docstring) — a one-directional
    check would let group membership depend on POP ORDER, which must not
    determine whether the cap fires.

    THE TRADE, stated plainly: an honest author who was onboarded by a friend
    who paid for their account creation shares that friend's lineage group and
    can lose a seat to them — bounded to at most ONE such collision per feed
    (the cap is enforced within this one call, never across feeds or
    requests), never demoted, only declined the reserved slot in favour of
    whichever lineage-mate got there first in pool order. This does not
    reduce ``max_slots_per_feed``'s cost (still a 70% cut vs. the pre-C2a
    ceiling, paid by every newcomer uniformly); it reallocates WITHIN that
    already-cut budget so one farm cannot claim the whole thing.
    """
    if config.slots_per_page <= 0 or not pool:
        return list(ranked)

    out = list(ranked)
    picks = list(pool)
    page = max(1, config.page_size)
    base = min(config.position, page - 1)
    inserted = 0
    # ★ ``ceiling`` OVERRIDE (2026-08-15, directive B2). ``None`` — every caller
    # that does not pass it, which is every caller today — is the exact
    # historic behaviour: the ceiling IS ``config.max_slots_per_feed``.
    #
    # The one production caller that may pass it (`pipeline.rank_feed`, behind
    # `ExplorationConfig.derive_slots_from_served_depth`, default OFF) computes
    # ``min(max_slots_per_feed, ceil(served_depth / page_size))``, i.e. it can
    # only ever LOWER this number. The parameter deliberately has no clamp of
    # its own: a bound that silently rewrites what its caller asked for is how
    # `max_slots_per_feed` came to be described three different ways in this
    # file. If a future caller wants a HIGHER ceiling it must raise
    # `max_slots_per_feed` itself, in the open, where the 75.5%/83.6% farm-capture
    # measurement recorded in that field's docstring is sitting.
    ceiling = config.max_slots_per_feed if ceiling is None else ceiling
    # ★ C2c (2026-08-04): resolve ``None`` once, up front — every lookup below
    # treats an author absent from `lineage` as having no known siblings,
    # which is exactly the "not configured" fail-open posture this lane takes
    # everywhere else (graph-cred absence, mute-list absence, and so on).
    lineage_map: Mapping[str, frozenset[str]] = lineage or {}
    # ★ ONE EXPLORATION PROMOTION PER AUTHOR PER FEED. Deliberate: the budget is
    # ~10 slots in a 200-post feed and its whole purpose is spreading scarce
    # reach across as many unheard authors as possible, so letting one author
    # take 3 of 10 is a direct loss. Pages without a pick are not empty — they
    # carry normally-ranked content. `max_posts_per_author_epoch` therefore
    # bounds POOL PRESENCE, not promotions; the round-robin's depth-1/depth-2
    # entries are pool shape, never a promise of a second slot.
    #
    # ★★ Enforced by the `i <= at` scan below, and NOT by a separate set. A
    # `promoted_authors` set was added here to "make the policy explicit" and
    # was then proved to be dead code: `at` is non-decreasing across the loop
    # and a promoted item never moves (later inserts and pops both target
    # strictly greater indices), so a promoted post is always at some index
    # <= every later slot and the positional scan already declines its author.
    # Reverting the set alone changed no test; reverting both mechanisms failed
    # two. It was deleted rather than kept as belt-and-braces — the honest
    # record is that the positional check was load-bearing all along.
    while picks and inserted < ceiling:
        page_index, within = divmod(inserted, config.slots_per_page)
        at = page_index * page + min(base + within, page - 1)
        if at > len(out):
            break
        pick = picks.pop(0)
        # ★ AN AUTHOR ALREADY PLACED ABOVE THE SLOT DOES NOT ALSO GET IT
        # (added 2026-08-04). Dedup was by post KEY only, so an author with a
        # merit-ranked post could win the reserved slot with a SECOND, unrelated
        # post — two slots for one author, and `diversity_rerank` cannot re-run
        # to space them because the splice happens after it.
        #
        # ★★ The FIRST version of this check compared against the whole feed
        # ("author appears anywhere") and broke the lane's primary case
        # outright: the q3 newcomer publishes THREE debut posts, all of them
        # buried together at 99/106/108, so each one blocked the promotion of
        # the other two and the newcomer went straight back to 99 — the exact
        # no-op this lane was built to fix. It was also far stricter than
        # anything the system actually enforces: `diversity_rerank` applies a
        # SOFT decay (`author_decay`/`author_floor`), never a hard cap.
        #
        # AHEAD OF THE SLOT is the honest analogue of rerank's "already placed"
        # counter, which counts only what was placed above. An author at
        # position 5 has real reach and is declined; an author whose every post
        # sits at 99+ has none, and is exactly who the slot is for. This also
        # corrects a misreading of the original repro: `alice` at position 21 of
        # a 22-item feed looked like "already visible" and was in fact the tail.
        #
        # The pick's own key is excluded so promotion still works — a promoted
        # post trivially "appears" in the feed as itself.
        #
        # ★ GENERALISED TO A LINEAGE GROUP, NOT JUST THE ONE AUTHOR (C2c,
        # 2026-08-04). `pick_group` is `{pick's author}` when `lineage_map` is
        # empty (the default), which makes the membership test below reduce
        # algebraically to the exact old comparison
        # (`c.post.author == pick.post.author`) — every caller that never
        # passes `lineage` is bit-for-bit unaffected. When `lineage_map` IS
        # supplied, the group widens to the pick's known siblings, so a post
        # already placed at or above the slot from ANY sibling — not only the
        # identical author — also declines this promotion. Checked in BOTH
        # directions (`c.post.author in pick_group` AND `pick.post.author` in
        # the placed post's OWN group) because `stake_lineage` is not
        # guaranteed symmetric for every edge shape (see its docstring) — a
        # one-directional check would make the cap depend on pool POP ORDER,
        # which must never decide whether it fires.
        # ★★★ C2 / DOUBLE-SERVE (2026-08-05). The bound is THIS PAGE, not "at or
        # above the slot".
        #
        # `i <= at` declined an author only when they were already ahead of slot
        # 13. But B-04's emerging-author budget frequently lands a newcomer on
        # page 1 BELOW 13 — the realistic case on a busy feed — and that author
        # then ALSO drew an exploration promotion, spending one of only
        # `max_slots_per_feed` (3) slots on somebody who already had guaranteed
        # page-1 reach. Reproduced twice independently: a newcomer pre-placed at
        # 15 ended up occupying [13, 16], and at 19 -> [13, 20].
        # BUILDMAP-B flagged "check for double-serve" and it was never closed.
        #
        # ★ WHY NOT "APPEARS ANYWHERE" — the check this replaces has history and
        # it must not be undone. Comparing against the WHOLE feed broke the
        # lane's primary case: the q3 newcomer publishes three debut posts buried
        # together at 99/106/108, and each blocked the promotion of the other
        # two, sending the newcomer straight back to 99. Those posts have no
        # reach; blocking on them was wrong.
        #
        # `page_end` is the honest line between those two. An author already
        # placed ON THIS PAGE (or an earlier one) has the reach this slot exists
        # to grant, so the slot goes to someone genuinely unseen instead. An
        # author whose every post sits at 99+ is still exactly who the slot is
        # for and is still promoted. The rule scales to page 2 (`at` = 33) by
        # construction rather than by a second special case.
        page_end = (page_index + 1) * page
        pick_group = lineage_map.get(pick.post.author, frozenset()) | {pick.post.author}
        if any(
            i < page_end
            and c.post.key != pick.post.key
            and (
                c.post.author in pick_group
                or pick.post.author in lineage_map.get(c.post.author, frozenset())
            )
            for i, c in enumerate(out)
        ):
            continue
        # Already in the feed? Promote it from wherever it landed — but only
        # from OFF this page. A post already on the page has its reach; moving
        # it from 15 to 13 buys the reader nothing and costs the lane a scarce
        # slot that an unseen author could have had. That was the other half of
        # the double-serve: same author, same budget spent, no new discovery.
        existing = next((i for i, c in enumerate(out) if c.post.key == pick.post.key), None)
        if existing is not None:
            if existing < page_end:
                continue
            out.pop(existing)
        out.insert(at, pick)
        inserted += 1
    return out


__all__ = [
    "eligible_for_exploration",
    "insert_exploration",
    "seat_order",
    "seat_secret_fingerprint",
]
