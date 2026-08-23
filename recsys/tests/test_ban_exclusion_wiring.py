"""The ban/curator exclusion WIRING — pinned because a mutation test proved it unpinned.

On 2026-08-23 two exclusion fixes landed in `pipeline.py`:

  1. `_popular_excluded` (the across-Hive popularity lane, served to EVERY viewer)
     gained `| banned_authors()`, which it had never had.
  2. `build_trust_snapshot` gained an edge filter dropping banned accounts in BOTH
     directions and curators in the OUTGOING direction only.

An adversarial review then reverted both and ran the suite: `1 failed, 1008 passed,
73 skipped, 3 xfailed` — byte-identical to the fixed tree. Neither fix was detected by
a single test. These are that detection.

The source-level check mirrors the one already written for the curator half of the same
defect (`test_the_pipeline_actually_excludes_curators_from_every_engagement_signal`),
which exists because deleting `| curator_accounts()` left its behavioural sibling green.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import recsys.pipeline as pipeline_mod
from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import EngagementEdge
from recsys.pipeline import build_trust_snapshot
from tests.fakes import FakeGateway

EPOCH = datetime(2024, 1, 1, tzinfo=timezone.utc)


def _snapshot(monkeypatch, edges, *, banned=frozenset(), curators=frozenset()):
    monkeypatch.setattr(pipeline_mod, "banned_authors", lambda: frozenset(banned))
    monkeypatch.setattr(pipeline_mod, "curator_accounts", lambda: frozenset(curators))
    accounts = {e.src for e in edges} | {e.dst for e in edges}
    gateway = FakeGateway(
        edges=edges, follow_graph={a: frozenset() for a in accounts}
    )
    # production=False for the same reason every other synthetic-world test here does it:
    # these invented names are not on the real curated seed list, so the F-R2 production
    # guard would refuse the build before the filter under test ever ran.
    return build_trust_snapshot(
        gateway, DEFAULT_SETTINGS, since=EPOCH, now=EPOCH, production=False
    )


def test_a_banned_account_mints_no_trust_and_receives_none(monkeypatch) -> None:
    """A ban is SYMMETRIC: both directions of a banned account's edges go."""
    edges = [
        EngagementEdge(src="troll", dst="alice", upvotes=5),  # outgoing: minting
        EngagementEdge(src="alice", dst="troll", upvotes=5),  # incoming: receiving
        EngagementEdge(src="bob", dst="alice", upvotes=5),  # untouched control
    ]
    snap = _snapshot(monkeypatch, edges, banned={"troll"})

    assert "troll" not in snap.graph_creds, (
        "a banned account still holds graph-cred — its incoming edges were not dropped"
    )
    assert {"alice", "bob"} <= set(snap.graph_creds), (
        "the control edge was dropped too — the filter is over-broad"
    )


def test_a_curator_mints_no_trust_but_still_earns_it(monkeypatch) -> None:
    """The curator rule is ASYMMETRIC, and collapsing it into the ban set would
    silently zero every curator's own standing. Outgoing goes, incoming stays."""
    edges = [
        EngagementEdge(src="qurator", dst="promoted", upvotes=5),  # must be dropped
        EngagementEdge(src="reader", dst="qurator", upvotes=5),  # must survive
    ]
    snap = _snapshot(monkeypatch, edges, curators={"qurator"})

    assert "promoted" not in snap.graph_creds, (
        "a curator's OUTGOING edge survived — curation trails mint graph-cred again"
    )
    assert "qurator" in snap.graph_creds, (
        "a curator's INCOMING edge was dropped — their own posts no longer earn them "
        "standing, which is a ban, not the engagement exclusion the owner asked for"
    )


def test_the_popularity_lane_excludes_banned_authors() -> None:
    """`_popular_excluded` is a closure inside `run_pipeline` and cannot be called
    directly, so this pins it at the source the same way the curator half is pinned.

    `core/popular.py` promises in writing that "the author, their ring, and banned
    accounts contribute nothing, a banned troll cannot promote anyone into the lane
    every viewer sees." This lane is served to EVERY viewer, so the omission had the
    widest reach of anywhere it could have sat.
    """
    src = (Path(__file__).resolve().parents[1] / "recsys" / "pipeline.py").read_text()
    assert "def _popular_excluded" in src

    body = src[src.index("def _popular_excluded") :]
    body = body[: body.index("popular_pool = ")]
    # ★ COMMENTS STRIPPED FIRST. Without this the check passes on the explanatory
    # comment inside this very function, which NAMES `banned_authors()` while
    # describing the omission — proven by mutation: deleting the actual `|
    # banned_authors()` call left this test green until the strip was added.
    body = "\n".join(
        line for line in body.splitlines() if not line.lstrip().startswith("#")
    )
    assert "banned_authors()" in body, (
        "_popular_excluded does not union banned_authors() — a banned account can "
        "promote a post into the across-Hive popularity lane"
    )
    assert "curator_accounts()" in body, (
        "_popular_excluded does not union curator_accounts() — regression of the "
        "2026-08-09 fix"
    )


def test_the_trust_snapshot_filter_is_not_a_single_collapsed_set() -> None:
    """Pins the asymmetry itself. `banned | curators` in one condition would pass both
    behavioural tests above only until someone 'simplified' it, at which point every
    curator's graph-cred silently goes to zero."""
    src = (Path(__file__).resolve().parents[1] / "recsys" / "pipeline.py").read_text()
    assert "e.src not in _banned and e.dst not in _banned and e.src not in _curators" in src, (
        "the trust-snapshot edge filter no longer reads as ban-symmetric / "
        "curator-outgoing-only"
    )
