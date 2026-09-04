import querystring from 'querystring';
import multihash from 'multihashes';
import { configuredImagesEndpoint } from '@hive/ui/config/public-vars';

const proxyBase = configuredImagesEndpoint;

interface ProxyOptions {
  [key: string]: string | number | undefined;
  format: string;
  mode?: string;
  width?: number;
  height?: number;
}

export function extractPHash(url: string): string | null {
  if (url.startsWith(`${proxyBase}/p/`)) {
    const [hash] = url.split('/p/')[1].split('?');
    return hash.replace(/.webp/, '').replace(/.png/, '');
  }
  return null;
}

export function getLatestUrl(str: string): string {
  const [last] = [
    ...str
      .replace(/https?:\/\//g, '\n$&')
      .trim()
      .split('\n')
  ].reverse();
  return last;
}

export function proxifyImageSrc(url?: string, width = 0, height = 0, format = 'webp', token?: string) {
  if (!url || typeof url !== 'string') {
    return '';
  }

  // ★ RELATIVE URLS ARE OURS — NEVER HAND THEM TO A THIRD-PARTY PROXY (2026-08-13).
  //
  // Everything below encodes `url` into `${proxyBase}/p/<base58>`, which asks
  // images.hive.blog to go and FETCH that url itself. A relative path only means
  // something to our own origin, so the proxy resolves nothing and answers
  // `HTTP 400 {"error":{"name":"invalid_proxy_url"}}` — a JSON body where the
  // browser was promised an image, which Chrome then kills as
  // `net::ERR_BLOCKED_BY_ORB`, leaving a broken thumbnail.
  //
  // Measured on the live post page, not deduced: three failures per page, and
  // base58-decoding the hashes gave back our own `/api/avatar?username=beggars`,
  // `/api/avatar?username=unklebonehead` and `/api/avatar/default`. They arrive
  // here from `find_first_img`'s last fallback (features/list-of-posts/post-img.tsx),
  // which returns `getUserAvatarUrl(author,'large')`, and from
  // `getDefaultImageUrl()` on the `onError` retry in suggestions-posts/card.tsx —
  // so the retry was as unproxyable as the original and failed the same way.
  //
  // Returning it untouched is the whole fix: the browser loads it from us, which
  // is what a same-origin URL is for. Resizing is lost, but `/api/avatar` already
  // takes its own `size`/`width`/`height` params, so nothing that reaches here
  // needed this function to resize it.
  if (!/^https?:\/\//i.test(url)) {
    return url;
  }

  // Skip already-proxified URLs (ones that already carry our resize/format
  // query string). A bare `${proxyBase}/p/<hash>` URL with no query string is
  // NOT necessarily "already proxied" -- it's also the exact path shape Hive's
  // own raw image storage uses for uploads, since proxyBase (images.hive.blog)
  // is both the CDN and the resize proxy. `format` is the one option this
  // function unconditionally sets on every URL it builds (mode/width/height
  // are omitted for GIFs, see below), so its presence -- not the path alone --
  // is what actually means "already went through this function". Matching on
  // the path alone would wrongly treat every raw Hive-hosted upload as
  // pre-proxied and skip resizing/reformatting it entirely.
  // ★ ...BUT ONLY WHEN NO RESIZE WAS REQUESTED (2026-09-04, perf). A card that
  // asks for a width/height must still get THAT size, even off an already-proxied
  // URL: an author's json_metadata.image often carries a full-size proxy URL
  // (e.g. ?format=match&mode=fit&width=1536), and returning it unchanged shipped a
  // single 1.9 MB image to a 256px card (96% of that page's image weight). When a
  // width/height IS requested we fall through to extractPHash + rebuild below,
  // which re-derives the SAME /p/<hash> at the requested size. With no resize
  // requested (width=0,height=0) we still return it as-is (re-deriving would drop
  // the existing width and, on mode=fit with no dimensions, can inflate the file).
  if (url.startsWith(`${proxyBase}/p/`) && /[?&]format=/.test(url) && width === 0 && height === 0) {
    return url; // already proxified, no resize asked for
  }

  if (url.indexOf('https://steemitimages.com/') === 0 && url.indexOf('https://steemitimages.com/D') !== 0) {
    let result = url.replace('https://steemitimages.com', proxyBase);
    if (token) {
      result += (result.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
    return result;
  }

  // For other external images (including ecency), use the /p/hash system
  // Note: ecency's /p/ hash format is incompatible with hive.blog's, so we
  // must encode the full URL rather than doing a simple domain replacement
  const realUrl = getLatestUrl(url);
  // Handle spaces in malformed URLs (blockchain URLs are already percent-encoded;
  // encodeURI() was double-encoding %XX sequences, breaking URLs with %2F etc.)
  const encodedUrl = realUrl.replace(/ /g, '%20');
  const pHash = extractPHash(encodedUrl);

  // Detect GIF URLs - the resize proxy is unsafe for GIFs in two ways
  // (verified empirically against the live proxy, not just from the original
  // comment here): asking it to resize (width/height) collapses the
  // animation to a single static frame, AND asking it to `mode=fit` with NO
  // width/height (which is what a naive "just skip the dimensions" fix would
  // send) hits a proxy-side bug that inflates the file 45-63x instead of
  // passing it through (a 66KB/3-frame source came back as a 4.1MB/97-"frame"
  // response). So GIFs get `format` only -- no mode, no width, no height --
  // which reproduces the original bytes untouched.
  const isGif = /\.gif($|\?)/i.test(realUrl);

  const options: ProxyOptions = {
    // 'match' passes GIF bytes through unchanged regardless of what format
    // the caller/default asked for; converting to webp would flatten it same
    // as resizing would.
    format: isGif ? 'match' : format
  };

  if (!isGif) {
    options.mode = 'fit';

    if (width > 0) {
      options.width = width;
    }

    if (height > 0) {
      options.height = height;
    }
  }

  const qs = querystring.stringify(options);
  const tokenSuffix = token ? '&token=' + encodeURIComponent(token) : '';

  if (pHash) {
    // Don't add .png extension for Hive images, let the image hoster decide
    return `${proxyBase}/p/${pHash}?${qs}${tokenSuffix}`;
  }

  // Use TextEncoder for browser compatibility instead of Buffer
  const encoder = new TextEncoder();
  const bytes = encoder.encode(encodedUrl);
  const b58url = multihash.toB58String(bytes);

  return `${proxyBase}/p/${b58url}?${qs}${tokenSuffix}`;
}
