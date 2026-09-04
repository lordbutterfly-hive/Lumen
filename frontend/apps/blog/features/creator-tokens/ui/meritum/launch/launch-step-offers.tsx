'use client';

import { FC, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { COMMISSION_BPS } from '../../../lib/contract-math';
import { usdPrice } from '../../../market/format';
import { BackAction, PrimaryAction } from './launch-controls';
import type { MeritumLaunchBlock, MeritumOffer } from './use-meritum-launch';
import { MAX_OFFER_TITLE_LEN, offerTitleProblem } from '@/blog/features/creator-tokens/lib/vsc/op-builders';
import WorkLinkField from '@/blog/features/creator-tokens/ui/work-link-field';

/**
 * STEP 2 — the three open offers.
 *
 * Open, not a template: the reader writes what they do in their own words and
 * puts a price on it. Each row becomes a real posted offering on chain, which
 * is why a priced row without a name is refused here rather than at the
 * signature prompt.
 *
 * ★ THE SPLIT BAR IS DERIVED FROM THE CONTRACT'S OWN CONSTANT. 88 and 12 are
 * `COMMISSION_BPS`, not two numbers typed into a gradient. If the commission
 * ever changes, the bar and the two figures move together or not at all.
 *
 * ★ ONE ACCENT. The reference draws the creator's share as a red-to-orange
 * gradient; a second orange is explicitly out on these screens, so the share
 * is the brand fill and the remainder is a line-coloured track. It reads the
 * same and it cannot drift from the palette.
 */

const COMMISSION = COMMISSION_BPS / 10_000;
const CREATOR_SHARE_PCT = `${100 - COMMISSION_BPS / 100}%`;

export interface LaunchStepOffersProps {
  /**
   * Bare account name, no leading '@' — the signed-in creator launching this
   * market. Passed straight through to `WorkLinkField` below, which uses it to
   * key its own profile read/write (see that file for why it is never used to
   * target the write itself — both write paths are session-scoped).
   */
  account: string;
  offers: MeritumOffer[];
  onName: (index: number, value: string) => void;
  onPrice: (index: number, value: string) => void;
  block: MeritumLaunchBlock | null;
  blockMessage: string | null;
  onContinue: () => void;
  onBack: () => void;
}

const LaunchStepOffers: FC<LaunchStepOffersProps> = ({
  account,
  offers,
  onName,
  onPrice,
  block,
  blockMessage,
  onContinue,
  onBack
}) => {
  const { t } = useTranslation('common_blog');
  const examples = [
    t('meritum_launch.offer_example_1'),
    t('meritum_launch.offer_example_2'),
    t('meritum_launch.offer_example_3')
  ];

  /**
   * ★ THE ERROR MESSAGE MUST NOT RENDER FROM AN UNTOUCHED, EMPTY MOUNT
   * (2026-08-17, verified UX defect #2). `blockMessage` used to render the
   * instant this panel appeared, because the empty default state (`no-offer`)
   * IS a block — so a reader landed on step 2 and was told to fix a mistake
   * they had not yet had the chance to make.
   *
   * Seeded from the offers themselves, not hardcoded `false`: a RESTORED draft
   * can arrive here with a real problem already typed in (a priced offer
   * missing a name, say), and that is not an empty mount, it is old, genuine
   * input — the message should show for it immediately, same as it would have
   * before this reader ever left the page. Any edit, or a Continue press,
   * marks it touched from then on regardless of how it started.
   */
  const [touched, setTouched] = useState(() => offers.some((o) => o.name.trim() !== '' || o.price.trim() !== ''));

  const handleName = (index: number, value: string): void => {
    setTouched(true);
    onName(index, value);
  };
  const handlePrice = (index: number, value: string): void => {
    setTouched(true);
    onPrice(index, value);
  };
  const handleContinue = (): void => {
    setTouched(true);
    onContinue();
  };

  return (
    <div className="mt-step">
      {/* ★ HEADERS ONLY WHEN THE CARDS ARE SIDE-BY-SIDE (2026-09-04, QA #10).
          Below sm the offer card wraps name over price, so a two-column header
          ("WHAT IS YOUR SKILL?" | "YOUR PRICE") aligns to nothing and "YOUR
          PRICE" right-aligns to empty space. Hidden there; each field's own
          aria-label and placeholder carry the meaning on narrow screens. */}
      <div className="mt-[26px] hidden items-baseline gap-[18px] px-5 pb-0.5 sm:flex">
        <span className="min-w-0 flex-1 text-label font-medium uppercase tracking-label text-meritum-ink-faint font-ui">
          {t('meritum_launch.offers_col_skill')}
        </span>
        <span className="flex-none basis-[106px] text-right text-label font-medium uppercase tracking-label text-meritum-ink-faint font-ui">
          {t('meritum_launch.offers_col_price')}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {offers.map((offer, i) => (
          <div
            key={`offer-${i}`}
            className="flex flex-wrap items-center gap-x-[18px] gap-y-3.5 rounded-2xl border border-meritum-line-input bg-meritum-card px-5 py-[18px]"
          >
            <span className="flex-none text-15 text-meritum-ink-faint font-num" aria-hidden="true">
              {`0${i + 1}`}
            </span>
            {/*
              ★ `maxLength` WAS 120 AND THE CONTRACT'S LIMIT IS 64
              (core/params.go MaxOfferTitleLen), so the field invited a creator to
              type nearly twice what the chain will accept and refused it only at
              execution. Corrected to the real bound, and the remaining rules
              (no comma, no pipe, no control characters) are checked as the
              creator types rather than at the signature: `offerTitleProblem`
              mirrors `core/offerings.go validOfferTitle` exactly. Before
              2026-08-21 none of this was enforced anywhere a person could see it,
              and "Copy edit, 1k words" was accepted here, signed, broadcast,
              included in a block, and then discarded on chain with an empty
              result and no error the UI could show.
            */}
            {/* ★ aria-invalid: empty is UNFILLED, not INVALID (2026-09-04, QA #15).
                offerTitleProblem('') reports "needs a title", which marked every
                fresh field aria-invalid before a keystroke — a screen reader
                announcing each blank input as an error. Flag invalid only once
                there is content that is actually bad. */}
            <div className="min-w-[min(100%,180px)] flex-1 basis-60">
              <input
                type="text"
                value={offer.name}
                onChange={(e) => handleName(i, e.target.value)}
                placeholder={examples[i]}
                aria-label={t('meritum_launch.offer_name_aria', { n: i + 1 })}
                aria-invalid={offer.name.trim() !== '' && offerTitleProblem(offer.name) !== null}
                maxLength={MAX_OFFER_TITLE_LEN}
                className="w-full border-0 border-b-[1.5px] border-meritum-line-input bg-transparent pb-1 font-ui text-16 font-medium text-meritum-ink outline-none placeholder:text-meritum-ink-faint"
              />
              {/*
                ★ A COUNTER, NOT JUST A CAP (2026-08-31, verified UX defect —
                Section 03). `maxLength` stops the box silently at 64 with no
                sign a limit exists at all — the input just stops accepting
                keystrokes. This is a `.length` (UTF-16 code unit) count, not
                the byte count `offerTitleProblem`/the contract enforce, so it
                can under-count for non-Latin script; it is a soft hint next to
                the input, never the gate — `offerTitleProblem` (below) and the
                'offer-bad-title' block still own the real, byte-accurate rule.
              */}
              <div className="mt-0.5 text-right text-caption tabular-nums text-meritum-ink-faint font-num">
                {offer.name.length}/{MAX_OFFER_TITLE_LEN}
              </div>
            </div>
            <div className="flex flex-none items-baseline gap-[5px]">
              <span className="text-20 text-meritum-ink-faint font-num" aria-hidden="true">
                $
              </span>
              {/*
                ★ LOW 10 (2026-08-16) — `w-[84px]` clipped its own value: typing
                `999999999` rendered as `9999`, because the fixed pixel width was
                narrower than nine tabular-nums digits at `text-30`, so the native
                input scrolled and showed only what fit. `text-right` also read as
                a gap between the `$` and the digits for every ordinary (short)
                price, since right-aligned text sits at the box's far edge, away
                from the `$` beside it, whenever the box is wider than the value.
                Fixed both by sizing the box in `ch` — the longest a legitimate
                price can be is `10000.000` (MAX_PRICE_USD to three decimals, see
                `../../launch-money.ts`), nine characters, plus one for slack —
                and left-aligning so the digits start right after the `$`.
                Permissive parsing (`sanitizeMoneyInput`) still decides what
                counts as a valid price; `maxLength` here only stops the box from
                ever having to scroll.
              */}
              <input
                type="text"
                value={offer.price}
                onChange={(e) => handlePrice(i, e.target.value)}
                placeholder="0"
                inputMode="decimal"
                maxLength={9}
                aria-label={t('meritum_launch.offer_price_aria', { n: i + 1 })}
                className="w-[10ch] min-w-0 border-0 border-b-[1.5px] border-meritum-line-input bg-transparent pb-1 text-left text-30 tabular-nums text-meritum-ink font-num outline-none placeholder:text-meritum-ink-faint"
              />
            </div>
          </div>
        ))}
      </div>

      {/*
        ★ THE BLOCK MESSAGE RENDERS HERE, RIGHT UNDER THE ROWS IT DESCRIBES
        (2026-08-31, verified UX defect — Section 03). It used to sit below the
        split bar AND the "Show them the work" section, ~300px under the price
        inputs it explains. A reader who typed an out-of-band price had to
        scroll past two unrelated blocks to learn why Continue was disabled.
      */}
      {touched && blockMessage ? (
        <p className="mt-4 text-caption font-medium text-meritum-ink-brand font-ui" role="status">
          {blockMessage}
        </p>
      ) : null}

      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2.5">
          <span className="text-label font-medium uppercase tracking-label text-meritum-ink-muted font-ui">
            {t('meritum_launch.split_heading')}
          </span>
          <span className="text-caption text-meritum-ink-faint font-ui">{t('meritum_launch.split_note')}</span>
        </div>
        <div
          className="mt-2.5 flex h-[11px] overflow-hidden rounded-full bg-meritum-line-input"
          role="img"
          aria-label={t('meritum_launch.split_aria', {
            you: usdPrice(1 - COMMISSION),
            lumen: usdPrice(COMMISSION)
          })}
        >
          <span className="bg-meritum-surface-brand" style={{ width: CREATOR_SHARE_PCT }} />
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-7 gap-y-2.5" aria-hidden="true">
          <span className="flex items-baseline gap-2">
            <span className="text-20 tabular-nums text-meritum-ink font-num">
              {usdPrice(1 - COMMISSION)}
            </span>
            <span className="font-ui text-caption text-meritum-ink-muted">{t('meritum_launch.split_you')}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-20 tabular-nums text-meritum-ink-muted font-num">
              {usdPrice(COMMISSION)}
            </span>
            <span className="font-ui text-caption text-meritum-ink-faint">{t('meritum_launch.split_lumen')}</span>
          </span>
        </div>
      </div>

      {/*
        ★ SHOW THEM THE WORK — REWRITTEN 2026-08-30 (owner: "THEY NEED TO ADD
        THE LINK HERE... NOT SETTINGS. AND I DONT SEE IT IN SETTINGS.").
        The 2026-08 note this replaces argued an input is worse than no input
        because nothing in the launch write can carry it: `register` takes a
        price and a cap, `createOffering` takes a title and a price, neither
        has room for a link. That premise was correct and the conclusion was
        wrong — the link was never supposed to ride inside the launch
        transaction at all. It goes to the profile store instead, the same one
        `features/account-settings/form.tsx` already writes for both account
        tiers (`website` on `posting_json_metadata.profile` for a Hive account,
        `lumen_user.profile` for a lite one), which already persists and, once
        B3/B5 land, already renders on the token page and the profile. So
        `WorkLinkField` writes straight there and never touches this screen's
        launch write at all — see that component for the two write paths and
        why the Hive one is its own signature, independent of the hold-to-strike
        below. Kept and corrected rather than deleted: this codebase records why
        a decision reversed.
      */}
      <div className="mt-[26px] border-t border-meritum-line-card pt-[22px]">
        <div className="text-label font-medium uppercase tracking-label text-meritum-ink-3 font-ui">
          {t('meritum_launch.work_heading')}
        </div>
        <p className="mt-2 max-w-[48ch] font-ui text-caption text-meritum-ink-muted">{t('meritum_launch.work_body')}</p>
        <div className="mt-3">
          <WorkLinkField
            account={account}
            inputClassName="min-w-[min(100%,220px)] flex-1 rounded-lg border border-meritum-line-input bg-meritum-card px-3 py-2 font-ui text-14 text-meritum-ink outline-none placeholder:text-meritum-ink-faint focus-visible:outline-none focus:border-meritum-line-brand disabled:opacity-60"
            buttonClassName="inline-flex h-[38px] flex-none items-center rounded-lg bg-meritum-surface-brand px-4 text-caption font-medium text-meritum-ink-on-brand font-ui transition-colors hover:bg-meritum-surface-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
            errorClassName="mt-1.5 text-caption font-medium text-meritum-ink-brand font-ui"
            statusClassName="mt-1.5 text-caption text-meritum-ink-faint font-ui"
          />
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-5">
        <PrimaryAction
          label={t('meritum_launch.step2_continue')}
          onClick={handleContinue}
          disabled={block !== null}
          title={blockMessage ?? undefined}
        />
        <BackAction label={t('meritum_launch.back')} onClick={onBack} />
      </div>
    </div>
  );
};

export default LaunchStepOffers;
