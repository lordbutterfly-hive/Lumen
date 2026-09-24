/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for container FAMILIES (quote reblog spec v2, section 2; migration 0049).
 *
 * Drives the real container repository and helpers against a real Postgres, because
 * the risk being covered lives in SQL: the per-(account, family) live-container index,
 * the family filter on every reservation, and concurrent reservations across both
 * families. Nothing here broadcasts.
 *
 *   F1  a lite reservation still yields a `lumen-c-` container with family 'lite'
 *   F2  a quote reservation yields a `lumen-q-` container with family 'quote', while
 *       the lite container stays live (one live container PER FAMILY, not per account)
 *   F3  a full quote container rolls to a NEW quote container; the lite one is untouched
 *   F4  40 concurrent reservations split across both families: no error, every slot
 *       lands in its own family, never more than one live container per family
 *   F5  the permlink helpers: prefix per family, recognition of both, and a `lumen-q-`
 *       child is never mistaken for a Lumen POST container
 *
 * SAFETY. This script writes and TRUNCATES `lumen_container`. It refuses to start
 * unless LITE_DATABASE_URL names a database ending in `_selftest`.
 *
 * Run (from apps/blog), after `CREATE DATABASE lite_selftest` on a throwaway server:
 *   LITE_DATABASE_URL=postgresql://user:pw@127.0.0.1:5433/lite_selftest \
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/lite/publisher/container-family.selftest.ts
 */
const DB_URL = process.env.LITE_DATABASE_URL || '';
if (!/_selftest(\?.*)?$/.test(DB_URL)) {
  console.error(
    'REFUSING TO RUN: LITE_DATABASE_URL must point at a scratch database whose name ends in "_selftest".\n' +
      'This script TRUNCATES lumen_container.'
  );
  process.exit(1);
}

import { query } from '../db/pool';
import { runMigrations } from '../db/migrate';
import * as containers from '../repositories/container-repository';
import { containerFamilyOf, isContainerPermlink } from './container';

const PUB = 'test-publisher';
let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

async function liveCount(family: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) n FROM lumen_container WHERE hive_author = $1 AND family = $2 AND status IN ('opening','open')`,
    [PUB, family]
  );
  return Number(rows[0].n);
}

async function main(): Promise<void> {
  const ran = await runMigrations();
  console.log(`migrations applied this run: ${ran.length ? ran.join(', ') : 'none (already current)'}`);
  await query('TRUNCATE lumen_container CASCADE');

  console.log('F1  lite reservation unchanged');
  const lite = await containers.reserveChildSlot(PUB, 1000);
  check('lite container permlink starts lumen-c-', lite.hivePermlink.startsWith('lumen-c-'), lite.hivePermlink);
  check("lite container family is 'lite'", lite.family === 'lite', lite.family);

  console.log('F2  quote reservation alongside a live lite container');
  const quote = await containers.reserveChildSlot(PUB, 3, 'quote');
  check('quote container permlink starts lumen-q-', quote.hivePermlink.startsWith('lumen-q-'), quote.hivePermlink);
  check("quote container family is 'quote'", quote.family === 'quote', quote.family);
  check('the lite container is still live (one live PER FAMILY)', (await liveCount('lite')) === 1 && (await liveCount('quote')) === 1);
  const again = await containers.reserveChildSlot(PUB, 1000);
  check('a later lite reservation still lands in the SAME lite container', again.containerId === lite.containerId, `${again.containerId} vs ${lite.containerId}`);

  console.log('F3  a full quote container rolls within its family');
  await containers.reserveChildSlot(PUB, 3, 'quote');
  await containers.reserveChildSlot(PUB, 3, 'quote'); // 3 of 3 now
  const rolled = await containers.reserveChildSlot(PUB, 3, 'quote');
  check('the 4th quote slot opens a NEW quote container', rolled.containerId !== quote.containerId && rolled.family === 'quote', rolled.containerId);
  const old = await containers.findByPermlink(PUB, quote.hivePermlink);
  check('the full quote container is closed', old?.status === 'closed', old?.status);
  check('the lite container was not touched by the roll', (await containers.findLive(PUB, 'lite'))?.containerId === lite.containerId);
  check('findLive(quote) returns the new quote container', (await containers.findLive(PUB, 'quote'))?.containerId === rolled.containerId);

  console.log('F4  40 concurrent reservations across both families');
  await query('TRUNCATE lumen_container CASCADE');
  const jobs = Array.from({ length: 40 }, (_, i) => containers.reserveChildSlot(PUB, 7, i % 2 === 0 ? 'lite' : 'quote'));
  const results = await Promise.allSettled(jobs);
  const rejected = results.filter((r) => r.status === 'rejected');
  check('no reservation failed', rejected.length === 0, rejected.map((r) => String((r as PromiseRejectedResult).reason)).join(' | '));
  const got = results.filter((r): r is PromiseFulfilledResult<Awaited<(typeof jobs)[number]>> => r.status === 'fulfilled').map((r) => r.value);
  const wrongFamily = got.filter((c, i) => c.family !== (i % 2 === 0 ? 'lite' : 'quote'));
  check('every slot landed in the family it asked for', wrongFamily.length === 0, `${wrongFamily.length} wrong`);
  const { rows: counts } = await query<{ family: string; slots: string; containers: string }>(
    `SELECT family, sum(child_count) slots, count(*) containers FROM lumen_container WHERE hive_author = $1 GROUP BY family ORDER BY family`,
    [PUB]
  );
  check(
    '20 slots per family, spread over ceil(20/7) = 3 containers each',
    JSON.stringify(counts.map((r) => [r.family, Number(r.slots), Number(r.containers)])) === JSON.stringify([['lite', 20, 3], ['quote', 20, 3]]),
    JSON.stringify(counts)
  );
  check('never more than one live container per family', (await liveCount('lite')) <= 1 && (await liveCount('quote')) <= 1);

  console.log('F5  permlink helpers');
  check("containerPermlink(id, 'quote') uses lumen-q-", containers.containerPermlink('01ABC', 'quote') === 'lumen-q-01abc');
  check('containerPermlink(id) defaults to lumen-c-', containers.containerPermlink('01ABC') === 'lumen-c-01abc');
  check('both families are recognised as containers', isContainerPermlink('lumen-c-01abc') && isContainerPermlink('lumen-q-01abc'));
  check("family of lumen-q- is 'quote', of lumen-c- is 'lite'", containerFamilyOf('lumen-q-x') === 'quote' && containerFamilyOf('lumen-c-x') === 'lite');
  check('a lite post permlink is not a container', !isContainerPermlink('lumen-01m14tvm9fkp5kgnccpxgm8vy7') && containerFamilyOf('lumen-rq-abc') === null);

  await query('TRUNCATE lumen_container CASCADE');
  console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL — the self-test threw:', error);
  process.exit(1);
});
