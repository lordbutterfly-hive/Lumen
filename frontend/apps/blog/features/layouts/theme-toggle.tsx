'use client';

import { useEffect, useState } from 'react';
import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { readTheme, setTheme, watchTheme, type Theme } from '@/blog/lib/theme';
import styles from './theme-toggle.module.css';

/**
 * ════ TWO ICONS AT THE FOOT OF THE RAIL (owner, 2026-09-18) ════
 *
 * "dark light mode get 2 icons on left navbar on bottom easy to switch between
 * them", then "the light dark needs to be a PILL on left navbar containing both and
 * at the bottom of the screen" — so a pair inside one trough, not one button that
 * swaps its own glyph and not two loose icons. The difference is not
 * cosmetic: a single swapping button has to be read twice (what does the icon mean,
 * and does it show the current state or the one I would get?), while two buttons
 * with one seated are a segmented control and answer both at a glance. Every other
 * two-state choice in this app is already shaped that way.
 *
 * ★★ WHICH ONE LOOKS SELECTED IS DECIDED IN CSS — see theme-toggle.module.css. The
 * `selected` state below exists only for `aria-pressed`, which cannot be expressed in
 * a stylesheet, and it is deliberately `null` until mount: on the server there is no
 * document to read, and announcing "light, pressed" to a screen reader on a dark page
 * would be worse than announcing nothing for one frame. The VISUAL state never waits
 * for this, so nothing flickers.
 *
 * ★ `watchTheme()` IS MOUNTED HERE BECAUSE THIS IS THE CONTROL THAT LIES WITHOUT IT.
 * The rest of the page is styled by the class and self-corrects; only this pair has to
 * re-render to move its seat. It keeps a reader who has never chosen following their
 * system, and keeps two open tabs agreeing after a choice in either one.
 */
export default function ThemeToggle() {
  const { t } = useTranslation('common_blog');
  const [selected, setSelected] = useState<Theme | null>(null);

  useEffect(() => {
    setSelected(readTheme());
    const stop = watchTheme();
    // The DOM is the source of truth (the script, the storage event and the system
    // listener all write it), so observing the attribute keeps `aria-pressed` correct
    // no matter which of the three moved it, without duplicating their logic here.
    const observer = new MutationObserver(() => setSelected(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  const choose = (theme: Theme) => {
    setTheme(theme);
    setSelected(theme);
  };

  return (
    <div className={styles.pill} data-testid="theme-toggle" role="group" aria-label={t('navigation.left_rail.theme_group')}>
      <button
        type="button"
        onClick={() => choose('light')}
        aria-pressed={selected === null ? undefined : selected === 'light'}
        aria-label={t('navigation.left_rail.theme_light')}
        title={t('navigation.left_rail.theme_light')}
        className={cn(styles.button, styles.light)}
        data-testid="theme-toggle-light"
      >
        <Icons.sun className={styles.icon} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => choose('dark')}
        aria-pressed={selected === null ? undefined : selected === 'dark'}
        aria-label={t('navigation.left_rail.theme_dark')}
        title={t('navigation.left_rail.theme_dark')}
        className={cn(styles.button, styles.dark)}
        data-testid="theme-toggle-dark"
      >
        <Icons.moon className={styles.icon} aria-hidden="true" />
      </button>
    </div>
  );
}
