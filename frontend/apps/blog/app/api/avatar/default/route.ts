import { NextRequest, NextResponse } from 'next/server';
import { configuredImagesEndpoint } from '@hive/ui/config/public-vars';

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
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const defaultUrl = `${configuredImagesEndpoint}/DQmb2HNSGKN3pakguJ4ChCRjgkVuDN9WniFRPmrxoJ4sjR4`;

    // Fetch the image from the image hoster and stream it to the client
    const response = await fetch(defaultUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok || !response.body) {
      return NextResponse.json({ error: 'Failed to fetch default avatar' }, { status: response.status });
    }

    const headers = new Headers({
      'Content-Type': response.headers.get('content-type') || 'image/png',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      'X-Content-Type-Options': 'nosniff',
    });

    // Stream the response body directly
    return new NextResponse(response.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Error fetching default avatar:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

