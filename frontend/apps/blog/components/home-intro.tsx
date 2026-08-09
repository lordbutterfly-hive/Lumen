/**
 * WHAT THIS PLACE IS — shown on the home page to a signed-out visitor only.
 *
 * ★ WHY IT EXISTS (2026-08-08, UX tester on the new-user path). A first-time
 * visitor landed straight in a post stream carrying dollar figures, beside a
 * sidebar reading Wallet / Vote Witness / Vote Proposals, with nothing anywhere on
 * the page saying what Lumen is or who it is for. The one line that does say it —
 * "A calmer place to read and write on Hive" — existed only behind the Log in
 * click, i.e. only for people who had already decided.
 *
 * Deliberately small. This is an orientation line, not a landing page: two
 * sentences, two links, and then the actual product immediately below it. It is
 * rendered only when there is no session, so it never costs a returning reader a
 * single row of their feed.
 *
 * Copy lives here rather than in the locale files for the same reason the other
 * Lumen surfaces keep theirs beside them (`lumen-login.tsx`, `PostPublishingSection`):
 * the lite vocabulary gets translated in one pass, not half-populated across nine
 * files.
 */
import { withBasePath } from '@ui/lib/path-utils';

/**
 * ★ THE PROMISE MUST MATCH WHAT THE NEXT PAGE CAN ACTUALLY DO (2026-08-09).
 *
 * This said, unconditionally, "it is free: no keys, no wallet, nothing to set
 * up" — and "Start free" landed on `/login`, which said the opposite: "Every way
 * in below needs something you already have — a Bitcoin or Ethereum wallet, or
 * the Hive Keychain extension. The key-free option, Google, is being set up."
 *
 * Both sentences were honest about their own page. Together they were a false
 * promise to the exact person this line was written for: someone who has never
 * owned a wallet, who is told the door is open and finds it needs a key.
 *
 * `/login` already derives its copy from `googleConfigured()`. The bug was that
 * this page hardcoded the happy version instead of asking the same question. So
 * it asks now — and the wording below follows the answer, which means the day
 * real Google credentials are configured this reverts to the strong promise on
 * its own, with nobody having to remember to edit it.
 *
 * Read SERVER-side from the environment rather than through the client-side
 * `googleConfigured()` this page's sibling uses. Importing that helper pulled
 * the whole GoogleSignIn module into this component and took the home page down
 * with a hooks error — an orientation line is not worth a client boundary. The
 * predicate is duplicated (deliberately, and identically) in `app/login/page.tsx`
 * for the same reason; both read the one variable that decides it.
 */
const googleReady = (() => {
  const id = process.env.REACT_APP_LITE_GOOGLE_CLIENT_ID ?? '';
  return id.length > 0 && !/placeholder/i.test(id) && id.endsWith('.apps.googleusercontent.com');
})();
const COPY = {
  tagline: 'A calmer place to read and write on Hive.',
  bodyKeyFree:
    'Lumen is a place to read and write, publishing to Hive — a public network no single company owns. Reading needs no account. Writing needs one, and it is free: no keys, no wallet, nothing to set up.',
  bodyWalletNeeded:
    'Lumen is a place to read and write, publishing to Hive — a public network no single company owns. Reading needs no account. Writing needs one, and it is free — today you sign up with a Bitcoin or Ethereum wallet, or an existing Hive account. Key-free sign-up with Google is coming.',
  start: 'Start free',
  learn: 'How it works'
};

export default function HomeIntro() {
  return (
    <div className="mx-auto max-w-[1720px] px-6 pt-[26px] md:px-11">
      <section className="rounded-[18px] border border-[#ebebeb] bg-white px-6 py-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)] sm:px-7 sm:py-6">
        <h1 className="font-serif text-[22px] font-semibold leading-[1.2] tracking-[-0.01em] text-[#161511] sm:text-[26px]">
          {COPY.tagline}
        </h1>
        <p className="mt-2 max-w-[62ch] font-sans text-[14.5px] leading-[1.55] text-[#4b5563]">{googleReady ? COPY.bodyKeyFree : COPY.bodyWalletNeeded}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <a
            href={withBasePath('/login')}
            className="rounded-[11px] bg-[#c0392b] px-[18px] py-[9px] font-sans text-sm font-semibold text-white hover:bg-[#a5301f]"
          >
            {COPY.start}
          </a>
          <a
            href={withBasePath('/help.html')}
            className="font-sans text-sm font-semibold text-[#6b7280] underline-offset-4 hover:text-[#161511] hover:underline"
          >
            {COPY.learn}
          </a>
        </div>
      </section>
    </div>
  );
}
