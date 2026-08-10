-- ★★★ THE RANKED FEED SURVIVES A RESTART (2026-08-08).
--
-- MEASURED THIS MORNING through /api/feed/for-you, cold, per viewer:
--   steevc 7.2s | melinda010100 9.3s | gtg 13.2s | lordbutterfly 16.3s
-- With RECSYS_FEED_TIMEOUT_MS=15000, `lordbutterfly` ABORTS every single time,
-- caches nothing, and is served Hive trending marked `degraded: "unavailable"`.
-- Reload and it happens again. That is not a slow feed, it is a PERMANENT TRAP:
-- there is no number of retries that gets that reader a ranked feed, which is
-- exactly why the owner reported "my logged-in feed is identical to the
-- logged-out one".
--
-- The other half of the same wound: the assembled feed was cached in an
-- in-process Map. Every deploy, every restart, every crash threw away every
-- viewer's feed, and recsys's own viewer cache expires after 300s, so the reader
-- who comes back tomorrow pays the full cold cost AGAIN. The owner's rule is
-- one sentence: "it can load once, for as long as needed... but then it cannot
-- load every time." A process-local Map cannot honour that. A table can.
--
-- WHAT IS STORED, AND WHY BOTH
--   `keys`    the ranked order as `author/permlink` — small, greppable, and the
--             thing that is actually the product. Kept separately from
--             `entries` so the order can be inspected, diffed between builds,
--             and (later) re-hydrated against fresh post content without
--             re-running the ranker.
--   `entries` the ASSEMBLED feed — full `Entry` objects, exactly what the route
--             returns. Storing keys alone would leave ~20 `bridge.get_post`
--             round-trips on the serve path, which is most of the latency this
--             table exists to delete. Instant means instant.
--
-- SIZE, MEASURED NOT GUESSED. A real 20-entry feed from this deployment is
-- 519KB of JSON; Postgres stores it TOAST-compressed at 293,793 bytes
-- (`pg_column_size`, ~51% of raw), so ~287KB per viewer at limit=20 and ~430KB
-- at the client's limit=30. That is why the bound below is a ROW CAP and not a
-- prayer: at the default 5,000-row cap this table tops out near 1.4-2.1GB,
-- against 784GB free on this box. Both bounds are tunable without a migration
-- (FEED_STORE_MAX_ROWS, FEED_STORE_TTL_DAYS) and the sweep is in
-- feed-store-repository.ts.
--
-- `viewer` is TEXT, not CITEXT. A viewer here is either a Hive account name
-- (always lower-case) or a lite ULID (always upper-case Crockford base32), and
-- the in-process cache this replaces matched them EXACTLY. Case-folding the key
-- would be a silent semantic change to identity lookup, which is not something a
-- cache table gets to do.
CREATE TABLE IF NOT EXISTS lumen_feed_store (
  viewer       TEXT PRIMARY KEY,

  -- ★ THE CHEAP INVALIDATION HOOK. The ranking weights are being changed right
  -- now (viewer-affinity is coming on), so a stored feed can go stale in
  -- CONTENT while its `built_at` still looks recent. Bumping FEED_STORE_VERSION
  -- retires every stored feed at once — no migration, no deploy coordination,
  -- no truncate. Default behaviour on a mismatch is deliberately SOFT: the old
  -- feed is still served instantly and rebuilt behind the reader, because the
  -- owner's requirement for a weight change is "those slight updates should be
  -- invisible", and a spinner is the opposite of invisible.
  feed_version TEXT NOT NULL DEFAULT '',

  -- What recsys said it ranked (`feed.count`), reported back to the client
  -- unchanged so a stored response is not quietly more confident than a fresh one.
  ranked       INTEGER NOT NULL DEFAULT 0,

  -- The `limit` this copy was BUILT for. A request for more than it holds is
  -- served from it immediately and rebuilt at the larger size in the background:
  -- a short page beats a spinner, and it self-heals after exactly one rebuild.
  built_limit  INTEGER NOT NULL DEFAULT 0,

  keys         JSONB NOT NULL DEFAULT '[]'::jsonb,
  entries      JSONB NOT NULL DEFAULT '[]'::jsonb,

  built_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweep orders by `built_at` for both the TTL cut and the row cap; without
-- this it seq-scans a table of multi-hundred-KB TOAST pointers.
CREATE INDEX IF NOT EXISTS lumen_feed_store_built_at_idx ON lumen_feed_store (built_at);

-- Only used by the OPTIONAL hard purge (FEED_STORE_PURGE_OLD_VERSIONS=yes), for
-- a weight change drastic enough that serving the previous order even once is
-- worse than making readers wait. Cheap to keep, and the alternative is a full
-- scan at exactly the moment an operator is already nervous.
CREATE INDEX IF NOT EXISTS lumen_feed_store_version_idx ON lumen_feed_store (feed_version);
