/**
 * The lite profile merge (lib/profile/lite-profile-merge.ts): own posts and reblogs on
 * one time cursor. Plain assertions; exits 0 when all pass.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/lite-profile-merge.test.ts
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { mergeLiteProfile, parseLiteCursor } from '../profile/lite-profile-merge';
import { ulidFloor } from '../lite/ids';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}
const e = (p: string, ms: number) => ({ entry: { permlink: p } as unknown as Entry, ms });

const m = mergeLiteProfile([e('own3', 3000), e('own1', 1000)], [e('rb4', 4000), e('rb2', 2000)], 3, false, false);
check('newest first across both', m.entries.map((x) => x.permlink).join(',') === 'rb4,own3,rb2', m.entries.map((x) => x.permlink).join(','));
check('next page starts after the last shown', m.nextBefore === 'bt:2000', String(m.nextBefore));
const end = mergeLiteProfile([e('own1', 1000)], [], 3, false, false);
check('everything shown and nothing more: no next page', end.nextBefore === null);
const full = mergeLiteProfile([e('a', 5)], [], 3, true, false);
check('a full source means there may be more', full.nextBefore === 'bt:5');

const c = parseLiteCursor('bt:2000');
check("'bt:' cursor: posts before that millisecond, reblogs older than it", c.postsBefore === ulidFloor(2000) && c.time?.getTime() === 2000);
const legacy = parseLiteCursor(ulidFloor(1234567) .slice(0, 10) + 'ABCDEFGHJKMNPQRS');
check('a legacy post-id cursor keeps working (and gives its time)', legacy.postsBefore?.endsWith('ABCDEFGHJKMNPQRS') === true && legacy.time?.getTime() === 1234567);
check('no cursor: from the newest', parseLiteCursor(undefined).time === null);

// eslint-disable-next-line no-console
console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
