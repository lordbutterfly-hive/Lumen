'use client';

import { FC, useEffect, useRef, useState } from 'react';
import env from '@beam-australia/react-env';

/**
 * Cloudflare Turnstile widget for the signup step.
 *
 * WHY THIS EXISTS: the server already verifies a Turnstile token and, in production,
 * REFUSES to open signup unless the secret is set — but nothing on the client ever
 * produced a token. The moment the secret was set in production, every single signup
 * would have failed with `captcha_failed`, and it would have looked like a backend
 * bug. This closes that loop.
 *
 * Config is symmetric with the server on purpose:
 *   site key unset  -> renders nothing, `onToken('')`, and the server passes through
 *                      (the dev setup, unchanged)
 *   site key set    -> real widget, real token, server verifies it
 *
 * So a half-configured deploy is impossible: either both ends are on, or both are off.
 */

/**
 * Local accessor instead of a `declare global` Window augmentation: augmenting Window
 * from a feature file collides with the other augmentations in this repo (smart-signer
 * declares `window.google` for the Drive backup, and a second augmentation in the same
 * program trips TS2687). A narrow cast keeps this self-contained.
 */
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
    }
  ) => string;
  remove: (id: string) => void;
}

function turnstile(): TurnstileApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null;
}

const SCRIPT_ID = 'cf-turnstile-script';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export function turnstileSiteKey(): string {
  try {
    return env('TURNSTILE_SITE_KEY') || '';
  } catch {
    return '';
  }
}

interface Props {
  /** Called with a fresh token, or '' when it expires/errors and must be redone. */
  onToken: (token: string) => void;
}

const TurnstileWidget: FC<Props> = ({ onToken }) => {
  const siteKey = turnstileSiteKey();
  const holder = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey || !holder.current) return;
    let cancelled = false;

    const render = () => {
      const api = turnstile();
      if (cancelled || !holder.current || !api || widgetId.current) return;
      widgetId.current = api.render(holder.current, {
        sitekey: siteKey,
        theme: 'light',
        callback: (token) => onToken(token),
        // Expiry and errors clear the token, so the submit button disables itself
        // again rather than sending a stale one the server will reject.
        'expired-callback': () => onToken(''),
        'error-callback': () => {
          onToken('');
          setFailed(true);
        }
      });
    };

    const existing = document.getElementById(SCRIPT_ID);
    if (turnstile()) {
      render();
    } else if (existing) {
      existing.addEventListener('load', render, { once: true });
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', render, { once: true });
      script.addEventListener('error', () => setFailed(true), { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      const api = turnstile();
      if (widgetId.current && api) {
        api.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey, onToken]);

  // Not configured: the server passes through too, so there is nothing to show.
  if (!siteKey) return null;

  return (
    <div className="mb-4">
      <div ref={holder} />
      {failed ? (
        <p className="mt-2 text-[13px] leading-[20px] text-ink-warn-3">
          The human check couldn’t load. Please refresh and try again.
        </p>
      ) : null}
    </div>
  );
};

export default TurnstileWidget;
