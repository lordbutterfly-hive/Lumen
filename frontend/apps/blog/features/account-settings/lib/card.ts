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
  'rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';

/** Card headline: Lora, the same weight and ink as the rest of the product. */
export const SETTINGS_CARD_TITLE = 'font-serif text-[19px] font-semibold leading-[1.2] text-[#161511]';

/** The line under a card headline that says what the card is for. */
export const SETTINGS_CARD_HINT = 'mt-1.5 text-[13px] leading-[1.6] text-[#6b7280]';

/** Field label above an input or a select. */
export const SETTINGS_LABEL = 'mb-1.5 block text-[12.5px] font-semibold text-[#3f4650]';

/** Text input / select trigger. */
export const SETTINGS_INPUT =
  'h-10 w-full rounded-[10px] border border-[#e4e6e9] bg-white px-3 font-sans text-[13.5px] text-[#161511] outline-none transition-colors placeholder:text-[#9ca3af] focus-visible:border-[#c0392b] focus-visible:ring-0';
