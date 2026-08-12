/**
 * ★★★ PROOF THAT A CHAIN MUTE IS NOW READ AS A BLOCK — DRIVEN AGAINST THE
 * RUNNING DEV SERVER.
 *
 *   QA_BASE=http://localhost:3000 node qa/harness/chain-mute-block-merge-proof.mjs
 *
 * Owner ruling (2026-08-12): "there should be no muted list. its all block
 * list... if someone mutes on peakd it should be treated as blocked on
 * Lumen." Before this change, `bridge.get_follow_list(name, 'muted')` was
 * never read anywhere in the block-filter pipeline — a PeakD/Ecency mute did
 * nothing on Lumen. This script proves the merge against REAL chain data
 * (`lordbutterfly`'s own 22 real mutes), not a fixture.
 *
 * NO WRITES ARE MADE TO CHAIN OR TO `lumen_block`. Every assertion below reads
 * real, pre-existing state — `lordbutterfly`'s mutes and two real threads he
 * and a third party already commented on. There is nothing to clean up.
 *
 * ★ THE VACUOUS-PASS TRAP, closed the way the brief warns about: most of
 * `lordbutterfly`'s 22 mutes are spam accounts Hivemind's OWN indexes already
 * exclude from most listings (`bridge.get_account_posts sort=comments`
 * returned ZERO rows for all 22 when this script was being written — that is
 * Hivemind filtering, not this feature). So every "is it hidden" assertion
 * below is preceded by an independent "is it actually there to hide"
 * assertion — from the raw chain directly for effect (B), and from a signed-
 * out render of the same page for effect (A) — so a check that finds nothing
 * FAILS instead of passing by accident.
 *
 * Two real fixtures, chosen by walking `lordbutterfly`'s posts for direct
 * comments from any of his 22 muted accounts (see the exploration notes in
 * this session's scratchpad; re-derived live below via `RAW CONTROL` so the
 * script does not depend on stale notes):
 *
 *   EFFECT_B_POST — a post `lordbutterfly` AUTHORED, with direct top-level
 *   comments from FOUR of his muted accounts (obaro, wallay, stefy.music,
 *   isbelhiv02). Owner-side: must be hidden from EVERY reader.
 *
 *   EFFECT_A_POST — a post authored by someone else entirely (@samostically),
 *   which @obaro also commented on. Nobody there has muted or blocked obaro
 *   except `lordbutterfly` himself (via his own chain mutes) — so this
 *   isolates effect (A): only `lordbutterfly`'s OWN view should be missing
 *   the comment; a signed-out reader of the exact same page must still see it.
 */
import { chromium } from 'playwright';
import { signedInStorageState } from '/home/clauderfly/hive-blog-rebuild/qa/harness/session.mjs';

const BASE = process.env.QA_BASE || 'http://localhost:3000';
const CHROME_PATH = '/home/clauderfly/opt/chrome-root/opt/google/chrome/chrome';

const OWNER = 'lordbutterfly';
const THIRD_PARTY = 'hbd-temp';

const EFFECT_B_POST = {
  author: 'lordbutterfly',
  permlink: 'call-to-action-vibes--heartfeldt-community-cross-promotion',
  category: 'hive-140169'
};
const EFFECT_B_MUTED_COMMENTERS = ['obaro', 'wallay', 'stefy.music', 'isbelhiv02'];

const EFFECT_A_POST = {
  author: 'samostically',
  permlink: 'the-neoxian-city-talent-hunt--february-edition',
  category: 'hive-177682'
};
const EFFECT_A_MUTED_AUTHOR = 'obaro';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, evidence) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${evidence ? `  -- ${evidence}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${evidence ? `  -- ${evidence}` : ''}`);
  }
}
function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

async function signedInState(username) {
  const state = await signedInStorageState(username);
  // ★ Cookie was minted `secure: true` (right for the TLS front other proofs in
  // this directory target). This script deliberately targets the plain-HTTP dev
  // server on :3000 instead (ports 3100/3200/3300 and .next-prod* are off
  // limits), and a browser refuses to SEND a Secure cookie over http:// — so
  // without this the session would silently be dropped and every "signed in"
  // check below would actually be running signed out. Same fix
  // `f6-gap3-settings-proof.mjs` already uses for the same reason.
  state.cookies = state.cookies.map((c) => ({ ...c, secure: false }));
  return state;
}

/* ------------------------------------------------------------------ */
/* raw chain reads (bypass Lumen entirely)                             */
/* ------------------------------------------------------------------ */

async function chainCall(method, params, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch('https://api.hive.blog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
      });
      const body = await res.json();
      if (body.result !== undefined) return body.result;
      lastError = new Error(`RPC error: ${JSON.stringify(body.error ?? body)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Lumen HTTP reads (through OUR server)                               */
/* ------------------------------------------------------------------ */

function cookieHeader(state) {
  return (state?.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
}

async function lumenDiscussion(post, cookie) {
  const headers = cookie ? { cookie } : {};
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(
      `${BASE}/api/discussion?author=${post.author}&permlink=${post.permlink}`,
      { headers }
    );
    const body = await res.json().catch(() => null);
    const map = body?.discussion ?? {};
    const values = Object.values(map);
    last = {
      status: res.status,
      degraded: body?.degraded ?? null,
      count: values.length,
      authors: values.map((e) => e.author),
      rootPresent: values.some((e) => e.author === post.author && e.permlink === post.permlink)
    };
    if (last.rootPresent) return last;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return last;
}

async function main() {
  console.log(`Target: ${BASE}`);
  console.log(`Owner (real Hive account, 22 real chain mutes): @${OWNER}`);

  /* ================================================================ */
  section('0. RAW CONTROL — confirm the fixtures on the chain directly, bypassing Lumen entirely');
  /* ================================================================ */

  const muted22 = await chainCall('bridge.get_follow_list', { observer: OWNER, follow_type: 'muted' });
  check(
    `@${OWNER} has a real, non-empty chain mute (ignore) list`,
    Array.isArray(muted22) && muted22.length > 0,
    `${muted22?.length ?? 0} entries`
  );
  const mutedNames = new Set((muted22 ?? []).map((r) => r.name));
  for (const name of EFFECT_B_MUTED_COMMENTERS) {
    check(`@${name} is genuinely on @${OWNER}'s real chain mute list`, mutedNames.has(name));
  }
  check(`@${EFFECT_A_MUTED_AUTHOR} is genuinely on @${OWNER}'s real chain mute list`, mutedNames.has(EFFECT_A_MUTED_AUTHOR));

  const rawB = await chainCall('bridge.get_discussion', {
    author: EFFECT_B_POST.author,
    permlink: EFFECT_B_POST.permlink
  });
  const rawBAuthors = Object.values(rawB ?? {}).map((e) => e.author);
  check(
    'RAW CHAIN: the effect-(B) thread has entries at all (not empty/deleted)',
    rawBAuthors.length > 5,
    `${rawBAuthors.length} entries`
  );
  for (const name of EFFECT_B_MUTED_COMMENTERS) {
    check(
      `RAW CHAIN: @${name}'s comment genuinely exists, unfiltered, on this thread`,
      rawBAuthors.includes(name),
      `present=${rawBAuthors.includes(name)}`
    );
  }
  const rawBControlAuthor = rawBAuthors.find((a) => !EFFECT_B_MUTED_COMMENTERS.includes(a) && a !== EFFECT_B_POST.author);
  check(
    'RAW CHAIN: the thread also has at least one commenter NOT on the mute list (precision control)',
    Boolean(rawBControlAuthor),
    rawBControlAuthor ?? 'none found'
  );

  const rawA = await chainCall('bridge.get_discussion', {
    author: EFFECT_A_POST.author,
    permlink: EFFECT_A_POST.permlink
  });
  const rawAAuthors = Object.values(rawA ?? {}).map((e) => e.author);
  check(
    `RAW CHAIN: @${EFFECT_A_MUTED_AUTHOR}'s comment exists on the effect-(A) thread (owned by @${EFFECT_A_POST.author}, NOT @${OWNER})`,
    rawAAuthors.includes(EFFECT_A_MUTED_AUTHOR),
    `authors=${JSON.stringify(rawAAuthors)}`
  );

  /* ================================================================ */
  section('1. EFFECT (B) — @' + OWNER + "'s chain mutes hide replies from EVERY reader, not just him");
  /* ================================================================ */

  const anonB = await lumenDiscussion(EFFECT_B_POST, null);
  check(
    'baseline: Lumen serves the effect-(B) thread to an anonymous reader at all',
    anonB.rootPresent,
    `root present=${anonB.rootPresent} degraded=${anonB.degraded} count=${anonB.count}`
  );
  for (const name of EFFECT_B_MUTED_COMMENTERS) {
    check(
      `★ ANONYMOUS reader does not receive @${name}'s comment under @${OWNER}'s post`,
      !anonB.authors.includes(name),
      `present=${anonB.authors.includes(name)}`
    );
  }
  check(
    'unrelated commenter is still served (this is not the whole thread going empty)',
    rawBControlAuthor ? anonB.authors.includes(rawBControlAuthor) : true,
    `@${rawBControlAuthor} present=${rawBControlAuthor ? anonB.authors.includes(rawBControlAuthor) : 'n/a'}`
  );

  const thirdPartyState = await signedInState(THIRD_PARTY);
  const thirdB = await lumenDiscussion(EFFECT_B_POST, cookieHeader(thirdPartyState));
  check(
    `★ a THIRD-PARTY signed-in reader (@${THIRD_PARTY}, who has muted/blocked nobody here) also does not receive any of the ${EFFECT_B_MUTED_COMMENTERS.length} muted commenters' replies`,
    EFFECT_B_MUTED_COMMENTERS.every((name) => !thirdB.authors.includes(name)),
    `authors present: ${EFFECT_B_MUTED_COMMENTERS.filter((n) => thirdB.authors.includes(n)).join(', ') || 'none'}`
  );
  check(
    'and the third party still gets the unrelated commenter, and the same entry count as the anonymous view',
    (rawBControlAuthor ? thirdB.authors.includes(rawBControlAuthor) : true) && thirdB.count === anonB.count,
    `count ${thirdB.count} vs anon ${anonB.count}`
  );

  /* ================================================================ */
  section('2. EFFECT (A) — @' + OWNER + "'s OWN view drops a muted author elsewhere; nobody else's does");
  /* ================================================================ */

  // The route effect (B) runs on does NOT apply effect (A) (see block-filter.ts's
  // header) -- so this must still include @obaro's comment for EVERY caller. If
  // it did not, the browser check below would be proving nothing.
  const anonA = await lumenDiscussion(EFFECT_A_POST, null);
  check(
    `/api/discussion for the effect-(A) thread includes @${EFFECT_A_MUTED_AUTHOR} for an unauthenticated caller (effect B does not apply to this thread)`,
    anonA.authors.includes(EFFECT_A_MUTED_AUTHOR),
    `authors=${JSON.stringify(anonA.authors)}`
  );

  const listAsOwner = await fetch(`${BASE}/api/lite/block/list`, {
    headers: { cookie: cookieHeader(await signedInState(OWNER)) }
  }).then((r) => r.json());
  check(
    `/api/lite/block/list as @${OWNER} exists and reports ok`,
    listAsOwner?.ok === true,
    JSON.stringify(listAsOwner).slice(0, 160)
  );
  check(
    `@${EFFECT_A_MUTED_AUTHOR} is present in @${OWNER}'s merged block list (names[])`,
    (listAsOwner?.names ?? []).includes(EFFECT_A_MUTED_AUTHOR),
    `names sample=${JSON.stringify((listAsOwner?.names ?? []).slice(0, 5))}`
  );
  const chainPeer = (listAsOwner?.peers ?? []).find((p) => p.name === EFFECT_A_MUTED_AUTHOR);
  check(
    `@${EFFECT_A_MUTED_AUTHOR}'s row in peers[] is identified as chain-sourced ('chain' or 'both'), not a bare Lumen block`,
    Boolean(chainPeer) && (chainPeer.source === 'chain' || chainPeer.source === 'both'),
    JSON.stringify(chainPeer)
  );

  const browser = await chromium.launch({ executablePath: CHROME_PATH });
  try {
    const postUrl = `${BASE}/${EFFECT_A_POST.category}/@${EFFECT_A_POST.author}/${EFFECT_A_POST.permlink}`;

    // Control: SIGNED OUT, the exact same page. Must still show the comment --
    // otherwise "absent for lordbutterfly" would prove nothing (vacuous pass).
    //
    // ★ RETRIED, NOT A SINGLE SHOT. `/api/discussion` answers from a public Hive
    // node and this codebase's own history records it going empty and coming
    // back on the same thread seconds apart (`block-proof.mjs`'s `fetchThread`
    // note). A reload-and-recheck loop tells a real upstream hiccup apart from
    // an actual regression; a single attempt cannot.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      let total = 0;
      let obaroCount = 0;
      for (let attempt = 1; attempt <= 3 && total === 0; attempt += 1) {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page
          .waitForSelector('[data-testid="comment-list-item"]', { timeout: 20000 })
          .catch(() => {});
        await page.waitForTimeout(2500);
        total = await page.locator('[data-testid="comment-list-item"]').count();
        if (total === 0 && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      check('CONTROL (signed out): the comment thread actually rendered items', total > 0, `${total} items`);
      obaroCount = await page
        .locator('[data-testid="comment-list-item"]', { hasText: EFFECT_A_MUTED_AUTHOR })
        .count();
      check(
        `CONTROL (signed out): @${EFFECT_A_MUTED_AUTHOR}'s comment IS rendered on the page`,
        obaroCount > 0,
        `matches=${obaroCount}`
      );
      await context.close();
    }

    // Test: signed in as the OWNER of the mute. Same page, same comment -- must
    // now be gone, while the rest of the thread still renders.
    {
      const state = await signedInState(OWNER);
      const context = await browser.newContext({ storageState: state });
      const page = await context.newPage();
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[data-testid="comment-list-item"]', { timeout: 60000 });
      await page.waitForTimeout(2500);
      const items = page.locator('[data-testid="comment-list-item"]');
      const total = await items.count();
      check(
        `signed in as @${OWNER}: the thread still renders OTHER comments (not a blanket empty page)`,
        total > 0,
        `${total} items`
      );
      const obaroItems = page.locator('[data-testid="comment-list-item"]', { hasText: EFFECT_A_MUTED_AUTHOR });
      const obaroCount = await obaroItems.count();
      check(
        `★ signed in as @${OWNER}: @${EFFECT_A_MUTED_AUTHOR}'s comment is ABSENT from the rendered page`,
        obaroCount === 0,
        `matches=${obaroCount}`
      );
      await context.close();
    }

    /* ================================================================ */
    section('3. SETTINGS — the ONE merged Block list, chain entries identifiable');
    /* ================================================================ */
    {
      const state = await signedInState(OWNER);
      const context = await browser.newContext({ storageState: state });
      const page = await context.newPage();
      await page.goto(`${BASE}/@${OWNER}/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[data-testid="settings-blocked-accounts"]', { timeout: 60000 });
      // ★ POLL, DO NOT GUESS A FIXED DELAY. This card shares the page with
      // `SettingsForm` (avatar/cover image loads, several other queries) and a
      // cold mount of the whole settings page was measured taking well over 2s
      // to get past the skeleton for a 22-row chain-merged list — a short fixed
      // wait here read as "0 rows" and would have reported this feature as
      // broken. Wait for the skeleton to actually go away instead.
      await page
        .waitForSelector('[data-testid="settings-blocked-accounts-skeleton"]', { state: 'detached', timeout: 20000 })
        .catch(() => {});
      await page.waitForTimeout(500);

      // Only ONE moderation card on the page now.
      const legacyCards = await page.locator('[data-testid="settings-moderation-lists"], [data-testid="settings-muted-users"]').count();
      check('the old separate "Moderation lists" / "Muted Users" cards are gone', legacyCards === 0, `found=${legacyCards}`);

      const rows = page.locator('[data-testid="settings-blocked-row"]');
      const rowCount = await rows.count();
      check('the merged Blocked list actually rendered rows (not empty/loading)', rowCount > 0, `${rowCount} rows`);

      const chainRows = page.locator('[data-testid="settings-blocked-row"][data-source="chain"], [data-testid="settings-blocked-row"][data-source="both"]');
      const chainRowCount = await chainRows.count();
      check(
        `at least one row is identified as chain-sourced (${EFFECT_B_MUTED_COMMENTERS.length + 1} known real mutes among @${OWNER}'s 22)`,
        chainRowCount > 0,
        `${chainRowCount} chain-sourced rows`
      );

      const badgeCount = await page.locator('[data-testid="settings-blocked-chain-badge"]').count();
      check('the chain badge/hint text is rendered on those rows', badgeCount > 0, `${badgeCount} badges`);

      const cardText = await page.locator('[data-testid="settings-blocked-accounts"]').innerText();
      const namedInList = [...EFFECT_B_MUTED_COMMENTERS, EFFECT_A_MUTED_AUTHOR].filter((n) => cardText.includes(n));
      check(
        'known real chain-muted names from the fixture appear in the rendered list',
        namedInList.length > 0,
        `found: ${namedInList.join(', ') || 'none'}`
      );

      const unblockButtons = await page.locator('[data-testid="settings-unblock-button"]').count();
      check('every row still offers the SAME "Unblock" action (no separate label)', unblockButtons === rowCount, `${unblockButtons} buttons for ${rowCount} rows`);

      await context.close();
    }

    /* ================================================================ */
    section('4. THE FOUR LEGACY /lists/* ROUTES REDIRECT TO THE ONE BLOCK LIST');
    /* ================================================================ */
    for (const path of ['muted', 'blacklisted', 'followed_blacklists', 'followed_muted_lists']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${BASE}/@${OWNER}/lists/${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Next's dev-mode redirect renders a 1s meta-refresh rather than a bare
      // HTTP 3xx (confirmed live: `<meta http-equiv="refresh" content="1;url=...">`
      // in the served HTML) -- wait for the actual navigation it triggers. A
      // route that has never been hit this dev-server run also pays an on-demand
      // compile the FIRST time, so this polls rather than trusting one timeout.
      for (let attempt = 0; attempt < 3 && !page.url().includes('/settings'); attempt += 1) {
        await page.waitForURL(/\/settings(#.*)?$/, { timeout: 8000 }).catch(() => {});
      }
      await page.waitForTimeout(500);
      const landed = page.url();
      check(
        `/@${OWNER}/lists/${path} redirects to the Settings Block list, not a 404 or its own page`,
        landed.includes('/settings') && landed.includes('blocked-accounts'),
        landed
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nHARNESS ERROR:', error);
  process.exit(2);
});
