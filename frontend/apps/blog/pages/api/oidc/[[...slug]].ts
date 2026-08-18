import { NextApiRequest, NextApiResponse } from 'next';
import { oidc } from '@smart-signer/lib/oidc';

/**
 * ★★ THE MISSING `return` (A5, 2026-08-18).
 *
 * This handler read:
 *
 *   if (oidc) { await oidc.callback()(req, res); }
 *   res.status(404).end();
 *
 * The 404 was UNCONDITIONAL. When OIDC is disabled that is the intended answer and the
 * bug is invisible — which is why it survived: `oidcInstance` is `null` unless the
 * provider is configured (packages/smart-signer/lib/oidc.ts:213), and it is not
 * configured on this build, so every request takes the harmless path.
 *
 * The moment a deployment DOES configure it, `oidc.callback()` writes a full response and
 * then this line tries to write a second one on the same request — `ERR_HTTP_HEADERS_SENT`
 * on every OIDC call, i.e. the feature is broken exactly when it is switched on. That is
 * the worst shape a bug can have: dormant in every environment where anyone would look
 * for it.
 *
 * ★ WHAT THE AUDIT GOT WRONG, RECORDED SO THE NEXT PASS DOES NOT REPEAT IT. The finding
 * said `next.config.js` rewrites `/oidc/:path*` to a destination that "does not exist",
 * having looked only in `app/api/`. The route has always existed — HERE, in the Pages
 * router, which this app still serves alongside the App router. The observed 404 was
 * real; the explanation was not. The rewrites are correct and stay.
 */
async function oidcRoute(req: NextApiRequest, res: NextApiResponse) {
  if (oidc) {
    await oidc.callback()(req, res);
    return;
  }
  res.status(404).end();
}

export default oidcRoute;
