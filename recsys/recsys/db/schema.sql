-- recsys Phase-0 schema (own Postgres + pgvector).
-- Mirrors DISCOVERY-RANKING-BUILD-PLAN.md Appendix C, expanded with the
-- Thunder post index (§7), second-degree engager index (§8.1), ring
-- membership (§8.5), and network suppression (§8.7).

CREATE EXTENSION IF NOT EXISTS vector;

-- Viewer interest profile: seeded by cold-start interest selection (rev 2.2),
-- refined by telemetry (Phase 1).
CREATE TABLE IF NOT EXISTS viewer_profile (
    account         text PRIMARY KEY,
    interest_vec    vector(384),
    top_categories  text[]      NOT NULL DEFAULT '{}',
    top_communities text[]      NOT NULL DEFAULT '{}',
    is_new          boolean     NOT NULL DEFAULT true,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Collaborative-filtering latent factors (ALS, §6.1).
CREATE TABLE IF NOT EXISTS cf_factors (
    entity_type   text        NOT NULL,   -- 'user' | 'author' | 'community'
    entity_id     text        NOT NULL,
    factors       vector(64)  NOT NULL,
    model_version text        NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_type, entity_id, model_version)
);

-- Graph-cred (§8.3): engagement-weighted follow-graph PageRank, weekly.
-- ``outside_engaged`` (H02) MUST be persisted and reloaded with the snapshot:
-- ``_voter_trust_from_creds`` (recsys/pipeline.py) gates the vouched tier on it
-- (``GraphCred.outside_engaged``, contracts.py). Without this column a persisted
-- snapshot round-trips every reloaded GraphCred to the dataclass default
-- (outside_engaged=False), emptying the vouched set network-wide and dropping
-- every genuinely-vouched account to unknown-tier breadth budgeting. Wire the
-- persist/load of this column together with the F-R2 persistence layer.
CREATE TABLE IF NOT EXISTS graph_cred (
    account               text             PRIMARY KEY,
    score                 double precision NOT NULL,
    follow_follower_ratio double precision NOT NULL,
    outside_engaged       boolean          NOT NULL DEFAULT false,
    computed_at           timestamptz      NOT NULL DEFAULT now()
);

-- recsys's own "Thunder" post index (§7): recent posts by author/community.
CREATE TABLE IF NOT EXISTS post_index (
    author    text        NOT NULL,
    permlink  text        NOT NULL,
    community text,
    category  text        NOT NULL,
    created   timestamptz NOT NULL,
    is_short  boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (author, permlink)
);
CREATE INDEX IF NOT EXISTS post_index_author_created ON post_index (author, created DESC);
CREATE INDEX IF NOT EXISTS post_index_community_created ON post_index (community, created DESC);

-- Second-degree engager index (§8.1): which in-network account engaged an OON post.
CREATE TABLE IF NOT EXISTS second_degree_engager (
    author   text NOT NULL,
    permlink text NOT NULL,
    engager  text NOT NULL,
    kind     text NOT NULL,   -- 'vote' | 'reply' | 'reblog'
    PRIMARY KEY (author, permlink, engager, kind)
);
CREATE INDEX IF NOT EXISTS second_degree_engager_by_post ON second_degree_engager (author, permlink);

-- Soft vote-ring membership (§8.5) — never a hard ban.
CREATE TABLE IF NOT EXISTS ring_membership (
    account     text PRIMARY KEY,
    ring_score  double precision NOT NULL,
    ring_id     integer,
    computed_at timestamptz NOT NULL DEFAULT now()
);

-- Network-wide report suppression (§8.7) — a filter, not a grey-out.
CREATE TABLE IF NOT EXISTS network_suppression (
    author     text NOT NULL,
    permlink   text NOT NULL,
    suppressed boolean NOT NULL DEFAULT false,
    flag_score double precision NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (author, permlink)
);
