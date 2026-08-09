"""Accounts whose ENGAGEMENT the ranker ignores — but whose posts still rank.

★★★ WHY THIS IS SEPARATE FROM `banned.py` (2026-08-09, owner: "dont ban them
like trolls, only ban them from the ranker and algo").

A ban (`recsys/core/banned.py`) does two things: it hides the account's posts
AND it stops their engagement minting breadth. That is right for a troll and
wrong for a curation bot. `@curangel`'s curation compilation was the #1 post in
the popularity lane on 2026-08-09 — a real post people read. What must not
count is the other direction: `worldmappin` commented on 44 distinct authors in
36 hours, `pizzabot` on 104. Counting those as "people who engaged" makes the
ranker measure which posts a bot found, not which posts humans discussed, and
curation is a service an author can solicit — so it is farmable by design.

So this list is applied to the EXCLUSION set every engagement signal reads
(votes, comments, reblogs — `VoteExclusions.excluded()`), and NOWHERE near
`filter_eligible`, which is what decides whether a post is shown.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

_DATA = Path(__file__).resolve().parent.parent / "data" / "curator_accounts.txt"


@lru_cache(maxsize=1)
def curator_accounts() -> frozenset[str]:
    """The curator/bot set, from the data file plus `RECSYS_CURATOR_ACCOUNTS`."""
    names: set[str] = set()
    if _DATA.exists():
        for line in _DATA.read_text(encoding="utf-8").splitlines():
            entry = line.split("#", 1)[0].strip().lower()
            if entry:
                names.add(entry)
    extra = os.environ.get("RECSYS_CURATOR_ACCOUNTS", "")
    names.update(part.strip().lower() for part in extra.split(",") if part.strip())
    return frozenset(names)


def is_curator(account: str) -> bool:
    """True when this account's engagement must not count toward any signal."""
    return account.lower() in curator_accounts()
