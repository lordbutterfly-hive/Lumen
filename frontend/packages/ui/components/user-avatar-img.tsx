'use client';

import { useState } from 'react';
import { cn } from '@ui/lib/utils';
import { getUserAvatarDirectUrl, getUserAvatarUrl } from '@ui/lib/avatar-utils';

type AvatarApiSize = 'small' | 'medium' | 'large';

export interface UserAvatarImgProps {
  /** Hive (or Lumen-lite) account name. */
  username: string;
  /**
   * Which resolution to request from the image host / proxy — matches the
   * host's own `small`/`medium`/`large` presets, independent of the CSS box
   * size below. Defaults to `small`, which is what almost every existing
   * call site already requested regardless of its on-screen size.
   */
  apiSize?: AvatarApiSize;
  /** CSS width/height in px. Every call site had its own exact box size before this converged them, so this is required rather than defaulted, to keep every migration a pure behavior fix with zero layout diff. */
  pixelSize: number;
  /** Tailwind radius class for both the monogram box and the image. `rounded-full` (circle) unless the call site used a rounded square. */
  radiusClassName?: string;
  /** Extra classes on the outer box. */
  className?: string;
  /** `alt` for the `<img>`. Most call sites already carry the name on a surrounding `<Link>` or adjacent text, so this defaults to `''` (decorative) — pass a real string when the image is the only thing naming the account. */
  alt?: string;
  loading?: 'lazy' | 'eager';
}

/**
 * ★★★ THE ONE AVATAR IMPLEMENTATION (2026-08-11, fuckery F6 item 22).
 *
 * Before this, "an avatar with a fallback" had been independently written at
 * least eight times across the app — feed byline, witnesses table, muted
 * list, header, account menu, notifications, proposals, account lists,
 * wallet, profile cover, the composer, the lite feed strip, the classic post
 * card — each with a slightly different fallback strategy: some went
 * straight to the slow `/api/avatar` proxy on every render (header,
 * menu — the exact per-request queueing bug `avatar-utils.ts` measured and
 * fixed for the feed on 2026-08-10, just not everywhere), some had NO
 * fallback at all and would show the browser's broken-image glyph on a 404
 * (proposals, account lists, wallet), one duplicated the N-4 bug the header
 * had already been fixed for — a Radix `AvatarFallback` pointed at the exact
 * same failing URL as `AvatarImage` (the composer) — and the launch wizard's
 * step 1 never attempted a real avatar at all, just a flat gradient square.
 * That sprawl is why the same product looked like three or four different
 * apps depending on which screen you were on.
 *
 * The chain implemented ONCE, here:
 *
 *   1. `getUserAvatarDirectUrl` — straight to `images.hive.blog`, on its own
 *      connection pool, ~70ms. This is the common case and costs the app
 *      nothing (see the long note on that function).
 *   2. onError, swap to `getUserAvatarUrl` (`/api/avatar`) — the ERROR path
 *      only, exactly as designed. Read `/api/avatar/route.ts` before
 *      assuming this is slow-by-default: it isn't hit unless the direct host
 *      404s or times out.
 *   3. `/api/avatar` itself degrades server-side to a generated,
 *      per-username initial-letter SVG (`initialAvatar()` in that route) —
 *      it does not error — so step 2 almost always succeeds and paints a
 *      real (if generated) avatar. The monogram this component renders
 *      underneath is therefore a genuine last resort: it only shows through
 *      if `/api/avatar` itself is unreachable, and it also masks the instant
 *      before the direct image paints, so there is never a blank frame.
 */
export function UserAvatarImg({
  username,
  apiSize = 'small',
  pixelSize,
  radiusClassName = 'rounded-full',
  className,
  alt = '',
  loading = 'lazy'
}: UserAvatarImgProps) {
  // 'direct' -> images.hive.blog, 'proxy' -> /api/avatar (which itself never
  // hard-fails — see the route), 'failed' -> even that request errored
  // (network down), so stop trying and let the monogram alone stand.
  const [stage, setStage] = useState<'direct' | 'proxy' | 'failed'>('direct');

  return (
    <span
      aria-hidden={alt === '' ? true : undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-[#f1f3f5] font-sans font-bold uppercase text-[#9ca3af]',
        radiusClassName,
        className
      )}
      style={{ width: pixelSize, height: pixelSize, fontSize: Math.max(10, Math.round(pixelSize * 0.36)) }}
      data-testid="user-avatar-img"
    >
      {(username || '?').trim().slice(0, 1)}
      {stage !== 'failed' ? (
        <img
          src={stage === 'direct' ? getUserAvatarDirectUrl(username, apiSize) : getUserAvatarUrl(username, apiSize)}
          alt={alt}
          width={pixelSize}
          height={pixelSize}
          loading={loading}
          decoding="async"
          onError={() => setStage((current) => (current === 'direct' ? 'proxy' : 'failed'))}
          className={cn('absolute inset-0 h-full w-full object-cover', radiusClassName)}
        />
      ) : null}
    </span>
  );
}

export default UserAvatarImg;
