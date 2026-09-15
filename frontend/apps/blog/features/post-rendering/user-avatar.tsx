import { cn } from '@ui/lib/utils';
import { UserAvatarImg } from '@ui/components';

interface Props {
  username: string;
  size: string;
  className?: string;
  /** The lite author's own stored picture, when the byline has one (see LiteOverlay.avatarUrl). */
  src?: string;
  /** This name is a Lumen identity: never ask the Hive image host for it by name. */
  lite?: boolean;
}

/**
 * ★ CONVERGED ON `UserAvatarImg` (2026-09-15). This was a bare CSS
 * `background-image` pointed at our own `/api/avatar` proxy and nothing else,
 * the exact shape the feed card already left behind (post-list-item.tsx, F6
 * item 22). Two consequences, both measured on production 2026-09-15:
 *
 *   1. The proxy is the SLOW path (Node + wax name validation + an upstream
 *      fetch with a 3 s budget), and when that budget runs out it serves the
 *      generated initial-letter SVG. `/var/log/lumen.log` carried 112 such
 *      "avatar fetch timed out or failed, serving fallback" lines, one of them
 *      for magi.network.
 *   2. That SVG went out with the same one-day cache header as a real picture,
 *      so ONE slow upstream second turned into a day of a purple "M" in the
 *      post byline while the feed card (which asks the image host directly,
 *      a different URL) kept showing the real avatar. "It's ok in other
 *      places" was literally true: only this surface used the proxy alone.
 *
 * `UserAvatarImg` asks the image host directly first (one hop, browser-cached,
 * on the host's own connection pool), promotes to the guarded proxy on error or
 * a blocked/empty response, and keeps the monogram beneath both, so a bad second
 * costs one retry, not a day. `src`/`lite` keep the 2026-09-11 squatting guard:
 * a Lumen identity skips the name-keyed host entirely.
 */
function UserAvatar({ username, size, className, src, lite = false }: Props) {
  const apiSize = size === 'xLarge' ? 'large' : size === 'normal' || size === 'small' ? 'small' : 'medium';
  const pixelSize = size === 'xLarge' ? 96 : size === 'large' ? 64 : 48;

  return (
    <UserAvatarImg
      username={username}
      apiSize={apiSize}
      pixelSize={pixelSize}
      src={src}
      lite={lite}
      className={cn('mr-2', className)}
    />
  );
}

export default UserAvatar;
