const dumpStartupEnvironment = () => {
  const executionEnv = process.env.NODE_ENV ?? 'test';
  const isProduction = executionEnv === 'production';
  const doDump = (process.env.DENSER_SERVER_ENV_DUMP ?? 'false') === 'true' ;

  if (isProduction && doDump === false) {
    console.log('Missing DENSER_SERVER_ENV_DUMP variable or set to false, skipping environment dump in production mode.');
    return;
  }

  console.log('Attempting to dump Denser specific environment variables (you can skip it by unsetting DENSER_SERVER_ENV_DUMP variable or set it to false');

  const vars = Object.keys(process.env);
  const filteredVars = vars.filter((key) => {
    return key.startsWith('DENSER_') || key.startsWith('HIVE_') || key.startsWith('NEXT_PUBLIC_') || key.startsWith('REACT_APP_');
  });

  const env = filteredVars.sort().forEach((key) => {
    const value = process.env[key];
    if (value) {
      console.log(`${key}: ${value}`);
    } else {
      console.log(`Variable ${key} is <undefined> !!!`);
    }
  });

  console.log('Denser startup environment variables dump finsihed');
};

/**
 * ★ REFUSE TO START ON A PUBLISHED PLACEHOLDER SECRET (2026-08-23).
 *
 * `DENSER_SERVER_SECRET_COOKIE_PASSWORD` is the iron-session sealing key
 * (`packages/smart-signer/lib/session.ts`) AND the OAuth2 JWT secret
 * (`packages/smart-signer/lib/oauth/config.ts`). Anyone holding it can mint a cookie
 * asserting any account. The `.env.*.example` files shipped
 * `CHANGE_ME_GENERATE_UNIQUE_SECRET` in that slot from the first commit, and it is exactly
 * 32 characters, so iron-session ACCEPTS it and everything appears to work. That silence
 * is why it survived: nothing anywhere warned, and the one existing check
 * (`oauth/config.ts`) only fires when the variable is UNSET, never when it holds the
 * published default.
 *
 * The model is `recsys`, which raises rather than falling back when a required secret is
 * missing under `production` (`recsys/recsys/config.py`). Same three properties here:
 * production-gated, refuses rather than degrades, and names the variable and the generator.
 *
 * MATCHING IS EXACT, NEVER A HEURISTIC. A substring rule on "dummy"/"test"/"not-a-secret"
 * would kill the Playwright fixture suite, which runs a real production build with
 * `fixture-tests-dummy-cookie-password-not-a-secret`, and the CI e2e shards, which use
 * `SomeValueForTestingPurposesOnly!`. Neither is a placeholder; both must keep working.
 *
 * Three conditions, each load-bearing:
 *   1. production only  - a dev box may legitimately carry anything.
 *   2. nodejs runtime   - `process.exit` does not exist on the edge runtime.
 *   3. not during build - a CI image build runs with no secrets and must still build.
 */
// The two `CHANGE_ME_ADMIN_*` placeholders that used to sit here belonged to the
// Rocket.Chat admin credentials, removed with that integration on 2026-08-23.
const PUBLISHED_PLACEHOLDERS = new Set(['CHANGE_ME_GENERATE_UNIQUE_SECRET']);

/**
 * Sealing/signing keys that are ALWAYS required. An empty one in production is as fatal as
 * a published one, because iron-session accepts it and every session becomes forgeable.
 *
 * ★ `DENSER_SERVER_OIDC_COOKIES_KEYS` IS DELIBERATELY NOT HERE (corrected 2026-08-23).
 * It was, and that was wrong: the variable is absent from `apps/blog/.env.local` (what the
 * running server actually loads) and from `.env.lumen-mainnet.example` (the production
 * template), and OIDC is OFF unless `DENSER_SERVER_OIDC_ENABLED=yes` — `oidc.ts` only
 * builds the Provider when it is. Requiring it therefore refused to boot the QA production
 * server, a mainnet deploy, and the Playwright fixture suite, which is a far worse outcome
 * than the thing being guarded against. It keeps the published-placeholder check below,
 * which is the part that actually matters for it.
 */
const MUST_BE_REAL = ['DENSER_SERVER_SECRET_COOKIE_PASSWORD'];

/** Credentials where a published default is unsafe but an empty value merely disables. */
const MUST_NOT_BE_PUBLISHED = ['DENSER_SERVER_OIDC_COOKIES_KEYS'];

const refuseKnownDefaults = (): void => {
  if ((process.env.NODE_ENV ?? 'test') !== 'production') return;
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.LUMEN_ALLOW_INSECURE_SECRETS === 'yes') return;

  const published = [...MUST_BE_REAL, ...MUST_NOT_BE_PUBLISHED].filter((key) =>
    PUBLISHED_PLACEHOLDERS.has(process.env[key] ?? '')
  );
  const missing = MUST_BE_REAL.filter((key) => (process.env[key] ?? '').length === 0);

  // ★ EMPTY DOES NOT ALWAYS MEAN "DISABLED" (2026-08-23, adversarial review).
  //
  // The note on MUST_BE_REAL above is right that an absent OIDC key is harmless while OIDC
  // is off — but it does NOT follow that an empty one is harmless when OIDC is ON. Measured
  // against the installed `oidc-provider@8.6.0`: `new Provider(..., { cookies: { keys: [] } })`
  // CONSTRUCTS, logging only "configuration cookies.keys is missing, this option is critical
  // to detect and ignore tampered cookies". So the server starts and serves OIDC with
  // unsigned, tamper-undetectable cookies. `.env.blog.example` ships
  // `DENSER_SERVER_OIDC_ENABLED="yes"` with the key blank, which is exactly that state.
  // `site.ts` maps an empty value to `[]`, so this is the only place it can be caught.
  const oidcOn = process.env.DENSER_SERVER_OIDC_ENABLED === 'yes';
  const oidcKeyEmpty = (process.env.DENSER_SERVER_OIDC_COOKIES_KEYS ?? '').length === 0;
  const oidcUnsigned = oidcOn && oidcKeyEmpty;

  if (published.length === 0 && missing.length === 0 && !oidcUnsigned) return;

  if (oidcUnsigned) {
    console.error(
      '[boot] REFUSING TO START: DENSER_SERVER_OIDC_ENABLED is "yes" but ' +
        'DENSER_SERVER_OIDC_COOKIES_KEYS is empty. oidc-provider accepts this and runs with ' +
        'cookies it cannot verify, so a tampered OIDC cookie is undetectable. Set the key, ' +
        'or set DENSER_SERVER_OIDC_ENABLED=no.'
    );
  }

  if (published.length > 0) {
    console.error(
      `[boot] REFUSING TO START: ${published.join(', ')} still hold the published ` +
        `.env.*.example placeholder value. A session sealed with a published key can be ` +
        `forged for any account.`
    );
  }
  if (missing.length > 0) {
    console.error(`[boot] REFUSING TO START: ${missing.join(', ')} is empty in production.`);
  }
  console.error('[boot] Generate each with: openssl rand -base64 32');
  process.exit(1);
};

export async function commonRegister(appName: string): Promise<void> {
  console.log(`Starting up the '${appName}' application server...`);
  // Before the env dump: a refusal is more useful than a log of a broken config.
  refuseKnownDefaults();
  dumpStartupEnvironment();
}

