import { LumenLoader } from '@hive/ui';

/**
 * ★ Was `PostDetailSkeleton` — a full ghost article: a title bar, an author row, ten
 * grey paragraph lines and three ghost comments. It could not have matched, because
 * it cannot know how long the post is; a 200-word note and a 4,000-word essay got
 * the same nine-line body, so one shifted up and the other shifted down the moment
 * the real thing arrived. See `packages/tailwindcss/globals.css`.
 */
export default function Loading() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-12">
      <div className="col-span-2 hidden md:block" />
      <div className="w-full min-w-0 py-8 md:col-span-8 md:mx-auto md:flex md:flex-col">
        <LumenLoader size="lg" className="min-h-[60vh]" />
      </div>
      <div className="col-span-2" />
    </div>
  );
}
