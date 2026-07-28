'use client';

import { FC, useEffect, useRef, useState } from 'react';
import env from '@beam-australia/react-env';

/**
 * Google Identity Services sign-in button.
 *
 * The backend for this (`/api/lite/auth/google`, `auth/google-verify.ts`) has been
 * built, tested and unused: the button on the login page just displayed "Google
 * sign-in is being set up", because nothing ever acquired an ID token. This is that
 * missing half.
 *
 * Config seam, same shape as the Turnstile widget: with no client id we render
 * nothing and the caller keeps its explanatory message, so a half-configured deploy
 * shows an honest state instead of a button that fails. Set
 * `REACT_APP_LITE_GOOGLE_CLIENT_ID` (public, client-side) alongside the server's
 * `LITE_GOOGLE_CLIENT_ID` — Google's own console requires the site's origin to be
 * registered too, so a wrong/missing origin surfaces as an onerror here rather than
 * a silent no-op.
 *
 * We use `renderButton` rather than One Tap deliberately: One Tap can be suppressed by
 * browser settings with no feedback, which is indistinguishable from "broken" for a
 * first-time visitor.
 */

interface GoogleCredentialResponse {
  credential?: string;
}

/**
 * Local accessor rather than a `declare global` for `window.google`: another feature
 * (Google Drive key backup) already declares that global with a different shape, and
 * two declarations conflict. Reading it through a narrow cast keeps both working.
 */
interface GsiIdApi {
  initialize: (opts: {
    client_id: string;
    callback: (res: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    /** Echoed into the ID token's `nonce` claim — required by the bind step-up. */
    nonce?: string;
  }) => void;
  renderButton: (
    el: HTMLElement,
    opts: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'small' | 'medium' | 'large';
      text?: 'signin_with' | 'signup_with' | 'continue_with';
      shape?: 'rectangular' | 'pill';
      width?: number;
      logo_alignment?: 'left' | 'center';
    }
  ) => void;
}

function gsi(): GsiIdApi | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { google?: { accounts?: { id?: GsiIdApi } } };
  return w.google?.accounts?.id ?? null;
}

const SCRIPT_ID = 'google-gsi-client';
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

export function googleClientId(): string {
  try {
    return env('LITE_GOOGLE_CLIENT_ID') || '';
  } catch {
    return '';
  }
}

/** A placeholder value counts as unset — it must never render a doomed button. */
export function googleConfigured(): boolean {
  const id = googleClientId();
  return id.length > 0 && !/placeholder/i.test(id) && id.endsWith('.apps.googleusercontent.com');
}

interface Props {
  /** Receives the Google ID token; hand it to /api/lite/auth/google. */
  onIdToken: (idToken: string) => void;
  onError: (message: string) => void;
  /**
   * Step-up nonce for LINKING Google to an existing account. `/api/lite/auth/bind`
   * refuses any ID token whose `nonce` claim does not match the challenge it issued
   * (XC-2), so a bind caller must pass it here. Sign-in leaves it undefined.
   *
   * The nonce is fixed for the life of this component — GIS captures it at
   * `initialize` and the button is rendered once. Callers that need a fresh nonce
   * should remount via `key={nonce}` rather than change the prop underneath it.
   */
  nonce?: string;
}

const GoogleSignIn: FC<Props> = ({ onIdToken, onError, nonce }) => {
  const holder = useRef<HTMLDivElement | null>(null);
  const rendered = useRef(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!googleConfigured() || !holder.current) return;
    let cancelled = false;

    const render = () => {
      const api = gsi();
      if (cancelled || rendered.current || !api || !holder.current) return;
      try {
        api.initialize({
          client_id: googleClientId(),
          callback: (res) => {
            if (res.credential) onIdToken(res.credential);
            else onError('Google didn’t return a sign-in token — please try again.');
          },
          auto_select: false,
          cancel_on_tap_outside: true,
          ...(nonce ? { nonce } : {})
        });
        api.renderButton(holder.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: 380
        });
        rendered.current = true;
      } catch {
        onError('Google sign-in couldn’t start. Please try another method.');
      } finally {
        setLoading(false);
      }
    };

    const existing = document.getElementById(SCRIPT_ID);
    if (gsi()) {
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
      script.addEventListener(
        'error',
        () => {
          setLoading(false);
          onError('Couldn’t reach Google. Check your connection or use another method.');
        },
        { once: true }
      );
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
  }, [onIdToken, onError]);

  if (!googleConfigured()) return null;

  return (
    <div className="mb-1">
      <div ref={holder} className="flex justify-center" />
      {loading ? <div className="h-[44px]" aria-hidden /> : null}
    </div>
  );
};

export default GoogleSignIn;
