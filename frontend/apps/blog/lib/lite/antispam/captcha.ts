import { liteConfig } from '../config';

/**
 * CAPTCHA at signup (spec §H) — Cloudflare Turnstile, proven at Ecency. When no
 * secret is configured the check passes through (dev), so the feature can run
 * before Turnstile is provisioned; enable it before opening public signup.
 */

export function captchaEnabled(): boolean {
  return liteConfig.turnstileSecret.length > 0;
}

export async function verifyCaptcha(token: string, ip?: string): Promise<boolean> {
  // F-L8: fail CLOSED in production. An unset Turnstile secret is a dev convenience
  // (pass-through so the feature runs before Turnstile is provisioned), but in prod it
  // meant signup ran with zero bot protection — the exact "fails open" hole. In
  // production an absent secret now rejects; assertLiteEnabled() additionally refuses to
  // even start the signup path without it (config.ts), so this is defence-in-depth.
  if (!captchaEnabled()) return process.env.NODE_ENV !== 'production';
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: liteConfig.turnstileSecret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
