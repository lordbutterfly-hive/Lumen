'use client';

import { FC, useEffect, useRef, useState } from 'react';
import env from '@beam-australia/react-env';
import { useTranslation } from '@/blog/i18n/client';

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
      /**
       * ISO 639-1 code, or 'auto' (Turnstile's own default) to follow the
       * BROWSER's language. Unset, this widget was auto-detecting Croatian
       * on an English UI (B4). Turnstile falls back to English itself for any
       * code it doesn't recognise (per Cloudflare's docs), so passing the
       * app's locale straight through, unmapped, is safe.
       */
      language?: string;
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
  /**
   * ★ B4 (partial): Turnstile auto-detects the BROWSER's language when no
   * `language` option is passed, independently of what language the app
   * itself is showing — measured rendering the widget in Croatian inside an
   * otherwise-English page. `i18n.resolvedLanguage` is this app's own current
   * locale (same accessor `wallet/components/account-history-row.tsx` and
   * friends already use), so pinning to it keeps the widget in step with
   * whatever language the reader actually chose here, not their OS/browser
   * setting. Falls back to 'en' the same way those callers do, for the
   * window before i18next has resolved a language.
   */
  const { i18n } = useTranslation('common_blog');
  const language = i18n.resolvedLanguage ?? 'en';

  useEffect(() => {
    if (!siteKey || !holder.current) return;
    let cancelled = false;

    const render = () => {
      const api = turnstile();
      if (cancelled || !holder.current || !api || widgetId.current) return;
      widgetId.current = api.render(holder.current, {
        sitekey: siteKey,
        theme: 'light',
        language,
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
    // `language` included: a locale change mid-flow should re-render the
    // widget in the new language rather than leave it pinned to the one that
    // was active on mount (the widget itself is cheap to recreate, and the
    // `widgetId` guard plus this cleanup's `api.remove` keep that safe).
  }, [siteKey, onToken, language]);

  // Not configured: the server passes through too, so there is nothing to show.
  if (!siteKey) return null;

  return (
    <div className="mb-4">
      <div ref={holder} />
      {failed ? (
        <p className="mt-2 text-caption text-ink-warn-3">
          The human check couldn’t load. Please refresh and try again.
        </p>
      ) : null}
    </div>
  );
};

export default TurnstileWidget;
