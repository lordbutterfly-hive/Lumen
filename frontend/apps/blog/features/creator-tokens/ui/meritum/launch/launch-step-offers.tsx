'use client';

import { FC, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { COMMISSION_BPS } from '../../../lib/contract-math';
import { usdPrice } from '../../../market/format';
import { BackAction, PrimaryAction } from './launch-controls';
import type { MeritumLaunchBlock, MeritumOffer } from './use-meritum-launch';

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
   * Bare account name, no leading '@'. Only used to build the settings link —
   * there is no bare `/settings` route in this app, the real one is nested under
   * the profile as `/@<account>/settings`.
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
      <div className="mt-[26px] flex items-baseline gap-[18px] px-5 pb-0.5">
        <span className="min-w-0 flex-1 text-label font-bold uppercase tracking-label text-meritum-ink-faint">
          {t('meritum_launch.offers_col_skill')}
        </span>
        <span className="flex-none basis-[106px] text-right text-label font-bold uppercase tracking-label text-meritum-ink-faint">
          {t('meritum_launch.offers_col_price')}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {offers.map((offer, i) => (
          <div
            key={`offer-${i}`}
            className="flex flex-wrap items-center gap-x-[18px] gap-y-3.5 rounded-2xl border border-meritum-line-input bg-meritum-card px-5 py-[18px]"
          >
            <span className="flex-none font-serif text-15 font-semibold text-meritum-ink-faint" aria-hidden="true">
              {`0${i + 1}`}
            </span>
            <input
              type="text"
              value={offer.name}
              onChange={(e) => handleName(i, e.target.value)}
              placeholder={examples[i]}
              aria-label={t('meritum_launch.offer_name_aria', { n: i + 1 })}
              maxLength={120}
              className="min-w-[min(100%,180px)] flex-1 basis-60 border-0 border-b-[1.5px] border-meritum-line-input bg-transparent pb-1 font-serif text-16 font-semibold text-meritum-ink outline-none placeholder:text-meritum-ink-faint"
            />
            <div className="flex flex-none items-baseline gap-[5px]">
              <span className="font-serif text-20 text-meritum-ink-faint" aria-hidden="true">
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
                className="w-[10ch] min-w-0 border-0 border-b-[1.5px] border-meritum-line-input bg-transparent pb-1 text-left font-serif text-30 font-semibold tabular-nums text-meritum-ink outline-none placeholder:text-meritum-ink-faint"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2.5">
          <span className="text-label font-bold uppercase tracking-label text-meritum-ink-muted">
            {t('meritum_launch.split_heading')}
          </span>
          <span className="text-caption text-meritum-ink-faint">{t('meritum_launch.split_note')}</span>
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
            <span className="font-serif text-20 font-semibold tabular-nums text-meritum-ink">
              {usdPrice(1 - COMMISSION)}
            </span>
            <span className="font-serif text-caption text-meritum-ink-muted">{t('meritum_launch.split_you')}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="font-serif text-20 font-semibold tabular-nums text-meritum-ink-muted">
              {usdPrice(COMMISSION)}
            </span>
            <span className="font-serif text-caption text-meritum-ink-faint">{t('meritum_launch.split_lumen')}</span>
          </span>
        </div>
      </div>

      {/*
        ★ SHOW THEM THE WORK — A LINK, NOT A FIELD.
        The reference puts a work-link input on this card. Nothing in the launch
        write carries it: `register` takes a price and a cap, `createOffering`
        takes a title and a price. An input that quietly discards what is typed
        into it, on the screen where a creator is being asked to trust the
        numbers, is worse than no input. The profile link is real, it persists,
        and it is one click away, so this points at it instead.
      */}
      <div className="mt-[26px] border-t border-meritum-line-card pt-[22px]">
        <div className="text-label font-bold uppercase tracking-label text-meritum-ink-3">
          {t('meritum_launch.work_heading')}
        </div>
        <p className="mt-2 max-w-[48ch] font-serif text-caption text-meritum-ink-muted">{t('meritum_launch.work_body')}</p>
        {/*
          ★ THERE IS NO BARE `/settings` ROUTE. It 404s. The settings page lives
          under the profile — `app/[param]/(user-profile)/settings/page.tsx` —
          so the only correct href is `/@<account>/settings`. Sending a creator
          to a 404 from the screen that asks them to trust the numbers is the
          worst possible place for a dead link.
        */}
        <a
          href={`/@${account}/settings`}
          className="mt-3 inline-flex text-14 font-semibold text-meritum-ink-link hover:underline"
        >
          {t('meritum_launch.work_link')}
        </a>
      </div>

      {touched && blockMessage ? (
        <p className="mt-5 text-caption font-semibold text-meritum-ink-brand" role="status">
          {blockMessage}
        </p>
      ) : null}

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
