import type { Metadata } from 'next';
import CreatorsView from '@/blog/features/creator-tokens/ui/creators/creators-view';
import MeritumIntro from '@/blog/features/creator-tokens/ui/meritum/intro/meritum-intro';

export const metadata: Metadata = {
  // The page now LEADS with the Meritum intro, so the title names the product
  // rather than only the directory below it. Kept short: the browser tab and the
  // share card both truncate, and "Meritum" is the word that has to survive.
  title: 'Meritum',
  // ★ THE RANKING CLAUSE NAMED AN ORDER THAT RANKS NOTHING (2026-08-28,
  // false-text audit F5). This said "Browse creators ranked by how reliably they
  // deliver". `features/creator-tokens/market/discovery-ranking.ts` recorded on
  // 2026-08-27 that every delivery column is null for every creator on the live
  // index (answered_count 0, missed_count 0, completion_pct null), that the
  // default "Most reliable" tab "ranks nothing", and it HID the ordering tabs and
  // the Answers filter for that reason. The controls went; this sentence, and the
  // masthead line it mirrors, did not. A static `Metadata` export cannot be gated
  // on `rankingAvailable` the way the masthead can, so the clause is simply gone
  // rather than made conditional.
  description:
    'Launch a Meritum token in seconds. Browse creators, hold a creator’s token, and spend it on their work.'
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
