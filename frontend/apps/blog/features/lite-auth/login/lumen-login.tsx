'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import env from '@beam-australia/react-env';
import { useRouter } from 'next/navigation';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useLiteLogin, type WalletChain } from './use-lite-login';
import WalletConnectDialog from './wallet-connect-dialog';
import TurnstileWidget, { turnstileSiteKey } from './turnstile-widget';
import GoogleSignIn, { googleConfigured } from './google-signin';
import KeychainSignin from './keychain-signin';
import { Link } from '@hive/ui';
import { isInternalPath } from '@ui/lib/sanitize-url';
import { SHOW_HELP_LINKS } from '@/blog/lib/help-visibility';

// TODO i18n — staged copy while the redesign lands (mirrors app-header's LABELS
// precedent); move to locales/*/common_blog.json once final.
// A Lumen account posts to Hive but DECLINES all rewards (decision 2026-07-23) —
// earning starts on your own Hive account, after upgrading. Promising payment on the
// signup screen would be a straight lie to the person reading it, so the copy sells
// the thing that is actually true: publishing to Hive with nothing to set up.
/**
 * ★★ COPY PASS (2026-08-10, fuckery list A1-A4).
 *
 * Four rules, all owner calls:
 *
 *  1. **No em-dashes or en-dashes.** They were the loudest AI tell on the screen,
 *     six of them on one card. Full stops do the same work and sound like a person.
 *  2. **Say what we are, do not swing at anyone.**
 *  3. **The heading and intro do not say Hive.** A stranger has not heard of it and
 *     the word makes a promise sound like plumbing. It stays in the rows that name
 *     a real thing the reader must recognise (Keychain, an existing account),
 *     because renaming those would be a lie rather than a style choice.
 *  4. **The intro answers "why should I trust this with my account", not "what
 *     features does it have".** `Welcome to Lumen` answered neither: it is the
 *     default heading of every template ever shipped, and the paragraph under it
 *     listed three things at once. One claim, and make it the one that matters at
 *     the moment somebody is deciding whether to hand over a key.
 *
 * `tagline` now lives ONLY here (A4). The home hero used to carry the same
 * sentence, so the product's one line appeared twice in two different roles.
 */
const COPY = {
  tagline: 'A calmer place to read and write.',
  /**
   * ★★★ THE FIRST LINE SELLS THE PLACE, NOT THE SAFETY (v8, owner).
   *
   * "Your keys stay with you." answered a question nobody has yet. Somebody who has
   * not decided what this is does not open a login screen worrying about custody;
   * they worry about whether it is worth an account. Security reassurance is real
   * and it stays, one line down, where a reader who HAS decided will look for it.
   *
   * It reuses the home hero's angle on purpose. A stranger who clicked "Start free"
   * should land on the same promise they clicked, not a different pitch.
   */
  // ★ 2026-08-16, owner: "Get found without a following" is gone from the
  // product, here as well as on the home masthead — the note above about
  // reusing the home hero's angle still holds, the angle just changed. The
  // tagline above is now the home heading too, so this line must NOT repeat it;
  // it says what you do here instead. The rule the old comment set still stands:
  // sell the place first, keep the custody reassurance one line down.
  welcome: 'Read first. Write when you are ready.',
  // ★ REMOVED 2026-08-28, owner: the "Nothing to chase, nothing to install. Lumen
  // never sees a private key." line is gone from every surface. `welcomeSub` no
  // longer exists; when Google IS ready the headline stands on its own with no
  // subtitle. `welcomeSubWalletsOnly` below is deliberately KEPT: it is different
  // copy doing a different job, explaining why the walletless door is missing when
  // Google is unavailable, and dropping it would put four key-requiring options
  // under a headline that promises none are needed.
  /**
   * ★★★ THE PROMISE HAS TO DEGRADE WITH THE THING THAT KEEPS IT (2026-08-08, UX
   * tester on the new-user path).
   *
   * `welcomeSub` above says "without keys, wallets or setup", and exactly ONE of
   * the four ways in delivers that: Google. The other three each require
   * something the reader must already own — a Bitcoin wallet, an Ethereum wallet
   * (which has no manual fallback at all), or the Hive Keychain extension. When
   * Google is unavailable the headline kept promising key-free signup above four
   * doors that all needed a key, which is the one failure mode a first-time
   * visitor cannot diagnose: they assume they are missing something.
   *
   * This is NOT "signup is broken" — with a real client id configured the
   * walletless path exists and the promise is true. The defect was that the
   * sentence was static. So it is now conditional on `googleReady`, the same flag
   * that decides whether the button underneath it works.
   */
  welcomeSubWalletsOnly:
    'Every way in below needs something you already own: a Bitcoin or Ethereum wallet, or the Keychain extension. The walletless option, Google, is not set up yet.',
  google: 'Continue with Google',
  orGoogle: 'or use an account you already have',
  orHive: 'or sign in with an existing Hive account',
  keychainTitle: 'Sign in with Hive Keychain',
  keychainSub: 'Your keys, your content.',
  btcTitle: 'Continue with a Bitcoin wallet',
  btcSub: 'Sign a message to prove ownership. No payment, no gas.',
  /**
   * ★ THE ICON PROMISED ONE WALLET AND THE COPY PROMISED THREE (A2). The row showed
   * a bare MetaMask fox under the words "MetaMask, Rainbow, any EVM wallet". The
   * path underneath genuinely is WalletConnect (`../wallet/appkit`), so the broad
   * claim was true and the ICON was the thing lying. Fixed on the icon side rather
   * than by narrowing the copy: naming one wallet would have shut the door on the
   * others for no reason. See the row markup for the generic mark.
   */
  evmTitle: 'Continue with an Ethereum wallet',
  evmSub: 'A signature, not a transaction.',
  namePick: 'Pick your Lumen name',
  namePickSub: 'This is how you’ll appear across Lumen. You can’t change it later, so choose well.',
  nameRules: 'Lowercase letters, numbers and dashes. 3 to 16 characters.',
  create: 'Create my Lumen account',
  /**
   * ★★★ THE SAME CLAUSE H8 CUT FROM THE UPGRADE SCREEN, STILL STANDING ON THE
   * SIGNUP SCREEN (2026-08-28, false-text audit F13).
   *
   * This ended "and your posting history comes with you". `upgrade-panel.tsx:72`
   * removed exactly that promise on 2026-08-16 because it contradicts
   * `COPY.historyLimit` — posts written before an upgrade stay signed by Lumen's
   * publishing account, and a Hive post cannot change author, so every other Hive
   * front end shows the back catalogue under Lumen forever. The edit was applied
   * where the promise was noticed and not where it actually lands: this is the
   * signup screen, the highest-leverage moment in the product to make a promise
   * about who owns your writing.
   *
   * Scoped rather than cut, because the Lumen half is true and worth saying.
   */
  createReassure:
    'Free. No keys to save. Your posts publish through Lumen with a small “via Lumen” mark and do not collect rewards. Upgrade to a full Hive account whenever you want. On Lumen your history follows your new name; on other Hive sites, posts written before the upgrade stay under Lumen’s account.',
  back: 'Back',
  checking: 'Checking…',
  googleSeam:
    'Google sign-in is being set up. For now, use a Bitcoin or Ethereum wallet, or a Hive account below.',
  captchaNeeded: 'Please complete the “I’m human” check first.'
};

type View = 'default' | 'name';

/**
 * ★★★ `?next=` WAS WRITTEN BUT NEVER READ (2026-08-10).
 *
 * `/profile` has redirected signed-out readers to `/login?next=/profile` since it
 * was built, and `/wallet` and `/wallet/tokens` now do the same. Nothing on this
 * page ever looked at the parameter: all three `router.replace('/')` calls below
 * sent everyone to the feed, so "sign in and we will take you back" was a promise
 * the product did not keep, and the reader had to remember for themselves what
 * they had been trying to open.
 *
 * ★ `isInternalPath` IS THE GATE, AND IT IS NOT OPTIONAL. Without it this is an
 * open redirect: anyone can hand a victim `/login?next=https://evil.example` and
 * the sign-in page would send them there the moment their session was minted.
 * Only a plain in-app path (leading `/`, not `//`, no `javascript:`) is accepted;
 * anything else falls back to the feed.
 *
 * ★ WHY IT READS `window.location` AND NOT `useSearchParams()`. That hook forces
 * the page that uses it to be client-rendered or wrapped in `<Suspense>`, and
 * this value is never rendered — it is only read at the moment a redirect
 * happens. A plain function keeps the login page's rendering unchanged.
 */
function loginDestination(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next') ?? '';
  return next && isInternalPath(next) ? next : '/';
}

/**
 * `embedded` renders the same four ways in — Google, Bitcoin wallet, Ethereum
 * wallet, Hive Keychain — without the standalone-page chrome, so the sign-in
 * DIALOG can offer the identical set.
 *
 * ★ WHY (2026-08-07): the dialog opens from ~24 places (upvote, reply, composer,
 * profile) and showed ONLY Hive Keychain, with a text link to /login for
 * everything else. So the app's widest sign-in surface hid three of its four
 * methods — including the two that need no keys, which are the whole point of a
 * Lumen account. Reusing this component means the dialog can never drift from
 * the page again.
 */
interface LumenLoginProps {
  embedded?: boolean;
  /**
   * The SAME `googleReady` boolean `app/login/page.tsx` already computes server-side
   * for its `<meta>` description, handed down so the FIRST render (the one hydration
   * diffs against) already shows the true state instead of a hardcoded `false`. See
   * the flicker-fix comment on that file for why this replaced the old
   * effect-only correction. Omitted by callers that mount this outside that server
   * component (the sign-in dialog, `dialog-login.tsx`) — those fall back to the
   * client-only correction below, exactly as before.
   */
  googleConfiguredInitially?: boolean;
}

const LumenLogin: FC<LumenLoginProps> = ({ embedded = false, googleConfiguredInitially = false }) => {

  const router = useRouter();

  // ★ AN ALREADY-SIGNED-IN VISITOR MUST NOT LAND ON A SIGN-IN FORM (2026-08-07).
  //
  // The header renders a real, clickable "Log in" link before hydration — on
  // purpose, so crawlers and slow connections can see the front door (see
  // app-header.tsx). For a SIGNED-IN reader that window was assumed to be one
  // frame; measured on a cold cache over a slow connection it lasts 8-48s, and
  // clicking it brought them here, to a full sign-in form that did not recognise
  // their perfectly valid session. That is what "refreshing logs me out" looked
  // like from the outside — the session was never lost, the reader was just
  // stranded on the wrong page.
  //
  // Fixing it here rather than in the header keeps the SEO-visible link intact.
  const { user: sessionUser, isHydrated: sessionHydrated } = useUserClient();
  useEffect(() => {
    if (embedded) return; // inside the dialog, signing in is the point
    if (sessionHydrated && sessionUser?.isLoggedIn) {
      router.replace(loginDestination());
    }
  }, [embedded, sessionHydrated, sessionUser?.isLoggedIn, router]);
  const { user } = useUserClient();
  const { nameStatus, checkName, createAccount, google, googleChallenge } = useLiteLogin();

  const [view, setView] = useState<View>('default');
  // Which wallet dialog is open (null = none). One dialog serves both chains.
  const [walletOpen, setWalletOpen] = useState<WalletChain | null>(null);
  const [name, setName] = useState('');
  // ★ M1 FIX (2026-08-16): must stay neutral until the field is dirty or
  // blurred. Before this, `nameBorder`'s default branch carried
  // `focus-within:border-line-brand-10`, which fires on FOCUS ALONE — and
  // this input has `autoFocus`, so the wrapper went brand-red the instant the
  // "name" view rendered, before the reader had typed a single character.
  // `nameTouched` gates that: false until the reader types (dirty) or leaves
  // the field (blurred), matching every other validation state below it,
  // which already cannot fire on an empty value (`checkName` short-circuits
  // to `idle` for a blank string).
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // '' until the widget hands one over. Required only when a site key is configured,
  // which is exactly when the server has a secret to verify it against.
  const [captchaToken, setCaptchaToken] = useState('');
  const captchaRequired = turnstileSiteKey().length > 0;
  const [error, setError] = useState<string | null>(null);

  // F-L11: Google's ID token must echo a single-use server nonce (GIS captures it at
  // button init), so fetch one up front and re-arm after each attempt. null = not yet
  // ready / fetch failed → the real button is withheld rather than minting a token the
  // server will reject as a replay.
  const [googleNonce, setGoogleNonce] = useState<string | null>(null);
  // ★★★ RESOLVED ON THE CLIENT, NOT DURING SSR (2026-08-06).
  //
  // `googleConfigured()` reads the client id through `@beam-australia/react-env`,
  // whose `env()` resolves from `window.__ENV` in the BROWSER but from
  // `process.env` on the SERVER. Those two disagreed here: the browser had
  // `REACT_APP_LITE_GOOGLE_CLIENT_ID` (verified in `window.__ENV`) while the
  // server render did not, so SSR emitted the disabled "Google sign-in is being
  // set up" fallback — and because nothing re-rendered after hydration, that
  // fallback STUCK. Google sign-in was permanently dead on a correctly
  // configured deploy, and it also produced a React hydration mismatch.
  //
  // Evaluating it in an effect makes the browser the authority: the server
  // renders the safe "not available" state, and the client corrects it on mount.
  //
  // ★★★ SEEDED FROM THE BEST ANSWER AVAILABLE AT FIRST PAINT, NOT HARDCODED
  // FALSE (2026-08-28, flicker root-cause fix). Each call site supplies it the
  // only way that is safe for ITS rendering context, which is why the prop is
  // named for what it means rather than for where it came from:
  //   • `app/login/page.tsx` (server-rendered) passes the value it ALREADY
  //     computes for its `<meta>` description — proof the server could see the
  //     client id all along.
  //   • `components/dialog-login.tsx` (client-only; Radix mounts DialogContent
  //     on open, so nothing here is ever server-rendered) passes
  //     `googleConfigured()` directly.
  // The login page's computation is the same one `app/login/page.tsx` runs for
  // its `<meta>` description —
  // proof the server COULD see the client id all along. Starting from THAT value
  // instead of a literal `false` means a correctly-configured deploy shows the
  // real state from the very first paint: no "being set up" flash, and still no
  // hydration risk, because this is a plain serialized prop, not a render-time
  // `env()` call that could disagree between server and client. The effect below
  // still runs and still re-derives `googleReady` from `googleConfigured()` on the
  // client — now as a confirmation/safety net rather than the sole source of truth.
  const [googleReady, setGoogleReady] = useState(googleConfiguredInitially);
  const refreshGoogleNonce = useCallback(() => {
    void googleChallenge().then((n) => setGoogleNonce(n));
  }, [googleChallenge]);
  /**
   * ★ ONE NONCE PER MOUNT, NOT TWO (2026-08-16, QA report B3).
   *
   * Every login page load logged:
   *   [GSI_LOGGER]: google.accounts.id.initialize() is called multiple times.
   *
   * The cause was here, not in GoogleSignIn's own guard. `reactStrictMode` is on
   * (next.config.js), so this effect runs, unmounts and runs again on mount. With
   * no cancellation, BOTH runs completed and each set a different single-use
   * nonce, so `<GoogleSignIn key={googleNonce}>` remounted with a new key and
   * legitimately called `initialize()` a second time. Two correct calls caused by
   * one uncancelled fetch, which is why hardening the callee could never fix it.
   *
   * The first nonce is also wasted: it is single-use and nothing ever redeems it.
   */
  useEffect(() => {
    // ★ THE CORRECTIVE ELSE MATTERS NOW THAT `googleReady` CAN START TRUE
    // (2026-08-28). Seeding from `googleConfiguredInitially` (above) is only safe
    // if a disagreement can still self-heal: if the server's env and the
    // client's `window.__ENV` ever genuinely differ, this pulls `googleReady`
    // back down instead of leaving the page stuck showing a button that the
    // client side believes isn't configured.
    if (!googleConfigured()) {
      setGoogleReady(false);
      return;
    }
    let cancelled = false;
    setGoogleReady(true);
    void googleChallenge().then((n) => {
      if (!cancelled) setGoogleNonce(n);
    });
    return () => {
      cancelled = true;
    };
  }, [googleChallenge]);

  // Already signed in → leave the pre-auth page.
  useEffect(() => {
    if (user?.isLoggedIn) router.replace(loginDestination());
  }, [user?.isLoggedIn, router]);

  // Named for what it did before `?next=` was honoured: the destination is the
  // feed unless the reader was sent here from a page that needs an account.
  const goHome = () => {
    router.replace(loginDestination());
    router.refresh();
  };

  /** Google returned an ID token — hand it to the (already built) backend. */
  /** ★ 2026-08-28: same handler for both doors — `kind` selects idToken vs code. */
  const handleGoogleCredential = async (credential: string, kind: 'idToken' | 'code') => {
    if (!googleNonce) {
      setError('Google sign-in is not ready yet. Please try again in a moment.');
      return;
    }
    setError(null);
    setBusy(true);
    const outcome = await google(credential, googleNonce, kind);
    setBusy(false);
    refreshGoogleNonce();
    if (outcome.status === 'authenticated') goHome();
    else if (outcome.status === 'needs_name') setView('name');
    else setError(outcome.message);
  };

  const handleGoogleToken = async (idToken: string) => {
    if (!googleNonce) {
      setError('Google sign-in is not ready yet. Please try again in a moment.');
      return;
    }
    setError(null);
    setBusy(true);
    const outcome = await google(idToken, googleNonce);
    setBusy(false);
    // The nonce is single-use; arm a fresh one for the next attempt.
    refreshGoogleNonce();
    if (outcome.status === 'authenticated') goHome();
    else if (outcome.status === 'needs_name') setView('name');
    else setError(outcome.message);
  };

  const submitName = async () => {
    if (nameStatus.state !== 'available') return;
    // The token MUST be sent. The server verifies it and, in production, refuses to
    // open signup at all unless Turnstile is configured — so a client that never
    // sends one turns every signup into `captcha_failed`.
    if (captchaRequired && !captchaToken) {
      setError(COPY.captchaNeeded);
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await createAccount(name.trim().toLowerCase(), captchaToken || undefined);
    setBusy(false);
    if (outcome.status === 'ok') goHome();
    else setError(outcome.message);
  };

  const nameBorder = !nameTouched
    ? 'border-line-11'
    : nameStatus.state === 'available'
      ? 'border-line-ok-5'
      : nameStatus.state === 'unavailable'
        ? 'border-line-warn-8'
        : 'border-line-11 focus-within:border-line-brand-10';

  return (
    // Full-screen layer: /login is standalone (no three-column shell), but the
    // root layout renders <AppHeader/> on every route. Covering it here keeps the
    // change isolated to this feature; the clean long-term fix is a route-group
    // split (move AppHeader into a "(shell)" group, login outside it).
    <div
      className={
        embedded
          ? 'flex w-full flex-col items-center bg-surface-1 font-sans text-ink-2'
          : 'fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-surface-1 px-5 pb-12 font-sans text-ink-2 [scrollbar-gutter:stable_both-edges]'
      }
    >
      {/* ★ `line-brand-10`, not `#c0392b` (2026-08-14): a Tailwind arbitrary value
          accepts `rgb(var(--x))` the same as any other CSS, so this progress-bar
          rule keeps the same red in light mode and gains the dark-mode lift the
          literal never had. */}
      {embedded ? null : <div className="fixed inset-x-0 top-0 h-[3px] bg-[linear-gradient(90deg,rgb(var(--line-brand-10)),#e07b3e)]" />}

      {/* Wordmark: Lora, matching the app shell.

          ★ THIS COMMENT USED TO ARGUE THE OPPOSITE, AND ITS PREMISE INVERTED
          (2026-08-19). It read: "Open Sans to match the app shell's committed
          identity (app-header design-handoff-v2: no serif display face) — the
          login mockup's Lora wordmark was the stray outlier." The shell it cited
          as the Open Sans reference became Lora itself on 2026-08-11 (owner:
          "our logo is not fucking Lora, you need to set it Lora"), and the whole
          product followed on 2026-08-19. The mockup was right and this note was
          wrong. The `font-sans` below happens to render correctly today only
          because that utility is now aliased to Lora — right result, backwards
          reasoning, which is exactly the kind of comment that survives a
          migration and misleads the next reader. */}
      {embedded ? null : (
        <div className="mb-8 mt-16 text-center">
          <Link href="/" className="font-sans text-[44px] leading-[52px] font-bold leading-none tracking-[-0.025em] text-ink-2">
            Lumen
          </Link>
          <p className="mt-2 font-serif text-base text-ink-10">{COPY.tagline}</p>
        </div>
      )}

      <div className={embedded ? 'flex w-full max-w-full flex-col gap-[18px]' : 'flex w-[460px] max-w-full flex-col gap-[18px]'}>
        {view === 'default' ? (
          <>
            {/* ★ NO DOUBLE FRAME IN THE DIALOG (2026-08-08). Embedded, this card
                sat inside the popup's own frame and padding — two borders, two
                paddings — which squeezed each method row until its label wrapped
                outside the button. In the dialog the popup IS the card. */}
            <div
              className={
                embedded
                  ? 'overflow-hidden bg-surface-1'
                  /* ★ THE TIGHT LAYER GOES WARM; THE BRAND GLOW STAYS (illumination §3).
                     This card's outer `rgba(192,57,43,0.07)` bloom is a deliberate hero
                     treatment and is not what §3 is replacing — but its second, tight layer was
                     still the app's old grey `rgba(20,18,10,0.04)`. Found only after fixing the
                     coverage probe: `/login` REDIRECTS to `/` for a signed-in session, so the
                     signed-in run had been measuring the feed and reporting it as login. */
                  : 'overflow-hidden rounded-panel border border-line-9 bg-surface-1 shadow-[0_12px_40px_rgba(192,57,43,0.07),0_1px_2px_rgba(26,22,18,0.035)]'
              }
            >
              <div
                className={
                  embedded
                    ? 'border-b border-line-5 px-0 pb-4 pt-0'
                    : 'border-b border-line-5 bg-[radial-gradient(120%_100%_at_0%_0%,rgb(var(--login-wash-1))_0%,rgb(var(--login-wash-2))_62%)] px-[30px] pb-6 pt-8'
                }
              >
                <h1 className={`font-serif font-semibold tracking-[-0.01em] text-ink-2 ${embedded ? 'text-[22px] leading-[26px]' : 'text-center text-[30px] leading-[46px] leading-[34px]'}`}>
                  {COPY.welcome}
                </h1>
                {/* Google is the only walletless way in, so it is what makes the
                    "without keys, wallets or setup" sentence true. Resolved on
                    the client for the same reason the button is (see
                    `googleReady`): the server render cannot see the client id, so
                    it shows the conservative sentence and the browser corrects
                    it. Erring that way round is deliberate — over-promising is
                    the failure this fixes. */}
                {!googleReady && (
                  <p className={`mt-2 text-[15px] leading-[24px] text-ink-8 ${embedded ? '' : 'text-center'}`}>
                    {COPY.welcomeSubWalletsOnly}
                  </p>
                )}
              </div>

              <div className={embedded ? 'py-5' : 'p-6'}>
                {/* Primary: Google identity (Lumen Lite, no keys). The real Google
                    button renders when a client id is configured; otherwise the styled
                    fallback below explains the state instead of failing on click. */}
                {googleReady ? (
                  googleNonce ? (
                    // key + nonce: GIS captures the nonce at init, so a fresh nonce
                    // remounts the button (F-L11).
                    //
                    /* ★ THE SLOT IS 64px, THE BUTTON ISN'T (2026-08-28, measured live on
                       lumensocial.net/login). GSI's own `size: 'large'` iframe measures
                       40px tall (`[data-testid="google-signin-row"]` rect height 40,
                       iframe 44); the Bitcoin/Ethereum rows next to it run 70-90px (34px
                       icon or a wrapped two-line subtitle, inside `px-4 py-3`). Google
                       owns that iframe's height, border and corner radius; none of the
                       three are ours to set, and google-signin.tsx documents why growing
                       or framing the iframe itself is off the table (its own ancestors
                       must never carry opacity, a transform, overflow-hidden or
                       pointer-events-none, or GSI silently drops the click — proven, not
                       theoretical, see that file's header). A border around it was tried
                       and reverted for a different reason (google-signin.tsx:403-441,
                       "one row, not a pill inside a pill"): Google already draws its own
                       border, so a second one around it reads as a layout bug, not a fix.
                       So this wrapper reserves HEIGHT, not paint. `min-h-[64px]` matches
                       the two disabled placeholders below (loading, not-configured), so
                       nothing on the page jumps when the nonce lands and the real button
                       swaps in; `items-center` centres the shorter iframe in that slot
                       rather than stretching it, so GSI is never asked to be a size it
                       didn't choose. It narrows the 40-vs-90px gap without touching the
                       iframe or anything that wraps it in a forbidden way. */
                    <div className="flex min-h-[64px] w-full items-center justify-center">
                      <GoogleSignIn
                        key={googleNonce}
                        nonce={googleNonce}
                        onIdToken={handleGoogleToken}
                        /* ★ Lumen's own button, behind a flag until the server has a
                           client secret to exchange the code with. Off = GIS's own
                           rendered button, which works today. */
                        /* ★★★ LUMEN'S OWN BUTTON, AND THE ONLY FLOW THAT DELIVERS IT
                           WITHOUT A CLIENT SECRET (2026-08-29). Straight to Google's
                           OIDC authorize endpoint for `response_type=id_token`; the
                           JWT it returns is verified exactly like the rendered
                           button's. Needs `<origin>/auth/google/return` registered as
                           an Authorized redirect URI, so it stays behind a flag until
                           that is done — a wrong redirect URI is a hard
                           `redirect_uri_mismatch`, not a graceful degrade. */
                        idTokenFlow={env('LITE_GOOGLE_ID_TOKEN_FLOW') === 'yes'}
                        codeFlow={env('LITE_GOOGLE_CODE_FLOW') === 'yes'}
                        onCode={(c) => handleGoogleCredential(c, 'code')}
                        /* ★ THE NO-SECRET PATH TO LUMEN'S OWN BUTTON (2026-08-28).
                           `codeFlow` needs `LITE_GOOGLE_CLIENT_SECRET`, which nobody has
                           pasted into prod yet, so it stays off there. `promptFlow` gets
                           the same Lumen-styled row from One Tap / FedCM instead (see
                           `google-signin.tsx` `startPrompt`) — no secret required, because
                           it never leaves the browser's own Google session for a code to
                           exchange. Same flag shape as `codeFlow`, same off-by-default
                           safety: unset envs mean both are false and nothing changes for
                           today's deploy. `codeFlow` wins if a future deploy somehow sets
                           both, since it is the more complete OAuth flow once a secret
                           exists. */
                        promptFlow={env('LITE_GOOGLE_CODE_FLOW') !== 'yes' && env('LITE_GOOGLE_PROMPT_FLOW') === 'yes'}
                        onError={setError}
                      />
                    </div>
                  ) : (
                    // ★ THE ICON STAYS (2026-08-28, flicker fix, second half). This
                    // placeholder used to drop the Google mark entirely while waiting
                    // on the nonce round trip, so a reader who got here via the
                    // now-seeded-true `googleReady` (see the state declaration above)
                    // watched the row go from "a Google button" to "a blank grey bar
                    // with no icon and no explanation" for the ~100-800ms that fetch
                    // takes — measured live on lumensocial.net across repeated loads.
                    // Keeping the same mark in both disabled states means the row
                    // never looks like it broke; it just looks like it's loading.
                    <button
                      type="button"
                      disabled
                      className="flex h-[64px] w-full items-center justify-center gap-[11px] rounded-card border border-line-11 bg-surface-1 text-[16px] font-semibold text-ink-2 opacity-60"
                    >
                      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
                        <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
                        <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
                        <path fill="#FBBC05" d="M11.8 27.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 16.1 2.1 19.9 2.1 23s.9 6.9 2.4 9.9l7.3-5.7z" />
                        <path fill="#EA4335" d="M24 9.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 3.3 29.9 1 24 1 15.4 1 8.1 5.9 4.5 13.1l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z" />
                      </svg>
                      {COPY.google}
                    </button>
                  )
                ) : (
                  // Not configured client-side (REACT_APP_LITE_GOOGLE_CLIENT_ID unset — see
                  // google-signin.tsx googleConfigured()). Rendering this as a normal-looking,
                  // clickable button was the F-14b bug: it looked identical to a working button
                  // but did nothing visible on click. Disabled + an always-visible reason instead.
                  <div>
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="flex h-[64px] w-full cursor-not-allowed items-center justify-center gap-[11px] rounded-card border border-line-11 bg-surface-1 text-[16px] font-semibold text-ink-2 opacity-60"
                    >
                      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
                        <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
                        <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
                        <path fill="#FBBC05" d="M11.8 27.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 16.1 2.1 19.9 2.1 23s.9 6.9 2.4 9.9l7.3-5.7z" />
                        <path fill="#EA4335" d="M24 9.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 3.3 29.9 1 24 1 15.4 1 8.1 5.9 4.5 13.1l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z" />
                      </svg>
                      {COPY.google}
                    </button>
                    <p className={`mt-2 ${embedded ? '' : 'text-center'} text-caption text-ink-10`}>{COPY.googleSeam}</p>
                  </div>
                )}

                {/* ★ GOOGLE IS NOT A CRYPTO WALLET AND THE PAGE SAID IT WAS (C7).
                    There was one divider on this card, "or connect with Hive
                    Keychain", sitting above the Keychain row. Everything above that
                    line therefore read as one group, so Google was filed silently
                    beside Bitcoin and Ethereum. For the reader this method exists
                    FOR, that grouping is the whole message: it says "this is the
                    crypto section" to somebody who came here precisely because they
                    do not have a wallet. Its own divider separates them. */}
                <div className="mx-0.5 my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-surface-26" />
                  <span className="text-caption font-semibold text-ink-14">{COPY.orGoogle}</span>
                  <div className="h-px flex-1 bg-surface-26" />
                </div>
                <div className="flex flex-col gap-2.5">

                  {/* Bitcoin wallet — Lumen Lite, no keys. */}
                  {/* ★ HEIGHT IS AUTO, NOT FIXED (C4). These were `h-14` with a
                      two-line subtitle inside, so the copy crowded and in places
                      overflowed its own border, and the rows ended up visually
                      unequal. Padding sets the height now, so a row grows with its
                      content instead of clipping it. The A1 rewrites shorten the
                      copy enough that they land on one line anyway, but a row that
                      only fits when the copy is short is a row waiting to break. */}
                  <button
                    onClick={() => setWalletOpen('btc')}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-card border border-line-11 bg-surface-1 px-4 py-3 text-left hover:border-line-warn-5 hover:bg-surface-warn-1"
                  >
                    {/* ★ THE REAL BITCOIN MARK (2026-08-09, owner-supplied).
                        History worth keeping: this was the character "₿", which
                        the app's font stack does not carry, so it rendered as an
                        empty orange square; then a hand-drawn SVG. Both were
                        stand-ins for the actual logo, which is what ships now.
                        The asset is the official disc with its white plate made
                        transparent and the stock caption cropped off, so it
                        needs no coloured background behind it. */}
                    {/* ★ ONE MARK BOX FOR EVERY ROW (C5). The three marks were a
                        bare orange disc, a bare fox and a black rounded square, at
                        three different visual weights. The artwork stays as each
                        brand ships it; what is shared is the 34px box and the 10px
                        radius, so the column of icons lines up. */}
                    <img
                      src="/logos/bitcoin.png"
                      alt=""
                      aria-hidden
                      width={34}
                      height={34}
                      className="h-[34px] w-[34px] flex-shrink-0 rounded-control"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] leading-[24px] font-semibold text-ink-2">{COPY.btcTitle}</span>
                      <span className="block text-caption text-ink-10">{COPY.btcSub}</span>
                    </span>
                  </button>

                  {/* EVM wallet — Lumen Lite, no keys. Same proof shape as BTC. */}
                  <button
                    onClick={() => setWalletOpen('evm')}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-card border border-line-11 bg-surface-1 px-4 py-3 text-left hover:border-line-info-3 hover:bg-surface-9"
                  >
                    {/* ★ A GENERIC WALLET MARK, NOT THE METAMASK FOX (2026-08-10, A2).
                        The row opens WalletConnect and genuinely accepts Rainbow,
                        Coinbase Wallet and the rest, but the fox told the reader
                        otherwise: show one brand and you have promised one brand.
                        Anyone without MetaMask reads that icon as "not for me" and
                        stops. A neutral mark keeps the door as wide as the code
                        actually opens it, and the subtitle names the popular ones. */}
                    {/* ★ THE ETHEREUM MARK, not MetaMask and not a generic wallet
                        (owner call, 2026-08-10). v1 flagged the MetaMask fox as a lie
                        because the path underneath is WalletConnect and accepts
                        Rainbow, Coinbase Wallet and the rest; v8 then flagged the
                        generic wallet glyph as too vague to recognise. Both were
                        right about the other one. The network's own mark names what
                        the row actually is: an Ethereum wallet, any of them. */}
                    <span
                      aria-hidden
                      className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-control bg-surface-info-3"
                    >
                      <svg width="20" height="20" viewBox="0 0 256 417" aria-hidden>
                        <path fill="#343434" d="M127.96 0l-2.8 9.5v275.7l2.8 2.8 127.96-75.6z" />
                        <path fill="#8C8C8C" d="M127.96 0L0 212.4l127.96 75.6V154.2z" />
                        <path fill="#3C3C3B" d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z" />
                        <path fill="#8C8C8C" d="M127.96 416.9v-104.7L0 236.6z" />
                        <path fill="#141414" d="M127.96 287.96l127.96-75.6-127.96-58.16z" />
                        <path fill="#393939" d="M0 212.36l127.96 75.6V154.2z" />
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] leading-[24px] font-semibold text-ink-2">{COPY.evmTitle}</span>
                      <span className="block text-caption text-ink-10">{COPY.evmSub}</span>
                    </span>
                  </button>
                </div>

                {/* ── The Hive path, deliberately SEPARATE ──────────────────
                    Google / Bitcoin / Ethereum above are all LUMEN LITE: no
                    keys, no wallet required to hold an account, created by us.
                    Keychain below signs into a FULL HIVE ACCOUNT the person
                    already owns. They are different kinds of thing, so they do
                    not belong in one undifferentiated list — the three lite
                    options carry equal weight, and this is its own step. */}
                <div className="mx-0.5 my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-surface-26" />
                  <span className="text-caption font-semibold text-ink-14">{COPY.orHive}</span>
                  <div className="h-px flex-1 bg-surface-26" />
                </div>

                <KeychainSignin />

                {error ? <p className={`mt-4 ${embedded ? '' : 'text-center'} text-caption text-ink-warn-3`}>{error}</p> : null}

                <p className={`mt-[18px] ${embedded ? '' : 'text-center'} text-caption text-ink-14`}>
                  By continuing you agree to Lumen’s <Link href="/tos.html">Terms</Link> and{' '}
                  <Link href="/privacy.html">Privacy Policy</Link>.
                </p>
              </div>
            </div>

            {/* Tier-2: full Hive account, secondary. */}
          </>
        ) : (
          <div className="rounded-panel border border-line-9 bg-surface-1 p-6 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]">
            <button
              onClick={() => {
                setView('default');
                setError(null);
              }}
              className="mb-4 flex items-center gap-1.5 border-0 bg-transparent p-0 text-caption font-semibold text-ink-10"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              {COPY.back}
            </button>
            <h1 className="font-serif text-2xl font-semibold text-ink-2">{COPY.namePick}</h1>
            <p className="mt-1.5 text-sm text-ink-10">{COPY.namePickSub}</p>

            <div className={`mb-2 mt-[18px] flex h-12 items-center gap-2 rounded-xl border-2 px-3.5 ${nameBorder}`}>
              <span className="font-bold text-ink-14">@</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  checkName(e.target.value);
                  setNameTouched(true);
                }}
                onBlur={() => setNameTouched(true)}
                autoFocus
                spellCheck={false}
                // M5 QA fix (2026-08-16): `nameRules` below has always said "3 to 16
                // characters", but nothing stopped the field itself accepting more —
                // the browser now enforces the upper bound (typed AND pasted) instead
                // of only the copy claiming it.
                maxLength={16}
                // ★ NOT `focus-visible:outline-none` (2026-08-27). Every other input
                // suppressed today sits in a wrapper whose focus affordance is
                // UNCONDITIONAL. This one's is not: `nameBorder`'s `!nameTouched`
                // branch is bare `border-line-11`, because the dated M1 ruling
                // (2026-08-16) forbids brand-red before the reader has typed — it read
                // as a validation error on an autoFocused field. No `line-*` token
                // reaches the 3:1 WCAG 1.4.11 bar (darkest is line-19 at 1.48:1), so
                // suppressing the global ring here left the FIRST field of signup with
                // no focus indicator at all. The global ring stays.
                className="min-w-0 flex-1 border-0 font-sans text-base font-semibold text-ink-2 outline-none"
              />
              {nameStatus.state === 'checking' ? (
                <span className="text-caption font-semibold text-ink-14">{COPY.checking}</span>
              ) : nameStatus.state === 'available' ? (
                <span className="flex items-center gap-1.5 text-caption font-semibold text-ink-ok-2">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2f7d4f" strokeWidth="2.8">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  @{name.trim().toLowerCase()} is available
                </span>
              ) : null}
            </div>
            {nameStatus.state === 'unavailable' ? (
              <p className="mb-2 text-caption font-medium text-ink-warn-3">{nameStatus.reason}</p>
            ) : null}
            <p className="mb-[18px] text-caption text-ink-14">{COPY.nameRules}</p>

            {/* Real Turnstile widget. Renders nothing when no site key is set — which
                is also when the server passes the check through, so the two ends can
                never be half-configured. */}
            <TurnstileWidget onToken={setCaptchaToken} />

            <button
              onClick={submitName}
              disabled={busy || nameStatus.state !== 'available' || (captchaRequired && !captchaToken)}
              className="h-12 w-full cursor-pointer rounded-xl bg-surface-brand-12 text-[15px] leading-[24px] font-semibold text-ink-27 hover:bg-surface-brand-16 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? COPY.checking : COPY.create}
            </button>
            {error ? <p className="mt-3 text-left text-caption text-ink-warn-3">{error}</p> : null}
            <p className="mt-3 text-left text-caption text-ink-10">{COPY.createReassure}</p>
          </div>
        )}
      </div>

      {/* ★ THE SAME TWO LINKS WERE OFFERED TWICE, 20px APART (C8). The card ends
          with "By continuing you agree to Lumen's Terms and Privacy Policy", and
          this row repeated Terms and Privacy directly beneath it. The sentence is
          the one that has to stay: it is attached to the action it describes, which
          is the whole point of saying it. So this row keeps only Help, which is the
          one thing the card does not offer. */}
      {/* v8: this footer belongs to the standalone PAGE. Rendered inside the dialog it
          became a single orphaned "Help" link under the card, with no context and no
          sibling. The page keeps it; the dialog does not. */}
      {/* ★ HIDDEN 2026-08-27 (owner): *"theres help on login hide it."* The whole
          ROW is skipped, not just the link inside it: after C8 above stripped Terms
          and Privacy from this row, Help is its ONLY child, so keeping the row would
          leave an empty 72px `my-9` gap under the card. Not rendered rather than
          `display:none`d, following `SHOW_CARD_OVERFLOW_MENU` in
          `features/discovery-feed/medium-post-card.tsx` — a hidden-but-present link
          is one more thing focus handling and the QA probes have to keep reasoning
          about, and not rendering it removes the question. Comes back exactly as it
          was by flipping `SHOW_HELP_LINKS`. */}
      {SHOW_HELP_LINKS ? (
        <div className={`my-9 flex gap-5 text-caption text-ink-14 ${embedded ? 'hidden' : ''}`}>
          {/* ★ HELP FOR THE PERSON ACTUALLY ON THIS SCREEN (2026-08-08, UX tester).
              This pointed at /faq.html — the inherited "Hive.blog FAQ", which opens
              on master passwords, owner keys, Resource Credits and MVESTs and refers
              the reader to a third-party account-creation service. Handing that to
              someone who was just promised "without keys, wallets or setup" is worse
              than offering no help at all. /help.html is Lumen's own, and links on to
              the Hive FAQ at the bottom for anyone who wants it. */}
          <Link href="/help.html" className="text-ink-14">Help</Link>
        </div>
      ) : null}

      {walletOpen ? (
        <WalletConnectDialog
          chain={walletOpen}
          onClose={() => setWalletOpen(null)}
          onAuthenticated={() => {
            setWalletOpen(null);
            goHome();
          }}
          onNeedsName={() => {
            setWalletOpen(null);
            setView('name');
          }}
        />
      ) : null}
    </div>
  );
};

export default LumenLogin;
