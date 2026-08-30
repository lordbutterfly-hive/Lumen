'use client';

import { useEffect, useState } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★★ WHERE GOOGLE DELIVERS THE ID TOKEN, SO LUMEN CAN DRAW ITS OWN BUTTON.
 *
 * Owner, 2026-08-29: "i want our own button. always our own button." Three
 * earlier attempts failed, and this page exists because of what each proved:
 *
 *   1. A Lumen row with Google's real button invisible on top (`opacity-0` +
 *      `transform: scale()` inside `overflow-hidden`). GIS SILENTLY refuses
 *      clicks on a button that is transparent, transformed or clipped —
 *      anti-clickjacking. Dead for 18 days without one error in any log.
 *   2. FedCM (`navigator.credentials.get`, `mode:"active"`). Genuinely reached
 *      Google, but Google removed `response_type` from the FedCM pipeline in
 *      October 2025 and left the sign-in continuation calling the old consent
 *      builder, so a signed-out reader lands on `Error 400: invalid_request —
 *      Required parameter is missing: response_type`. Broken on Google's side.
 *   3. `initCodeClient` (authorization-code flow). Correct, but needs a client
 *      SECRET, which we do not have.
 *
 * THE WAY THROUGH is the one thing none of those tried: ask Google's own
 * authorization endpoint for `response_type=id_token` directly. Google's
 * discovery document advertises it (`response_types_supported` includes
 * `id_token`), it is plain OpenID Connect, and the implicit flow HAS NO CLIENT
 * SECRET by definition — the token is signed by Google and verified against
 * Google's public keys, so there is no secret to prove anything with.
 *
 * ★ THE SECURITY IS NOT WEAKER, and that is the whole reason this is allowed.
 * The token that arrives here is the SAME Google-signed JWT `renderButton`
 * would have produced, carrying the SAME server-issued single-use `nonce`, and
 * it is handed to the SAME `/api/lite/auth/google` endpoint, which checks the
 * signature against Google's keys, checks `aud` is our client id, consumes the
 * challenge, and refuses unless the token's `nonce` claim echoes it. Nothing
 * about this page is trusted: it is a courier, not an authority.
 *
 * ★ WHY A PAGE AND NOT AN API ROUTE. `response_mode=form_post` would need a
 * route that renders HTML with an inline script to hand the token to the
 * opener, and this app ships a strict CSP — an inline script there would be
 * blocked, or would force a CSP hole on a route that handles credentials. A
 * normal React page has no inline script at all, so there is nothing to
 * whitelist and no HTML-injection surface.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Must match the sender in `google-signin.tsx`. */
const MESSAGE_TYPE = 'lumen:google-id-token';

export default function GoogleReturnPage() {
  const [stranded, setStranded] = useState(false);

  useEffect(() => {
    // The fragment never reaches a server — browsers do not send it — so the
    // token exists only in this tab, for the moment it takes to forward it.
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const params = new URLSearchParams(hash);
    const idToken = params.get('id_token') ?? '';
    const state = params.get('state') ?? '';
    const error = params.get('error') ?? '';

    /**
     * ★ STRIP IT IMMEDIATELY. Even in a popup that is about to close, leaving a
     * credential in `location.href` puts it in session history and in anything
     * that later reads the URL. `replaceState` drops it without a navigation.
     */
    window.history.replaceState(null, '', window.location.pathname);

    const opener = window.opener as Window | null;
    if (!opener || opener.closed) {
      // Someone opened this URL directly, or the opener is gone. Say nothing
      // about tokens; just get them somewhere useful.
      setStranded(true);
      return;
    }

    /**
     * ★ EXACT ORIGIN, NEVER '*'. `postMessage` with a wildcard target delivers
     * to whatever document happens to be in the opener — including one an
     * attacker navigated it to — which would hand a live credential to them.
     */
    opener.postMessage({ type: MESSAGE_TYPE, idToken, state, error }, window.location.origin);
    window.close();
  }, []);

  // Nothing is rendered in the normal path: the window closes within a frame of
  // mount. This is only for the stranded case above.
  if (!stranded) return null;

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <p className="font-sans text-body text-ink-2">You can close this window and return to Lumen.</p>
        <a href="/login" className="mt-3 inline-block font-sans text-caption text-ink-10 underline">
          Back to sign in
        </a>
      </div>
    </main>
  );
}
