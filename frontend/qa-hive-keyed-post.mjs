/**
 * END-TO-END: a HIVE-KEYED account posts short-form from the composer.
 *
 * ★★★ THIS BROADCASTS A REAL POST TO HIVE MAINNET. ★★★
 *
 * It exists because there is no other way to prove the Hive-keyed half of the
 * composer: that tier signs IN THE BROWSER, so nothing short of unlocking a
 * wallet with a real posting key and letting it broadcast actually tests it.
 * It publishes under LITE_FRONTEND_ACCOUNT_MAINNET using
 * LITE_PUBLISHER_POSTING_WIF, both read from apps/blog/.env.local inside this
 * process and never printed.
 *
 * Guarded so it cannot run by accident:
 *   QA_ALLOW_MAINNET_POST=yes NODE_EXTRA_CA_CERTS=$PWD/.tls/cert.pem \
 *     node qa-hive-keyed-post.mjs
 *
 * Verified 2026-08-06: broadcast_transaction fired, the post landed as a normal
 * root post (depth 0, category `lumen`), and the composer cleared.
 */
if (process.env.QA_ALLOW_MAINNET_POST !== 'yes') {
  console.error(
    'Refusing to run: this publishes a REAL post to Hive mainnet.\n' +
      'Re-run with QA_ALLOW_MAINNET_POST=yes if that is what you want.'
  );
  process.exit(2);
}
import { createRequire } from 'module';
import fs from 'fs';
const require_ = createRequire('/home/clauderfly/hive-blog-rebuild/apps/blog/package.json');
const { chromium } = require_('playwright');
const { sealData } = require_('iron-session');

const envText = fs.readFileSync('/home/clauderfly/hive-blog-rebuild/apps/blog/.env.local', 'utf8');
const pick = (k) => (envText.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1]?.trim();
const cookiePw = pick('DENSER_SERVER_SECRET_COOKIE_PASSWORD');
const wif = pick('LITE_PUBLISHER_POSTING_WIF');
const account = pick('LITE_FRONTEND_ACCOUNT_MAINNET');
if (!cookiePw || !wif || !account) { console.error('missing config'); process.exit(1); }
console.log('posting as @' + account + ' (key length ' + wif.length + ', not shown)');

const user = { isLoggedIn: true, username: account, avatarUrl: '', loginType: 'wif', keyType: 'posting', authenticateOnBackend: false, chatAuthToken: '', oauthConsent: {}, strict: false };
const sealed = await sealData({ user }, { password: cookiePw });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
await ctx.addCookies([{ name: 'app_session', value: sealed, domain: 'localhost', path: '/', secure: true }]);
const page = await ctx.newPage();
await page.addInitScript((u) => window.localStorage.setItem('user', JSON.stringify(u)), user);

const rpc = [];
page.on('request', (r) => { const m = (r.postData() || '').match(/"method":"([^"]+)"/); if (m) rpc.push(m[1]); });

await page.goto('https://localhost:3443/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(3500);
const marker = 'lumen-shortform-' + Date.now().toString(36);
const body = `Short-form composer check from a Hive-keyed account. ${marker}`;
await page.getByText("What's on your mind?").first().click();
const ta = page.locator('textarea').first();
await ta.waitFor({ state: 'visible', timeout: 10000 });
await ta.fill(body);
await page.getByRole('button', { name: /^Post$/ }).first().click();
await page.waitForTimeout(6000);

const dlg = page.locator('[role="dialog"]');
if (await dlg.count()) {
  await dlg.first().locator('input[name="password"]').fill(wif);
  await dlg.first().getByRole('button', { name: /Submit/ }).click();
  console.log('WIF submitted to the signer');
}
await page.waitForTimeout(30000);

console.log('URL after      :', page.url());
console.log('textarea now   :', JSON.stringify((await ta.inputValue().catch(() => '(gone)')).slice(0, 40)));
console.log('composer error :', (await page.locator('.text-red-600').innerText().catch(() => '')) || '(none)');
console.log('broadcast RPCs :', [...new Set(rpc)].filter((m) => /broadcast|transaction/i.test(m)));
console.log('MARKER         :', marker);
await browser.close();
