import { NextRequest, NextResponse } from 'next/server';
import { configuredImagesEndpoint } from '@hive/ui/config/public-vars';
import { proxifyImageSrc } from '@hive/ui/lib/proxify-images';
import { withRetry } from '@transaction/lib/retry';

/**
 * Proxy endpoint for the default avatar image.
 * Usage: /api/avatar/default
 *
 * ★ NOW CACHED (2026-08-15). It said "prevents caching" and sent `no-store,
 * no-cache, must-revalidate, max-age=0` — on a response whose body is ONE
 * hardcoded IPFS CID. A CID is content-addressed: that URL cannot return
 * different bytes, ever, so there was nothing for revalidation to catch.
 *
 * What it cost: this is the universal broken-image fallback (`post-img.tsx`,
 * `suggestions-posts/card.tsx`), so every missing avatar on a page re-fetched
 * the same immutable PNG from the image host with caching explicitly forbidden.
 * The sibling `/api/avatar` route already fixed exactly this — its own note
 * records 29 avatar requests per page at ~6s each before it switched to
 * `public, max-age=86400, stale-while-revalidate` — but this route was never
 * brought along.
 *
 * Same one-day life as the sibling, for the same reason and by the same
 * argument, so the two routes cannot drift apart again.
 */
/**
 * ★★ AND IT WAS FROZEN AT BUILD TIME (found 2026-08-25). Caching this response
 * is right — the note above is correct and stands — but Next was doing
 * something stronger and permanent: it PRERENDERED the whole route into the
 * build and served those bytes forever, with `initialRevalidateSeconds: false`.
 *
 * ★ THE TRAP WORTH REMEMBERING: this route DOES declare `GET(req: NextRequest)`.
 * A declared Request parameter does not save a route — `req` is never
 * referenced in the body, and Next tracks actual dynamic USAGE, not the
 * signature. Of all 95 route handlers in this app, this was the only one where
 * the parameter is declared and unused, which is exactly why it was the only
 * one to freeze despite having it.
 *
 * The frozen BODY is harmless: the URL is one hardcoded IPFS CID, and a CID is
 * content-addressed, so those bytes cannot go stale. The frozen ENDPOINT is
 * not. `configuredImagesEndpoint` is `env('IMAGES_ENDPOINT')` — resolved at
 * RUNTIME by react-env — so a build-time evaluation bakes whichever host was
 * configured on the BUILD machine into the artifact permanently. Deploy this
 * build anywhere with a different `IMAGES_ENDPOINT` and the universal
 * broken-image fallback keeps fetching from the old host, forever, silently.
 *
 * 86400 matches the `Cache-Control: max-age=86400` below exactly, so the
 * serving behaviour and the perf argument above are unchanged — the endpoint
 * is simply re-resolved once a day instead of never.
 */
export const revalidate = 86400;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const defaultUrl = `${configuredImagesEndpoint}/DQmb2HNSGKN3pakguJ4ChCRjgkVuDN9WniFRPmrxoJ4sjR4`;

    // ★ WEBP (2026-09-04, T1b perf). `defaultUrl` above is the raw blob store, not
    // the resize proxy — no redirect in the chain, and (verified) appending
    // `?format=webp` to it does nothing; it just streams the stored bytes back
    // unchanged. `proxifyImageSrc` builds this SAME image's `/p/<hash>` resize-proxy
    // URL instead, which DOES honour `format` — width/height stay 0 (unset) so this
    // asks for the source's own resolution transcoded to WebP, not a resize.
    // Measured on this exact CID: 91,267 bytes PNG (raw fetch) -> 24,232 bytes WebP
    // (-73%). This is the universal broken-image fallback (every missing avatar on
    // the site), so every byte here is paid on top of an already-failed image load.
    const webpUrl = proxifyImageSrc(defaultUrl, 0, 0);

    // Fetch the image from the image hoster and stream it to the client
    // ★ A6 retry rollout (2026-08-18): idempotent read of one immutable, content-
    // addressed image — the safest possible retry target in this codebase.
    const response = await withRetry(
      () => fetch(webpUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      { label: 'avatar-default' }
    );

    // WebP isn't guaranteed forever from the proxy — fall back to the original raw
    // fetch (today's pre-fix behaviour) rather than turning a proxy hiccup into a
    // broken universal fallback image.
    const resolved =
      response.ok && response.body
        ? response
        : await withRetry(() => fetch(defaultUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }), { label: 'avatar-default-fallback' });

    if (!resolved.ok || !resolved.body) {
      return NextResponse.json({ error: 'Failed to fetch default avatar' }, { status: resolved.status });
    }

    const headers = new Headers({
      'Content-Type': resolved.headers.get('content-type') || 'image/png',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      'X-Content-Type-Options': 'nosniff',
    });

    // Stream the response body directly
    return new NextResponse(resolved.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Error fetching default avatar:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

