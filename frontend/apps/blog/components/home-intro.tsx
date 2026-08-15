/**
 * WHAT THIS PLACE IS — shown on the home page to a signed-out visitor only.
 *
 * ★ WHY IT EXISTS (2026-08-08, UX tester on the new-user path). A first-time
 * visitor landed straight in a post stream carrying dollar figures, beside a
 * sidebar reading Wallet / Vote Witness / Vote Proposals, with nothing anywhere on
 * the page saying what Lumen is or who it is for.
 *
 * ★★ PORTED ONTO THE TOPIC-HEADER SHELL (2026-08-10, fuckery list E1-E7). It was a
 * full-bleed 1519x237 white card at left:0, spanning underneath the sidebar, in a
 * different radius (18 vs 20), a different border (#ebebeb vs #eee2dc) and a
 * different h1 size (26 vs 34) from the topic header doing the same job one route
 * away. Two heroes, two vocabularies. It now renders INSIDE the feed column, above
 * the composer, so its edges align with the composer and the post cards, and it
 * inherits the column width rather than hardcoding one.
 *
 * ★★★ 147px IS A HARD BUDGET (E2) and it is what forces the shape of the copy.
 * Eyebrow + 34px h1 + ONE meta row is all that fits, so the paragraph is one line
 * and the two calls to action sit inline on the meta row rather than in a button
 * row of their own. Anything added here costs height that the topic header does
 * not spend, and the two stop matching. Measured: 28 pad + 19 eyebrow + 37 h1 + 14
 * gap + 29 row + 20 pad = 147.
 *
 * Copy lives here rather than in the locale files for the same reason the other
 * Lumen surfaces keep theirs beside them (`lumen-login.tsx`, `PostPublishingSection`):
 * the lite vocabulary gets translated in one pass, not half-populated across nine
 * files.
 */
import { withBasePath } from '@ui/lib/path-utils';
import PageMasthead from '@/blog/features/layouts/page-masthead';

/**
 * ★ THE PROMISE MUST MATCH WHAT THE NEXT PAGE CAN ACTUALLY DO (2026-08-09).
 *
 * This said, unconditionally, "it is free: no keys, no wallet, nothing to set
 * up" — and "Start free" landed on `/login`, which said the opposite. Both
 * sentences were honest about their own page; together they were a false promise
 * to the exact person this line was written for. So the CALL TO ACTION now follows
 * the same flag the login page follows, and says what the reader will actually
 * need when they get there.
 *
 * Read SERVER-side from the environment rather than through the client-side
 * `googleConfigured()`: importing that helper pulls the whole GoogleSignIn module
 * into this component and took the home page down with a hooks error. The
 * predicate is duplicated (deliberately, and identically) in `app/login/page.tsx`.
 */
const googleReady = (() => {
  const id = process.env.REACT_APP_LITE_GOOGLE_CLIENT_ID ?? '';
  return id.length > 0 && !/placeholder/i.test(id) && id.endsWith('.apps.googleusercontent.com');
})();

/**
 * ★ VOICE (fuckery list A3, tightened by the owner 2026-08-10). No em-dashes or
 * en-dashes, heading under six words, one concrete claim rather than three.
 *
 * Two hard rules on top of that, both owner calls and both worth keeping:
 *
 *  1. **We pitch ourselves, we do not swing at anyone else.** An earlier draft led
 *     with what other frontends get wrong. Punching down from your own front door
 *     tells a stranger who you resent, not what you are.
 *  2. **The masthead does not say Hive.** A first-time reader does not arrive
 *     knowing what that is, and the word makes the promise sound like plumbing.
 *     Where the network genuinely has to be named (the Keychain row, the upgrade
 *     path) it still is; this is a masthead, not a spec sheet.
 *
 * What is left is the one thing that is actually true here: reading is the signal.
 * Stated positively, it needs no comparison to land.
 *
 * The claim is also kept SHORT on purpose. It shares its row with both calls to
 * action, and the row has to end before the watermark glyph begins at roughly x=760
 * in an 846px column, or the text runs under the mark.
 */
const COPY = {
  eyebrow: 'Lumen',
  /**
   * ★★★ THE HEADING SELLS AN OUTCOME. IT IS NOT A PUN ABOUT THE MECHANISM.
   *
   * Two drafts died here and both died the same way. "Your readers decide what
   * rises" and "Where reading is the vote" are both descriptions of how the ranker
   * works, dressed up as slogans. A stranger does not arrive caring how the ranker
   * works. They arrive asking what they get.
   *
   * The standard test for a hero line is: could three competitors put the same
   * sentence on their own page? "A calmer place to read and write" fails it, every
   * platform claims calm. "Writing that finds its readers" fails it too. What no
   * ordinary platform can say is that you do not need an audience first, because
   * everywhere else distribution is a function of followers.
   *
   * So the heading is the outcome (you get read without having built a following)
   * and the line under it is the mechanism that makes the outcome credible (the feed
   * is built from reading, so post number one and post number one thousand start in
   * the same place). Outcome first, mechanism second, no wordplay in either.
   */
  heading: 'Get found without a following.',
  // Kept short on purpose: this line shares its row with both calls to action, and
  // the row has to end before the watermark begins at roughly x=760 in an 846px
  // column. The first draft of it ran under the mark.
  claim: 'The feed is built from reading, not from your follower count.',
  startFree: 'Start free',
  startWallet: 'Start with a wallet',
  learn: 'How it works'
};

export default function HomeIntro() {
  /*
   * ★ h2, NOT h1 (2026-08-15, regression sweep). `home-shell.tsx` renders an
   * sr-only `<h1>Home feed</h1>` unconditionally, and this intro only renders
   * when signed OUT — so leaving the masthead at its default h1 gave the
   * signed-out home page TWO h1s while the signed-in one had one. Stepping this
   * down keeps "Home feed" as the single h1 in BOTH auth states, so the document
   * outline does not change shape when a reader logs in. Same mechanism already
   * used by creators-view.tsx:209.
   */
  return (
    <PageMasthead eyebrow={COPY.eyebrow} title={COPY.heading} mark="pilcrow" headingLevel="h2">
      <span>{COPY.claim}</span>
      <a
        href={withBasePath('/login')}
        className="rounded-[11px] bg-surface-brand-12 px-3.5 py-1.5 font-sans text-[13px] leading-[20px] font-semibold text-ink-27 hover:bg-surface-brand-16"
      >
        {googleReady ? COPY.startFree : COPY.startWallet}
      </a>
      <a
        href={withBasePath('/help.html')}
        className="font-sans text-[13px] leading-[20px] font-semibold text-ink-10 underline-offset-4 hover:text-ink-2 hover:underline"
      >
        {COPY.learn}
      </a>
    </PageMasthead>
  );
}
