'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { getUserAvatarDirectUrl, getUserAvatarUrl } from '@ui/lib/avatar-utils';

type AvatarApiSize = 'small' | 'medium' | 'large';

/**
 * How long the direct image gets before we stop waiting on it. See the effect
 * below.
 *
 * Exported (2026-08-16, QA Low 9) so the feed thumbnail's own blocked/
 * zero-pixel fallback (`medium-post-card.tsx`) waits the same window before
 * concluding an image request is hung rather than picking a second, unrelated
 * number for the same class of problem — a request an extension or ad
 * blocker black-holes rather than 404s.
 */
export const DIRECT_TIMEOUT_MS = 2500;

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
  /**
   * A known picture URL to try FIRST instead of the Hive image host (2026-09-05,
   * search review). A Lumen lite account has no hosted Hive avatar, so the
   * direct stage was a guaranteed miss and the proxy stage a second round trip
   * before the monogram; a caller that already holds the lite user's own
   * picture (the People tab, the typeahead) hands it in here. The proxy ->
   * monogram fallback chain below is unchanged for a `src` that fails.
   */
  src?: string;
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

/**
 * ★ DETERMINISTIC PLACEHOLDER COLOUR, HASHED FROM THE USERNAME (2026-08-16,
 * QA Low 1: same account rendered purple in one place and orange in another).
 *
 * `h = (h * 31 + charCode) % 360` is not a new formula here — it is already
 * the hash three OTHER places in this app use to turn a handle into a colour:
 * `avatarFill()` in `creator-tokens/ui/creators/creators-view.tsx`,
 * the byte-identical `avatarFill()` in
 * `creator-tokens/ui/token-page/token-market-view.tsx`, and again,
 * independently, `initialAvatar()`'s `hash` in `app/api/avatar/route.ts`
 * (the server-side SVG this component falls back to at the `proxy` stage).
 * Reusing the formula here rather than a fourth reimplementation. It is not
 * lifted into a shared export because every one of those call sites lives in
 * an `apps/blog` feature module this fix is not scoped to touch, and
 * `packages/ui` importing from `apps/blog` would also be a package-boundary
 * violation the other direction — flagged for whoever next owns a shared
 * `hashHue` util.
 *
 * Saturation/lightness are NOT copied from `avatarFill()` alongside the hash:
 * that gradient decorates a bare swatch with no text on it, so it can afford
 * a light second stop. This box always has a monogram letter drawn over it,
 * so the colour has to hold contrast against ONE fixed text colour (white,
 * matching `initialAvatar()`'s own `fill="#fff"`) at every one of the 360
 * possible hues. Checked programmatically across the full hue range at
 * `42% / 28%`: worst case is yellow/green (hue ~60), 6.06:1 white-on-fill —
 * still comfortably clear of the 4.5:1 floor the neutral fallback below this
 * was originally held to.
 */
function hashHue(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 360;
  return h;
}

export function UserAvatarImg({
  username,
  apiSize = 'small',
  pixelSize,
  radiusClassName = 'rounded-full',
  className,
  alt = '',
  loading = 'lazy',
  src
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
  /*
   * ★ THE SAME GUARD NOW COVERS THE PROXY STAGE TOO (2026-08-15).
   *
   * This read `if (stage !== 'direct') return;`, so everything above applied to
   * exactly one hop. But the proxy response is an image response like any other
   * — it can be blocked, hang, or come back non-image — and in the proxy stage
   * `onError` is the ONLY escape left, which is precisely the escape this whole
   * comment exists to explain does not fire for a blocked or zero-pixel
   * response. So the fix for the direct hop left the second hop with no way out
   * at all: a reader whose proxy request stalls keeps the broken-image glyph
   * forever, with no timer to promote them and no error to catch.
   *
   * Running in both stages makes the machine terminate: direct -> proxy ->
   * failed, at most two timers per avatar, and `failed` renders the monogram
   * deliberately rather than a broken image indefinitely.
   */
  useEffect(() => {
    if (stage === 'failed') return;
    const timer = setTimeout(() => {
      const el = imgRef.current;
      // `complete` is true for a LOADED image and for one that errored (whose
      // onError already handled it). Still false means: still waiting.
      //
      // ★ ...AND `complete` IS ALSO TRUE FOR A BLOCKED ONE, WHICH IS THE THIRD
      // CASE THIS GUARD ORIGINALLY MISSED (2026-08-15). Chrome's Opaque Response
      // Blocking (`ERR_BLOCKED_BY_ORB`) — which fires when the image host answers
      // a missing avatar with a non-image body — COMPLETES the request with zero
      // pixels and does NOT fire `onError`. So both escapes were shut: `onError`
      // never ran, and `!el.complete` was false, so the promotion never happened
      // and the reader kept the broken-image glyph indefinitely.
      //
      // Measured on `/creators/launch` with a fresh lite account, both avatars on
      // ONE page: `size=small` promoted and resolved through the proxy
      // (naturalWidth 96), while `size=medium` sat at `complete: true,
      // naturalWidth: 0` forever. Same component, same account — so the proxy
      // demonstrably works and only the trigger was missing.
      //
      // `naturalWidth === 0` on a completed image means exactly "produced no
      // pixels", so this can only ADD promotions to a path already proven good;
      // a genuinely loaded image has a non-zero width and is untouched.
      if (!el || (el.complete && el.naturalWidth > 0)) return;
      // direct -> proxy -> failed. Never backwards, so this always terminates.
      setStage((current) => (current === 'direct' ? 'proxy' : 'failed'));
    }, DIRECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  // Hashed once per render from the same trimmed value the letter below uses,
  // so an empty username and the literal '?' glyph share one deterministic hue
  // instead of the hash running on '' (still deterministic, but pointlessly a
  // special case).
  const hue = hashHue((username || '?').trim());

  return (
    <span
      aria-hidden={alt === '' ? true : undefined}
      className={cn(
        // ★ Contrast (2026-08-16, revised for the hashed background above).
        // White text is fixed rather than reading from a className because it
        // has to hold 4.5:1 against a colour that is now username-dependent —
        // see `hashHue`'s comment for the worst-hue measurement. The flat
        // `#f1f3f5`/`#6f6963` pairing this replaced (2026-08-13, O5 a11y build
        // map item 4) was tuned for a single fixed background and stops being
        // valid the moment the background stops being fixed.
        // leading-none (2026-08-13, typography audit item 1): the monogram's
        // font-size is COMPUTED (`pixelSize * 0.36`), so it was frequently odd —
        // 43px at a 120px avatar — and Tailwind Preflight's inherited unitless
        // `line-height: 1.5` turned that into a 64.5px line box. The glyph is
        // centred in a fixed square, so its line box only needs to be whole.
        // (Pass 2 additionally snaps the computed size to the type scale — see
        // `snapToScale` above — so it is now whole AND on-scale.)
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden font-sans font-bold uppercase leading-none text-white',
        radiusClassName,
        className
      )}
      style={{
        width: pixelSize,
        height: pixelSize,
        fontSize: snapToScale(pixelSize * 0.36),
        backgroundColor: `hsl(${hue} 42% 28%)`
      }}
      data-testid="user-avatar-img"
    >
      {(username || '?').trim().slice(0, 1)}
      {stage !== 'failed' ? (
        <img
          ref={imgRef}
          src={stage === 'direct' ? src || getUserAvatarDirectUrl(username, apiSize) : getUserAvatarUrl(username, apiSize)}
          /*
           * ★ ALWAYS EMPTY ALT, EVEN WHEN A CALLER PASSED ONE (2026-08-16).
           *
           * A QA pass reported the composer avatar showing four overlapping
           * characters ("SO2D") crammed into a circle sized for one, while the
           * nav avatar beside it showed a clean "S". Nothing was wrong with the
           * monogram — it is `slice(0, 1)` and cannot be four characters. What
           * was on screen was the BROKEN IMAGE'S ALT TEXT: callers pass
           * `alt={username}`, and a browser paints alt text where the picture
           * would be. Over the monogram, in a 44px box, that is the mess that
           * was reported.
           *
           * It is exactly the ORB case this component already fights: the
           * response completes with zero pixels and fires no `onError`, so the
           * element sits in the DOM as a broken image until a timeout promotes
           * it. Emptying the alt costs nothing accessibly — the monogram behind
           * it is the visual fallback, and the accessible name lives on the
           * wrapping span, which already reads `aria-hidden` when the caller
           * passed `alt=""`. `alt` is still honoured for that decision above;
           * it just never becomes visible text on top of the letter.
           */
          alt=""
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
