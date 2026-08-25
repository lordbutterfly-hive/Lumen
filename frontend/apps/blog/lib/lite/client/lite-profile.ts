'use client';

import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { LumenProfile } from '../types';

/**
 * Profile and image calls for LITE-tier sessions.
 *
 * A lite account has no Hive keys, so it can neither broadcast a profile update nor
 * sign an image upload in the browser — both go through `/api/lite/*`, which does the
 * signing server-side with the publishing account. Callers branch on
 * `user.account_tier === 'lite'`, the same way the write path does.
 */

const JSON_POST: HeadersInit = { 'Content-Type': 'application/json', [csrfHeaderName]: '1' };

export async function fetchLiteProfile(): Promise<LumenProfile | null> {
  try {
    const res = await fetch('/api/lite/profile');
    if (!res.ok) return null;
    const body = (await res.json()) as { profile?: LumenProfile };
    return body.profile ?? {};
  } catch {
    return null;
  }
}

export async function saveLiteProfile(
  profile: LumenProfile
): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
  try {
    const res = await fetch('/api/lite/profile', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ profile })
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      return { status: 'error', message: body?.message ?? 'Could not save your profile.' };
    }
    return { status: 'ok' };
  } catch {
    return { status: 'error', message: 'Could not save your profile.' };
  }
}

/**
 * Upload one image for a FULL (keyed) account, via `/api/upload`, which signs it
 * server-side with the publishing account.
 *
 * ★ WHY A KEYED ACCOUNT NO LONGER SIGNS ITS OWN UPLOADS (owner, 2026-08-25).
 * Hive's image host signs over the FILE'S BYTES, so a signature cannot be reused
 * across images and every attachment meant another wallet prompt. Moving it
 * server-side removes the prompt; the cost is that the image is attributed to the
 * publisher rather than the uploader. See `app/api/upload/route.ts` for the full
 * reasoning and the trade.
 *
 * Deliberately a SEPARATE function from `uploadLiteImage` even though the bodies
 * are near-identical: the two hit different routes with different gates and
 * different quotas, and collapsing them into one helper with a flag is how the
 * lite path's guarantees would eventually get loosened to suit this one.
 */
/** Thrown when the SERVER cannot sign — the caller should sign it itself instead. */
export class ServerUploadUnavailable extends Error {}

export async function uploadKeyedImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    // No Content-Type: the browser sets the multipart boundary itself.
    headers: { [csrfHeaderName]: '1' },
    body: form
  });
  const body = (await res.json().catch(() => null)) as { url?: string; message?: string; error?: string } | null;
  /* ★★★ 503 IS NOT A FAILURE, IT IS "NOT ME" (2026-08-25, found by running it).
     The server-side uploader REFUSES TO INSTALL under NODE_ENV=production unless
     a KMS-backed signer has been injected — `hive-image-uploader.ts` throws
     "LITE_PUBLISHER_POSTING_WIF must not be used in production". On a production
     build with no KMS wired, this route is therefore 503 by design, and routing
     every keyed upload through it unconditionally turned a working (if
     prompt-y) feature into a broken one. Measured: `{"status":503,
     "error":"uploader_unavailable"}` on the very first real attempt.
     Distinguishing it lets the caller fall back to signing in the browser, which
     always works because the user's own key is right there. */
  /* ★ NARROWED (adversarial review, 2026-08-25). This was
     `res.status === 503 || body?.error === 'uploader_unavailable'`, so ANY 503 —
     a reverse proxy restarting, or `guardWrite`'s unrelated
     `lite_accounts_disabled` — silently downgraded the reader to wallet signing
     with no signal that anything was wrong operationally. Only the specific
     "I have no signer" answer means "you sign it instead"; every other 503 is an
     outage and should surface as one. */
  if (body?.error === 'uploader_unavailable') {
    throw new ServerUploadUnavailable('server cannot sign uploads');
  }
  if (!res.ok || !body?.url) {
    throw new Error(
      body?.message ??
        (res.status === 429
          ? 'You’ve uploaded a lot today — try again tomorrow.'
          : 'Could not upload that image.')
    );
  }
  return body.url;
}

/**
 * Upload one image and get its hosted URL back. Throws with a readable message so
 * the caller can surface it — an upload that fails silently looks like a hung page.
 */
export async function uploadLiteImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/lite/upload', {
    method: 'POST',
    // No Content-Type: the browser sets the multipart boundary itself.
    headers: { [csrfHeaderName]: '1' },
    body: form
  });
  const body = (await res.json().catch(() => null)) as { url?: string; message?: string } | null;
  if (!res.ok || !body?.url) {
    throw new Error(
      body?.message ??
        (res.status === 429
          ? 'You’ve uploaded a lot today — try again tomorrow.'
          : 'Could not upload that image.')
    );
  }
  return body.url;
}
