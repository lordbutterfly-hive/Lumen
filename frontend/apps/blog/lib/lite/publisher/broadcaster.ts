/**
 * Broadcast seam for the publisher (spec §D.2). The real implementation is a
 * `SignerServerWif`: loads the frontend account's POSTING wif from KMS/HSM (never
 * an env var), signs the digest headlessly via @hiveio/beekeeper's Node build,
 * calls `verifyAuthorityOrThrow(..., 'posting')`, and asserts the author equals
 * the configured frontend account before broadcasting via wax.
 *
 * That implementation is INFRA-GATED (needs the KMS key + a real Hive account),
 * so it is injected at deploy via `setBroadcaster`. Until then `hasBroadcaster()`
 * is false and the worker stays idle — the publisher is dark, never fake.
 */

export interface CommentOp {
  parentAuthor: string; // '' for a root post
  parentPermlink: string; // category/community tag for a root post
  author: string; // the frontend Hive account
  permlink: string;
  title: string;
  body: string; // footer already appended
  jsonMetadata: string; // stringified
  // Lite posts REJECT all rewards (decision 2026-07-23): the frontend account
  // takes on no per-user earnings and no platform beneficiary. The real
  // broadcaster sets comment_options max_accepted_payout = 0.000 HBD (declined),
  // with no beneficiaries. Earning happens only once a user upgrades to their
  // own Hive account.
  declinePayout: boolean;
}

export interface PostBroadcaster {
  broadcastComment(op: CommentOp): Promise<{ trxId: string }>;
  /** Crash-after-broadcast guard: was this (author, permlink) already published? */
  postExists(author: string, permlink: string): Promise<boolean>;
}

let broadcaster: PostBroadcaster | null = null;

/** Inject the KMS-backed signer/broadcaster at deploy time. */
export function setBroadcaster(impl: PostBroadcaster): void {
  broadcaster = impl;
}

export function hasBroadcaster(): boolean {
  return broadcaster !== null;
}

export function getBroadcaster(): PostBroadcaster {
  if (!broadcaster) {
    throw new Error(
      'Publisher broadcaster not configured — inject a KMS-backed SignerServerWif via setBroadcaster (spec §D.2)'
    );
  }
  return broadcaster;
}
