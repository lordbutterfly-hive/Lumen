/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * SAFE-EXTERNAL-LINK self-test (WORK-LINK spec B1, 2026-08-30).
 *
 * apps/blog has no unit test runner wired (see market/curve.selftest.ts and
 * lib/vsc/payload-contract.selftest.ts for the full audit of why — no
 * jest/vitest anywhere). Same established shape: a plain assertion script
 * with its own `check`, exit 1 on any failure.
 *
 * Run:
 *   cd apps/blog && npx tsx components/safe-external-link.selftest.ts
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS UNDER TEST, AND WHAT THIS CAN AND CANNOT PROVE.
 *
 * `SafeExternalLink` is a React component and this repo cannot render one,
 * so the proof is in TWO halves:
 *
 *  (a) THE GATE. `isSafeExternalHref` / `safeHostname` are plain functions —
 *      exported from the same module `SafeExternalLink` calls internally —
 *      called directly here with the exact hostile inputs the spec named:
 *      `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative
 *      `//evil.com`, embedded credentials, uppercase-obfuscated scheme,
 *      percent-encoded obfuscation, and the empty string. Plus two valid
 *      cases (http + https) so the gate is proven to accept something, not
 *      just reject everything.
 *
 *  (b) THE WIRING. A source scan of `safe-external-link.tsx` itself: the
 *      component must call the gate BEFORE returning an `<a>`/`Link`, and
 *      must have a `return null` reachable when the gate fails. This is the
 *      "does not silently revert to rendering the raw href" guard — same
 *      technique (comment stripping, a non-vacuity check so the scan can
 *      never pass on having read nothing) as
 *      `features/retention/lib/__tests__/ladder.test.ts`'s own call-site
 *      scan and `features/creator-tokens/market/buy-preview.selftest.ts`'s
 *      wiring half.
 *
 * Neither half renders a DOM. What this proves: the exact function the
 * component calls refuses every hostile shape below, and the component's
 * own source really does gate on that function before it can render
 * anything. It does NOT prove React actually mounts `null` correctly (that
 * is React's own contract, not this codebase's).
 */

import { isSafeExternalHref, safeHostname } from './safe-external-link';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

console.log('── THE GATE — hostile inputs, each must be refused\n');

const HOSTILE: Record<string, string> = {
  'javascript: scheme': 'javascript:alert(1)',
  'data: scheme': 'data:text/html,<script>alert(1)</script>',
  'vbscript: scheme': 'vbscript:msgbox(1)',
  'file: scheme': 'file:///etc/passwd',
  'protocol-relative (network-path reference)': '//evil.com/steal-session',
  'embedded credentials (http)': 'http://user:pass@evil.com',
  'embedded credentials (https)': 'https://user:pass@evil.com/path',
  'uppercase/mixed-case obfuscation': 'JaVaScRiPt:alert(1)',
  'percent-encoded obfuscation (no literal colon)': 'javascript%3Aalert(1)',
  'whitespace-obfuscated scheme': 'java\tscript:alert(1)',
  'empty string': '',
  'not a string at all (runtime defence — a caller ignoring the type)': undefined as unknown as string,

  /*
   * ★★★ THE SCHEMES ONLY THE ALLOWLIST CATCHES (added 2026-08-30).
   *
   * A mutation sweep found that four of the five defensive lines in
   * `isSafeExternalHref` had NO coverage: the http/https allowlist and the
   * `sanitizeUrl` denylist each masked the other, because every hostile input
   * above is caught by BOTH. Deleting either line on its own left this suite
   * green — so the file's own claim that the two checks are "deliberately
   * redundant, if check 1 is ever loosened check 2 still stands" was untested
   * in both directions.
   *
   * It is not a symmetric pair. `sanitizeUrl` is a DENYLIST, so it accepts every
   * scheme nobody thought to list. Each entry below was verified to pass
   * `sanitizeUrl` and to be refused only by the allowlist. Without these, the
   * next person who deletes the "redundant" protocol line ships live
   * `intent://` and `ms-msdt:` links driven by attacker-controlled chain
   * metadata — anyone can write anything into their own Hive profile.
   */
  'ftp: (denylist accepts it, allowlist must not)': 'ftp://evil.com/x',
  'ws: (denylist accepts it)': 'ws://evil.com',
  'intent: android intent launch': 'intent://evil#Intent;scheme=http;end',
  'ms-msdt: (the Follina delivery scheme)': 'ms-msdt:/id',
  'view-source:': 'view-source:http://evil.com',
  'jar: (archive URL handler)': 'jar:http://evil.com!/x',
  'chrome: internal page': 'chrome://settings',
  'steam: external app handler': 'steam://run/1',
  'mailto: (not a work link)': 'mailto:a@b.c',
  'tel: (not a work link)': 'tel:+123'
};

for (const [name, href] of Object.entries(HOSTILE)) {
  check(`isSafeExternalHref REJECTS ${name}`, isSafeExternalHref(href) === false, `input=${JSON.stringify(href)}`);
  check(`safeHostname REJECTS ${name} (returns null, never the raw string)`, safeHostname(href) === null);
}

console.log('\n── THE GATE — valid inputs, each must be accepted\n');

const VALID: [string, string, string][] = [
  ['plain http', 'http://alice.com', 'alice.com'],
  ['https with path and query', 'https://alice.dev/work?ref=lumen', 'alice.dev'],
  ['https with a subdomain, matching the display convention (hostname, not the full URL)', 'https://portfolio.alice.io/index', 'portfolio.alice.io']
];

for (const [name, href, expectedHost] of VALID) {
  check(`isSafeExternalHref ACCEPTS ${name}`, isSafeExternalHref(href) === true, href);
  check(
    `safeHostname(${JSON.stringify(href)}) is the HOSTNAME only, not the raw URL`,
    safeHostname(href) === expectedHost,
    `got ${JSON.stringify(safeHostname(href))}`
  );
}

console.log('\n── NEGATIVE CONTROL — the gate genuinely distinguishes these, not a rubber stamp\n');
{
  check(
    'a rejected href and an accepted href do not collapse to the same verdict',
    isSafeExternalHref('javascript:alert(1)') !== isSafeExternalHref('https://alice.com'),
    'both true or both false would mean the gate is not actually gating'
  );
}

console.log('\n── WIRING — the component really calls the gate before it can render anything\n');
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const src = readFileSync(join(__dirname, 'safe-external-link.tsx'), 'utf8');

  // Comment stripping so a doc-comment quoting "return null" or "isSafeExternalHref"
  // in prose cannot count as the code doing it. Same stripper as the precedent files.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Non-vacuity: a scan that read nothing must FAIL, never silently pass.
  check('the scan read the component source', src.length > 500, `${src.length} bytes`);

  const componentStart = code.indexOf('export function SafeExternalLink');
  check('SafeExternalLink was located in the stripped source', componentStart >= 0);
  const componentBody = componentStart >= 0 ? code.slice(componentStart, componentStart + 400) : '';

  check(
    'SafeExternalLink calls the gate (isSafeExternalHref) inside its own body',
    componentBody.includes('isSafeExternalHref(href)'),
    componentBody
  );
  check(
    'SafeExternalLink has a reachable `return null`',
    /return\s+null/.test(componentBody),
    componentBody
  );
  // ★ THE REVERT GUARD. If a future edit deletes the gate call and goes back to
  // unconditionally rendering `href`, this must fail: the ONLY way this check
  // passes is if the gate call precedes the `<a>`/`Link` render, i.e. the order
  // in the source text is (gate check) then (return null) then (render).
  const gateIdx = componentBody.indexOf('isSafeExternalHref(href)');
  const returnNullIdx = componentBody.indexOf('return null');
  const renderIdx = componentBody.search(/<Link|<a\s/);
  check(
    'THE REVERT GUARD: gate check, then return null, both come BEFORE the element is rendered',
    gateIdx >= 0 && returnNullIdx > gateIdx && renderIdx > returnNullIdx,
    `gate@${gateIdx} returnNull@${returnNullIdx} render@${renderIdx}`
  );
}

console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
