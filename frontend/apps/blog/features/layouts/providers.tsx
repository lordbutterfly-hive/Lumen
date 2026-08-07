'use client';

import { QueryClientProvider } from '@tanstack/react-query';

import { FC, PropsWithChildren, useMemo } from 'react';
import Head from 'next/head';
import { useTheme } from 'next-themes';
import { SignerProvider } from '@hive/smart-signer/components/signer-provider';
import { GoogleOAuthRedirectHandler } from '@smart-signer/components/google-oauth-redirect-handler';
import { siteConfig } from '@ui/config/site';
import { getQueryClient } from '@/blog/lib/react-query';
import { LoggedUserProvider } from '@/blog/features/votes/hooks/use-logged-user';
import { ThemeProvider } from '@/blog/features/layouts/theme-provider';
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
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation('common_blog');

  return (
    <>
      <Head>
        <meta name="theme-color" content={resolvedTheme === 'dark' ? '#030711' : '#ffffff'} />
      </Head>
      <QueryClientProvider client={queryClient}>
        {/* ★ LIGHT ONLY (2026-08-06, owner ruling). The in-app theme toggle was
            removed, but `defaultTheme="system" enableSystem` meant anyone whose OS
            was set to dark still got a dark, unstyled-in-places UI with no way to
            opt out — QA confirmed `html.dark` and a dark body background. The
            provider stays (providers.tsx reads useTheme() for the theme-color meta
            tag), it is simply pinned to light. */}
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} forcedTheme="light">
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
                {children}
              </LoggedUserProvider>
            </SignerProvider>
          </NavigationProgressProvider>
        </ThemeProvider>
        <ModalContainer />
        <Toaster />
      </QueryClientProvider>
    </>
  );
};
