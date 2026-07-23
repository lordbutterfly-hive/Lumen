"""Reference test module — the quality/style bar for every builder's tests."""

from __future__ import annotations

import math

from recsys.core.normalize import build_norm_context, log_compress, percentile_rank


def test_log_compress_zero_is_zero() -> None:
    assert log_compress(0) == 0.0


def test_log_compress_below_floor_is_zero() -> None:
    # |x| <= floor -> log10(1) = 0
    assert log_compress(5_000_000) == 0.0


def test_log_compress_known_value() -> None:
    # 1e8 / 1e7 = 10 -> log10(10) = 1
    assert math.isclose(log_compress(1e8), 1.0)


def test_log_compress_preserves_sign() -> None:
    assert log_compress(-1e9) < 0 < log_compress(1e9)


def test_percentile_rank_empty_sample_is_neutral() -> None:
    assert percentile_rank(5.0, ()) == 0.5


def test_percentile_rank_positions() -> None:
    samples = (1.0, 2.0, 3.0, 4.0)
    assert percentile_rank(2.0, samples) == 0.5
    assert percentile_rank(0.0, samples) == 0.0
    assert percentile_rank(5.0, samples) == 1.0


def test_build_norm_context_sorts_ascending() -> None:
    ctx = build_norm_context([3.0, 1.0, 2.0], [50.0], [9.0, 8.0])
    assert ctx.vote_signal_samples == (1.0, 2.0, 3.0)
    assert ctx.organic_samples == (8.0, 9.0)
    assert ctx.reputation_samples == (50.0,)
