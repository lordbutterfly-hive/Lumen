"""A5.2 — ``recsys.norm_builder`` tests.

Offline group (no marker) exercises the pure aggregation logic against a
minimal in-memory fake that implements only ``window_posts`` — deliberately
NOT ``tests.fakes.FakeGateway`` (which predates A5 and has no ``window_posts``
method at all; adding one there risks colliding with another builder's
concurrent edits to that shared fixture file, so this module defines its own
narrow fake instead).

Live group (``@pytest.mark.live``, gated on ``RECSYS_LIVE_DB``) proves the
whole thing end to end against the real HAFSQL mirror: a real
``HafsqlClient.window_posts`` call, hydrated, producing a ``NormContext``
whose three sample tuples are each ``>= settings.norm.min_samples`` and
sorted ascending — the exact shape ``rank_feed`` requires before it will rank
anything (see ``pipeline.rank_feed``'s own ``min_samples`` gate).
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from recsys.config import DEFAULT_SETTINGS, HafsqlConfig, LiteConfig
from recsys.contracts import Post
from recsys.core.vote_signal import independent_vote_signal
from recsys.io import hafsql
from recsys.norm_builder import build_window_norm
from tests.fakes import EPOCH, make_post, make_vote

_live = pytest.mark.skipif(
    not os.environ.get("RECSYS_LIVE_DB"),
    reason="RECSYS_LIVE_DB not set — live-mirror suite opted out (offline by default)",
)


class _FakeWindowGateway:
    """The one method `build_window_norm` needs — nothing else."""

    def __init__(self, posts: list[Post]) -> None:
        self._posts = posts
        self.last_since: datetime | None = None
        self.last_limit: int | None = None

    def window_posts(self, since: datetime, limit: int) -> list[Post]:
        self.last_since = since
        self.last_limit = limit
        return list(self._posts)[:limit]


# ---------------------------------------------------------------------------
# Offline
# ---------------------------------------------------------------------------


def test_build_window_norm_produces_sorted_samples_matching_post_count() -> None:
    posts = [
        make_post(
            author=f"author{i}",
            permlink=f"p{i}",
            author_reputation=float(i),
            votes=[make_vote(voter=f"voter{i}", rshares=10_000_000 * (i + 1))],
        )
        for i in range(5)
    ]
    gateway = _FakeWindowGateway(posts)
    now = EPOCH + timedelta(days=1)

    norm = build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    assert len(norm.vote_signal_samples) == 5
    assert len(norm.reputation_samples) == 5
    assert len(norm.organic_samples) == 5
    assert list(norm.vote_signal_samples) == sorted(norm.vote_signal_samples)
    assert list(norm.reputation_samples) == sorted(norm.reputation_samples)
    assert list(norm.organic_samples) == sorted(norm.organic_samples)
    # Every post's own author_reputation is present in the sample (exactly
    # what the raw reputation collector is supposed to do — no transformation).
    assert set(norm.reputation_samples) == {float(i) for i in range(5)}


def test_build_window_norm_defaults_since_from_sourcing_freshness_days() -> None:
    gateway = _FakeWindowGateway([])
    now = datetime(2026, 6, 15, tzinfo=UTC)

    build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    expected_since = now - timedelta(days=DEFAULT_SETTINGS.history.sourcing_freshness_days)
    assert gateway.last_since == expected_since


def test_build_window_norm_explicit_since_overrides_the_default() -> None:
    gateway = _FakeWindowGateway([])
    now = datetime(2026, 6, 15, tzinfo=UTC)
    explicit_since = now - timedelta(days=1)

    build_window_norm(gateway, DEFAULT_SETTINGS, now=now, since=explicit_since)

    assert gateway.last_since == explicit_since


def test_build_window_norm_empty_window_returns_empty_norm_context() -> None:
    gateway = _FakeWindowGateway([])
    now = EPOCH

    norm = build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    assert norm.vote_signal_samples == ()
    assert norm.reputation_samples == ()
    assert norm.organic_samples == ()


def test_build_window_norm_vote_signal_matches_the_authoritative_function_directly() -> None:
    """Pin: the sample this builder feeds `NormContext.vote_signal_samples`
    with is EXACTLY `independent_vote_signal` on the same post/exclusion
    shape `pipeline._score` scores real candidates with (module docstring's
    "lockstep" requirement) — not a reimplementation that happens to agree
    today."""
    post = make_post(
        author="alice",
        votes=[
            make_vote(voter="bob", rshares=50_000_000),
            make_vote(voter="alice", rshares=999_000_000),  # self-vote, excluded
        ],
    )
    gateway = _FakeWindowGateway([post])
    now = EPOCH

    norm = build_window_norm(gateway, DEFAULT_SETTINGS, now=now)

    from recsys.contracts import VoteExclusions

    expected = independent_vote_signal(post, VoteExclusions(author="alice"))
    assert norm.vote_signal_samples == (expected,)


# ---------------------------------------------------------------------------
# PRUNED N1 — the sample must rank the SCORER'S quantity, not a second formula
# ---------------------------------------------------------------------------


def _budgeting_snapshot(author: str, voters: list[str]):
    """A TrustSnapshot whose graph-cred makes `_voter_trust` return a budget
    that actually BITES on `voters` — i.e. one vouched account (so the tier
    exists at all) and everyone else unknown, which is the regime where the
    §4 sample and the scorer visibly disagreed."""
    from recsys.contracts import GraphCred
    from recsys.pipeline import TrustSnapshot

    creds = {
        "seed": GraphCred(account="seed", score=1.0, follow_follower_ratio=1.0,
                          outside_engaged=True,
                          outside_engagers=frozenset({author})),
    }
    for voter in voters:
        creds[voter] = GraphCred(account=voter, score=0.0, follow_follower_ratio=1.0)
    return TrustSnapshot(graph_creds=creds, trusted_seeds=frozenset({"seed"}))


def test_norm_sample_carries_the_breadth_budget_the_scorer_applies() -> None:
    """★ PRUNED N1, the headline. `_norm_inputs` used to call
    `_organic_signal` with `trust=None` while `pipeline._score` called it with
    the graph-cred breadth budget, so the sample held values the scorer could
    never produce and the organic percentile lost the top of its own scale
    (measured live, 3-day window: max 1.0000 -> 0.9487, sd 0.2887 -> 0.2163).

    A post with many unknown-tier voters must therefore land LOWER in the
    sample than its unbudgeted engagement would suggest — if this assertion
    fails, the budget is not reaching the sample."""
    from recsys.norm_builder import _norm_inputs

    voters = [f"v{i}" for i in range(30)]
    post = make_post(
        author="alice",
        votes=[make_vote(voter=v, rshares=9_000_000_000) for v in voters],
    )
    snap = _budgeting_snapshot("alice", voters)

    _, _, budgeted = _norm_inputs([post], EPOCH, settings=DEFAULT_SETTINGS, snapshot=snap)
    _, _, unbudgeted = _norm_inputs([post], EPOCH, settings=DEFAULT_SETTINGS, snapshot=None)

    assert budgeted[0] < unbudgeted[0], (
        "the norm sample ignored the breadth budget the scorer applies — "
        f"budgeted={budgeted[0]} unbudgeted={unbudgeted[0]}"
    )


def test_norm_sample_carries_the_author_pooled_prior_the_scorer_applies() -> None:
    """Same defect, second input: the scorer blends the author-pooled
    leave-one-out prior into the organic raw (`pooled_author_base`) and the
    sample did not, so a prolific author's posts were ranked against a
    distribution built from un-pooled values."""
    from recsys.core.scoring import AuthorEngagement
    from recsys.norm_builder import _norm_inputs

    post = make_post(
        author="alice",
        votes=[make_vote(voter=f"v{i}", rshares=9_000_000_000) for i in range(6)],
    )
    # Six other window posts with NO engagement at all: the leave-one-out mean
    # is 0, so pooling must pull this post's value DOWN.
    prior = {"alice": AuthorEngagement(posts=7, total_base=0.0)}

    _, _, pooled = _norm_inputs([post], EPOCH, settings=DEFAULT_SETTINGS, priors=prior)
    _, _, unpooled = _norm_inputs([post], EPOCH, settings=DEFAULT_SETTINGS, priors=None)

    assert pooled[0] < unpooled[0], (
        "the norm sample ignored the author-pooled prior the scorer applies — "
        f"pooled={pooled[0]} unpooled={unpooled[0]}"
    )


def test_norm_sample_carries_the_banned_and_curator_exclusion() -> None:
    """Third scorer input the sample used to be missing. `pipeline._score`
    unions `banned_authors() | curator_accounts()` into every candidate's
    exclusion set — a curation bot's vote mints breadth for nobody — so a
    sample that counts those identities ranks real posts against engagement the
    scorer refuses to credit.

    Uses a REAL member of the shipped lists rather than a made-up name: the
    point is that the production sets are what reach the sample."""
    from recsys.core.curators import curator_accounts
    from recsys.norm_builder import _norm_inputs

    curator = sorted(curator_accounts())[0]
    curated = make_post(
        author="alice", permlink="curated",
        votes=[make_vote(voter=curator, rshares=9_000_000_000)],
    )
    organic_post = make_post(
        author="alice", permlink="organic",
        votes=[make_vote(voter="an-ordinary-reader", rshares=9_000_000_000)],
    )
    # The control: a post nobody engaged at all. Comparing against IT rather
    # than against 0.0 keeps the assertion free of `organic_recency`, which
    # also lands in this raw and is not what is under test.
    silent = make_post(author="alice", permlink="silent", votes=[])

    _, _, raws = _norm_inputs(
        [curated, organic_post, silent], EPOCH, settings=DEFAULT_SETTINGS
    )

    assert raws[0] < raws[1], (
        f"a vote from the curator account {curator!r} counted toward the §4 "
        "sample, while `pipeline._score` excludes it — the sample and the "
        "scorer are ranking different quantities (PRUNED N1)"
    )
    assert raws[0] == pytest.approx(raws[2]), (
        f"the curator {curator!r} was this post's only engager, so the sample "
        "must score it exactly like a post nobody engaged; got "
        f"{raws[0]} vs {raws[2]}"
    )


def test_norm_sample_equals_what_the_scorer_actually_computed(monkeypatch) -> None:
    """★★★ THE LOCKSTEP GUARD, MEASURED AT THE SCORER'S OWN CALL SITE.

    Every other test here asserts on `_norm_inputs` in isolation, which proves
    only that this module is self-consistent. N1 was not an inconsistency
    inside this module — it was this module and `pipeline._score` computing
    two different formulas, each internally fine. So this test runs a REAL
    `rank_feed`, intercepts the `(candidate, vote_raw, organic_raw)` triples
    the pipeline hands to `score_candidates`, and asserts they are EXACTLY the
    values this module puts in the sample for the same posts and snapshot.

    The ONE deliberate exception is the vote signal's `personal_for` — see
    `_norm_inputs`' docstring for why that one input stays chain-wide. It is
    pinned separately and exactly by
    `test_the_vote_terms_personal_residual_is_exactly_the_stranger_scale`, so
    that the residual stays a measured, visible fact instead of an assumption.
    """
    from recsys import pipeline as pipeline_mod
    from recsys.core.normalize import build_norm_context
    from recsys.norm_builder import _norm_inputs
    from recsys.pipeline import _author_priors, rank_feed
    from tests.fakes import FakeGateway, make_viewer

    # >= `norm.min_samples` (50) or `rank_feed` refuses to rank at all, and the
    # test would prove nothing by raising.
    n_posts = DEFAULT_SETTINGS.norm.min_samples + 10
    posts = [
        make_post(
            author=f"a{i}",
            permlink=f"p{i}",
            author_reputation=30.0 + i,
            votes=[
                make_vote(voter=f"v{i}_{j}", rshares=9_000_000_000)
                for j in range(i % 7 + 1)
            ],
        )
        for i in range(n_posts)
    ]
    snap = _budgeting_snapshot(
        "a0", [f"v{i}_{j}" for i in range(n_posts) for j in range(i % 7 + 1)]
    )
    gateway = FakeGateway(in_network=posts)
    viewer = make_viewer("reader", follows=frozenset(p.author for p in posts))

    captured: dict[str, float] = {}
    real = pipeline_mod.score_candidates

    def spy(items, *args, **kwargs):
        items = list(items)
        for candidate, _vote_raw, organic_raw in items:
            captured[candidate.post.key] = organic_raw
        return real(items, *args, **kwargs)

    monkeypatch.setattr(pipeline_mod, "score_candidates", spy)

    priors = _author_priors(
        gateway, frozenset(p.author for p in posts), EPOCH, snap, DEFAULT_SETTINGS
    )
    votes, reps, organics = _norm_inputs(
        posts, EPOCH, settings=DEFAULT_SETTINGS, snapshot=snap, priors=priors
    )
    norm = build_norm_context(votes, reps, organics)
    rank_feed(
        viewer, gateway, norm, now=EPOCH, since=EPOCH - timedelta(days=1),
        settings=DEFAULT_SETTINGS, snapshot=snap,
        trust_policy=pipeline_mod.TrustPolicy.WARN,
    )

    by_key = {p.key: organics[i] for i, p in enumerate(posts)}
    compared = [key for key in by_key if key in captured]
    # ★ A CHECK WITH NOTHING TO INSPECT MUST FAIL, NOT PASS. If the pool ever
    # stops reaching the scorer this loop is empty and every assertion below is
    # vacuously true — the exact shape of the ~22 decorative guards the
    # 2026-08-09 mutation sweep found in this repo.
    assert len(compared) >= 10, (
        f"only {len(compared)} candidates reached the scorer — too few for this "
        "guard to be meaningful; it must not pass by inspecting nothing"
    )
    for key in compared:
        assert captured[key] == pytest.approx(by_key[key], abs=1e-12), (
            f"{key}: the scorer ranked {captured[key]} against a sample built "
            f"from {by_key[key]} — the §4 yardstick and the value it ranks are "
            "two different quantities again (PRUNED N1)"
        )


def test_the_vote_terms_personal_residual_is_exactly_the_stranger_scale() -> None:
    """★ THE ONE KNOWN, DELIBERATE GAP, PINNED SO IT STAYS ONE LINE WIDE.

    `pipeline._score` passes `personal_for=viewer.follows` to
    `independent_vote_signal`; `_norm_inputs` does not, because mirroring it
    would make the §4 sample per-viewer. This test states the exact size of
    that residual: for a viewer who follows none of a post's voters, the
    scorer's vote raw is the SAMPLE's raw with every rshare scaled by
    `_PERSONAL_STRANGER_SCALE` — nothing else differs.

    If someone repairs the vote term (by ranking chain-wide and re-applying the
    personal factor to the PERCENTILE, per `normalize.py:36-48`), this test
    goes red and points at the decision that has to be made explicitly.
    """
    from recsys.contracts import VoteExclusions
    from recsys.core.normalize import log_compress
    from recsys.core.vote_signal import _PERSONAL_STRANGER_SCALE
    from recsys.norm_builder import _norm_inputs

    post = make_post(
        author="alice",
        votes=[make_vote(voter=f"v{i}", rshares=9_000_000_000) for i in range(5)],
    )
    sample_vote, _, _ = _norm_inputs([post], EPOCH, settings=DEFAULT_SETTINGS)
    scorer_vote = independent_vote_signal(
        post, VoteExclusions(author="alice"), personal_for=frozenset()
    )

    chain_raw = sum(v.rshares for v in post.votes)
    # The constant is pinned to its LITERAL shipped value, not read back from
    # the module: the size of this residual IS the constant, so a test that
    # computed the expectation from the same symbol would follow any retune
    # silently and prove nothing. Moving the stranger scale must be a
    # deliberate act that comes here and restates the number.
    assert _PERSONAL_STRANGER_SCALE == 0.35
    assert sample_vote[0] == pytest.approx(log_compress(chain_raw))
    assert scorer_vote == pytest.approx(log_compress(chain_raw * 0.35))
    # And the mechanism itself must still be live — if `personal_for` stopped
    # being honoured the two sides would agree and every assertion above would
    # still hold except this one.
    assert scorer_vote < sample_vote[0]


def test_build_window_norm_threads_the_snapshot_into_the_sample() -> None:
    """The wiring, not just the helper: a `build_window_norm` caller that
    supplies a snapshot must get a sample built WITH it. Without this the
    service could pass one and silently have it dropped."""
    voters = [f"v{i}" for i in range(30)]
    post = make_post(
        author="alice",
        votes=[make_vote(voter=v, rshares=9_000_000_000) for v in voters],
    )
    snap = _budgeting_snapshot("alice", voters)

    with_snap = build_window_norm(
        _FakeWindowGateway([post]), DEFAULT_SETTINGS, now=EPOCH, snapshot=snap
    )
    without = build_window_norm(_FakeWindowGateway([post]), DEFAULT_SETTINGS, now=EPOCH)

    assert with_snap.organic_samples[0] < without.organic_samples[0]


def test_sim_build_norm_uses_the_production_builder() -> None:
    """★ THE ANTI-DRIFT GUARD FOR THE MEASUREMENT INSTRUMENT.

    `measurement-harness/simworld.py::build_norm` used to re-implement
    `_norm_inputs` in three lines. That copy is how the harness ended up
    measuring a §4 sample production had stopped producing — the same drift
    class that already bit `SimGateway.popular_posts` twice (see
    `test_sim_recall_matches_production_weights`). It now DELEGATES, and this
    test fails if it stops: `_norm_inputs` is replaced with a sentinel and the
    sim's own `build_norm` must be the thing that calls it.

    Executed, not a substring check — a substring cannot tell you what the
    harness runs.
    """
    import importlib.util
    import sys
    from pathlib import Path

    pytest.importorskip("numpy")
    sim_path = Path(__file__).resolve().parents[1] / "measurement-harness" / "simworld.py"
    spec = importlib.util.spec_from_file_location("simworld_under_test", sim_path)
    assert spec is not None and spec.loader is not None
    simworld = importlib.util.module_from_spec(spec)
    # `@dataclass` resolves its own module out of `sys.modules`, so the module
    # has to be registered before exec, not after.
    sys.modules[spec.name] = simworld
    try:
        spec.loader.exec_module(simworld)
    finally:
        sys.modules.pop(spec.name, None)

    import recsys.norm_builder as nb

    calls: list[tuple[object, ...]] = []
    real = nb._norm_inputs

    def sentinel(posts, now, **kwargs):
        calls.append((tuple(posts), now, tuple(sorted(kwargs))))
        return real(posts, now, **kwargs)

    world = simworld.build_world(seed=7, authors_per_topic=2, viewers_per_topic=1)
    nb._norm_inputs = sentinel  # type: ignore[assignment]
    try:
        simworld.build_norm(world)
    finally:
        nb._norm_inputs = real  # type: ignore[assignment]

    assert calls, (
        "measurement-harness/simworld.py::build_norm did not call "
        "recsys.norm_builder._norm_inputs — the harness has gone back to "
        "re-implementing the §4 sample and can drift from production again"
    )
    assert calls[0][0] == tuple(world.posts), "the sim passed a different post set"


# ---------------------------------------------------------------------------
# Live
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def live_client() -> hafsql.HafsqlClient:
    c = hafsql.HafsqlClient(HafsqlConfig(), LiteConfig())
    try:
        c.stake_lineage("acidyo")
    except Exception as exc:
        pytest.skip(f"HAFSQL mirror unreachable: {type(exc).__name__}: {exc}")
    return c


@_live
def test_build_window_norm_live_meets_min_samples_and_is_sorted(
    live_client: hafsql.HafsqlClient,
) -> None:
    now = datetime.now(UTC)
    norm = build_window_norm(live_client, DEFAULT_SETTINGS, now=now)

    min_samples = DEFAULT_SETTINGS.norm.min_samples
    assert len(norm.vote_signal_samples) >= min_samples, (
        f"only {len(norm.vote_signal_samples)} vote-signal samples — rank_feed's own "
        f"min_samples={min_samples} gate would refuse to rank against this"
    )
    assert len(norm.reputation_samples) >= min_samples
    assert len(norm.organic_samples) >= min_samples
    assert list(norm.vote_signal_samples) == sorted(norm.vote_signal_samples)
    assert list(norm.reputation_samples) == sorted(norm.reputation_samples)
    assert list(norm.organic_samples) == sorted(norm.organic_samples)
