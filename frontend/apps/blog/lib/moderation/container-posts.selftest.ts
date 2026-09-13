/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * container-posts.selftest.ts
 *
 * Run: cd apps/blog && npx tsx lib/moderation/container-posts.selftest.ts
 *
 * The interesting assertion is the LAST one. Two lists of container accounts
 * exist - this module's and `PopularConfig.container_accounts` in recsys - and
 * they exist separately on purpose: this one has to work when recsys does not,
 * which is exactly when it matters, so it cannot read the value from the
 * service. Two hand-maintained copies of the same fact is how a filter quietly
 * stops covering an account, so the Python file is parsed and compared here.
 */
import { readFileSync } from 'node:fs';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { CONTAINER_ACCOUNTS, filterContainerEntries, isContainerEntry } from './container-posts';

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`ok    ${name}${detail ? `\n        ${detail}` : ''}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

/**
 * A stand-in carrying only the two fields the predicate reads. The cast is
 * confined to this one helper rather than sprayed over every call site: `Entry`
 * is a large wax type and building a real one here would be noise, but a cast
 * at each use would let a wrong shape through unnoticed at any of them.
 */
const entry = (author: string, permlink = 'whatever', chainAuthor?: string): Entry =>
  ({ author, permlink, ...(chainAuthor ? { _lite: { chainAuthor } } : {}) }) as unknown as Entry;

// ---- 0. the instrument ----
{
  const before = failures.length;
  check('instrument: a false condition is recorded', false);
  const caught = failures.length === before + 1;
  failures.pop();
  check('instrument: check() detects false', caught);
}

// ---- 1. the rule is the AUTHOR, not the permlink ----
check('a container account is caught whatever the post is named',
  isContainerEntry(entry('ecency.waves', 'waves-20260913vb5x2z')) &&
  isContainerEntry(entry('ecency.waves', 'a-completely-different-scheme')) &&
  isContainerEntry(entry('ecency.waves', '')));
check('★ THE POINT: a renamed permlink scheme cannot route around it',
  isContainerEntry(entry('peak.snaps', 'snap-2026-09-13')) &&
  isContainerEntry(entry('leothreads', 'thread-99')));
check('an ordinary author is never caught, whatever THEY name a post',
  !isContainerEntry(entry('alice', 'waves-of-grain')) &&
  !isContainerEntry(entry('bob', 'snap-container-happy-accident')) &&
  !isContainerEntry(entry('carol', 'leothread-my-holiday')));
check('★ our own publisher is NOT on the list, or the lite product would vanish',
  !isContainerEntry(entry('hbd-temp', 'lumen-01kzj8284fmc7tp1f549mc7zef')) &&
  !isContainerEntry(entry('hbd-temp', 'lumen-c-01kzj8284fmc7tp1f549mc7zef')));
check('case and empties are handled rather than crashing',
  isContainerEntry(entry('ECENCY.WAVES')) && !isContainerEntry(null) && !isContainerEntry(undefined));

// ---- 2. the relabelled-entry hole the ban filter already knew about ----
check('a container hiding in _lite.chainAuthor is still caught',
  isContainerEntry(entry('someone-else', 'x', 'peak.snaps')));

// ---- 3. the filter keeps everything else, in order ----
{
  const page = [entry('alice', 'a'), entry('ecency.waves', 'waves-1'), entry('bob', 'b'), entry('peak.snaps', 'snap-container-2'), entry('carol', 'c')];
  const out = filterContainerEntries(page);
  check('the three real posts survive, in their original order',
    out.length === 3 && out.map((e) => e.author).join(',') === 'alice,bob,carol',
    out.map((e) => e.author).join(','));
  check('empty and null pages are not a crash',
    filterContainerEntries([]).length === 0 && filterContainerEntries(null).length === 0 && filterContainerEntries(undefined).length === 0);
  check('a page of nothing but containers filters to empty, not to itself',
    filterContainerEntries([entry('ecency.waves', 'w'), entry('leothreads', 'l')]).length === 0);
}

// ---- 4. THE DRIFT GUARD: this list and recsys's must name the same accounts ----
{
  const CONFIG = '/mnt/o/Lumen/recsys/recsys/config.py';
  let py = '';
  try { py = readFileSync(CONFIG, 'utf8'); } catch { /* reported below */ }
  check('recsys config.py was readable', py.length > 1000, `${py.length} bytes from ${CONFIG}`);
  if (py) {
    const block = /container_accounts:\s*frozenset\[str\]\s*=\s*frozenset\(\s*\{([^}]*)\}/m.exec(py);
    check('container_accounts was found in recsys config.py', block !== null,
      block ? '' : 'the declaration moved or changed shape - this guard is now blind, fix it rather than deleting it');
    if (block) {
      const theirs = new Set([...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]));
      const ours = new Set(CONTAINER_ACCOUNTS);
      const missingHere = [...theirs].filter((a) => !ours.has(a));
      const missingThere = [...ours].filter((a) => !theirs.has(a));
      check('★ the two container lists name exactly the same accounts',
        missingHere.length === 0 && missingThere.length === 0,
        `recsys has ${[...theirs].sort().join(', ')} | this module has ${[...ours].sort().join(', ')}`);
      check('…and the guard is not vacuous: both lists are non-empty', theirs.size > 0 && ours.size > 0);
    }
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
