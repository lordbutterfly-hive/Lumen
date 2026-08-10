/**
 * PROOF, IN A REAL BROWSER: the composer and the reply box tell the truth about
 * whether your text is saved, and they do not resurrect what you just published.
 *
 *   NODE_EXTRA_CA_CERTS=$HOME/hive-blog-rebuild/.tls/cert.pem \
 *     node qa/harness/composer-draft-guards-proof.mjs
 *
 * Needs the app running behind the TLS front (QA_BASE, default
 * https://localhost:3443) — see qa-harness.mjs for why HTTPS is not optional.
 *
 * ★ WHY A BROWSER AND NOT A UNIT TEST. Every defect here is a browser fact:
 * localStorage refusing a write, a debounce timer firing after a navigation
 * starts, a React state flag that nothing resets. None of them are visible to
 * `tsc`, and a unit test of a helper proves nothing about whether the SCREEN
 * ever calls it — which is exactly how the composer shipped a `setStorageItem`
 * that reported failure to a caller that threw the answer away.
 *
 * WHAT IS PROVEN
 *   A. REPLY DRAFTS SAY WHEN THEY ARE NOT SAVED. With localStorage full, typing
 *      a reply raises a persistent banner. Before this build the reply box
 *      discarded the boolean `setStorageItem` returns, so the box looked
 *      identical to a saved draft right up until the text was gone.
 *   B. THE PREVIEW GATE IS REALLY WIRED. A 250k-character draft pauses the live
 *      preview, and "Render preview anyway" really renders it. (That the opt-in
 *      then RE-ARMS for a far larger document is proven by
 *      features/post-editor/__tests__/preview-gate.test.ts — driving a
 *      multi-megabyte paste through CodeMirror is not something Playwright can
 *      do honestly.)
 *   C. PUBLISHING LEAVES NO DRAFT BEHIND. ★ HONESTY NOTE: this assertion holds
 *      on the fixed tree AND on a tree with `stopAutoSave()` removed, so it does
 *      NOT by itself prove the draft-resurrection fix. The race needs the 500 ms
 *      auto-save timer to fire before React commits the post-submit reset render
 *      (whose effect cleanup clears it), and that ordering could not be forced
 *      here. The timer genuinely is not cleared at the point `removePost()` runs
 *      — read `use-post-form-actions.ts` — so the fix is a deterministic close of
 *      a race this harness can only observe by luck. Treat C as a regression
 *      guard, not as proof.
 *   D. …AND THE "NOT BEING SAVED" BANNER DOES NOT SURVIVE THE PUBLISH. It was
 *      only ever cleared inside the auto-save effect, which stops running the
 *      moment a submit succeeds, so a banner that was true at submit time stayed
 *      on screen over the now-empty form.
 *
 * The publish itself is stubbed at the network boundary (`page.route` on
 * /api/lite/posts): this box publishes to MAINNET, and none of A-D is about what
 * the server does with the post.
 */

import { openApp, BASE } from '../../qa-harness.mjs';

let failures = 0;
let checks = 0;
const ok = (condition, name, evidence) => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}\n          ${evidence}`);
};

/**
 * Fill localStorage until it refuses even a TINY write.
 *
 * ★ Filling with big blobs alone is not enough and quietly breaks the test. The
 * first 512 KB write to throw can still leave hundreds of KB free, a draft is a
 * few dozen bytes, and `setStorageItem` retries after `cleanupExpiredItems()` —
 * so the save succeeds, no banner appears, and the assertion fails for a reason
 * that has nothing to do with the code under test. Descending block sizes close
 * the gap: the last one proves a 256-byte write is impossible, which is the
 * precondition the banner is about.
 */
const FILL_STORAGE = `(() => {
  const sizes = [512 * 1024, 64 * 1024, 4 * 1024, 256];
  let n = 0;
  let last = 'never threw — storage did not fill';
  for (const size of sizes) {
    const blob = 'x'.repeat(size);
    try {
      for (let i = 0; i < 500; i++, n++) window.localStorage.setItem('__qa_fill_' + n, blob);
      last = 'never threw at ' + size + ' bytes';
      break;
    } catch (e) {
      last = String(e).slice(0, 80) + ' (at ' + size + ' bytes)';
    }
  }
  return { filled: n, error: last };
})()`;

/**
 * Keep topping up until a write the size of a real draft is impossible.
 *
 * ★ The descending fill above proves a 256-BYTE write fails at that instant, and
 * that is not the same thing. `setStorageItem` retries after
 * `cleanupExpiredItems()`, which deletes expired entries and can free exactly
 * enough for a small draft — so the save succeeded on some runs and not others,
 * and the assertion that depends on it passed or failed with the same build.
 * A flaky precondition is worse than no test: it turns a real regression into
 * "probably just the harness".
 */
const TOP_UP_STORAGE = `(() => {
  // ★ PROBE AT THE SIZE OF A REAL DRAFT, NOT A ROUND NUMBER. Probing with 4 KB
  // and topping up in 1 KB blocks leaves up to 4 KB free, and a composer draft of
  // a title plus a sentence is ~400 bytes — so it saved fine, no banner appeared,
  // and the check failed while reporting the store as "full". The probe has to be
  // smaller than the thing whose write must fail.
  const PROBE = 256;
  const probe = 'p'.repeat(PROBE);
  let added = 0;
  for (let i = 0; i < 20000; i++) {
    try {
      window.localStorage.setItem('__qa_probe', probe);
      window.localStorage.removeItem('__qa_probe');
    } catch (e) {
      return { added, roomForProbe: false, probeBytes: PROBE };
    }
    try {
      window.localStorage.setItem('__qa_top_' + i, 'y'.repeat(PROBE));
      added++;
    } catch (e) {
      return { added, roomForProbe: true, probeBytes: PROBE };
    }
  }
  return { added, roomForProbe: true, probeBytes: PROBE };
})()`;

const UNFILL_STORAGE = `(() => {
  for (let n = 0; n < 4000; n++) {
    window.localStorage.removeItem('__qa_fill_' + n);
    window.localStorage.removeItem('__qa_top_' + n);
  }
  return window.localStorage.length;
})()`;

console.log(`base=${BASE}`);
const { browser, page, username } = await openApp({ loggedIn: true, label: 'qadraft' });
console.log(`signed in as ${username}\n`);

/* ══════════════════════════════════════ A · reply drafts report a failed save */
console.log('A. a reply that cannot be saved says so');
{
  // Any post with a reply box. This one is a Lumen-native post that exists on
  // this box; the reply box is the same component everywhere.
  await page.goto(`${BASE}/blog/@bravouyuce/lite-01kzcdvp09gnb0cybzwawfbpp1`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });
  // ★ WAIT FOR THE CLIENT TO KNOW WHO IT IS. The reply affordance renders in two
  // shapes under the SAME testid (content.tsx:987 vs :1047): the real one when
  // `user.isLoggedIn`, and a login-dialog stub when not. Clicking too early gets
  // the stub, no editor mounts, and the test reads as "reply is broken" when it
  // only means hydration had not finished.
  await page.waitForFunction(
    () => document.body.innerText.length > 200,
    undefined,
    { timeout: 60000 }
  ).catch(() => {});
  await page.waitForTimeout(12000);

  // ★ AND KEEP ASKING UNTIL IT OPENS. `user.isLoggedIn` only becomes true on the
  // client once /api/users/me resolves, and until then the SAME testid renders a
  // signed-out stub whose click does nothing visible. One click plus a fixed
  // sleep is a coin flip — measured opening on one run and not the next with the
  // identical build. Retrying is waiting for hydration, not hiding a defect.
  const replyOpener = page.locator('[data-testid="comment-reply"]').first();
  const opened = await replyOpener.count();
  const editor = page.locator('[data-testid="reply-editor"] .cm-content').first();
  let attempts = 0;
  while (attempts < 16 && (await editor.count()) === 0) {
    attempts += 1;
    await replyOpener.click().catch(() => {});
    await page.waitForTimeout(2500);
  }
  const haveEditor = (await editor.count()) > 0;
  const loginDialog = await page.locator('[role="dialog"]').count();
  ok(
    haveEditor,
    'the reply box opened',
    `reply buttons=${opened} attempts=${attempts} editors=${await editor.count()} login-dialogs=${loginDialog}` +
      (loginDialog ? ' — the client rendered the signed-OUT reply stub' : '')
  );

  if (haveEditor) {
    const fill = await page.evaluate(FILL_STORAGE);
    const top = await page.evaluate(TOP_UP_STORAGE);
    ok(
      fill.filled > 0 && /Quota|exceed|QUOTA/i.test(fill.error) && top.roomForProbe === false,
      'localStorage is genuinely full (the precondition, MEASURED, not assumed)',
      `${fill.filled} blocks then ${fill.error}; +${top.added} x ${top.probeBytes}B; ` +
        `a ${top.probeBytes}-byte write now fails=${!top.roomForProbe}`
    );

    await editor.click();
    await page.keyboard.type('a reply that will not fit anywhere', { delay: 10 });
    // The reply auto-save is debounced 500 ms.
    await page.waitForTimeout(2000);

    const banner = page.locator('[data-testid="reply-draft-save-failed"]');
    const shown = await banner.count();
    const text = shown ? (await banner.first().innerText()).replace(/\s+/g, ' ') : '';
    ok(shown > 0, 'the "this reply is not being saved" banner is shown', text || 'no banner in the DOM');

    await page.evaluate(UNFILL_STORAGE);
  }
}

/* ═══════════════════════════════════ B · the preview size gate is really wired */
console.log('\nB. the live-preview size gate is wired to the composer');
{
  const key = `postData-new-${username}`;
  // Seed the composer's own draft store with a document over the 200k gate. This
  // is the same key `use-post-form-state.ts` hydrates from, so the editor comes
  // up holding it — the only way to get a quarter of a million characters into
  // CodeMirror without pretending a keyboard can do it.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.evaluate(
    ([storageKey]) => {
      const body = 'lorem ipsum dolor sit amet. '.repeat(9000); // ~252k chars
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          value: {
            title: 'A very large draft',
            postArea: body,
            postSummary: '',
            tags: 'test',
            author: '',
            category: 'blog',
            beneficiaries: [],
            maxAcceptedPayout: 1000000,
            payoutType: '50%'
          },
          expiresAt: Date.now() + 86400000,
          createdAt: Date.now()
        })
      );
      return body.length;
    },
    [key]
  );

  await page.goto(`${BASE}/submit.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(9000);

  const paused = page.locator('[data-testid="preview-too-large"]');
  ok(
    (await paused.count()) > 0,
    'a 252k-character draft pauses the live preview',
    (await paused.count()) ? (await paused.first().innerText()).replace(/\s+/g, ' ').slice(0, 120) : 'gate not shown'
  );

  const anyway = page.locator('[data-testid="render-huge-preview"]');
  if (await anyway.count()) {
    await anyway.click();
    await page.waitForTimeout(4000);
    ok(
      (await paused.count()) === 0,
      '"Render preview anyway" really renders it',
      `gate elements remaining=${await paused.count()}`
    );
  } else {
    ok(false, '"Render preview anyway" really renders it', 'opt-in button not found');
  }

  await page.evaluate(([storageKey]) => window.localStorage.removeItem(storageKey), [key]);
}

/* ════════════════════════ C + D · publishing clears the draft and the banner */
console.log('\nC. publishing does not resurrect the draft, and clears the banner');
{
  const key = `postData-new-${username}`;
  // Stub the publish at the network boundary — this box publishes to MAINNET and
  // none of what is under test here is about the server's half.
  await page.route('**/api/lite/posts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    // A beat of latency so the auto-save timer scheduled just before Submit is
    // still pending when the publish resolves — that is the race being tested.
    await new Promise((r) => setTimeout(r, 200));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', post: { postId: 'qa-stubbed-post' } })
    });
  });

  await page.goto(`${BASE}/submit.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(8000);

  const body = page.locator('.cm-content').first();
  await body.click();
  await page.keyboard.type('This body is long enough to be a real post about nothing at all.', { delay: 5 });
  await page.waitForTimeout(1200);

  const tags = page.locator('input[name="tags"], input#tags').first();
  if (await tags.count()) await tags.fill('test');

  // ★ TITLE LAST, ON PURPOSE. `title` is un-debounced, so filling it schedules
  // the 500 ms auto-save immediately; submitting within that window is exactly
  // the state in which the old code wrote the published draft back.
  const title = page.locator('input[name="title"], input#title').first();
  await title.fill('QA draft-resurrection check');

  const submit = page.getByRole('button', { name: /^Submit$/ }).first();
  ok((await submit.count()) > 0, 'the composer offered a Submit button', `count=${await submit.count()}`);
  await submit.click({ timeout: 20000 }).catch((e) => console.log(`      submit click: ${String(e).slice(0, 80)}`));

  // Well past the 500 ms auto-save debounce.
  await page.waitForTimeout(4000);

  const stored = await page.evaluate(([storageKey]) => window.localStorage.getItem(storageKey), [key]);
  ok(
    stored === null,
    'the published draft is NOT written back to localStorage',
    stored === null ? `${key} absent` : `${key} present again: ${stored.slice(0, 90)}…`
  );

  const banner = await page.locator('[data-testid="draft-save-failed"]').count();
  ok(banner === 0, 'no stale "draft is not being saved" banner survives the publish', `banners=${banner}`);
}

/* ══════════ D · a banner that WAS true at submit time does not outlive the post */
console.log('\nD. the "not being saved" banner does not survive a successful publish');
{
  await page.goto(`${BASE}/submit.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(8000);

  const fill = await page.evaluate(FILL_STORAGE);
  ok(
    fill.filled > 0 && /Quota|exceed|QUOTA/i.test(fill.error),
    'localStorage is genuinely full (the precondition, not assumed)',
    `wrote ${fill.filled} blocks then: ${fill.error}`
  );
  // ★ AND DROP THE COMPOSER'S OWN KEY. The auto-save writes `postData-new-<user>`
  // on mount, so by the time storage is filled that key already EXISTS — and a
  // browser will happily overwrite an existing entry with a similar-sized one out
  // of the space the old value frees. The draft then saves fine, no banner
  // appears, and the assertion below fails for a reason that has nothing to do
  // with the code under test. Deleting it first means the next auto-save has to
  // allocate, which is what "storage is full" is supposed to prevent.
  await page.evaluate(
    ([storageKey]) => window.localStorage.removeItem(storageKey),
    [`postData-new-${username}`]
  );
  const top = await page.evaluate(TOP_UP_STORAGE);
  ok(
    top.roomForProbe === false,
    'a draft-sized write is now genuinely impossible (MEASURED)',
    `+${top.added} x ${top.probeBytes}B; a ${top.probeBytes}-byte write now fails=${!top.roomForProbe}`
  );

  const body = page.locator('.cm-content').first();
  await body.click();
  await page.keyboard.type('A post typed while there is nowhere to save it.', { delay: 5 });
  const tags = page.locator('input[name="tags"], input#tags').first();
  if (await tags.count()) await tags.fill('test');
  const title = page.locator('input[name="title"], input#title').first();
  await title.fill('QA stuck-banner check');
  await page.waitForTimeout(2500);

  const before = await page.locator('[data-testid="draft-save-failed"]').count();
  ok(before > 0, 'the composer warns that the draft is not being saved', `banners=${before}`);

  await page
    .getByRole('button', { name: /^Submit$/ })
    .first()
    .click({ timeout: 20000 })
    .catch((e) => console.log(`      submit click: ${String(e).slice(0, 80)}`));
  await page.waitForTimeout(4000);

  const after = await page.locator('[data-testid="draft-save-failed"]').count();
  // ★ A check with nothing to inspect must FAIL: if the banner was never raised,
  // "it is gone afterwards" is true of a page that never had one, and would pass
  // over a completely broken build.
  ok(
    before > 0 && after === 0,
    'and the warning is gone once the post is published',
    `banners before=${before} after=${after}` +
      (before === 0 ? ' — VACUOUS: the banner never appeared, so this proves nothing' : '') +
      (after ? ' — it is cleared only inside the auto-save effect, which stops running after a submit' : '')
  );

  await page.evaluate(UNFILL_STORAGE);
}

await browser.close();
console.log(`\ncomposer-draft-guards-proof: ${checks - failures}/${checks} passed`);
if (failures) {
  console.log(`${failures} FAILING CHECK(S)`);
  process.exitCode = 1;
}
