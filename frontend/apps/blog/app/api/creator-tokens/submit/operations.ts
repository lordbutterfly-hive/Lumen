/**
 * The two GraphQL operations the wallet-signed rail sends, in a plain module.
 *
 * ★ THEY LIVE HERE AND NOT IN `route.ts` BECAUSE NEXT REFUSES IT. An App Router
 * route file may export only the HTTP verb handlers and the route config keys
 * (`dynamic`, `revalidate`, `runtime`, …). Anything else fails the build with
 * "X is not a valid Route export field" — after compilation, during type
 * checking, so the dist directory is left with no BUILD_ID and the failure
 * looks like a broken build rather than a bad export.
 *
 * Keeping them in one module shared by the route and the client is what makes
 * the allowlist meaningful: the proxy matches the operation by EXACT STRING, so
 * if the two sides could drift apart the client would simply stop working.
 */

export const NONCE_OPERATION = `query GetAccountNonce($account: String!) {
  getAccountNonce(account: $account) {
    account
    nonce
  }
}`;

export const SUBMIT_OPERATION = `query SubmitTransactionV1($tx: String!, $sig: String!) {
  submitTransactionV1(tx: $tx, sig: $sig) {
    id
  }
}`;
