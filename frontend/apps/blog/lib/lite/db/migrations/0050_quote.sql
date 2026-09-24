-- Quote reblogs ("reblog with a comment"), the index (2026-09-24, spec v2 section 7.1).
--
-- A quote is a real Hive comment under a `lumen-q-` container (migration 0049): the
-- chain is the source of truth for its text. This table is how Lumen FINDS a person's
-- quote on a post quickly (feed and profile cards ask "which of these (reblogger,
-- post) pairs have a live quote" in one query), and what moderation acts on.
--
-- One row per (quoter, target post) while it exists: `ux_quote_live`. The quoter is a
-- Lumen id OR a Hive name, never both (`ck_one_quoter`), keyed the same way blocks,
-- follows and DMs are (`u:<id>` / `h:<name>`, migration 0030), so a rename or an
-- upgrade never re-attributes a quote.
--
-- state: pending = a lite quote queued for the publisher (or a Hive quote not yet
-- verified on chain); live = verified on chain; removed = deleted or blanked by its
-- writer (or its reblog was undone); hidden = hidden by moderation.

CREATE TABLE IF NOT EXISTS lumen_quote (
  quote_id           TEXT PRIMARY KEY,
  quoter_user_id     TEXT REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  quoter_hive        CITEXT,
  quoter_key         TEXT GENERATED ALWAYS AS (
                       COALESCE('u:' || quoter_user_id, 'h:' || lower(quoter_hive::text))
                     ) STORED,
  target_author      TEXT NOT NULL,
  target_permlink    TEXT NOT NULL,
  quote_author       TEXT NOT NULL,
  quote_permlink     TEXT NOT NULL,
  container_author   TEXT NOT NULL,
  container_permlink TEXT NOT NULL,
  lite_post_id       TEXT,
  body_cache         TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL CHECK (state IN ('pending', 'live', 'removed', 'hidden')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  seq                BIGSERIAL,
  CONSTRAINT ck_one_quoter CHECK ((quoter_user_id IS NULL) <> (quoter_hive IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_live
  ON lumen_quote (quoter_key, target_author, target_permlink)
  WHERE state IN ('pending', 'live', 'hidden');
CREATE INDEX IF NOT EXISTS ix_quote_target
  ON lumen_quote (target_author, target_permlink) WHERE state = 'live';
CREATE INDEX IF NOT EXISTS ix_quote_quoter
  ON lumen_quote (quoter_key, created_at DESC) WHERE state = 'live';
CREATE INDEX IF NOT EXISTS ix_quote_coords
  ON lumen_quote (quote_author, quote_permlink);
