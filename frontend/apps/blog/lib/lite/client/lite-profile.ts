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
