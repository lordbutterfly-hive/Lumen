/**
 * Submitting a wallet-signed transaction, and the nonce discipline it needs.
 *
 * ★ THE NONCE IS ALWAYS RE-FETCHED. NEVER CACHED. Altera's client increments a
 * local `client.nonce` only on success and never re-reads it. The node forbids
 * GAPS, so a single failed submit leaves the local counter and the chain out of
 * step and every subsequent attempt is rejected — the account is wedged until a
 * reload. Altera's own unshipped passkey branch re-fetches every time; that is
 * the behaviour ported here. A nonce read is one cheap query and it is the only
 * thing standing between a failed submit and a stuck account.
 *
 * ★ `getAccountNonce` RETURNS THE NEXT NONCE TO USE, AS-IS. The schema's own
 * doc string says "Next transaction must use nonce + 1" and that is WRONG:
 * `IngestTx:150` rejects `Nonce < confirmed`, so adding one skips a slot and
 * then trips the gap check. A never-seen account returns 0 (never null, never
 * an error) and its first transaction is nonce 0.
 *
 * ★ WHICH FAILURES ARE SAFE TO RETRY. The node's rejects #1-#21 all fire BEFORE
 * anything is recorded, so the nonce is unconsumed and the same nonce may be
 * reused. Only the datalayer/p2p failures happen after commit — those must be
 * treated as "possibly accepted" and never blindly retried, because the
 * transaction may already be in the mempool.
 *
 * ★ PIPELINING DOES NOT WORK ACROSS NODES. `nonce > confirmed` requires nonce-1
 * to be present, unconfirmed, IN THAT NODE'S POOL. Submitting N and N+1 to
 * different endpoints fails. Everything here submits one at a time to one
 * endpoint and re-reads in between.
 */

import { NONCE_OPERATION, SUBMIT_OPERATION } from '@/blog/app/api/creator-tokens/submit/operations';

/** Same-origin write proxy. Never dial the node directly — CORS forbids it. */
export const SUBMIT_PROXY_PATH = '/api/creator-tokens/submit';

export interface SubmitResult {
  /** The transaction CID the node assigned. */
  id: string;
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string }> | null;
}

async function postProxy<T>(query: string, variables: Record<string, unknown>): Promise<GqlResponse<T>> {
  const res = await fetch(SUBMIT_PROXY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store'
  });
  // A 429/502/503 carries a JSON body in this proxy's own shape, so parse
  // before inspecting status — the message inside is more useful than the code.
  const text = await res.text();
  try {
    return JSON.parse(text) as GqlResponse<T>;
  } catch {
    throw new Error(`submit: the proxy returned a non-JSON response (HTTP ${res.status})`);
  }
}

function firstError(res: GqlResponse<unknown>): string | null {
  const msg = res.errors?.[0]?.message;
  return typeof msg === 'string' && msg.length > 0 ? msg : null;
}

/** Read the nonce to use for the next transaction from this account. */
export async function fetchNonce(account: string): Promise<number> {
  const res = await postProxy<{ getAccountNonce: { account: string; nonce: number } | null }>(
    NONCE_OPERATION,
    { account }
  );
  const err = firstError(res);
  if (err) throw new Error(`submit: could not read the account nonce — ${err}`);

  const nonce = res.data?.getAccountNonce?.nonce;
  if (typeof nonce !== 'number' || !Number.isInteger(nonce) || nonce < 0) {
    throw new Error(`submit: the node returned an unusable nonce (${String(nonce)})`);
  }
  return nonce;
}

/**
 * A nonce-shaped rejection means the value we read went stale between the read
 * and the submit — someone else submitted for this account, or a previous
 * attempt landed after we gave up on it. Re-reading and retrying ONCE is
 * correct; retrying forever would spin against a genuinely wedged account.
 */
function isNonceError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('nonce') || m.includes('gap');
}

/**
 * A failure that may have COMMITTED. The node's own post-commit failures are
 * datalayer and p2p; a network error on our side is the same class, because the
 * request may have been fully processed before the connection dropped.
 */
function isPossiblyAccepted(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('datalayer') || m.includes('p2p') || m.includes('could not be reached');
}

export interface SubmitInput {
  /** base64 DAG-CBOR of the container. */
  tx: string;
  /** base64 DAG-CBOR of the signature envelope. */
  sig: string;
}

/** One submit attempt, no retry logic. */
export async function submitOnce(input: SubmitInput): Promise<SubmitResult> {
  const res = await postProxy<{ submitTransactionV1: { id: string } | null }>(SUBMIT_OPERATION, {
    tx: input.tx,
    sig: input.sig
  });
  const err = firstError(res);
  if (err) throw new Error(err);

  const id = res.data?.submitTransactionV1?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('submit: the node accepted the transaction but returned no id');
  }
  return { id };
}

export interface SignForNonce {
  /**
   * Build and sign a transaction for exactly this nonce. Called again with a
   * fresh nonce if the first attempt is rejected as stale — which is why the
   * SIGNING has to live behind this callback rather than happening once
   * outside: a retry with a new nonce is a DIFFERENT transaction and needs a
   * new signature. Re-using the first signature would fail verification, and
   * would look like a wallet problem rather than a nonce problem.
   */
  (nonce: number): Promise<SubmitInput>;
}

/**
 * Read the nonce, sign for it, submit — and on a stale-nonce rejection, do it
 * once more with a freshly read nonce.
 *
 * The retry deliberately re-enters `sign`, so the user sees a second wallet
 * prompt. That is honest: it is a different transaction. Silently re-using the
 * old signature would fail, and hiding the second prompt would mean signing
 * something the user was not shown.
 */
export async function submitWithNonce(account: string, sign: SignForNonce): Promise<SubmitResult> {
  const nonce = await fetchNonce(account);
  try {
    return await submitOnce(await sign(nonce));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isPossiblyAccepted(message)) {
      throw new Error(
        `${message} — this transaction may already have been accepted. Check your balance before signing it again.`
      );
    }
    if (!isNonceError(message)) throw error;

    const fresh = await fetchNonce(account);
    if (fresh === nonce) {
      // The nonce did not move, so re-signing the same value would fail the
      // same way. Reporting that is more useful than a second wallet prompt
      // the user would have to reject.
      throw new Error(
        `${message} — the account nonce is still ${nonce}, so retrying would fail identically.`
      );
    }
    return submitOnce(await sign(fresh));
  }
}
