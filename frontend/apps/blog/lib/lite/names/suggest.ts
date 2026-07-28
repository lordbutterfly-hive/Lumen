import { siteConfig } from '@ui/config/site';
import * as users from '../repositories/user-repository';
import { vetNameFormat } from './vetting';

/**
 * Name suggestions for the lite -> Hive upgrade.
 *
 * A Lumen handle is NOT reserved on Hive. Reserving one would mean creating the
 * account, which permanently spends an account creation token — so a user who has
 * been `alice` on Lumen for months may simply find `alice` taken the day they
 * upgrade. There is no way to prevent that and no way to promise otherwise.
 *
 * What we can do is say so before they get attached to it, and hand them close
 * alternatives. Their Lumen history is keyed on `user_id`, not on the name, so a
 * derivative costs them nothing: every old post follows them to the new name (see
 * render/current-name.ts).
 */

const MAX_NAME = 16;

/** Trim a base so `base + suffix` still fits Hive's 16-character limit. */
function fit(base: string, suffix: string): string {
  return base.slice(0, Math.max(1, MAX_NAME - suffix.length)) + suffix;
}

/** Same, for a prefix. */
function fitPrefix(prefix: string, base: string): string {
  return prefix + base.slice(0, Math.max(1, MAX_NAME - prefix.length));
}

/**
 * Close variations on a name, cheapest-looking first.
 *
 * Deliberately boring: a user who wanted `alice` reads `alice1` and `alice-hive` as
 * obviously theirs, where something clever would just read as a different person.
 *
 * Note what is NOT here: anything containing "lumen". `vetNameFormat` rejects that
 * substring outright as impersonation, so suggesting `alice-lumen` would hand the
 * user a name the server then refuses.
 */
export function deriveCandidates(baseRaw: string): string[] {
  const base = baseRaw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!base) return [];

  const candidates = [
    fit(base, '1'),
    fit(base, '2'),
    fit(base, '3'),
    fit(base, '-1'),
    fit(base, '-hive'),
    fit(base, '-blog'),
    fitPrefix('the-', base),
    fitPrefix('real-', base),
    fit(base, '-x'),
    fit(base, '7')
  ];

  // De-duplicate (short bases collide after truncation) and drop anything the
  // server would refuse anyway — a suggestion that fails vetting is worse than none.
  return [...new Set(candidates)].filter((name) => name !== base && vetNameFormat(name).ok);
}

/**
 * Which of these names already exist on Hive — ONE API call for the whole list.
 *
 * `database_api.find_accounts` answers "absent" by simply omitting the account, so
 * there is no missing-account exception to handle. A plain fetch rather than the wax
 * client on purpose: this module is imported by ops scripts and tests, and wax has no
 * CJS export map (same reason `vetting.ts` defers its own chain import).
 *
 * Throws on transport failure. The caller must NOT read that as "all available" — a
 * name we could not check is a name we cannot recommend.
 */
export async function namesTakenOnChain(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();

  const res = await fetch(siteConfig.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'database_api.find_accounts',
      params: { accounts: names },
      id: 1
    })
  });
  if (!res.ok) throw new Error(`find_accounts failed: HTTP ${res.status}`);

  const data = (await res.json()) as { result?: { accounts?: { name?: string }[] }; error?: unknown };
  if (data.error) throw new Error(`find_accounts error: ${JSON.stringify(data.error).slice(0, 200)}`);

  return new Set((data.result?.accounts ?? []).map((account) => String(account.name)));
}

export interface NameSuggestion {
  /** Is the name they asked about actually free? */
  baseAvailable: boolean;
  /** Why not, when it isn't — safe to show to the user. */
  baseReason?: string;
  /** Free alternatives, best first. Empty if the chain could not be reached. */
  suggestions: string[];
}

/**
 * Check a name and, in the same round trip, offer alternatives that are genuinely
 * free. Both the name and its derivatives go to Hive in ONE `find_accounts` call.
 */
export async function suggestNames(
  baseRaw: string,
  opts: {
    want?: number;
    /**
     * Answer "unavailable, because <this>" without asking the chain about the base,
     * but still return alternatives derived from it. Used for the one name the
     * upgrade picker can never grant: the user's own Lumen handle (see
     * names/upgrade-name.ts). Without this the picker would report their handle as
     * free — it often is, on Hive — and then the server would refuse it.
     */
    refuseBaseBecause?: string;
  } = {}
): Promise<NameSuggestion> {
  const want = opts.want ?? 5;
  const base = baseRaw.trim().toLowerCase();

  const vet = vetNameFormat(base);
  if (!vet.ok) {
    // A malformed base cannot seed sensible derivatives, and the user needs to fix
    // the name itself first. Say what is wrong; suggest nothing.
    return { baseAvailable: false, baseReason: vet.error, suggestions: [] };
  }

  const candidates = deriveCandidates(base);
  let taken: Set<string>;
  try {
    taken = await namesTakenOnChain([base, ...candidates]);
  } catch {
    // Fail closed. Claiming a name is free when we could not ask is how a user ends
    // up staring at a failed account creation.
    return {
      baseAvailable: false,
      baseReason: 'Could not check availability right now — please try again.',
      suggestions: []
    };
  }

  // Hive availability is necessary but not sufficient: a name free on chain can
  // still be another Lumen user's handle, and `upgradeToFullAccount` refuses those.
  // Filtering here is what stops the picker offering a name the next screen rejects.
  let usedInLumen = new Set<string>();
  try {
    usedInLumen = await users.findNamesInUse(candidates);
  } catch {
    // A DB hiccup should not blank the suggestions — the upgrade itself still
    // enforces the rule, so the worst case is one rejected pick.
  }

  const free = candidates.filter((name) => !taken.has(name) && !usedInLumen.has(name)).slice(0, want);

  if (opts.refuseBaseBecause) {
    return { baseAvailable: false, baseReason: opts.refuseBaseBecause, suggestions: free };
  }
  // Alternatives exist to replace a name you cannot have. When the name IS free,
  // offering "instead, try…" reads as if something were wrong with it.
  if (!taken.has(base)) return { baseAvailable: true, suggestions: [] };

  return { baseAvailable: false, baseReason: 'That name is already taken on Hive.', suggestions: free };
}
