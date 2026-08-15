import type { Metadata } from 'next';
import CreatorsView from '@/blog/features/creator-tokens/ui/creators/creators-view';
import MeritumIntro from '@/blog/features/creator-tokens/ui/meritum/intro/meritum-intro';

export const metadata: Metadata = {
  // The page now LEADS with the Meritum intro, so the title names the product
  // rather than only the directory below it. Kept short: the browser tab and the
  // share card both truncate, and "Meritum" is the word that has to survive.
  title: 'Meritum',
  description:
    'Launch a Meritum token in seconds. Browse creators ranked by how reliably they deliver · hold a creator’s token and spend it on their work.'
};

/**
 * ★ THE MERITUM INTRO IS PASSED IN, NOT WRAPPED AROUND (2026-08-15, screen 1).
 *
 * `CreatorsView` owns `TokenShell` — the 200 / 1fr / 312 grid with the left nav
 * and the right rail — so rendering `<><MeritumIntro /><CreatorsView /></>`
 * here would put the intro OUTSIDE that grid: full-bleed, not aligned to the
 * nav, and above a page that then starts its own shell. Handing it in as a
 * child lets the view drop it into the centre column, where it lines up with
 * everything else on the page.
 *
 * NOTHING WAS REMOVED. The discovery list, its sorts, the "New here" strip and
 * the right rail all still render, unchanged, directly under the intro — the
 * intro is the answer to "what is this?", the list is the answer to "who is
 * here?", and the page needs both.
 */
export default function CreatorsPage() {
  return <CreatorsView intro={<MeritumIntro />} />;
}
