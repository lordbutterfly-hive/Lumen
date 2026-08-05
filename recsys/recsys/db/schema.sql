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
--
-- ★★ AND THE BOOLEAN ALONE IS NOT ENOUGH (2026-08-04). The warning above names
-- `outside_engaged`, but seed-anchored vouch propagation walks the SET —
-- `GraphCred.outside_engagers` (contracts.py), read at pipeline.py:916 and :926
-- to decide which already-vouched account may vouch whom. That column was
-- missing entirely, so a snapshot round-tripped through this schema as written
-- would reload every set empty and collapse propagation to the seeds alone.
-- Simulated on the 180-account harness world: vouched 145 -> 12 (exactly the
-- seeds), 133 honest accounts demoted to unknown-tier breadth, and 51.5% of all
-- served top-20 slots changed — with nothing logged. `_trust_is_fresh` would
-- NOT catch it: `graph_creds` is non-empty and `degraded` is False, so
-- FAIL_CLOSED stays silent. Exactly the fail-open shape H01/F-R2 exist to close,
-- hiding inside the persistence layer their own comments live in.
--
-- LATENT, NOT LIVE: nothing in the package writes any table here (grep for
-- INSERT/UPDATE returns nothing), so this is a trap for whoever builds
-- persistence rather than a current failure. The column is added now so the
-- trap cannot be stepped in.
CREATE TABLE IF NOT EXISTS graph_cred (
    account               text             PRIMARY KEY,
    score                 double precision NOT NULL,
    follow_follower_ratio double precision NOT NULL,
    outside_engaged       boolean          NOT NULL DEFAULT false,
    -- WHO engaged this account from outside its ring/lineage. Persist and
    -- reload alongside `outside_engaged`; an empty set here is not equivalent
    -- to `outside_engaged = false`, it silently breaks vouch propagation.
    outside_engagers      text[]           NOT NULL DEFAULT '{}',
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

-- ---------------------------------------------------------------------------
-- A6 — TrustSnapshot persistence (recsys/db/store.py).
--
-- ``TrustSnapshot`` (recsys/pipeline.py) has 6 fields: ``graph_creds``,
-- ``ring_members``, ``als``, ``degraded``, ``edges``, ``trusted_seeds``.
-- ``graph_creds`` -> the ``graph_cred`` table above (already had both
-- ``outside_engaged`` AND ``outside_engagers`` before this builder touched the
-- file — see the warning comment on that table, which documents the
-- 145 -> 12 vouched-set collapse a schema missing ``outside_engagers`` causes).
-- ``ring_members`` -> reuses ``ring_membership.account`` above; ``TrustSnapshot``
-- carries only the flagged SET (no per-account ring_score/ring_id), so those
-- two columns are written with neutral placeholders (ring_score = 0.0,
-- ring_id = NULL) on save and simply ignored on load — nothing round-trips
-- through them that ``TrustSnapshot`` ever had, so this is not a lossy reuse.
-- The three tables below are net-new, one per remaining field.
--
-- SINGLETON, NOT VERSIONED: all four tables here (this one, ``als_model``,
-- ``trust_snapshot_edge``, plus ``graph_cred``/``ring_membership`` above) hold
-- only the LATEST snapshot — the one a serving process should load. The
-- weekly batch (recsys/jobs/trust_batch.py) reads the current row(s) as
-- ``previous=`` BEFORE overwriting them with the freshly-built snapshot, so
-- the §H11 between-batch ALS-drift gate always has last week's model to
-- compare against. A degraded or empty freshly-built snapshot must never
-- overwrite a good one — enforced in ``recsys/db/store.py::save_snapshot``,
-- not here; SQL has no way to express "refuse silently corrupt input".
CREATE TABLE IF NOT EXISTS trust_snapshot_meta (
    id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- TrustSnapshot itself has NO timestamp field today (A8.3, pipeline.py —
    -- not this builder's file to edit). Carried alongside here so staleness
    -- (`_trust_is_fresh` today checks only present/not-degraded/non-empty,
    -- NOT age) can be computed by whoever wires the fourth clause. See
    -- recsys/db/store.py's module docstring for the exact dataclass change
    -- this is standing in for.
    built_at      timestamptz NOT NULL,
    degraded      boolean NOT NULL DEFAULT false,
    trusted_seeds text[] NOT NULL DEFAULT '{}'
);

-- Trained ALS factors (§6.1), persisted alongside the snapshot. NOT the
-- "cheap to skip, recompute later" field the A6.4 buildmap note suggested for
-- this whole unit -- ``ALSConfig.cf_weight`` defaults to 1.5 (a GATE, not a
-- magnitude: any positive value turns CF on) and ``ScoreWeights.organic_cf``
-- feeds it straight into the live 80% organic term (pipeline.py `_score`,
-- `viewer_affinity_percentiles`). Dropping this field silently on reload
-- would turn off a currently-active scoring signal for every request served
-- from a persisted snapshot -- the same silent-degradation shape the
-- `outside_engagers` warning above exists to prevent, just for CF instead of
-- the vouch gate. So it is persisted in full, exactly like everything else.
--
-- Factor matrices are stored as raw float64 bytes (C-contiguous
-- ``ndarray.tobytes()``/``np.frombuffer``), not JSON arrays, to keep a
-- (thousands-of-rows x ``factors_k``) matrix cheap to round-trip; row counts
-- are recovered from ``len(bytes) / (8 * factors_k)`` and cross-checked
-- against ``len(user_index)``/``len(item_index)`` on load (see store.py).
-- A model with no trained rows (``train_als`` on empty/all-non-positive
-- ratings returns ``(0, k)``-shaped arrays) stores zero-length bytea, not
-- NULL -- ``TrustSnapshot.als`` is `ALSModel | None`; ``als IS NULL`` in this
-- table means "no model was trained this batch" (``als=None`` on the
-- dataclass, e.g. the §H11 drift gate disabled it), which is a different,
-- deliberately-distinguished state from "model trained on zero rows".
CREATE TABLE IF NOT EXISTS als_model (
    id           integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    factors_k    integer NOT NULL,
    user_factors bytea   NOT NULL,
    item_factors bytea   NOT NULL,
    user_index   jsonb   NOT NULL,
    item_index   jsonb   NOT NULL
);

-- RealGraph engagement edges (§8.3/§6.1) this snapshot was built from.
-- Currently INERT at serving time by default (``ScoreWeights.organic_viewer =
-- 0.0`` gates the only consumer, `pipeline._viewer_affinity_lookup`) -- unlike
-- ``als_model`` above, so the A6.4 "cheap to skip and recompute" framing DOES
-- apply here today. Persisted anyway, in full, because the A6 acceptance bar
-- is round-trip fidelity, not "whatever is live right now" -- the day
-- ``organic_viewer`` is turned on, this table must already be correct rather
-- than a second migration.
--
-- ★★ OPERATOR COST FLAG (not this builder's call, see the build report): a
-- full ``trust_days = 365`` window can be tens of millions of rows (7d alone
-- measured 676,799 edges live 2026-08-04 -- BUILDMAP-A-LAUNCH-2026-08-04.md
-- A7). Every weekly batch TRUNCATEs and reloads this table in full (see
-- store.py) -- singleton-latest, not accumulated history, so it does not grow
-- unbounded across weeks, but one week's write is still a genuinely large
-- bulk load. If that proves too slow/costly in production, the sanctioned
-- fix is to stop persisting this table and make ``load_snapshot`` return
-- ``edges=()`` -- ``_viewer_affinity_lookup`` already treats empty edges as
-- "channel off" and every other consumer of a loaded snapshot is unaffected.
-- That is a product/ops call, not made here.
CREATE TABLE IF NOT EXISTS trust_snapshot_edge (
    src              text             NOT NULL,
    dst              text             NOT NULL,
    replies          integer          NOT NULL DEFAULT 0,
    reply_backs      integer          NOT NULL DEFAULT 0,
    upvotes          integer          NOT NULL DEFAULT 0,
    reblogs          integer          NOT NULL DEFAULT 0,
    mentions         integer          NOT NULL DEFAULT 0,
    profile_visits   integer          NOT NULL DEFAULT 0,
    post_opens       integer          NOT NULL DEFAULT 0,
    revisits         integer          NOT NULL DEFAULT 0,
    dwell_seconds    double precision NOT NULL DEFAULT 0,
    last_interaction timestamptz,
    PRIMARY KEY (src, dst)
);
