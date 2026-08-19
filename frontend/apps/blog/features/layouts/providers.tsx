'use client';

import { QueryClientProvider } from '@tanstack/react-query';

import { FC, PropsWithChildren, useMemo } from 'react';
import Head from 'next/head';
import { SignerProvider } from '@hive/smart-signer/components/signer-provider';
import { GoogleOAuthRedirectHandler } from '@smart-signer/components/google-oauth-redirect-handler';
import { siteConfig } from '@ui/config/site';
import { getQueryClient } from '@/blog/lib/react-query';
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

export const Providers: FC<PropsWithChildren> = ({ children }) => {
  const queryClient = useMemo(() => getQueryClient(), []);
  const { t } = useTranslation('common_blog');

  return (
    <>
      <Head>
        {/* ★ LIGHT ONLY, NO THEME (2026-08-11, owner ruling supersedes the
            2026-08-06 forced-light ruling). Dark mode was never reachable — no
            toggle existed anywhere in the product — and the `.dark` styles that
            did ship were provably broken when forced (header and cards stayed
            white, sidebar labels went unreadable dark-grey-on-dark). Rather than
            keep carrying next-themes to serve a single static value, the
            provider and every `dark:` variant in this app are removed. The color
            is now a plain constant. apps/wallet keeps its own real, working
            next-themes toggle — that is a separate app with its own provider and
            is not touched by this. */}
        <meta name="theme-color" content="#ffffff" />
      </Head>
      <QueryClientProvider client={queryClient}>
        <NavigationProgressProvider>
          <NavigationProgress />
          <NavigationProgressHandler />
          <SignerProvider>
            <GoogleOAuthRedirectHandler
              authenticateOnBackend={siteConfig.loginAuthenticateOnBackend}
              strict={!siteConfig.allowNonStrictLogin}
              loadingText={t('login_form.completing_google_auth')}
            />
            <LoggedUserProvider>
              {/* Renders nothing. Clears the post card's per-session top-comment
                  picks when the signed-in identity changes — see the file's own
                  header for why this watches identity instead of hooking the
                  logout button. Mounted here because this is the one place that
                  is inside the query client and mounted on every route. */}
              <TopCommentSessionReset />
              {children}
            </LoggedUserProvider>
          </SignerProvider>
        </NavigationProgressProvider>
        <ModalContainer />
        <Toaster />
      </QueryClientProvider>
    </>
  );
};
