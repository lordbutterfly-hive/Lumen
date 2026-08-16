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
 * Every word nobody may register outright, matched EXACTLY (after normalisation) —
 * never as a substring.
 *
 * H6 fix (2026-08-16): this used to be two lists with two different rules — `lumen`,
 * `admin`, `moderator` and `official` were matched as a SUBSTRING (so `myadmin`,
 * `moderator-x` and `unofficial` were all reserved too), while `hive`, `support`,
 * `root` etc. were matched EXACTLY (so `xhivex` and `xsupportx` were free). Nobody
 * could predict which rule applied to which word. Now every word here follows the
 * SAME rule — exact match only — so `admin`, `moderator` and `official` are free to
 * appear inside a longer name (`myadmin`, `moderator-x`, `unofficial-source`) exactly
 * like `hive` and `support` already were. `lumen` itself is deliberately NOT in this
 * list: it is handled below by a separate, narrower, explicitly-documented substring
 * rule, because it is our own brand rather than a generic reserved word (see
 * RESERVED_BRAND_SUBSTRING). `lumenposts` is also gone from here — it is redundant
 * now that anything containing "lumen" is already caught by that rule.
 */
const RESERVED_EXACT = new Set([
  'admin', 'administrator', 'moderator', 'official',
  'support', 'help', 'root', 'system', 'mod', 'staff', 'security',
  'hive', 'hiveio', 'null', 'undefined', 'api', 'www'
]);

/**
 * The ONE substring rule left after H6, and deliberately narrow: `lumen` is our own
 * brand, so a name that merely CONTAINS it (`lumen-support`, `official-lumen`) can
 * read as speaking for us to a user who has no reason to parse username grammar —
 * that impersonation risk is real and specific to our own name. It does not apply to
 * generic reserved words (`admin`, `moderator`, ...), which is exactly why they moved
 * to RESERVED_EXACT above instead of getting their own substring rule.
 */
const RESERVED_BRAND_SUBSTRING = 'lumen';

/**
 * Entries long enough for the doubled-letter collapse to be safe, pre-squashed so a
 * reserved word matches its own normalised form. Four characters and under are
 * excluded: see the collision note at the match site (`mood` -> `mod`).
 */
const MIN_LENGTH_FOR_SQUASHED_MATCH = 5;

/**
 * i18n keys for the two "reserved" refusal reasons vetNameFormat can produce.
 * vetNameFormat cannot call `t()` itself: it is a plain synchronous function
 * imported by the migration runner, ops scripts and tests (see the runtime-import
 * note on checkNameAvailability below) — none of which have a request to resolve a
 * locale from. It returns fallback English text AND this code; only a caller that
 * IS inside a Next request (app/api/lite/name/check/route.ts) resolves the code
 * through `t()` for the localized string.
 */
export type ReservedCode = 'lite_auth.name_check.reserved_lumen' | 'lite_auth.name_check.reserved';

// Reject anything shaped like a wallet address (spec §B.2). Most are already
// excluded by the Hive charset rules, but bc1/tb1 bech32 can slip through.
const WALLET_SHAPE = /^(0x|bc1|tb1|did:)/i;

export type VetResult = { ok: true } | { ok: false; error: string; code?: ReservedCode };

/**
 * Fold a name to the form reserved terms are compared against.
 *
 * Separator-stripping alone was not enough: `lum3n`, `lumeen`, `mod3rator` and
 * `lummen` all sailed through while `lumen` was blocked (proven 2026-07-28), which
 * is exactly the impersonation this list exists to stop. So also undo the two cheap
 * tricks — digit-for-letter substitutions and repeated letters. Unicode homoglyphs
 * are already impossible: Hive's own charset rules allow only a-z, 0-9 and dashes.
 *
 * Still needed after the H6 exact-match rule was introduced for RESERVED_EXACT:
 * without it, `adm1n` or `supp0rt` would read as a different string to Set.has()
 * and sail straight past an exact check too, the same way `lum3n` used to sail past
 * the brand check.
 */
function normaliseForReserved(lower: string, oneAs: 'l' | 'i' = 'l'): string {
  return lower
    .replace(/[-_.]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, oneAs)
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/(.)\1+/g, '$1'); // collapse doubled letters: lummen -> lumen
}

/**
 * ★ `1` IS TWO LETTERS, AND ASSUMING ONE OF THEM LET THE OTHER THROUGH (2026-08-16).
 *
 * The table above mapped `1` to `l` only, and the comment above claimed this defends
 * `adm1n`. It does not: `adm1n` folds to `admln`, which matches nothing, so `adm1n`
 * was FREE while `admin` was reserved. Proven by running the rule over a table of
 * candidates before touching it. `1` reads as `i` at least as often as `l` in this
 * kind of evasion, and there is no way to know which the registrant meant.
 *
 * So fold BOTH ways and refuse if EITHER form is reserved. Two cheap string passes,
 * no guessing. Everything else in the table is unambiguous and stays single-valued.
 */
function reservedForms(lower: string): string[] {
  const asL = normaliseForReserved(lower, 'l');
  const asI = normaliseForReserved(lower, 'i');
  return asL === asI ? [asL] : [asL, asI];
}

/** Built after `normaliseForReserved` because it uses it. See the match site. */
const RESERVED_EXACT_SQUASHED = new Set(
  // Arrow, not a point-free `.map(normaliseForReserved)`: `map` passes the INDEX as
  // the second argument, which since 2026-08-16 is the `oneAs` fold selector. Point-free
  // here folded entry 0 one way and entry 1 another. tsc caught it; runtime would not have.
  [...RESERVED_EXACT]
    .filter((w) => w.length >= MIN_LENGTH_FOR_SQUASHED_MATCH)
    .map((w) => normaliseForReserved(w))
);

export function vetNameFormat(displayName: string): VetResult {
  const name = displayName.trim();
  const formatError = validateHiveAccountName(name);
  if (formatError) return { ok: false, error: formatError };

  if (WALLET_SHAPE.test(name)) {
    return { ok: false, error: 'That name looks like a wallet address.' };
  }

  const lower = name.toLowerCase();
  const forms = reservedForms(lower);

  // Brand rule first (narrow, substring — see RESERVED_BRAND_SUBSTRING above).
  if (forms.some((f) => f.includes(RESERVED_BRAND_SUBSTRING))) {
    return {
      ok: false,
      error: "Names containing 'lumen' are reserved.",
      code: 'lite_auth.name_check.reserved_lumen'
    };
  }

  // Everything else: exact match only (H6 — see RESERVED_EXACT above).
  //
  // ★ THE SQUASHED FORM IS ONLY CONSULTED FOR LONG ENTRIES (2026-08-16). The
  // doubled-letter collapse shortens a name, so a short reserved word can swallow
  // an ordinary longer one: `mood` collapses to `mod`, and `mod` is on the list, so
  // "mood" was refused. Nobody typed a leetspeak evasion; they typed a word.
  //
  // Collapse only earns its keep on entries long enough that an accidental collision
  // is implausible, and there it defends a real evasion (`adm1n`, `suppport`). Below
  // that length the exact `lower` match is the whole rule. Reserved words are squashed
  // TOO, so `support` still matches its own collapsed form `suport`.
  if (RESERVED_EXACT.has(lower) || forms.some((f) => RESERVED_EXACT_SQUASHED.has(f))) {
    return { ok: false, error: `'${name}' is a reserved name.`, code: 'lite_auth.name_check.reserved' };
  }

  // The frontend account itself is config (liteConfig.frontendAccount), not a fixed
  // word, so it cannot live in RESERVED_EXACT above. It gets the same narrow substring
  // treatment as the brand rule and for the same reason: someone registering a name
  // that CONTAINS the actual on-chain posting account would read as speaking for it.
  const frontend = liteConfig.frontendAccount
    ? normaliseForReserved(liteConfig.frontendAccount.toLowerCase())
    : '';
  if (frontend && forms.some((f) => f.includes(frontend))) {
    return { ok: false, error: `'${name}' is a reserved name.`, code: 'lite_auth.name_check.reserved' };
  }
  return { ok: true };
}

export type AvailabilityResult =
  | { available: true }
  | { available: false; reason: string; code?: ReservedCode };

/**
 * Read-only availability check for live UX feedback — format + reserved +
 * on-chain existence. Does NOT reserve the name; the reservation happens
 * atomically at signup completion.
 */
export async function checkNameAvailability(displayName: string): Promise<AvailabilityResult> {
  const vet = vetNameFormat(displayName);
  if (!vet.ok) return { available: false, reason: vet.error, code: vet.code };

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
