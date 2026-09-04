'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

/**
 * ★ WAX-FREE GATE for the Google OAuth redirect handler (2026-09-04, perf).
 *
 * GoogleOAuthRedirectHandler pulls the entire sign-in stack (useProcessAuth ->
 * signin-form -> every signer implementation -> @hiveio/wax, a ~220 KB
 * pre-bundled runtime) and it is mounted app-wide in features/layouts/providers,
 * so a STATIC import dragged wax into the first-load JS of every page -- even
 * though the handler does nothing at all unless the current URL is a Google OAuth
 * return, which it detects by `?google_auth=pending` (see handleOAuthRedirect in
 * that file).
 *
 * This gate performs that same cheap, wax-free check itself and only THEN
 * dynamically imports the real handler. A normal visit renders null and never
 * downloads the handler (or wax); an OAuth return loads it on the spot. Props are
 * passed straight through, so the handler behaves exactly as before once mounted.
 * Kept as its own component (rather than inlined into Providers) so the detection
 * condition stays next to the handler it guards and can be tested in isolation.
 */
const GoogleOAuthRedirectHandler = dynamic(
  () => import('./google-oauth-redirect-handler').then((m) => m.GoogleOAuthRedirectHandler),
  {
    ssr: false,
    // ★ Match the handler's own processing overlay so there is no blank gap
    // between this gate mounting the handler and the handler starting to process
    // the redirect (F3, 2026-09-04). Without it, the Safari redirect path (which
    // returns to a full page load, not a popup) showed nothing while this chunk
    // downloaded. Same markup the handler renders once isProcessing; spinner-only
    // so it stays i18n-clean, and the handler's own translated loadingText takes
    // over the instant it mounts.
    loading: () => (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="status">
        <div className="rounded-lg bg-background p-6 text-center shadow-lg">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    )
  }
);

interface GoogleOAuthRedirectGateProps {
  authenticateOnBackend?: boolean;
  strict?: boolean;
  onComplete?: (username: string) => void;
  loadingText?: string;
}

export function GoogleOAuthRedirectGate(props: GoogleOAuthRedirectGateProps) {
  const [isOAuthReturn, setIsOAuthReturn] = useState(false);

  useEffect(() => {
    // Same trigger the handler uses; if it is not a Google OAuth return there is
    // nothing for the handler to do, so we never load it (or wax).
    const params = new URLSearchParams(window.location.search);
    if (params.get('google_auth') === 'pending') {
      setIsOAuthReturn(true);
    }
  }, []);

  if (!isOAuthReturn) return null;
  return <GoogleOAuthRedirectHandler {...props} />;
}
