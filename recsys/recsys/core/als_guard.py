"""Between-batch ALS anomaly gate (§H11 — PRUNED audit 2026-07-22).

**The threat.** ``recsys.pipeline.build_trust_snapshot`` trains a fresh
:class:`~recsys.core.als.ALSModel` from the last ``window_days`` of
engagement edges every weekly batch and freezes it straight into that week's
``TrustSnapshot`` with no comparison against the model it replaces. A
co-engagement campaign that poisons a single week's training run (the same
shape of attack as the C1/C2 finding — a one-directional sock -> author edge
slips both the ring test, which needs a reciprocal edge, and stake-lineage,
which needs a transfer record) therefore rides the CF percentile slice of
*every* request for the full following week, not just the request(s) that
produced the poisoned edges. There is no existing circuit breaker between
"ALS finished training" and "ALS is live in production."

**The fix (this module + the wiring).** A pure, side-effect-free instability
measurement: :func:`als_batch_drift` compares this week's trained model to last
week's on every ``(user, author)`` pair BOTH weeks trained factors for, and
returns one normalized number. As of 2026-07-22 it is WIRED into its caller,
``recsys.pipeline.build_trust_snapshot`` (which gained a ``previous`` parameter
and whose ``TrustSnapshot`` gained a ``degraded`` field); the caller is:

    als = train_als(edges, settings.als, ring_members=ring_members, lineage=lineage)
    degraded = False
    if previous is not None and previous.als is not None:
        drift = als_batch_drift(als, previous.als)
        if drift > settings.als.max_batch_drift:
            als = None          # disable CF for the week rather than serve it
            degraded = True     # H01's fail-closed path treats this as
                                 # "not fresh" and refuses, same as a
                                 # missing snapshot
    return TrustSnapshot(graph_creds=graph_creds, ring_members=ring_members,
                          als=als, degraded=degraded)

``TrustSnapshot``/``build_trust_snapshot`` both live in ``recsys.pipeline``,
which this build keeps single-owner (see ``recsys/pipeline.py``'s module
docstring / the build partition notes) so two builders never race edits to the
same function body — the wiring above therefore lives THERE, and this module
stays the pure, independently-tested primitive it consumes. ``max_batch_drift``
is a deliberately conservative, LIVE-DATA-GATED threshold on
:class:`recsys.config.ALSConfig` (see its own note): H11 is a backstop to the
C1/C2 in-training breadth budget, so it fires only on gross instability.

**Why "normalized" and not a raw mean delta.** ALS's absolute affinity scale
is a function of ``alpha``/``regularization``/``factors`` — none of which are
the signal we want to gate on, and any of which retuning would silently
re-calibrate a raw-delta threshold out from under the operator. Dividing the
mean absolute delta by the RMS magnitude of *last week's* affinities on the
same shared pairs makes the result a relative "how big was the average swing
versus what this model normally predicts" figure: uniformly rescaling both
models' factors (e.g. a global regularization change that shrinks every
factor by the same amount) leaves the ratio unchanged (see
``test_uniform_rescale_of_both_models_leaves_drift_unchanged``), so the
threshold means the same thing release over release.

**Why zero on no overlap, not an error or a maximal drift.** A week where the
two models share no trained users/authors at all is not comparable by this
method — absence of evidence is not evidence of an anomaly, the same posture
``graph_cred`` already takes for a never-engaged account (never a mid-scale
guess, never a worst-case guess). Total population churn is a real thing this
gate cannot see; it is not this gate's job — the second-degree vouch gate and
graph-cred floor are what stop a wholesale-fake population from ever entering
``edges`` in the first place.
"""

from __future__ import annotations

import numpy as np

from recsys.core.als import ALSModel

__all__ = ["als_batch_drift"]


def als_batch_drift(current: ALSModel, previous: ALSModel) -> float:
    """Week-over-week ALS instability signal (§H11).

    For every ``(user, author)`` pair whose user is in BOTH models'
    ``user_index`` and whose author is in BOTH models' ``item_index``,
    computes the predicted affinity under each model and takes the mean
    absolute difference, then divides by the RMS magnitude of ``previous``'s
    affinities over that same shared grid — see the module docstring for why
    that normalization, not a raw delta, is the right instability figure.

    Returns ``0.0`` when there is no shared user or no shared author between
    the two models (nothing to compare), or when ``previous``'s RMS affinity
    on the shared grid is exactly ``0.0`` (a degenerate/empty prior model —
    nothing to normalize against, and comparing against a model with no
    signal would either divide by zero or manufacture a false maximal
    reading, neither of which is honest).

    Symmetric in neither direction nor argument order matters for the shared
    grid computed, but the RMS is always taken over ``previous`` — this is a
    week N -> week N+1 instability figure, not a distance metric.
    """
    shared_users = sorted(current.user_index.keys() & previous.user_index.keys())
    shared_items = sorted(current.item_index.keys() & previous.item_index.keys())
    if not shared_users or not shared_items:
        return 0.0

    cur_user_rows = [current.user_index[u] for u in shared_users]
    cur_item_rows = [current.item_index[i] for i in shared_items]
    prev_user_rows = [previous.user_index[u] for u in shared_users]
    prev_item_rows = [previous.item_index[i] for i in shared_items]

    current_affinity = current.user_factors[cur_user_rows] @ current.item_factors[cur_item_rows].T
    previous_affinity = (
        previous.user_factors[prev_user_rows] @ previous.item_factors[prev_item_rows].T
    )

    previous_rms = float(np.sqrt(np.mean(previous_affinity**2)))
    if previous_rms <= 0.0:
        return 0.0

    mean_abs_delta = float(np.mean(np.abs(current_affinity - previous_affinity)))
    return mean_abs_delta / previous_rms
