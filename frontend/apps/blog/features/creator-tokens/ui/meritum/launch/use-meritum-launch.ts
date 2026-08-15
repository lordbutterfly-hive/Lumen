'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useLiveStudio } from '../../../live/use-live-studio';
import { buyQuote, displayPriceUsd } from '../../../market/curve';
import { COMMISSION_BPS, MAX_CAP_CREDITS_BASE_UNITS, MIN_CAP_CREDITS_BASE_UNITS } from '../../../lib/contract-math';
import { usdPrice } from '../../../market/format';
import { writeFailureMessage } from '../../write-failure';
import { MAX_PRICE_USD, MIN_PRICE_USD, STANDARD_CAP, parseMoney, sanitizeMoneyInput } from '../../launch-money';
import { MERITUM_STUD_COUNT } from '../coin';

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
  | 'unknown-market'
  | 'has-market'
  | 'no-offer'
  | 'offer-needs-name'
  | 'price-band'
  | 'first-buy-max';

const emptyOffers = (): MeritumOffer[] => Array.from({ length: MERITUM_OFFER_COUNT }, () => ({ name: '', price: '' }));

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
  /** The supply cap every token launches at. */
  cap: number;
  /** The curve's price at supply 0, formatted. */
  openingPrice: string;

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
    try {
      const raw = window.sessionStorage.getItem(draftKey);
      const draft = raw ? readDraft(raw) : null;
      if (draft) {
        const restoredStep = clampStep(draft.step);
        setStep(restoredStep);
        // The draft's own high-water mark, not the step being restored.
        setFurthestStep(clampStep(draft.furthestStep));
        setOffers(draft.offers);
        setFirstBuyState(draft.firstBuy);
        setRestoredFromDraft(true);
      }
    } catch {
      // A corrupt or unreadable draft must never block a launch. Start fresh.
    }
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
      window.sessionStorage.setItem(draftKey, JSON.stringify({ step, furthestStep, offers, firstBuy }));
    } catch {
      // Storage full or blocked (private mode). Persistence is a convenience,
      // never a precondition for launching.
    }
  }, [restored, step, furthestStep, offers, firstBuy, draftKey]);

  /**
   * ★ THE STEP IN THE URL, REFLECTION ONLY. `replace`, not `push`, so paging
   * through three short steps does not pile up history entries, and the param
   * is never read back on mount — the draft above stays the single thing that
   * decides where a reader lands, so there is one place that logic can drift.
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
    () => offers.map((o, i) => ({ index: i, name: o.name.trim(), usd: parseMoney(o.price) })).filter((o) => o.usd > 0),
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
  const capBroken = STANDARD_CAP < MIN_CAP_CREDITS_BASE_UNITS || STANDARD_CAP > MAX_CAP_CREDITS_BASE_UNITS;
  const firstBuyTooBig = firstBuyUsd > MAX_PRICE_USD;

  const offerBlock: MeritumLaunchBlock | null = priceBandBroken
    ? 'price-band'
    : offerMissingName
      ? 'offer-needs-name'
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
  const alreadyHasMarket = Boolean(studio.market);

  const block: MeritumLaunchBlock | null = !studio.loggedIn
    ? 'signed-out'
    : studio.isLite
      ? 'lite'
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
        setWrite('failed');
        // Routed through the shared formatter so the CREATOR_TOKENS_* machine
        // code is stripped and any key-shaped text is redacted before it is
        // painted into the DOM.
        setFailure(writeFailureMessage(e, 'Launch did not go through.'));
        return;
      }

      // Everything past the first price is a named offering. Sequential, not
      // parallel: they share one nonce and one signer, and being asked to sign
      // three prompts at once is worse than three in a row.
      let postedAll = true;
      for (const service of services.slice(1)) {
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
      setOffersFailed(!postedAll);
      setFirstBuySkipped(skipped);
      setWrite('ok');
    };

    void run();
  }, [studio, draftKey]);

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
    cap: STANDARD_CAP,
    openingPrice: usdPrice(openingPriceUsd),
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
