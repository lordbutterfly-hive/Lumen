import { walletErrorMessage } from '@/blog/features/lite-auth/wallet/appkit';
import { scrubSensitiveData } from '@ui/lib/sentry-scrub';

/**
 * Turn a thrown write error into something a user can ACT on.
 *
 * WHY THIS EXISTS. Every money modal in ./token-page/token-modals.tsx used to
 * do this:
 *
 *     } catch { setFailed(true); }
 *
 * — discarding the error object entirely — and then render a hardcoded
 * sentence that GUESSED at the cause: "That buy didn't go through — the market
 * may be at its cap or winding down. Try a smaller amount."
 *
 * That sentence was shown for every possible failure. A signed-out user, a
 * lite account with no Hive keys, a signer that cannot produce an active
 * signature, a wallet the user cancelled, a session whose signer is configured
 * for a different account, a network blip, and an actual at-cap market ALL
 * produced the same invented explanation. The one thing it reliably did was
 * send a user to try a smaller amount when the amount was never the problem.
 *
 * It is also a direct violation of this feature's own rule 4
 * (creator-tokens/STATUS.md, "Never invent a number. Anything the chain cannot
 * answer renders as absent with a stated reason"). A fabricated *reason* is
 * the same defect as a fabricated number.
 *
 * WHAT THIS DOES INSTEAD. The write paths already throw messages written for
 * humans, prefixed with a stable machine code:
 *
 *   CREATOR_TOKENS_LITE_ACCOUNT: this account has no Hive keys and cannot ...
 *   CREATOR_TOKENS_ACTIVE_KEY_REQUIRED: you are signed in with a posting ...
 *
 * (thrown by live/use-live-*.ts's requireSigner and by lib/vsc/broadcaster.ts's
 * active-authority guard). This splits the code off and shows the sentence.
 * Anything it does not recognise falls back to the caller's own neutral line —
 * neutral meaning it says the action did not complete, WITHOUT asserting a
 * cause it does not know.
 *
 * SCRUBBING. When an unrecognised error's own text is shown, it is passed
 * through the same WIF/master-password redactor Sentry uses
 * (packages/ui/lib/sentry-scrub.ts). Signer and wallet errors are the one
 * class of error that can plausibly quote key material back at us, and
 * rendering that into the DOM would put it in front of the user's screen, into
 * a screenshot, and into a Sentry session replay. The scrubber is cheap and
 * this is exactly the path it exists for.
 */

/** Codes thrown by the creator-tokens write path. The text after the colon is already user-facing. */
const CODE_PREFIX = /^(CREATOR_TOKENS_[A-Z_]+):\s*/;

/**
 * The failures `walletErrorMessage` knows how to phrase. Matched on the raw
 * text rather than on an error class, because these travel as plain messages
 * from the wallet adapter and arrive here as ordinary Errors.
 */
const WALLET_ERROR_TOKENS =
  /no_evm_signer|no_bitcoin_signer|wallet_connect_unconfigured|wallet_connect_timeout|wallet_connect_cancelled|taproot_unsupported|bad_signature_shape|User rejected|\b4001\b/i;

/**
 * Non-coded errors thrown deliberately by the data source / view layer whose
 * message is already a complete, accurate, user-facing sentence. Matched on a
 * distinctive fragment so a reworded message degrades to the neutral fallback
 * rather than to a wrong claim.
 */
const KNOWN_PLAIN_MESSAGES: readonly string[] = [
  'The price moved above your limit.',
  'That budget does not cover a whole token at the current price.',
  'curve sell is closed while the market winds down',
  'pro-rata refund opens only at wind-down',
  'market inflow is not open'
];

/** How long an unrecognised error is allowed to be before it stops being a message and becomes a wall. */
const MAX_RAW_LENGTH = 180;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

/**
 * @param err       whatever the write threw
 * @param fallback  a NEUTRAL sentence for this specific action — it must state
 *                  that the action did not complete and must NOT assert why.
 */
export function writeFailureMessage(err: unknown, fallback: string): string {
  const raw = messageOf(err).trim();
  if (raw === '') return fallback;

  const coded = CODE_PREFIX.exec(raw);
  if (coded) {
    const human = raw.slice(coded[0].length).trim();
    return human === '' ? fallback : scrubSensitiveData(human);
  }

  for (const known of KNOWN_PLAIN_MESSAGES) {
    if (raw.includes(known)) return scrubSensitiveData(raw);
  }

  // ★ WALLET ERRORS ALREADY HAVE HUMAN TRANSLATIONS — USE THEM (QA, 2026-08-20).
  // A failed buy showed the user "That buy didn't go through. (no_evm_signer)":
  // a raw internal token, in red, with no explanation and no way forward. The
  // sentence for exactly that condition already existed in `walletErrorMessage`
  // ("That wallet can't sign messages. Try another wallet.") and this path
  // simply never called it. Now that a wallet can sign a creator-token write,
  // wallet-shaped failures reach here routinely, which they did not before.
  if (WALLET_ERROR_TOKENS.test(raw)) return walletErrorMessage(err);

  // Unrecognised: almost always a wallet rejection or a node error. Say what
  // is certainly true (it did not go through), then hand over the actual text
  // so the user has something to search for or report — scrubbed, and cut off
  // before it becomes unreadable.
  const safe = scrubSensitiveData(raw);
  const trimmed = safe.length > MAX_RAW_LENGTH ? `${safe.slice(0, MAX_RAW_LENGTH)}…` : safe;
  return `${fallback} (${trimmed})`;
}
