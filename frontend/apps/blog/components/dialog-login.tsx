'use client';

import { Link } from '@hive/ui';

import { ReactNode, useCallback } from 'react';
import { Dialog, DialogContent, DialogTrigger, DialogTitle, DialogDescription } from '@ui/components/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import KeychainSignin from '@/blog/features/lite-auth/login/keychain-signin';
import { siteConfig } from '@ui/config/site';
import { useTranslation } from '@/blog/i18n/client';

const GOOGLE_GSI_SCRIPT_ID = 'google-gsi-script';
const GOOGLE_GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

interface DialogLoginProps {
  children: ReactNode;
  redirectTo?: string;
}

function DialogLogin({ children, redirectTo }: DialogLoginProps) {
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
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="mt-32 max-w-[380px] rounded-md p-0 sm:mt-auto sm:max-w-[450px] sm:px-0"
        data-testid="login-dialog"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <VisuallyHidden>
          <DialogTitle>Sign In</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden>
          <DialogDescription>Sign in to your account using your posting key.</DialogDescription>
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
        <div className="px-6 pb-2 pt-6">
          <KeychainSignin redirectTo={redirectTo} />
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
            <Link href="/login" className="text-destructive underline hover:no-underline">
              {t('login_dialog.signup_link')}
            </Link>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default DialogLogin;
