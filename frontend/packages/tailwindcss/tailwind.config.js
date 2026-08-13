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
