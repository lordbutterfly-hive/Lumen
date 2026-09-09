import { NextRequest, NextResponse } from 'next/server';
/**
 * ★ REMAINING CALLER (2026-09-09): the "Deposit BTC" dialog this route was built
 * for is gone (owner: "CUT only this in wallet... 2. deposit BTC"). The route
 * stays because the BTC WITHDRAW dialog still asks it for the account's own
 * bridge deposit address, to refuse a withdrawal to that address (Altera's
 * assertBtcRecipientAllowed: coins sent there return to the vault). That guard
 * is a no-op when this route cannot answer, so a down bot never blocks a
 * withdrawal; it only removes one safety net. Limiters still run before the
 * session lookup (security review L3).
 */
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { getLogger } from '@ui/lib/logging';
import { getServerSessionUser } from '@/blog/lib/server-session';
import { liteConfig } from '@/blog/lib/lite/config';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listByUser } from '@/blog/lib/lite/repositories/credential-repository';
import { walletDids } from '@/blog/lib/lite/wallet/did-pkh';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { consumeLocalGlobal, consumeLocalPerIp } from '@/blog/lib/lite/antispam/local-rate-limit';
import { guardBodySize, payloadTooLarge, readBoundedJson } from '@/blog/lib/lite/http/guard';

const logger = getLogger('app');

/**
 * POST /api/magi/btc-deposit-address — a Bitcoin deposit address for one of the
 * signed-in reader's OWN Magi accounts.
 *
 * THE MECHANISM IS ALTERA'S (altera-app/src/lib/sendswap/stages/deposit/
 * BitcoinMainnetDeposit.svelte:96-110 and src/routes/api/mapping-bot/+server.ts):
 * ask the BTC mapping bot for `deposit_to=<magi account id>`, and the bot answers
 * "address mapping (created|exists): <address> -> …". BTC sent to that address is
 * credited to the account on Magi as Bitcoin (the mapping contract's `a-<id>`
 * balance the wallet's Magi tab reads). Altera proxies the bot from its own
 * backend; the bot does send CORS headers today (probed 2026-09-08), but this
 * route exists for the SAME reasons the creator-tokens GQL proxy does: the
 * upstream host is server configuration, never a client-supplied URL, the call
 * is rate-limited here, and the only account a caller can ask for is one of
 * their own.
 *
 * ★ OWNERSHIP IS CHECKED, NOT ASSUMED. A full Hive session may ask for
 * `hive:<its username>`; a lite session may ask for any `did:pkh` of a wallet
 * bound to it (the same DB read `/api/lite/wallet/dids` serves). Asking for
 * anyone else's account is refused. The bot would happily mint an address for
 * any string, and a deposit address that credits someone else is exactly the
 * kind of thing a wallet must never hand out.
 *
 * Network: `REACT_APP_CREATOR_TOKENS_NET_ID` decides testnet vs mainnet, the
 * same switch every other Magi write in this app is keyed on; the bot hosts
 * default to Altera's own and `MAGI_BTC_MAPPING_BOT_URL` overrides.
 */

const BOT_MAINNET = 'https://btc.magi.milohpr.com';
const BOT_TESTNET = 'https://btc.testnet.magi.milohpr.com';
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4 * 1024;
/** Mapping-contract account ids are at most 160 bytes (core/util.go MaxAccountLen, mirrored in reads.ts isWellFormedDid). */
const MAX_ACCOUNT_LEN = 160;

async function allowedAccounts(): Promise<Set<string>> {
  const allowed = new Set<string>();
  const hive = await getServerSessionUser();
  if (hive.isLoggedIn && hive.accountTier === 'full' && hive.username) {
    allowed.add(`hive:${hive.username}`);
  }
  if (liteConfig.enabled && liteConfig.databaseUrl) {
    try {
      const session = await getLiteSession();
      // allowUpgraded for the same reason /api/lite/wallet/dids gives: an upgraded
      // user's wallets are still theirs, and this route acts on nothing.
      const actor = await requireActiveLiteUser(session.user, session, { allowUpgraded: true });
      if (actor.ok) {
        const credentials = await listByUser(actor.user.userId);
        for (const w of walletDids(credentials)) allowed.add(w.did);
      }
    } catch (error) {
      logger.warn(error, 'magi btc deposit: lite session lookup failed; continuing with the Hive session only');
    }
  }
  return allowed;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get(csrfHeaderName) !== '1') {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  const tooBig = guardBodySize(req, MAX_BODY_BYTES);
  if (tooBig) return tooBig;
  const parsed = await readBoundedJson<{ account?: unknown }>(req, MAX_BODY_BYTES);
  if (parsed === null) return payloadTooLarge();
  const account = typeof parsed.body?.account === 'string' ? parsed.body.account.trim() : '';
  if (!account || account.length > MAX_ACCOUNT_LEN || !/^[\x21-\x7e]+$/.test(account)) {
    return NextResponse.json({ error: 'account_required' }, { status: 400 });
  }

  const netId = process.env.REACT_APP_CREATOR_TOKENS_NET_ID;
  const network = netId === 'vsc-testnet' ? 'testnet' : netId === 'vsc-mainnet' ? 'mainnet' : null;
  if (!network) {
    return NextResponse.json({ error: 'magi_not_configured' }, { status: 503 });
  }

  // Ceilings, not shaping: a deposit address is asked for a few times per session
  // at most. ★ BEFORE the session lookup (security review L3): the ownership
  // check below costs a database read, and a limiter that runs after it bounds
  // the mapping bot but not our own database.
  if (!consumeLocalGlobal('magi_btc_deposit', 600)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (!consumeLocalPerIp(getClientIp(req), 'magi_btc_deposit', 30)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const allowed = await allowedAccounts();
  if (allowed.size === 0) return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
  if (!allowed.has(account)) return NextResponse.json({ error: 'account_not_yours' }, { status: 403 });

  const upstream = process.env.MAGI_BTC_MAPPING_BOT_URL || (network === 'testnet' ? BOT_TESTNET : BOT_MAINNET);
  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: `deposit_to=${account}` }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: 'no-store'
    });
    const text = await res.text();
    if (!res.ok) {
      // Status and size only (security review I1): the reply can carry a deposit
      // address bound to a named account, which does not belong in server logs.
      logger.warn({ status: res.status, bytes: text.length }, 'magi btc deposit: mapping bot refused');
      return NextResponse.json({ error: 'mapping_bot_error' }, { status: 502 });
    }
    const match = text.match(/address mapping (?:created|exists): (\S+)/);
    if (!match) {
      logger.warn({ bytes: text.length }, 'magi btc deposit: unexpected mapping bot response');
      return NextResponse.json({ error: 'mapping_bot_unexpected' }, { status: 502 });
    }
    return NextResponse.json(
      { address: match[1], network, account },
      { headers: { 'cache-control': 'private, no-store' } }
    );
  } catch (error) {
    logger.error(error, 'magi btc deposit: mapping bot unreachable');
    return NextResponse.json({ error: 'mapping_bot_unreachable' }, { status: 502 });
  }
}
