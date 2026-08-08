#!/usr/bin/env python3
"""ATTACK/COST — does score-ordering the reserved seat hand it to whoever
posted most recently, and does the serve budget bound that?

★ WHY THIS FILE EXISTS (2026-08-08). `ExplorationConfig.seat_by_score` gives
the reserved seat to the best-scoring member of the neediest need band instead
of to whichever equally-needy author the keyed lottery drew. Inside band 0 every
author has zero engagement BY DEFINITION, so the only thing left to order them
is the additive freshness bonus — i.e. the change risks re-introducing exactly
the "a posting-hourly author beats a quiet one at identical need" preference the
keyed shuffle was chosen to retire. This measures it rather than arguing it.

MEASURED 2026-08-08 (the numbers quoted in `core/exploration.py::seat_order`):

    seat_by_score  serve_log |  distinct occupants over 8 x 6h buckets
    -------------------------|----------------------------------------
    False          False     |  4 of 6 debuts
    True           False     |  1 of 6  <- the cost, unbounded
    False          True      |  4 of 6
    True           True      |  6 of 6  <- the shipped configuration

So the cost is REAL with the serve log off and is BOUNDED — in fact reversed —
with it on, because `seat_order` keys on serve count ABOVE score (B1's
tie-break, deliberately not overridden) and the budget then retires each author
at `max_serves_per_author`.

Original docstring follows.

Does score-ordering the reserved seat hand it to whoever posted most recently?

Six band-0 authors (zero distinct engagers, identical reputation), post ages
spread across the lane's real 3-day sourcing window. Prints every debut's score
so the ordering signal is visible, then the seat occupant across 8 clock buckets
under the keyed lottery vs `seat_by_score`.
"""
from __future__ import annotations

import hashlib
import pathlib
import sys
from dataclasses import replace
from datetime import timedelta

_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_ROOT))

from recsys.config import ExplorationConfig, Settings
from recsys.contracts import NormContext
from recsys.pipeline import TrustPolicy, rank_feed
from recsys.serve_log import ExplorationServeLog
from tests.fakes import EPOCH, FakeGateway, make_post, make_viewer, make_vote

NOW = EPOCH + timedelta(days=4)
SECRET = hashlib.sha256(b"probe-freshness").digest()
NOW_MIN = int((NOW - EPOCH).total_seconds() // 60)
AGES_H = [1, 8, 20, 34, 48, 66]


def norm() -> NormContext:
    return NormContext(
        vote_signal_samples=tuple(float(i) for i in range(200)),
        reputation_samples=tuple(float(i) for i in range(200)),
        organic_samples=tuple(i / 200.0 for i in range(200)),
    )


def world():
    in_network = [
        make_post(
            f"est{i:02d}", f"e{i}", category="photo", tags=("photo",),
            created_min=NOW_MIN - 60 - i, children=2,
            votes=[make_vote(f"r{i}a", 50_000_000), make_vote(f"r{i}b", 40_000_000)],
        )
        for i in range(25)
    ]
    debuts = [
        make_post(f"debut{i}-{h}h", "p", category="photo", tags=("photo",),
                  created_min=NOW_MIN - h * 60)
        for i, h in enumerate(AGES_H)
    ]
    gw = FakeGateway(in_network=in_network, tag=debuts)
    viewer = make_viewer(
        "me",
        follows=frozenset(f"est{i:02d}" for i in range(25)),
        interest_tags=frozenset({"photo"}),
    )
    return gw, viewer


def main() -> None:
    gw, viewer = world()
    base_ex = ExplorationConfig(seat_secret=SECRET)

    s = Settings(exploration=replace(base_ex, seat_by_score=True))
    feed = rank_feed(viewer, gw, norm(), now=NOW, since=EPOCH, settings=s,
                     trust_policy=TrustPolicy.WARN)
    scores = {sc.post.author: sc.score.final for sc in feed}
    print("debut scores at bucket+0 (age -> final):")
    for i, h in enumerate(AGES_H):
        a = f"debut{i}-{h}h"
        print(f"   {a:<14} age={h:>3}h  final={scores.get(a, float('nan')):.4f}")

    for by_score, with_log in ((False, False), (True, False), (False, True), (True, True)):
        st = Settings(exploration=replace(base_ex, seat_by_score=by_score))
        log = ExplorationServeLog() if with_log else None
        seats = []
        for k in range(8):
            now = NOW + timedelta(hours=1 + 6 * k)
            f = rank_feed(viewer, gw, norm(), now=now, since=EPOCH, settings=st,
                          trust_policy=TrustPolicy.WARN, serve_log=log)
            sc = f[st.exploration.position]
            seats.append((sc.post.author, sc.score.final, sc.source.value))
        print(f"\nseat_by_score={by_score!s:<5} serve_log={with_log!s:<5} occupant per clock bucket:")
        for i, (a, fv, src) in enumerate(seats):
            print(f"   bucket+{i}: {a:<14} {src:<12} final={fv:.4f}")
        print(f"   distinct occupants: {sorted({a for a, _, _ in seats})}")


if __name__ == "__main__":
    main()
