'use client';

/**
 * ★★ ONE MESSAGING KEY, EVERY DEVICE (owner, 2026-09-25: "the inbox must work on EVERY
 * device, not per device").
 *
 * Messages stay encrypted with the fast X25519 key in `dm-crypto`; nothing about sending
 * or reading changes. What changes is that the device which makes an account's key also
 * uploads a BACKUP of it, encrypted here, in the browser, before it leaves:
 *
 *   Hive account   a Hive memo to the account's OWN posting public key, written here from
 *                  a one-time key, so making it asks nothing of anyone. Opening it takes
 *                  the account's posting key: one approval in Keychain (or PeakVault, or
 *                  the MetaMask Hive snap), or the stored key of a WIF login.
 *   Wallet account AES-GCM under a key derived from the wallet's signature over a fixed
 *                  message. Only when the wallet signs that message the same way twice;
 *                  otherwise the signature could not be reproduced on the next device, so
 *                  there is no backup and the key stays on this device (and we say so).
 *
 * The server stores the backup verbatim and cannot open it. PeakD-style per-message
 * Keychain encryption was ruled out by the owner: one approval per device, not per message.
 *
 * Not covered, and honest about it: HiveAuth, hb-auth (the Lumen password login), Google
 * Drive wallet and Hivesigner expose no memo encryption to this page, and a Google-only
 * lite account has no key or wallet at all. Those stay per device, as before.
 */

import { LoginType, type User } from '@smart-signer/types/common';

export type BackupVia = 'keychain' | 'peakvault' | 'metamask' | 'wif' | 'wallet';

export interface HiveBackup {
  v: 1;
  kind: 'hive';
  account: string;
  /** The posting public key it was encrypted to, so a rotated posting key can be recognised. */
  key: string;
  memo: string;
}

export interface WalletBackup {
  v: 1;
  kind: 'wallet';
  did: string;
  iv: string;
  ct: string;
}

export type DmKeyBackup = HiveBackup | WalletBackup;

export class DeviceOnlyError extends Error {
  constructor() {
    super('wallet_not_deterministic');
  }
}

/** How THIS login can make or open a backup, or null when it cannot. */
export function backupViaFor(user: User): BackupVia | null {
  if (!user.isLoggedIn) return null;
  if (user.account_tier === 'lite') return 'wallet';
  switch (user.loginType) {
    case LoginType.keychain:
      return 'keychain';
    case LoginType.peakvault:
      return 'peakvault';
    case LoginType.metamask:
      return 'metamask';
    case LoginType.wif:
      return 'wif';
    default:
      return null;
  }
}

export function parseBackup(raw: string | null | undefined): DmKeyBackup | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Partial<DmKeyBackup>;
    if (b?.v !== 1) return null;
    if (b.kind === 'hive' && typeof b.memo === 'string' && typeof b.key === 'string') return b as HiveBackup;
    if (
      b.kind === 'wallet' &&
      typeof b.did === 'string' &&
      typeof b.iv === 'string' &&
      typeof b.ct === 'string'
    ) {
      return b as WalletBackup;
    }
  } catch {
    /* not ours */
  }
  return null;
}

/** Can this login open that backup at all (before asking anyone for anything)? */
export function canOpen(user: User, backup: DmKeyBackup): boolean {
  const via = backupViaFor(user);
  if (!via) return false;
  if (backup.kind === 'hive') return via !== 'wallet';
  return via === 'wallet';
}

/* ---------- Hive: a memo to the account's own posting key ---------- */

const wifStorageKey = (username: string) => `wif.${username}@posting`;

function storedWif(username: string): string | null {
  try {
    // The exact slot the WIF signer writes (smart-signer signer-wif.ts), raw JSON rather
    // than the TTL wrapper, so it is read the way it is written.
    // eslint-disable-next-line no-restricted-properties
    const raw = window.localStorage.getItem(wifStorageKey(username));
    return raw ? (JSON.parse(raw) as string) : null;
  } catch {
    return null;
  }
}

async function askForWif(): Promise<string> {
  const [{ PasswordDialogModalPromise }, { PasswordFormMode }] = await Promise.all([
    import('@smart-signer/components/password-dialog'),
    import('@smart-signer/components/password-form')
  ]);
  const { password } = (await PasswordDialogModalPromise({
    isOpen: true,
    passwordFormOptions: {
      mode: PasswordFormMode.WIF,
      showInputStorePassword: false,
      i18nKeysForCaptions: {
        inputPasswordPlaceholder: 'Your posting private key',
        title: 'Enter your posting key'
      }
    }
  })) as { password: string };
  return password;
}

/** The account's posting public key, as the chain has it. */
async function postingKeyOf(username: string): Promise<string> {
  const res = await fetch(`/api/account?username=${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error('account_read_failed');
  const account = (await res.json()) as { posting?: { key_auths?: [string, number][] } };
  const key = account.posting?.key_auths?.[0]?.[0];
  if (!key) throw new Error('no_posting_key');
  return key;
}

interface HiveCipher {
  decrypt(memo: string): Promise<string>;
}

/**
 * The signer behind this login, reduced to decrypt (making a backup needs none, see
 * `makeBackup`). `interactive` false means "only if it needs no typing": a WIF login
 * without a stored key is skipped rather than prompted for.
 */
async function hiveCipher(user: User, via: BackupVia, interactive: boolean): Promise<HiveCipher | null> {
  const username = user.username;
  if (via === 'wif') {
    const wif = storedWif(username) ?? (interactive ? await askForWif() : null);
    if (!wif) return null;
    const memo = await import('./hive-memo');
    return { decrypt: (m) => memo.decodeMemo(wif, m) };
  }
  // The extension signers load only here, on demand: they carry wax, which must not
  // reach every page (see smart-signer/lib/signer/signer.ts).
  if (via === 'keychain' || via === 'peakvault') {
    const provider =
      via === 'keychain'
        ? (await import('@hiveio/wax-signers-keychain')).default.for(username, 'posting')
        : (await import('@hiveio/wax-signers-peakvault')).default.for(username, 'posting');
    return { decrypt: (m) => provider.decryptData(m.startsWith('#') ? m : `#${m}`) };
  }
  if (via === 'metamask') {
    const env = (await import('@beam-australia/react-env')).default;
    const MetaMaskProvider = (await import('@hiveio/wax-signers-metamask')).default;
    const provider = await MetaMaskProvider.for(0, 'posting', env('METAMASK_SNAP_LOCATION'));
    return { decrypt: (m) => provider.decryptData(m) };
  }
  return null;
}

/* ---------- Wallet: a key from a reproducible signature ---------- */

type WalletChain = 'evm' | 'btc';

async function walletOf(): Promise<{ chain: WalletChain; address: string; did: string } | null> {
  const res = await fetch('/api/lite/wallet/dids');
  if (!res.ok) return null;
  const body = (await res.json()) as { wallets?: { method: string; address: string; did: string }[] };
  const w = body.wallets?.[0];
  if (!w) return null;
  return { chain: w.method === 'btc_wallet' ? 'btc' : 'evm', address: w.address, did: w.did };
}

/** The fixed message. Bound to the wallet so one signature can never open another's backup. */
export function walletBackupMessage(did: string): string {
  return `Lumen private messages\n\nSign to use your messages on this device. This does not move any funds and costs nothing.\n\n${did}`;
}

async function walletSign(
  wallet: { chain: WalletChain; address: string; did: string },
  interactive: boolean
): Promise<string> {
  const appkit = await import('@/blog/features/lite-auth/wallet/appkit');
  try {
    return await appkit.signMessageWith(wallet.chain, wallet.address, walletBackupMessage(wallet.did));
  } catch (error) {
    // Not connected in this page yet. Connecting opens the wallet picker, which only a
    // press may do; a background attempt stops here.
    if (!interactive) throw error;
    const connected = await appkit.connectWallet(wallet.chain);
    if (connected.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('wrong_wallet');
    return appkit.signMessageWith(wallet.chain, wallet.address, walletBackupMessage(wallet.did));
  }
}

const B64 = {
  enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
};

async function aesKeyFromSignature(signature: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signature.trim()),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('lumen-dm-backup-salt-v1'),
      info: new TextEncoder().encode('lumen-dm-backup-aes-256-gcm-v1')
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Can this account make a backup at all? A lite account needs a bound wallet: a
 * Google-only one has nothing to encrypt to and is never offered one.
 */
export async function hasBackupMethod(user: User): Promise<boolean> {
  const via = backupViaFor(user);
  if (via !== 'wallet') return via !== null;
  return (await walletOf().catch(() => null)) !== null;
}

/* ---------- the two operations ---------- */

/**
 * Encrypt a messaging private key (base64) into a backup, or null when this login
 * cannot (and would have to ask for something it may not ask for here). A Hive backup
 * asks nothing of anyone; a wallet one takes two signatures, and a wallet that signs the
 * fixed message two different ways throws DeviceOnlyError.
 */
export async function makeBackup(
  user: User,
  privateKeyB64: string,
  interactive: boolean
): Promise<DmKeyBackup | null> {
  const via = backupViaFor(user);
  if (!via) return null;
  if (via === 'wallet') {
    const wallet = await walletOf();
    if (!wallet) return null;
    const first = await walletSign(wallet, interactive);
    const second = await walletSign(wallet, interactive);
    if (first.trim() !== second.trim()) throw new DeviceOnlyError();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await aesKeyFromSignature(first),
        new TextEncoder().encode(privateKeyB64)
      )
    );
    return { v: 1, kind: 'wallet', did: wallet.did, iv: B64.enc(iv), ct: B64.enc(ct) };
  }
  /*
   * ★★ NO SIGNER IS ASKED TO MAKE A HIVE BACKUP (2026-09-25). It used to go through
   * Keychain's requestEncodeWithKeys, whose approval window is titled "Encode Multisig",
   * lists a public key, and prints the message being encoded: the messaging PRIVATE key,
   * in plain view (owner: "keychain showed me a key ... might spook people"). Encrypting
   * to a public key needs no private key, so it is done here from a one-time key. The
   * memo is the same standard format and opens the same way (one approval to decode).
   * A stored WIF names its own key exactly; otherwise the chain's posting key.
   */
  const memo = await import('./hive-memo');
  const wif = via === 'wif' ? storedWif(user.username) : null;
  const key = wif ? memo.publicKeyOfWif(wif) : await postingKeyOf(user.username);
  return {
    v: 1,
    kind: 'hive',
    account: user.username,
    key,
    memo: await memo.encodeMemoToKey(key, privateKeyB64)
  };
}

/** Open a backup and return the private key (base64). One approval or one signature. */
export async function openBackup(user: User, backup: DmKeyBackup): Promise<string> {
  const via = backupViaFor(user);
  if (!via || !canOpen(user, backup)) throw new Error('cannot_open_backup');
  if (backup.kind === 'wallet') {
    const wallet = await walletOf();
    if (!wallet || wallet.did !== backup.did) throw new Error('wrong_wallet');
    const signature = await walletSign(wallet, true);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: B64.dec(backup.iv) },
      await aesKeyFromSignature(signature),
      B64.dec(backup.ct)
    );
    return new TextDecoder().decode(plain);
  }
  const cipher = await hiveCipher(user, via, true);
  if (!cipher) throw new Error('cannot_open_backup');
  // Keychain hands a decoded memo back with its "#" still on; the key never starts with one.
  return (await cipher.decrypt(backup.memo)).replace(/^#/, '');
}
