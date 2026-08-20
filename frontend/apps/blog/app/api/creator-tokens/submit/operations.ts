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

/**
 * The status of one submitted transaction.
 *
 * ★ WHY THE WRITE PROXY CARRIES A READ. Submitting is not the same as executing:
 * the node accepts a transaction into its mempool and returns a CID long before
 * a block producer decides whether to include it. Confirming therefore belongs
 * to the same flow, with the same budget, as the submit it confirms — not to
 * the read proxy, whose limits are sized for page polling.
 */
export const TX_STATUS_OPERATION = `query FindTransaction($id: String!) {
  findTransaction(filterOptions: { byId: $id }) {
    id
    status
  }
}`;
