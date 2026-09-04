'use client';

import { Link } from '@hive/ui';

import { forwardRef, ReactNode, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Dialog, DialogContent, DialogTrigger, DialogTitle, DialogDescription } from '@ui/components/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { googleConfigured } from '@/blog/features/lite-auth/login/google-signin';
import { siteConfig } from '@ui/config/site';
import { useTranslation } from '@/blog/i18n/client';

// ★ LumenLogin is loaded LAZILY (2026-09-04, perf). It pulls the whole sign-in
// stack (useProcessAuth -> signin-form -> every signer -> @hiveio/wax, ~220 KB),
// and this dialog is statically imported by the app-wide header (it wraps ~24
// trigger buttons), so a static import dragged wax into every page's first load.
// Radix mounts DialogContent only when the dialog OPENS (see the note by the
// render below), so LumenLogin -- and wax -- now load only on a real login click,
// never for a reader who never opens it. ssr:false is safe: it never server-renders.
const LumenLogin = dynamic(() => import('@/blog/features/lite-auth/login/lumen-login'), {
  ssr: false,
  // ★ Reserve the form's rough height and show a spinner so the dialog does not
  // flash an empty box and then jump on first open while this chunk loads (F6,
  // 2026-09-04). The username field inside LumenLogin carries `autoFocus`, which
  // React fires when the field finally mounts, so keyboard focus still lands on
  // it. Spinner-only, no copy, so this stays i18n-clean.
  loading: () => (
    <div className="flex min-h-[280px] items-center justify-center" role="status">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
    </div>
  )
});

const GOOGLE_GSI_SCRIPT_ID = 'google-gsi-script';
const GOOGLE_GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

interface DialogLoginProps {
  children: ReactNode;
  redirectTo?: string;
}

/**
 * ★★★ THE COMPONENT ITSELF WAS BEING GIVEN A REF (2026-08-10, P0-4).
 *
 * React warned "Function components cannot be given refs. Check the render method of
 * `SlotClone`", pointing here. The audit read that as "wrap the CHILD in forwardRef",
 * and the children were a red herring: they are plain `<button>` elements and a
 * `FlagTooltip` that already forwarded.
 *
 * The stack says otherwise. `at DialogLogin` means DIALOGLOGIN is the component the
 * ref was aimed at, because it gets used inside somebody else's `asChild` slot. Radix
 * clones the child and hands it a ref, this was a plain function, and the ref went
 * nowhere. Every symptom followed from that: the trigger it should have measured was
 * never registered, which is why icons inside the modal raced and failed on a second
 * open.
 *
 * Forwarding to `DialogTrigger` puts the ref back on the real DOM node, whether this
 * is used standalone or nested in another slot.
 */
const DialogLogin = forwardRef<HTMLButtonElement, DialogLoginProps>(function DialogLogin(
  { children, redirectTo },
  ref
) {
  const { t } = useTranslation('common_blog');


  // Load Google Sign-In script on demand when dialog opens
  const loadGoogleScript = useCallback(() => {
    if (!siteConfig.googleDrive.clientId) return;
    if (typeof document === 'undefined') return;
    // Use instanceof to prevent DOM clobbering attacks where user content
    // like `<a id="google-gsi-script">` could shadow a legitimate script element
    const existingElement = document.getElementById(GOOGLE_GSI_SCRIPT_ID);
    if (existingElement instanceof HTMLScriptElement) return;
    // ★ ALSO check for the SIGN-IN script, which is a different element (2026-08-28).
    // `features/lite-auth/login/google-signin.tsx:66,77` loads the same gsi/client
    // library under id `google-gsi-client` and, critically, with `?hl=en` — the
    // locale pin added after the Turnstile/GSI widget rendered in Croatian for a
    // reader who had not asked for it. This id-only guard could not see that script,
    // so enabling Google Drive backup would have appended a SECOND copy of the same
    // library WITHOUT the locale pin, racing the first and silently undoing the fix.
    // Dormant today (`siteConfig.googleDrive.clientId` is unset in production, so
    // this function returns above), which is exactly why it would have been found
    // the hard way later. Match on the library URL, not on our own id.
    const alreadyLoaded = Array.from(document.querySelectorAll('script[src]')).some(
      (el) => el instanceof HTMLScriptElement && el.src.startsWith(GOOGLE_GSI_SCRIPT_SRC)
    );
    if (alreadyLoaded) return;

    const script = document.createElement('script');
    script.id = GOOGLE_GSI_SCRIPT_ID;
    script.src = GOOGLE_GSI_SCRIPT_SRC;
    script.async = true;
    document.body.appendChild(script);
  }, []);

  return (
    <Dialog
      modal={true}
      onOpenChange={(open) => {
        if (open) loadGoogleScript();
      }}
    >
      <DialogTrigger asChild ref={ref}>
        {children}
      </DialogTrigger>
      <DialogContent
        className="mt-16 max-w-[92vw] rounded-md p-0 sm:mt-auto sm:max-w-[480px] sm:px-0"
        data-testid="login-dialog"
      >
        <VisuallyHidden>
          <DialogTitle>Sign In</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden>
          {/* ★ NAMED A KEY TYPE NO DOOR HERE USES (2026-08-28, false-text audit F17).
              This read "Sign in to your account using your posting key", a leftover from
              the smart-signer SignInForm this dialog replaced. It is announced to screen
              readers on every login dialog and is invisible to everyone else, so it was
              the one description nobody could see was wrong. It now names the four doors
              the operator ruling below actually ships. */}
          <DialogDescription>
            Sign in with Google, a Bitcoin or Ethereum wallet, or Hive Keychain.
          </DialogDescription>
        </VisuallyHidden>
        {/* ★ OPERATOR RULING 2026-08-01 — Lumen has FOUR ways in: Google, a
            Bitcoin wallet and an EVM wallet (all Lumen Lite, via Reown for the
            two wallets), plus Hive Keychain for people who already have a Hive
            account. Everything denser shipped here is gone.

            This dialog used to render smart-signer's SignInForm, whose first
            step is the hbauth "encrypt your keys in this browser" screen, with
            PeakVault / MetaMask-Snap / Google-Drive-restore / WIF key entry /
            HiveAuth / HiveSigner behind an "Other sign in options" click. It
            opens from ~24 in-context places (upvote, reply, composer), so that
            was the app's widest exposure of the very flow we removed from
            /login.

            Keychain is inline because it is one field and one click. The three
            LITE methods need the name-pick, CAPTCHA and wallet-connect steps,
            which belong on the full page — the link below goes there. */}
        {/* ★ The SAME four methods as /login (2026-08-07). This used to render
            Keychain alone, so the app's most-opened sign-in surface hid Google
            and both wallet options behind a text link. */}
        {/* v8: this had its own `overflow-y-auto` inside a dialog that also scrolls,
            so a long card produced TWO scrollbars side by side. One scroll container,
            and it is the dialog (DialogContent's wrapper carries `overflow-y-auto`,
            packages/ui/components/dialog.tsx:90).
            ★ 2026-08-28: the `max-h-[76vh]` was left behind when that `overflow-y-auto`
            was removed, and a max-height with the default `overflow: visible` does not
            scroll or clip — it lets the content spill OUT of the box and paint on top of
            whatever follows. On a viewport where the four sign-in methods plus the Hive
            username field exceed 76vh, the "Sign in with Keychain" button rendered over
            the "New to Lumen?" footer below it. Reported from a real browser. The cap is
            gone: the dialog scrolls, the content takes the height it needs. */}
        {/* ★★★ THE DIALOG NEEDS THE FLICKER FIX TOO (2026-08-28). The login PAGE
            got it by handing down the value its own server render already knew;
            this surface would have kept the old behaviour — start at "Google
            sign-in is being set up...", then correct itself a beat later — and
            this is the surface that matters most, because it is the one opened
            from ~24 places in the app.
            Reading the answer directly is safe HERE and only here: this file is
            `'use client'`, and Radix mounts `DialogContent` only once the dialog
            is open, so nothing inside it is ever server-rendered and there is no
            hydration pass that could disagree. `window.__ENV` is long since
            loaded by the time a user clicks. If it somehow is not, the effect
            inside LumenLogin still re-derives the same answer and corrects. */}
        <div className="px-5 pb-2 pt-5">
          <LumenLogin embedded googleConfiguredInitially={googleConfigured()} />
        </div>
        {/* THE SIGNUP DOOR. This dialog is opened from ~24 places — the home
            composer, every upvote and reply button, the left rail — and it asks
            for a Hive username and a private key. A first-time visitor has
            neither, and until now there was no route from here to the keyless
            Google / Bitcoin / Ethereum signup that is the entire point of Lumen
            lite accounts: `/login` was linked from exactly ONE place in the app.
            Fixing it here rather than at each call site means every entry point
            gets it at once, and the visitor keeps their place instead of being
            navigated away from whatever they were trying to do. */}
        <div className="border-t border-border px-6 py-4 text-center">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{t('login_dialog.new_here')}</span>{' '}
            <Link href="/login" className="font-semibold text-destructive underline hover:no-underline">
              {t('login_dialog.signup_link')}
            </Link>{' '}
            {t('login_dialog.signup_explainer')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export default DialogLogin;
