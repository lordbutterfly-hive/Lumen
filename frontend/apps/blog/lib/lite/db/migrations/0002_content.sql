-- 0002_content.sql — Phase 3: lite post content (system of record). Spec §4/§C/§E.

CREATE TABLE IF NOT EXISTS lumen_post (
  post_id               TEXT PRIMARY KEY,                 -- ULID
  user_id               TEXT NOT NULL REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  display_name_snapshot TEXT NOT NULL,                    -- immutable name at post time -> the on-chain footer
  parent_ref            JSONB,                            -- {type:'lite',id} | {type:'chain',author,permlink}; NULL = root
  tier                  TEXT NOT NULL CHECK (tier IN ('normal','advanced')),
  title                 TEXT NOT NULL DEFAULT '',
  body                  TEXT NOT NULL,
  tags                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  community             TEXT,
  beneficiaries         JSONB NOT NULL DEFAULT '[]'::jsonb,
  thumbnail_url         TEXT,
  summary               TEXT,
  feed_visibility       TEXT NOT NULL DEFAULT 'visible' CHECK (feed_visibility IN ('visible','author_only','hidden')),
  publish_mode          TEXT NOT NULL DEFAULT 'proxy' CHECK (publish_mode IN ('proxy','direct')),
  hive_author           TEXT,                             -- set at publish (frontend acct, or the user's own account)
  hive_permlink         TEXT,                             -- set at publish
  shard                 TEXT,                             -- which frontend account (sharding, §D.8)
  edit_of_post_id       TEXT REFERENCES lumen_post(post_id) ON DELETE SET NULL,
  deleted_locally       BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_lumen_post_user_created ON lumen_post (user_id, post_id DESC);
CREATE INDEX IF NOT EXISTS ix_lumen_post_feed
  ON lumen_post (post_id DESC) WHERE feed_visibility = 'visible' AND deleted_locally = false;
-- attribution resolve: (hive_author, hive_permlink) -> user_id once published (§E.1)
CREATE UNIQUE INDEX IF NOT EXISTS ux_lumen_post_hive
  ON lumen_post (hive_author, hive_permlink) WHERE hive_author IS NOT NULL AND hive_permlink IS NOT NULL;
