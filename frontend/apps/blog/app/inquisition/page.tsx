import type { Metadata } from 'next';
import LeftRail from '@/blog/features/layouts/left-rail';
import InquisitionBoard from '@/blog/features/inquisition/inquisition-board';

/**
 * /inquisition
 *
 * ★ THE PAGE TITLE IS THE PLAIN NAME. The spec puts "Nobody expects the Hive
 * Inquisition" here; the owner cut it (2026-09-19: "remove 'nobody expects the Hive
 * inquisition'. thats a bit too much in header"). The costume is the mode, not the
 * chrome.
 */
export const metadata: Metadata = {
  title: 'Inquisition mode',
  description: 'Downvotes, value removed, mutes, rewards against stake and crossposting, read off public chain data.'
};

export default function InquisitionPage() {
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-[var(--rail-sticky-top)] hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        <InquisitionBoard />
      </main>
    </div>
  );
}
