import { DefaultRenderer, TablePlugin, InstagramResizePlugin, TwitterResizePlugin } from '@hive/renderer';
import { proxifyImageSrc } from '@ui/lib/proxify-images';

import imageUserBlocklist from '@hive/ui/config/lists/image-user-blocklist';

import { configuredSiteDomain, configuredImagesEndpoint } from '@hive/ui/config/public-vars';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

// Build a set of trusted origins for link safety checks.
// Uses URL.origin comparison instead of string prefix matching to prevent
// subdomain spoofing (e.g. "images.hive.blog.evil.com" matching "images.hive.blog").
const safeOrigins = new Set(
  [configuredImagesEndpoint, configuredSiteDomain]
    .filter(Boolean)
    .map((domain) => {
      try {
        return new URL(domain).origin;
      } catch {
        return null;
      }
    })
    .filter((o): o is string => o !== null)
);

function isLinkSafe(url: string): boolean {
  if (url.startsWith('#')) return true;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    return safeOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

const renderDefaultOptions = {
  baseUrl: configuredSiteDomain,
  breaks: false,
  skipSanitization: false,
  allowInsecureScriptTags: false,
  addNofollowToLinks: true,
  addTargetBlankToLinks: true,
  cssClassForInternalLinks: '',
  cssClassForExternalLinks: 'link-external',
  doNotShowImages: false,
  ipfsPrefix: '',
  assetsWidth: 640,
  assetsHeight: 480,
  // Note: Instagram uses iframe-only resize (postMessage), Twitter loads widgets.js for native rendering
  plugins: [new TablePlugin(), new InstagramResizePlugin(), new TwitterResizePlugin()],
  // Post body images render into a max-w-4xl content column. Measured its
  // rendered CSS width across breakpoints: 394px @768w, 650px @1024w,
  // 710px @1440w (this project's own standard test viewport -- see the
  // playwright-mcp config), plateauing at a hard 854px cap from 1920w
  // through 2560w (confirmed unchanged at both). 1420 = 2x the 1440w slot:
  // enough for a retina (dpr=2) display at the project's standard desktop
  // width without the ~4x overshoot the old hardcoded 1536 represented
  // relative to how this column actually renders at more typical/mobile
  // widths (2x @768w would be ~788, 2x @1024w ~1300). Picking 1420 over the
  // 854-cap's 2x (1708) also means it actually engages mode=fit's downscale
  // for the very common oversized-source-photo case: proxifyImageSrc never
  // upscales, so any width >= a photo's native width is a no-op -- verified
  // on a 1411px-native test image, where 1420 and 1708 produced
  // byte-identical output (both just returned the native resolution) while
  // 1100 (the audit's original, narrower reference point) forced a real
  // downscale and a meaningfully smaller file.
  imageProxyFn: (url: string) => proxifyImageSrc(url, 1420, 0),
  usertagUrlFn: (account: string) => (basePath ? `${basePath}/@${account}` : `/@${account}`),
  /**
   * ★★ `/topics/`, NOT `/trending/` (2026-08-18).
   *
   * This built `/trending/<hashtag>` for EVERY hashtag in EVERY rendered post body, and
   * `/trending/:tag` is a retired route: it survives only as a 307 in `next.config.js`.
   * So the most-clicked link type in the product paid a redirect round trip on every
   * click, and an investigation into deleting those 15 dead page files found this pointing
   * straight at them - deleting the redirect would have broken every hashtag in every post
   * ever written, which is not a thing anyone would have predicted from the page files
   * themselves looking unreachable.
   *
   * The mapping is not a guess: it is exactly what the redirect's own `Location` header
   * returns, verified by request.
   */
  hashtagUrlFn: (hashtag: string) => (basePath ? `${basePath}/topics/${hashtag}` : `/topics/${hashtag}`),
  isLinkSafeFn: (url: string) => isLinkSafe(url),
  addExternalCssClassToMatchingLinksFn: (url: string) => !isLinkSafe(url)
};

const rendererRegular = new DefaultRenderer(renderDefaultOptions);

const rendererNoImages = new DefaultRenderer({
  ...renderDefaultOptions,
  doNotShowImages: true
});

export function getRenderer(author: string = ''): DefaultRenderer {
  if (!!author && imageUserBlocklist.includes(author)) {
    return rendererNoImages;
  } else {
    return rendererRegular;
  }
}

/**
 * Returns a renderer with a proxy auth token baked into imageProxyFn,
 * so editor preview images bypass the whitelist check.
 */
export function getPreviewRenderer(token: string, author: string = ''): DefaultRenderer {
  const options = {
    ...renderDefaultOptions,
    imageProxyFn: (url: string) => proxifyImageSrc(url, 1420, 0, 'match', token),
  };
  if (!!author && imageUserBlocklist.includes(author)) {
    return new DefaultRenderer({ ...options, doNotShowImages: true });
  }
  return new DefaultRenderer(options);
}
