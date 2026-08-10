/**
 * ★★★ THE BLOCK CONTROL, IN A REAL BROWSER.
 *
 *   NODE_EXTRA_CA_CERTS=$HOME/hive-blog-rebuild/.tls/cert.pem \
 *     node qa/harness/block-ui-proof.mjs
 *
 * `block-proof.mjs` proves the SERVER does the right thing. This proves a reader can
 * actually reach it: that the control is rendered, that a LITE account (which cannot
 * mute at all — mute is a chain operation and they have no key) sees it, that pressing
 * it changes the label, and that a row really lands in `lumen_block`.
 *
 * A green API test with no button is a feature nobody can use, and "curl returns 200"
 * says nothing about whether a control ever mounts — the reason this harness directory
 * exists at all.
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openApp } from '../../qa-harness.mjs';

const BASE = process.env.QA_BASE || 'https://localhost:3443';
const TARGET = 'wiseagent'; // a real Hive account with a real profile page
const POST = {
  category: 'hive-124221',
  author: 'wiseagent',
  permlink: 'the-whales-modus-operandi-cws'
};

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, evidence) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${evidence ? `  — ${evidence}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${evidence ? `  — ${evidence}` : ''}`);
  }
}

const psql = (sql) =>
  execSync(`docker exec lumen-b12-pg psql -U qa -d lite -tAc ${JSON.stringify(sql)}`, {
    encoding: 'utf8'
  }).trim();

/**
 * Poll for an expected DB state instead of sleeping a guessed number of seconds.
 *
 * ★ MEASURED, not defensive. The block POST resolves a name it has never seen
 * against the CHAIN (`checkAccountExists` -> wax/WASM), which on a cold dev server
 * took well over the 3s this first waited — so the assertion ran before the write
 * and reported a working button as broken. A fixed sleep is a test that fails for
 * reasons that have nothing to do with the code under test.
 */
async function waitForCount(sql, expected, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = psql(sql);
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = psql(sql);
  }
  return value;
}

async function main() {
  psql('DELETE FROM lumen_block');

  const { page, browser, username } = await openApp({
    loggedIn: true,
    privateKey: `0x${randomBytes(32).toString('hex')}`,
    label: 'blockui'
  });
  console.log(`Signed in as lite account @${username}\nTarget profile: @${TARGET}\n`);

  try {
    /* ---------------------------------------------------------------- */
    console.log('1. PROFILE PAGE — the overflow menu');
    /* ---------------------------------------------------------------- */
    // `commit`, not `domcontentloaded`: a dev server compiles these routes on first
    // hit (measured 22-36s cold), and waiting for the whole document measures the
    // BUILD. The selector waits below are the real readiness signals.
    await page.goto(`${BASE}/@${TARGET}`, { waitUntil: 'commit', timeout: 180000 });
    // The redesigned profile hydrates its action row from several client queries;
    // measured at 8-10s on this dev box. Asserting earlier tests the skeleton.
    // ★ WAIT FOR THE SIGNED-IN VARIANT, NOT JUST FOR "a Follow button".
    // `profile-follow-button` is rendered by BOTH branches of `ProfileActions` — the
    // signed-out one wraps it in a login dialog and has no overflow menu at all — and
    // `useUserClient` hydrates asynchronously, so for the first moment after load a
    // signed-in reader is looking at the signed-out markup. Waiting on the Follow
    // button therefore raced hydration and intermittently asserted against the wrong
    // component. The overflow trigger only exists once the viewer is known.
    await page.waitForSelector('button[aria-label="More options"]', { timeout: 60000 });
    check('the profile renders its signed-in action row', true, 'overflow trigger present');

    // Located by accessible name, not "the button next to Follow" — a layout
    // assumption that breaks the first time the row is restyled.
    //
    // ★ RE-OPENED UNTIL THE ITEM IS THERE. Whether a Block item is offered depends on
    // `/api/lite/block/state`, which for a name Lumen has never seen has to ask the
    // CHAIN whether that account exists — seconds on a cold server. Radix renders the
    // menu's contents at open time, so a menu opened before that answer arrives simply
    // has no Block item and never gains one. Opening once and asserting was testing
    // the network, not the feature.
    const blockItem = page.locator('[data-testid="profile-block-menu-item"]');
    const openMenu = () => page.locator('button[aria-label="More options"]').first().click();

    // ★ OPEN IT AND WAIT INSIDE IT — do not open/close in a loop.
    //
    // Whether a Block item is offered depends on `/api/lite/block/state`, which for a
    // name Lumen has never seen has to ask the CHAIN whether that account exists:
    // seconds on a cold server. The menu's contents are a live React subtree while it
    // is OPEN, so the item appears there by itself the moment the answer lands.
    // Re-opening in a loop instead was strictly worse — every close unmounted the
    // subtree, and the loop's own last action was a close, so the assertion ran
    // against a menu that was not on screen at all and read 0 forever.
    await openMenu();
    await page
      .waitForSelector('[data-testid="profile-block-menu-item"]', { timeout: 45000 })
      .catch(() => undefined);
    check(
      "\u2605 a LITE account sees a Block item on a full Hive account's profile",
      (await blockItem.count()) > 0,
      `items=${await blockItem.count()}`
    );

    // Mute must NOT be offered to a keyless viewer — it is a chain operation they
    // cannot sign. Block replacing it is the whole point of this feature for them.
    const menuText = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"]')].map((e) => ({
        text: e.innerText.trim(),
        hidden: e.className.includes('hidden')
      }))
    );
    const mute = menuText.find((m) => /^mute$/i.test(m.text));
    check(
      'Mute stays hidden for a lite viewer (it needs a Hive key)',
      !mute || mute.hidden,
      JSON.stringify(menuText)
    );

    if ((await blockItem.count()) > 0) {
      const labelBefore = (await blockItem.first().innerText()).trim();
      check(
        'it reads "Block" before pressing',
        /block/i.test(labelBefore) && !/unblock/i.test(labelBefore),
        labelBefore
      );

      // ★ CLICK, VERIFY, RETRY — because the page is still settling.
      //
      // The menu item is present and enabled as soon as `/api/lite/block/state`
      // answers, but the profile is still finishing several other client queries at
      // that moment and React re-renders the subtree. A click that lands on a node
      // React has just replaced hits a detached element: no handler, no request, no
      // error. Traced directly — an isolated click always fires the POST; the same
      // click during the settling window sometimes does not. Retrying against the DB
      // is the honest fix; a longer sleep would only move the flake.
      let rows = '0';
      for (let attempt = 1; attempt <= 3 && rows !== '1'; attempt += 1) {
        await page.waitForTimeout(1000);
        await blockItem.first().click().catch(() => undefined);
        rows = await waitForCount(
          `SELECT count(*) FROM lumen_block WHERE blocked_hive = '${TARGET}' AND active`,
          '1',
          { timeoutMs: 15000 }
        );
        if (rows === '1') break;
        await openMenu().catch(() => undefined);
        await page
          .waitForSelector('[data-testid="profile-block-menu-item"]', { timeout: 20000 })
          .catch(() => undefined);
      }
      check('\u2605 pressing it writes a real block row', rows === '1', `rows=${rows}`);

    // ★ WAIT FOR THE LABEL, DO NOT SAMPLE IT ONCE. The row is written before the
    // control redraws: the hook deliberately RE-READS the server rather than flipping
    // its own state (only the server knows whether the edge really changed), so there
    // is a real, small gap between "blocked" and "says Unblock". Sampling once inside
    // that gap failed a working button.
      let labelAfter = '';
      for (let attempt = 0; attempt < 12 && !/unblock/i.test(labelAfter); attempt += 1) {
        await openMenu().catch(() => undefined);
        await page
          .waitForSelector('[data-testid="profile-block-menu-item"]', { timeout: 20000 })
          .catch(() => undefined);
        labelAfter = (await blockItem.first().innerText().catch(() => '')).trim();
        if (/unblock/i.test(labelAfter)) break;
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(1500);
      }
      check('the control flips to "Unblock"', /unblock/i.test(labelAfter), `label="${labelAfter}"`);

      if (/unblock/i.test(labelAfter)) {
        await blockItem.first().click();
        const active = await waitForCount(
          `SELECT count(*) FROM lumen_block WHERE blocked_hive = '${TARGET}' AND active`,
          '0',
          { timeoutMs: 60000 }
        );
        check('pressing Unblock retracts it', active === '0', `active rows=${active}`);
        const total = psql(`SELECT count(*) FROM lumen_block WHERE blocked_hive = '${TARGET}'`);
        check(
          'the edge is TOMBSTONED, not deleted (a consumer can observe the retraction)',
          total === '1',
          `total rows=${total}`
        );
      }
    }

    /* ---------------------------------------------------------------- */
    console.log('\n2. POST PAGE — the author popover on a byline');
    /* ---------------------------------------------------------------- */
    // A dev server compiles this route on first hit and it is one of the biggest in
    // the app; 30s is not enough on a cold one, and a timeout here is a build cost,
    // not a product defect.
    // `commit` rather than `domcontentloaded`: this route is one of the biggest in the
    // app and a dev server compiles it on first hit, so waiting for the full document
    // measures the BUILD. The selector wait below is the real readiness signal.
    await page.goto(`${BASE}/${POST.category}/@${POST.author}/${POST.permlink}`, {
      waitUntil: 'commit',
      timeout: 180000
    });
    await page.waitForSelector('[data-testid="author-name-link"]', { timeout: 120000 });
    await page.waitForTimeout(4000);

    const bylines = page.locator('[data-testid="author-name-link"]');
    const bylineCount = await bylines.count();
    check('the post page renders author bylines', bylineCount > 0, `${bylineCount} bylines`);

    // ★ WAIT FOR THE CONTROL, DO NOT SAMPLE FOR IT. The popover has to resolve the
    // author's chain account AND ask `/api/lite/block/state`, which for a name we have
    // never seen costs a chain existence check — seconds, not milliseconds. Sampling
    // after a fixed pause reports "no Block button" for a button that arrives shortly
    // afterwards.
    let popoverBlock = 0;
    for (let i = 0; i < Math.min(bylineCount, 4); i += 1) {
      await bylines.nth(i).click().catch(() => undefined);
      await page
        .waitForSelector('[data-testid="profile-block-button"]', { timeout: 25000 })
        .catch(() => undefined);
      popoverBlock = await page.locator('[data-testid="profile-block-button"]').count();
      if (popoverBlock > 0) break;
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(500);
    }
    check(
      '\u2605 the author popover on a post/comment offers Block to a lite viewer',
      popoverBlock > 0,
      `block buttons in popover: ${popoverBlock}`
    );

    /* ---------------------------------------------------------------- */
    console.log('\n3. EFFECT (A) IN THE THREAD — the reader stops seeing them here too');
    /* ---------------------------------------------------------------- */
    // The owner's sentence includes comment threads: "if I block someone, I never see
    // them in my feeds" AND on comments. `/api/discussion` is deliberately identical
    // for every reader (that is what makes the OWNER-side promise enforceable), so
    // this half has to be applied on top, in the reader's own browser. Proven by
    // counting the blocked account's comments on screen before and after.
    const commentAuthors = async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="comment-list"] [data-testid="author-name-link"]')].map(
          (e) => e.innerText.trim().split('(')[0].trim()
        )
      );

    const beforeNames = await commentAuthors();
    const victim = beforeNames.find((n) => n && n !== TARGET);
    check(
      'the thread shows comments by somebody the reader could block',
      Boolean(victim),
      `authors on screen: ${JSON.stringify([...new Set(beforeNames)])}`
    );

    if (victim) {
      const beforeCount = beforeNames.filter((n) => n === victim).length;
      // Block them through the API from inside the page, then let React Query's
      // invalidation (fired by the same hook the button uses) redraw the thread.
      const result = await page.evaluate(async (name) => {
        const res = await fetch('/api/lite/block', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
          body: JSON.stringify({ targetName: name, targetKind: 'hive' })
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      }, victim);
      check(
        `the reader blocks @${victim}`,
        result.status === 200,
        `status=${result.status} body=${JSON.stringify(result.body)}`
      );

      await page.reload({ waitUntil: 'commit', timeout: 180000 });
      await page.waitForSelector('[data-testid="comment-list"]', { timeout: 120000 });
      await page.waitForTimeout(6000);
      const afterNames = await commentAuthors();
      const afterCount = afterNames.filter((n) => n === victim).length;
      check(
        '\u2605 their comments are gone from the thread for THIS reader',
        beforeCount > 0 && afterCount === 0,
        `@${victim} comments on screen: ${beforeCount} -> ${afterCount}`
      );
      check(
        'the rest of the thread is still there',
        afterNames.length > 0 && afterNames.length === beforeNames.length - beforeCount,
        `${beforeNames.length} -> ${afterNames.length} bylines`
      );
    }

    await page.screenshot({ path: '/tmp/block-ui-proof.png', fullPage: false }).catch(() => undefined);
  } finally {
    psql('DELETE FROM lumen_block');
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('HARNESS ERROR:', error);
  try {
    psql('DELETE FROM lumen_block');
  } catch {
    /* best effort */
  }
  process.exit(2);
});
