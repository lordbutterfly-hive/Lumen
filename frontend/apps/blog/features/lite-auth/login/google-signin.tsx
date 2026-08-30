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
 * We use `renderButton` rather than One Tap by default: One Tap can be suppressed by
 * browser settings with no feedback, which is indistinguishable from "broken" for a
 * first-time visitor. `promptFlow` below (2026-08-28) opts back into One Tap/FedCM
 * for a Lumen-styled button with no client secret, but only with a fallback wired
 * to the exact failure this paragraph describes — see the props doc and `startPrompt`.
 */

interface GsiOauth2Api {
  initCodeClient: (opts: {
    client_id: string;
    scope: string;
    ux_mode: 'popup' | 'redirect';
    callback: (res: { code?: string; error?: string }) => void;
  }) => { requestCode: () => void };
}

/**
 * Google's OpenID Connect authorization endpoint, and the page it hands the
 * token back to. Taken from Google's own discovery document
 * (`accounts.google.com/.well-known/openid-configuration`), which also
 * advertises `id_token` in `response_types_supported` — the fact this whole
 * flow rests on. `RETURN_PATH` must be registered as an Authorized redirect URI
 * on the OAuth client, or Google answers `redirect_uri_mismatch`.
 */
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const RETURN_PATH = '/auth/google/return';
/** Must match the sender in `app/auth/google/return/page.tsx`. */
const RETURN_MESSAGE_TYPE = 'lumen:google-id-token';

/** Google's FedCM provider manifest — the identity provider `credentials.get` talks to. */
const GOOGLE_FEDCM_CONFIG_URL = 'https://accounts.google.com/gsi/fedcm.json';

/**
 * The FedCM shapes `lib.dom` does not declare yet. Narrow, hand-written and local
 * rather than a cast to `any`: the only fields read are the ones written here.
 */
interface FedcmCredentialsContainer {
  get: (opts: {
    identity: {
      mode: 'active' | 'passive';
      providers: { configURL: string; clientId: string; nonce?: string }[];
    };
  }) => Promise<Credential | null>;
}
/** What active-mode FedCM resolves with: `token` is a Google-signed ID token (JWT). */
interface IdentityCredentialLike {
  token?: string;
}
/** Does this browser implement FedCM at all? Checked before the call, not after. */
function fedcmAvailable(): boolean {
  return typeof window !== 'undefined' && 'IdentityCredential' in window;
}

interface GoogleCredentialResponse {
  credential?: string;
}

/**
 * What `prompt()` hands its moment listener. Distinguishes "One Tap / FedCM could
 * not be shown at all" (third-party cookies blocked, FedCM disabled, no Google
 * session in the browser — a structurally dead mechanism for this visitor) from
 * "the reader saw it and closed it" (a normal, retryable choice). Only the first
 * kind should demote the row to the real `renderButton()` fallback — see
 * `startPrompt` below.
 */
interface GsiPromptMomentNotification {
  isNotDisplayed: () => boolean;
  getNotDisplayedReason: () => string;
  isSkippedMoment: () => boolean;
  getSkippedReason: () => string;
  isDismissedMoment: () => boolean;
  getDismissedReason: () => string;
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
    /**
     * ★ BOTH FedCM FLAGS ARE DELIBERATELY ABSENT. `initialize()` here only
     * configures the STOCK fallback button, which must stay on Google's classic
     * OAuth popup so it is independent of FedCM — the mechanism it exists to fall
     * back FROM. Lumen's own button drives FedCM directly via
     * `navigator.credentials.get`; see `startPrompt`.
     */
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
  /** One Tap / FedCM, triggered by OUR click handler — see `startPrompt`. */
  prompt: (momentListener?: (notification: GsiPromptMomentNotification) => void) => void;
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
  /**
   * ★★★ THE PATH THAT ACTUALLY DELIVERS LUMEN'S OWN BUTTON. Opens Google's
   * OIDC authorization endpoint directly asking for `response_type=id_token`:
   * no client secret, no GIS iframe, no FedCM — see `startIdTokenFlow`.
   * Requires `<origin>/auth/google/return` to be a registered Authorized
   * redirect URI. Takes precedence when more than one flow flag is set.
   */
  idTokenFlow?: boolean;
  /** When true, render Lumen's own row and drive the flow ourselves. */
  codeFlow?: boolean;
  /**
   * ★ THE NO-SECRET PATH TO LUMEN'S OWN BUTTON (2026-08-28).
   *
   * `codeFlow` needs `LITE_GOOGLE_CLIENT_SECRET`, which production does not have
   * configured. This gets the same Lumen-styled row without one: the row's `onClick`
   * calls `google.accounts.id.prompt()` (One Tap / FedCM) instead of drawing a real
   * GSI iframe under it — there is no iframe to protect, so this is not the
   * transparent/transformed/clipped overlay pattern that broke the old design; it's a
   * real, opaque, keyboard-reachable `<button>` whose click starts a SEPARATE,
   * Google-hosted UI surface (the browser's own account chooser), not a disguised
   * click on Google's button.
   *
   * `prompt()` can silently decline to show anything at all (third-party cookies
   * blocked, FedCM off, no Google session in this browser) — GSI's own moment
   * listener is the only way to find out, since there is no visible failure
   * otherwise. When it reports that, this component falls back to the real
   * `renderButton()` iframe so the reader always has a WORKING door, just not
   * always Lumen's own paint on it. See `startPrompt` below.
   */
  promptFlow?: boolean;
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

const GoogleSignIn: FC<Props> = ({ onIdToken, onCode, codeFlow, promptFlow, idTokenFlow, onError, nonce }) => {
  const holder = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const rendered = useRef(false);
  const [loading, setLoading] = useState(true);
  // ★ promptFlow's fallback (2026-08-28). Starts false: try Lumen's own button
  // first, driven by `prompt()`. Flips true only when GSI's own moment listener
  // says the prompt could not be shown at all (see `startPrompt`) — never on a
  // reader closing it, which is a normal, retryable choice, not a broken flow.
  // Once true, the effect below renders the real GSI iframe as a fallback so the
  // reader always has a WORKING door.
  const [promptFailed, setPromptFailed] = useState(false);
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
    // ★ NO `!holder.current` GATE HERE ANY MORE (2026-08-28, promptFlow). The
    // holder div only exists once this component is showing the REAL button —
    // in `codeFlow` and `promptFlow` mode it isn't mounted at all until a
    // fallback is needed (see the JSX below), but `initialize()` still has to
    // run early so `startPrompt`'s `prompt()` call and `startCodeFlow`'s
    // `initCodeClient` both have a live `window.google` to call. Each of
    // `ensureInitialized`/`renderRealButton` below re-checks what it individually
    // needs instead.
    if (!googleConfigured()) return;
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
        // Clear the guard so `renderRealButton()` will actually run again, and let
        // it re-measure the shell, which by now has certainly been laid out.
        rendered.current = false;
        renderRealButton();
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

    /**
     * ★★ SPLIT FROM A SINGLE `render()` (2026-08-28, promptFlow). This used to
     * initialize AND renderButton in one call, gated on `holder.current` existing
     * — fine when the holder was always mounted, wrong now that `codeFlow` and
     * `promptFlow` mode don't mount it until (or unless) a real button is
     * actually needed. `ensureInitialized` needs no DOM node: it only registers
     * the callback GIS calls with a credential, which every mode needs (the
     * default renderButton flow, AND `promptFlow`'s `prompt()` — `codeFlow` is
     * the one mode that skips `accounts.id` entirely and never calls this).
     */
    const ensureInitialized = (): boolean => {
      const api = gsi();
      if (cancelled || !api) return false;
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
          /**
           * ★★★ NO FedCM FLAG HERE — AND A FALLBACK THAT SHARES THE FAILING
           * MECHANISM IS NOT A FALLBACK (2026-08-28).
           *
           * `initialize()` now configures ONE thing: the stock `renderButton`
           * shown when FedCM could not run. Lumen's own pill does not come
           * through here at all — it calls `navigator.credentials.get` directly
           * (see `startPrompt`), because no GIS option gives OUR button active
           * mode.
           *
           * The button flag used to be set here, and it was a mistake: it makes
           * GIS's rendered button use FedCM too. So when FedCM was the thing that
           * failed, the reader was demoted to a button running the SAME mechanism,
           * which failed the same way. Left off, the stock button uses Google's
           * classic OAuth popup — a completely independent path — which is the
           * entire reason it exists.
           *
           * Do not "restore" either FedCM flag here. The prompt one is worse
           * still: deprecated, ignored, and it silently downgrades the call to
           * passive mode (One Tap), which cannot answer a click on any browser.
           */
          ...(nonce ? { nonce } : {})
        });
        initializedFor = key;
      }
      return true;
    };

    const renderRealButton = () => {
      const api = gsi();
      if (cancelled || rendered.current || !api || !holder.current) return;
      try {
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

    /**
     * What actually happens once GSI's script is available. `codeFlow` needs
     * nothing from `accounts.id` at all (it drives `oauth2.initCodeClient`
     * itself, on click — see `startCodeFlow`). `promptFlow`, until its own
     * click handler discovers `prompt()` can't be shown, also holds off
     * rendering the real button — the whole point is to show Lumen's row
     * instead. Everything else (the default mode, and promptFlow AFTER a
     * failed prompt) renders the real button immediately, same as before.
     */
    const boot = () => {
      if (cancelled || !ensureInitialized()) return;
      if (codeFlow || (promptFlow && !promptFailed)) {
        setLoading(false);
        return;
      }
      renderRealButton();
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
      boot();
    } else if (existing) {
      existing.addEventListener('load', boot, { once: true });
      loadTarget = existing;
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', boot, { once: true });
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
      loadTarget?.removeEventListener('load', boot);
      ownedScript?.removeEventListener('error', handleScriptError);
    };
    // Deliberately NOT depending on the callbacks: see the refs above. `nonce` is
    // fixed for the life of this component (the parent remounts via `key`).
    // ★ `promptFailed` IS a dep (2026-08-28): the fallback needs this whole effect
    // to re-run once `startPrompt` flips it, so `boot()` re-evaluates and this
    // time calls `renderRealButton()`. Safe to re-run in full: by the time
    // `promptFailed` can ever become true, GSI's script has necessarily already
    // loaded (see `startPrompt`), so this re-entry takes the `if (gsi())` branch
    // directly — no second script tag, no listener left dangling from the first
    // run (that run took the same branch, so `loadTarget`/`ownedScript` were
    // never set and cleanup below is a no-op).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, promptFailed]);

  if (!googleConfigured()) return null;

  /**
   * ★ ONE ROW, NOT A PILL INSIDE A PILL (2026-08-10, owner, second pass; superseded
   * 2026-08-28, then extended again the same day for `promptFlow`).
   *
   * The first attempt at B1/B2 put Google's own bordered button inside a bordered
   * shell that matched the other rows — two nested outlines, a small rounded
   * rectangle floating inside a large one. A later attempt painted a Lumen-styled
   * row and stretched GSI's real, invisible iframe over it at `opacity: 0` with a
   * `transform: scale(...)`, so the click still belonged to Google. THAT is the
   * design this file's history used to describe here. It is gone: GSI silently
   * refuses to act on a click when its own iframe is transparent, transformed or
   * clipped (anti-clickjacking) — proven live, not theoretical, see the JSX below
   * — so that row could never actually be clicked.
   *
   * What ships today has THREE modes, chosen by the caller via `codeFlow` /
   * `promptFlow`, all real (non-overlay) buttons:
   *
   *   - Default (both flags off): Google's own `renderButton()` iframe, drawn
   *     directly and visibly — no Lumen paint over it, no invisible click target.
   *     This is GSI's button as GSI ships it; matching the other rows exactly is
   *     off the table (Google owns that iframe's border, radius and font).
   *   - `codeFlow`: a genuine Lumen `<button>` whose click drives
   *     `oauth2.initCodeClient` (`startCodeFlow`) — needs `LITE_GOOGLE_CLIENT_SECRET`
   *     server-side to exchange the resulting code.
   *   - `promptFlow`: the SAME Lumen `<button>` markup, whose click instead calls
   *     `accounts.id.prompt()` (`startPrompt`) — One Tap / FedCM, no secret needed.
   *     If GSI's own moment listener reports it couldn't be shown at all (blocked
   *     third-party cookies, FedCM off, no Google session), this falls back to
   *     the real `renderButton()` iframe rather than leaving a dead button up.
   *
   * ★ B3: the `holder` div stays mounted in BOTH states of the default/fallback
   * modes, unavailable or not. It is the exact DOM node GSI's `renderButton` call
   * is pointed at, and it's what `watchAvailability` keeps watching — swapping it
   * out of the tree on "unavailable" would destroy the node GSI is using and make
   * the self-heal described there impossible. Only the surrounding paint and
   * interactivity change.
   */
  /**
   * ★ LUMEN'S OWN BUTTON (2026-08-28, owner: "put back the lumen styling").
   *
   * This is the ORIGINAL row design, restored — but as a REAL button, not a
   * decorative one. The previous version painted this same row with
   * `pointer-events-none` and hid GIS's real iframe on top of it under
   * `opacity-0` + `transform: scale()`; GIS refuses to act on a click when its
   * button is transparent, transformed or clipped, so that could never work.
   * Driving the flow ourselves — with `initCodeClient` here, or with `prompt()`
   * in `startPrompt` below — is the only way to have Lumen's styling AND a
   * working button. Same markup either way; only the click handler differs.
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

  /**
   * ★ THE NO-SECRET PATH (2026-08-28). `google.accounts.id.prompt()` opens the browser's
   * own account chooser, because `ensureInitialized` above sets
   * `use_fedcm_for_button: true` — FedCM's ACTIVE mode, the one built to answer a
   * click on the site's own button. It is
   * a SEPARATE surface Google draws on top of the page, not an iframe living inside
   * this row — so there is nothing here for the anti-clickjacking check to refuse,
   * unlike the old overlay design this file's history warns about.
   *
   * ★★ IT IS NOT ONE TAP, AND THE DIFFERENCE IS THE WHOLE FEATURE. One Tap is
   * FedCM's PASSIVE mode: opportunistic, shown when the browser feels like it, and
   * never in response to a click. Driving this button through passive mode is what
   * the first attempt did, and it failed on a signed-in browser every time. If this
   * ever regresses, the one-line diagnostic is the `mode` field of the
   * `navigator.credentials.get()` call the click produces: `active` is correct,
   * `passive` means the flag did not land and nothing else about the row matters.
   *
   * The moment listener is the ONLY signal for "this could not be shown at all":
   * GSI does not throw, and does not fire the `initialize()` callback either, when
   * `prompt()` silently declines.
   *
   * ★ WHICH REASONS TRIGGER THE FALLBACK — a judgment call, not yet runtime-verified
   * against a real moment notification (this repo cannot drive an actual Google
   * account through `prompt()` from here; flagging for whoever tests this against
   * a live deploy). Per Google's own documented reason strings:
   *   - `isNotDisplayed()` (`opt_out_or_no_session`, `suppressed_by_user`,
   *     `unregistered_origin`, `browser_not_supported`, `secure_http_required`,
   *     `invalid_client`, `missing_client_id`) — unambiguous: nothing appeared, and
   *     clicking again gets the same answer. Always falls back.
   *   - `isSkippedMoment()` — a mixed bag. `issuing_failed` is a real failure and
   *     should fall back; `auto_cancel` / `user_cancel` / `tap_outside` are closer
   *     to a dismissal (the reader interacted, or a rapid re-click auto-cancelled
   *     the previous one) and arguably should NOT. Folded into the fallback anyway,
   *     because the owner's own instruction is explicit: "a working ugly button
   *     beats a pretty dead one" — worst case, a reader who tap-cancelled once sees
   *     the real GSI button instead of a second try at Lumen's, which still signs
   *     them in. That is a worse LOOK, never a worse OUTCOME.
   *   - `isDismissedMoment()` (`credential_returned` — success; `cancel_called` — we
   *     never call `cancel()`; `flow_restarted`) — NOT treated as failure. None of
   *     these mean the mechanism is broken, and `credential_returned` is the happy
   *     path itself.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ★★★ CALL THE BROWSER, NOT GOOGLE'S WRAPPER (2026-08-28, third attempt).
   *
   * THE TWO ATTEMPTS THAT FAILED, AND WHY, so nobody repeats them:
   *   1. A Lumen row with GIS's real button stretched over it, invisible
   *      (`opacity-0` + `transform: scale()` inside `overflow-hidden`). GIS
   *      REFUSES to act on a click when its button is transparent, transformed or
   *      clipped — anti-clickjacking, and completely silent.
   *   2. `google.accounts.id.prompt()` with `use_fedcm_for_prompt: true`. That
   *      flag is deprecated and ignored. MEASURED on the deployed site by trapping
   *      `navigator.credentials.get`: the click produced
   *      `{mode: "passive", configURL: ".../gsi/fedcm.json", nonce: set}`, which
   *      was rejected ~13s later with `NetworkError: Error retrieving a token`.
   *      Passive mode IS One Tap: opportunistic, suppressible, and structurally
   *      incapable of opening an account chooser in response to a click. Swapping
   *      in `use_fedcm_for_button` did NOT fix it — re-measured, still `passive` —
   *      because that flag binds active mode to GIS's OWN rendered button, and
   *      `prompt()` is always One Tap. There is no GIS call that gives Lumen's
   *      button active mode.
   *
   * SO WE SKIP GIS ENTIRELY HERE. FedCM is a BROWSER API; `mode: "active"` is the
   * mode built for "the site's own button was clicked", and `navigator.credentials
   * .get` takes it directly. Google is just the identity provider named in
   * `configURL` — the same provider, the same `nonce`, and the resolved
   * `IdentityCredential.token` is the same Google-signed ID token GIS's callback
   * would have handed us. It goes to the same `/api/lite/auth/google` endpoint and
   * through the same signature + audience + nonce checks. No client secret, no
   * weakening of the login contract, and Lumen draws its own button.
   *
   * ★ MUST STAY SYNCHRONOUS. Active mode requires a live user gesture; a single
   * `await` before this call spends it and the browser refuses. Everything async
   * happens in the `.then`, never before the call.
   *
   * ★ HOW TO CHECK THIS IN ONE LINE if it ever regresses: trap
   * `navigator.credentials.get` and read `identity.mode` on the click. `active` is
   * correct. `passive` means something routed back through One Tap and the button
   * is dead, whatever else looks right.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const startPrompt = useCallback(() => {
    const clientId = googleClientId();
    if (!fedcmAvailable() || !clientId) {
      // Not a failure the reader should read about: fall straight through to
      // GIS's real button, which works without FedCM.
      setPromptFailed(true);
      return;
    }
    let request: Promise<Credential | null>;
    try {
      request = (navigator.credentials as FedcmCredentialsContainer).get({
        identity: {
          mode: 'active',
          providers: [
            {
              configURL: GOOGLE_FEDCM_CONFIG_URL,
              clientId,
              // Binds the returned ID token to the server-issued single-use
              // challenge, exactly as `initialize({ nonce })` did.
              ...(nonce ? { nonce } : {})
            }
          ]
        }
      });
    } catch {
      // Synchronous throw = the browser rejected the shape of the call at all
      // (older FedCM without active mode). Fall back rather than explain.
      setPromptFailed(true);
      return;
    }
    /**
     * ★★★ THE FALLBACK IS A CAPABILITY DECISION, NOT A FAILURE HANDLER
     * (2026-08-28, third correction — the previous two both latched).
     *
     * THE BUG THIS FIXES, confirmed on the live site: ANY attempt that did not end
     * in a token flipped `promptFailed` and permanently replaced Lumen's pill with
     * Google's stock "Continue as <name>" button for the rest of the page's life.
     * Cancel the chooser, hit an error at Google and come back, close the window —
     * the design was burned until a reload. One underlying problem therefore looked
     * like two, because every failed attempt also visibly wrecked the button.
     *
     * THE RULE, and it is the whole of it: `setPromptFailed` answers ONE question —
     * "can this browser run FedCM for us AT ALL?" — and that question is settled
     * before the flow starts, by the capability check and the synchronous throw
     * above. It is NOT an outcome of the flow. A runtime failure means this ATTEMPT
     * did not finish, which is a message and a chance to click again, never a
     * reason to take away the button that was clicked.
     *
     * A cancelled dialog is not even that: it shows nothing and changes nothing.
     * The reader chose to close it, and telling them off for that would be noise.
     */
    void request
      .then((credential) => {
        const token = (credential as IdentityCredentialLike | null)?.token;
        if (token) {
          onIdTokenRef.current(token);
          return;
        }
        // Resolved with no token: an outcome of this attempt, not a dead mechanism.
        onErrorRef.current('Google sign-in didn’t finish. Please try again.');
      })
      .catch((error: unknown) => {
        // ★ A CANCELLED DIALOG IS SILENT. Closing the chooser rejects with
        // AbortError. Nothing shown, nothing changed, the pill stays put.
        if (error instanceof Error && error.name === 'AbortError') return;
        onErrorRef.current('Google sign-in didn’t finish. Please try again.');
      });
  }, [nonce]);

  /**
   * ═════════════════════════════════════════════════════════════════════════════
   * ★★★ LUMEN'S OWN BUTTON, WITH NO CLIENT SECRET (2026-08-29).
   *
   * Owner: "i want our own button. always our own button." This is the path
   * that delivers it. We do not ask Google's JavaScript library for anything —
   * we open Google's own OpenID Connect authorization endpoint ourselves and
   * ask for `response_type=id_token`. Google's discovery document advertises
   * that response type, the implicit flow has no client secret by definition,
   * and the JWT that comes back is signed by Google and verified against
   * Google's public keys by the SAME endpoint the rendered button already feeds
   * (`/api/lite/auth/google`): signature, `aud`, single-use challenge, and the
   * `nonce` echo. Identical security, our own pixels.
   *
   * ★ `prompt=select_account` IS DELIBERATE, and it fixes a real complaint.
   * Google's rendered button personalises itself to whatever account is signed
   * into the BROWSER — the owner logged into Lumen with one address, logged
   * out, and was still offered a different Google address back. Forcing the
   * chooser means the reader always states who they are instead of Google
   * guessing, which is the right behaviour for a shared sign-in surface.
   *
   * ★ A POPUP, NOT A TOP-LEVEL REDIRECT. Notion and Figma both do exactly this;
   * it keeps the reader's place on the page, and unlike a redirect it needs
   * nowhere to stash the credential while the browser navigates away.
   * ═════════════════════════════════════════════════════════════════════════════
   */
  const startIdTokenFlow = () => {
    const clientId = googleClientId();
    if (!clientId) {
      onErrorRef.current('Google sign-in isn’t configured. Please use another method.');
      return;
    }
    if (!nonce) {
      onErrorRef.current('Google sign-in is still loading. Try again in a moment.');
      return;
    }
    /**
     * ★ `state` GUARDS THE MESSAGE CHANNEL, the nonce guards the token. Two
     * different jobs: the server already refuses a token whose `nonce` claim
     * does not echo the challenge it issued, but nothing server-side can tell
     * this TAB that a `postMessage` came from the window it actually opened.
     * A fresh random `state`, echoed by Google and checked below, does that.
     */
    const state = crypto.randomUUID();
    const redirectUri = `${window.location.origin}${RETURN_PATH}`;
    const url = `${GOOGLE_AUTH_ENDPOINT}?${new URLSearchParams({
      client_id: clientId,
      response_type: 'id_token',
      scope: 'openid email profile',
      redirect_uri: redirectUri,
      nonce,
      state,
      prompt: 'select_account'
    }).toString()}`;

    const w = 480;
    const h = 640;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
    const popup = window.open(url, 'lumen-google-signin', `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      onErrorRef.current('Your browser blocked the Google window. Allow pop-ups for Lumen and try again.');
      return;
    }

    const onMessage = (event: MessageEvent) => {
      // ★ Three checks, all load-bearing: any page on the internet can
      // postMessage to this window, so origin, shape and `state` must all agree
      // before a single byte is treated as a credential.
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; idToken?: string; state?: string; error?: string } | null;
      if (!data || data.type !== RETURN_MESSAGE_TYPE || data.state !== state) return;
      window.removeEventListener('message', onMessage);
      if (data.error) {
        // `access_denied` is the reader closing Google's chooser — not a failure
        // to report, they simply changed their mind.
        if (data.error !== 'access_denied') {
          onErrorRef.current('Google sign-in didn’t finish. Please try again.');
        }
        return;
      }
      if (data.idToken) onIdTokenRef.current(data.idToken);
      else onErrorRef.current('Google sign-in didn’t finish. Please try again.');
    };
    window.addEventListener('message', onMessage);
  };

  if (idTokenFlow || codeFlow || (promptFlow && !promptFailed)) {
    return (
      <button
        type="button"
        data-testid="google-signin-row"
        onClick={idTokenFlow ? startIdTokenFlow : codeFlow ? startCodeFlow : startPrompt}
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
      /* ★★★ GOOGLE'S BUTTON, IN LUMEN'S CARD (2026-08-29, owner's decision).
         The owner chose this over their own pill once the tradeoff was measured:
         `renderButton` exposes no corner-radius, no font, no icon and no second
         text line, so Google's button can sit INSIDE a Lumen row but can never BE
         one. What the card supplies is everything outside the iframe — our
         surface, our radius, our vertical rhythm, and the subtitle every sibling
         row has.

         ★ NO BORDER ON THIS CARD, deliberately. Google's `outline` theme always
         paints its own #747775 stroke and it cannot be turned off, so a second
         stroke around it reads as "a pill inside a pill" — tried and reverted on
         2026-08-10. Background + padding do the framing instead.

         ★★ NO `overflow-hidden`, EVER, and no transform or opacity. Two sibling
         containers in lumen-login.tsx use `overflow-hidden` purely to round their
         corners; copying that here silently reintroduces the exact clipping that
         made this button dead to every click from 2026-08-10 to 08-28. A clipped
         ancestor is one of the three things GSI's anti-clickjacking refuses. */
      className="mb-1 w-full rounded-card bg-surface-1"
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
          working sign-in beats a consistent one. `renderButton` is what THIS
          branch renders (default mode, or the `promptFlow` fallback below);
          `codeFlow`/`promptFlow` mode never reaches this JSX at all — they
          return the Lumen-styled `<button>` above instead. */}
      {/* The iframe keeps its own natural box; only the CONTAINER is padded, so
          nothing about Google's button is scaled, clipped or covered. `min-h`
          (not `h`) lifts the 44px iframe to the 70px rhythm of the wallet rows
          while still letting the card grow if the message below wraps. */}
      <div className="flex min-h-[70px] w-full items-center justify-center px-2">
        <div ref={holder} className="flex justify-center" />
      </div>
      {/* The availability message stays BELOW the button rather than inside it:
          the row is Google's now, and injecting our own text into its box is what
          started the whole overlay problem. */}
      {/* ★ THE SUBTITLE LIVES HERE, NOT IN THE BUTTON. Google's control has ONE
          text line and no subtitle slot, and writing our own text into its box is
          precisely what started the overlay disaster. Underneath the iframe it is
          plainly ours, and the row still says what every other row says. It is
          replaced by the failure message rather than stacked with it, so the card
          never shows a reassurance and a warning at the same time. */}
      <p
        className={`px-4 pb-3 text-center font-sans text-caption ${
          unavailable ? 'text-ink-warn-3' : 'text-ink-10'
        }`}
      >
        {t(unavailable ? 'lite_auth.google_signin.unavailable' : 'lite_auth.google_signin.subtitle')}
      </p>
    </div>
  );
};

export default GoogleSignIn;
