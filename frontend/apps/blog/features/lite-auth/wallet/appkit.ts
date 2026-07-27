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
          description: 'Sign in to Lumen with a wallet — no keys, no gas.',
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
    return 'Taproot addresses aren’t supported yet — use a SegWit (bc1q…) or legacy (1…) address.';
  if (/wallet_connect_timeout/.test(raw)) return 'The wallet connection timed out — try again.';
  if (/no_bitcoin_signer|no_evm_signer/.test(raw))
    return 'That wallet can’t sign messages. Try another wallet.';
  if (/User rejected|rejected|denied|4001/i.test(raw)) return 'You cancelled the signature request.';
  return 'Couldn’t complete the wallet signature — please try again.';
}
