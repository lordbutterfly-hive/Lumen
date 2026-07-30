import '@hive/tailwindcss-config/globals.css';
import * as Sentry from '@sentry/nextjs';
import { ReactNode } from 'react';
import { Metadata } from 'next';
import { cookies } from 'next/headers';
import AppHeader from '../features/layouts/app-header';
import ClientEffects from '../features/layouts/site-header/client-effects';
import { Providers } from '../features/layouts/providers';
import { StorageCleanup } from '@hive/ui';
import CondenserMigration from '../components/condenser-migration';
import { getEnvVersion } from '../lib/env-version';
import { Open_Sans, Lora } from 'next/font/google';
import { siteConfig } from '@ui/config/site';

// Redesign typography (design-handoff-v2, 2026-07-21): Open Sans for ALL UI —
// headers, nav, labels, chips, buttons, tabs, table headers and numbers
// (tabular-nums) — and Lora for running body prose. The handoff is explicit:
// "ONLY two families ... no Inter, no serif display face." Self-hosted via
// next/font so it complies with the app CSP (font-src 'self'). The CSS-variable
// names are deliberately kept (--font-inter / --font-source-serif) so the whole
// tailwind + denser font pipeline downstream needs no change — only the family
// bound to each variable swaps.
const openSans = Open_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-inter',
  display: 'swap'
});
const lora = Lora({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-source-serif',
  display: 'swap'
});

// Get basePath from build-time environment
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const SITE_DESC =
  'Communities without borders. A social network owned and operated by its users, powered by Hive.';

const metadata = {
  metadataBase: new URL(process.env.REACT_APP_SITE_DOMAIN || 'https://hive.blog'),
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`
  },
  description: SITE_DESC,
  icons: {
    icon: '/favicon.ico'
  },
  openGraph: {
    type: 'website',
    siteName: siteConfig.name,
    title: siteConfig.name,
    description: SITE_DESC,
    // TODO(branding): these still point at hive.blog's own share images — no
    // Lumen-branded og/twitter share image exists anywhere in public/images/
    // yet. Left as a real, working image rather than a 404 on a guessed path;
    // swap once a real asset exists.
    images: ['https://hive.blog/images/hive-blog-share.png']
  },
  twitter: {
    card: 'summary',
    // No real Lumen social handle exists anywhere in this codebase
    // (siteConfig.links.twitter is itself a dead '/' placeholder) — omitting
    // `site` rather than keeping the unrelated official @hiveblocks handle.
    title: siteConfig.name,
    description: SITE_DESC,
    images: ['https://hive.blog/images/hive-blog-twshare.png']
  },
  other: {
    // Real placeholder removed: no Facebook App ID is configured anywhere in
    // this codebase, so the key is simply omitted rather than shipping a
    // literal 'YOUR_FB_APP_ID' string in production metadata.
  }
} as const satisfies Metadata;

export function generateMetadata(): Metadata {
  if (!process.env.REACT_APP_SENTRY_DSN) {
    return metadata;
  }

  return {
    ...metadata,
    other: {
      ...metadata.other,
      ...Sentry.getTraceData()
    }
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server-side locale and language handling
  const cookieStore = cookies();
  const locale = cookieStore.get('NEXT_LOCALE')?.value || 'en';
  const isRTL = locale === 'ar';

  // Generate stable version hash for __ENV.js cache-busting
  // Only changes when REACT_APP_* env variables change
  const envVersion = getEnvVersion();

  return (
    <html lang={locale} dir={isRTL ? 'rtl' : 'ltr'} className={`${openSans.variable} ${lora.variable}`}>
      <head>
        {/* Use plain script tag for guaranteed synchronous loading of env globals */}
        <script src={`${basePath}/__ENV.js?v=${envVersion}`} />
      </head>
      <body className="bg-background-secondary font-sans">
        <div className="min-h-screen">
          <Providers>
            <>
              <StorageCleanup />
              <CondenserMigration />
              <AppHeader />
              <main className="mx-auto">{children}</main>
            </>
          </Providers>
        </div>
        <ClientEffects />
      </body>
    </html>
  );
}
