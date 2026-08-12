// Type-only: `operation`/`ApiOperation`/`ApiTransaction` are wax type aliases,
// never touched as values in this file. `custom_json` IS touched as a value
// (`.create(...)` below) — that one is loaded lazily inside getOperationForLogin
// instead, since this module is reachable, statically, from every page:
// GoogleOAuthRedirectHandler (mounted unconditionally by Providers) calls
// useProcessAuth (packages/smart-signer/components/auth/process.tsx), which
// imports getOperationForLogin from here. A plain top-level `custom_json` import
// would have reopened the same '@hiveio/wax' WASM-bundle leak fixed there.
import type { operation, ApiOperation, ApiTransaction } from '@hiveio/wax';
import { KeyType } from '@smart-signer/types/common';

/**
 * Create fake transaction for signing in login flow.
 *
 * @export
 * @param {string} username
 * @param {KeyType} keyType
 * @param {string} loginChallenge
 * @param {string} loginType
 * @returns {Promise<operation>}
 */
export async function getOperationForLogin(
  username: string,
  keyType: KeyType,
  loginChallenge: string,
  loginType: string
): Promise<operation> {
  const { custom_json } = await import('@hiveio/wax');
  let operation: operation;
  if (keyType === KeyType.posting) {
    // Type annotation dropped — `custom_json` is a locally-destructured VALUE
    // binding (see the dynamic import above), and TS cannot resolve it as a
    // type from a destructure the way a static `import { custom_json }` would;
    // `.create(...)`'s return type is inferred instead, which is identical.
    const customJsonLoginChallenge = custom_json.create({
      id: `denser_${loginType}`,
      json: JSON.stringify({ challenge: loginChallenge }),
      required_auths: [],
      required_posting_auths: [username]
    });
    operation = { custom_json_operation: customJsonLoginChallenge };
  } else if (keyType === KeyType.active) {
    const customJsonLoginChallenge = custom_json.create({
      id: `denser_${loginType}`,
      json: JSON.stringify({ challenge: loginChallenge }),
      required_auths: [username],
      required_posting_auths: []
    });
    operation = { custom_json_operation: customJsonLoginChallenge };
  } else {
    throw new Error('Unsupported keyType');
  }
  return operation;
}

/**
 * Get `loginChallenge` from fake transaction in login flow.
 *
 * @export
 * @param {ApiTransaction} tx
 * @param {KeyType} keyType
 * @returns {string}
 */
export function getLoginChallengeFromTransactionForLogin(tx: ApiTransaction, keyType: KeyType): string {
  const operation: ApiOperation = tx.operations[0];
  return getLoginChallengeFromOperationForLogin(operation, keyType);
}

/**
 * Get `loginChallenge` from fake operation in login flow.
 *
 * @export
 * @param {ApiOperation} operation
 * @param {KeyType} _keyType
 * @returns {string}
 */
export function getLoginChallengeFromOperationForLogin(operation: ApiOperation, _keyType: KeyType): string {
  // The login operation is always a custom_json_operation with the challenge in the json field
  const jsonString = (operation as any).value?.json;
  if (!jsonString) {
    throw new Error('Missing json field in custom_json operation');
  }
  const parsed = JSON.parse(jsonString);
  if (!parsed.challenge) {
    throw new Error('Missing challenge in custom_json operation');
  }
  return parsed.challenge;
}
