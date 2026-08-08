"""Globally banned authors — the operator's hard blocklist.

★ Added 2026-08-08 (owner: a named troll "needs to be deleted from showing up
anywhere on Lumen... so he cant be inside the ranking or affect it").

WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
=============================================
This is an OPERATOR list: a human wrote it, the same way ``trusted_seeds.txt``
is human-written and human-reviewed. Nothing derives it, nothing votes on it,
and no signal in this package can add to it. That is the whole point — an
auto-derived ban list is a suppression weapon anyone who can move the input can
aim, and this codebase has already retired one chain-derived trust input
(``_lineage_for``) for exactly that reason.

It is also NOT the per-viewer mute list (``ViewerProfile.mutes``), which is a
reader's own preference and affects only their feed. This applies to everyone.

TWO EFFECTS, AND BOTH ARE REQUIRED
==================================
1. **They cannot be SEEN**: their posts are dropped in
   :func:`recsys.core.second_degree.filter_eligible`, before any lane, gate or
   quota — a ban that a lane could route around is not a ban.
2. **They cannot AFFECT**: their votes, comments and reblogs are unioned into
   the per-candidate ``VoteExclusions`` in ``pipeline``, so they mint no breadth
   for anyone. Banning someone's visibility while still counting their
   engagement would leave them able to promote whoever they like from behind a
   curtain, which is a worse position than not banning them at all.

Set via ``RECSYS_BANNED_AUTHORS`` (comma-separated) and/or the shipped file
``recsys/data/banned_authors.txt`` (one account per line, ``#`` comments). The
two are unioned, so an operator can add one urgently through the environment
without a release. Names are lower-cased and stripped of a leading ``@``:
Hive account names are lower-case, and an entry that silently matches nothing
because somebody typed ``@Name`` is the failure mode this normalisation exists
to prevent.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

_BANNED_FILE = Path(__file__).resolve().parent.parent / "data" / "banned_authors.txt"
_ENV_VAR = "RECSYS_BANNED_AUTHORS"


def _normalise(raw: str) -> str:
    return raw.strip().lstrip("@").lower()


@lru_cache(maxsize=1)
def banned_authors() -> frozenset[str]:
    """The union of the shipped file and ``RECSYS_BANNED_AUTHORS``.

    Cached for the process's lifetime: this is read on every candidate of every
    request, and an operator adding a name restarts the service (the same
    contract ``trusted_seeds`` already has). A missing or unreadable file is an
    empty list, never an error — failing a whole feed shut because a blocklist
    file was absent would trade a troll for an outage.
    """
    names: set[str] = set()

    try:
        if _BANNED_FILE.is_file():
            for line in _BANNED_FILE.read_text(encoding="utf-8").splitlines():
                entry = line.split("#", 1)[0]
                name = _normalise(entry)
                if name:
                    names.add(name)
    except OSError:
        pass

    for entry in os.environ.get(_ENV_VAR, "").split(","):
        name = _normalise(entry)
        if name:
            names.add(name)

    return frozenset(names)


def is_banned(account: str) -> bool:
    """Whether ``account`` is on the operator blocklist (case-insensitive)."""
    return _normalise(account) in banned_authors()
