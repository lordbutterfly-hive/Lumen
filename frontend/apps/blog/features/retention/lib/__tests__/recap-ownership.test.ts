/**
 * The Monday recap must never report one person's week to another — plain
 * assertions, no test runner (this repo has none, and adding one is out of scope).
 *
 * RUN IT (from the repo root):
 *   npx ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node","esModuleInterop":true,"skipLibCheck":true,"jsx":"react-jsx","baseUrl":"apps/blog","paths":{"@ui/*":["../../packages/ui/*"],"@smart-signer/*":["../../packages/smart-signer/*"],"@/blog/*":["./*"]}}' \
 *     apps/blog/features/retention/lib/__tests__/recap-ownership.test.ts
 *
 * Exits 0 when every check passes, 1 otherwise.
 *
 * ★ WHY THIS EXISTS. On 2026-08-17 the owner screenshotted `/` while SIGNED OUT
 * and the recap card was showing "3 posts · 6 replies · active 3 of 7 days".
 * The act ledger behind it lives in localStorage, is scoped to the BROWSER, is
 * never cleared on sign-out, and recorded nothing about whose acts it held. So
 * it reported the previous reader's week to whoever opened the page next.
 *
 * The render gate is fixed separately in `weekly-recap-card.tsx`. This covers the
 * data layer, because a gate is one edit away from regressing while this ledger
 * outlives every session: `weekTally` must refuse to report a ledger that is not
 * the viewer's, and `recordRetentionAct` must not append one account's act to
 * another's ledger.
 */

// ── localStorage + window shims, installed BEFORE the module under test loads ──
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  }
};

/* eslint-disable @typescript-eslint/no-var-requires */
const { weekTally, recordRetentionAct } = require('../../components/retention-moments');
const userStore = require('@smart-signer/lib/auth/user-localstore');

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function signIn(username: string): void {
  userStore.saveUser({ isLoggedIn: !!username, username, avatarUrl: '', loginType: 'keychain', keyType: 'posting' });
}

// ── 1. a signed-in account's own acts are reported (the NEGATIVE CONTROL) ─────
//
// Without this, every "reports nothing" check below could pass for a weekTally
// that always returned zeroes — i.e. for a completely broken recap.
store.clear();
signIn('alice');
recordRetentionAct('post');
recordRetentionAct('reply');
recordRetentionAct('reply');
const alice = weekTally('alice');
check('alice sees her own posts', alice.posts === 1, `posts=${alice.posts}`);
check('alice sees her own replies', alice.replies === 2, `replies=${alice.replies}`);
check('alice has an active day', alice.activeDays === 1, `activeDays=${alice.activeDays}`);

// ── 2. THE REPORTED BUG: a logged-out viewer must get nothing ────────────────
const anon = weekTally('');
check('a signed-out viewer is reported NOTHING', anon.posts === 0 && anon.replies === 0 && anon.activeDays === 0,
  JSON.stringify(anon));

// ── 3. a different account on the same browser must get nothing ─────────────
const bob = weekTally('bob');
check("bob is not shown alice's week", bob.posts === 0 && bob.replies === 0 && bob.activeDays === 0, JSON.stringify(bob));

// ── 4. acts are never appended to someone else's ledger ─────────────────────
signIn('bob');
recordRetentionAct('post');
const bobOwn = weekTally('bob');
const aliceAfter = weekTally('alice');
check('bob accrues his own act', bobOwn.posts === 1, `posts=${bobOwn.posts}`);
check("bob's act did not join alice's ledger", bobOwn.replies === 0, `replies=${bobOwn.replies}`);
check("alice's ledger is not readable once bob owns the browser", aliceAfter.posts === 0, `posts=${aliceAfter.posts}`);

// ── 5. a legacy ledger with no owner belongs to nobody ──────────────────────
store.clear();
store.set('retention-acts-v1', JSON.stringify({ value: { days: { [new Date().toISOString().slice(0, 10)]: { post: 9 } } }, expiresAt: null }));
check('an un-owned legacy ledger is reported to nobody', weekTally('alice').posts === 0, JSON.stringify(weekTally('alice')));
check('…and not to an anonymous viewer either', weekTally('').posts === 0);

console.log(
  failures === 0
    ? `\nPASS — ${checks} checks, cross-account and signed-out leakage refused, with the negative control`
    : `\nFAIL — ${failures} of ${checks} checks failed`
);
process.exit(failures === 0 ? 0 : 1);
