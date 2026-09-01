'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useLiveStudio } from '../../../live/use-live-studio';
import { buyQuote, displayPriceUsd, serviceSupplyShareProblem } from '../../../market/curve';
import { COMMISSION_BPS, MAX_CAP_CREDITS_BASE_UNITS, MIN_CAP_CREDITS_BASE_UNITS } from '../../../lib/contract-math';
import { usdPrice } from '../../../market/format';
import { writeFailureMessage } from '../../write-failure';
import { MAX_PRICE_USD, MIN_PRICE_USD, STANDARD_CAP, parseMoney, sanitizeMoneyInput } from '../../launch-money';
import { MERITUM_STUD_COUNT } from '../coin';
import { getStorageItem, removeStorageItem, setStorageItem } from '@ui/lib/storage-with-ttl';
import { offerTitleProblem } from '@/blog/features/creator-tokens/lib/vsc/op-builders';
import { REGISTER_CONFIRM_TIMEOUT_MS } from '@/blog/features/creator-tokens/lib/vsc-data-source';

/**
 * THE MERITUM LAUNCH FLOW — all of its state, and the real launch write.
 *
 * The screen is three steps and a strike; this hook is everything behind it.
 * It is a rebuild of the SURFACE of `studio/launch-wizard.tsx`, not of its
 * mechanism: the chain calls, the validation bounds, the draft persistence and
 * every gate that decides whether a signature may be asked for are the same
 * ones that flow already proved, because those are the parts that cost real
 * money when they are wrong.
 *
 * ★ WHAT THE COIN NEEDS FROM HERE, AND WHY IT IS DERIVED RATHER THAN LISTED.
 * `offersPriced` is a COUNT of offers that actually carry a price, and
 * `furthestStep` is a high-water mark. Neither is a per-step lookup table — a
 * stud lit for an offer nobody priced, or reeding that un-cuts itself when the
 * reader steps back, are both lies the UI would be telling about the reader's
 * own work.
 *
 * ★ WHERE THE LAUNCH WRITE FIRES. `launch()` is called from the coin's
 * `onCharged`, 1100ms into the hold with 2400ms of strike animation still to
 * run, so the network has the whole strike window to land. It is deliberately
 * fire-and-forget from the caller's point of view: `write` carries the result,
 * and the flow refuses to show a struck panel until that result is `ok`.
 */

/** Three offers, because the coin has three studs. Never typed twice. */
export const MERITUM_OFFER_COUNT = MERITUM_STUD_COUNT;

/** Lumen's cut, as a whole percent, off the contract's own bps constant. */
export const MERITUM_COMMISSION_PCT = Math.round(COMMISSION_BPS / 100);

export interface MeritumOffer {
  name: string;
  price: string;
}

export type MeritumLaunchStep = 1 | 2 | 3;

/**
 * `idle` before the hold, `pending` from the moment the write is sent, then
 * exactly one of `ok` / `failed`. The struck panel is gated on `ok` alone.
 */
export type MeritumWriteState = 'idle' | 'pending' | 'ok' | 'failed';

/**
 * Why the strike is refused, if it is. A string key the screen translates —
 * never a sentence, so the copy stays in the locale file.
 */
export type MeritumLaunchBlock =
  | 'signed-out'
  | 'lite'
  /** The market read is still in flight — transient, clears itself, no retry offered. */
  | 'checking-market'
  | 'unknown-market'
  | 'has-market'
  | 'no-offer'
  | 'offer-needs-name'
  /** Two priced offers carry the same name — the buyer cannot tell them apart. */
  | 'offer-duplicate-name'
  /**
   * A title carries something the CONTRACT refuses: a comma, a pipe, a control
   * byte, or more than 64 characters (core/offerings.go validOfferTitle).
   * Blocked here because the chain's refusal is INVISIBLE otherwise — the
   * broadcast succeeds, the block includes it, and the offering silently does
   * not exist. Proven live on 2026-08-19 with "Copy edit, 1k words".
   */
  | 'offer-bad-title'
  /**
   * A priced offer costs an unreachable share of the token's whole supply.
   *
   * The chain does NOT refuse this — nothing on chain relates an offering's
   * price to `kCap` — so unlike 'offer-bad-title' there is no on-chain backstop
   * behind it at all. Every token launches at `STANDARD_CAP`, which is known
   * here before anything is signed, and the opening price is fixed at supply 0,
   * so the whole check is available at exactly the moment the creator types the
   * price. See market/curve.ts's serviceSupplyShareProblem for the threshold
   * and why it is the escrow, not taste, that sets it.
   *
   * ★★ NON-BINDING ON THIS SCREEN SINCE 2026-08-30, and said out loud rather
   * than left for someone to discover. `STANDARD_CAP` is now the contract's
   * MaxCap (1e9, see launch-money.ts's ruling note), so the guard is measured
   * against a supply nobody will ever mint. Proven on the live curve: no price
   * up to MAX_PRICE_USD ($10,000) trips it at a 1e9 cap (the selftest sweeps
   * every cent). On the LAUNCH path this block can therefore never fire.
   *
   * ★★ AND THE GUARD ITSELF IS NARROWER THAN IT WAS (2026-08-30, B2). It used
   * to also refuse a service above 10% of the cap; that half was removed after
   * it was proven to fire on the owner's own legacy 30-cap Studio market for
   * every price a person types. What remains is UNFILLABLE only, `tokens >
   * cap`, a chain fact (buy.go will not mint past the cap). market/curve.ts,
   * serviceSupplyShareProblem's block, has the numbers.
   *
   * IT IS KEPT, NOT DELETED: the same function still guards the Studio
   * (creator-studio.tsx NewOfferingRow and both PriceInput sites), which reads
   * each market's REAL cap, and the three legacy markets (30 / 30 / 500) can
   * still post an unfillable price until their creators raise the cap. If an
   * owner ever re-tightens the launch cap, this block comes back to life with
   * it rather than having to be rebuilt.
   */
  | 'offer-supply-share'
  | 'price-band'
  | 'first-buy-max';

const emptyOffers = (): MeritumOffer[] => Array.from({ length: MERITUM_OFFER_COUNT }, () => ({ name: '', price: '' }));

/**
 * ★ AN OFFER NAME IS ENGRAVED ON A MARKET AND SHOWN TO BUYERS, SO IT IS UNTRUSTED
 * TEXT ON A MONEY SURFACE — even though the creator types it themselves.
 *
 * The creator is not the victim here; the BUYER is. What the buyer reads is what
 * they think they are paying for, so any character that lets the rendered string
 * differ from the stored one is a mis-selling vector, and it is written once, on
 * chain, where nobody can edit it afterwards. Before this the only checks were
 * `maxLength={120}` on the input and a `.trim()`.
 *
 * Three classes are stripped, all for the same reason — they are invisible or
 * they reorder what is around them:
 *
 *   · BIDI overrides and isolates (U+202A-202E, U+2066-2069). These reverse the
 *     visual order of neighbouring text: a name written as
 *     `1 hour <U+202E>llac<U+202C> - $5` renders as "1 hour call - $5" while
 *     storing something else. This is the Trojan-Source class of trick
 *     (CVE-2021-42574) pointed at a price list. Written here as <U+202E>
 *     rather than the character itself, because a literal one would be
 *     invisible and would reorder this very comment.
 *   · Zero-width and joiner characters (U+200B-U+200D, U+2060, U+FEFF). They
 *     make two different stored names render identically, so a buyer cannot tell
 *     two offers apart, and they let a name pass a "non-empty" check while
 *     showing nothing at all.
 *   · C0/C1 control characters, which have no business in a one-line label.
 *
 * Normalising to NFC first means the comparison below sees composed and
 * decomposed spellings of the same word as the same word. Whitespace runs
 * collapse so " a  b " and " a b" cannot be sold as two distinct offers.
 *
 * NOT stripped: ordinary non-Latin scripts, emoji, punctuation. Refusing those
 * would be a different product decision, and a wrong one.
 */
export function sanitizeOfferName(raw: string): string {
  return (
    raw
      .normalize('NFC')
      // BIDI overrides + isolates. Escapes, never literals: a literal here would
      // be invisible in this file and reorder the source you are reading.
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
      // zero-width space/non-joiner/joiner, word joiner, BOM
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      // C0 and C1 control characters
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * ★ THE ONE-MARKET RULE IS ENFORCED ON CHAIN; THIS STOPS US PAYING TO LEARN IT.
 *
 * `inFlight` next to it is a `useRef`, so it is per-COMPONENT. Two tabs open on
 * step 3 — which the draft restore makes easy, since both tabs rehydrate the
 * same saved flow — each hold their own coin and each fire `register`. The
 * contract rejects the second for one-market-per-account, so the creator pays a
 * signature and RC for a transaction that cannot succeed, and reads a launch
 * failure for a token that in fact launched.
 *
 * The claim lives in localStorage, which is what tabs share, and goes through
 * the repo's TTL wrapper rather than raw `localStorage` (see the app's own lint
 * rule). It is keyed per creator so two accounts in two profiles never collide.
 *
 * ★ 90 SECONDS, AND WHY A TTL AT ALL. A tab that is closed or crashes mid-write
 * never runs its own cleanup, and a claim with no expiry would lock the creator
 * out of their own launch permanently — a worse failure than the one being
 * prevented. 90s comfortably covers a signature prompt plus broadcast while
 * self-healing if nobody clears it.
 */
// ★ F1 (2026-08-31): DERIVED from the register poll, never hand-matched. Two
// independent 90_000s that merely had to stay ordered is how the anti-double-
// launch guard drifted: the poll consumed the whole claim, so the guard expired
// exactly when the op gave up. The claim MUST outlive the operation.
const LAUNCH_CLAIM_TTL_MS = REGISTER_CONFIRM_TIMEOUT_MS + 30_000;
const launchClaimKey = (creator: string): string => `meritum:launch-inflight:${creator}`;

/**
 * ★ IS THERE ACTUALLY ANYTHING IN THIS DRAFT?
 *
 * The flow auto-saves on every settle, so without this test the blank default
 * state is itself written to sessionStorage the moment the screen mounts — and
 * the next reload reads it back and announces "Picked up your saved draft at
 * step 1 of 3" to somebody who has never typed a character. Reproduced on a
 * brand-new account with zero interaction, and again immediately after "Start
 * over", which is the same lie arriving by a second route.
 *
 * `step` is deliberately NOT content. Clicking through to step 2 and entering
 * nothing is not a draft, and restoring it is not worth telling somebody they
 * saved something.
 */
const draftHasContent = (offers: MeritumOffer[], firstBuy: string): boolean =>
  firstBuy.trim() !== '' || offers.some((o) => o.name.trim() !== '' || o.price.trim() !== '');

interface DraftShape {
  step: number;
  /**
   * ★ THE HIGH-WATER MARK IS PART OF THE DRAFT (2026-08-15, council).
   * It used to be re-derived from `step` on restore, so a reader who reached
   * step 3 (coin fully reeded, legend legible), stepped back to 2 to edit an
   * offer, then reloaded, came back with `furthestStep = 2` and watched the
   * coin's reeding and legend visibly regress — un-cutting detail they had
   * earned. `geometry.ts` states the rule this broke: pass the FURTHEST step,
   * "or walking back to step 1 un-cuts reeding the user has already earned."
   */
  furthestStep: number;
  offers: MeritumOffer[];
  firstBuy: string;
}

/**
 * A hand-written guard rather than `JSON.parse(...) as DraftShape`. The draft
 * is attacker-adjacent (it is whatever is in this tab's sessionStorage) and the
 * repo's lint discourages the assertion for exactly this reason.
 */
function readDraft(raw: string): DraftShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record: Record<string, unknown> = { ...parsed };
  const step = typeof record.step === 'number' ? Math.min(3, Math.max(1, Math.floor(record.step))) : 1;
  // Never BELOW the step being restored: an older draft has no `furthestStep`
  // at all, and a tampered one could claim a lower mark than the step it also
  // claims. Falling back to `step` reproduces the old behaviour exactly.
  const furthestRaw =
    typeof record.furthestStep === 'number' ? Math.min(3, Math.max(1, Math.floor(record.furthestStep))) : step;
  const furthestStep = Math.max(step, furthestRaw);
  const firstBuy = typeof record.firstBuy === 'string' ? sanitizeMoneyInput(record.firstBuy) : '';
  const offers = emptyOffers();
  if (Array.isArray(record.offers)) {
    record.offers.slice(0, MERITUM_OFFER_COUNT).forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) return;
      const row: Record<string, unknown> = { ...entry };
      offers[i] = {
        name: typeof row.name === 'string' ? row.name.slice(0, 120) : '',
        price: typeof row.price === 'string' ? sanitizeMoneyInput(row.price) : ''
      };
    });
  }
  return { step, furthestStep, offers, firstBuy };
}

export interface MeritumLaunchApi {
  /** The panel on screen. */
  step: MeritumLaunchStep;
  /** The furthest step reached. This, not `step`, is what the coin is told. */
  furthestStep: MeritumLaunchStep;
  goNext: () => void;
  goBack: () => void;

  offers: MeritumOffer[];
  setOfferName: (index: number, value: string) => void;
  setOfferPrice: (index: number, value: string) => void;
  /** How many offers carry a price. 0..3. Lights the studs. */
  offersPriced: number;

  firstBuy: string;
  setFirstBuy: (value: string) => void;

  /** `@name`, or an empty string until the session answers. */
  handle: string;
  /* `cap` was published here for the terms ledger's Supply row. Both are gone
     (owner, 2026-08-30) — a market now launches at the contract's MaxCap, which
     is not a fact any screen should recite. STANDARD_CAP is still what `launch`
     puts on chain; it is just no longer part of this hook's public surface. */
  /** The curve's price at supply 0, formatted. */
  openingPrice: string;

  /**
   * The supply-cap refusal sentence for the first offending priced offer, or
   * null. Surfaced from the hook rather than recomputed in the view for the
   * same reason 'offer-bad-title' uses the validator's own sentence: the reason
   * SHOWN and the reason ENFORCED must come from one place, and rebuilding it
   * in the view would need a second copy of the parse/sanitise chain too.
   */
  offerSupplyShareMessage: string | null;

  /** Why the strike is refused, or null when it may proceed. */
  block: MeritumLaunchBlock | null;
  /** Why THIS step's Continue is refused, or null. */
  stepBlock: MeritumLaunchBlock | null;
  /** True when the market read failed, so "Try again" can be offered. */
  canRetryRead: boolean;
  retryRead: () => void;
  /** True when the chain says this creator already has a market. */
  alreadyHasMarket: boolean;
  /** True when the contract is not provisioned at all. */
  unavailable: boolean;

  write: MeritumWriteState;
  /** A formatted, redacted failure message. Only set when `write` is `failed`. */
  failure: string | null;
  /** The market opened but one or more named offers did not post. */
  offersFailed: boolean;
  /** The market opened but the requested first buy could not be filled. */
  firstBuySkipped: boolean;

  /** Fire the real launch write. Called from the coin's `onCharged`. */
  launch: () => void;
  /** Drop the failure and go back to a strikeable step 3. */
  dismissFailure: () => void;

  restoredFromDraft: boolean;
  startOver: () => void;
}

export function useMeritumLaunch(): MeritumLaunchApi {
  const { t } = useTranslation('common_blog');
  const router = useRouter();
  const pathname = usePathname();
  const studio = useLiveStudio();
  /**
   * ★ DISPLAY ONLY — NOT THE LAUNCH GATE. `studio.loggedIn` trails the server
   * by seconds while `useUserClient()` hydrates, so a genuinely signed-in
   * reader would be shown "not signed in" on step 1 of their own launch flow.
   * The server already read the session cookie to render this page. Every gate
   * that decides whether a SIGNATURE is asked for still reads `studio`, which
   * waits for the real client answer — a stale disabled control is safe,
   * broadcasting on the server's cookie-only guess is not.
   */
  const identity = useSessionIdentity();

  const [step, setStep] = useState<MeritumLaunchStep>(1);
  const [furthestStep, setFurthestStep] = useState<MeritumLaunchStep>(1);
  const [offers, setOffers] = useState<MeritumOffer[]>(emptyOffers);
  const [firstBuy, setFirstBuyState] = useState('');
  const [write, setWrite] = useState<MeritumWriteState>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [offersFailed, setOffersFailed] = useState(false);
  const [firstBuySkipped, setFirstBuySkipped] = useState(false);
  const [restored, setRestored] = useState(false);
  const [restoredFromDraft, setRestoredFromDraft] = useState(false);

  const account = studio.creator ?? identity.username;
  const handle = account ? `@${account}` : '';

  /**
   * ★ PER ACCOUNT, AND sessionStorage NOT localStorage. A single global key
   * meant a second account signing in on the same tab opened the flow on the
   * FIRST account's step with their prices pre-filled; a draft should also not
   * outlive the tab.
   */
  const draftKey = `lumen-meritum-launch-draft-${studio.creator ?? 'anon'}`;

  useEffect(() => {
    let restoredStep: MeritumLaunchStep = 1;
    let restoredFurthest: MeritumLaunchStep = 1;
    let restoredOffers = emptyOffers();
    let restoredFirstBuy = '';
    let hadDraft = false;
    try {
      const raw = window.sessionStorage.getItem(draftKey);
      const draft = raw ? readDraft(raw) : null;
      if (draft) {
        restoredStep = clampStep(draft.step);
        // The draft's own high-water mark, not the step being restored.
        restoredFurthest = clampStep(draft.furthestStep);
        restoredOffers = draft.offers;
        restoredFirstBuy = draft.firstBuy;
        // Only a draft with something IN it is one the reader "saved".
        hadDraft = draftHasContent(draft.offers, draft.firstBuy);
      }
    } catch {
      // A corrupt or unreadable draft must never block a launch. Start fresh.
    }

    /**
     * ★ M-07 — AN IN-RANGE `?step` OVERRIDES THE DRAFT'S OWN STEP (2026-08-31,
     * verified UX defect). Before this the URL was reflection-only and never
     * read back on mount (see the sync effect below and its own comment), so
     * `?step=2` on a step-3 draft rendered step 3 anyway, and `?step=99`
     * rendered whatever the draft held — the address bar described a page
     * that was not on screen.
     *
     * "In range" is `[1, the draft's own furthestStep]`: a reader may jump
     * BACK to a step they already reached, by URL, the same as pressing Back,
     * but the param cannot grant a step they never earned. `furthestStep`
     * itself is never raised by this — only which panel renders THIS load.
     *
     * Absent or non-numeric leaves the draft's own step alone (an ordinary
     * first load carries no `?step` at all). An out-of-range value is
     * silently clamped rather than rejected, and the sync effect below then
     * rewrites the URL to match what is actually on screen — it fires on the
     * very next render because `restored` flips true here, so the correction
     * is not new plumbing, it is the existing reflect-only effect doing its
     * job on the corrected value.
     */
    try {
      const rawStep = new URLSearchParams(window.location.search).get('step');
      const parsed = rawStep !== null ? Number(rawStep) : NaN;
      if (Number.isFinite(parsed)) {
        restoredStep = clampStep(Math.min(parsed, restoredFurthest));
      }
    } catch {
      // Malformed URL — fall back to the draft's own step.
    }

    setStep(restoredStep);
    setFurthestStep(restoredFurthest);
    setOffers(restoredOffers);
    setFirstBuyState(restoredFirstBuy);
    setRestoredFromDraft(hadDraft);
    setRestored(true);
  }, [draftKey]);

  /** Set by `startOver()` so the write-back effect skips exactly one pass. */
  const skipNextPersist = useRef(false);

  useEffect(() => {
    // Only write AFTER the restore pass, or the blank defaults overwrite a real
    // saved draft before it has been read back.
    if (!restored) return;
    /**
     * ★ AND NOT ON THE TICK AFTER "START OVER" (2026-08-15, launch E2E).
     *
     * `startOver()` removes the key, but it also resets `step`/`offers`/
     * `firstBuy` — which are this effect's dependencies, so it fired on the very
     * next render and wrote a BLANK draft straight back. sessionStorage was
     * never actually empty: reading it back gave
     * `{"step":1,"offers":[...empty...],"firstBuy":""}` immediately and 1.5s
     * later. The reader then reloaded and was told "Picked up your saved draft
     * at step 1 of 3" about a draft they had just discarded and never saved.
     * Reproduced twice. Nothing is lost — the draft is genuinely empty — but a
     * banner claiming the reader did something they did not is exactly the
     * dishonest UI this flow is written to avoid.
     */
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    try {
      /*
       * ★ A BLANK STATE CLEARS THE KEY RATHER THAN WRITING ITSELF INTO IT
       * (2026-08-16, QA pass). The `skipNextPersist` guard above fixed exactly
       * one route to the false banner — the tick after "Start over". This fixes
       * the general case it missed: ANY reload of an untouched flow used to
       * persist the blank default and then be told, next load, that a draft was
       * picked up. Removing instead of writing also means "Start over" stays
       * done, however many renders follow it.
       */
      if (!draftHasContent(offers, firstBuy)) {
        window.sessionStorage.removeItem(draftKey);
        return;
      }
      window.sessionStorage.setItem(draftKey, JSON.stringify({ step, furthestStep, offers, firstBuy }));
    } catch {
      // Storage full or blocked (private mode). Persistence is a convenience,
      // never a precondition for launching.
    }
  }, [restored, step, furthestStep, offers, firstBuy, draftKey]);

  /**
   * ★ THE STEP IN THE URL. `replace`, not `push`, so paging through three
   * short steps does not pile up history entries.
   *
   * ★ ALSO THE CORRECTION PATH FOR M-07 (2026-08-31). The restore effect
   * above DOES read `?step` back now, but only once, clamped against the
   * draft's `furthestStep` — an out-of-range or malformed value there is
   * silently dropped, not rewritten. This effect is what makes the address
   * bar honest afterwards: it fires the moment `restored` flips true and
   * unconditionally sets `step` to whatever this render actually settled on,
   * so `?step=99` on load becomes `?step=3` (or whatever `furthestStep`
   * allows) without a second, purpose-built rewrite.
   */
  useEffect(() => {
    if (!restored) return;
    const params = new URLSearchParams(window.location.search);
    params.set('step', String(step));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // `router` and `pathname` are stable for this route; re-running on them
    // would fight the replace it just performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, step]);

  /**
   * ★ SCROLL TO THE TOP ON EVERY STEP CHANGE (2026-08-17, verified UX defect
   * #3). Nothing in this tree called `scrollTo` at all — the URL-sync effect
   * above passes `{ scroll: false }` deliberately (see its own comment), which
   * only stops Next.js's router-driven scroll; it does not replace it with
   * one of ours. Step 3's terms list routinely runs past the fold on a normal
   * viewport, so paging forward or back left the reader wherever they had
   * scrolled to on the PREVIOUS step, now looking at a different step's copy
   * mid-way down it.
   *
   * `firstRun` skips the pass that fires the moment `restored` flips true —
   * that is page load (or a draft restore straight onto step 2 or 3), not a
   * step the reader chose to move to, and a scroll-jump on first paint would
   * be the same "the page moved under me" surprise this fixes.
   */
  const firstScrollEffect = useRef(true);
  useEffect(() => {
    if (!restored) return;
    if (firstScrollEffect.current) {
      firstScrollEffect.current = false;
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [restored, step]);

  const advance = useCallback((next: MeritumLaunchStep) => {
    setStep(next);
    setFurthestStep((high) => (next > high ? next : high));
  }, []);

  const goNext = useCallback(() => advance(clampStep(step + 1)), [advance, step]);
  const goBack = useCallback(() => setStep(clampStep(step - 1)), [step]);

  const setOfferName = useCallback((index: number, value: string) => {
    setOffers((current) => current.map((o, i) => (i === index ? { ...o, name: value } : o)));
  }, []);

  const setOfferPrice = useCallback((index: number, value: string) => {
    const clean = sanitizeMoneyInput(value);
    setOffers((current) => current.map((o, i) => (i === index ? { ...o, price: clean } : o)));
  }, []);

  const setFirstBuy = useCallback((value: string) => setFirstBuyState(sanitizeMoneyInput(value)), []);

  /** Offers that carry a usable price, in the order the reader wrote them. */
  const pricedOffers = useMemo(
    () =>
      offers
        .map((o, i) => ({ index: i, name: sanitizeOfferName(o.name), usd: parseMoney(o.price) }))
        .filter((o) => o.usd > 0),
    [offers]
  );
  const offersPriced = pricedOffers.length;

  const firstBuyUsd = parseMoney(firstBuy);
  /**
   * ★ THE OPENING PRICE IS WHAT THE FIRST BUYER PAYS, at supply 0 — the same
   * figure the Buy button will charge. It is NOT `spotPriceUsd(0)`, which the
   * contract defines as 0 for an empty market and which rendered "$0.00" here.
   */
  const openingPriceUsd = displayPriceUsd(0);

  /**
   * ★ EVERY FIELD THE CHAIN CAN REJECT IS CHECKED BEFORE THE HOLD IS ARMED,
   * not per step. A restored draft can drop a reader straight onto step 3
   * carrying a price the contract refuses, and the strike is the control that
   * asks for a signature — so it is the control that must be sure.
   */
  const priceBandBroken = pricedOffers.some((o) => o.usd < MIN_PRICE_USD || o.usd > MAX_PRICE_USD);
  const offerMissingName = pricedOffers.some((o) => o.name === '');

  /**
   * ★ TWO PRICED OFFERS MAY NOT CARRY THE SAME NAME.
   *
   * The three offers are engraved together and shown to a buyer as a list to
   * choose from. Two rows reading "1 hour call" at $5 and $50 is not a typo the
   * buyer can resolve — the label is the only thing distinguishing them, and the
   * market is written once. It also defeats the point of the sanitiser above:
   * strip the zero-width characters and two names that LOOKED different become
   * genuinely identical, so this check has to run on the sanitised value, which
   * it does (`pricedOffers` is already sanitised).
   *
   * Case-insensitive, because "1 Hour Call" and "1 hour call" are the same
   * offer to every reader. Empty names are excluded — that is `offer-needs-name`
   * above, and reporting one fault as two is how a form makes a reader chase
   * their tail.
   */
  const offerNamesDuplicated = (() => {
    const seen = new Set<string>();
    for (const o of pricedOffers) {
      if (o.name === '') continue;
      const key = o.name.toLocaleLowerCase();
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  })();
  /**
   * ★ A PRICE THE MARKET CANNOT CARRY (2026-08-27). Checked against
   * `STANDARD_CAP` and the supply-0 opening price — both fixed and both known
   * on this screen — so a creator learns it while typing rather than posting a
   * shop whose services no buyer can afford a share of.
   *
   * ★ SINCE 2026-08-30 THIS IS EFFECTIVELY ALWAYS `null` — `STANDARD_CAP` is
   * MaxCap. Proven monotone before the change shipped: raising the cap can only
   * SHRINK `tokens / cap`, so no price this used to allow is newly refused (swept
   * $0.01–$2,000 at the supply-0 opening price, zero new refusals). It is a
   * silent check, never a false one. Full reasoning on the 'offer-supply-share'
   * block above.
   */
  const offerSupplyShareProblem =
    pricedOffers.map((o) => serviceSupplyShareProblem(o.usd, openingPriceUsd, STANDARD_CAP)).find((m) => m != null) ??
    null;
  const capBroken = STANDARD_CAP < MIN_CAP_CREDITS_BASE_UNITS || STANDARD_CAP > MAX_CAP_CREDITS_BASE_UNITS;
  const firstBuyTooBig = firstBuyUsd > MAX_PRICE_USD;

  // A title the contract will refuse. Only PRICED offers matter: an empty row is
  // not submitted, and `offer-needs-name` already covers a priced row with none.
  const offerTitleRejected = offers.some(
    (o) => o.name.trim() !== '' && offerTitleProblem(o.name) !== null
  );

  const offerBlock: MeritumLaunchBlock | null = priceBandBroken
    ? 'price-band'
    : offerMissingName
      ? 'offer-needs-name'
      : offerTitleRejected
        ? 'offer-bad-title'
        : offerNamesDuplicated
          ? 'offer-duplicate-name'
          : offerSupplyShareProblem !== null
            ? 'offer-supply-share'
            : offersPriced === 0
              ? 'no-offer'
              : null;

  /**
   * A failed market read is NOT "no market". `register` enforces one market per
   * account on chain, so launching when the creator already has one costs a
   * real signed transaction to buy a guaranteed on-chain failure — and a read
   * we could not complete is exactly the case where we do not know.
   */
  const canRetryRead = studio.status === 'error';
  // ★ A CLOSED market can be relaunched (M-4, 2026-08-31): registerCheck
  // (core/market.go) admits stored state "" or CLOSED, and Phase() returns
  // CLOSED only when CloseIfDrained wrote it (closed AND drained), so this
  // matches the contract exactly. Retire/Billing promise "coming back means a
  // new token"; before this the client made that journey impossible.
  const alreadyHasMarket = studio.market != null && studio.market.phase !== 'CLOSED';

  /**
   * ★ "STILL READING" IS ALSO "WE DO NOT KNOW" (added 2026-08-15).
   *
   * The comment above is right and the gate under it was incomplete: it caught
   * `status === 'error'` but not `status === 'loading'`, and `LiveMarketStatus`
   * has both (`use-live-token-market.ts:30` — 'unavailable' | 'loading' |
   * 'error' | 'missing' | ...). While the read is in flight `studio.market` is
   * undefined, so `alreadyHasMarket` is false, so NOTHING blocked the strike.
   *
   * That is the ordinary first-paint state of this screen, not an edge case: a
   * creator who already owns a market can arrive, hold the coin before the read
   * lands, and spend a real signed transaction on a `register` the contract is
   * guaranteed to reject for one-market-per-account. Exactly the loss the
   * 'error' branch was written to prevent, through the door next to it.
   *
   * It is a SEPARATE reason from 'unknown-market' because the honest copy
   * differs: 'error' means "we tried and failed, here is a retry", this means
   * "hold on, we are still looking" and clears itself in a moment. Telling a
   * reader the chain read failed while it is merely in flight is a lie that
   * invites a pointless retry.
   */
  const marketStillUnknown = studio.status === 'loading';

  const block: MeritumLaunchBlock | null = !studio.loggedIn
    ? 'signed-out'
    : studio.isLite
      ? 'lite'
      : marketStillUnknown
        ? 'checking-market'
        : canRetryRead
          ? 'unknown-market'
          : alreadyHasMarket
            ? 'has-market'
            : (offerBlock ??
              (firstBuyTooBig ? 'first-buy-max' : capBroken ? 'price-band' : null));

  const stepBlock: MeritumLaunchBlock | null = step === 2 ? offerBlock : null;

  /**
   * The write is started from a timer callback inside the coin, so it must not
   * depend on a value captured at the render the hold began in.
   */
  const launchArgs = useRef({ pricedOffers, firstBuyUsd, blocked: block !== null });
  launchArgs.current = { pricedOffers, firstBuyUsd, blocked: block !== null };

  const inFlight = useRef(false);

  const launch = useCallback(() => {
    if (inFlight.current) return;
    const { pricedOffers: services, firstBuyUsd: budget, blocked } = launchArgs.current;
    if (blocked || services.length === 0) return;

    // Cross-tab claim — see `launchClaimKey`. Taken BEFORE `pending` so a second
    // tab cannot slip between the check and the write.
    const claimKey = account ? launchClaimKey(account) : null;
    if (claimKey && getStorageItem<number>(claimKey) !== null) {
      setWrite('failed');
      setFailure(t('meritum_launch.error_launch_in_another_tab'));
      return;
    }
    if (claimKey) setStorageItem(claimKey, Date.now(), LAUNCH_CLAIM_TTL_MS);
    const releaseClaim = () => {
      if (claimKey) removeStorageItem(claimKey);
    };

    inFlight.current = true;
    setWrite('pending');
    setFailure(null);
    setOffersFailed(false);
    setFirstBuySkipped(false);

    /**
     * The optional anti-snipe first buy is a DOLLAR budget here but a whole
     * TOKEN count on chain. Converted with the same curve math the contract
     * runs; a budget too small for one whole token buys nothing, and the
     * creator is told rather than silently launched without it.
     */
    const firstBuyTokens = budget > 0 ? buyQuote(budget, { supply: 0, cap: STANDARD_CAP, position: null }).tokens : 0;
    const skipped = budget > 0 && firstBuyTokens <= 0;

    const run = async () => {
      /**
       * ★ TWO CALLS, TWO OUTCOMES, DELIBERATELY NOT ONE TRY BLOCK.
       *
       * `register` is the irreversible part, so it goes first and alone. If a
       * named offering fails AFTER it, the creator has a live market with one
       * working price and can post the rest from Creator Studio — reporting
       * that as "your token wasn't launched" would be false, and false in the
       * direction that makes someone launch a second time.
       */
      try {
        await studio.register({
          faceHbd: services[0].usd,
          capTokens: STANDARD_CAP,
          firstBuyTokens: skipped ? 0 : firstBuyTokens
        });
      } catch (e) {
        inFlight.current = false;
        // ★ F1 (2026-08-31): register carries the first-buy HBD on the SAME
        // broadcast, so on REGISTER_UNCONFIRMED ("Hive accepted it, Magi hasn't
        // recorded the market yet, it may still land") releasing the claim would
        // let a second attempt DOUBLE-CHARGE the first buy. Keep AND extend the
        // claim there; release only on a genuine failure where nothing landed.
        const mayStillLand = e instanceof Error && e.message.includes('REGISTER_UNCONFIRMED');
        if (mayStillLand) {
          if (claimKey) setStorageItem(claimKey, Date.now(), LAUNCH_CLAIM_TTL_MS);
        } else {
          releaseClaim();
        }
        setWrite('failed');
        // Routed through the shared formatter so the CREATOR_TOKENS_* machine
        // code is stripped and any key-shaped text is redacted before it is
        // painted into the DOM.
        setFailure(writeFailureMessage(e, 'Launch did not go through.'));
        return;
      }

      // Every offer is a named offering, so each shows the name the creator
      // typed. The on-chain `face` carries a price but NO title, so offer #0
      // posted as the face alone was unnamed — and because named offerings
      // exist it was never rendered (faceAsService is the zero-offerings case),
      // making the creator's flagship promise invisible and unbuyable. `faceHbd`
      // (set at register) keeps offer #0's price as the legacy "Ask a question"
      // fallback. Sequential, not parallel: they share one nonce and one signer,
      // and being asked to sign several prompts at once is worse than in a row.
      let postedAll = true;
      for (const service of services) {
        try {
          await studio.createOffering({ title: service.name, priceUsd: service.usd });
        } catch {
          postedAll = false;
        }
      }

      // The token is launched past this point, so the saved draft is spent —
      // leaving it would re-open a stale flow over a live market.
      try {
        window.sessionStorage.removeItem(draftKey);
      } catch {
        // Never let a storage failure swallow a successful launch.
      }

      inFlight.current = false;
      // The market now exists, so `has-market` takes over as the real guard and
      // the claim has done its job. Released rather than left to expire so a
      // creator who launches and immediately opens Studio is not told, for the
      // next 90 seconds, that a launch is running in another tab.
      releaseClaim();
      setOffersFailed(!postedAll);
      setFirstBuySkipped(skipped);
      setWrite('ok');
    };

    void run();
  }, [studio, draftKey, account, t]);

  const dismissFailure = useCallback(() => {
    setWrite('idle');
    setFailure(null);
  }, []);

  const startOver = useCallback(() => {
    // Set BEFORE the resets below: those resets are what re-fire the persistence
    // effect, and it must find this already true.
    skipNextPersist.current = true;
    try {
      window.sessionStorage.removeItem(draftKey);
    } catch {
      // Nothing to undo if storage was never reachable.
    }
    setRestoredFromDraft(false);
    setStep(1);
    setFurthestStep(1);
    setOffers(emptyOffers());
    setFirstBuyState('');
    setWrite('idle');
    setFailure(null);
    setOffersFailed(false);
    setFirstBuySkipped(false);
  }, [draftKey]);

  return {
    step,
    furthestStep,
    goNext,
    goBack,
    offers,
    setOfferName,
    setOfferPrice,
    offersPriced,
    firstBuy,
    setFirstBuy,
    handle,
    /* `cap` was returned here for the Supply row of the terms ledger only. That
       row is gone (owner, 2026-08-30 — a cap of 1e9 is not a fact worth telling
       anyone), and with its single reader gone the field would be dead surface.
       STANDARD_CAP is still what `launch` sends on chain, one screen below. */
    openingPrice: usdPrice(openingPriceUsd),
    offerSupplyShareMessage: offerSupplyShareProblem,
    block,
    stepBlock,
    canRetryRead,
    retryRead: studio.retry,
    alreadyHasMarket,
    unavailable: studio.status === 'unavailable',
    write,
    failure,
    offersFailed,
    firstBuySkipped,
    launch,
    dismissFailure,
    restoredFromDraft,
    startOver
  };
}

function clampStep(n: number): MeritumLaunchStep {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}
