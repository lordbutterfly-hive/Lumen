/**
 * The live-preview size gate — plain assertions, no test runner (this repo has
 * none, and adding one is out of scope; same shape as
 * features/retention/lib/__tests__/ladder.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/post-editor/__tests__/preview-gate.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHAT IS PROVEN
 *   1. Under the limit the gate never holds, opt-in or not — the guard must be
 *      invisible to every real article.
 *   2. Over the limit with no opt-in, it holds.
 *   3. THE BUG: after opting in, the gate COMES BACK for a document far larger
 *      than the one that was approved. Before this build the opt-in was a plain
 *      boolean that nothing reset, so one click disabled the 200k guard for the
 *      whole session and the next multi-MB paste re-froze the tab the feature
 *      exists to protect.
 *   4. …and it does NOT come back for ordinary editing after opting in, which is
 *      the half a naive "reset on every change" fix would break: a gate that
 *      re-arms mid-sentence is a gate nobody can get past.
 */

import { LIVE_PREVIEW_MAX_CHARS, previewGateHolds } from '../lib/preview-gate';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, evidence: string): void {
  checks += 1;
  if (!condition) failures.push(`${name} — ${evidence}`);
  // eslint-disable-next-line no-console
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}\n          ${evidence}`);
}

const LIMIT = LIVE_PREVIEW_MAX_CHARS;

// ── 1 · a real article never meets the guard ─────────────────────────────────
console.log('\n1. under the limit the gate never holds');
for (const size of [0, 1, 5_000, 60_000, LIMIT]) {
  check(
    `${size} chars, never opted in`,
    previewGateHolds(size, null) === false,
    `previewGateHolds(${size}, null) = ${previewGateHolds(size, null)}`
  );
  check(
    `${size} chars, previously opted in at 250k`,
    previewGateHolds(size, 250_000) === false,
    `previewGateHolds(${size}, 250000) = ${previewGateHolds(size, 250_000)}`
  );
}

// ── 2 · over the limit, un-opted-in, it holds ────────────────────────────────
console.log('\n2. over the limit with no opt-in, the gate holds');
for (const size of [LIMIT + 1, 250_000, 5_000_000]) {
  check(
    `${size} chars`,
    previewGateHolds(size, null) === true,
    `previewGateHolds(${size}, null) = ${previewGateHolds(size, null)}`
  );
}

// ── 3 · THE BUG · a later, much bigger document re-arms the gate ─────────────
console.log('\n3. the opt-in does NOT carry to a far larger document');
const approvedAt = 250_000;
for (const size of [approvedAt + LIMIT + 1, 1_000_000, 5_000_000]) {
  check(
    `approved ${approvedAt}, now ${size} chars`,
    previewGateHolds(size, approvedAt) === true,
    `previewGateHolds(${size}, ${approvedAt}) = ${previewGateHolds(size, approvedAt)} ` +
      `(a boolean opt-in would answer false here — that is the defect)`
  );
}

// ── 4 · …and it DOES carry across ordinary editing ───────────────────────────
console.log('\n4. the opt-in survives ordinary editing of the approved document');
for (const size of [approvedAt, approvedAt + 1, approvedAt + 50_000, approvedAt + LIMIT]) {
  check(
    `approved ${approvedAt}, now ${size} chars`,
    previewGateHolds(size, approvedAt) === false,
    `previewGateHolds(${size}, ${approvedAt}) = ${previewGateHolds(size, approvedAt)} ` +
      `(re-arming here would hide the preview mid-sentence)`
  );
}
// Shrinking below the limit must not hold either, whatever was approved.
check(
  'approved 5,000,000 then cut back to 1,000 chars',
  previewGateHolds(1_000, 5_000_000) === false,
  `previewGateHolds(1000, 5000000) = ${previewGateHolds(1_000, 5_000_000)}`
);

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\npreview-gate: ${checks - failures.length}/${checks} passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILING CHECK(S):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
