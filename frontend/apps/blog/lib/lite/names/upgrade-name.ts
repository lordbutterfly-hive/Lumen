/**
 * The one rule the upgrade name picker and the upgrade service must agree on.
 *
 * A new Hive account may NOT take the user's own Lumen handle. This is not a style
 * preference — `lumen_user` carries a CHECK constraint
 * (`hive_name_differs_from_display`, migration 0001) that makes the row
 * unrepresentable, and the row is written AFTER the account exists on chain. Letting
 * the two names match therefore spends a real, non-refundable account creation token,
 * creates a permanent on-chain account, and then fails to record any of it: the user
 * stays 'lite' forever with a real account nobody has linked to them. Verified by
 * running exactly that, 2026-07-28.
 *
 * So the refusal has to happen up front, while refusing is still free — and both the
 * picker and the server have to state the same rule, which is why it lives here
 * rather than being spelled out twice.
 *
 * Nothing is lost by taking a different name: `user_id` never changes, so the user's
 * entire Lumen history follows them (see render/current-name.ts).
 */

export const LITE_HANDLE_REUSE_MESSAGE =
  'Your Lumen name can’t be reused for your Hive account — pick a new one. Everything you’ve posted moves across with you.';

/** Is this the user's own Lumen handle? Case-insensitive, like the DB constraint. */
export function isOwnLiteHandle(candidate: string, displayName: string): boolean {
  return candidate.trim().toLowerCase() === displayName.trim().toLowerCase();
}
