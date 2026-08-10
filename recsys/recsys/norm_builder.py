"""A5.2 — build a real :class:`~recsys.contracts.NormContext` from HAFSQL's
rolling window (§4).

WHY THIS FILE EXISTS. ``rank_feed`` needs a ``NormContext`` (the 7/3-day
global percentile sample every raw score is ranked against) on every call,
and — before this module — the only place that built one was
``measurement-harness/simworld.py:build_norm``, which iterates an in-memory
``World.posts`` list. There was no production builder at all: A5.1 landed
``HafsqlGateway.window_posts`` (recency-ordered, not engagement-ordered — see
that method's own docstring for why ``popular_posts`` would bias the sample),
but nothing turned its output into a ``NormContext``. A10 (the HTTP entry)
cannot serve a single request without one, so this module is a hard
dependency of that unit and is built alongside it.

THE SAMPLE IS BUILT BY THE SCORER'S OWN CALL. For each window post this
module emits the three raw values ``recsys.pipeline._score`` computes for a
candidate, from the same functions with the same arguments:

  * ``independent_vote_signal(post, exclusions)``
  * ``post.author_reputation``
  * ``_organic_signal(post, ..., excluded, weights=, prior=, trust=, ...)``

then :func:`recsys.core.normalize.build_norm_context`.

★★★ WHY THE ARGUMENTS ARE THREADED THROUGH (2026-08-10, PRUNED N1). Until
this date ``_norm_inputs`` called ``_organic_signal`` with ``prior=None``,
``trust=None``, ``excluded={post.author}`` and the DEFAULT weights, while
``pipeline._score`` (``:1441-1450``) called the same function with the
author-pooled prior, the graph-cred breadth budget, the
``ring | banned | curators`` exclusion set and ``settings.weights``. The
sample and the value ranked against it were therefore two different
quantities, which is precisely what ``normalize.py``'s saturation note
forbids — only at the FLOOR rather than the ceiling. Measured on the live
3-day HAFSQL window (3,684 posts, `PRUNED-2026-08-09` follow-up):

    organic percentile   mean    max     sd      distinct
    sample's own value   0.5001  1.0000  0.2887  3679
    what the scorer got  0.4258  0.9487  0.2163  1769

i.e. the 76%-weight organic term lost 21% of its realised spread and the top
of its own scale became unreachable, so vote+reputation silently gained
influence they were never given. Decomposed, the breadth budget is 92% of the
gap (mean 0.5001 -> 0.4087 alone), the pooled prior 8% (-> 0.4925) and the
exclusion set the remainder (-> 0.4968). With the arguments threaded the
sample IS the scorer's distribution again: mean 0.5001, max 1.0000, sd
0.2887, 3679 distinct.

NOT VIEWER-SPECIFIC, AND THAT IS WHY THIS IS CHEAP. Every input above is
either per-snapshot (``trust``, ring), per-author (``prior``) or global
(banned, curators) — ``_organic_signal`` ignores its ``viewer`` argument
outright (see its docstring). So the sample stays SHARED across every viewer
and the service keeps caching exactly one of them on a timer. The one input
that genuinely is per-viewer, ``independent_vote_signal(personal_for=...)``,
is deliberately NOT mirrored here; see :func:`_norm_inputs`.

``simworld.build_norm`` calls :func:`_norm_inputs` directly rather than
re-implementing it, so the measurement harness and production cannot drift
apart again.

``_organic_signal``, ``_ring_exclusion``, ``_voter_trust`` and
``_author_priors`` are imported from ``recsys.pipeline`` even though each is
private there (a leading underscore, not ``__all__``-exported). That is
deliberate and it is the whole point of this module: the norm sample must be
produced by the SAME code the scorer runs, so it imports the scorer's own
helpers rather than restating them. ``_organic_signal``'s docstring names this
caller explicitly ("This is the function the rolling-window norm builder calls
once per window post"). The imports are local to the functions that use them
because ``recsys.pipeline`` reaches ``recsys.io`` transitively.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from recsys.config import DEFAULT_SETTINGS, Settings
from recsys.contracts import HafsqlGateway, NormContext, Post, ViewerProfile, VoteExclusions
from recsys.core.banned import banned_authors
from recsys.core.curators import curator_accounts
from recsys.core.normalize import build_norm_context
from recsys.core.scoring import AuthorEngagement
from recsys.core.vote_signal import independent_vote_signal

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids a runtime import cycle
    from recsys.pipeline import TrustSnapshot

logger = logging.getLogger("recsys.norm_builder")

# Deliberately not a real account — mirrors ``measurement-harness/simworld.py``'s
# own ``DUMMY_VIEWER``. ``_organic_signal``'s ``viewer``/``als``/``cf_weight``
# params are retired (see that function's own docstring): the CF term is a
# per-viewer percentile blended in AFTER normalization, never a raw addend on
# the sample, so what is passed here can never affect a real request's score —
# only the *shape* of the call (positional, viewer-independent) matters, and
# that shape must match every other caller of the same function.
_NORM_VIEWER = ViewerProfile(account="__norm__")

#: Hard ceiling on rows fetched per window build. Live-verified 2026-08-04
#: (BUILDMAP-A-LAUNCH A5 sizing): a 3-day window is ~3,753 posts, a 7-day
#: window ~8,882 — both comfortably under this, so the cap is a safety rail
#: against a misconfigured/very wide window, not a value expected to bind in
#: normal operation.
DEFAULT_WINDOW_POST_LIMIT = 20_000


def _norm_inputs(
    posts: list[Post],
    now: datetime,
    *,
    settings: Settings = DEFAULT_SETTINGS,
    snapshot: TrustSnapshot | None = None,
    priors: Mapping[str, AuthorEngagement] | None = None,
) -> tuple[list[float], list[float], list[float]]:
    """The three §4 raw samples for ``posts`` — the SAME quantities
    :func:`recsys.pipeline._score` computes per candidate.

    Pure helper, split out so it is unit-testable against a canned post list
    with no gateway at all, and so ``measurement-harness/simworld.py`` can call
    the production builder instead of re-implementing it.

    ``snapshot`` supplies the two scorer inputs the sample used to be missing:
    the graph-cred breadth budget (``_voter_trust``) and the per-author ring
    exclusion. ``priors`` supplies the third (the author-pooled engagement
    prior). ``None`` for either is the honest degraded state — the same one
    ``_score`` itself takes when the snapshot carries no graph-cred or an
    author has no window aggregate — NOT a different formula. The global
    ``banned``/``curator`` exclusions are unconditional here because they are
    unconditional there.

    ★ ``personal_for`` IS DELIBERATELY ABSENT (2026-08-10). ``_score`` passes
    ``personal_for=viewer.follows`` to :func:`independent_vote_signal`, which
    scales a stranger's rshares by
    ``recsys.core.vote_signal._PERSONAL_STRANGER_SCALE``. That IS a genuine
    per-viewer input, and mirroring it here would make the sample per-viewer —
    a whole rolling window rebuilt per request. It is left chain-wide on
    purpose, so the residual mismatch is confined to the ONE term where fixing
    the sample is not affordable, and it is a mismatch that pushes the stake
    term DOWN (measured live: vote percentile mean 0.5086 chain-wide vs 0.4038
    for a followless viewer, sd 0.2761 -> 0.2144), i.e. it errs toward the
    owner's "payout is a minority signal" rather than against it. The
    doctrine-compliant repair for that term is a bounded adjustment applied to
    the PERCENTILE (``normalize.py:36-48``), which changes what "personal
    payout" MEANS and is therefore an owner decision, not a build decision. It
    is measured and costed in the 2026-08-10 build report; it is not shipped
    here.
    """
    # Local import: these live in ``recsys.pipeline``, which imports
    # ``recsys.io`` transitively only inside functions that need a driver —
    # importing here at module scope would be a cycle (pipeline imports nothing
    # from this module, but ``simworld`` imports both), so keeping them next to
    # their one use also makes the non-public import boundary easy to spot.
    from recsys.pipeline import _organic_signal, _ring_exclusion, _voter_trust

    trust = _voter_trust(snapshot, settings) if snapshot is not None else None
    prior_map: Mapping[str, AuthorEngagement] = priors if priors is not None else {}
    global_excluded = banned_authors() | curator_accounts()
    vote_signal_raw: list[float] = []
    reputation_raw: list[float] = []
    organic_raw: list[float] = []
    for post in posts:
        exclusions = VoteExclusions(
            author=post.author,
            ring_members=(
                (_ring_exclusion(post.author, snapshot) if snapshot is not None else frozenset())
                | global_excluded
            ),
        )
        vote_signal_raw.append(independent_vote_signal(post, exclusions, trust=trust))
        reputation_raw.append(post.author_reputation)
        organic_raw.append(
            _organic_signal(
                post,
                _NORM_VIEWER,
                now,
                exclusions.excluded(),
                weights=settings.weights,
                prior=prior_map.get(post.author),
                trust=trust,
                require_attribution=settings.vote_signal.require_attribution,
            )
        )
    return vote_signal_raw, reputation_raw, organic_raw


def build_window_norm(
    gateway: HafsqlGateway,
    settings: Settings = DEFAULT_SETTINGS,
    *,
    now: datetime,
    since: datetime | None = None,
    limit: int = DEFAULT_WINDOW_POST_LIMIT,
    snapshot: TrustSnapshot | None = None,
    author_prior_cache: Callable[[frozenset[str]], Mapping[str, AuthorEngagement]]
    | None = None,
) -> NormContext:
    """Build a real ``NormContext`` from ``gateway.window_posts`` (§4).

    ``snapshot`` and ``author_prior_cache`` are the two request-path inputs the
    sample must carry to rank the scorer's own quantity — see
    :func:`_norm_inputs`. They mirror ``rank_feed``'s parameters of the same
    name exactly, including the miss policy: an author the warm prior cache
    does not cover has no prior HERE either, which is the same value the
    scorer gets for that author, so a partial cache degrades both sides
    identically instead of re-opening the gap.

    ★ CALLING THIS WITHOUT A SNAPSHOT IS A DEGRADED SAMPLE, AND IT SAYS SO.
    With no snapshot there is no breadth budget and no ring exclusion to apply,
    so the sample reverts to the pre-2026-08-10 quantity for those two inputs.
    That is unreachable in production — ``rank_feed`` FAILS CLOSED without a
    fresh snapshot (H01), so a service that cannot build one serves nothing at
    all — but it is the path unit tests and the offline harness take, and a
    silent revert is exactly how this defect survived. It logs.

    ★ COST, AND WHY ``author_prior_cache`` IS NOT OPTIONAL IN PRACTICE. Omitting
    it makes this function run ``_author_priors``' grouped ``author_engagement``
    query itself, over EVERY author in the window (measured live 2026-08-10:
    1,641 authors, 16.5 s at a 900 s statement timeout). That is survivable on
    the norm cache's 30-minute timer and it is fatal under the 15 s default —
    see ``_author_priors``' own note on the structural floor. Production
    supplies the warm cache (``service.app`` does), which makes this a dict
    lookup; anything else should expect the query.

    ``since`` defaults to ``now - settings.history.sourcing_freshness_days``
    — the SAME short candidate-sourcing window ``rank_feed`` itself defaults
    to (``pipeline.rank_feed``'s own ``since`` default), so the norm sample
    and the candidates it ranks are drawn from the same horizon by default.
    An explicit ``since`` still wins, matching every other windowed builder
    in this package.

    Raises nothing extra of its own — an empty or too-small result is
    ``rank_feed``'s ``min_samples`` gate's job to refuse loudly (§4's own
    documented posture: "Empty samples are refused loudly rather than
    silently collapsing every score to 0.5"), not this builder's.

    OPERATIONAL NOTE (measured live 2026-08-04, BUILDMAP-A-LAUNCH
    "OPERATIONAL CONSTRAINT"): ``window_posts`` hydrates every row (votes,
    comments, rebloggers, reputations), so a 3-day window costs ~8.8s and a
    7-day window is dangerously close to the 15s default statement timeout.
    This function does no caching of its own — the caller (``recsys.service``)
    MUST cache the returned ``NormContext`` and rebuild on a timer, never per
    request. See that module's ``_TimerCache``.
    """
    if since is None:
        since = now - timedelta(days=settings.history.sourcing_freshness_days)
    if snapshot is None:
        logger.warning(
            "build_window_norm called with no TrustSnapshot: the §4 sample is built "
            "WITHOUT the graph-cred breadth budget and ring exclusion the scorer "
            "applies, so the organic percentile it produces is not the scorer's own "
            "distribution (PRUNED N1). Fine offline; never correct in production."
        )
    posts = gateway.window_posts(since, limit)
    # The prior is a per-author WINDOW aggregate, so it is fetched exactly the way
    # the request path fetches it — the warm cache when one is supplied, otherwise
    # the same grouped query `_author_priors` runs. This adds no NEW data source:
    # it is the read the scorer already does, on the norm cache's own timer.
    from recsys.pipeline import TrustSnapshot as _TrustSnapshot
    from recsys.pipeline import _author_priors

    priors = _author_priors(
        gateway,
        frozenset(post.author for post in posts),
        since,
        snapshot if snapshot is not None else _TrustSnapshot(),
        settings,
        prior_cache=author_prior_cache,
    )
    vote_signal_raw, reputation_raw, organic_raw = _norm_inputs(
        posts, now, settings=settings, snapshot=snapshot, priors=priors
    )
    return build_norm_context(vote_signal_raw, reputation_raw, organic_raw)


__all__ = ["DEFAULT_WINDOW_POST_LIMIT", "build_window_norm"]
