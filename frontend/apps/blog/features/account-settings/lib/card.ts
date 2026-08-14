/**
 * The settings page is a stack of cards, and every card is this one.
 *
 * Kept in one place because `/@username/settings` is assembled from three
 * files (the page content, the profile+preferences form, the muted list) that
 * used to each draw their own chrome — which is how the page ended up with no
 * chrome at all. Matches the house card used by the right rail and the
 * witnesses page: white, 1px #ebebeb, 18px radius, one-pixel lift.
 */
export const SETTINGS_CARD =
  'rounded-[18px] border border-line-9 bg-surface-1 p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';

/** Card headline: Lora, the same weight and ink as the rest of the product. */
export const SETTINGS_CARD_TITLE = 'font-serif text-[18px] font-semibold leading-[28px] text-ink-2';

/** The line under a card headline that says what the card is for. */
export const SETTINGS_CARD_HINT = 'mt-1.5 text-[13px] leading-[20px] text-ink-10';

/** Field label above an input or a select. */
export const SETTINGS_LABEL = 'mb-1.5 block text-[13px] leading-[20px] font-semibold text-ink-7';

/** Text input / select trigger. */
export const SETTINGS_INPUT =
  'h-10 w-full rounded-[10px] border border-line-11 bg-surface-1 px-3 font-sans text-[14px] leading-[22px] text-ink-2 outline-none transition-colors placeholder:text-ink-14 focus-visible:border-line-brand-10 focus-visible:ring-0';
