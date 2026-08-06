/**
 * Lite-account domain types (camelCase), mapped from the snake_case Postgres
 * rows defined in db/migrations/0001_identity.sql. Canonical schema keys are
 * fixed by LUMEN-LITE-ACCOUNTS-SPEC §4 — do not introduce naming variants.
 */

export type AccountTier = 'lite' | 'full';
export type AuthMethod = 'google_passkey' | 'btc_wallet' | 'evm_wallet';
export type ChallengePurpose = 'login' | 'post_attestation' | 'stepup';
export type UserStatus = 'active' | 'suspended' | 'upgraded' | 'banned';
export type NameReservationStatus = 'pending' | 'active';

/**
 * The editable part of a lite account's public profile. Deliberately the same field
 * names Hive uses inside `posting_json_metadata.profile`, so the rendered account
 * object and the settings form work identically for both tiers — and so the values
 * can be moved on chain unchanged if an upgraded user ever asks for that.
 */
export interface LumenProfile {
  name?: string;
  about?: string;
  location?: string;
  website?: string;
  profile_image?: string;
  cover_image?: string;
}

/** A lite (or upgraded-full) Lumen account. The `userId` is permanent. */
export interface LumenUser {
  userId: string;
  displayName: string;
  displayNameHistory: string[];
  avatarUrl: string | null;
  profile: LumenProfile;
  accountTier: AccountTier;
  /** Real on-chain account name, set only after ACT upgrade; differs from displayName. */
  hiveAccountName: string | null;
  trustScore: number;
  status: UserStatus;
  suspendedReason: string | null;
  /** Monotonic cookie-invalidation counter (F-L3): bumped on upgrade, suspend/ban and
   *  logout-all. A session whose stamped epoch differs from this is stale and refused. */
  sessionEpoch: number;
  /** Signup interest picks (taxonomy ids). See lib/lite/interests/taxonomy.ts. */
  interests: string[];
  /** NULL = never asked. Set with an empty `interests` = asked and declined. */
  interestsSetAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  upgradedAt: Date | null;
  suspendedAt: Date | null;
}

/** An auth binder (Google passkey or BTC wallet). One user may hold several. */
export interface LumenAuthCredential {
  credentialId: string;
  userId: string;
  method: AuthMethod;
  /** google: verified `sub`; btc: lower(address). Unique per (method, externalRef). */
  externalRef: string;
  network: string | null;
  /** hash160(compressed pubkey), BTC only: stable across every address encoding. */
  keyFingerprint: string | null;
  webauthnCredentialId: string | null;
  webauthnPublicKeyCose: Buffer | null;
  webauthnSignCount: number;
  emailCiphertext: Buffer | null;
  emailHash: string | null;
  deviceLabel: string | null;
  isPrimary: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** A single-use, short-TTL challenge for login / per-post attestation / step-up. */
export interface LumenChallenge {
  nonce: string;
  userId: string | null;
  purpose: ChallengePurpose;
  payloadHash: string | null;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Two-phase name claim row that arbitrates concurrent signups (spec §B.2). */
export interface NameReservation {
  displayNameNorm: string;
  status: NameReservationStatus;
  userId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

// ── content (Phase 3) ────────────────────────────────────────────────────────

export type PostTier = 'normal' | 'advanced';
export type FeedVisibility = 'visible' | 'author_only' | 'hidden';
export type PublishMode = 'proxy' | 'direct';

export type ParentRef =
  | { type: 'lite'; id: string }
  | { type: 'chain'; author: string; permlink: string };

export interface BeneficiaryRoute {
  account: string;
  weight: number;
}

// (Earnings ledger removed 2026-07-23 — lite posts reject all rewards; no
//  per-user balance is ever held, so there is nothing to collect or settle.)

// ── publisher (Phase 4) ──────────────────────────────────────────────────────

export type PublishJobType = 'create' | 'update' | 'delete';
export type PublishJobStatus =
  | 'pending'
  | 'holding'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'rejected';

/** Frozen at enqueue — the exact content the worker broadcasts (spec §D.3). */
export interface PublishPayload {
  author: string; // the frontend Hive account (on-chain author)
  permlink: string; // deterministic, retry-stable
  parentAuthor: string; // '' for a root post; the Hive/lite parent author for a reply
  parentPermlink: string; // category/community tag for a root post; parent permlink for a reply
  title: string;
  body: string; // pre-footer; the worker appends the footer at publish time
  tags: string[];
  displayName: string; // for the footer + metadata
  userId: string;
  postId: string;
}

export interface PublishJob {
  jobId: string;
  postId: string;
  jobType: PublishJobType;
  status: PublishJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  lastError: string | null;
  idempotencyKey: string;
  payloadSnapshot: PublishPayload;
  createdAt: Date;
}

/** A lite post — the DB is the system of record; publishing happens async (§C/§D). */
export interface LumenPost {
  postId: string;
  userId: string;
  displayNameSnapshot: string;
  parentRef: ParentRef | null;
  tier: PostTier;
  title: string;
  body: string;
  tags: string[];
  community: string | null;
  beneficiaries: BeneficiaryRoute[];
  thumbnailUrl: string | null;
  summary: string | null;
  feedVisibility: FeedVisibility;
  publishMode: PublishMode;
  hiveAuthor: string | null;
  hivePermlink: string | null;
  shard: string | null;
  editOfPostId: string | null;
  deletedLocally: boolean;
  /** Audit stamp + the guard that refuses edits after deletion. */
  deletedAt: Date | null;
  /** Increments per edit; drives per-edit publish-job idempotency keys. */
  editVersion: number;
  createdAt: Date;
  publishedAt: Date | null;
}

/**
 * A rolling container root post. Every lite post is published as a comment under
 * one of these, because Hive caps root posts at one per 5 minutes per account
 * (HIVE_MIN_ROOT_COMMENT_INTERVAL) but replies at one per 3 seconds
 * (HIVE_MIN_REPLY_INTERVAL). Rotates when `childCount` reaches `maxChildren`.
 */
export interface LumenContainer {
  containerId: string;
  hiveAuthor: string;
  hivePermlink: string;
  /** opening = root post not on chain yet; open = accepting children; closed = full. */
  /** 'failed' = retired: it could not be opened and must never be retried (migration 0020). */
  status: 'opening' | 'open' | 'closed' | 'failed';
  childCount: number;
  maxChildren: number;
  openedAt: Date;
  publishedAt: Date | null;
  closedAt: Date | null;
  lastError: string | null;
}
