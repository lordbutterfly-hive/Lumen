'use client';

import { Link } from '@hive/ui';

import { forwardRef, ReactNode, useCallback } from 'react';
import { Dialog, DialogContent, DialogTrigger, DialogTitle, DialogDescription } from '@ui/components/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import LumenLogin from '@/blog/features/lite-auth/login/lumen-login';
import { siteConfig } from '@ui/config/site';
import { useTranslation } from '@/blog/i18n/client';

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
            and it is the dialog. */}
        <div className="max-h-[76vh] px-5 pb-2 pt-5">
          <LumenLogin embedded />
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
