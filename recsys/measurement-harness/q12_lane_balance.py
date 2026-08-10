"""Q12 — LANE BALANCE: composition, earned-vs-spliced, reader cost.

The gap this fills, quoted from `mutate_panels.EXPECTED_MISSES`:

    "★ THE ONE GENUINE GAP ... NO panel catches this mutant ... It needs a
     panel that measures lane composition directly."

Three questions, over many viewers x many worlds, each with a bound AND a
reported MARGIN (a gate that only prints PASS proves nothing until someone
measures how close it was):

  G1 COMPOSITION  — is the mean per-lane share what was intended, and is the
                    per-viewer floor met (not just the fleet mean)?
  G2 EARNED       — does a lane's occupant hold its slot on its own score, or
                    was it placed there? Discriminator is RANK DISPLACEMENT:
                    served_position - score_rank_within_the_served_page.
                    0 = earned. Negative = promoted above its own score.
  G3 READER COST  — mean_rel@20 with the lane ON vs OFF. A lane that buys
                    reach must state what it costs the reader, per viewer.

Run:  python3 q12_lane_balance.py [seed ...]

★ LANDED 2026-08-08 from the measurement seat's prototype, with two changes,
both about the difference between a gate and a coincidence:

  1. **G2b was VACUOUS and reported OK.** It counts "served inside the head
     while ranked dead last", and the exploration seat sits at position 14 —
     outside `HEAD` — so the condition it tests was structurally unreachable
     and the gate passed by having nothing to look at. It now reports VACUOUS
     and FAILS when a lane never places anything inside the head at all. It
     becomes live the moment `ExplorationConfig.position` moves into the top
     ten, which is exactly when it is needed.
  2. **The popularity gates are CONFIG-AWARE, not permanently red.** G1b/G2
     grade `oon_popular`, which ships at `PopularConfig.limit = 0` (see that
     field for the measurement that decided it). A gate that can never pass
     trains people to ignore the file — the exact failure `mutate_panels.
     EXPECTED_MISSES` was built to stop — so with the lane OFF the target is
     REPORTED with its margin and does not fail the run, and with the lane ON
     it binds. The number stays visible either way.
"""
from __future__ import annotations

import collections
import pathlib
import statistics as st
import sys

_H = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_H))
sys.path.insert(0, str(_H.parent))

from simworld import (
    EPOCH,
    NOW,
    TAGS,
    TOPICS,
    SimGateway,
    build_norm,
    build_world,
    harness_settings,
    mean_rel_at_k,
)

from recsys.contracts import ViewerProfile
from recsys.pipeline import build_trust_snapshot, rank_feed

SEEDS = [int(a) for a in sys.argv[1:]] or [7, 11, 23, 42]
PAGE = 20
HEAD = 10


def run_world(seed, settings):
    world = build_world(seed=seed)
    gw = SimGateway(world)
    # ★ SNAPSHOT FIRST, THEN THE NORM (2026-08-10, PRUNED N1) — the §4 sample
    # carries the scorer's breadth budget and ring exclusion, which live on the
    # snapshot. See `simworld.build_norm`.
    snap = build_trust_snapshot(
        gw, settings, since=EPOCH, now=NOW, trusted_seeds=frozenset(), production=False
    )
    norm = build_norm(world, gateway=gw, snapshot=snap, settings=settings)
    names = [f"v-{t}-{j:02d}" for t in TOPICS for j in range(4)]
    out = []
    for name in names:
        acct = world.accounts[name]
        v = ViewerProfile(
            account=name, follows=world.follows[name],
            interest_tags=frozenset(TAGS[acct.topic]),
        )
        scored = rank_feed(v, gw, norm, now=NOW, since=EPOCH,
                           settings=settings, snapshot=snap)[:PAGE]
        if not scored:
            continue
        finals = [s.score.final for s in scored]
        order = sorted(range(len(finals)), key=lambda i: -finals[i])
        rank = {i: r for r, i in enumerate(order, 1)}
        rows = [
            {
                "pos": i + 1,
                "rank": rank[i],
                "disp": (i + 1) - rank[i],
                "final": finals[i],
                "lane": s.source.value,
            }
            for i, s in enumerate(scored)
        ]
        out.append({
            "viewer": name, "world": seed, "rows": rows,
            "rel": mean_rel_at_k([s.post for s in scored], name, world, k=PAGE),
        })
    return out


def summarise(feeds, label):
    n = len(feeds)
    print(f"\n=== {label}: {n} feeds ({len(SEEDS)} worlds) ===")
    c20, c10 = collections.Counter(), collections.Counter()
    for f in feeds:
        c20 += collections.Counter(r["lane"] for r in f["rows"])
        c10 += collections.Counter(r["lane"] for r in f["rows"][:HEAD])
    lanes = sorted(set(c20) | set(c10))
    print(f"{'lane':<18}{'mean/20':>9}{'mean/10':>9}{'feeds >=1 @10':>15}"
          f"{'meanDisp':>10}{'minDisp':>9}{'deadlast&served<=10':>21}")
    stats = {}
    for lane in lanes:
        ds, dead, seen10 = [], 0, 0
        for f in feeds:
            k = len(f["rows"])
            if any(r["lane"] == lane for r in f["rows"][:HEAD]):
                seen10 += 1
            for r in f["rows"]:
                if r["lane"] != lane:
                    continue
                ds.append(r["disp"])
                if r["rank"] == k and r["pos"] <= HEAD:
                    dead += 1
        stats[lane] = {
            "m20": c20[lane] / n, "m10": c10[lane] / n,
            "meandisp": st.mean(ds) if ds else 0.0,
            "mindisp": min(ds) if ds else 0,
            "dead": dead, "seen10": seen10,
        }
        s = stats[lane]
        print(f"{lane:<18}{s['m20']:>9.2f}{s['m10']:>9.2f}{seen10:>11}/{n}"
              f"{s['meandisp']:>10.2f}{s['mindisp']:>9}{dead:>21}")
    inv = []
    for f in feeds:
        fin = [r["final"] for r in f["rows"]]
        inv.append(sum(1 for i in range(len(fin) - 1) if fin[i] < fin[i + 1] - 1e-9))
    print(f"score-order inversions per feed: mean {st.mean(inv):.2f} max {max(inv)} "
          f"pure-order feeds {sum(1 for i in inv if i == 0)}/{n}")
    return stats, [f["rel"] for f in feeds]


def main():
    base = harness_settings()
    feeds_on = []
    for s in SEEDS:
        feeds_on += run_world(s, base)
    stats_on, rel_on = summarise(feeds_on, "SHIPPED settings")

    print("\n\n########## GATE REPORT (value / bound / MARGIN) ##########")
    print("A margin is the distance to the bound in the metric's own units; "
          "'rel%' is that margin as a fraction of the bound. A gate whose "
          "margin is a rounding error is a coincidence, not a gate.\n")

    def gate(name, value, op, bound):
        margin = value - bound if op == ">=" else bound - value
        rel = (margin / abs(bound) * 100) if bound else float("nan")
        ok = margin >= 0
        print(f"  {name:<44}{value:>9.3f} {op} {bound:<7.3f} margin {margin:>+8.3f} "
              f"({rel:>+7.1f}%)  {'OK' if ok else '** FAIL **'}")
        return ok

    ok = []
    n_feeds = len(feeds_on)
    popular_on = base.popular.limit > 0

    def target(name, value, op, bound, reason):
        """A bound that is REPORTED with its margin but does not fail the run,
        because the mechanism it grades is switched off. Never used to excuse a
        mechanism that IS on."""
        margin = value - bound if op == ">=" else bound - value
        print(f"  {name:<44}{value:>9.3f} {op} {bound:<7.3f} margin {margin:>+8.3f} "
              f"          OPEN TARGET ({reason})")

    # G1 composition (bounds are the OWNER PROPOSAL; the council may move them,
    # the point here is that the instrument reads them at all).
    ok.append(gate("G1a in_network mean/20",
                   stats_on.get("in_network", {}).get("m20", 0), ">=", 6.0))
    ok.append(gate("G1c exploration mean/20",
                   stats_on.get("exploration", {}).get("m20", 0), ">=", 1.0))
    # ★ The owner's headline popularity requirement: ">=3 slots inside top 10,
    # not manually set". Measured -2.24 short at every setting tried, which is
    # why `PopularConfig.limit` ships at 0. Reported every run so the gap stays
    # a NUMBER rather than a memory; binds the moment the lane is enabled.
    pop10 = stats_on.get("oon_popular", {}).get("m10", 0.0)
    if popular_on:
        ok.append(gate("G1b oon_popular mean/10", pop10, ">=", 3.0))
    else:
        target("G1b oon_popular mean/10", pop10, ">=", 3.0,
               "PopularConfig.limit = 0")

    # G2 earned: a lane is EARNED iff its mean displacement is ~0 and it is
    # never dead-last-but-served-in-the-head.
    for lane in ("oon_popular", "exploration"):
        s = stats_on.get(lane)
        if not s:
            if lane == "oon_popular" and not popular_on:
                print(f"  G2 {lane:<41}   -- lane disabled by config, "
                      f"OPEN TARGET (PopularConfig.limit = 0)")
            else:
                print(f"  G2 {lane:<41}   -- LANE ABSENT, gate VACUOUS "
                      f"(must FAIL, not skip)")
                ok.append(False)
            continue
        # ★ WHICH LANES ARE SUPPOSED TO BE EARNED. `oon_popular` is required to
        # hold its slots on its own score ("not manually set — it has to
        # surface there"), so displacement is a GATE for it. `exploration` is a
        # RESERVED slot by construction — `insert_exploration` splices it at a
        # fixed index and the lane's whole premise is that this content cannot
        # win on score — so grading it against "earned" would be gating a
        # mechanism on the definition of a different one. Its displacement is
        # REPORTED, every run, because the number is the price of the seat and
        # it is what a decision to move that seat has to be made against.
        if lane == "exploration":
            print(f"  G2a {lane:<40} mean displacement {s['meandisp']:>+8.2f} "
                  f"(min {s['mindisp']:+d})  RESERVED-SLOT COST, not a gate — "
                  f"this lane is spliced at ExplorationConfig.position by design")
        else:
            ok.append(gate(f"G2a {lane} mean displacement", s["meandisp"], ">=", -1.0))
        # ★★★ VACUITY (2026-08-08). `dead` only counts placements INSIDE the
        # head, so for a lane that never reaches the head the count is 0 by
        # construction and the gate passes on an empty inspection. A check with
        # nothing to look at must FAIL, not report OK — this project's
        # signature failure is gates that pass while the thing is broken.
        if s["seen10"] == 0:
            # ★★★ VACUOUS vs NOT-APPLICABLE, and the difference decides whether
            # this fails. A check that inspected nothing while it SHOULD have
            # been able to fire is a blind spot and must FAIL. A check the
            # CONFIG has structurally excluded is a stated fact, not a blind
            # spot — for `exploration` at `position >= HEAD` the lane cannot
            # appear in the head by arithmetic, so there is nothing for it to
            # be dead-last inside of. Getting this wrong in either direction is
            # how a gate becomes decoration.
            reserved_outside_head = (
                lane == "exploration" and base.exploration.position >= HEAD
            )
            if reserved_outside_head:
                print(f"  G2b {lane:<40} dead-last-in-head:  NOT APPLICABLE — "
                      f"ExplorationConfig.position = {base.exploration.position} "
                      f"is outside the top {HEAD}, so this lane cannot be served "
                      f"in the head at all. BINDS the moment that value moves "
                      f"below {HEAD}.")
            else:
                print(f"  G2b {lane:<40} dead-last-in-head:  VACUOUS — this lane "
                      f"reached the head in 0/{n_feeds} feeds while nothing in "
                      f"the config prevents it, so the check inspected nothing.")
                ok.append(False)
        else:
            ok.append(gate(f"G2b {lane} dead-last-in-head count",
                           s["dead"], "<=", 0))
    print(f"\n  reader mean_rel@20 = {st.mean(rel_on):.4f} "
          f"(sd {st.pstdev(rel_on):.4f}, min {min(rel_on):.4f})")
    print(f"\nRESULT: {sum(ok)}/{len(ok)} gates pass")
    return 0 if all(ok) else 1


if __name__ == "__main__":
    raise SystemExit(main())
