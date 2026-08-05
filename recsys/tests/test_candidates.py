"""Tests for recsys.core.candidates (§3.1)."""

from __future__ import annotations

from recsys.contracts import CandidateSource
from recsys.core.candidates import SOURCE_PRIORITY, merge_candidates, top_up
from tests.fakes import make_candidate, make_post


def test_dup_keys_are_deduped() -> None:
    post = make_post(author="alice", permlink="p1")
    a = make_candidate(post, CandidateSource.OON_ENGAGED)
    b = make_candidate(post, CandidateSource.OON_INTEREST)
    merged = merge_candidates([a], [b])
    assert len(merged) == 1


def test_higher_priority_source_wins() -> None:
    post = make_post(author="alice", permlink="p1")
    engaged = make_candidate(post, CandidateSource.OON_ENGAGED)
    in_network = make_candidate(post, CandidateSource.IN_NETWORK)
    merged = merge_candidates([engaged], [in_network])
    assert merged[0].source is CandidateSource.IN_NETWORK


def test_higher_priority_source_wins_regardless_of_input_order() -> None:
    post = make_post(author="alice", permlink="p1")
    in_network = make_candidate(post, CandidateSource.IN_NETWORK)
    engaged = make_candidate(post, CandidateSource.OON_ENGAGED)
    merged = merge_candidates([in_network], [engaged])
    assert merged[0].source is CandidateSource.IN_NETWORK


def test_output_ordered_by_priority_highest_first() -> None:
    als = make_candidate(make_post(permlink="p-als"), CandidateSource.OON_ALS)
    in_network = make_candidate(make_post(permlink="p-in"), CandidateSource.IN_NETWORK)
    interest = make_candidate(make_post(permlink="p-int"), CandidateSource.OON_INTEREST)
    merged = merge_candidates([als, in_network, interest])
    assert [c.source for c in merged] == [
        CandidateSource.IN_NETWORK,
        CandidateSource.OON_INTEREST,
        CandidateSource.OON_ALS,
    ]


def test_ties_are_stable_by_first_appearance() -> None:
    first = make_candidate(make_post(permlink="p1"), CandidateSource.OON_ENGAGED)
    second = make_candidate(make_post(permlink="p2"), CandidateSource.OON_ENGAGED)
    merged = merge_candidates([first, second])
    assert [c.post.permlink for c in merged] == ["p1", "p2"]


def _filler(n: int) -> list:
    return [
        make_candidate(make_post(author="pop", permlink=f"f{i}"), CandidateSource.INTEREST_TAG)
        for i in range(n)
    ]


def test_top_up_pads_a_starved_pool_to_target() -> None:
    base = [make_candidate(make_post(author="live", permlink=f"l{i}")) for i in range(3)]
    padded = top_up(base, _filler(30), 20)
    assert len(padded) == 20
    # the viewer's own pool is preserved, in order, at the head
    assert padded[:3] == base


def test_top_up_is_a_no_op_for_a_healthy_pool() -> None:
    # A pool at or above target must be returned unchanged AND must not consume
    # the fallback at all — a healthy feed can never be diluted.
    base = [make_candidate(make_post(author="live", permlink=f"l{i}")) for i in range(20)]

    def poison() -> object:
        raise AssertionError("fallback consumed for a healthy pool")
        yield  # pragma: no cover

    assert top_up(base, poison(), 20) == base
    assert top_up(base, poison(), 5) == base


def test_top_up_skips_keys_already_in_base() -> None:
    shared = make_post(author="live", permlink="l0")
    base = [make_candidate(shared)]
    extra = [make_candidate(shared, CandidateSource.INTEREST_TAG), *_filler(5)]
    padded = top_up(base, extra, 4)
    assert len(padded) == 4
    assert [c.post.key for c in padded].count("@live/l0") == 1


def test_top_up_never_invents_candidates_when_extra_is_short() -> None:
    base = [make_candidate(make_post(author="live", permlink="l0"))]
    padded = top_up(base, _filler(2), 20)
    assert len(padded) == 3  # what exists, not the target


def test_source_priority_ranks_in_network_highest() -> None:
    ordered = [
        CandidateSource.IN_NETWORK,
        CandidateSource.OON_ENGAGED,
        CandidateSource.OON_INTEREST,
        CandidateSource.OON_ALS,
    ]
    assert [SOURCE_PRIORITY[s] for s in ordered] == sorted(SOURCE_PRIORITY[s] for s in ordered)
