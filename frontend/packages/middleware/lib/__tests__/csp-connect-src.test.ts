/**
 * CSP connect-src — plain assertions, no test runner (this repo has none; same
 * shape as apps/blog/features/votes/__tests__/downvote-demotion.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     ../../packages/middleware/lib/__tests__/csp-connect-src.test.ts
 *
 * ★★★ WHY THIS EXISTS. On 2026-08-16 a real launch failed with "Your token was
 * not launched. Nothing was charged. ... (possible network or CORS error): POST
 * https://testnet.techcoderx.com". The node was healthy and answers
 * `access-control-allow-origin: *`; the browser refused the request itself
 * because `connect-src` did not list the host the launch broadcasts to.
 *
 * Two properties are asserted, and the SECOND is the one that made the original
 * bug easy to reintroduce: `REACT_APP_ALLOWED_HIVE_API_NODES` CLEARS the default
 * host set, so a grant written above that clear silently vanishes on any deploy
 * that sets it. The grant must survive both configurations.
 */
import { buildCsp } from '../csp';

let pass = 0;
const failures: string[] = [];

function check(name: string, ok: boolean) {
  if (ok) pass += 1;
  else failures.push(name);
}

function connectSrcOf(csp: string): string {
  const directive = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src '));
  return directive ?? '';
}

const HIVE_API = 'https://testnet.techcoderx.com';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// 1. The default configuration grants the broadcast endpoint.
withEnv(
  { REACT_APP_CREATOR_TOKENS_HIVE_API: HIVE_API, REACT_APP_ALLOWED_HIVE_API_NODES: undefined },
  () => {
    const connect = connectSrcOf(buildCsp());
    check('default config grants the creator-tokens Hive API', connect.includes(HIVE_API));
    check('default config still grants api.hive.blog', connect.includes('https://api.hive.blog'));
  }
);

// 2. It survives REACT_APP_ALLOWED_HIVE_API_NODES, which wipes the default set.
withEnv(
  {
    REACT_APP_CREATOR_TOKENS_HIVE_API: HIVE_API,
    REACT_APP_ALLOWED_HIVE_API_NODES: 'https://api.openhive.network'
  },
  () => {
    const connect = connectSrcOf(buildCsp());
    check('grant survives an explicit allowed-nodes list', connect.includes(HIVE_API));
    check('explicit allowed-nodes list still replaces the defaults', !connect.includes('https://api.hive.blog'));
  }
);

// 3. An unset var grants nothing — no stale permission on a deploy without the
//    feature provisioned.
withEnv(
  { REACT_APP_CREATOR_TOKENS_HIVE_API: undefined, REACT_APP_ALLOWED_HIVE_API_NODES: undefined },
  () => {
    const connect = connectSrcOf(buildCsp());
    check('unset var grants no extra host', !connect.includes('techcoderx.com'));
  }
);

// 4. A trailing path is reduced to an origin — CSP hosts are origins, and
//    `https://host/path` in a source list is a source-expression, not a host.
withEnv(
  {
    REACT_APP_CREATOR_TOKENS_HIVE_API: `${HIVE_API}/`,
    REACT_APP_ALLOWED_HIVE_API_NODES: undefined
  },
  () => {
    const connect = connectSrcOf(buildCsp());
    check('a trailing slash is normalised to the origin', connect.includes(` ${HIVE_API} `) || connect.endsWith(` ${HIVE_API}`));
  }
);

if (failures.length) {
  console.error(`${pass} PASS, ${failures.length} FAIL`);
  failures.forEach((f) => console.error(`  FAIL: ${f}`));
  process.exit(1);
}
console.log(`${pass} PASS, 0 FAIL (${pass} checks)`);
