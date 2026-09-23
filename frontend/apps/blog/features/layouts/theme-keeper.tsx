'use client';

import { useEffect } from 'react';
import { applyTheme, displayTheme } from '@/blog/lib/theme';

/**
 * ════ RE-ASSERTS THE THEME AFTER REACT REBUILDS <html> ════
 *
 * ★★★ THIS EXISTS BECAUSE OF A REAL, MEASURED HOLE, NOT AS A BELT-AND-BRACES.
 * `THEME_INIT_SCRIPT` writes `class`, `data-theme` and `style.color-scheme` onto
 * <html> before the first paint, and on an ordinary route React reconciles that
 * element and leaves them alone (`suppressHydrationWarning` in app/layout.tsx).
 * On Next's ERROR path it does not reconcile it, it renders a different one —
 * the 404 ships as `<html id="__next_error__">` — and every attribute the script
 * set is gone by the time hydration finishes.
 *
 * Measured on the production build at 127.0.0.1:3011, `/@nonexistent-account-xyz`
 * with `theme=dark` in storage: `data-theme` null, `classList.contains('dark')`
 * false, `body` background rgb(252,250,248). The whole 404 rendered light with a
 * theme toggle on it showing neither button seated — which is what made it
 * visible, since that control's selected state is painted from the attribute.
 * `/healthchecker` shows the same thing because it calls `notFound()` in
 * production. Both are ROUTES A READER REACHES, not edge cases.
 *
 * ★★ AN EFFECT IS THE ONLY INSTRUMENT THAT WORKS HERE. The script cannot win —
 * it runs before React, and React is what removes its work. So the theme has to
 * be stated again after hydration. That costs one frame of light on the error
 * path only; on every other route the attributes were never lost, `applyTheme`
 * writes the values that are already there, and nothing repaints.
 *
 * ★ IT RE-DECIDES FROM STORAGE, NOT FROM THE DOM. `readTheme()` would ask the
 * element whose attributes have just been wiped and confidently answer "light".
 * `displayTheme()` asks the same sources the inline script asks (Inquisition mode,
 * then the stated theme, then the system), in the same order, so the two can never
 * disagree.
 */
export default function ThemeKeeper() {
  useEffect(() => {
    applyTheme(displayTheme());
  }, []);
  return null;
}
