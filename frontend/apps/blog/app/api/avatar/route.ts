import { NextRequest, NextResponse } from 'next/server';
import { configuredImagesEndpoint } from '@hive/ui/config/public-vars';
import { isHiveAccountNameValid } from '@hive/transaction';
import { isLiteDisplayName } from '@/blog/lib/lite/render/lite-identity';

/**
 * Proxy endpoint for user avatars that prevents caching
 * Usage: /api/avatar?username=USERNAME&size=small|medium|large
 *        /api/avatar?username=USERNAME&width=WIDTH&height=HEIGHT
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const searchParams = req.nextUrl.searchParams;
    const username = searchParams.get('username');
    const size = searchParams.get('size');
    const width = searchParams.get('width');
    const height = searchParams.get('height');

    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    if (!(await isHiveAccountNameValid(username))) {
      return NextResponse.json({ error: 'Invalid username' }, { status: 400 });
    }

    // Build the image hoster URL
    let imageUrl: string;
    if (size && ['small', 'medium', 'large'].includes(size)) {
      imageUrl = `${configuredImagesEndpoint}/u/${username}/avatar/${size}`;
    } else if (width && height) {
      const baseUrl = `${configuredImagesEndpoint}/u/${username}/avatar`;
      imageUrl = baseUrl;
    } else {
      imageUrl = `${configuredImagesEndpoint}/u/${username}/avatar/small`;
    }

    // Fetch the image from the image hoster and stream it to the client
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok || !response.body) {
      // A Lumen lite account has no Hive account and therefore no hosted avatar, so
      // the image hoster 404s and every surface that renders this as a bare
      // background-image showed a blank square. Serve a generated initial-letter
      // avatar instead — the same idea as the feed strip's AvatarFallback, but here so
      // that every consumer of /api/avatar benefits without touching each one.
      if (await isLiteDisplayName(username)) {
        return initialAvatar(username);
      }
      return NextResponse.json({ error: 'Failed to fetch avatar' }, { status: response.status });
    }

    // Prepare headers, copying content-type from the origin
    const headers = new Headers({
      'Content-Type': response.headers.get('content-type') || 'image/png',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff',
    });

    // Stream the response body directly
    return new NextResponse(response.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Error fetching avatar:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}


/**
 * Deterministic initial-letter avatar. Same name always yields the same colour, so a
 * user's avatar does not change between page loads.
 */
function initialAvatar(username: string): NextResponse {
  const letter = (username.trim()[0] ?? '?').toUpperCase();
  let hash = 0;
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="${letter}">
  <rect width="96" height="96" fill="hsl(${hash} 45% 42%)"/>
  <text x="48" y="62" text-anchor="middle" font-family="system-ui,sans-serif" font-size="46" font-weight="600" fill="#fff">${letter}</text>
</svg>`;
  return new NextResponse(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      // Cacheable: it is a pure function of the name.
      'Cache-Control': 'public, max-age=86400'
    }
  });
}
