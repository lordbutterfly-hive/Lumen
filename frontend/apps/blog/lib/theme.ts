/**
 * ════ LIGHT / DARK: ONE KEY, ONE CLASS, NO PROVIDER ════
 *
 * ★★★ THIS RE-OPENS A CLOSED RULING, ON PURPOSE (owner, 2026-09-18: "dark light
 * mode get 2 icons on left navbar on bottom easy to switch between them").
 *
 * The 2026-08-11 ruling recorded in `features/layouts/providers.tsx` removed
 * `next-themes` and every `dark:` variant, and `app/layout.tsx` has been actively
 * DELETING the reader's `theme` key on every load since 2026-08-16. That ruling was
 * not "dark is wrong", it was "dark is broken and unreachable, so stop paying for
 * it": no toggle existed, and forcing the class left the header and cards white and
 * the sidebar unreadable. Both halves are being fixed together — this file is the
 * reachable part, the `.dark` palette work is the correct part. Neither is worth
 * shipping without the other, which is exactly the trap the old ruling was avoiding.
 *
 * ★★ NO PROVIDER, AND NO DEPENDENCY. `next-themes` is no longer in this app's
 * package.json and is not being added back. What it buys over the twenty lines here
 * is system-preference listening and cross-tab sync, both of which are below — and
 * what it costs is a client provider wrapping the whole tree for one string. The
 * theme is a class on <html>; nothing in React needs to know it.
 *
 * ★★★ `data-theme` EXISTS SO THE TOGGLE NEEDS NO HYDRATION. The class alone would
 * force the control to read the DOM in an effect, which means the server renders
 * "neither button is selected" and the client corrects it a frame later — a visible
 * flicker on the one control whose entire job is to show which theme you are in. The
 * attribute lets CSS answer instead (`html[data-theme='dark'] .moon { ... }`), so the
 * selected state is painted by the same inline script that sets the class, before
 * React is on the page at all. The class stays because `darkMode: ['class']` in
 * tailwind.config.js keys every `dark:` variant off it; the attribute is additive.
 */

export const THEME_STORAGE_KEY = 'theme';

export type Theme = 'light' | 'dark';

/**
 * The browser-chrome colours, kept beside the palette they have to agree with.
 * `light` is the measured `getComputedStyle(document.body).backgroundColor` the
 * `viewport` export in layout.tsx already carried; `dark` is `--background` from the
 * `.dark` block in globals.css. If either ground moves, this moves with it or the
 * browser chrome and the page disagree by a visible step.
 */
export const THEME_COLORS: Record<Theme, string> = {
  light: '#f7f7f7',
  dark: '#0e0f11'
};

/**
 * Applied to <html> by both the inline script and the toggle, so there is one
 * definition of "being in a theme" rather than two that can drift.
 *
 * `color-scheme` is not decoration: it is what makes the scrollbar, the form
 * controls, and `<input type="date">`'s picker follow the theme. Without it a dark
 * page keeps a white scrollbar and light native widgets, which reads as a rendering
 * fault rather than a choice.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode, blocked storage: the choice does not survive a reload, but it
    // still applies to this page. Failing to persist must never fail to switch.
  }
  applyTheme(theme);
}

export function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * The stated preference, or the system's — the SAME decision `THEME_INIT_SCRIPT`
 * makes, in TypeScript. Deliberately does NOT read the DOM, unlike `readTheme()`:
 * this is the function for re-deciding when the DOM's answer has been lost.
 */
export function resolveTheme(): Theme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* blocked storage: fall through to the system preference */
  }
  if (stored === 'dark' || stored === 'light') return stored;
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * ★★★ THIS STRING RUNS BEFORE THE FIRST PAINT, WHICH IS THE WHOLE POINT.
 *
 * A theme restored in a React effect is a theme the reader watches arrive: the page
 * paints light, then flips. The only way to avoid it is a synchronous script in
 * <head>, before the stylesheet has anything to apply the class to. That is why this
 * is a string rather than an imported function — it has to be inlined into the
 * document, and it must not wait for a chunk.
 *
 * ★★ IT IS THE SAME SCRIPT TAG THAT USED TO DELETE THE KEY. `lumen-clear-dead-theme-key`
 * (QA Low-4, 2026-08-16) ran `localStorage.removeItem('theme')` on every load because
 * nothing read the key any more. Something does now. Replacing that script rather
 * than adding a second one matters for readers who still carry a value from before
 * the removal: the remover and the reader would otherwise race inside one document,
 * and which won would depend on tag order — a bug that only ever shows on the first
 * load after an upgrade, which is the hardest kind to be told about.
 *
 * ★ NO STORED VALUE MEANS FOLLOW THE SYSTEM, not "light". A reader whose OS is dark
 * has already stated a preference; making them state it again on every new device is
 * the thing `prefers-color-scheme` exists to prevent. An explicit choice always wins
 * over it, and only an explicit choice is written to storage — so "follow my system"
 * stays live and keeps tracking until the reader overrides it.
 *
 * Wrapped in try/catch because `localStorage` THROWS rather than returning null on a
 * blocked-cookies origin, and an uncaught throw here would take out the chunk-error
 * guard and the env script that share this head.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var s=null;try{s=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}
var d=s==='dark'||(s!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
var r=document.documentElement;
r.classList.toggle('dark',d);r.dataset.theme=d?'dark':'light';r.style.colorScheme=d?'dark':'light';
}catch(e){}})();`;

/**
 * Keeps a reader who has NOT chosen tracking their system, and keeps two open tabs
 * agreeing after a choice in either. Returns its own teardown.
 *
 * The `storage` event fires in every tab EXCEPT the one that wrote, which is what
 * makes it the right instrument here: the writing tab has already applied the change
 * itself, so there is no echo to guard against.
 */
export function watchTheme(): () => void {
  const onSystem = (event: MediaQueryListEvent) => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      /* blocked storage: treat as "no explicit choice" and follow the system */
    }
    if (stored === 'light' || stored === 'dark') return;
    applyTheme(event.matches ? 'dark' : 'light');
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyTheme(event.newValue === 'dark' ? 'dark' : 'light');
  };
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener('change', onSystem);
  window.addEventListener('storage', onStorage);
  return () => {
    mq?.removeEventListener('change', onSystem);
    window.removeEventListener('storage', onStorage);
  };
}
