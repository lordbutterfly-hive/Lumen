const shared = require('@hive/tailwindcss-config/tailwind.config');

/** @type {import('tailwindcss').Config} */
module.exports = {
  ...shared,
  // ★ `.ts` ADDED (2026-08-13, typography audit item 1). The shared glob is
  // `**/*.{jsx,tsx}` only, so class strings that live in plain `.ts` modules
  // were never seen by the JIT scanner and compiled to NOTHING. Measured on the
  // shipped build before this change: `26.4px`, `23.1px`, `19.2px`, `17.6px`
  // and `30.7px` — every responsive and heading step of `postClassName`
  // (`features/post-editor/lib/utils.ts`) — appear ZERO times in
  // `/_next/static/css/*.css`, while `16.5px` appears once, and only because
  // two `.tsx` files (`medium-post-card.tsx`, `profile-identity.tsx`) happened
  // to use the same value for feed excerpts. So the post body rendered at one
  // size at EVERY breakpoint and its heading ramp never existed. Same trap in
  // `features/account-settings/lib/card.ts`. Scoped to the app's own source
  // directories rather than a bare `**/*.ts`, which would also walk
  // `apps/blog/node_modules`.
  content: [
    ...shared.content,
    './app/**/*.ts',
    './components/**/*.ts',
    './features/**/*.ts',
    './lib/**/*.ts',
    './store/**/*.ts',
    './utils/**/*.ts'
  ],
  theme: {
    ...shared.theme,
    extend: {
      ...shared.theme.extend,
      fontFamily: {
        /**
         * ★★★ ONE FAMILY. LORA (owner ruling, 2026-08-19).
         *
         * `app/layout.tsx` now loads exactly one face and binds it to
         * `--font-lora`. Everything below is an alias of that one variable.
         *
         * `lora` is the truthful name and the one new code should reach for.
         *
         * `sans` and `serif` are COMPATIBILITY ALIASES, kept on purpose. There
         * are ~460 `font-sans` / `font-serif` call sites in this repo; deleting
         * the utilities in the same change that swaps the face would turn a
         * font migration into a 460-file rewrite, and every one of those files
         * would be un-reviewable next to the visual change. They resolve to the
         * same file today, so the swap is provably a font change and nothing
         * else. The call sites migrate to `font-lora` (or to inheriting the
         * body face and carrying no family utility at all) surface by surface.
         *
         * ★ `sans` IS NOW A LIE AND THAT IS THE POINT OF THIS COMMENT. It reads
         * as "select the sans-serif face" and there is no longer one. This file
         * has carried a stale font name three times — Inter, Source Serif,
         * Source Sans Pro — and each time a reader had to already know the
         * history to understand what compiled. It is written down here instead.
         * When the last `font-sans` call site is gone, delete this key.
         *
         * ★ THE FALLBACK STACK IS SERIF ON BOTH. It used to be
         * `ui-sans-serif, system-ui, Helvetica, Arial, sans-serif` on `sans`,
         * which meant a font-load failure repainted the entire UI in a system
         * SANS while the prose next to it fell back to Georgia — two different
         * families in one document, which is worse than either alone. Georgia
         * and Cambria are the closest widely-installed matches to Lora's
         * proportions, so a failed load now degrades to one consistent voice.
         */
        lora: ['var(--font-lora)', 'Georgia', 'Cambria', 'serif'],
        sans: ['var(--font-lora)', 'Georgia', 'Cambria', 'serif'],
        serif: ['var(--font-lora)', 'Georgia', 'Cambria', 'serif'],
        /**
         * ★ MONO IS THE ONE DELIBERATE EXCEPTION (typography spec §7). A serif
         * cannot disambiguate characters in a hex string: wallet addresses,
         * keys, hashes, code blocks and inline `<code>` stay monospace. Prose
         * that merely *looks* technical — dates, ordinary numbers, labels —
         * does not. `consolas` is the pre-existing key and is kept so its call
         * sites keep compiling; `mono` is the name new code should use.
         */
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Cascadia Mono', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
        consolas: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Cascadia Mono', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace']
      }
    }
  }
};
