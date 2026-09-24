/**
 * Shared by BOTH publishing paths: a full account's own removal (`quote-ops.ts`) and the
 * lite publisher's soft delete (apps/blog/lib/lite/publisher/worker.ts). Its own file so
 * the lite path never imports the full-account attribution module.
 */

/**
 * The text a removed comment is left with when Hive will not allow a real delete (it
 * has replies, net-positive votes, or has paid out).
 *
 * ★ NEVER THE EMPTY STRING. hived's `comment_operation::validate` asserts "Body is
 * empty" (hive_operations.cpp:109): a comment with `body: ''` is rejected before it is
 * ever applied, so a blanking edit with an empty body can never land. Measured
 * 2026-09-24 with wax's own validate() (the protocol code compiled to wasm): `''` is
 * INVALID, `' '` and any text are VALID.
 */
export const DELETED_BODY = '[deleted]';
