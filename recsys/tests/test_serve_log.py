"""B1 (2026-08-05) — the exploration serving log."""

from __future__ import annotations

import threading

from recsys.serve_log import ExplorationServeLog


def test_record_counts_each_served_slot() -> None:
    log = ExplorationServeLog()
    log.record(["alice", "bob", "alice"])
    assert log.counts() == {"alice": 2, "bob": 1}


def test_record_is_thread_safe() -> None:
    """`rank_feed` runs on a threaded HTTP server, and a lost increment is a
    free extra slot for whoever races."""
    log = ExplorationServeLog()

    def worker() -> None:
        for _ in range(200):
            log.record(["alice"])

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert log.counts() == {"alice": 1600}


def test_merge_takes_the_maximum_never_the_sum() -> None:
    """★ Reloading persisted counts must not double-charge an author this
    process already served, and must not lower a count either. Summing would
    retire authors on every restart; overwriting would discard in-flight
    counts."""
    log = ExplorationServeLog({"alice": 3, "bob": 1})
    log.merge({"alice": 2, "bob": 5, "carol": 1})
    assert log.counts() == {"alice": 3, "bob": 5, "carol": 1}


def test_clear_forgets_one_author() -> None:
    log = ExplorationServeLog({"alice": 3})
    log.clear("alice")
    assert log.counts() == {}
