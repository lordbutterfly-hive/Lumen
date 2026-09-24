/**
 * `commentPageRedirectTarget` with reblog comments (quote reblog spec v2 6.2): a reblog
 * comment's own page never redirects to its container; a reply straight under one
 * opens the comment's page at that reply; ordinary comments keep redirecting to their
 * post. Plain assertions; exits 0 when all pass.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/comment-redirect-quote.test.ts
 */
import { commentPageRedirectTarget } from '../post/comment-redirect';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const quote = { depth: 1, author: 'alice', permlink: 'lumen-rq-abc', parent_author: 'pub', parent_permlink: 'lumen-q-01xyz', url: '/lumen/@pub/lumen-q-01xyz#@alice/lumen-rq-abc' };
check("a reblog comment's page stays (never the container)", commentPageRedirectTarget(quote) === null);

const reply = { depth: 2, author: 'bob', permlink: 're-1', parent_author: 'alice', parent_permlink: 'lumen-rq-abc', url: '/lumen/@pub/lumen-q-01xyz#@bob/re-1' };
const target = commentPageRedirectTarget(reply);
check("a reply under it opens the comment's page at the reply", target === '/lumen/@alice/lumen-rq-abc#@bob/re-1', String(target));

const deeper = { ...reply, depth: 3, url: '/lumen/@pub/lumen-q-01xyz#@carol/re-2' };
check('deeper replies are left alone (no redirect to the container)', commentPageRedirectTarget(deeper) === null);

const ordinary = { depth: 1, author: 'bob', permlink: 're-x', parent_author: 'alice', parent_permlink: 'a-post', url: '/hive-1/@alice/a-post#@bob/re-x' };
check('an ordinary comment still redirects to its post', commentPageRedirectTarget(ordinary) === '/hive-1/@alice/a-post#@bob/re-x');

// eslint-disable-next-line no-console
console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
