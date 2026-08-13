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
        // ★ TOKENS RENAMED TO MATCH REALITY (2026-08-13, typography audit item
        // 5). These used to be `--font-inter` and `--font-source-serif` while
        // `app/layout.tsx` bound Open Sans and Lora to them — three layers of
        // naming drift (Inter -> Open Sans, Source Serif -> Lora, Source Sans
        // Pro -> Open Sans) that made every reader of this file believe a font
        // was in use that has not been in the bundle for a long time.
        // Redesign typography (handoff-v2): Open Sans for ALL UI/numbers, Lora
        // for body prose.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'Helvetica', 'Arial', 'sans-serif'],
        serif: ['var(--font-serif)', 'Georgia', 'Cambria', 'serif'],
        // Unchanged, carried over from the shared config (this object replaces
        // it wholesale rather than spreading it).
        consolas: ['Consolas', '"Liberation Mono"', 'Courier', 'monospace']
        // ★ `sanspro` and `source` DELETED (2026-08-13, typography audit item
        // 4). Both were byte-identical duplicates of `sans` / `serif` above:
        // `font-sanspro` read like it was selecting a third face ("Source Sans
        // Pro") and silently produced Open Sans, which is how the comment
        // renderer ended up in a different family from the post body without
        // anyone noticing. `font-source` had zero usages left. Every remaining
        // `font-sanspro` call site has been rewritten to the utility it
        // actually meant.
      }
    }
  }
};
