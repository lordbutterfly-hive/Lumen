/**
 * Load the app in a real browser AS A SIGNED-IN WALLET USER, and check that a
 * wallet identity sees the tokens it actually owns.
 *
 *   node qa/harness/wallet-ui-check.mjs                  # against :3100
 *   LUMEN_BASE=https://localhost:3443 node qa/harness/wallet-ui-check.mjs
 *
 * WHY THIS EXISTS. Every other check in this repo is a unit test, an API probe,
 * or a chain read. None of them would have caught the bug this was written for:
 * a wallet user BOUGHT tokens successfully, and the token page then read their
 * position back as ZERO, because the read keyed on the Lumen display name while
 * the write signed as the wallet DID. On a ledger keyed by account string a
 * wrong key is not an error, it is a successful read of an account that does not
 * exist. Nothing threw. The only way to see it was to look at the page as the
 * user who owned the tokens.
 *
 * ★ IT LOGS IN FOR REAL. Challenge, sign, verify, against the running server,
 * with the QA keys. No mocked session and no injected provider, because the
 * thing under test is the whole path from credential to rendered balance.
 *
 * ★ KEYS LIVE OUTSIDE THE REPO at `~/lumen-qa-wallets.json` (mode 600), the same
 * file `ct-wallet-sign.ts` reads. Throwaway testnet identities holding no
 * mainnet value. The BTC one is a MAINNET-FORMAT address by necessity (the node
 * only parses mainnet Bitcoin DIDs); that does not put bitcoin at stake, since a
 * Magi transaction signed with a Bitcoin key never touches the Bitcoin chain.
 *
 * ★ IT ASSERTS ON THE NUMBER, NOT THE PANEL. The first version of this check
 * asked whether a position panel existed and reported PASS while the holding was
 * invisible; a later version looked for "Your position" when the copy says "You
 * hold" and reported a FALSE FAILURE on a working fix. Both were the harness
 * being wrong about the page. Assert the value a human would read.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

const BASE = process.env.LUMEN_BASE ?? 'http://127.0.0.1:3100';
const CHROME = process.env.CHROME_PATH ?? '/home/clauderfly/opt/chrome-root/opt/google/chrome/chrome';
const KEYS = `${process.env.HOME}/lumen-qa-wallets.json`;

/**
 * Each wallet and the creator whose token it holds. Update when the QA wallets
 * buy elsewhere; a wallet holding nothing makes this check vacuous, which is
 * why the run FAILS on a zero holding rather than reporting "no position".
 */
const HOLDINGS = [
  { chain: 'evm', creator: 'lumen.aria' },
  { chain: 'btc', creator: 'lumen.cole' }
];

let wallets;
try {
  wallets = JSON.parse(readFileSync(KEYS, 'utf8'));
} catch {
  console.error(`wallet-ui-check: no QA wallets at ${KEYS}. See the header for its shape.`);
  process.exit(2);
}

async function post(path, body, cookie) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': '1', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }
  // getSetCookie(), not get(): a response sets several cookies and `get` returns
  // only the first, which silently loses the session.
  return { json, cookies: r.headers.getSetCookie?.() ?? [] };
}

/** Stands in for Leather/Xverse. Note: NO segwit header offset on the LOGIN path. */
function btcSignMessage(privHex, message) {
  const prefix = Buffer.from('\x18Bitcoin Signed Message:\n', 'binary');
  const msg = Buffer.from(message, 'utf8');
  const varint = msg.length < 0xfd
    ? Buffer.from([msg.length])
    : Buffer.concat([Buffer.from([0xfd]), Buffer.from([msg.length & 0xff, msg.length >> 8])]);
  const digest = sha256(sha256(Buffer.concat([prefix, varint, msg])));
  const sig = secp256k1.sign(digest, privHex);
  const out = new Uint8Array(65);
  out[0] = 27 + (sig.recovery ?? 0) + 4;
  out.set(sig.toCompactRawBytes(), 1);
  return Buffer.from(out).toString('base64');
}

async function sessionFor(chain) {
  const address = chain === 'evm' ? wallets.evm.address : wallets.btc.address;
  const challenge = await post(`/api/lite/auth/${chain}/challenge`, { address });
  if (!challenge.json?.message) throw new Error(`${chain}: no challenge issued`);
  const signature = chain === 'evm'
    ? await privateKeyToAccount(wallets.evm.privateKey).signMessage({ message: challenge.json.message })
    : btcSignMessage(wallets.btc.privateKeyHex, challenge.json.message);
  const verified = await post(`/api/lite/auth/${chain}/verify`, {
    address,
    signature,
    nonce: challenge.json.nonce
  });
  if (verified.json?.status === 'needs_name') {
    throw new Error(`${chain}: this wallet has no Lumen account yet. Complete signup once, then re-run.`);
  }
  const host = new URL(BASE).hostname;
  return verified.cookies.map((c) => {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: host, path: '/' };
  });
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
let failures = 0;

for (const { chain, creator } of HOLDINGS) {
  const label = `${chain.toUpperCase()} on /creators/${creator}`;
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    await ctx.addCookies(await sessionFor(chain));
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });

    await page.goto(`${BASE}/creators/${creator}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // The holding is fetched client-side after hydration, so wait for the
    // SENTENCE, not for a timer.
    const holding = page.getByText(/You hold\s+[\d.]+\s+tokens/i).first();
    await holding.waitFor({ state: 'visible', timeout: 30_000 });
    const text = (await holding.textContent()) ?? '';

    const amount = Number(text.match(/You hold\s+([\d.]+)/i)?.[1] ?? '0');
    const ok = amount > 0;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: "${text.trim()}"`);

    if (consoleErrors.length > 0) {
      failures++;
      console.log(`FAIL  ${label}: console error: ${consoleErrors[0]}`);
    }
    await ctx.close();
  } catch (error) {
    failures++;
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await browser.close();
console.log(failures === 0 ? '\nwallet UI check: all holdings visible' : `\nwallet UI check: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
