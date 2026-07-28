import { validateHiveAccountName } from '@smart-signer/lib/validators/validate-hive-account-name';
import { liteConfig } from '../config';

/**
 * Chosen-name vetting (spec §B). Reuses the existing `validateHiveAccountName`
 * (length + segment rules + the 912-entry bad-actor and 52-entry DMCA lists),
 * then adds: explicit wallet-address-shape rejection, platform reserved terms,
 * and the frontend account name. The live Hive existence check is separate
 * (fail-closed on api_error).
 */

/**
 * Terms nobody may use ANYWHERE in a name — impersonation risks. Deliberately does
 * NOT include generic words like `hive` or `api`: as substrings they would reject
 * ordinary names ("archive", "hivemind-fan", "rapiddev"), and those are handled by
 * RESERVED_EXACT instead.
 */
const RESERVED = new Set([
  'lumen', 'admin', 'administrator', 'moderator', 'official', 'lumenposts'
]);

/** Blocked only as the whole name — too common to ban as a substring. */
const RESERVED_EXACT = new Set([
  'support', 'help', 'root', 'system', 'mod', 'staff', 'security',
  'hive', 'hiveio', 'null', 'undefined', 'api', 'www'
]);

// Reject anything shaped like a wallet address (spec §B.2). Most are already
// excluded by the Hive charset rules, but bc1/tb1 bech32 can slip through.
const WALLET_SHAPE = /^(0x|bc1|tb1|did:)/i;

export type VetResult = { ok: true } | { ok: false; error: string };

/**
 * Fold a name to the form reserved terms are compared against.
 *
 * Separator-stripping alone was not enough: `lum3n`, `lumeen`, `mod3rator` and
 * `lummen` all sailed through while `lumen` was blocked (proven 2026-07-28), which
 * is exactly the impersonation this list exists to stop. So also undo the two cheap
 * tricks — digit-for-letter substitutions and repeated letters. Unicode homoglyphs
 * are already impossible: Hive's own charset rules allow only a-z, 0-9 and dashes.
 */
function normaliseForReserved(lower: string): string {
  return lower
    .replace(/[-_.]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/(.)\1+/g, '$1'); // collapse doubled letters: lummen -> lumen
}

export function vetNameFormat(displayName: string): VetResult {
  const name = displayName.trim();
  const formatError = validateHiveAccountName(name);
  if (formatError) return { ok: false, error: formatError };

  if (WALLET_SHAPE.test(name)) {
    return { ok: false, error: 'That name looks like a wallet address.' };
  }

  const lower = name.toLowerCase();
  // Exact match alone was not enough: `lumen` was blocked while `lumensupport`,
  // `lumen-support`, `adminhelp` and `official-lumen` were all free — which is
  // exactly what an impersonator wants. Compare against a form with separators
  // stripped, and reject a reserved term appearing anywhere in the name.
  const squashed = normaliseForReserved(lower);
  if (RESERVED_EXACT.has(squashed) || RESERVED_EXACT.has(lower)) {
    return { ok: false, error: 'That name is reserved.' };
  }
  for (const term of RESERVED) {
    if (squashed === term || squashed.includes(term)) {
      return { ok: false, error: 'That name is reserved.' };
    }
  }
  const frontend = liteConfig.frontendAccount
    ? normaliseForReserved(liteConfig.frontendAccount.toLowerCase())
    : '';
  if (frontend && squashed.includes(frontend)) {
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

  // Runtime import, same reason as publisher/hive-broadcaster.ts: the chain client
  // pulls in @hiveio/wax, which has no CJS export map, so a static import here makes
  // this module unloadable from anything that is not the Next bundle — the migration
  // runner, ops scripts and tests all import vetNameFormat transitively. Only THIS
  // function needs the chain, so only this function pays for it.
  const { checkAccountExists } = await import('@transaction/lib/validation/existence/account');
  const existence = await checkAccountExists(displayName.trim().toLowerCase());
  if (existence.status === 'exists') {
    return { available: false, reason: 'That name already exists on Hive.' };
  }
  if (existence.status === 'api_error') {
    return { available: false, reason: 'Could not verify availability right now, please retry.' };
  }
  return { available: true };
}
