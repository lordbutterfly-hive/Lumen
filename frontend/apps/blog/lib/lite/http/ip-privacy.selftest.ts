/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * ★★★ NO RAW IP ADDRESS IS EVER PERSISTED (owner decision, 2026-08-28).
 *
 * THE DEFECT THIS EXISTS TO CATCH. `rate_counter.subject` stored `ip:<address>`
 * in cleartext, written by 19 API routes. Measured on the live QA database the
 * day this was written:
 *
 *     subject         | action             | window_key   | count
 *     ip:127.0.0.1    | creator_tokens_gql | d:2026-08-28 |   539
 *     ip:0:0:0:0::/64 | lookup             | d:2026-08-28 |    11
 *
 * That was the single largest thing the product had to disclose in a privacy
 * policy, and it was also the thing it did not need to keep: rate limiting has to
 * tell two callers apart, not know who they are. PeakD reached the same
 * conclusion and says so plainly: "IP addresses are hashed (one-way,
 * irreversible) before storage. We cannot identify you from view records."
 *
 * WHY A SCAN AND NOT ONLY A UNIT TEST. `ipKey()` on its own is easy to get right
 * and easy to bypass: the defect was never in a function, it was in ten call
 * sites that each interpolated the address directly. A unit test on the helper
 * would have passed on the old build. The scan is the half that fails on it.
 *
 * Run: cd apps/blog && npx tsx lib/lite/http/ip-privacy.selftest.ts
 * Add LITE_DATABASE_URL=... for the live-database half.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { ipBucket, ipKey } from './ip';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) console.log(`ok    ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The key must not contain the address, in any form.
// ---------------------------------------------------------------------------
const SAMPLES = ['203.0.113.7', '198.51.100.42', '2001:db8:85a3:1::/64', 'unattributed'];

for (const addr of SAMPLES) {
  const key = ipKey(addr);
  check(`ipKey(${addr}) does not contain the address`, !key.includes(addr), key);
  check(`ipKey(${addr}) is ip:<32 hex>`, /^ip:[0-9a-f]{32}$/.test(key), key);
}

// A dotted quad or an IPv6 group must not survive anywhere in the output.
for (const addr of SAMPLES) {
  const body = ipKey(addr).slice(3);
  check(
    `ipKey(${addr}) output holds no dotted quad`,
    !/\d{1,3}(\.\d{1,3}){3}/.test(body),
    body
  );
}

// ---------------------------------------------------------------------------
// 2. The limiter must still work: stable per address, distinct across addresses.
// ---------------------------------------------------------------------------
check('same address gives the same key', ipKey('203.0.113.7') === ipKey('203.0.113.7'));
check(
  'different addresses give different keys',
  ipKey('203.0.113.7') !== ipKey('203.0.113.8')
);
check(
  'the unattributed bucket is still one shared bucket',
  ipKey('unattributed') === ipKey('unattributed')
);
// The /64 collapse happens before hashing, so two addresses in one allocation
// must still land in one bucket — otherwise an IPv6 user mints unlimited buckets.
check(
  'two addresses in one IPv6 /64 share a bucket',
  ipKey(ipBucket('2001:db8:85a3:1:aaaa::1')) === ipKey(ipBucket('2001:db8:85a3:1:bbbb::2')),
  `${ipBucket('2001:db8:85a3:1:aaaa::1')} vs ${ipBucket('2001:db8:85a3:1:bbbb::2')}`
);
check(
  'a different /64 is a different bucket',
  ipKey(ipBucket('2001:db8:85a3:1::1')) !== ipKey(ipBucket('2001:db8:85a3:2::1'))
);

// ---------------------------------------------------------------------------
// 3. THE SCAN. No source file may build a rate-limit subject from an address.
//    This is the half that FAILS on the pre-2026-08-28 build.
// ---------------------------------------------------------------------------
const ROOTS = ['lib', 'app', 'features'];
const SKIP = new Set(['node_modules', '.next']);
const HELPER = 'lib/lite/http/ip.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith('.next')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes('.selftest.')) out.push(full);
  }
  return out;
}

const offenders: string[] = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file === HELPER) continue; // the helper is where the prefix legitimately lives
    scanned += 1;
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      // `ip:${...}` in a template literal — the exact shape the ten call sites used.
      if (/`ip:\$\{/.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
}
check(
  `no source file interpolates an address into a rate-limit subject (${scanned} files scanned)`,
  offenders.length === 0,
  offenders.join('\n      ')
);
check('the scan actually looked at something', scanned > 200, `${scanned} files`);

// ---------------------------------------------------------------------------
// 3b. The secret must fail CLOSED at boot, and must NOT break a build.
//     Resolved at module load, so each case needs its own process.
// ---------------------------------------------------------------------------
import { execFileSync } from 'child_process';

// A real file rather than `tsx -e`: an eval'd dynamic import does not resolve
// against this package the way an import in a file on disk does, and the first
// version of this check silently imported something that was not `ip.ts` at all.
const PROBE = join(process.cwd(), 'lib', 'lite', 'http', '.ip-boot-probe.mts');
writeFileSync(
  PROBE,
  "import { ipKey } from './ip';\nconsole.log(ipKey('203.0.113.7'));\n"
);

function bootWith(env: Record<string, string>): { ok: boolean; out: string } {
  try {
    const out = execFileSync('npx', ['tsx', PROBE], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const noSecretProd = bootWith({
  NODE_ENV: 'production',
  DENSER_SERVER_SECRET_COOKIE_PASSWORD: '',
  NEXT_PHASE: ''
});
check(
  'production with no secret REFUSES to boot',
  !noSecretProd.ok && /refusing to start/.test(noSecretProd.out),
  noSecretProd.out.slice(0, 200)
);

const buildNoSecret = bootWith({
  NODE_ENV: 'production',
  DENSER_SERVER_SECRET_COOKIE_PASSWORD: '',
  NEXT_PHASE: 'phase-production-build'
});
check(
  'a production BUILD with no secret still works',
  buildNoSecret.ok && /^ip:[0-9a-f]{32}$/.test(buildNoSecret.out.trim()),
  buildNoSecret.out.slice(0, 200)
);

const withSecret = bootWith({
  NODE_ENV: 'production',
  DENSER_SERVER_SECRET_COOKIE_PASSWORD: 'x'.repeat(48),
  NEXT_PHASE: ''
});
check(
  'production with a secret boots and keys',
  withSecret.ok && /^ip:[0-9a-f]{32}$/.test(withSecret.out.trim()),
  withSecret.out.slice(0, 200)
);
check(
  'a different secret produces a different key (it really is keyed)',
  withSecret.out.trim() !==
    bootWith({
      NODE_ENV: 'production',
      DENSER_SERVER_SECRET_COOKIE_PASSWORD: 'y'.repeat(48),
      NEXT_PHASE: ''
    }).out.trim(),
  withSecret.out.trim()
);

// ---------------------------------------------------------------------------
// 4. Live database half. Skipped without LITE_DATABASE_URL, and skipping SAYS so
//    rather than passing quietly — a check with nothing to inspect must not pass.
// ---------------------------------------------------------------------------
async function liveHalf(): Promise<void> {
  const url = process.env.LITE_DATABASE_URL;
  if (!url) {
    console.log('\nskip  live database half — set LITE_DATABASE_URL to run it');
    return;
  }
  // Write through the REAL repository first, with a real client address, so the
  // read below is never inspecting an empty table. Reading whatever happens to be
  // there would pass vacuously the moment the two-day purge had just run.
  const rateRepo = await import('../repositories/rate-limit-repository');
  const probeAddress = '203.0.113.7';
  await rateRepo.checkAndConsume(ipKey(probeAddress), 'selftest_probe', 1000, 'd:selftest');

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(
      `select subject from rate_counter where subject like 'ip:%'`
    );
    check('live rate_counter has rows to inspect', rows.length > 0, `${rows.length} rows`);
    check(
      'the row this test just wrote is present and hashed',
      rows.some((r: { subject: string }) => r.subject === ipKey(probeAddress)),
      `looked for ${ipKey(probeAddress)}`
    );
    check(
      'the probe address appears nowhere in the table',
      !rows.some((r: { subject: string }) => r.subject.includes(probeAddress)),
      probeAddress
    );
    const raw = rows
      .map((r: { subject: string }) => r.subject)
      .filter((s: string) => !/^ip:[0-9a-f]{32}$/.test(s));
    check(
      'no stored subject is a raw address',
      raw.length === 0,
      raw.slice(0, 5).join(', ')
    );
    await pool.query(`delete from rate_counter where action = 'selftest_probe'`);
  } finally {
    await pool.end();
  }
}

liveHalf()
  .catch((err) => {
    failures += 1;
    console.error(`FAIL  live half threw: ${err instanceof Error ? err.message : String(err)}`);
  })
  .finally(() => {
    try {
      unlinkSync(PROBE);
    } catch {
      /* already gone */
    }
    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
  });
