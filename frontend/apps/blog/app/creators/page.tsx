import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import CreatorsView from '@/blog/features/creator-tokens/ui/creators/creators-view';
import MeritumIntro from '@/blog/features/creator-tokens/ui/meritum/intro/meritum-intro';
import {
  MERITUM_HAS_TOKEN_COOKIE,
  MERITUM_INTRO_OPEN_COOKIE,
  MERITUM_INTRO_OPEN_VALUE
} from '@/blog/features/creator-tokens/ui/meritum/intro/intro-state';
import { readCreatorMarketSummary } from '@/blog/lib/meritum/server-market';
import { getServerSessionUser } from '@/blog/lib/server-session';

/**
 * Longest the page waits on the chain to know whether the reader has a token.
 * Past it the page uses what this browser remembered for the account (else the
 * card renders open and the client's own read folds it); a slow Magi node must
 * never hold up the page (the summary's own timeout is 5 s).
 */
const HAS_TOKEN_DEADLINE_MS = 1_000;

/** The chain's answer: true / false, or null when it gave none (deadline, shed read, node down). */
async function hasMarketWithinDeadline(username: string): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), HAS_TOKEN_DEADLINE_MS);
  });
  try {
    return await Promise.race([readCreatorMarketSummary(username).then((s) => (s === null ? null : s.registered)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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
    'Launch a Meritum token in seconds. Browse creators, hold the tokens you believe in, and decide for yourself how to use them.'
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
export default async function CreatorsPage() {
  const session = await getServerSessionUser();
  const jar = cookies();
  const initialOpen = jar.get(MERITUM_INTRO_OPEN_COOKIE)?.value === MERITUM_INTRO_OPEN_VALUE;
  // The chain answers for a Hive account. A lite account's market is keyed by
  // its wallet, which the session does not carry, and a slow read gives no
  // answer; both fall back to what this browser last saw for THIS account
  // (intro-state.ts). A definite chain answer always wins.
  const remembered = session.isLoggedIn && jar.get(MERITUM_HAS_TOKEN_COOKIE)?.value === session.username;
  const chainAnswer =
    session.isLoggedIn && session.accountTier === 'full' ? await hasMarketWithinDeadline(session.username) : null;
  const initialHasToken = session.isLoggedIn && (chainAnswer ?? remembered);
  return (
    <CreatorsView
      viewerHasToken={initialHasToken}
      intro={<MeritumIntro initialHasToken={initialHasToken} initialOpen={initialOpen} />}
    />
  );
}
