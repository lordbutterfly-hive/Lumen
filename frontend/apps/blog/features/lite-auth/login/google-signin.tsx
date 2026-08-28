'use client';

import { FC, useEffect, useRef, useState, useCallback} from 'react';
import env from '@beam-australia/react-env';
import { useTranslation } from '@/blog/i18n/client';

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

interface GsiOauth2Api {
  initCodeClient: (opts: {
    client_id: string;
    scope: string;
    ux_mode: 'popup' | 'redirect';
    callback: (res: { code?: string; error?: string }) => void;
  }) => { requestCode: () => void };
}

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
      locale?: string;
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
 *
 * ★ REMAINING GAP, OUT OF THIS FILE'S SCOPE (2026-08-16). The guard above stops
 * THIS component's own StrictMode double-invoke from calling `initialize()` twice
 * for the SAME (client id, nonce) — traced through both the cold-load path (script
 * not yet on the page) and the warm path (script already loaded from an earlier
 * mount): both land on exactly one real `initialize()` call. It cannot stop two
 * genuinely different mounts: `lumen-login.tsx` renders this component keyed on
 * `googleNonce` (`key={googleNonce}`), and the effect that fetches that nonce
 * (`refreshGoogleNonce()` inside `useEffect(() => {...}, [refreshGoogleNonce])`)
 * has no cancellation guard — so under `reactStrictMode: true` (next.config.js) it
 * fires twice, fetches two distinct single-use nonces from the server, and mounts
 * this component twice with two different keys. Each of those two mounts is
 * individually correct (a new nonce genuinely does need a fresh `initialize()`),
 * so what GIS is logging is two REAL, legitimately-different calls, not a bug in
 * the guard above. Fixing the root cause means cancelling the second fetch's
 * `setGoogleNonce` in that effect's cleanup — that effect lives in
 * `lumen-login.tsx`, out of this fix's scope (see task boundary). Flagged here for
 * whoever owns that file.
 */
let initializedFor: string | null = null;

/** GIS clamps rendered width to 200..400 CSS px; outside that it silently ignores it. */
const GSI_MIN_WIDTH = 200;
const GSI_MAX_WIDTH = 400;

/**
 * ★ GIS DRAWS 20px WIDER THAN YOU ASK (measured live 2026-08-28).
 *
 * Ask for `width: 270` and the iframe comes back 290 CSS px. Measured on
 * lumensocial.net/login in a real browser: `width=270` in the iframe's own src,
 * `getBoundingClientRect().width` 290, container 270 — so the button overhung its
 * row by 10px on each side, starting at x=50 while every wallet row starts at
 * x=60. That misalignment, not Google's internal styling, is what made the row
 * look wrong next to the others: it was a different WIDTH and a different LEFT EDGE.
 *
 * The overhead is GIS's own outer box (border + shadow gutter), constant and
 * independent of the requested width. Subtracting it means the RENDERED button
 * measures what the container measures, and the left edges line up.
 *
 * If a GIS update changes this, the symptom is a button slightly narrower or wider
 * than the wallet rows; re-measure `iframe rect width - src width=` and adjust.
 */
const GSI_RENDER_OVERHEAD = 20;

/**
 * ★★★ A RENDERED BUTTON IS NOT A WORKING BUTTON (2026-08-16, defect B3).
 *
 * Measured: with the OAuth client's origin unauthorised, `initialize()` never
 * throws and `renderButton()` never throws either — GSI logs the 403 from
 * `accounts.google.com/gsi/button?...` to the console and quietly leaves the
 * button iframe at 0x0. Nothing in this file's existing try/catch could ever see
 * that: there is no exception to catch. The painted row below still renders (it
 * is plain markup, independent of GSI), so the reader sees what looks like a
 * normal, clickable "Continue with Google" card that is actually inert — the
 * worst failure shape on a sign-up path, because it looks fine.
 *
 * Checked against Google's own JS API reference before reaching for geometry:
 * `initialize()` takes a token `callback` and nothing documented that fires on a
 * render failure, and a cross-origin iframe that comes back 403 still fires the
 * DOM `load` event, not `error` — HTTP status isn't visible to the parent frame
 * at all. Geometry is the only signal GSI leaves behind, and it matches exactly
 * what was measured: the content GSI would have inserted never appears, so
 * `isGoogleButtonRendered` below stays false and never flips true.
 *
 * Why this can't false-positive on a slow-but-working load: `watchAvailability`
 * (below, in the mount effect) does not check geometry once after a timeout and
 * stop there. It keeps a `MutationObserver` on the holder for the life of the
 * component, so the moment content with real size actually appears — 50ms in or
 * 15s in, it doesn't matter — it is picked up and any "unavailable" state already
 * shown is cleared straight back. `RENDER_GRACE_MS` only controls how long we
 * stay quiet before saying anything; a low value can make the warning fire a few
 * seconds too eagerly on a very slow load, but the observer corrects that within
 * one DOM mutation, it can never leave a working button stuck looking broken.
 * The number itself is a conservative guess, not a measured one — this fix
 * cannot run the app to time a real button fetch against a throttled connection
 * (not runtime-verified) — picked to comfortably clear a slow-3G-class load
 * without leaving a fast, genuinely broken load looking fine for too long.
 */
const RENDER_GRACE_MS = 6000;

/**
 * How many times to ask GSI to render again before merely hinting. Three is enough to
 * cover the realistic cause (a first render that beat layout); more would just delay the
 * hint for a genuinely dead client.
 */
const RENDER_RETRIES = 3;
const RENDER_RETRY_MS = 1500;

/**
 * Measures whatever GSI actually put in the DOM rather than trusting the
 * holder's own auto-size: if GSI positions its iframe absolutely (common for
 * embedded-widget SDKs, precisely so they don't nudge host-page layout), the
 * holder's own box can stay 0x0 even when the button rendered fine elsewhere in
 * the viewport. Querying for the iframe first measures the thing that is
 * actually clickable; falling back to the holder itself keeps this correct in
 * the true-failure case too, where GSI inserts nothing at all.
 */
function isGoogleButtonRendered(container: HTMLElement): boolean {
  const frame = container.querySelector('iframe');
  const rect = (frame ?? container).getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

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
  /** Auth CODE from initCodeClient — the path that lets Lumen draw its own button. */
  onCode?: (code: string) => void;
  /** When true, render Lumen's own row and drive the flow ourselves. */
  codeFlow?: boolean;
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

const GoogleSignIn: FC<Props> = ({ onIdToken, onCode, codeFlow, onError, nonce }) => {
  const holder = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const rendered = useRef(false);
  const [loading, setLoading] = useState(true);
  // B3: flips true only once `watchAvailability` (below) has given GSI a full
  // RENDER_GRACE_MS and still sees a 0x0 button. Starts false so a fresh mount
  // (or a remount on a fresh nonce) always gets that grace period before this
  // says anything — see the comment above RENDER_GRACE_MS for why it's also
  // safe to flip back false later if a slow load turns out to be a real one.
  const [unavailable, setUnavailable] = useState(false);
  const { t } = useTranslation('common_blog');

  /**
   * The parent re-creates both callbacks on every render, so depending on them
   * re-ran this effect and re-entered `initialize`. Held in refs, kept current by
   * an effect, so the mount effect below can depend on nothing but the nonce.
   */
  const onIdTokenRef = useRef(onIdToken);
  const onCodeRef = useRef(onCode);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onIdTokenRef.current = onIdToken;
    onCodeRef.current = onCode;
    onErrorRef.current = onError;
  }, [onIdToken, onCode, onError]);

  useEffect(() => {
    if (!googleConfigured() || !holder.current) return;
    let cancelled = false;
    let stopWatching: (() => void) | null = null;

    /**
     * B3: once GSI has been asked to render, watch what it actually produced
     * instead of trusting that `renderButton()` not throwing means it worked.
     * See the RENDER_GRACE_MS comment above for why keeping the
     * MutationObserver alive for the whole mount (not just until the grace
     * timer fires) is what makes this safe against a slow-but-working load.
     */
    const watchAvailability = () => {
      if (!holder.current) return;
      const container = holder.current;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const check = () => {
        if (!isGoogleButtonRendered(container)) return;
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        setUnavailable(false);
      };

      const observer = new MutationObserver(check);
      observer.observe(container, { childList: true, subtree: true, attributes: true });
      check(); // covers a synchronous insert, so a fast load never waits on a mutation event

      /**
       * ★★★ IT RETRIES, AND IT FAILS OPEN (2026-08-19, owner-reported P0).
       *
       * This used to fire ONCE and, on a 0x0 button, call `setUnavailable(true)` - which
       * greyed the row, set `aria-disabled`, and put `pointer-events: none` over Google's
       * own button. So the single most prominent sign-in path, the ONLY one aimed at
       * people without a crypto wallet, disabled itself ~6s after load and stayed dead
       * for the rest of the session.
       *
       * TWO THINGS WERE WRONG WITH THAT, AND THE SECOND IS THE IMPORTANT ONE.
       *
       * 1. It gave up instead of trying again. GSI sizes the button from its container at
       *    render time, so a render that lands before layout settles produces a 0x0
       *    iframe permanently - re-rendering into a now-measured container is very likely
       *    to succeed, and we never asked.
       *
       * 2. It failed CLOSED. A silent, recoverable, routinely-normal condition was
       *    allowed to permanently remove the primary sign-in route. The geometry probe is
       *    a heuristic about what GSI drew; it is NOT a statement about whether Google
       *    sign-in works. Treating a heuristic as authority, and then acting
       *    destructively on it, is how a working button ends up unclickable.
       *
       * Now: retry with backoff, and if every retry still measures zero, leave the button
       * ENABLED and merely hint. A click on a genuinely broken button surfaces a real
       * error, which is strictly better information than refusing the click.
       */
      const attemptRerender = (attempt: number) => {
        if (cancelled || isGoogleButtonRendered(container)) {
          setUnavailable(false);
          return;
        }
        if (attempt >= RENDER_RETRIES) {
          // Out of retries. Hint, but never disable - see (2) above.
          setUnavailable(true);
          return;
        }
        // Clear the guard so `render()` will actually run again, and let it re-measure
        // the shell, which by now has certainly been laid out.
        rendered.current = false;
        render();
        graceTimer = setTimeout(() => attemptRerender(attempt + 1), RENDER_RETRY_MS);
      };

      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (cancelled || isGoogleButtonRendered(container)) return;
        attemptRerender(0);
      }, RENDER_GRACE_MS);

      stopWatching = () => {
        observer.disconnect();
        if (graceTimer) clearTimeout(graceTimer);
      };
    };

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
        // Ask for the container width MINUS the overhead above, so the button GIS
        // actually draws is the width of the row it sits in.
        const target = (measured || GSI_MAX_WIDTH) - GSI_RENDER_OVERHEAD;
        const width = Math.min(GSI_MAX_WIDTH, Math.max(GSI_MIN_WIDTH, target));
        api.renderButton(holder.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width,
          /* ★ `locale` MUST be passed HERE too, not just as `?hl=en` on the script
             (2026-08-28, owner screenshot). The script-level pin governs the library,
             but `renderButton` re-resolves the button's own language, and with it
             absent GIS falls back to the BROWSER's locale. Live evidence: a Croatian
             browser rendered "Nastavite kao Damir" inside an English page, on the very
             widget the 2026-08-10 `?hl=en` fix was added to keep in English. Same class
             of defect as that one, a layer lower down. */
          locale: 'en'
        });
        rendered.current = true;
        watchAvailability();
      } catch {
        onErrorRef.current('Google sign-in couldn’t start. Please try another method.');
      } finally {
        setLoading(false);
      }
    };

    const handleScriptError = () => {
      setLoading(false);
      onErrorRef.current('Couldn’t reach Google. Check your connection or use another method.');
    };

    const existing = document.getElementById(SCRIPT_ID);
    // Only removed in cleanup if THIS instance was the one that attached it —
    // the script tag itself is deliberately never removed (it's a shared,
    // page-global resource other mounts may still be waiting on).
    let loadTarget: HTMLElement | null = null;
    let ownedScript: HTMLScriptElement | null = null;
    if (gsi()) {
      render();
    } else if (existing) {
      existing.addEventListener('load', render, { once: true });
      loadTarget = existing;
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', render, { once: true });
      script.addEventListener('error', handleScriptError, { once: true });
      document.head.appendChild(script);
      loadTarget = script;
      ownedScript = script;
    }

    return () => {
      cancelled = true;
      stopWatching?.();
      // `{ once: true }` already self-removes a listener that FIRED; this only
      // matters for one that unmounted before firing, so it doesn't keep this
      // closure (and everything it captures) alive off a script tag that, per
      // the comment above, is never itself removed.
      loadTarget?.removeEventListener('load', render);
      ownedScript?.removeEventListener('error', handleScriptError);
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
   * (The old invisible-overlay geometry notes were removed on 2026-08-28 when the
   * overlay itself was deleted — see the comment in the returned JSX.)
   *
   * ★ B3: the `holder` div below stays mounted in BOTH states, unavailable or not.
   * It is the exact DOM node GSI's `renderButton` call was pointed at, and it's what
   * `watchAvailability` keeps watching — swapping it out of the tree on "unavailable"
   * would destroy the node GSI is using and make the self-heal described above
   * impossible. Only the surrounding paint and interactivity change.
   */
  /**
   * ★ LUMEN'S OWN BUTTON (2026-08-28, owner: "put back the lumen styling").
   *
   * This is the ORIGINAL row design, restored — but as a REAL button, not a
   * decorative one. The previous version painted this same row with
   * `pointer-events-none` and hid GIS's real iframe on top of it under
   * `opacity-0` + `transform: scale()`; GIS refuses to act on a click when its
   * button is transparent, transformed or clipped, so that could never work.
   * Driving the flow ourselves with `initCodeClient` is the only way to have
   * Lumen's styling AND a working button.
   */
  const startCodeFlow = useCallback(() => {
    const api = (window as unknown as { google?: { accounts?: { oauth2?: GsiOauth2Api } } })
      .google?.accounts?.oauth2;
    if (!api) {
      onErrorRef.current('Google sign-in is still loading. Try again in a moment.');
      return;
    }
    try {
      api
        .initCodeClient({
          client_id: googleClientId(),
          scope: 'openid email profile',
          ux_mode: 'popup',
          callback: (res) => {
            if (res.code) onCodeRef.current?.(res.code);
            else onErrorRef.current('Google sign-in was cancelled.');
          }
        })
        .requestCode();
    } catch {
      onErrorRef.current('Google sign-in couldn’t start. Please try another method.');
    }
  }, []);

  if (codeFlow) {
    return (
      <button
        type="button"
        data-testid="google-signin-row"
        onClick={startCodeFlow}
        className="mb-1 flex w-full cursor-pointer items-center gap-3 rounded-card border border-line-11 bg-surface-1 px-4 py-3 text-left hover:border-line-warn-5 hover:bg-surface-warn-1"
      >
        <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-control bg-surface-1">
          <svg width="22" height="22" viewBox="0 0 48 48" aria-hidden>
            <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
            <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
            <path fill="#FBBC05" d="M11.8 27.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 16.1 2.1 19.9 2.1 23s.9 6.9 2.4 9.9l7.3-5.7z" />
            <path fill="#EA4335" d="M24 9.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 3.3 29.9 1 24 1 15.4 1 8.1 5.9 4.5 13.1l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-[15px] leading-[24px] font-semibold text-ink-2">Continue with Google</span>
          <span className="block font-sans text-caption text-ink-10">No wallet, no extension, nothing to install.</span>
        </span>
      </button>
    );
  }

  return (
    <div
      ref={shell}
      data-testid="google-signin-row"
      /* No `aria-disabled` and no dimming: the row stays fully live. `unavailable` is a
         HINT that our geometry probe saw nothing, not a verdict that Google is down. */
      /* ★ `min-h`, NOT `h` (2026-08-19, owner-reported with a screenshot).
         This was a fixed `h-[64px]` with `overflow-hidden` — sized for the
         one-line subtitle ("No wallet, no extension, nothing to install."). The
         B3 swap below replaces that subtitle IN PLACE with a much longer
         sentence ("Google sign-in is unavailable right now. Use a Bitcoin or
         Ethereum wallet, or sign in with Hive below."), which wraps to three
         lines at this width and had its last line clipped off by the fixed
         height. So the row explaining the failure was itself broken, and the
         reader was told to "sign in with Hive bel" — the instruction was the
         part that got cut. The row now grows to fit its own message; 64px stays
         as the floor so the normal state is pixel-identical. */
      /* ★ THE ORANGE OUTLINE (2026-08-28, owner reported it on the live site).
         globals.css:1231 sets `:focus-visible:not([contenteditable]) { outline: 2px
         solid rgb(var(--line-brand-10)) }` on EVERYTHING. That token is #c0392b, and
         thin + antialiased it reads orange, not red — the same complaint that was
         fixed across 24 input sites on 2026-08-27. Google's button is an IFRAME
         injected by gsi/client after those fixes shipped, so it never got one.
         Focusing the row painted a 2px orange rectangle around an element that is
         deliberately invisible, which looks like a rendering fault rather than focus.
         `[&_iframe]:focus-visible:outline-none` is (0,2,1) and beats the global
         (0,2,0). The affordance is NOT lost: `focus-within:border-line-brand-10`
         below already turns the row's own border brand red, which is the visible,
         intended treatment. Suppressing the outline without that border would have
         removed the only focus indicator, which is the trap the 08-27 pass called
         out at witnesses-filters-card.tsx:67. */
      className="mb-1 w-full"
    >
      {/* ★★★ GOOGLE'S BUTTON IS NOW THE REAL, VISIBLE BUTTON (2026-08-28).
          THE BUG THIS REPLACES, and why the previous design could never work:
          this row used to be a Lumen-styled fake with `pointer-events-none`, and
          GSI's real iframe was stretched over it inside
          `absolute inset-0 z-10 opacity-0` with `transform: scale(...)`, all
          clipped by `overflow-hidden` on the card.
          Google Identity Services REFUSES TO ACT ON A CLICK when its button is
          transparent, transformed or clipped. It is anti-clickjacking protection,
          and it is silent: the iframe loads 200, hit-testing lands on it, focus
          even moves into it, and the click is simply swallowed. No popup, no
          network call, no console error.
          PROVEN, not guessed: neutralising the wrapper in the live DOM
          (`transform:none; opacity:1; overflow:visible`) and clicking the exact
          same pixel fired the flow immediately and opened
          accounts.google.com/o/oauth2/v2/auth. Nothing else was changed.
          ★ Note for whoever is tempted to restore the overlay: making the scale
          LARGER makes it worse, not better. That was tried the same day.
          So: no opacity trick, no transform, no clipping ancestor. Google draws
          its own button, at its own size, and we style around it. The tradeoff is
          that this row no longer matches the wallet rows pixel for pixel; a
          working sign-in beats a consistent one. `renderButton` is still used
          rather than One Tap for the reasons at the top of this file. */}
      <div ref={holder} className="flex w-full justify-center" />
      {/* The availability message stays BELOW the button rather than inside it:
          the row is Google's now, and injecting our own text into its box is what
          started the whole overlay problem. */}
      {unavailable && (
        <p className="mt-2 text-center font-sans text-caption text-ink-warn-3">
          {t('lite_auth.google_signin.unavailable')}
        </p>
      )}
    </div>
  );
};

export default GoogleSignIn;
