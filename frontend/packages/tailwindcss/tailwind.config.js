/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    // apps content
    `**/*.{jsx,tsx}`,
    // include packages if not transpiling
    '../../packages/**/*.{jsx,tsx}',
    '../../node_modules/@hiveio/healthchecker-component/**/*.{ts,tsx,js,jsx}'
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px'
      }
    },
    extend: {
      fontFamily: {
        source: ['"Source Serif Pro"', 'serif'],
        sanspro: ['"Source Sans Pro"', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
        consolas: ['Consolas', '"Liberation Mono"', 'Courier', 'monospace']
      },

      /**
       * ★★★ THE LUMEN TYPE SCALE — ONE LIST, THIS LIST, NOWHERE ELSE
       * (2026-08-13, typography pass 2: "font twins").
       *
       * WHY THIS EXISTS. A rendered census of 15 signed-in routes
       * (`font-inventory.tmp.mjs`) counted 21 distinct font sizes and, worse,
       * one JOB rendered at many treatments: 4 card titles, 8 card actions,
       * 8 button treatments, 26 card meta/excerpt treatments. Nothing chose
       * those numbers — they accumulated. This block is the whole scale, so
       * the next person picks a step instead of inventing one.
       *
       * HOW IT WAS DERIVED. From what the product ALREADY uses most, not from
       * a fashionable ratio — measured over every `text-[Npx]` and
       * `text-{xs..6xl}` in `apps/` + `packages/`:
       *
       *     13px x284 · 14px x423 · 12px x187 · 15px x106 · 18px x37
       *     30px x37 · 16px x31 · 20px x24 · 24px x22 · 22px x13 · 17px x11
       *
       * Every step below is one of those. Sizes that appeared a handful of
       * times immediately NEXT to a heavy step were drift, and were folded
       * into it: 11 -> 12, 19 -> 20 (or 18 where the line box already said
       * 18), 21 -> 22, 23 -> 24, 25 -> 26, 28 -> 30, 32/36/38 -> 34, 42 -> 44,
       * 9/10 -> 12. No new size was invented and no step in daily use was
       * removed, so the product does not reflow into someone's taste.
       *
       * PAIRED LINE HEIGHTS ARE PART OF THE STEP. The census keyed on
       * (family, size, weight, line-height), and the single largest source of
       * twins was ONE size with TWO line boxes — `text-sm` (14/20, Tailwind's
       * default) sitting beside the redesign's own `text-[14px]
       * leading-[22px]` (169 hand-written call sites) in the same card, the
       * same button row, the same comment. So the t-shirt names below are
       * REDEFINED onto this scale rather than left on Tailwind's defaults:
       * `text-sm` and `text-[14px] leading-[22px]` are now the same treatment,
       * which is what "one job, one treatment" actually requires.
       * Changed from Tailwind's defaults: xs 12/16 -> 12/18, sm 14/20 ->
       * 14/22, xl 20/28 -> 20/30, 3xl 30/36 -> 30/38, 4xl 36/40 -> 34/44,
       * 5xl 48 -> 44/52. base/lg/2xl/6xl already matched and are unchanged.
       *
       * EVERY VALUE IS A WHOLE PIXEL, size and leading both. The app inherits
       * Preflight's unitless `line-height: 1.5` and `prose`'s `1.75`, so any
       * fractional size drags every following block off the device pixel grid
       * (that is what the first typography pass fixed, and what the em-based
       * rules further down this file kept quietly re-introducing).
       *
       * USE THE NUMERIC TOKENS IN NEW CODE: `text-14` is `14px/22px`, self
       * documenting, and impossible to pair with a stray leading by accident.
       * The `text-[14px] leading-[22px]` spelling still works and renders
       * identically — it just does not tell the next reader that 14 is a step
       * rather than a guess.
       */
      fontSize: {
        // — UI + reading steps (the working range; ~95% of all text) —
        12: ['12px', '18px'], // micro: eyebrows, badges, table headers, timestamps
        13: ['13px', '20px'], // meta: bylines, tags, secondary UI, compact buttons
        14: ['14px', '22px'], // DEFAULT UI: buttons, tabs, labels, comment chrome
        15: ['15px', '24px'], // emphasis UI, comment reading body (at lg)
        16: ['16px', '24px'], // base UI, section tabs
        17: ['17px', '26px'], // reading: post body, feed card dek
        // — headings —
        18: ['18px', '28px'], // compact card title
        20: ['20px', '30px'], // stat figure, small heading
        22: ['22px', '28px'], // secondary card title, dialog title
        24: ['24px', '32px'],
        26: ['26px', '32px'], // feed card title (32 is what the title itself uses:
        //   a 2-line clamped headline wants a tighter box than running text)
        // — display —
        30: ['30px', '38px'],
        34: ['34px', '44px'], // masthead, profile name, post h1
        44: ['44px', '52px'],
        60: ['60px', '1'],

        // t-shirt names, redefined as exact aliases of the steps above so that
        // `text-sm` and `text-14` are byte-identical CSS.
        xs: ['12px', '18px'],
        sm: ['14px', '22px'],
        base: ['16px', '24px'],
        lg: ['18px', '28px'],
        xl: ['20px', '30px'],
        '2xl': ['24px', '32px'],
        '3xl': ['30px', '38px'],
        '4xl': ['34px', '44px'],
        '5xl': ['44px', '52px'],
        '6xl': ['60px', '1']
      },
      colors: {
        /**
         * ★★★ THE LUMEN PALETTE TOKENS — LIGHT AND DARK, ONE SOURCE
         * (2026-08-13, dark-mode build; audit finding 1.1.)
         *
         * WHY THESE EXIST. The audit measured 15 `.dark` rules in the entire
         * stylesheet against 3,338 hardcoded colour decisions in source, so
         * flipping the theme half-converted the page: body went dark while the
         * sticky header, the cards and the body text all stayed light. The
         * cause was never the toggle — it was that almost every colour in this
         * app was written as a literal (`bg-white`, `text-[#6b7280]`,
         * `border-[#ebebeb]`), and a literal cannot respond to a theme.
         *
         * Every one of those literals is now a token below, and each token's
         * LIGHT value is byte-identical to the literal it replaced — the light
         * product is unchanged by construction, which is the property that made
         * a rewrite this size safe to do at all.
         *
         * THE NAMES ARE ROLE + STEP, and the role comes from the CSS property,
         * because one colour needs three different dark values depending on how
         * it is used: `bg-[#c0392b]` is a brand FILL that stays red on dark,
         * `text-[#c0392b]` is brand INK that must lighten to clear 4.5:1 on a
         * dark card, and `border-[#c0392b]` is a brand LINE that only needs 3:1.
         * Hence surface-* / ink-* / line-*, each suffixed with its colour family
         * (brand, warn, ok, info, gold, violet) where it is not neutral.
         *
         * The dark values are DERIVED, not picked: see the generator notes in
         * globals.css. Inks preserve the contrast ratio the designer chose
         * against white, so the type hierarchy survives the flip, then get
         * lifted if that lands under 4.5:1.
         *
         * Values are space-separated channels rather than hex so that
         * `<alpha-value>` works — `bg-surface-1/80` and `ring-line-brand-10/40`
         * are both in use and both need it.
         */
        'ink-1': 'rgb(var(--ink-1) / <alpha-value>)',
        'ink-10': 'rgb(var(--ink-10) / <alpha-value>)',
        'ink-11': 'rgb(var(--ink-11) / <alpha-value>)',
        'ink-12': 'rgb(var(--ink-12) / <alpha-value>)',
        'ink-13': 'rgb(var(--ink-13) / <alpha-value>)',
        'ink-14': 'rgb(var(--ink-14) / <alpha-value>)',
        'ink-15': 'rgb(var(--ink-15) / <alpha-value>)',
        'ink-16': 'rgb(var(--ink-16) / <alpha-value>)',
        'ink-17': 'rgb(var(--ink-17) / <alpha-value>)',
        'ink-18': 'rgb(var(--ink-18) / <alpha-value>)',
        'ink-19': 'rgb(var(--ink-19) / <alpha-value>)',
        'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
        'ink-20': 'rgb(var(--ink-20) / <alpha-value>)',
        'ink-21': 'rgb(var(--ink-21) / <alpha-value>)',
        'ink-22': 'rgb(var(--ink-22) / <alpha-value>)',
        'ink-23': 'rgb(var(--ink-23) / <alpha-value>)',
        'ink-24': 'rgb(var(--ink-24) / <alpha-value>)',
        'ink-25': 'rgb(var(--ink-25) / <alpha-value>)',
        'ink-26': 'rgb(var(--ink-26) / <alpha-value>)',
        'ink-27': 'rgb(var(--ink-27) / <alpha-value>)',
        'ink-3': 'rgb(var(--ink-3) / <alpha-value>)',
        'ink-4': 'rgb(var(--ink-4) / <alpha-value>)',
        'ink-5': 'rgb(var(--ink-5) / <alpha-value>)',
        'ink-6': 'rgb(var(--ink-6) / <alpha-value>)',
        'ink-7': 'rgb(var(--ink-7) / <alpha-value>)',
        'ink-8': 'rgb(var(--ink-8) / <alpha-value>)',
        'ink-9': 'rgb(var(--ink-9) / <alpha-value>)',
        'ink-brand-1': 'rgb(var(--ink-brand-1) / <alpha-value>)',
        'ink-brand-10': 'rgb(var(--ink-brand-10) / <alpha-value>)',
        'ink-brand-2': 'rgb(var(--ink-brand-2) / <alpha-value>)',
        'ink-brand-3': 'rgb(var(--ink-brand-3) / <alpha-value>)',
        'ink-brand-4': 'rgb(var(--ink-brand-4) / <alpha-value>)',
        'ink-brand-5': 'rgb(var(--ink-brand-5) / <alpha-value>)',
        'ink-brand-6': 'rgb(var(--ink-brand-6) / <alpha-value>)',
        'ink-brand-7': 'rgb(var(--ink-brand-7) / <alpha-value>)',
        'ink-brand-8': 'rgb(var(--ink-brand-8) / <alpha-value>)',
        'ink-brand-9': 'rgb(var(--ink-brand-9) / <alpha-value>)',
        'ink-info-1': 'rgb(var(--ink-info-1) / <alpha-value>)',
        'ink-info-10': 'rgb(var(--ink-info-10) / <alpha-value>)',
        'ink-info-11': 'rgb(var(--ink-info-11) / <alpha-value>)',
        'ink-info-2': 'rgb(var(--ink-info-2) / <alpha-value>)',
        'ink-info-3': 'rgb(var(--ink-info-3) / <alpha-value>)',
        'ink-info-4': 'rgb(var(--ink-info-4) / <alpha-value>)',
        'ink-info-5': 'rgb(var(--ink-info-5) / <alpha-value>)',
        'ink-info-6': 'rgb(var(--ink-info-6) / <alpha-value>)',
        'ink-info-7': 'rgb(var(--ink-info-7) / <alpha-value>)',
        'ink-info-8': 'rgb(var(--ink-info-8) / <alpha-value>)',
        'ink-info-9': 'rgb(var(--ink-info-9) / <alpha-value>)',
        'ink-ok-1': 'rgb(var(--ink-ok-1) / <alpha-value>)',
        'ink-ok-2': 'rgb(var(--ink-ok-2) / <alpha-value>)',
        'ink-ok-3': 'rgb(var(--ink-ok-3) / <alpha-value>)',
        'ink-ok-4': 'rgb(var(--ink-ok-4) / <alpha-value>)',
        'ink-ok-5': 'rgb(var(--ink-ok-5) / <alpha-value>)',
        'ink-violet-1': 'rgb(var(--ink-violet-1) / <alpha-value>)',
        'ink-violet-2': 'rgb(var(--ink-violet-2) / <alpha-value>)',
        'ink-warn-1': 'rgb(var(--ink-warn-1) / <alpha-value>)',
        'ink-warn-10': 'rgb(var(--ink-warn-10) / <alpha-value>)',
        'ink-warn-2': 'rgb(var(--ink-warn-2) / <alpha-value>)',
        'ink-warn-3': 'rgb(var(--ink-warn-3) / <alpha-value>)',
        'ink-warn-4': 'rgb(var(--ink-warn-4) / <alpha-value>)',
        'ink-warn-5': 'rgb(var(--ink-warn-5) / <alpha-value>)',
        'ink-warn-6': 'rgb(var(--ink-warn-6) / <alpha-value>)',
        'ink-warn-7': 'rgb(var(--ink-warn-7) / <alpha-value>)',
        'ink-warn-8': 'rgb(var(--ink-warn-8) / <alpha-value>)',
        'ink-warn-9': 'rgb(var(--ink-warn-9) / <alpha-value>)',
        'line-1': 'rgb(var(--line-1) / <alpha-value>)',
        'line-10': 'rgb(var(--line-10) / <alpha-value>)',
        'line-11': 'rgb(var(--line-11) / <alpha-value>)',
        'line-12': 'rgb(var(--line-12) / <alpha-value>)',
        'line-13': 'rgb(var(--line-13) / <alpha-value>)',
        'line-14': 'rgb(var(--line-14) / <alpha-value>)',
        'line-15': 'rgb(var(--line-15) / <alpha-value>)',
        'line-16': 'rgb(var(--line-16) / <alpha-value>)',
        'line-17': 'rgb(var(--line-17) / <alpha-value>)',
        'line-18': 'rgb(var(--line-18) / <alpha-value>)',
        'line-19': 'rgb(var(--line-19) / <alpha-value>)',
        'line-2': 'rgb(var(--line-2) / <alpha-value>)',
        'line-20': 'rgb(var(--line-20) / <alpha-value>)',
        'line-21': 'rgb(var(--line-21) / <alpha-value>)',
        'line-22': 'rgb(var(--line-22) / <alpha-value>)',
        'line-23': 'rgb(var(--line-23) / <alpha-value>)',
        'line-24': 'rgb(var(--line-24) / <alpha-value>)',
        'line-25': 'rgb(var(--line-25) / <alpha-value>)',
        'line-26': 'rgb(var(--line-26) / <alpha-value>)',
        'line-27': 'rgb(var(--line-27) / <alpha-value>)',
        'line-28': 'rgb(var(--line-28) / <alpha-value>)',
        'line-29': 'rgb(var(--line-29) / <alpha-value>)',
        'line-3': 'rgb(var(--line-3) / <alpha-value>)',
        'line-4': 'rgb(var(--line-4) / <alpha-value>)',
        'line-5': 'rgb(var(--line-5) / <alpha-value>)',
        'line-6': 'rgb(var(--line-6) / <alpha-value>)',
        'line-7': 'rgb(var(--line-7) / <alpha-value>)',
        'line-8': 'rgb(var(--line-8) / <alpha-value>)',
        'line-9': 'rgb(var(--line-9) / <alpha-value>)',
        'line-brand-1': 'rgb(var(--line-brand-1) / <alpha-value>)',
        'line-brand-10': 'rgb(var(--line-brand-10) / <alpha-value>)',
        'line-brand-11': 'rgb(var(--line-brand-11) / <alpha-value>)',
        'line-brand-2': 'rgb(var(--line-brand-2) / <alpha-value>)',
        'line-brand-3': 'rgb(var(--line-brand-3) / <alpha-value>)',
        'line-brand-4': 'rgb(var(--line-brand-4) / <alpha-value>)',
        'line-brand-5': 'rgb(var(--line-brand-5) / <alpha-value>)',
        'line-brand-6': 'rgb(var(--line-brand-6) / <alpha-value>)',
        'line-brand-7': 'rgb(var(--line-brand-7) / <alpha-value>)',
        'line-brand-8': 'rgb(var(--line-brand-8) / <alpha-value>)',
        'line-brand-9': 'rgb(var(--line-brand-9) / <alpha-value>)',
        'line-info-1': 'rgb(var(--line-info-1) / <alpha-value>)',
        'line-info-2': 'rgb(var(--line-info-2) / <alpha-value>)',
        'line-info-3': 'rgb(var(--line-info-3) / <alpha-value>)',
        'line-info-4': 'rgb(var(--line-info-4) / <alpha-value>)',
        'line-info-5': 'rgb(var(--line-info-5) / <alpha-value>)',
        'line-info-6': 'rgb(var(--line-info-6) / <alpha-value>)',
        'line-ok-1': 'rgb(var(--line-ok-1) / <alpha-value>)',
        'line-ok-2': 'rgb(var(--line-ok-2) / <alpha-value>)',
        'line-ok-3': 'rgb(var(--line-ok-3) / <alpha-value>)',
        'line-ok-4': 'rgb(var(--line-ok-4) / <alpha-value>)',
        'line-ok-5': 'rgb(var(--line-ok-5) / <alpha-value>)',
        'line-warn-1': 'rgb(var(--line-warn-1) / <alpha-value>)',
        'line-warn-2': 'rgb(var(--line-warn-2) / <alpha-value>)',
        'line-warn-3': 'rgb(var(--line-warn-3) / <alpha-value>)',
        'line-warn-4': 'rgb(var(--line-warn-4) / <alpha-value>)',
        'line-warn-5': 'rgb(var(--line-warn-5) / <alpha-value>)',
        'line-warn-6': 'rgb(var(--line-warn-6) / <alpha-value>)',
        'line-warn-7': 'rgb(var(--line-warn-7) / <alpha-value>)',
        'line-warn-8': 'rgb(var(--line-warn-8) / <alpha-value>)',
        'surface-1': 'rgb(var(--surface-1) / <alpha-value>)',
        'surface-10': 'rgb(var(--surface-10) / <alpha-value>)',
        'surface-11': 'rgb(var(--surface-11) / <alpha-value>)',
        'surface-12': 'rgb(var(--surface-12) / <alpha-value>)',
        'surface-13': 'rgb(var(--surface-13) / <alpha-value>)',
        'surface-14': 'rgb(var(--surface-14) / <alpha-value>)',
        'surface-15': 'rgb(var(--surface-15) / <alpha-value>)',
        'surface-16': 'rgb(var(--surface-16) / <alpha-value>)',
        'surface-17': 'rgb(var(--surface-17) / <alpha-value>)',
        'surface-18': 'rgb(var(--surface-18) / <alpha-value>)',
        'surface-19': 'rgb(var(--surface-19) / <alpha-value>)',
        'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
        'surface-20': 'rgb(var(--surface-20) / <alpha-value>)',
        'surface-21': 'rgb(var(--surface-21) / <alpha-value>)',
        'surface-22': 'rgb(var(--surface-22) / <alpha-value>)',
        'surface-23': 'rgb(var(--surface-23) / <alpha-value>)',
        'surface-24': 'rgb(var(--surface-24) / <alpha-value>)',
        'surface-25': 'rgb(var(--surface-25) / <alpha-value>)',
        'surface-26': 'rgb(var(--surface-26) / <alpha-value>)',
        'surface-27': 'rgb(var(--surface-27) / <alpha-value>)',
        'surface-28': 'rgb(var(--surface-28) / <alpha-value>)',
        'surface-29': 'rgb(var(--surface-29) / <alpha-value>)',
        'surface-3': 'rgb(var(--surface-3) / <alpha-value>)',
        'surface-30': 'rgb(var(--surface-30) / <alpha-value>)',
        'surface-31': 'rgb(var(--surface-31) / <alpha-value>)',
        'surface-32': 'rgb(var(--surface-32) / <alpha-value>)',
        'surface-33': 'rgb(var(--surface-33) / <alpha-value>)',
        'surface-34': 'rgb(var(--surface-34) / <alpha-value>)',
        'surface-35': 'rgb(var(--surface-35) / <alpha-value>)',
        'surface-36': 'rgb(var(--surface-36) / <alpha-value>)',
        'surface-37': 'rgb(var(--surface-37) / <alpha-value>)',
        'surface-38': 'rgb(var(--surface-38) / <alpha-value>)',
        'surface-39': 'rgb(var(--surface-39) / <alpha-value>)',
        'surface-4': 'rgb(var(--surface-4) / <alpha-value>)',
        'surface-40': 'rgb(var(--surface-40) / <alpha-value>)',
        'surface-41': 'rgb(var(--surface-41) / <alpha-value>)',
        'surface-42': 'rgb(var(--surface-42) / <alpha-value>)',
        'surface-43': 'rgb(var(--surface-43) / <alpha-value>)',
        'surface-44': 'rgb(var(--surface-44) / <alpha-value>)',
        'surface-5': 'rgb(var(--surface-5) / <alpha-value>)',
        'surface-6': 'rgb(var(--surface-6) / <alpha-value>)',
        'surface-7': 'rgb(var(--surface-7) / <alpha-value>)',
        'surface-8': 'rgb(var(--surface-8) / <alpha-value>)',
        'surface-9': 'rgb(var(--surface-9) / <alpha-value>)',
        'surface-brand-1': 'rgb(var(--surface-brand-1) / <alpha-value>)',
        'surface-brand-10': 'rgb(var(--surface-brand-10) / <alpha-value>)',
        'surface-brand-11': 'rgb(var(--surface-brand-11) / <alpha-value>)',
        'surface-brand-12': 'rgb(var(--surface-brand-12) / <alpha-value>)',
        'surface-brand-13': 'rgb(var(--surface-brand-13) / <alpha-value>)',
        'surface-brand-14': 'rgb(var(--surface-brand-14) / <alpha-value>)',
        'surface-brand-15': 'rgb(var(--surface-brand-15) / <alpha-value>)',
        'surface-brand-16': 'rgb(var(--surface-brand-16) / <alpha-value>)',
        'surface-brand-17': 'rgb(var(--surface-brand-17) / <alpha-value>)',
        'surface-brand-2': 'rgb(var(--surface-brand-2) / <alpha-value>)',
        'surface-brand-3': 'rgb(var(--surface-brand-3) / <alpha-value>)',
        'surface-brand-4': 'rgb(var(--surface-brand-4) / <alpha-value>)',
        'surface-brand-5': 'rgb(var(--surface-brand-5) / <alpha-value>)',
        'surface-brand-6': 'rgb(var(--surface-brand-6) / <alpha-value>)',
        'surface-brand-7': 'rgb(var(--surface-brand-7) / <alpha-value>)',
        'surface-brand-8': 'rgb(var(--surface-brand-8) / <alpha-value>)',
        'surface-brand-9': 'rgb(var(--surface-brand-9) / <alpha-value>)',
        'surface-gold-1': 'rgb(var(--surface-gold-1) / <alpha-value>)',
        'surface-gold-2': 'rgb(var(--surface-gold-2) / <alpha-value>)',
        'surface-gold-3': 'rgb(var(--surface-gold-3) / <alpha-value>)',
        'surface-info-1': 'rgb(var(--surface-info-1) / <alpha-value>)',
        'surface-info-10': 'rgb(var(--surface-info-10) / <alpha-value>)',
        'surface-info-2': 'rgb(var(--surface-info-2) / <alpha-value>)',
        'surface-info-3': 'rgb(var(--surface-info-3) / <alpha-value>)',
        'surface-info-4': 'rgb(var(--surface-info-4) / <alpha-value>)',
        'surface-info-5': 'rgb(var(--surface-info-5) / <alpha-value>)',
        'surface-info-6': 'rgb(var(--surface-info-6) / <alpha-value>)',
        'surface-info-7': 'rgb(var(--surface-info-7) / <alpha-value>)',
        'surface-info-8': 'rgb(var(--surface-info-8) / <alpha-value>)',
        'surface-info-9': 'rgb(var(--surface-info-9) / <alpha-value>)',
        'surface-ok-1': 'rgb(var(--surface-ok-1) / <alpha-value>)',
        'surface-ok-2': 'rgb(var(--surface-ok-2) / <alpha-value>)',
        'surface-ok-3': 'rgb(var(--surface-ok-3) / <alpha-value>)',
        'surface-ok-4': 'rgb(var(--surface-ok-4) / <alpha-value>)',
        'surface-ok-5': 'rgb(var(--surface-ok-5) / <alpha-value>)',
        'surface-ok-6': 'rgb(var(--surface-ok-6) / <alpha-value>)',
        'surface-ok-7': 'rgb(var(--surface-ok-7) / <alpha-value>)',
        'surface-ok-8': 'rgb(var(--surface-ok-8) / <alpha-value>)',
        'surface-ok-9': 'rgb(var(--surface-ok-9) / <alpha-value>)',
        'surface-warn-1': 'rgb(var(--surface-warn-1) / <alpha-value>)',
        'surface-warn-10': 'rgb(var(--surface-warn-10) / <alpha-value>)',
        'surface-warn-11': 'rgb(var(--surface-warn-11) / <alpha-value>)',
        'surface-warn-12': 'rgb(var(--surface-warn-12) / <alpha-value>)',
        'surface-warn-13': 'rgb(var(--surface-warn-13) / <alpha-value>)',
        'surface-warn-14': 'rgb(var(--surface-warn-14) / <alpha-value>)',
        'surface-warn-15': 'rgb(var(--surface-warn-15) / <alpha-value>)',
        'surface-warn-2': 'rgb(var(--surface-warn-2) / <alpha-value>)',
        'surface-warn-3': 'rgb(var(--surface-warn-3) / <alpha-value>)',
        'surface-warn-4': 'rgb(var(--surface-warn-4) / <alpha-value>)',
        'surface-warn-5': 'rgb(var(--surface-warn-5) / <alpha-value>)',
        'surface-warn-6': 'rgb(var(--surface-warn-6) / <alpha-value>)',
        'surface-warn-7': 'rgb(var(--surface-warn-7) / <alpha-value>)',
        'surface-warn-8': 'rgb(var(--surface-warn-8) / <alpha-value>)',
        'surface-warn-9': 'rgb(var(--surface-warn-9) / <alpha-value>)',

        border: 'hsl(var(--border))',
        'thread-line': 'hsl(var(--thread-line))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: {
          DEFAULT: 'hsl(var(--background))',
          secondary: 'hsl(var(--background-secondary))',
          tertiary: 'hsl(var(--background-tertiary))'
        },
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          icon: 'hsl(var(--destructive-icon))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
          noContent: 'hsl(var(--card-no-content))',
          emptyBorder: 'hsl(var(--card-empty-border))'
        },
        link: 'hsl(var(--link))'
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      keyframes: {
        'accordion-down': {
          from: { height: 0 },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: 0 }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out'
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '100%',
            color: 'hsl(var(--primary))',
            'h1, h2, h3, h4, h5, h6': {
              color: 'hsl(var(--primary))',
              fontWeight: '600',
              marginBottom: '0.25rem',
              marginTop: '2.5rem'
            },
            p: {
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              '&::before': {
                content: 'none !important'
              },
              '&::after': {
                content: 'none !important'
              }
            },
            a: {
              color: 'hsl(var(--link))',
              textDecoration: 'none',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            },
            blockquote: {
              color: 'hsl(var(--primary), 0.7)',
              fontWeight: '400',
              margin: '0',
              marginBottom: '1rem',
              paddingInlineStart: '1.25rem',
              paddingTop: '0.5rem',
              textIndent: '-3px'
            },
            strong: {
              color: 'hsl(var(--primary))'
            },
            code: {
              backgroundColor: 'hsl(var(--background-secondary))',
              color: 'hsl(var(--primary), 0.7)',
              fontFamily: 'Consolas, monospace',
              fontWeight: '400',
              padding: '5px',
              textIndent: '-3px',
              wordBreak: 'break-word',
              // Whole pixels (typography audit item 1): 14.4px put every inline
              // <code> run on a fractional glyph scale and, paired with a
              // fractional line box, pushed the rest of the paragraph off the
              // device pixel grid.
              fontSize: '14px',
              lineHeight: '20px'
            },
            /**
             * ★★★ THE LAST FRACTIONAL LEAK, AND WHERE IT CAME FROM
             * (2026-08-13, typography pass 2).
             *
             * After the first pass rounded every literal `text-[N.Mpx]` in
             * source to a whole pixel, the rendered census STILL reported one
             * fractional size app-wide: 11.25px, on a real post
             * (`/hive/@lordbutterfly/killing-hives-...`). There is no `11.25`
             * anywhere in the repo. It was `sub, sup { font-size: 75% }` —
             * Preflight, not us — landing on a 15px comment body: 0.75 x 15.
             * That one is fixed in `globals.css`; the rules below are the same
             * trap in this file's own plugin, and they were live but unhit.
             *
             * `@tailwindcss/typography` sizes every prose child in `em`:
             * pre/table/figcaption/kbd at `0.875em`, `lead` at `1.25em`,
             * heading code at `0.875em`/`0.9em`. Those are whole ONLY when the
             * container is a multiple of 8 — true for a bare `.prose` (1rem =
             * 16px, e.g. the static pages) and for `.prose-sm` (14px), which is
             * why the census never caught them. But our two real reading
             * containers are NOT multiples of 8: `postClassName` is 17px and
             * `commentClassName` is 13/14/15px. On a post body a `<table>`
             * computed 0.875 x 17 = 14.875px, a `pre` the same, a `lead`
             * 21.25px; on a comment, 13.125px. Every one of those drags its
             * block off the pixel grid exactly like 11.25px did — they were
             * waiting for a post that happens to contain a table.
             *
             * Fix: absolute whole pixels, matching the `code` decision three
             * keys up (14px/20px). Code, pre, tables and captions are all
             * "supporting matter inside prose" and now render at one size in
             * every reading container instead of four sizes that depend on
             * which container they landed in. 14px is a step on the scale at
             * the top of this file.
             */
            pre: {
              color: 'hsl(var(--primary), 0.7)',
              backgroundColor: 'hsl(var(--background-secondary))',
              margin: '0',
              padding: '7px',
              fontSize: '14px',
              lineHeight: '20px'
            },
            'pre code': {
              // The plugin resets nested code to `1em` of the <pre>; keep that
              // relationship but make it explicit, so a future change to `pre`
              // cannot silently make it fractional again.
              fontSize: '14px',
              lineHeight: '20px'
            },
            'h2 code': {
              fontSize: '14px'
            },
            'h3 code': {
              fontSize: '14px'
            },
            kbd: {
              fontSize: '14px'
            },
            figcaption: {
              fontSize: '13px',
              lineHeight: '20px'
            },
            '[class~="lead"]': {
              fontSize: '20px',
              lineHeight: '30px'
            },
            table: {
              marginBottom: '16px',
              borderCollapse: 'collapse',
              width: '100%',
              overflowX: 'auto',
              border: '1px solid hsl(var(--secondary))',
              // 16px/24px, NOT the 14px used for code above: `td` two keys down
              // has been an explicit 16px/24px since the first pass, and `td`
              // wins on specificity, so the table's own `0.875em` only ever
              // reached the <th> row — which therefore rendered 14.875px on a
              // post and 13.125px in a comment while the cells beside it were
              // 16px. Matching `table` (and so `th`) to the cells fixes the
              // fraction AND the header/body split in one move, and leaves the
              // visible bulk of every existing table byte-identical.
              fontSize: '16px',
              lineHeight: '24px'
            },
            th: {
              color: 'hsl(var(--primary))'
            },
            tr: {
              backgroundColor: 'hsl(var(--background-secondary))',
              '&:nth-child(even)': {
                backgroundColor: 'hsl(var(--background))'
              }
            },
            td: {
              border: '1px solid hsl(var(--secondary))',
              verticalAlign: 'middle',
              // Whole pixels (typography audit item 1) — was `4px 6.4px` / 16.3px.
              padding: '4px 6px',
              fontSize: '16px',
              lineHeight: '24px'
            },
            ol: {
              marginBottom: '1rem',
              marginInlineStart: '0.75rem',
              marginTop: '0'
            },
            ul: {
              marginBottom: '1rem',
              marginInlineStart: '0.75rem',
              marginTop: '0'
            },
            li: {
              margin: '0',
              padding: '0'
            },
            img: {
              marginBottom: '10px',
              marginTop: '0'
            },
            hr: {
              margin: '20px 0'
            }
          }
        }
      }
    }
  },
  plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')]
};
