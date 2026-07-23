/**
 * Regression check for the Sentry secret scrubber (spec §F.3 must-fix): a Hive
 * WIF AND a master password ('P' + WIF) must both be redacted before an error
 * event leaves the process. Run standalone:
 *   pnpm --filter @hive/ui exec tsx lib/sentry-scrub.selftest.ts
 */
import { scrubSensitiveData } from './sentry-scrub';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`sentry-scrub selftest FAILED: ${msg}`);
}

const wif = `5J${'a'.repeat(50)}`; // shape of a real WIF
const masterPassword = `P${wif}`; // Hive master password shape

assert(scrubSensitiveData(`wif=${wif}`) === 'wif=[REDACTED]', 'WIF not redacted');
assert(
  scrubSensitiveData(`master=${masterPassword}`) === 'master=[REDACTED]',
  'master password not redacted'
);
assert(scrubSensitiveData('nothing secret here') === 'nothing secret here', 'benign text altered');

// eslint-disable-next-line no-console -- standalone selftest
console.log('sentry-scrub selftest passed');
