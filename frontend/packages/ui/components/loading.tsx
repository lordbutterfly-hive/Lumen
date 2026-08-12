'use client';

import clsx from 'clsx';
import { LumenLoader } from './lumen-loader';

/**
 * ★ THE OTHER LOADING COMPONENT — found on the twin-miss sweep (2026-08-12).
 *
 * Replacing the skeletons would have left this behind, and it is not a small
 * surface: it is rendered on the POST page, the followers and followed lists, the
 * community roles page and a hover card in blog, plus roughly twenty places across
 * wallet. It drew `Icons.spinner` at 48px in `text-red-600`, spinning — so after the
 * skeleton work the app would have had a warm light bloom on one route and a hard
 * red spinner on the next, which is the specific failure this whole pass exists to
 * remove.
 *
 * ★ FIXED AT THE SOURCE, NOT CALL BY CALL. Every one of those ~27 sites now gets the
 * new mark without being touched, exactly as the `Skeleton` primitive does. A visual
 * language applied file by file is one that gets applied to the feed and forgotten on
 * the profile tabs — which is precisely how this component survived the redesign in
 * the first place.
 *
 * ★ SIZE IS A LIKE-FOR-LIKE SWAP, DELIBERATELY. `sm` is a 44px mark against the old
 * spinner's 48px, and `min-h-0` cancels `LumenLoader`'s own reserved height so this
 * occupies the same box it always did. Callers pass their own layout through
 * `className` (several rely on `h-full`/`pt-*`), and changing the footprint here
 * would have quietly re-laid-out two dozen screens in two apps.
 */
const Loading = ({ loading, className }: { loading: boolean; className?: string }) => {
  if (!loading) return null;

  return (
    <div className={clsx('flex h-full w-full items-center justify-center pt-16', className)}>
      <LumenLoader size="sm" className="min-h-0" />
    </div>
  );
};

export default Loading;
