"""Tie-break must be deterministic per viewer, not alphabetical globally.

Ties were resolved by `post.key` ascending — i.e. by @author/permlink, the same
way for every viewer on the platform. Determinism is correct; a GLOBAL
alphabetical order is not. Wherever scores tie, the same authors win for
everybody, and the winner takes the impression, the engagement, and the history
advantage that follows — so an arbitrary property (where your name sorts)
compounds into a durable ranking advantage. This is the most plausible mechanism
behind round-1 luck predicting round-60 dominance at partial correlation
0.94-0.96 after controlling for true quality.

The replacement keeps both guarantees that mattered — identical inputs give an
identical feed, and a refresh cannot re-roll a tie — while scattering ties across
viewers instead of banking them for the same accounts.
"""

from __future__ import annotations

from recsys.config import DEFAULT_SETTINGS
from recsys.contracts import CandidateSource, ScoreBreakdown, ScoredCandidate, ViewerProfile
from recsys.core.rerank import rerank
from tests.fakes import make_post


def _tied(n: int) -> list[ScoredCandidate]:
    """N candidates with byte-identical scores, distinct authors."""
    out = []
    for i in range(n):
        post = make_post(author=f"author{i:02d}", permlink=f"p{i:02d}", category="hive")
        breakdown = ScoreBreakdown(vote_norm=0.5, rep_norm=0.5, organic=0.5, final=0.5)
        out.append(
            ScoredCandidate(
                post=post, source=CandidateSource.IN_NETWORK, score=breakdown
            )
        )
    return out


def _order(seed: str) -> list[str]:
    return [sc.post.author for sc in rerank(_tied(12), DEFAULT_SETTINGS.diversity, seed)]


def test_same_viewer_always_gets_the_same_order() -> None:
    """Stability: a refresh must not re-roll a tie into a better slot."""
    assert _order("alice") == _order("alice")


def test_different_viewers_get_different_tie_orders() -> None:
    """The point of the change: ties must not resolve identically for everyone."""
    orders = {v: _order(v) for v in ("alice", "bob", "carol", "dave", "erin")}
    distinct = {tuple(o) for o in orders.values()}
    assert len(distinct) > 1, (
        "every viewer received the same tie ordering — the tie-break is still global"
    )


def test_alphabetical_advantage_is_gone() -> None:
    """The alphabetically-first author must not win for every viewer.

    With a global alphabetical tie-break, author00 takes the top slot in 100% of
    feeds. Across many viewers it should now win only sometimes.
    """
    firsts = [_order(f"viewer{i:03d}")[0] for i in range(60)]
    always_first = firsts.count("author00")
    assert always_first < len(firsts), (
        "the alphabetically-first author still takes every top slot"
    )


def test_no_seed_preserves_the_old_deterministic_order() -> None:
    """Callers with no viewer (tests, offline tooling) keep a stable ordering."""
    assert _order("") == _order("")
    assert _order("")[0] == "author00"


def test_an_empty_viewer_account_warns_instead_of_degrading_silently() -> None:
    """★ Executes the anonymous branch — it carried a NameError nothing reached.

    `_tie_break` falls back to the post key on an empty seed, which is right for
    offline tooling and wrong for a user-facing feed: it reinstates the global
    alphabetical ordering the per-viewer tie-break exists to remove, for every
    anonymous viewer simultaneously. The warning is the whole point of the
    branch, so the branch has to be exercised — the first version of it called a
    logger that does not exist under that name, and the suite stayed green
    because no test had ever passed an empty account.
    """
    import logging
    from datetime import timedelta

    from recsys.core.normalize import build_norm_context
    from recsys.pipeline import TrustPolicy, rank_feed
    from tests.fakes import EPOCH, FakeGateway, make_post

    posts = [make_post(author=f"a{i}", permlink=f"p{i}") for i in range(5)]
    viewer = ViewerProfile(account="", follows=frozenset({"a0"}))
    samples = [float(i) for i in range(50)]

    logger = logging.getLogger("recsys.pipeline")
    records: list[str] = []
    handler = logging.Handler()
    handler.emit = lambda r: records.append(r.getMessage())  # type: ignore[method-assign]
    logger.addHandler(handler)
    try:
        feed = rank_feed(
            viewer, FakeGateway(in_network=posts),
            build_norm_context(samples, samples, samples),
            now=EPOCH + timedelta(days=1), since=EPOCH, trust_policy=TrustPolicy.WARN,
        )
    finally:
        logger.removeHandler(handler)

    assert feed, "the anonymous path must still return a feed"
    assert any("empty viewer account" in m for m in records), (
        "the anonymous degradation was silent"
    )
