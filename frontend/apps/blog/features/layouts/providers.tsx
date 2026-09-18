'use client';

import { QueryClientProvider } from '@tanstack/react-query';

import { FC, PropsWithChildren, useMemo } from 'react';
import { SignerProvider } from '@hive/smart-signer/components/signer-provider';
import { GoogleOAuthRedirectGate } from '@smart-signer/components/google-oauth-redirect-gate';
import { siteConfig } from '@ui/config/site';
import { getQueryClient } from '@/blog/lib/react-query';
import { UserClientProvider } from '@smart-signer/lib/auth/user-client-context';
import { LoggedUserProvider } from '@/blog/features/votes/hooks/use-logged-user';
import TopCommentSessionReset from '@/blog/features/discovery-feed/top-comment-session-reset';
import { ModalContainer } from '@smart-signer/components/modal-container';
import { Toaster } from '@ui/components/toaster';
import {
  NavigationProgressProvider,
  NavigationProgress,
  NavigationProgressHandler
} from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import ThemeKeeper from '@/blog/features/layouts/theme-keeper';

export const Providers: FC<PropsWithChildren> = ({ children }) => {
  const queryClient = useMemo(() => getQueryClient(), []);
  const { t } = useTranslation('common_blog');

  return (
    <>
      {/* ★★ THE `<Head>` BLOCK IS GONE WITH THE LIGHT-ONLY RULING (2026-09-18).
          It held exactly one tag — `<meta name="theme-color" content="#ffffff">` —
          and the 2026-08-11 note beside it explained that the app had no theme so
          the colour could be a constant. The owner has asked for dark back, so a
          constant is now wrong: an installed PWA would show a white bar over a
          #0e0f11 page. Two things replace it, both closer to the value they
          describe — the `viewport` export in app/layout.tsx emits one media-scoped
          `theme-color` per theme, and `applyTheme()` in lib/theme.ts rewrites the
          served tag when the reader's stated choice differs from their system
          preference.
          ★ Worth knowing either way: this is `next/head`, which is a PAGES-router
          component and a no-op inside the App Router. Whatever it held was never
          in the document; the working tag has always been the `viewport` export.
          So this removes dead code as well as a stale value. */}
      {/* Re-states the theme after hydration; see theme-keeper.tsx for the one
          route family that needs it and the measurement that found it. */}
      <ThemeKeeper />
      <QueryClientProvider client={queryClient}>
        <NavigationProgressProvider>
          <NavigationProgress />
          <NavigationProgressHandler />
          <SignerProvider>
            <GoogleOAuthRedirectGate
              authenticateOnBackend={siteConfig.loginAuthenticateOnBackend}
              strict={!siteConfig.allowNonStrictLogin}
              loadingText={t('login_form.completing_google_auth')}
            />
            {/* ★ ONE `useUserCore` INSTANCE FOR THE WHOLE TREE (option A,
                warm-reclick build map, 2026-09-06). Wraps `LoggedUserProvider`
                (which itself calls `useUserClient()` and now reads this
                context instead of running its own copy) and every route's
                content below it — see `user-client-context.tsx` for the full
                accounting of what used to run once per call site. */}
            <UserClientProvider>
              <LoggedUserProvider>
                {/* Renders nothing. Clears the post card's per-session top-comment
                    picks when the signed-in identity changes — see the file's own
                    header for why this watches identity instead of hooking the
                    logout button. Mounted here because this is the one place that
                    is inside the query client and mounted on every route. */}
                <TopCommentSessionReset />
                {children}
              </LoggedUserProvider>
            </UserClientProvider>
          </SignerProvider>
        </NavigationProgressProvider>
        <ModalContainer />
        <Toaster />
      </QueryClientProvider>
    </>
  );
};
