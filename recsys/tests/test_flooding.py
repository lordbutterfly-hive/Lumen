"""Tests for recsys.core.flooding (§8.8)."""

from __future__ import annotations

from recsys.contracts import CandidateSource
from recsys.core.flooding import cap_oon_flooding
from tests.fakes import make_candidate, make_post


def test_caps_prolific_gated_oon_author_keeping_first_n_in_order() -> None:
    candidates = [
        make_candidate(make_post(author="bob", permlink=f"p{i}"), CandidateSource.OON_ENGAGED)
        for i in range(5)
    ]
    assert cap_oon_flooding(candidates, max_per_author=2) == candidates[:2]


def test_in_network_and_interest_tag_are_unaffected_regardless_of_count() -> None:
    in_network = [
        make_candidate(make_post(author="alice", permlink=f"in{i}"), CandidateSource.IN_NETWORK)
        for i in range(5)
    ]
    assert cap_oon_flooding(in_network, max_per_author=1) == in_network

    interest = [
        make_candidate(make_post(author="carol", permlink=f"it{i}"), CandidateSource.INTEREST_TAG)
        for i in range(5)
    ]
    assert cap_oon_flooding(interest, max_per_author=1) == interest


def test_mixed_input_preserves_relative_order() -> None:
    exempt = make_candidate(make_post(author="a1", permlink="1"), CandidateSource.IN_NETWORK)
    dave_1 = make_candidate(make_post(author="dave", permlink="d1"), CandidateSource.OON_ENGAGED)
    dave_2 = make_candidate(make_post(author="dave", permlink="d2"), CandidateSource.OON_ENGAGED)
    interest = make_candidate(make_post(author="a2", permlink="2"), CandidateSource.INTEREST_TAG)
    dave_3 = make_candidate(make_post(author="dave", permlink="d3"), CandidateSource.OON_ENGAGED)

    result = cap_oon_flooding([exempt, dave_1, dave_2, interest, dave_3], max_per_author=2)

    assert result == [exempt, dave_1, dave_2, interest]


def test_empty_input_returns_empty_list() -> None:
    assert cap_oon_flooding([], max_per_author=3) == []
