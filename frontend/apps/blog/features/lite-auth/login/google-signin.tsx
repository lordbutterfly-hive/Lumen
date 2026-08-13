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
/**
 * ★ `?hl=en` IS NOT OPTIONAL (2026-08-10, fuckery list B3). Without it GIS follows
 * the BROWSER UI language, not the document's: on a Croatian Chrome the button read
 * "Nastavite s Googleom" and its iframe title "Gumb za prijavu putem Googlea",
 * inside a page whose `<html lang>` is `en`. One control in a different language
 * than everything around it reads as a third-party graft, which is the opposite of
 * what a sign-in button needs to convey. Lumen is English-only in the app shell
 * today; when the shell is translated this should follow the active locale rather
 * than being hardcoded.
 */
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client?hl=en';

/**
 * ★★ initialize() MUST RUN ONCE PER PAGE (2026-08-10, fuckery list B4). GIS logged
 * `google.accounts.id.initialize() is called multiple times` on every load. Two
 * causes, both real: React StrictMode mounts effects twice in development, and the
 * effect below depends on `onIdToken`/`onError`, which the parent re-creates on
 * every render. The `rendered` ref only guarded the render, not the initialize, and
 * a ref is per-instance anyway — it cannot see a second mount.
 *
 * A module-level guard is the right scope because GIS itself is a page-global
 * singleton: there is exactly one `window.google.accounts.id`. Keyed by client id +
 * nonce so a genuine nonce rotation (which remounts via `key`) still re-initializes.
 */
let initializedFor: string | null = null;

/** GIS clamps rendered width to 200..400 CSS px; outside that it silently ignores it. */
const GSI_MIN_WIDTH = 200;
const GSI_MAX_WIDTH = 400;

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
  const shell = useRef<HTMLDivElement | null>(null);
  const rendered = useRef(false);
  const [loading, setLoading] = useState(true);

  /**
   * The parent re-creates both callbacks on every render, so depending on them
   * re-ran this effect and re-entered `initialize`. Held in refs, kept current by
   * an effect, so the mount effect below can depend on nothing but the nonce.
   */
  const onIdTokenRef = useRef(onIdToken);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onIdTokenRef.current = onIdToken;
    onErrorRef.current = onError;
  }, [onIdToken, onError]);

  useEffect(() => {
    if (!googleConfigured() || !holder.current) return;
    let cancelled = false;

    const render = () => {
      const api = gsi();
      if (cancelled || rendered.current || !api || !holder.current) return;
      try {
        const key = `${googleClientId()}::${nonce ?? ''}`;
        if (initializedFor !== key) {
          api.initialize({
            client_id: googleClientId(),
            callback: (res) => {
              if (res.credential) onIdTokenRef.current(res.credential);
              else onErrorRef.current('Google didn’t return a sign-in token. Please try again.');
            },
            auto_select: false,
            cancel_on_tap_outside: true,
            ...(nonce ? { nonce } : {})
          });
          initializedFor = key;
        }
        // ★ WIDTH IS MEASURED, NOT GUESSED (B1). Hardcoded 380 rendered a 380px
        // button inside a 412px slot, so the pill visibly jumped inward the moment
        // gsi/client finished loading. Ask for the shell's real width, clamped to
        // the range GIS honours, so the rendered button fills the box that was
        // already reserved for it.
        const measured = Math.round(shell.current?.getBoundingClientRect().width ?? 0);
        const width = Math.min(GSI_MAX_WIDTH, Math.max(GSI_MIN_WIDTH, measured || GSI_MAX_WIDTH));
        api.renderButton(holder.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width
        });
        rendered.current = true;
      } catch {
        onErrorRef.current('Google sign-in couldn’t start. Please try another method.');
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
          onErrorRef.current('Couldn’t reach Google. Check your connection or use another method.');
        },
        { once: true }
      );
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
    // Deliberately NOT depending on the callbacks: see the refs above. `nonce` is
    // fixed for the life of this component (the parent remounts via `key`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  if (!googleConfigured()) return null;

  /**
   * ★ ONE ROW, NOT A PILL INSIDE A PILL (2026-08-10, owner, second pass).
   *
   * The first attempt at B1/B2 put Google's own bordered button inside a bordered
   * shell that matched the other rows. That fixed the height and the radius and
   * introduced a worse fault: two nested outlines, a small rounded rectangle floating
   * inside a large one. It looked like a mistake, because it was one.
   *
   * Google's button cannot be restyled: it renders in a cross-origin iframe, so its
   * border, its radius, its Roboto and its centred label are all fixed. There are
   * exactly two ways to make this row match its neighbours, and only one of them
   * keeps the credential flow:
   *
   *   1. One Tap (`prompt()`), which needs no button at all. Rejected here already,
   *      for a good reason kept in this file's header: browser settings can suppress
   *      it silently, which a first-time visitor reads as "broken".
   *   2. Draw our own row, and let Google's real button take the click from on top,
   *      invisible. That is what this does.
   *
   * The visible row is `aria-hidden` and `pointer-events-none`: it is paint, not a
   * control. The real, focusable, clickable control is Google's own button, stretched
   * over the row at `opacity: 0` — so the click, the keyboard activation and the
   * credential all still belong to Google, and nothing here handles an identity it
   * should not touch. `focus-within` puts our own ring on the row when that invisible
   * button takes focus, otherwise keyboard users would see nothing.
   *
   * This is the pattern Google's branding guidance allows for a custom button (their
   * mark, their wording, unmodified logo), and the row is painted before the script
   * lands, so there is still nothing to shift (B1).
   *
   * `scale(1.8)` on the holder: GIS renders at most 400x44 and the row is 412x65, so
   * an unscaled overlay would leave the top and bottom strips dead to the mouse. The
   * parent clips the overflow, so the hit area is exactly the row.
   */
  return (
    <div
      ref={shell}
      data-testid="google-signin-row"
      className="relative mb-1 h-[64px] w-full overflow-hidden rounded-[14px] border border-[#e4e6e9] bg-white focus-within:border-[#c0392b]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none flex h-full w-full items-center gap-3 px-4 text-left"
      >
        <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[10px] bg-white">
          <svg width="22" height="22" viewBox="0 0 48 48" aria-hidden>
            <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
            <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
            <path fill="#FBBC05" d="M11.8 27.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 16.1 2.1 19.9 2.1 23s.9 6.9 2.4 9.9l7.3-5.7z" />
            <path fill="#EA4335" d="M24 9.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 3.3 29.9 1 24 1 15.4 1 8.1 5.9 4.5 13.1l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-[15px] leading-[24px] font-semibold text-[#161511]">Continue with Google</span>
          <span className="block font-sans text-xs text-[#6b7280]">No wallet, no extension, nothing to install.</span>
        </span>
      </div>

      {/* Google's real button: invisible, on top, and the only thing that is
          actually clickable or focusable in this row. */}
      <div className="absolute inset-0 z-10 flex items-center justify-center opacity-0">
        <div ref={holder} style={{ transform: 'scale(1.8)' }} />
      </div>
    </div>
  );
};

export default GoogleSignIn;
