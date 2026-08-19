/**
 * An account's spending power on Magi: its HBD balance and its resource credits.
 *
 * ★ WHY BOTH NUMBERS, AND WHY THEY ARE NOT THE SAME QUESTION.
 *
 * HBD is what a creator-token purchase costs. Resource credits are what it costs to
 * SEND any transaction at all. For a Hive account those are comfortably independent
 * — every `hive:` account gets a free allowance and can transact on a zero balance.
 * For a **wallet identity they are the same pot**, and that changes the product:
 *
 *   RC = balance(hbd) + (10_000 if the account id starts with "hive:") − frozen
 *        — modules/rc-system/rc-system.go:27-46, read at source
 *
 * A `did:pkh` wallet gets NOTHING free. Its HBD balance *is* its resource credits,
 * so **a freshly connected wallet with no HBD cannot submit anything** — not a buy,
 * not a transfer, nothing. Verified live on testnet: `hive:milo.magi` reads hbd
 * 103,297 / RC 113,297 (exactly +10,000), while a wallet identity would read RC
 * equal to its balance.
 *
 * That is escapable and there is no deadlock: HBD arrives via an L1 deposit to the
 * gateway, which the wallet signs on its own chain and which needs no Magi
 * signature. But a UI that offers a Buy button before checking this is offering a
 * transaction that cannot be submitted, so the balance has to be known BEFORE the
 * action is offered.
 *
 * ★ A FAILED READ IS NOT A ZERO BALANCE. Every function here either returns a real
 * figure or throws. Nothing coalesces to 0, because "we could not reach the node"
 * and "you have no money" would then look identical, and the UI would confidently
 * tell someone their funds are gone.
 */

/** HBD is a base-unit integer with 3 decimals. Never put it through a float. */
export interface MagiBalance {
  /** The account this is for: `hive:<name>` or a `did:pkh:…`. */
  account: string;
  /** Liquid HBD in base units (1000 = 1.000 HBD). */
  hbdBaseUnits: number;
  /** Block height the balance was recorded at — the read is a snapshot, not live. */
  blockHeight: number;
}

export interface MagiResourceCredits {
  account: string;
  /** Currently available RC. For a wallet identity this tracks the HBD balance. */
  amount: number;
  /** Ceiling for this account. */
  maxRcs: number;
}

export interface MagiSpendingPower {
  balance: MagiBalance;
  rc: MagiResourceCredits;
  /**
   * TRUE when this account cannot submit ANY transaction because it has no
   * resource credits. For a wallet identity that means an empty HBD balance; for a
   * Hive account it should essentially never happen, since the free allowance
   * covers it unless everything is frozen.
   */
  cannotTransact: boolean;
}

/** The free RC allowance, `hive:`-only. params.go: RC_HIVE_FREE_AMOUNT. */
export const RC_HIVE_FREE_AMOUNT = 10_000;

/** Does this account id get the free allowance? Only `hive:` prefixed ones do. */
export function getsFreeResourceCredits(account: string): boolean {
  return account.startsWith('hive:');
}

/**
 * ★ EXPORTED so the same-origin proxy can allowlist it by exact string.
 * `app/api/creator-tokens/gql/route.ts` imports this and matches on identity,
 * the same single-source-of-truth arrangement it already has with reads.ts's
 * three query constants — so the proxy and this caller can never drift.
 */
export const BALANCE_QUERY = `query MagiAccountBalance($account: String!) {
  getAccountBalance(account: $account) { account block_height hbd }
  getAccountRC(account: $account) { account amount max_rcs }
}`;

function asNumber(value: unknown, field: string): number {
  // Int64 arrives as a JSON number from this schema, but a string would also be
  // valid JSON for a 64-bit value — accept both rather than silently producing NaN.
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`Magi balance read: ${field} was not a number (got ${JSON.stringify(value)})`);
  }
  return n;
}

function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Read an account's HBD balance and resource credits from a Magi node.
 *
 * Throws on any failure — a network error, a GraphQL error, or an account the node
 * has never seen. Callers must distinguish that from an account that genuinely
 * holds nothing; see the note at the top of this file.
 */
/**
 * The same-origin proxy every other creator-tokens read already goes through.
 *
 * ★ DEFECT FIX 2026-08-19. This function used to `fetch(gqlUrl)` — the Magi node
 * directly from the browser — and it could never have worked:
 *
 *   - the node sends no `Access-Control-Allow-Origin`, so the browser refuses at
 *     the CORS preflight (this is the whole reason reads.ts was proxied), and
 *   - `REACT_APP_CREATOR_TOKENS_GQL_URL` was removed from `connect-src` on
 *     2026-08-11 (packages/middleware/lib/csp.ts), so CSP blocks it too.
 *
 * That removal was made after grepping for the only browser-reachable caller —
 * and this file, written on 08-09, was two days younger than the grep and was
 * missed. The failure is SILENT AND DANGEROUS in exactly the direction this
 * module was written to avoid: the read throws, `useMagiSpendingPower` reports
 * `failed`, affordability degrades to 'unknown', `blockedBySpending` becomes
 * false, and the Buy button stays ENABLED for someone who cannot pay — while
 * the funding help that would tell them why never renders.
 *
 * `gqlUrl` is kept in the signature for call-site compatibility and is no longer
 * used to fetch, exactly as reads.ts's own client does.
 */
const CREATOR_TOKENS_GQL_PROXY_PATH = '/api/creator-tokens/gql';

export async function readMagiSpendingPower(gqlUrl: string, account: string): Promise<MagiSpendingPower> {
  if (!gqlUrl) throw new Error('Magi balance read: no GraphQL endpoint configured');
  if (!account) throw new Error('Magi balance read: no account given');

  const res = await fetch(CREATOR_TOKENS_GQL_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: BALANCE_QUERY, variables: { account } }),
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`Magi balance read: HTTP ${res.status}`);

  const json: unknown = await res.json();
  const errors = prop(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const first = prop(errors[0], 'message');
    throw new Error(`Magi balance read: ${typeof first === 'string' ? first : 'GraphQL error'}`);
  }

  const data = prop(json, 'data');
  const balanceNode = prop(data, 'getAccountBalance');
  const rcNode = prop(data, 'getAccountRC');

  // ★★ A MISSING BALANCE ROW BESIDE A PRESENT RC ROW IS A ZERO, NOT AN UNKNOWN
  // (2026-08-09, tester MONEY-08b).
  //
  // This threw whenever `getAccountBalance` was null, on the reasoning that a
  // null record is "unknown" and that "the caller's message for both is the same
  // thing: fund it." The second half was simply false, and the tester proved it
  // on a real Hive account: the throw lands in the gauge's `failed` branch,
  // which renders **"Couldn't check your Magi balance just now — nothing is
  // wrong with your funds"** and leaves `blockedBySpending` FALSE — so the Buy
  // button stays ENABLED and `MagiFundingHelp` (the @vsc.gateway panel that
  // exists precisely for this person) never renders at all.
  //
  // Net effect: an account that has simply never funded Magi — the DEFAULT state
  // for every user of a brand-new feature — was reassured that nothing was wrong
  // and invited to sign a transaction that cannot succeed, burning real resource
  // credits, with the one piece of help they needed suppressed.
  //
  // The node answered. `getAccountRC` came back with a record for this same
  // account in the same response, so this is not a failed read: it is the node
  // saying it holds no balance row, which for a ledger means zero. Measured on
  // the live testnet: `hbd-temp` returns `getAccountBalance: null` beside
  // `getAccountRC {amount: 10000, max_rcs: 10000}` — and 10,000 is exactly the
  // free baseline a hive: account gets on top of its HBD, so the balance is
  // demonstrably 0.
  //
  // BOTH null is still a genuine unknown and still throws — that is a node that
  // told us nothing, which must never be rendered as "you have no money".
  if (
    (balanceNode === null || balanceNode === undefined) &&
    (rcNode === null || rcNode === undefined)
  ) {
    throw new Error(`Magi balance read: the node has no record at all for ${account}`);
  }
  if (rcNode === null || rcNode === undefined) {
    throw new Error(`Magi balance read: the node has no resource-credit record for ${account}`);
  }

  // An absent balance row is a real, reportable zero (see above). `blockHeight`
  // is unknown in that case and is reported as 0 rather than guessed.
  const balance: MagiBalance =
    balanceNode === null || balanceNode === undefined
      ? { account, hbdBaseUnits: 0, blockHeight: 0 }
      : {
          account,
          hbdBaseUnits: asNumber(prop(balanceNode, 'hbd'), 'hbd'),
          blockHeight: asNumber(prop(balanceNode, 'block_height'), 'block_height')
        };
  const rc: MagiResourceCredits = {
    account,
    amount: asNumber(prop(rcNode, 'amount'), 'amount'),
    maxRcs: asNumber(prop(rcNode, 'max_rcs'), 'max_rcs')
  };

  return { balance, rc, cannotTransact: rc.amount <= 0 };
}

/**
 * Can this account afford a purchase, and if not, why not?
 *
 * Deliberately returns a REASON rather than a boolean, because the two failures need
 * different words in front of a user: "top up to cover this" is actionable, while
 * "you have nothing at all, so no transaction can even be sent" is a different
 * problem with a different fix.
 */
export type AffordabilityReason = 'ok' | 'no_resource_credits' | 'insufficient_hbd';

export function checkAffordable(power: MagiSpendingPower, costBaseUnits: number): AffordabilityReason {
  // Order matters: zero RC blocks everything, so report it first even when the
  // balance would also be short. Telling someone to add 5 HBD when no amount would
  // let them transact is a wrong instruction.
  if (power.cannotTransact) return 'no_resource_credits';
  if (costBaseUnits > power.balance.hbdBaseUnits) return 'insufficient_hbd';
  return 'ok';
}
