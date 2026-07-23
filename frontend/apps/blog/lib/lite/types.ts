/**
 * Lite-account domain types (camelCase), mapped from the snake_case Postgres
 * rows defined in db/migrations/0001_identity.sql. Canonical schema keys are
 * fixed by LUMEN-LITE-ACCOUNTS-SPEC §4 — do not introduce naming variants.
 */

export type AccountTier = 'lite' | 'full';
export type AuthMethod = 'google_passkey' | 'btc_wallet';
export type ChallengePurpose = 'login' | 'post_attestation' | 'stepup';
export type UserStatus = 'active' | 'suspended' | 'upgraded' | 'banned';
export type NameReservationStatus = 'pending' | 'active';

/** A lite (or upgraded-full) Lumen account. The `userId` is permanent. */
export interface LumenUser {
  userId: string;
  displayName: string;
  displayNameHistory: string[];
  avatarUrl: string | null;
  accountTier: AccountTier;
  /** Real on-chain account name, set only after ACT upgrade; differs from displayName. */
  hiveAccountName: string | null;
  trustScore: number;
  status: UserStatus;
  suspendedReason: string | null;
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
  createdAt: Date;
  publishedAt: Date | null;
}
