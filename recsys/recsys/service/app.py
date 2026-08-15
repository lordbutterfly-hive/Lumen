"""A10 — the HTTP entry: ``GET /feed?viewer=<account>`` -> a real, ranked
feed. THE UNIT THAT MAKES IT REAL — before this module, nothing in
``/mnt/o/Lumen`` ever called :func:`recsys.pipeline.rank_feed`.

No web framework is a dependency. ``pyproject.toml`` is shared with other
builders this phase, so adding one (FastAPI+uvicorn, as BUILDMAP-A A10.1
suggested) means editing a file this builder does not own, for a choice the
build brief itself flags as "a deploy decision". The brief's own fallback —
``http.server`` from the stdlib — is dependency-free and, for one GET route
plus a health check, simpler to keep honest: there is no framework layer
whose behaviour needs auditing on top of what this file actually does.

WHAT THIS ASSEMBLES, end to end, per request:

  1. a cached :class:`~recsys.contracts.NormContext` (built by
     :func:`recsys.norm_builder.build_window_norm`, refreshed on a
     background timer — see :class:`_TimerCache` and the OPERATIONAL
     CONSTRAINT note below);
  2. a cached :class:`~recsys.pipeline.TrustSnapshot` (loaded from
     ``recsys.db.store``, same timer-cache treatment — see
     :func:`_load_snapshot_fixed` for a cross-file bug this had to route
     around, documented there);
  3. a per-viewer, TTL-cached :class:`~recsys.contracts.ViewerProfile`
     (built by :func:`recsys.viewer.build_viewer_profile`);
  4. :func:`recsys.pipeline.rank_feed`, ALWAYS under
     :attr:`~recsys.pipeline.TrustPolicy.FAIL_CLOSED` — this module never
     passes ``TrustPolicy.WARN``, by design (see ``rank_feed``'s own "MUST
     NOT CHANGE" note in the build map).

OPERATIONAL CONSTRAINT (measured 2026-08-04, BUILDMAP-A-LAUNCH): a 3-day
``window_posts`` call costs ~8.8s and a 7-day one is within a couple of
seconds of the 15s default statement timeout. The NormContext therefore MUST
be built on a timer and never inside a request — :class:`_TimerCache`
enforces this structurally (the request path only ever reads ``.value``;
only a background thread, or the blocking warm-up before the server starts
accepting connections, ever calls the builder). ``tests/test_service.py``
proves the builder function is invoked exactly once across many requests
inside one refresh window, not once per request.

R8 — THE DONE-CHECK THIS MODULE IS BUILT AGAINST (BUILD-ADJUDICATION
ruling R8, overriding the original "curl returns 200" bar): a live request
must return a non-empty ranked feed, with ``trust_policy`` provably
FAIL_CLOSED (the refusal path must actually fire against a stale/absent
snapshot), every score in ``[0, 1]``, and the served order identical to a
direct in-process ``rank_feed()`` call on the same inputs. See
``tests/test_service.py::test_r8_*`` for the automated proof, not a manual
curl.
"""

from __future__ import annotations

import contextlib
import functools
import ipaddress
import json
import logging
import os
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Generic, TypeVar
from urllib.parse import ParseResult, parse_qs, urlparse

from recsys import db as _recsys_db_pkg  # noqa: F401  (see recsys.db.store import below)
from recsys.author_prior_cache import (
    DEFAULT_CHUNK_SIZE,
    DEFAULT_DISCOVERY_DAYS,
    DEFAULT_DISCOVERY_LIMIT,
    AuthorPriorCache,
    build_warm_author_priors,
)
from recsys.config import DEFAULT_SETTINGS, HafsqlConfig, LiteConfig, Settings
from recsys.core.exploration import post_engagers
from recsys.io.seen_log import fetch_seen
from recsys.contracts import NormContext, ScoredCandidate, ViewerProfile
from recsys.db import store as recsys_store
from recsys.io.hafsql import HafsqlClient
from recsys.norm_builder import build_window_norm
from recsys.pipeline import (
    ALS_DRIFT_REJECTIONS,
    TRUST_DEGRADATION,
    MissingTrustError,
    TrustPolicy,
    TrustSnapshot,
    _trust_is_fresh,
    rank_feed,
)
from recsys.serve_log import ExplorationServeLog
from recsys.viewer import build_viewer_profile

logger = logging.getLogger("recsys.service.app")

# Same env var `recsys/io/hafsql.py` (A15) and `recsys/db/store.py` (A6)
# already read for the recsys DB connection — kept as a local literal rather
# than importing either module's private constant, since this module must
# stay decoupled from their internal naming.
_RECSYS_DSN_ENV = "RECSYS_DATABASE_URL"

# Loose Hive-account-name sanity check (real chain rules are more precise:
# dot-separated segments, no leading/trailing/doubled hyphens per segment —
# not reproduced in full here). This exists to reject obviously-junk input
# before it spends a live round trip, not as the injection defense — every
# query this service reaches (via `recsys.viewer`/`recsys.io.hafsql`) is
# parameterized regardless of what reaches it.
_ACCOUNT_RE = re.compile(r"^[a-z][a-z0-9.-]{1,15}$")

# ★ B3 (2026-08-05) — LUMEN LITE VIEWER IDENTITIES.
#
# A lite user has no Hive account. Their id is a 26-char Crockford base32 ULID
# (48-bit ms timestamp + 80 bits CSPRNG), generated by
# `frontend/apps/blog/lib/lite/ids.ts` — alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`,
# which deliberately omits I, L, O and U. Kept byte-identical to that file; if
# the frontend's alphabet or length ever changes, this must change with it.
#
# WHY THIS WAS A BLOCKER: `_ACCOUNT_RE` requires a lowercase leading letter and
# caps length at 16, so EVERY lite id failed it and `/feed?viewer=<lite-id>`
# returned 400 — the entire Lite tier could not obtain a feed at all, while the
# product treats lite accounts as first-class. Verified before the fix: a real
# 26-char ULID matched neither as generated nor lowercased.
#
# The two alphabets cannot collide: a Hive name must start [a-z] and is at most
# 16 chars; a lite id is exactly 26 and uppercase-only. So `_viewer_is_lite`
# below is a total, unambiguous discriminator, not a heuristic.
_LITE_ID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def _valid_account(name: str) -> bool:
    """Cheap plausibility check before spending a live round trip. As the note
    above `_ACCOUNT_RE` says, this is NOT the injection defense — every query
    downstream is parameterized regardless of what reaches it."""
    return (bool(_ACCOUNT_RE.match(name)) and len(name) <= 16) or bool(_LITE_ID_RE.match(name))


def _viewer_is_lite(name: str) -> bool:
    """True for a Lumen Lite identity, which has no chain-side follow/mute list
    and therefore cannot be profiled from HAFSQL at all."""
    return bool(_LITE_ID_RE.match(name))


def _csv_param(qs: dict[str, list[str]], key: str) -> frozenset[str] | None:
    """Parse a comma-separated query parameter into a set.

    Returns ``None`` when the parameter is ABSENT (meaning "derive it" / "ask
    the chain") and a possibly-EMPTY frozenset when it is present. Collapsing
    those two into a falsy check would make ``?tags=`` silently mean "go derive
    tags from chain history", which is the opposite of what a caller sending an
    empty pick list is asking for.

    Note `parse_qs` drops empty values by default, so `?tags=` does not appear
    in `qs` at all; the `in` check below is against the caller sending the key
    with only separators or whitespace (e.g. `?tags=,`), which IS present and
    IS an explicit empty set.
    """
    if key not in qs:
        return None
    return frozenset(part.strip() for value in qs[key] for part in value.split(",") if part.strip())


def _csv_env(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    """★ B10. Comma-separated ENV var -> tuple, preserving order.

    An UNSET variable falls back to ``default``; a SET-BUT-EMPTY one is an
    explicit empty tuple. That distinction matters for
    ``RECSYS_TRUSTED_PROXY_PEERS`` specifically: `compose.recsys.yml` lists it
    as a pass-through key, so the variable can arrive as `""` on a host that
    never set it, and treating that as "unset" would silently reinstate the
    default rather than letting ``__post_init__`` refuse a hops-without-peers
    configuration.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    return tuple(part.strip() for part in raw.split(",") if part.strip())


@functools.lru_cache(maxsize=32)
def _proxy_networks(
    peers: tuple[str, ...],
) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    """★ B10. Parse (once) the trusted-proxy allowlist into networks.

    Cached on the tuple itself — ``ServiceConfig`` is frozen, so the value is
    hashable and stable for the process, and this runs on the hot path of every
    request. Entries are already validated by ``ServiceConfig.__post_init__``;
    this never sees an unparseable one in practice, and the guard is here so a
    hand-built config in a test cannot turn a typo into a crash mid-request.
    """
    out = []
    for peer in peers:
        try:
            out.append(ipaddress.ip_network(peer, strict=False))
        except ValueError:  # pragma: no cover - refused at construction
            logger.error("ignoring unparseable trusted proxy peer %r", peer)
    return tuple(out)


def _peer_is_trusted_proxy(peer: str, peers: tuple[str, ...]) -> bool:
    """★ B10. Whether the KERNEL-REPORTED peer address is one of the declared
    proxies. No header participates in this decision — that is the entire
    point: ``X-Forwarded-For`` is attacker-controlled, and the peer address is
    the one fact about a request a client cannot rewrite."""
    if not peers:
        return False
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        # Not an IP at all (e.g. a UNIX socket path, or a test double). Cannot
        # be shown to be a declared proxy, so it is not one.
        return False
    return any(addr in net for net in _proxy_networks(peers))


def _int_param(qs: dict[str, list[str]], key: str) -> int | None:
    """Parse an integer query parameter; ``None`` when absent or unparseable.

    Unparseable is treated as absent rather than as an error: `?limit=abc` is a
    caller bug that should not cost them their feed, and the alternative (a 400)
    turns a typo into an outage for a client that was going to ignore the extra
    posts anyway. A NEGATIVE value is rejected by the caller, because that one
    is unambiguous rather than merely malformed.
    """
    values = qs.get(key)
    if not values:
        return None
    try:
        return int(values[0])
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# _TimerCache — build-once-refresh-on-a-timer, never inside a request.
# ---------------------------------------------------------------------------

T = TypeVar("T")


class _TimerCache(Generic[T]):
    """Builds a ``T`` once (blocking, via :meth:`warm`), then refreshes it on
    a background daemon thread every ``refresh_s`` seconds. The request path
    only ever reads :attr:`value` — it never triggers a rebuild, which is the
    property the OPERATIONAL CONSTRAINT (module docstring) requires."""

    def __init__(self, name: str, builder: Callable[[], T], refresh_s: float) -> None:
        self._name = name
        self._builder = builder
        self._refresh_s = refresh_s
        self._lock = threading.Lock()
        self._value: T | None = None
        self._last_built_monotonic: float | None = None
        self._last_built_wall: datetime | None = None
        self.build_count = 0
        self.build_failures = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def warm(self, *, guard: bool = False) -> None:
        """Blocking initial build, called before the server accepts any
        connections. ``guard=True`` logs-and-continues (leaving ``value`` at
        ``None``) instead of raising on failure — for the trust snapshot,
        where "nothing persisted yet" is an expected cold-start state that
        ``rank_feed``'s own FAIL_CLOSED already answers correctly (503, not a
        crash). ``guard=False`` (the default, used for the norm context) lets
        a startup failure propagate and crash the process: a NormContext that
        cannot be built means no request could ever be ranked, so failing
        loudly at boot beats accepting traffic that can only 503 forever."""
        try:
            self._rebuild()
        except Exception:
            self.build_failures += 1
            if guard:
                logger.exception(
                    "%s: initial build failed — starting with no cached value; "
                    "dependent requests are refused until the next successful "
                    "background refresh.",
                    self._name,
                )
                return
            raise

    def start_background_refresh(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._loop, name=f"{self._name}-refresh", daemon=True
        )
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.wait(self._refresh_s):
            try:
                self._rebuild()
            except Exception:
                self.build_failures += 1
                age = self.age_s
                if age is None:
                    # No value has EVER been built, so there is nothing being kept
                    # and dependent requests stay refused. The single message this
                    # replaced logged "keeping the last-known-good cached value
                    # (age -1s)" in this case too, which reads as a benign transient
                    # and hides a total outage. Observed 2026-08-15: it repeated
                    # every 10 minutes for an hour after a reboot brought the
                    # service up before its database, while /feed would have 503'd
                    # the whole time and the container sat "unhealthy" unexplained.
                    logger.exception(
                        "%s: background refresh failed and there is NO cached value "
                        "— dependent requests stay REFUSED until a build succeeds "
                        "(consecutive failures: %d).",
                        self._name,
                        self.build_failures,
                    )
                else:
                    logger.exception(
                        "%s: background refresh failed — keeping the last-known-good "
                        "cached value (age %.0fs); a transient failure must never "
                        "silently discard a good cache.",
                        self._name,
                        age,
                    )

    def _rebuild(self) -> None:
        value = self._builder()
        with self._lock:
            self._value = value
            self._last_built_monotonic = time.monotonic()
            self._last_built_wall = datetime.now(UTC)
            self.build_count += 1

    @property
    def value(self) -> T | None:
        with self._lock:
            return self._value

    @property
    def last_built_wall(self) -> datetime | None:
        with self._lock:
            return self._last_built_wall

    @property
    def age_s(self) -> float | None:
        with self._lock:
            if self._last_built_monotonic is None:
                return None
            return time.monotonic() - self._last_built_monotonic

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)


class _ViewerProfileCache:
    """Per-account TTL cache for ``build_viewer_profile`` — the per-VIEWER
    analogue of :class:`_TimerCache` above. Unlike the norm/snapshot (shared,
    proactively refreshed), a profile is per-account and unbounded in
    cardinality, so it is cached LAZILY: built on first request for that
    account, reused until it ages out.

    Exists because ``recsys.viewer.derive_interest_tags``'s voting-history
    half is measured live at ~0.7-4s (see that module's own note) — cheap
    enough for a genuine per-viewer login/profile-build, too expensive to
    redo on every single feed poll from the same viewer.
    """

    def __init__(self, ttl_s: float, max_entries: int) -> None:
        self._ttl_s = ttl_s
        self._max_entries = max(1, max_entries)
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, ViewerProfile]] = {}

    def get(self, account: str, builder: Callable[[], ViewerProfile]) -> ViewerProfile:
        now_m = time.monotonic()
        with self._lock:
            cached = self._entries.get(account)
            if cached is not None and now_m - cached[0] < self._ttl_s:
                return cached[1]
        profile = builder()
        with self._lock:
            if account not in self._entries and len(self._entries) >= self._max_entries:
                # Cheap unbounded-growth guard, not real LRU: evict whatever
                # is oldest by insertion order (dicts preserve it, py3.7+).
                # Phase-0 traffic does not need a precise eviction policy.
                self._entries.pop(next(iter(self._entries)))
            self._entries[account] = (now_m, profile)
        return profile

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


def _load_snapshot_fixed(dsn: str | None) -> TrustSnapshot | None:
    """Load the current :class:`TrustSnapshot`, applying a fix for a bug this
    builder found (and does not own the file to fix directly) in
    ``recsys.db.store.load_snapshot``.

    ★★ A CROSS-FILE BUG WORKED AROUND, NOT FIXED (found 2026-08-04, live-
    verified against a real recsys Postgres). ``load_snapshot`` returns a
    ``PersistedSnapshot(snapshot, built_at)`` — but ``snapshot.built_at``
    (the field ``recsys.pipeline._trust_is_fresh`` actually reads for A8.3
    staleness) is left at its dataclass default, ``None``, on EVERY load.
    Only the wrapper's OWN ``built_at`` carries the real timestamp. Proven
    live: persisted a snapshot with ``built_at`` 400 days in the past,
    ``_trust_is_fresh(persisted.snapshot, now=now, max_age_days=14)``
    returned ``True`` (a 400-day-old snapshot reading as fresh — exactly the
    silent-staleness gap A8.3 exists to close), while
    ``_trust_is_fresh(dataclasses.replace(persisted.snapshot,
    built_at=persisted.built_at), ...)`` correctly returned ``False``. Any
    caller that does the natural, obvious thing —
    ``rank_feed(..., snapshot=load_snapshot().snapshot)`` — silently defeats
    its own staleness gate. This is exactly the shape R8 says to prove:
    "assert the refusal path actually fires with a stale ... snapshot", and
    it would NOT fire without this fix. Reported for ``recsys/db/store.py``'s
    owner to fix at the source (make ``load_snapshot`` stamp ``built_at`` on
    the returned dataclass directly) — applied here via ``dataclasses.
    replace`` in the meantime, since this builder does not own that file.

    Returns ``None`` — never raises — for the two EXPECTED "no snapshot"
    states: no ``RECSYS_DATABASE_URL`` configured at all (permanent until an
    operator sets one), and a DSN configured but nothing persisted yet
    (``load_snapshot`` itself returns ``None`` for this — "a real, expected
    state, not an error", per its own docstring). ``rank_feed``'s
    FAIL_CLOSED default already answers a ``None`` snapshot correctly (503
    via :class:`MissingTrustError`, never a crash). Any OTHER exception (a
    genuine DB error) is left to PROPAGATE: :meth:`_TimerCache.warm` (guarded
    at startup) and :meth:`_TimerCache._loop` (background refresh) both treat
    that as "could not refresh this time", not "the snapshot is gone" — a
    transient recsys-DB blip must never silently erase a good cached
    snapshot.
    """
    resolved_dsn = dsn if dsn is not None else os.environ.get(_RECSYS_DSN_ENV)
    if not resolved_dsn:
        logger.warning(
            "trust_snapshot cache: no %s configured — treating the trust snapshot "
            "as permanently absent; /feed will refuse under FAIL_CLOSED until one "
            "is configured and a batch has run.",
            _RECSYS_DSN_ENV,
        )
        return None
    persisted = recsys_store.load_snapshot(resolved_dsn)
    if persisted is None:
        return None
    return replace(persisted.snapshot, built_at=persisted.built_at)


def _default_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class ServiceConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    #: How often the shared NormContext is rebuilt in the background. 30 min
    #: default: `sourcing_freshness_days` (3d default) changes slowly, and a
    #: rebuild costs several seconds (window_posts hydration) that must never
    #: land inside a request.
    norm_refresh_s: float = 1800.0
    #: How often the shared TrustSnapshot is reloaded from the recsys DB.
    #: 10 min default: the batch runs weekly, so promptness is not the
    #: concern — bounding how long a stale operator DSN misconfiguration or a
    #: fresh batch run takes to be *noticed* is.
    snapshot_refresh_s: float = 600.0
    #: Per-account ViewerProfile TTL — see `_ViewerProfileCache`.
    viewer_cache_ttl_s: float = 300.0
    #: ★★★ LAUNCH PUNCH LIST #3 (2026-08-05) — TRUSTED REVERSE-PROXY HOPS.
    #:
    #: The rate limiter keys on the peer address. Behind the reverse proxy this
    #: artifact documents, EVERY client shares one peer address, so ONE
    #: unauthenticated caller spends the whole bucket and locks the feed out for
    #: every real user — measured by two councils: 10 credential-free requests,
    #: and the 11th with the CORRECT token gets 429.
    #:
    #: `0` (the default) means "no proxy in front, trust nobody": the peer
    #: address is used, and `X-Forwarded-For` is IGNORED. That is the safe
    #: default, because a forwarded header is attacker-supplied — trusting it
    #: with no proxy in front lets anyone forge a fresh identity per request and
    #: bypass the limiter entirely, which is a worse bug than the one it fixes.
    #:
    #: `N > 0` means "there are N proxies you control between you and the
    #: client", and the client address is taken N entries from the RIGHT of
    #: `X-Forwarded-For` — the only position an upstream attacker cannot write.
    #:
    #: ★★★ B10 (2026-08-06 QA) — `N > 0` ALONE WAS NOT SAFE, and this is a gap in
    #: the fix directly above, found by the QA seat one round after it shipped.
    #: See `trusted_proxy_peers`.
    trusted_proxy_hops: int = 0
    #: ★★★ B10 — WHO IS ALLOWED TO SPEAK FOR A `X-Forwarded-For` HEADER.
    #:
    #: Taking `chain[-hops]` is only sound if the request ACTUALLY ARRIVED
    #: THROUGH those proxies. Nothing checked that. `_client_identity` read the
    #: header purely on the strength of a number in the config, so any client
    #: that could reach the port DIRECTLY — a sibling container on the same
    #: Docker network, anything inside the VPC, anyone at all if the port is
    #: published — supplied the whole chain itself, including the position we
    #: call unforgeable, and minted an unlimited number of fresh rate-limit
    #: buckets. The limiter is the only thing standing between one script and
    #: the shared third-party mirror, so "unlimited buckets" means "no limiter".
    #:
    #: Entries are IPs or CIDRs (`10.0.0.7`, `172.18.0.0/16`, `::1`), matched
    #: against the PEER address — the one the kernel reports, which no header
    #: can change. A request from outside the set is judged on its peer address
    #: and its `X-Forwarded-For` is ignored entirely, exactly as at `hops=0`.
    #:
    #: ★ REQUIRED whenever `trusted_proxy_hops > 0`, refused at construction
    #: otherwise (`__post_init__`). Not defaulted to something permissive and
    #: not merely documented in a comment: this project has now shipped the same
    #: defect three times — a control that is optional-by-default is a control
    #: nobody sets, and "documented precondition" is how the seat secret, the
    #: API token and the lite DSN each went missing in turn. Setting hops
    #: without peers is far more likely to be an operator who does not know
    #: about this than a deliberate choice, so it fails LOUDLY at startup rather
    #: than serving a silently-forgeable limiter.
    trusted_proxy_peers: tuple[str, ...] = ()
    viewer_cache_max_entries: int = 10_000
    #: How often the shared author-pooled engagement prior (§6) is
    #: rebuilt in the background — see `recsys.author_prior_cache`'s module
    #: docstring for why this is on the SAME cache/timer basis as
    #: `norm_refresh_s` rather than a per-request computation. 30 min
    #: default, matching `norm_refresh_s`: the prior is a per-author WINDOW
    #: aggregate over `settings.history.quality_prior_days` (45d default),
    #: which moves slowly. Live-measured 2026-08-04 (this builder), stated
    #: honestly rather than rounded down: a FULL warm build over the
    #: default 7-day/6000-author discovery scope (2,227 real distinct
    #: authors on the live network at measurement time) took 508s (8.5
    #: min) — ~62s of per-author `stake_lineage` calls plus chunked
    #: `author_engagement`, ~28% of this 1800s default. That is real
    #: background cost, but it is BACKGROUND cost: it must never land inside
    #: a request (`_TimerCache`'s own discipline, mirrored here), and 1800s
    #: leaves comfortable room for it even at today's network size. Shrink
    #: this default only alongside re-measuring the warm-build time it would
    #: then need to fit inside.
    author_prior_refresh_s: float = 1800.0
    #: How many days back the warm-set author UNIVERSE is discovered from
    #: (see `recsys.author_prior_cache.discover_recent_authors`) — NOT the
    #: window the prior itself is pooled over (that stays
    #: `settings.history.quality_prior_days`, unconditionally, to match
    #: `rank_feed`'s own `quality_since`). Defaults to
    #: `recsys.author_prior_cache.DEFAULT_DISCOVERY_DAYS` (7d — the WIDEST
    #: candidate-sourcing horizon any lane in `gather_candidates` uses).
    author_prior_discovery_days: int = DEFAULT_DISCOVERY_DAYS
    #: Hard cap on the warm-set size — see
    #: `recsys.author_prior_cache.DEFAULT_DISCOVERY_LIMIT`'s own docstring
    #: for the live-measured headroom this leaves today.
    author_prior_discovery_limit: int = DEFAULT_DISCOVERY_LIMIT
    #: Authors per `author_engagement` call during a warm build — see
    #: `recsys.author_prior_cache`'s module docstring for the live-measured
    #: cost curve this default is chosen from.
    author_prior_chunk_size: int = DEFAULT_CHUNK_SIZE

    # ------------------------------------------------------------------
    # B4c (2026-08-05) — HTTP surface controls.
    #
    # Before these, `/feed` had NO auth, NO rate limit, NO concurrency cap and
    # NO per-connection read timeout, in front of a pool that (pre-B4b) opened
    # unbounded connections to a SHARED third-party mirror. One loop took the
    # service down and plausibly got the deployment banned by the mirror
    # operator. `/feed?viewer=<anyone>` also returned any account's feed
    # including the full {vote_norm, rep_norm, organic, final} decomposition.
    # ------------------------------------------------------------------

    #: Shared bearer token. ``None`` disables auth — permitted in dev, REFUSED
    #: in production by `main()`, exactly like the exploration seat secret.
    api_token: str | None = None
    #: Requests per minute per client address. 0 disables.
    rate_limit_per_minute: int = 120
    #: Concurrent in-flight `/feed` requests. Bounds thread and pool pressure
    #: independently of the rate limit, which cannot stop 100 simultaneous
    #: slow requests. 0 disables.
    max_concurrent_requests: int = 16
    #: Per-connection socket read timeout. `BaseHTTPRequestHandler.timeout` is
    #: `None` by default, so a slow-loris client held a thread indefinitely;
    #: `daemon_threads` bounds shutdown, not occupancy.
    request_read_timeout_s: float = 10.0

    def __post_init__(self) -> None:
        # ★ B10. Validate at CONSTRUCTION, so a bad value cannot reach a request.
        # Every entry must parse, because a typo (`10.0.0.7 ` with a stray comma,
        # or a hostname) that silently matched nothing would degrade to "peer
        # address" — the shared-bucket outage punch-list #3 exists to fix —
        # while the config still claimed a proxy was trusted.
        for peer in self.trusted_proxy_peers:
            try:
                ipaddress.ip_network(peer, strict=False)
            except ValueError as exc:
                raise ValueError(
                    f"RECSYS_TRUSTED_PROXY_PEERS entry {peer!r} is not an IP or CIDR: "
                    f"{exc}. Use e.g. '172.18.0.0/16' or '127.0.0.1' (hostnames are "
                    "not resolved — the peer address is compared numerically)."
                ) from exc
        if self.trusted_proxy_hops > 0 and not self.trusted_proxy_peers:
            raise ValueError(
                "RECSYS_TRUSTED_PROXY_HOPS > 0 requires RECSYS_TRUSTED_PROXY_PEERS. "
                "Declaring hops without declaring WHO the proxies are means "
                "X-Forwarded-For is trusted from any caller that can reach this "
                "port directly, and each forged header is a fresh rate-limit "
                "bucket — the limiter stops existing. Set the proxy's address or "
                "CIDR (e.g. RECSYS_TRUSTED_PROXY_PEERS=172.18.0.0/16), or set "
                "RECSYS_TRUSTED_PROXY_HOPS=0 if there is no proxy in front."
            )

    @classmethod
    def from_env(cls) -> ServiceConfig:
        return cls(
            host=os.environ.get("RECSYS_SERVICE_HOST", cls.host),
            port=int(os.environ.get("RECSYS_SERVICE_PORT", cls.port)),
            api_token=os.environ.get("RECSYS_API_TOKEN") or None,
            trusted_proxy_hops=int(
                os.environ.get("RECSYS_TRUSTED_PROXY_HOPS", cls.trusted_proxy_hops)
            ),
            trusted_proxy_peers=_csv_env(
                "RECSYS_TRUSTED_PROXY_PEERS", cls.trusted_proxy_peers
            ),
            rate_limit_per_minute=int(
                os.environ.get("RECSYS_RATE_LIMIT_PER_MINUTE", cls.rate_limit_per_minute)
            ),
            max_concurrent_requests=int(
                os.environ.get("RECSYS_MAX_CONCURRENT_REQUESTS", cls.max_concurrent_requests)
            ),
            request_read_timeout_s=float(
                os.environ.get("RECSYS_REQUEST_READ_TIMEOUT_S", cls.request_read_timeout_s)
            ),
            norm_refresh_s=float(os.environ.get("RECSYS_NORM_REFRESH_S", cls.norm_refresh_s)),
            snapshot_refresh_s=float(
                os.environ.get("RECSYS_SNAPSHOT_REFRESH_S", cls.snapshot_refresh_s)
            ),
            viewer_cache_ttl_s=float(
                os.environ.get("RECSYS_VIEWER_CACHE_TTL_S", cls.viewer_cache_ttl_s)
            ),
            viewer_cache_max_entries=int(
                os.environ.get(
                    "RECSYS_VIEWER_CACHE_MAX_ENTRIES", cls.viewer_cache_max_entries
                )
            ),
            author_prior_refresh_s=float(
                os.environ.get("RECSYS_AUTHOR_PRIOR_REFRESH_S", cls.author_prior_refresh_s)
            ),
            author_prior_discovery_days=int(
                os.environ.get(
                    "RECSYS_AUTHOR_PRIOR_DISCOVERY_DAYS", cls.author_prior_discovery_days
                )
            ),
            author_prior_discovery_limit=int(
                os.environ.get(
                    "RECSYS_AUTHOR_PRIOR_DISCOVERY_LIMIT", cls.author_prior_discovery_limit
                )
            ),
            author_prior_chunk_size=int(
                os.environ.get("RECSYS_AUTHOR_PRIOR_CHUNK_SIZE", cls.author_prior_chunk_size)
            ),
        )


@dataclass
class ServiceState:
    """Everything one running service process holds: the pooled gateway, the
    two timer-refreshed caches, the per-viewer cache, and ``now_fn`` — the
    ONE seam this module exposes for deterministic testing (R8's "served
    order is IDENTICAL to a direct in-process rank_feed() call" proof needs
    the HTTP path and the comparison call to share an identical ``now``; see
    ``tests/test_service.py``). Production never overrides it; the default is
    plain wall-clock UTC."""

    config: ServiceConfig
    settings: Settings
    gateway: HafsqlClient
    recsys_dsn: str | None
    norm_cache: _TimerCache[NormContext]
    snapshot_cache: _TimerCache[TrustSnapshot | None]
    viewer_cache: _ViewerProfileCache
    #: The author-pooled engagement prior (§6) warm cache — see
    #: `recsys.author_prior_cache`'s module docstring. NOT YET READ by
    #: `build_feed`/`rank_feed`: `recsys.pipeline._author_priors` still
    #: calls `gateway.author_engagement(...)` directly on every request, and
    #: this builder does not own `recsys/pipeline.py` — see this class's own
    #: module docstring note at the `rank_feed` call site in `build_feed`
    #: below, and the build report, for the exact change needed to wire it
    #: in. Warmed and refreshed regardless, so `stats()` and `/health` are
    #: already meaningful ahead of that wiring landing.
    author_prior_cache: AuthorPriorCache
    #: ★ B1 (2026-08-05) — process-wide exploration serve counts. In-process by
    #: design (see `recsys.serve_log`): a restart forgets them, which fails OPEN
    #: (authors become eligible again) rather than shut, the correct direction
    #: for a discovery lane.
    #:
    #: ★★★ PERSISTENCE EXISTS SINCE 2026-08-15 — this comment used to end
    #: "Persistence is NOT implemented" and that is now false. `recsys.
    #: serve_log_store` provides a durable Postgres store and
    #: `ExplorationServeLog` resolves it FROM THE ENVIRONMENT in its own
    #: `__init__` (`RECSYS_EXPLORATION_SERVE_PERSIST`, default OFF), precisely so
    #: the capability is reachable without editing this line — the repeated
    #: defect in this package's history is a feature that is built and then
    #: reached by nothing. With the flag off the behaviour above is unchanged.
    #: It matters because FEED-BALANCE-RULING-2026-08-08 blocks any newcomer
    #: increase "until the serve log is persisted", and an in-process log also
    #: let a restart refund a spent budget.
    serve_log: ExplorationServeLog = field(default_factory=ExplorationServeLog)
    now_fn: Callable[[], datetime] = field(default=_default_now)

    @classmethod
    def build(
        cls,
        *,
        config: ServiceConfig | None = None,
        settings: Settings = DEFAULT_SETTINGS,
        hafsql_config: HafsqlConfig | None = None,
        lite_config: LiteConfig | None = None,
        recsys_dsn: str | None = None,
    ) -> ServiceState:
        cfg = config or ServiceConfig.from_env()
        resolved_dsn = recsys_dsn if recsys_dsn is not None else os.environ.get(_RECSYS_DSN_ENV)
        resolved_hafsql_config = hafsql_config or HafsqlConfig.from_env()
        gateway = HafsqlClient(resolved_hafsql_config, lite_config, recsys_dsn=resolved_dsn)
        snapshot_cache: _TimerCache[TrustSnapshot | None] = _TimerCache(
            "trust_snapshot",
            lambda: _load_snapshot_fixed(resolved_dsn),
            cfg.snapshot_refresh_s,
        )
        # Closes over the LOCAL `snapshot_cache` above (not `self`/`state`,
        # which does not exist yet at this point in `build()`) so the warm
        # builder always reads the CURRENT shared TrustSnapshot at rebuild
        # time — see `recsys.author_prior_cache.build_warm_author_priors`'s
        # own docstring for why the exclusion/breadth budget it computes
        # must track the same snapshot `_author_priors` would use live.
        author_prior_cache = AuthorPriorCache(
            "author_prior",
            lambda: build_warm_author_priors(
                gateway,
                resolved_hafsql_config,
                settings,
                lambda: snapshot_cache.value,
                discovery_days=cfg.author_prior_discovery_days,
                discovery_limit=cfg.author_prior_discovery_limit,
                chunk_size=cfg.author_prior_chunk_size,
            ),
            cfg.author_prior_refresh_s,
        )
        # ★★★ THE NORM CACHE IS BUILT LAST, AND IT READS THE OTHER TWO
        # (2026-08-10, PRUNED N1). The §4 percentile sample must be drawn from
        # the SAME quantity `pipeline._score` ranks against it, and two of that
        # quantity's inputs — the graph-cred breadth budget and the per-author
        # ring exclusion — live on the TrustSnapshot, while the third (the
        # author-pooled prior) lives on the warm prior cache. Built without
        # them, as this was, the sample is a different formula from the scorer's
        # and the organic percentile loses 21% of its realised spread with the
        # top of its own scale unreachable (measured: live 3-day window, mean
        # 0.5001 -> 0.4258, max 1.0000 -> 0.9487, sd 0.2887 -> 0.2163).
        #
        # It closes over the LOCAL caches (not `self`/`state`, which does not
        # exist yet here) for the same reason `author_prior_cache` above does,
        # and reads `.value` at REBUILD time so each 30-minute rebuild picks up
        # whatever snapshot/priors the request path is currently using. Passing
        # the cache's own `get` — rather than letting `build_window_norm` run
        # the grouped query itself — is what keeps the sample's prior coverage
        # identical to the scorer's, misses included.
        norm_cache: _TimerCache[NormContext] = _TimerCache(
            "norm_context",
            lambda: build_window_norm(
                gateway,
                settings,
                now=datetime.now(UTC),
                snapshot=snapshot_cache.value,
                author_prior_cache=author_prior_cache.get,
            ),
            cfg.norm_refresh_s,
        )
        viewer_cache = _ViewerProfileCache(cfg.viewer_cache_ttl_s, cfg.viewer_cache_max_entries)
        return cls(
            config=cfg,
            settings=settings,
            gateway=gateway,
            recsys_dsn=resolved_dsn,
            norm_cache=norm_cache,
            snapshot_cache=snapshot_cache,
            viewer_cache=viewer_cache,
            author_prior_cache=author_prior_cache,
        )

    def warm(self) -> None:
        """Blocking. Call once, before the server starts accepting
        connections — see `_TimerCache.warm`'s own docstring for why the norm
        build is fatal-on-failure and the snapshot build is not.

        ★ ORDER IS LOAD-BEARING (2026-08-10, PRUNED N1): snapshot and priors
        first, THEN the norm. The §4 sample is drawn from the scorer's own
        quantity, and that quantity reads both — see `build()`. Warming the
        norm first (as this did) would bake a sample built with neither, then
        keep it for a full `norm_refresh_s` while every request scored against
        it. The two feeders stay `guard=True`: a snapshot failure must not kill
        boot, and `build_window_norm` logs loudly when it has to fall back."""
        logger.info("service: warming TrustSnapshot cache (blocking)...")
        self.snapshot_cache.warm(guard=True)
        logger.info(
            "service: warming author-prior cache (blocking — chunked "
            "author_engagement over the warm-set author universe; see "
            "recsys.author_prior_cache's module docstring for measured cost)..."
        )
        self.author_prior_cache.warm(guard=True)
        logger.info(
            "service: warming NormContext cache (blocking — window_posts is a few "
            "seconds at the default window; drawn from the snapshot + priors "
            "warmed above)..."
        )
        self.norm_cache.warm(guard=False)

    def start_background_refresh(self) -> None:
        self.norm_cache.start_background_refresh()
        self.snapshot_cache.start_background_refresh()
        self.author_prior_cache.start_background_refresh()

    def close(self) -> None:
        self.norm_cache.stop()
        self.snapshot_cache.stop()
        self.author_prior_cache.stop()
        for pool_attr in ("_pool", "_recsys_pool"):
            pool = getattr(self.gateway, pool_attr, None)
            if pool is not None:
                try:
                    pool.closeall()
                except Exception:
                    logger.warning("service: error closing gateway %s", pool_attr, exc_info=True)


# ---------------------------------------------------------------------------
# The core assembly (A10.2) — importable and directly callable with no HTTP
# involved at all, which is what lets `tests/test_service.py` compare it
# against the HTTP response for the R8 "identical order" proof.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FeedResult:
    account: str
    now: datetime
    viewer: ViewerProfile
    scored: list[ScoredCandidate]


class FeedUnavailableError(RuntimeError):
    """What ``build_feed`` raises for every REFUSAL ``rank_feed`` can produce
    — carries enough for the HTTP layer to pick the right status/body without
    re-deriving it. ``kind`` is a short machine-readable tag, not free text."""

    def __init__(
        self, kind: str, detail: str, *, norm_samples: dict[str, int] | None = None
    ) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.norm_samples = norm_samples


def build_feed(
    state: ServiceState,
    account: str,
    *,
    explicit_interest_tags: frozenset[str] | None = None,
    explicit_follows: frozenset[str] | None = None,
    explicit_mutes: frozenset[str] | None = None,
    #: ★★★ HOW MANY POSTS THIS RANKING WILL ACTUALLY BE DELIVERED (2026-08-15).
    #:
    #: `?limit=` was parsed in the HTTP handler and applied to the SERIALISED
    #: payload AFTER this function returned, so the number existed one layer above
    #: the ranker and was thrown away before reaching it — which is why neither
    #: the exploration seat rule ("1 per 20 SERVED posts") nor the seen-suppression
    #: starvation floor could be expressed at all. Forwarded here ONCE, with one
    #: agreed meaning, so the two features cannot build it twice with two.
    #:
    #: `None` = unknown; `rank_feed` then floors on `FallbackConfig.min_feed_size`
    #: alone, which is the pre-existing guarantee.
    serve_limit: int | None = None,
) -> FeedResult:
    """A10.2's assembly, in one function: cached NormContext + cached
    TrustSnapshot + a (per-viewer-cached) real ViewerProfile ->
    ``rank_feed(..., trust_policy=TrustPolicy.FAIL_CLOSED)``. Never passes
    ``TrustPolicy.WARN`` — see the module docstring.

    ★ B3 (2026-08-05). The two ``explicit_*`` arguments carry caller-supplied
    viewer state. They serve two constituencies:

      * **Lumen Lite viewers**, whose follow graph exists only in Lumen's own
        store — see ``_viewer_is_lite`` and ``build_viewer_profile``'s note.
      * **The signup interest picker** (spec D3) for EITHER tier, which until
        now had no consumer anywhere in the package: ``explicit_interest_tags``
        existed on ``build_viewer_profile`` and was never once passed by
        production code, so a brand-new account's picks could not reach the
        ranker and it fell through to popular-fallback padding.

    ★★ THESE REQUESTS BYPASS ``viewer_cache`` DELIBERATELY. That cache is keyed
    on ``account`` ALONE, so caching a profile built from per-request tags or
    follows would serve the FIRST request's picks to every later request from
    the same viewer — stale in a way no test keyed on account would notice. The
    bypass is close to free for the case that needs it: with follows and tags
    both supplied there is no chain query left to make, which is exactly the
    lite path. A request with neither argument keeps the cached path unchanged.
    """
    now = state.now_fn()
    norm = state.norm_cache.value
    if norm is None:
        raise FeedUnavailableError(
            "norm_unavailable",
            "NormContext has not been built yet (service is still warming up)",
        )
    snapshot = state.snapshot_cache.value  # None is a legitimate value — FAIL_CLOSED handles it

    # ★★★ B6 (2026-08-06 full-system QA) — THE REFUSAL RUNS FIRST NOW.
    #
    # This gate used to fire inside `rank_feed`, i.e. AFTER `build_viewer_profile`
    # had already made its live HAFSQL calls (`follows_of`/`mutes_of`/
    # `derive_interest_tags`) and after `gather_candidates` had hydrated the pool.
    # Measured by the QA seat: 33s uncached vs 7ms cached — so under exactly the
    # condition this refusal exists for (the weekly trust batch has stopped, or
    # the DB holding the snapshot is unreachable), every request paid the FULL
    # live cost and was then thrown away with a 503.
    #
    # That is backwards twice over. FAIL_CLOSED exists to PROTECT during an
    # outage, and running it last meant it protected nothing; worse, it amplified
    # a local outage into sustained load on a SHARED third-party mirror we do not
    # own and were nearly banned from once already (see `ServiceConfig`'s B4c
    # block). A refusal that costs more than a success is not a safety valve.
    #
    # ★ DELIBERATELY THE SAME PREDICATE, NOT A SECOND ONE. `_trust_is_fresh` is
    # the exact function `rank_feed` gates on, called with the exact same
    # arguments (`snapshot`, `now`, `settings.trust.max_snapshot_age_days`), so
    # this cannot drift into refusing a request `rank_feed` would have served or
    # vice versa. `health_payload` below calls the same function for the same
    # reason. The `except MissingTrustError` handler further down is KEPT as
    # defence in depth rather than deleted: if these two ever DO disagree, the
    # request is still refused rather than silently served fail-open.
    if not _trust_is_fresh(
        snapshot, now=now, max_age_days=state.settings.trust.max_snapshot_age_days
    ):
        reason = "no trust snapshot" if snapshot is None else "degraded or stale trust snapshot"
        logger.error(
            "feed: REFUSING every request BEFORE any upstream work — %s "
            "(viewer=%s). The weekly trust batch has probably stopped running; "
            "/health reports status=degraded for this.",
            reason,
            account,
        )
        raise FeedUnavailableError(
            "trust_unavailable",
            f"refusing to rank ({reason}): the breadth budget, ring/lineage exclusion, "
            "graph-cred floor and CF would all silently revert to full-breadth "
            "fail-open. Refused before building the viewer profile so an outage "
            "costs no upstream queries.",
        )

    # A lite identity has no chain-side follow/mute list at all, so its profile
    # must NEVER fall through to `follows_of`/`mutes_of` — those would query
    # HAFSQL for an account name that does not exist on chain. Absent an
    # explicit list, a lite viewer's graph is empty (the signup state), which is
    # `frozenset()` and emphatically NOT `None`.
    is_lite = _viewer_is_lite(account)
    follows_arg = explicit_follows
    tags_arg = explicit_interest_tags
    # ★★★ LAUNCH PUNCH LIST #2 (2026-08-05) — A LITE VIEWER CAN NOW MUTE.
    # `?mutes=` was parsed NOWHERE, and a lite viewer's mute list was forced to
    # the empty set unconditionally, so muting somebody in the UI changed
    # nothing at all and the exploration lane happily kept serving that author
    # into position 13. A feature that silently does nothing is worse than an
    # absent one: the user believes they acted. Found by two councils running.
    mutes_arg: frozenset[str] | None = explicit_mutes
    if is_lite:
        if follows_arg is None:
            follows_arg = frozenset()
        if mutes_arg is None:
            mutes_arg = frozenset()
        if tags_arg is None:
            # Same reason as follows/mutes: `derive_interest_tags` reads the
            # account's own chain history, which for a ULID is a live query
            # guaranteed to return nothing. A lite viewer who sent no picks has
            # no interests yet — that is an empty set, not something to derive.
            tags_arg = frozenset()

    def _build() -> ViewerProfile:
        return build_viewer_profile(
            account,
            state.gateway,
            now=now,
            settings=state.settings,
            explicit_interest_tags=tags_arg,
            explicit_follows=follows_arg,
            explicit_mutes=mutes_arg,
        )

    # ★ `mutes_arg` joins the cache-bypass condition for the same reason tags
    # and follows are on it: `viewer_cache` is keyed on ACCOUNT ALONE, so a
    # cached profile would serve the FIRST request's mute list to every later
    # request from that viewer — a mute that works once and then silently stops.
    if tags_arg is not None or follows_arg is not None or explicit_mutes is not None:
        viewer = _build()
    else:
        viewer = state.viewer_cache.get(account, builder=_build)

    # ★ WIRED 2026-08-04. `state.author_prior_cache.get` is exactly the
    # `Callable[[frozenset[str]], Mapping[str, AuthorEngagement]]` shape
    # `rank_feed` wants — no adapter. Without it, `_author_priors` calls
    # `author_engagement(...)` fresh on every request, which EXCEEDS the live
    # 15s statement timeout for a realistic candidate pool (measured: 150 busy
    # authors -> QueryCanceled at 16.1s). With it, that same lookup is 0.042ms.
    #
    # A miss degrades to the post's own engagement — the documented pre-existing
    # behaviour — and the cache counts and logs misses and reports them on
    # /health, because that degradation silently moves ~80% of the composite.
    try:
        # ★★★ SEEN-POST SUPPRESSION — the one read, taken here and injected, not
        # taken inside `rank_feed` (2026-08-15). Keeping the ranker free of I/O is
        # what makes the rule reproducible offline and what stops a database
        # outage from changing a ranking decision by anything except HOW MUCH is
        # suppressed.
        #
        # ★ GATED ON THE FEATURE FLAG so that with `RECSYS_SEEN_SUPPRESSION` unset
        # (the default, contract C11) this costs ZERO round trips — not a query
        # whose result is then discarded. `fetch_seen` itself never raises and
        # returns {} on an absent DSN or an unreachable store, and {} means
        # "suppress nothing", so every degrade lands on the pre-suppression feed.
        seen = (
            fetch_seen(
                state.settings.lite,
                account,
                window_days=state.settings.seen.window_days,
            )
            if state.settings.seen.enabled
            else {}
        )
        scored = rank_feed(
            viewer,
            state.gateway,
            norm,
            now=now,
            settings=state.settings,
            snapshot=snapshot,
            trust_policy=TrustPolicy.FAIL_CLOSED,
            author_prior_cache=state.author_prior_cache.get,
            serve_log=state.serve_log,
            seen=seen,
            serve_limit=serve_limit,
        )
    except MissingTrustError as exc:
        # ★★ B5 (2026-08-05) — THIS PATH USED TO BE COMPLETELY SILENT. Compare
        # the generic handler below, which documents `exc_info=True`: a stale or
        # absent trust snapshot took down every single request while writing
        # nothing to the server log at all, so the only evidence an operator had
        # was client-side 503s. Logged at ERROR because under FAIL_CLOSED this
        # is a total outage, not a degraded mode.
        logger.error(
            "feed: REFUSING every request — trust snapshot absent or stale "
            "(viewer=%s): %s. The weekly trust batch has probably stopped "
            "running; /health now reports status=degraded for this.",
            account,
            exc,
        )
        raise FeedUnavailableError("trust_unavailable", str(exc)) from exc
    except ValueError as exc:
        raise FeedUnavailableError(
            "norm_unavailable",
            str(exc),
            norm_samples={
                "vote_signal": len(norm.vote_signal_samples),
                "reputation": len(norm.reputation_samples),
                "organic": len(norm.organic_samples),
            },
        ) from exc
    except Exception as exc:
        # ★ OPERATIONAL FINDING (2026-08-04, found running this service for
        # real against the live mirror, including containerized). `rank_feed`
        # -> `_author_priors` -> `HafsqlClient.author_engagement` (both files
        # this builder does not own) queries `hafsql.comments` filtered by
        # the FULL candidate-author set, and cost scales with that set's
        # size. Live-measured: ~0.5-1s for 3 authors, but a real, ordinary,
        # well-followed account (1,731 follows) hit the 15s statement timeout
        # — reproduced repeatedly running this exact service in a real Docker
        # container against the real mirror (`psycopg.errors.QueryCanceled`
        # inside `author_engagement`). This is NOT a bug this module
        # introduced — `rank_feed` had no production caller before A10 — but
        # A10 is what makes it a REQUEST a real viewer can trigger, so it
        # gets handled here rather than left as a stack trace. A DB timeout
        # deep in the gateway is an operational, likely-transient condition —
        # the same posture `MissingTrustError` already gets (503, not 500) —
        # not evidence of a bug in the ranking logic itself. Full traceback
        # still goes to the server log (`exc_info=True`) so it stays
        # diagnosable; only the HTTP-facing classification changes. Report:
        # `author_engagement`'s query likely needs either a narrower author
        # set, a dedicated shorter timeout, or an index — out of this
        # builder's file ownership to fix directly.
        logger.error(
            "build_feed: unexpected error from the gateway while ranking for "
            "viewer=%s — treating as an operational/upstream condition (503), "
            "not an application bug (500). See traceback.",
            account,
            exc_info=True,
        )
        raise FeedUnavailableError("upstream_error", f"{type(exc).__name__}: {exc}") from exc

    return FeedResult(account=account, now=now, viewer=viewer, scored=scored)


def serialize_scored(scored: ScoredCandidate) -> dict[str, Any]:
    return {
        "key": scored.post.key,
        "author": scored.post.author,
        "permlink": scored.post.permlink,
        # ★ CHAIN IDENTITY (2026-08-06) — required to make this feed RENDERABLE.
        #
        # For a Lumen Lite post, `author` above is the writer's `lumen_user_id`
        # (a ULID) — the RANKED identity, which is the whole point of the lite
        # substitution. But a consumer cannot fetch `@01KZAC…/permlink` from
        # Hive, because on chain the post belongs to the shared publisher
        # account. Without this field the frontend can rank lite posts and then
        # fail to display them, which is the worst of both.
        #
        # `None` for every ordinary Hive post, meaning "same as author" — see
        # `Post.chain_author`. Consumers hydrate from `chain_author or author`.
        "chain_author": scored.post.chain_author,
        "category": scored.post.category,
        "created": scored.post.created.isoformat(),
        "source": scored.source.value,
        # ★★★ THE RESURRECTION BASELINE (2026-08-15) — distinct NON-LITE engagers
        # this post carries right now.
        #
        # It is emitted so the frontend can record it ALONGSIDE the impression:
        # seen-suppression resurrects a post on `E_now - engagers_at_last_serve`,
        # and without a baseline captured AT SERVE TIME that rule is not strict,
        # it is UNMEASURABLE. There is nowhere else it can be captured — recsys
        # is the only party that computes it and the frontend is the only party
        # that knows a page was delivered.
        #
        # ★ WHY NOT `score.final`, which is already carried end to end. Because
        # `final` is a PERCENTILE RANK against a `NormContext` rebuilt from a
        # rolling window, so a post's `final` moves when OTHER posts change.
        # "Growth" measured on it would fire on other people's activity. A rule
        # that resurrects on a number whose denominator moves is not measuring
        # the post. This is a raw count, monotone inside the window, viewer-
        # independent, and — because lite votes are excluded — not mintable by
        # free identities.
        "engagers": len(post_engagers(scored.post)),
        "score": {
            "vote_norm": scored.score.vote_norm,
            "rep_norm": scored.score.rep_norm,
            "organic": scored.score.organic,
            "final": scored.score.final,
        },
    }


def serialize_feed(result: FeedResult) -> dict[str, Any]:
    return {
        "viewer": result.account,
        "generated_at": result.now.isoformat(),
        "count": len(result.scored),
        "posts": [serialize_scored(sc) for sc in result.scored],
    }


def health_payload(state: ServiceState) -> dict[str, Any]:
    """A10.3 — snapshot age, norm sample counts, pool stats, and the two
    counters `pipeline.py` already exposes for exactly this
    (`TRUST_DEGRADATION`, `ALS_DRIFT_REJECTIONS`) — wired, not reinvented."""
    norm = state.norm_cache.value
    snapshot = state.snapshot_cache.value
    author_prior_stats = state.author_prior_cache.stats()
    # ★ B5 (2026-08-05) — the SAME clock the request path uses
    # (`build_feed` -> `state.now_fn()`), not a second independent
    # `datetime.now(UTC)`. Now that `/health` reports whether trust is fresh,
    # judging freshness on a different clock from the one `rank_feed` gates on
    # would let health and serving disagree — which is precisely the failure
    # this task exists to remove. In production they are the same wall clock;
    # the difference is that this is now deterministically testable.
    now = state.now_fn()

    snapshot_age_days = None
    if snapshot is not None and snapshot.built_at is not None:
        snapshot_age_days = (now - snapshot.built_at).total_seconds() / 86400.0

    pool_connections_opened = None
    with contextlib.suppress(Exception):
        # defensive: `_pool` is another builder's private implementation detail.
        pool_connections_opened = state.gateway._pool.connections_opened

    # ★★★ B5 (2026-08-05) — `/health` MUST REFLECT WHETHER /feed CAN ACTUALLY
    # SERVE. It previously computed `status` from the NORM ALONE and never
    # looked at the snapshot, so the documented worst case was: the weekly batch
    # stops running, `max_snapshot_age_days` (14) elapses, EVERY /feed request
    # 503s under FAIL_CLOSED — and `/health` still returned `"ok"`, the
    # `wget --spider` container healthcheck still passed, and the refusal path
    # logged nothing. A total outage that nothing alerts on, for two weeks
    # before it even begins.
    #
    # `_trust_is_fresh` is the SAME predicate `rank_feed` gates on, called with
    # the same `max_snapshot_age_days`, deliberately reused rather than
    # reimplemented — a second copy of this rule would be free to drift from the
    # one that actually decides whether requests succeed.
    trust_fresh = _trust_is_fresh(
        snapshot, now=now, max_age_days=state.settings.trust.max_snapshot_age_days
    )
    if norm is None:
        status = "starting"
    elif snapshot is None:
        # ★★★ PUNCH LIST #4 (2026-08-05). A snapshot that has NEVER existed is a
        # COLD START; one that exists and has gone stale is DEGRADATION. Both
        # refuse to serve, but they are different operational facts and the
        # container healthcheck has to tell them apart — collapsed into
        # "degraded", every first deploy reported UNHEALTHY forever, because the
        # weekly batch is deliberately unscheduled in the shipped compose file.
        # An operator seeing "degraded" on a fresh install looks for a fault
        # that is not there; what they need to be told is "run the batch".
        status = "starting"
    elif not trust_fresh:
        # Not "ok": under FAIL_CLOSED this state serves NOTHING.
        status = "degraded"
    else:
        status = "ok"

    return {
        # A10.4 — whole-site cold start is a GLOBAL gate (norm.min_samples):
        # below it every viewer gets nothing. Reported explicitly here so
        # that state is diagnosable in one look, not as a wall of 503s.
        "status": status,
        #: True only when a real request would succeed. An orchestrator should
        #: gate readiness on THIS, not on the process being alive.
        "serving": status == "ok",
        #: ★ Why it is not serving, in one word an operator can act on:
        #: `starting` -> warm up or run the trust batch; `degraded` -> the batch
        #: has stopped running and the snapshot has aged out.
        "not_serving_reason": None if status == "ok" else status,
        "norm": {
            "present": norm is not None,
            "vote_signal_samples": len(norm.vote_signal_samples) if norm else 0,
            "reputation_samples": len(norm.reputation_samples) if norm else 0,
            "organic_samples": len(norm.organic_samples) if norm else 0,
            "min_samples": state.settings.norm.min_samples,
            "last_built": (
                state.norm_cache.last_built_wall.isoformat()
                if state.norm_cache.last_built_wall
                else None
            ),
            "age_s": state.norm_cache.age_s,
            "refresh_s": state.config.norm_refresh_s,
            "build_count": state.norm_cache.build_count,
            "build_failures": state.norm_cache.build_failures,
        },
        "trust_snapshot": {
            "present": snapshot is not None,
            "built_at": (
                snapshot.built_at.isoformat() if snapshot and snapshot.built_at else None
            ),
            "age_days": snapshot_age_days,
            "max_age_days": state.settings.trust.max_snapshot_age_days,
            # B5: the decisive field. `present` was true for a six-month-old
            # snapshot too, which is why `present` alone was never a health
            # signal. `fresh` is what `rank_feed` actually gates on.
            "fresh": trust_fresh,
            "degraded": snapshot.degraded if snapshot is not None else None,
            "graph_creds": len(snapshot.graph_creds) if snapshot is not None else 0,
            "last_refresh_attempt": (
                state.snapshot_cache.last_built_wall.isoformat()
                if state.snapshot_cache.last_built_wall
                else None
            ),
            "refresh_s": state.config.snapshot_refresh_s,
            "build_count": state.snapshot_cache.build_count,
            "build_failures": state.snapshot_cache.build_failures,
        },
        "viewer_cache": {"entries": len(state.viewer_cache)},
        # ★ CORRECTED 2026-08-05 (B5). This comment used to say the prior cache
        # was "NOT YET READ by `build_feed`" — stale since 2026-08-04, when it
        # was wired (see the `★ WIRED` note at the `rank_feed` call site, which
        # passes `state.author_prior_cache.get`). The 2026-08-05 council flagged
        # the contradiction: two comments in one file disagreeing about the same
        # fact, with the false one reaching the reader first. `authors_hit`/
        # `authors_missed`/`miss_rate` are LIVE and meaningful now, and a rising
        # miss rate matters — a miss silently swaps ~80% of the composite for
        # the post's own engagement.
        "author_prior_cache": {
            "authors_cached": author_prior_stats.authors_cached,
            "last_built": (
                author_prior_stats.last_built_wall.isoformat()
                if author_prior_stats.last_built_wall
                else None
            ),
            "age_s": author_prior_stats.age_s,
            "refresh_s": author_prior_stats.refresh_s,
            "build_count": author_prior_stats.build_count,
            "build_failures": author_prior_stats.build_failures,
            "authors_requested": author_prior_stats.authors_requested,
            "authors_hit": author_prior_stats.authors_hit,
            "authors_missed": author_prior_stats.authors_missed,
            "miss_rate": author_prior_stats.miss_rate,
        },
        "pool": {"connections_opened": pool_connections_opened},
        "counters": {
            "trust_degradation": TRUST_DEGRADATION.count,
            "als_drift_rejections": ALS_DRIFT_REJECTIONS.count,
        },
    }


# ---------------------------------------------------------------------------
# HTTP layer — thin. All decisions above are already made by build_feed/
# health_payload; this just routes and serializes.
# ---------------------------------------------------------------------------


class _RateLimiter:
    """Fixed-window request counter, keyed by client address.

    B4c (2026-08-05). Deliberately the simplest thing that bounds abuse: a
    sliding window or token bucket would be more elegant and is not what this
    service is missing. Memory is bounded by pruning windows older than the
    current one on every check, so an attacker cycling source addresses cannot
    grow the dict without bound the way a never-evicted cache would.
    """

    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._lock = threading.Lock()
        self._counts: dict[tuple[str, int], int] = {}

    def allow(self, client: str, now_s: float) -> bool:
        if self._per_minute <= 0:
            return True
        window = int(now_s // 60)
        with self._lock:
            for key in [k for k in self._counts if k[1] != window]:
                del self._counts[key]
            key = (client, window)
            count = self._counts.get(key, 0) + 1
            self._counts[key] = count
            return count <= self._per_minute


class _FeedHTTPServer(ThreadingHTTPServer):
    """Carries `state` on the SERVER object (not the per-connection handler)
    — the standard `http.server` pattern for sharing state across handler
    instances without a module-level global."""

    daemon_threads = True

    def __init__(
        self, server_address: tuple[str, int], handler_cls: type[BaseHTTPRequestHandler],
        state: ServiceState,
    ) -> None:
        self.state = state
        # B4c: shared across handler instances, like `state` itself.
        self.rate_limiter = _RateLimiter(state.config.rate_limit_per_minute)
        self.inflight = threading.BoundedSemaphore(
            max(1, state.config.max_concurrent_requests)
        )
        super().__init__(server_address, handler_cls)


class FeedRequestHandler(BaseHTTPRequestHandler):
    server: _FeedHTTPServer  # narrows self.server's type for readability
    server_version = "recsys-feed/0.1"

    @property
    def state(self) -> ServiceState:
        return self.server.state

    def log_message(self, format: str, *args: Any) -> None:
        logger.info("%s - %s", self.address_string(), format % args)

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def setup(self) -> None:
        # B4c: bound how long one connection may hold a thread. Applied AFTER
        # `super().setup()` — `self.connection` does not exist until
        # `StreamRequestHandler.setup()` assigns it from `self.request`, and the
        # socket timeout still governs every read through the `rfile` it builds.
        # (`BaseHTTPRequestHandler.timeout` is a ClassVar and cannot carry a
        # per-instance, config-driven value, which is why this sets the socket.)
        super().setup()
        self.connection.settimeout(self.state.config.request_read_timeout_s)

    def _client_identity(self) -> str:
        """The address the rate limiter counts against.

        ★ Punch list #3. `X-Forwarded-For` is only consulted when the operator
        has declared how many proxies they run (`trusted_proxy_hops`), and then
        only at the position those proxies control — counting from the RIGHT.
        Everything to the left of that is client-supplied and forgeable; a
        limiter keyed on a forgeable value is not a limiter.

        ★ B10. And only when the request actually CAME from one of those
        proxies (`trusted_proxy_peers`) — see the comment below and the field's
        own docstring.
        """
        hops = self.state.config.trusted_proxy_hops
        peer = self.client_address[0]
        if hops <= 0:
            return peer
        # ★★★ B10 (2026-08-06 QA) — AND THE REQUEST MUST HAVE COME THROUGH THEM.
        # `hops > 0` said "there are N proxies in front of me"; nothing checked
        # that THIS request arrived via one. A caller reaching the port directly
        # supplied the entire chain, including `chain[-hops]`, and got a fresh
        # rate-limit bucket per request — the limiter, which is the only thing
        # bounding load onto a shared third-party mirror, silently stopped
        # existing. The peer address is the one property of a request no header
        # can rewrite, so it is what decides whether the header is heard at all.
        # An untrusted peer is treated exactly as `hops=0`: judged on its own
        # address, header ignored.
        if not _peer_is_trusted_proxy(peer, self.state.config.trusted_proxy_peers):
            return peer
        # ★★★ ROUND-5 COUNCIL (Seat 3): `.get()` returns only the FIRST
        # occurrence, and a client may send `X-Forwarded-For` on several header
        # lines. RFC 7230 §3.2.2 says repeated fields are equivalent to one
        # comma-joined field, so reading the first alone lets a client SHORTEN
        # the chain it is judged on — sending its own header line first pushes
        # the proxy's real entry into a second line this code never saw.
        forwarded = ", ".join(self.headers.get_all("X-Forwarded-For") or [])
        chain = [part.strip() for part in forwarded.split(",") if part.strip()]
        if len(chain) < hops:
            # Fewer hops than declared: the request did not come through the
            # expected proxy chain. Fall back to the peer address rather than
            # trusting a short (and therefore forged) header.
            return peer
        return chain[-hops]

    def _authorized(self) -> bool:
        """Constant-time bearer check. `secrets.compare_digest`, never `==` —
        a byte-wise early-exit comparison on a shared secret is a timing oracle
        (this project's own checklist item)."""
        expected = self.state.config.api_token
        if not expected:
            return True  # auth disabled; `main()` refuses this in production
        header = self.headers.get("Authorization", "")
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer":
            return False
        # ★★ 2026-08-05 POST-CLOSEOUT COUNCIL (Seat 3, verified). `compare_digest`
        # on `str` raises TypeError the moment either side contains a non-ASCII
        # character, and this runs on UNAUTHENTICATED, attacker-supplied input:
        # one request with an accented byte in the header crashed the handler.
        # Comparing BYTES has no such restriction and is the documented use of
        # this primitive. `surrogateescape` keeps any undecodable byte sequence
        # a comparison rather than a second exception — the header arrives as
        # latin-1-decoded text from http.client, so a raw byte can survive here.
        # ★★ ROUND-3 COUNCIL (Seat 2, verified): the first version of this fix
        # stopped the crash and made a LEGITIMATE non-ASCII token impossible to
        # authenticate. `http.client` decodes header bytes as LATIN-1, while the
        # environment decodes the configured token as UTF-8, so encoding the
        # header back as UTF-8 compared two different byte strings and the
        # correct token got a 401. The original test asserted 401 — identical to
        # a wrong token — so it passed in both worlds.
        #
        # Latin-1 round-trips the bytes the client actually sent, so this is an
        # exact comparison for every ASCII token (which is all of them:
        # `secrets.token_urlsafe` is ASCII by construction, and `main()` now
        # REFUSES a non-ASCII token at startup rather than shipping one that can
        # never authenticate).
        presented_bytes = presented.strip().encode("latin-1", "replace")
        return secrets.compare_digest(presented_bytes, expected.encode("latin-1", "replace"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        # /health is deliberately UNAUTHENTICATED and un-throttled: container
        # healthchecks and load balancers must reach it without credentials,
        # and it exposes counters only, never feed content.
        if parsed.path == "/health":
            self._write_json(200, health_payload(self.state))
            return
        if parsed.path == "/feed":
            # ★★ 2026-08-05 POST-CLOSEOUT COUNCIL (Seat 3, verified). The rate
            # limiter used to run AFTER the auth check, so wrong-token traffic
            # was unthrottled: 40 bad tokens produced 40 x 401 and 0 x 429. An
            # unauthenticated client could therefore spend the server's threads
            # for free, which is exactly what the limiter exists to stop.
            # Throttle FIRST, on the one identifier available before auth (the
            # peer address), then authenticate.
            if not self.server.rate_limiter.allow(self._client_identity(), time.time()):
                self._write_json(429, {"error": "rate_limited"})
                return
            if not self._authorized():
                # No detail: a 401 that distinguishes "no token" from "wrong
                # token" is a probing aid and buys the operator nothing.
                self._write_json(401, {"error": "unauthorized"})
                return
            if not self.server.inflight.acquire(blocking=False):
                # Shed rather than queue: queueing converts a burst into a
                # thread pile-up behind a bounded connection pool.
                self._write_json(503, {"error": "overloaded"})
                return
            try:
                self._handle_feed(parsed)
            finally:
                self.server.inflight.release()
            return
        self._write_json(404, {"error": "not_found"})

    def _handle_feed(self, parsed: ParseResult) -> None:
        qs = parse_qs(parsed.query)
        viewers = qs.get("viewer")
        if not viewers or not viewers[0]:
            self._write_json(
                400,
                {"error": "bad_request", "detail": "missing required 'viewer' query parameter"},
            )
            return
        account = viewers[0]
        if not _valid_account(account):
            self._write_json(
                400,
                {
                    "error": "bad_request",
                    "detail": (
                        "'viewer' is neither a plausible Hive account name nor a "
                        "Lumen Lite identity"
                    ),
                },
            )
            return
        # ★ B3 (2026-08-05). `tags` carries the signup interest picks (spec D3);
        # `follows` carries a lite viewer's Lumen-side follow graph. Both are
        # comma-separated. An ABSENT parameter is None ("derive it / ask the
        # chain"); a PRESENT but empty one is an empty set ("supplied, and the
        # viewer genuinely has none") — the same distinction
        # `build_viewer_profile` documents, and the reason this parses with an
        # explicit `in qs` check rather than a falsy one.
        explicit_tags = _csv_param(qs, "tags")
        explicit_follows = _csv_param(qs, "follows")
        # ★ Launch punch list #2: `mutes` is parsed on the same terms as the
        # other two — ABSENT means "derive it / ask the chain", PRESENT-but-empty
        # means "supplied, and the viewer genuinely mutes nobody".
        explicit_mutes = _csv_param(qs, "mutes")
        # ★ B4c — `limit` was PARSED NOWHERE and silently ignored, so every
        # caller got the full ranked page regardless of what it asked for.
        limit = _int_param(qs, "limit")
        if limit is not None and limit <= 0:
            self._write_json(
                400, {"error": "bad_request", "detail": "'limit' must be a positive integer"}
            )
            return
        try:
            result = build_feed(
                self.state,
                account,
                explicit_interest_tags=explicit_tags,
                explicit_follows=explicit_follows,
                explicit_mutes=explicit_mutes,
                # ★★★ THE SAME `limit` THAT SLICES THE PAYLOAD BELOW NOW ALSO
                # REACHES THE RANKER (2026-08-15). Until this line it did not:
                # it was parsed here and applied only at `payload["posts"][:limit]`
                # after `build_feed` had returned, with the comment "`count`
                # documents the payload, not the ranking" — so the ranker could
                # not express any rule about the served page, and the
                # seen-suppression starvation floor had nothing to floor ON.
                #
                # ONE parse, ONE meaning, BOTH consumers: the floor here and the
                # payload slice below read the identical number, so they cannot
                # drift. `None` stays `None` — "unknown depth", which floors on
                # `min_feed_size` alone and slices nothing.
                serve_limit=limit,
            )
        except FeedUnavailableError as exc:
            # R8: MissingTrustError -> 503, never 500 — "trust is stale/absent" is
            # an operational state with a fix, not a bug.
            #
            # ★ B4c — `exc.detail` is built from `str(exc)` on the underlying
            # error, which for a driver failure carries the upstream DB HOST AND
            # PORT. That reached the client verbatim. The full text still goes to
            # the server log; only the client-facing body is now generic.
            logger.warning("feed: unavailable for viewer=%s: %s: %s", account, exc.kind, exc.detail)
            body: dict[str, Any] = {"error": exc.kind}
            if exc.norm_samples is not None:
                body["norm_samples"] = exc.norm_samples
            self._write_json(503, body)
            return
        except Exception:
            logger.exception("feed: unexpected error ranking for viewer=%s", account)
            self._write_json(500, {"error": "internal_error"})
            return
        payload = serialize_feed(result)
        if limit is not None:
            payload["posts"] = payload["posts"][:limit]
            # `count` documents the payload, not the ranking — leaving it at the
            # full length would make the two fields disagree.
            payload["count"] = len(payload["posts"])
        self._write_json(200, payload)


def make_server(state: ServiceState) -> _FeedHTTPServer:
    return _FeedHTTPServer((state.config.host, state.config.port), FeedRequestHandler, state)


def require_ascii_api_token(token: str | None) -> None:
    """Refuse a non-ASCII bearer token at STARTUP rather than at every request.

    ★★ ROUND-3 COUNCIL (Seat 2). HTTP header bytes arrive latin-1-decoded while
    the environment decodes this token as UTF-8, so a non-ASCII token cannot be
    compared unambiguously — the first version of the crash fix silently made
    such a token IMPOSSIBLE to authenticate with, and its test asserted 401,
    which is exactly what a WRONG token gets, so it passed in both worlds.

    Rather than guess an encoding on the wire, the configuration is refused.
    Every real token is ASCII (`secrets.token_urlsafe` is ASCII by
    construction), so this rejects nothing an operator would legitimately
    choose.

    A free function, not inline in `main()`, for a test-design reason worth
    recording: the first version of its gate called `main()` itself, which
    builds state and WARMS CACHES AGAINST THE LIVE MIRROR. Inside the full
    suite it inherited another test's environment, missed the raise, and spent
    168 seconds booting a real service. A validation rule must be testable
    without starting a server.
    """
    if token and not token.isascii():
        raise ValueError(
            "RECSYS_API_TOKEN contains non-ASCII characters. HTTP headers are "
            "transmitted as bytes and decoded latin-1 by the server, so such a "
            "token cannot be matched reliably and would reject every request. "
            'Generate an ASCII token: `python -c "import secrets; '
            'print(secrets.token_urlsafe(32))"`.'
        )


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("RECSYS_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # ★★ PRODUCTION SETTINGS COME FROM THE ENVIRONMENT, NOT `DEFAULT_SETTINGS`
    # (2026-08-04). `Settings.from_env(production=True)` is what reads
    # `LUMEN_EXPLORE_SEAT_SECRET` and REFUSES to start without it.
    #
    # This call site is the whole point of that machinery. The keyed MAC on the
    # reserved new-author seat exists because the unkeyed version was grindable:
    # 6 offline-ground account names took 85% of the seat platform-wide, with no
    # votes and nothing ring-flagged. `from_env` was built and tested, and for a
    # while NOTHING CALLED IT — the capability existed and was unreachable, which
    # is the same defect class as a config that validates a contract it never
    # applies. A service that boots on `DEFAULT_SETTINGS` boots with the critical
    # still open and no warning.
    #
    # `RECSYS_PRODUCTION=0` opts out for local runs; anything else fails shut.
    production = os.environ.get("RECSYS_PRODUCTION", "1") != "0"
    settings = Settings.from_env(production=production)
    if not production:
        logger.warning(
            "recsys.service.app: RECSYS_PRODUCTION=0 — running with the fixed "
            "dev seat key and no fail-shut. Never serve real users this way."
        )
    # ★★ B4c (2026-08-05) — REFUSE TO SERVE UNAUTHENTICATED IN PRODUCTION.
    # Same posture as the seat secret directly above: a control that is
    # optional-by-default is a control nobody sets. `/feed?viewer=<anyone>`
    # returns any account's ranked feed plus the full score decomposition, in
    # front of a bounded-but-finite pool pointed at a SHARED third-party mirror,
    # so an open instance is both a data-exposure and an abuse-amplification
    # problem for someone else's database.
    service_config = ServiceConfig.from_env()
    if production and not service_config.api_token:
        raise ValueError(
            "RECSYS_API_TOKEN is required when RECSYS_PRODUCTION is on: /feed would "
            "otherwise be open to the internet. Generate one with "
            '`python -c "import secrets; print(secrets.token_urlsafe(32))"`, or set '
            "RECSYS_PRODUCTION=0 for a local run."
        )
    # ★★ ROUND-3 COUNCIL (Seat 2). HTTP header bytes arrive latin-1-decoded
    # while the environment decodes this token as UTF-8, so a non-ASCII token
    # cannot be compared unambiguously — the first version of the crash fix
    # silently made such a token IMPOSSIBLE to authenticate with, and its test
    # could not tell that apart from a wrong token. Rather than guess an
    # encoding on the wire, refuse the configuration: every real token is ASCII
    # (`secrets.token_urlsafe` is ASCII by construction), so this rejects
    # nothing an operator would legitimately choose, and it fails LOUDLY at
    # startup instead of at every request.
    require_ascii_api_token(service_config.api_token)
    if not service_config.api_token:
        logger.warning(
            "recsys.service.app: no RECSYS_API_TOKEN — /feed is UNAUTHENTICATED. "
            "Local runs only."
        )
    state = ServiceState.build(settings=settings, config=service_config)
    state.warm()
    state.start_background_refresh()
    server = make_server(state)
    logger.info(
        "recsys.service.app: listening on %s:%d", state.config.host, state.config.port
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        state.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "FeedRequestHandler",
    "FeedResult",
    "FeedUnavailableError",
    "ServiceConfig",
    "ServiceState",
    "build_feed",
    "health_payload",
    "main",
    "make_server",
    "serialize_feed",
    "serialize_scored",
]
