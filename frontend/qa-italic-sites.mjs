/**
 * DID THE §4 ITALIC EDITS ACTUALLY REACH THE SCREEN?
 *
 * 13 sites were changed in source. `qa-verify-all.mjs` proves the policy holds
 * (nothing forbidden is italic) but sees only a couple of italic elements on the
 * routes it visits, because an empty-state string does not render until its state
 * is empty. A source edit is not evidence; this hunts each empty state down and
 * measures the computed `font-style` on the element that carries the copy.
 *
 * Anything it cannot reach is reported as UNREACHED, never as passing.
 */
import { openApp, BASE } from './qa-harness.mjs';

const { browser, page } = await openApp({ loggedIn: true });
const rows = [];
const probe = async (label, route, finder, prep) => {
  try {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    if (prep) await prep();
    const r = await page.evaluate((f) => {
      const el = eval(f)();
      if (!el) return null;
      const s = getComputedStyle(el);
      return { italic: /italic|oblique/.test(s.fontStyle), size: s.fontSize, text: (el.textContent || '').trim().slice(0, 52) };
    }, finder);
    rows.push({ label, route, ...(r || { unreached: true }) });
  } catch (e) {
    rows.push({ label, route, unreached: true, err: String(e).slice(0, 50) });
  }
};

const byText = (re) => `() => [...document.querySelectorAll('p,div,span')].filter(e=>!e.children.length).find(e=>/${re}/i.test((e.textContent||'').trim()))`;

await probe('404 body (§5.12)', '/this-route-does-not-exist', byText('link may be wrong|couldn|doesn'));
await probe('no Meritum held', '/wallet/tokens', byText("don.t hold any Meritum"));
await probe('no asks yet', '/wallet/tokens', byText('No asks yet'));
await probe('studio: no requests', '/creators/studio', byText('No requests waiting'));
await probe('studio: no services', '/creators/studio', byText("haven.t posted any services"));
// ★ TARGET THE BODY, NOT THE TITLE. This empty state is a semibold TITLE
// ("No price history yet") plus a prose BODY. §4's editorial voice is the body;
// the title is a label and stays roman. A first version searched for the title
// text, found the roman title, and reported a failure against an element that was
// never supposed to change.
await probe('price chart empty (body)', '/creators/@magi.contracts', byText('price above is live from the curve'));
await probe('blocked list empty', '/@lordbutterfly/settings', byText("blocked|You have not blocked"));
await probe('profile has no posts', '/@stoodkev', byText("hasn.t|no posts|not posted"));
await probe('following empty', '/@lordbutterfly/following', byText('Not following anyone yet|following anyone'));
await probe('notifications empty', '/', byText('No notifications yet'), async () => {
  const bell = page.locator('[data-testid="nav-notifications"]');
  if (await bell.count()) { await bell.click({ timeout: 10000 }).catch(() => {}); await page.waitForTimeout(2500); }
});
await probe('feed status strip', '/', byText('ranking is warming up|Showing popular posts'));
await probe('end-of-list line', '/@lordbutterfly/communities', byText("that.s everything|all caught up|end of"));

console.log(`${'site'.padEnd(26)} ${'route'.padEnd(28)} result`);
let proven = 0, unreached = 0, failed = 0;
for (const r of rows) {
  if (r.unreached) { unreached++; console.log(`${r.label.padEnd(26)} ${r.route.padEnd(28)} UNREACHED (state not shown)`); continue; }
  if (r.italic) { proven++; console.log(`${r.label.padEnd(26)} ${r.route.padEnd(28)} ITALIC ✓  ${r.size}  "${r.text}"`); }
  else { failed++; console.log(`${r.label.padEnd(26)} ${r.route.padEnd(28)} ROMAN ✗  ${r.size}  "${r.text}"`); }
}
console.log(`\nproven italic on screen: ${proven}   still roman: ${failed}   state never rendered: ${unreached}`);
if (failed) console.log('A ROMAN row means the edit did not reach that element — investigate before claiming the site is done.');
await browser.close();
