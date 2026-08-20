'use client';

import env from '@beam-australia/react-env';
import { stringToHex } from 'viem';
// Type-only: erased at compile time, so it adds nothing to the bundle. Everything
// runtime is dynamically imported in getModal().
import type { CreateAppKit } from '@reown/appkit';

/**
 * Reown AppKit wallet connector for Lumen Lite sign-in (BTC + EVM).
 *
 * Ported from Magi/Altera's proven setup (altera-app/src/lib/auth/reown/index.ts):
 * same adapters (`bip122` via BitcoinAdapter, `eip155`), same network list and
 * mainnet-first ordering — Xverse defaults to Bitcoin mainnet and misbehaves if
 * handed a testnet network when the connect popup opens. Altera is Svelte, so the
 * component layer is ours; this module is the framework-agnostic core.
 *
 * Everything is dynamically imported on first use: AppKit pulls in web components
 * that must never touch SSR, and the login page should not pay for the bundle
 * unless a user actually clicks "connect".
 *
 * Signing is a LOGIN PROOF only — a plain signed message, never a transaction.
 *   bip122: provider.signMessage({ message, address, protocol:'ECDSA' }) -> base64
 *   eip155: personal_sign (EIP-191) -> 0x… 65-byte hex
 *
 * NOTE on BIP-137 headers: real SegWit wallets emit header bytes 35-42 rather than
 * the classic 27-34. Our verifier (`bip322-js`, non-strict) keys off the recovery
 * id modulo 4 and ignores the address flag, so those verify unchanged — proven by
 * scripts/lite-btc-header-check.mjs. Do NOT add Altera's header-rewrite hack here;
 * that exists for a stricter Go backend and would corrupt a valid signature.
 */

export type WalletChain = 'btc' | 'evm';

const NAMESPACE: Record<WalletChain, 'bip122' | 'eip155'> = {
  btc: 'bip122',
  evm: 'eip155'
};

/** Milliseconds to wait for the user to pick a wallet and approve the connection. */
const CONNECT_TIMEOUT_MS = 180_000;

/**
 * WalletConnect/Reown project id — get one at dashboard.reown.com. Runtime env
 * (REACT_APP_REOWN_PROJECT_ID) so a deploy can set it without a rebuild, matching
 * the app's other client config. Deliberately NO fallback to Altera's id: a project
 * id carries another app's metadata and domain allowlist.
 */
export function reownProjectId(): string {
  try {
    return env('REOWN_PROJECT_ID') || '';
  } catch {
    return '';
  }
}

/** False when no project id is configured — callers must fall back to manual signing. */
export function walletConnectAvailable(): boolean {
  return reownProjectId().length > 0;
}

export function isTaprootAddress(address: string): boolean {
  return /^(bc1p|tb1p)/i.test(address.trim());
}

type Modal = {
  open: (options?: { namespace?: 'bip122' | 'eip155' }) => Promise<unknown>;
  disconnect: (namespace?: 'bip122' | 'eip155') => Promise<void>;
  getProvider: <T>(namespace: 'bip122' | 'eip155') => T | undefined;
  getAccount: (namespace?: 'bip122' | 'eip155') => { address?: string; isConnected?: boolean } | undefined;
  subscribeAccount: (
    cb: (state: { address?: string; isConnected?: boolean; status?: string }) => void,
    namespace?: 'bip122' | 'eip155'
  ) => () => void;
  /** Modal open/closed. Needed to tell "user closed it" from "still choosing" — see connectWallet. */
  subscribeState: (cb: (state: { open?: boolean }) => void) => () => void;
};

let modalPromise: Promise<Modal> | null = null;

async function getModal(): Promise<Modal> {
  const projectId = reownProjectId();
  if (!projectId) throw new Error('wallet_connect_unconfigured');

  if (!modalPromise) {
    modalPromise = (async () => {
      const [{ createAppKit }, { EthersAdapter }, { BitcoinAdapter }, networksMod] = await Promise.all([
        import('@reown/appkit'),
        import('@reown/appkit-adapter-ethers'),
        import('@reown/appkit-adapter-bitcoin'),
        import('@reown/appkit/networks')
      ]);
      const { mainnet, bitcoin, bitcoinTestnet } = networksMod;
      // Mainnet-first: see the Xverse note in the module header.
      const networks: CreateAppKit['networks'] = [mainnet, bitcoin, bitcoinTestnet];
      const origin = typeof window !== 'undefined' ? window.location.origin : '';

      return createAppKit({
        adapters: [new EthersAdapter(), new BitcoinAdapter({ projectId })],
        networks,
        projectId,
        metadata: {
          name: 'Lumen',
          description: 'Sign in to Lumen with a wallet. No keys, no gas.',
          url: origin,
          icons: [`${origin}/favicon.ico`]
        },
        features: {
          analytics: false,
          email: false,
          socials: false,
          connectMethodsOrder: ['wallet']
        }
      }) as unknown as Modal;
    })().catch((error) => {
      // Never cache a failed init — a transient chunk-load error would otherwise
      // poison every later attempt for the whole page session.
      modalPromise = null;
      throw error;
    });
  }
  return modalPromise;
}

/**
 * Opens the wallet modal and resolves once an address for `chain` is connected.
 * The address must be known BEFORE the challenge is requested — the server binds
 * each nonce to one address (SEQ-1) — so connect and sign are separate steps.
 */
export async function connectWallet(chain: WalletChain): Promise<string> {
  const modal = await getModal();
  const namespace = NAMESPACE[chain];

  const existing = modal.getAccount(namespace);
  if (existing?.isConnected && existing.address) return existing.address;

  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeState();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('wallet_connect_timeout'))),
      CONNECT_TIMEOUT_MS
    );
    const unsubscribe = modal.subscribeAccount((state) => {
      if (state?.isConnected && state.address) {
        const address = state.address;
        finish(() => resolve(address));
      }
    }, namespace);

    /**
     * ★★★ CLOSING THE WALLET PICKER USED TO HANG THE PAGE FOR 3 MINUTES
     * (owner-reported 2026-08-17, seen on /security as "both buttons are dead").
     *
     * This promise only settled on a connection or on CONNECT_TIMEOUT_MS. Dismissing
     * the modal is not an error and does not connect anything, so it settled neither
     * way — and the caller holds a single `busy` lock that disables EVERY wallet
     * button while it waits. So one changed mind left "Waiting for your wallet…"
     * stuck, both Link buttons disabled, and no way out but a reload. On the
     * account-recovery page that reads as a broken product.
     *
     * `open` going true→false with nothing connected IS the user cancelling; reject
     * so the caller can release the lock. Guarded on having actually seen it open,
     * because the state starts closed and would otherwise self-cancel immediately.
     */
    let sawOpen = false;
    const unsubscribeState = modal.subscribeState((state) => {
      if (state?.open) {
        sawOpen = true;
        return;
      }
      if (!sawOpen) return;
      // Re-read the account rather than trusting ordering: a wallet that connects
      // as the modal closes must resolve, not be reported as a cancel.
      const account = modal.getAccount(namespace);
      if (account?.isConnected && account.address) {
        const address = account.address;
        finish(() => resolve(address));
        return;
      }
      finish(() => reject(new Error('wallet_connect_cancelled')));
    });

    modal.open({ namespace }).catch((error) => finish(() => reject(error)));
  });
}

/**
 * Sign `message` with the already-connected wallet as a login/bind proof.
 * `message` MUST be the exact string the challenge route returned — the server
 * rebuilds it from the nonce and rejects anything else. Returns base64 for BTC,
 * 0x-hex for EVM: precisely what the matching verify route expects.
 */
export async function signMessageWith(
  chain: WalletChain,
  address: string,
  message: string
): Promise<string> {
  if (chain === 'btc') {
    if (isTaprootAddress(address)) {
      await disconnectWallet(chain).catch(() => undefined);
      throw new Error('taproot_unsupported');
    }
    const modal = await getModal();
    const provider = modal.getProvider<{
      signMessage: (p: { message: string; address: string; protocol?: string }) => Promise<string>;
    }>('bip122');
    if (!provider?.signMessage) throw new Error('no_bitcoin_signer');
    return provider.signMessage({ message, address, protocol: 'ECDSA' });
  }

  const modal = await getModal();
  const provider = modal.getProvider<{
    request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  }>('eip155');
  if (!provider?.request) throw new Error('no_evm_signer');
  // personal_sign takes the message hex-encoded; wallets display the decoded text.
  const signature = await provider.request({
    method: 'personal_sign',
    params: [stringToHex(message), address]
  });
  if (typeof signature !== 'string') throw new Error('bad_signature_shape');
  return signature;
}

/**
 * Sign EIP-712 typed data with the connected EVM wallet — the TRANSACTION
 * signer, as opposed to `signMessageWith`'s login/bind proof.
 *
 * ★ WHY A SECOND FUNCTION AND NOT A FLAG ON THE FIRST. These sign different
 * things for different purposes with different failure consequences. A
 * `personal_sign` proof authenticates a session; a typed-data signature
 * AUTHORISES A TRANSFER OF VALUE. Keeping them apart means the login path can
 * never be pointed at a transaction payload by a stray argument, and every
 * caller of this one is visible in a single grep.
 *
 * `typedData` must already carry `types.EIP712Domain` — see `toWalletTypedData`.
 * It is passed as a JSON STRING because that is what `eth_signTypedData_v4`
 * takes; a wallet handed an object silently rejects it.
 */
export async function signTypedDataWith(address: string, typedData: unknown): Promise<string> {
  const modal = await getModal();
  const provider = modal.getProvider<{
    request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  }>('eip155');
  if (!provider?.request) throw new Error('no_evm_signer');

  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify(typedData)]
  });
  if (typeof signature !== 'string') throw new Error('bad_signature_shape');
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    // A wallet that returns a differently-shaped signature has not signed what
    // we asked; submitting it would burn a nonce slot to no effect.
    throw new Error('bad_signature_shape');
  }
  return signature;
}

export async function disconnectWallet(chain?: WalletChain): Promise<void> {
  if (!modalPromise) return;
  const modal = await getModal();
  await modal.disconnect(chain ? NAMESPACE[chain] : undefined);
}

/** Maps connector failures onto the copy the login dialog shows. */
export function walletErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/wallet_connect_unconfigured/.test(raw))
    return 'Wallet connect isn’t configured on this deployment yet.';
  if (/taproot_unsupported/.test(raw))
    return 'Taproot addresses aren’t supported yet. Use a SegWit (bc1q…) or legacy (1…) address.';
  if (/wallet_connect_timeout/.test(raw)) return 'The wallet connection timed out. Try again.';
  // Closing the picker is a decision, not a failure — say nothing alarming, and
  // above all release the button (see connectWallet's cancel path).
  if (/wallet_connect_cancelled/.test(raw)) return 'No wallet connected. You can try again whenever you like.';
  // ★ THIS MEANS "NO WALLET IS CONNECTED", NOT "THIS WALLET IS BROKEN" (QA,
  // 2026-08-20). The old sentence said "try another wallet", which sends the
  // user to swap a wallet that was never the problem. It is thrown whenever
  // there is no live AppKit provider in this browser session — including for
  // someone who signed in through the BTC "Sign manually instead" path, which
  // authenticates fine and establishes no signer, so every later buy, sell,
  // send and ask fails here. Say what is actually wrong and what fixes it.
  if (/no_bitcoin_signer|no_evm_signer/.test(raw))
    return 'No wallet is connected in this browser, so nothing can be signed. Connect your wallet and try again.';
  if (/User rejected|rejected|denied|4001/i.test(raw)) return 'You cancelled the signature request.';
  return 'Couldn’t complete the wallet signature. Please try again.';
}
