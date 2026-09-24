/**
 * `isMissingPostError` (lib/lite/hive-missing-post.ts): the two ways a node says a
 * comment is not there, and nothing else. Exact error bodies captured from the Hive
 * testnet (hived 1.28.3) on 2026-09-24. Plain assertions; exits 0 when all pass.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/hive-missing-post.test.ts
 */
import { isMissingPostError } from '../lite/hive-missing-post';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) failures++;
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}

const neverExisted = { code: -32602, message: 'Assert Exception', data: { code: 10, extension: { assertion_expression: 'Post alice/p1 does not exist' } } };
const deleted = { code: -31999, data: 'Post alice/p1 was deleted 1 time(s)', message: 'Invalid parameters' };
check('never existed: missing', isMissingPostError(neverExisted, 'alice', 'p1'));
check('deleted: missing', isMissingPostError(deleted, 'alice', 'p1'));
check('another post named in the error: not this one', !isMissingPostError(deleted, 'alice', 'p2') && !isMissingPostError(neverExisted, 'bob', 'p1'));
check('a real failure is never read as missing', !isMissingPostError({ code: -32603, message: 'Internal Error', data: 'timeout' }, 'alice', 'p1'));
check('no error object: not missing', !isMissingPostError(undefined, 'alice', 'p1') && !isMissingPostError('x', 'alice', 'p1'));

// eslint-disable-next-line no-console
console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
