'use client';

import { useEffect, useRef } from 'react';
import { useSignIn } from '@smart-signer/lib/auth/use-sign-in';
import { LoginType, KeyType } from '@smart-signer/types/common';
import { ensureLoginChallenge } from '@smart-signer/lib/ensure-login-challenge';
import { cookieNamePrefix } from '@smart-signer/lib/session';
// ★ getSigner, getOperationForLogin and getChain are imported LAZILY at their
// point of use inside migrate() below (2026-09-04, perf). getChain() pulls in
// @hiveio/wax + beekeeper (~123 KB gzip) and the signer factory pulls the
// signing stack; all three are only ever reached on the rare Condenser-Keychain
// migration path. This component is mounted app-wide in app/layout.tsx, so a
// static import here dragged that whole stack into the first-load bundle every
// visitor downloads. The dynamic import() keeps it out until the path runs.
import { hasCompatibleKeychain } from '@smart-signer/lib/signer/signer-keychain';
import type { Signatures } from '@smart-signer/lib/auth/login-schema';
import {
  parseAutopost2,
  cleanupCondenserStorage,
  isAlreadyMigrated,
  markMigrated,
  migrateLanguage,
  migrateCondenserData
} from '../lib/condenser-migration';
import { FetchError } from '@smart-signer/lib/fetch-json';
import { getLogger } from '@hive/ui/lib/logging';

// Direct localStorage access is intentional: we read/write Condenser's legacy
// WIF key format (same as signer-wif.ts) and migration cleanup.
/* eslint-disable no-restricted-properties */

const logger = getLogger('app');

/**
 * Invisible component that detects Condenser login data in localStorage
 * and automatically logs the user into Denser.
 *
 * Handles two login methods from Condenser:
 * - WIF key (stored in autopost2 as posting private key)
 * - Keychain (detected via autopost2 flag + extension presence)
 *
 * Runs once on mount, sets a flag to prevent re-execution.
 */
export default function CondenserMigration() {
  const signIn = useSignIn();
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    migrate();

    async function migrate() {
      if (isAlreadyMigrated()) return;

      // Language migration runs regardless of login data
      migrateLanguage();

      const data = parseAutopost2();
      if (!data) {
        // No autopost2 means no condenser login — only remove migration markers,
        // not user data (replyEditorData-*, voteWeight-* etc.) which may belong to
        // users who have drafts/templates but never logged in via condenser.
        localStorage.removeItem('autopost2');
        localStorage.removeItem('autopost');
        localStorage.removeItem('saveLogin');
        markMigrated();
        return;
      }

      const { username, loginWithKeychain } = data;

      // Migrate user data (templates, drafts, vote weights) before login attempt.
      // These are synchronous and idempotent, so safe to run even if login retries later.
      migrateCondenserData(username);

      // ★ 2026-08-01 — THE WIF BRANCH IS GONE. It used to take a plaintext
      // posting key out of legacy Condenser storage and write it straight into
      // `wif.<user>@posting` for SignerWif to read: a private key persisted to
      // localStorage, unencrypted, with no TTL, WITHOUT the user ever seeing
      // the "store my key" consent checkbox that the normal WIF login path
      // requires — and it ran automatically on page load for every visitor,
      // because this component is mounted app-wide in app/layout.tsx.
      //
      // It is also a login method Lumen no longer offers. The product supports
      // exactly four: Google, Bitcoin wallet, EVM wallet (all Lumen Lite) and
      // Hive Keychain. Silently signing someone in with a stored private key is
      // the opposite of that.
      //
      // Their DATA (templates, drafts, vote weights) is still migrated above —
      // that is the part worth keeping. Without Keychain they simply sign in
      // again through the normal login page.
      let loginType: LoginType;
      if (loginWithKeychain && hasCompatibleKeychain()) {
        loginType = LoginType.keychain;
      } else {
        // No usable login method, but data was already migrated above
        cleanupCondenserStorage(username);
        markMigrated();
        return;
      }

      try {
        // ★ The challenge is no longer minted on cacheable anonymous page
        // responses (snappiness phase 2); the first API call of the visit mints
        // it, and this asks for it explicitly rather than assuming the page
        // response carried it (found in review: this path used to wipe the
        // stored key and retry forever on a cookie-less first load).
        const loginChallenge = await ensureLoginChallenge();
        if (!loginChallenge) {
          // Could not obtain a challenge (offline, API down): do not mark
          // migrated so we retry on the next page load.
          logger.warn('Condenser migration: no login_challenge cookie');
          removeStoredWif(username, loginType);
          return;
        }

        const { getChain } = await import('@transaction/lib/chain');
        const hiveChain = await getChain();
        const { getOperationForLogin } = await import('@smart-signer/lib/login-operation');
        const operation = await getOperationForLogin(
          username,
          KeyType.posting,
          loginChallenge,
          loginType
        );

        const expr = new Date();
        expr.setHours(expr.getHours() + 1);
        const txBuilder = await hiveChain.createTransaction(expr);
        txBuilder.pushOperation(operation);
        txBuilder.validate();

        const { getSigner } = await import('@smart-signer/lib/signer/get-signer');
        const signer = getSigner({
          username,
          loginType,
          keyType: KeyType.posting,
          storageType: 'localStorage'
        });

        const signature = await signer.signTransaction({
          digest: txBuilder.sigDigest,
          transaction: txBuilder.transaction
        });

        txBuilder.addSignature(signature);
        const signatures: Signatures = { posting: signature, active: '' };

        // Complete login: sets iron-session cookie, updates React Query
        await signIn.mutateAsync({
          data: {
            username,
            loginType,
            hivesignerToken: '',
            keyType: KeyType.posting,
            txJSON: txBuilder.toApi(),
            pack: signer.pack,
            strict: false,
            signatures,
            authenticateOnBackend: true
          }
        });

        logger.info('Condenser migration: user %s logged in via %s', username, loginType);
        cleanupCondenserStorage(username);
        markMigrated();
      } catch (error) {
        logger.error(error, 'Condenser migration failed for user %s', username);

        // Network errors: don't mark migrated, retry on next page load
        if (isNetworkError(error)) {
          removeStoredWif(username, loginType);
          return;
        }

        // Signing/validation errors: clean up and give up
        removeStoredWif(username, loginType);
        cleanupCondenserStorage(username);
        markMigrated();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function isNetworkError(error: unknown): boolean {
  // fetch() throws TypeError on network failure
  if (error instanceof TypeError) return true;
  // AbortError from fetch timeout
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  // FetchError with 5xx status (server issues, not client errors)
  if (error instanceof FetchError && error.response.status >= 500) return true;
  return false;
}

function removeStoredWif(username: string, _loginType: LoginType): void {
  // Unconditional REMEDIATION, not just cleanup. Until 2026-08-01 this
  // component wrote a plaintext posting key to `wif.<user>@posting` on page
  // load; anyone who ran that build still has one sitting in localStorage. The
  // WIF branch is gone, so nothing writes it any more — this now deletes the
  // legacy key on the next load regardless of how the user signs in.
  window.localStorage.removeItem(`wif.${username}@posting`);
}
