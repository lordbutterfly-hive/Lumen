const shared = require('@hive/tailwindcss-config/tailwind.config');

/** @type {import('tailwindcss').Config} */
module.exports = {
  ...shared,
  theme: {
    ...shared.theme,
    extend: {
      ...shared.theme.extend,
      fontFamily: {
        ...shared.theme.extend.fontFamily,
        // Redesign typography (handoff-v2): Open Sans for ALL UI/numbers, Lora for body prose.
        // The CSS vars keep their old names (see layout.tsx) so only the family bound to each changes.
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'Helvetica', 'Arial', 'sans-serif'],
        serif: ['var(--font-source-serif)', 'Georgia', 'Cambria', 'serif'],
        // Remap denser's OWN font utilities so Open Sans + Lora apply app-wide,
        // not just to the new components (denser uses font-sanspro / font-source everywhere).
        sanspro: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'Helvetica', 'Arial', 'sans-serif'],
        source: ['var(--font-source-serif)', 'Georgia', 'Cambria', 'serif']
      }
    }
  }
};
