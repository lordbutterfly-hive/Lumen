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

MIRRORS ``simworld.build_norm`` EXACTLY, on purpose. For each window post it
emits the same three raw values, in the same shapes, with the same exclusion
set and the same viewer-independent (``cf=0``) call shape:

  * ``independent_vote_signal(post, VoteExclusions(author=post.author))``
  * ``post.author_reputation``
  * ``_organic_signal(post, <dummy viewer>, now, {post.author}, None, 0.0)``

then :func:`recsys.core.normalize.build_norm_context`. ``normalize.py``'s own
saturation note is the reason for the lockstep: a raw value carrying an
addend the SAMPLE was not built with clips to 1.0 and silently deletes
ordering inside that group (the 2026-07-21 organic-percentile bug). Every
*scorer* call to ``_organic_signal`` for a real request must stay consistent
with what THIS builder feeds the sample with — this module and
``recsys.pipeline._score`` sharing the one function is what keeps that true
by construction rather than by two authors remembering to agree.

``_organic_signal`` is imported from ``recsys.pipeline`` even though it is
name-mangled private there (a leading underscore, not ``__all__``-exported):
that module is owned by another workstream this phase and this builder does
not edit it, but the function is exactly the §4 norm-sample producer per its
own docstring ("This is the function the rolling-window norm builder calls
once per window post") — it is not accidentally private, the norm builder is
simply expected to live in a different file and import it.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from recsys.config import DEFAULT_SETTINGS, Settings
from recsys.contracts import HafsqlGateway, NormContext, Post, ViewerProfile, VoteExclusions
from recsys.core.normalize import build_norm_context
from recsys.core.vote_signal import independent_vote_signal

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


def _norm_inputs(posts: list[Post], now: datetime) -> tuple[list[float], list[float], list[float]]:
    """Pure helper, split out so it is unit-testable against a canned post
    list with no gateway at all."""
    # Local import: ``_organic_signal`` lives in ``recsys.pipeline``, which
    # imports ``recsys.io`` transitively only inside functions that need a
    # driver — importing it here at module scope is fine (pipeline itself has
    # no psycopg import at module scope either), but keeping it next to its
    # one use makes the "this is the one non-public import in the file"
    # boundary easy to spot in review.
    from recsys.pipeline import _organic_signal

    vote_signal_raw: list[float] = []
    reputation_raw: list[float] = []
    organic_raw: list[float] = []
    for post in posts:
        vote_signal_raw.append(
            independent_vote_signal(post, VoteExclusions(author=post.author))
        )
        reputation_raw.append(post.author_reputation)
        organic_raw.append(
            _organic_signal(post, _NORM_VIEWER, now, frozenset({post.author}), None, 0.0)
        )
    return vote_signal_raw, reputation_raw, organic_raw


def build_window_norm(
    gateway: HafsqlGateway,
    settings: Settings = DEFAULT_SETTINGS,
    *,
    now: datetime,
    since: datetime | None = None,
    limit: int = DEFAULT_WINDOW_POST_LIMIT,
) -> NormContext:
    """Build a real ``NormContext`` from ``gateway.window_posts`` (§4).

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
    posts = gateway.window_posts(since, limit)
    vote_signal_raw, reputation_raw, organic_raw = _norm_inputs(posts, now)
    return build_norm_context(vote_signal_raw, reputation_raw, organic_raw)


__all__ = ["DEFAULT_WINDOW_POST_LIMIT", "build_window_norm"]
