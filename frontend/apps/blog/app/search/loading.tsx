import { LumenLoader } from '@hive/ui';

/**
 * ★ NO SKELETON FOR A SEARCH BOX THAT IS NOT ON THIS PAGE (2026-08-10). This
 * used to open with a full-width rounded bar, which was the placeholder for
 * /search's own search field — the second, duplicate field that was removed.
 * Leaving it here would flash a box that never arrives. The header's field is
 * outside this boundary and is already on screen.
 *
 * The result list below it went the same way for the same reason (2026-08-12): a
 * ghost of five post cards in a layout the redesign no longer uses.
 */
export default function Loading() {
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div className="hidden md:block" />
      <main className="flex min-w-0 flex-col gap-6">
        <LumenLoader size="lg" />
      </main>
    </div>
  );
}
