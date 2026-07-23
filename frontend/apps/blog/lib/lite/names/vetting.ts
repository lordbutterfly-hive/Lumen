import { validateHiveAccountName } from '@smart-signer/lib/validators/validate-hive-account-name';
import { checkAccountExists } from '@transaction/lib/validation/existence/account';
import { liteConfig } from '../config';

/**
 * Chosen-name vetting (spec §B). Reuses the existing `validateHiveAccountName`
 * (length + segment rules + the 912-entry bad-actor and 52-entry DMCA lists),
 * then adds: explicit wallet-address-shape rejection, platform reserved terms,
 * and the frontend account name. The live Hive existence check is separate
 * (fail-closed on api_error).
 */

const RESERVED = new Set([
  'lumen', 'admin', 'administrator', 'support', 'help', 'root', 'system',
  'mod', 'moderator', 'official', 'staff', 'security', 'lumenposts',
  'hive', 'hiveio', 'null', 'undefined', 'api', 'www'
]);

// Reject anything shaped like a wallet address (spec §B.2). Most are already
// excluded by the Hive charset rules, but bc1/tb1 bech32 can slip through.
const WALLET_SHAPE = /^(0x|bc1|tb1|did:)/i;

export type VetResult = { ok: true } | { ok: false; error: string };

export function vetNameFormat(displayName: string): VetResult {
  const name = displayName.trim();
  const formatError = validateHiveAccountName(name);
  if (formatError) return { ok: false, error: formatError };

  if (WALLET_SHAPE.test(name)) {
    return { ok: false, error: 'That name looks like a wallet address.' };
  }

  const lower = name.toLowerCase();
  if (RESERVED.has(lower)) {
    return { ok: false, error: 'That name is reserved.' };
  }
  if (liteConfig.frontendAccount && lower === liteConfig.frontendAccount.toLowerCase()) {
    return { ok: false, error: 'That name is reserved.' };
  }
  return { ok: true };
}

export type AvailabilityResult = { available: true } | { available: false; reason: string };

/**
 * Read-only availability check for live UX feedback — format + reserved +
 * on-chain existence. Does NOT reserve the name; the reservation happens
 * atomically at signup completion.
 */
export async function checkNameAvailability(displayName: string): Promise<AvailabilityResult> {
  const vet = vetNameFormat(displayName);
  if (!vet.ok) return { available: false, reason: vet.error };

  const existence = await checkAccountExists(displayName.trim().toLowerCase());
  if (existence.status === 'exists') {
    return { available: false, reason: 'That name already exists on Hive.' };
  }
  if (existence.status === 'api_error') {
    return { available: false, reason: 'Could not verify availability right now, please retry.' };
  }
  return { available: true };
}
