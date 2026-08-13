'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { getUserAvatarDirectUrl, getUserAvatarUrl } from '@ui/lib/avatar-utils';

type AvatarApiSize = 'small' | 'medium' | 'large';

/** How long the direct image gets before we stop waiting on it. See the effect below. */
const DIRECT_TIMEOUT_MS = 2500;

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
/**
 * The type scale from `packages/tailwindcss/tailwind.config.js`, as numbers.
 *
 * This component is the one place in the app that computes a font-size at
 * runtime instead of naming a class, so it is also the one place the scale
 * cannot be enforced by Tailwind. Before this, `Math.round(pixelSize * 0.36)`
 * put sizes the scale does not contain into the rendered app — measured on a
 * signed-in census of 15 routes: 10px (small bylines) and 43px (the 120px
 * profile avatar), i.e. 2 of the app's 21 distinct font sizes existed solely
 * because of this expression.
 */
const TYPE_SCALE = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 30, 34, 44, 60];

/**
 * Nearest step on the type scale. Keeps the monogram proportional to its box
 * (it still grows with the avatar) while landing on a size the rest of the
 * product actually uses. Safe to snap: the glyph is flex-centred in a fixed
 * square with `leading-none` and `overflow-hidden`, so its size cannot move
 * anything around it.
 */
function snapToScale(px: number): number {
  return TYPE_SCALE.reduce((best, step) => (Math.abs(step - px) < Math.abs(best - px) ? step : best));
}

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
  const imgRef = useRef<HTMLImageElement>(null);

  /**
   * ★★★ A BLOCKED REQUEST NEVER FIRES `onError` (2026-08-13, reported: "follow
   * notifications are missing profile pics in the bell").
   *
   * The direct-first strategy documented above only falls back to `/api/avatar`
   * from the img's `onError`. That covers a 404 or a dead host — but a content
   * blocker, a privacy extension or a DNS black-hole typically makes the request
   * HANG rather than fail, so `onError` never fires, the fallback never runs, and
   * the reader is left looking at the bare monogram letter forever. That is
   * indistinguishable from "the avatars are missing", and it is invisible in a
   * clean browser, which is why this could not be reproduced here.
   *
   * So the timeout is the fallback for the case `onError` cannot see. If the
   * direct image has not completed within `DIRECT_TIMEOUT_MS`, promote to our own
   * proxy — same-origin, so no blocker list has an entry for it.
   *
   * Only ever runs in the 'direct' stage, and clears on unmount, so a feed of 30
   * avatars costs 30 timers for at most 2.5s and none after they load.
   */
  useEffect(() => {
    if (stage !== 'direct') return;
    const timer = setTimeout(() => {
      const el = imgRef.current;
      // `complete` is true for a LOADED image and for one that errored (whose
      // onError already handled it). Still false means: still waiting.
      if (el && !el.complete) setStage('proxy');
    }, DIRECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  return (
    <span
      aria-hidden={alt === '' ? true : undefined}
      className={cn(
        // ★ Contrast fix (2026-08-13, O5 a11y build map item 4). `#9ca3af` on
        // this box's own `#f1f3f5` background measured 2.28:1, well under the
        // 4.5:1 floor (the fallback initial is never large/bold enough for
        // the large-text exemption — max 14px at the biggest call site). This
        // is the "grey-ground" replacement (`#6f6963`, 4.87:1 on `#f1f3f5`),
        // not the plain-white one, because the background is baked into this
        // same className.
        // leading-none (2026-08-13, typography audit item 1): the monogram's
        // font-size is COMPUTED (`pixelSize * 0.36`), so it was frequently odd —
        // 43px at a 120px avatar — and Tailwind Preflight's inherited unitless
        // `line-height: 1.5` turned that into a 64.5px line box. The glyph is
        // centred in a fixed square, so its line box only needs to be whole.
        // (Pass 2 additionally snaps the computed size to the type scale — see
        // `snapToScale` above — so it is now whole AND on-scale.)
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-[#f1f3f5] font-sans font-bold uppercase leading-none text-[#6f6963]',
        radiusClassName,
        className
      )}
      style={{ width: pixelSize, height: pixelSize, fontSize: snapToScale(pixelSize * 0.36) }}
      data-testid="user-avatar-img"
    >
      {(username || '?').trim().slice(0, 1)}
      {stage !== 'failed' ? (
        <img
          ref={imgRef}
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
