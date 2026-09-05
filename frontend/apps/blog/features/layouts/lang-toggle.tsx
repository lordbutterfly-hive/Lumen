'use client';

import * as React from 'react';
import { Button } from '@ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@ui/components/dropdown-menu';
import { useState } from 'react';
import clsx from 'clsx';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import TooltipContainer from '@ui/components/tooltip-container';
import { getLanguage, setLanguage } from '../../utils/language';
import { languages as supportedLocales, defaultLocale } from '@/blog/i18n/settings';
import { useRouter } from 'next/navigation';

/**
 * ★★★ NAMES, NOT FLAGS AND NOT ISO CODES (2026-08-13, audit §1.2).
 *
 * This menu used to be nine flag emoji plus the bare ISO code — `🇵🇱 pl`,
 * `🇯🇵 ja`, and `عر ar` for Arabic, which has no flag to borrow. Two separate
 * problems, both confirmed live on the shipped build:
 *
 *  1. NOTHING NAMED A LANGUAGE. `pl` is not a word a Polish reader is looking
 *     for; `Polski` is. The audit's whole read of this menu — "the menu lists
 *     locales as raw ISO codes, not language names" — is that.
 *  2. THE FLAGS DID NOT RENDER. On the audited machine every flag came out as
 *     the two-letter regional-indicator fallback box, so the menu read as a
 *     column of broken glyphs. That is a font question no CSS here can answer,
 *     and it is not worth answering: a flag is a COUNTRY, and a language is not
 *     one. 🇪🇸 is wrong for the ~90% of Spanish speakers outside Spain, 🇬🇧 is
 *     wrong for most English speakers, and Arabic gets no flag at all — which is
 *     precisely why the old list had to hand-write `عر` for that one row.
 *
 * So each row is now the language's own name in its own script (the endonym —
 * what a reader who cannot read the current UI language will actually
 * recognise), with the ISO code kept as a small muted tag beside it. The tag is
 * not decoration: it keeps `data-testid={locale}` on a real element, which the
 * e2e suite's `languageMenuPl` locator (`[data-testid="pl"]` -> parent) and the
 * account-menu typeahead both already depend on.
 *
 * `lang`/`dir` on each name make the browser pick the right font and shape
 * Arabic right-to-left inside an otherwise LTR menu.
 */
const LANGUAGE_ENDONYMS: Record<string, string> = {
  ar: 'العربية',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  pl: 'Polski',
  ru: 'Русский',
  zh: '中文'
};

/** Right-to-left locales among the supported set — currently Arabic only, same test the root layout makes. */
const RTL_LOCALES = new Set(['ar']);

/**
 * Derived from `i18n/settings.ts` rather than re-listed here, so a locale added
 * to `languages` (the array `getOptions` validates against and `setLanguage`
 * gates on) cannot silently fail to appear in the only UI that can select it.
 */
const languages = supportedLocales.map((locale) => ({
  locale,
  name: LANGUAGE_ENDONYMS[locale] ?? locale
}));

const META_CLASS = 'shrink-0 font-sans text-label uppercase text-ink-9 tracking-label';

/**
 * ★ SUBMENU MODE (2026-08-13, QA V3-a11y item 2 / O5 build map item 1c
 * follow-up). `renderAs="submenu"` embeds the language list INSIDE another
 * Radix `DropdownMenu` (currently: the account menu, `user-menu.tsx`)
 * instead of standing up a second one.
 *
 * That second Root was the actual bug, not just the wrapper `<div>` that
 * used to sit around it. This component cannot take the `asChild` treatment
 * every other account-menu row got, because its outermost node was a
 * `<DropdownMenu>` Root — a context provider, not a DOM element, so there is
 * nothing for `Slot` to merge `menuitem` props onto. Lifting it OUT of
 * `DropdownMenuItem` (the previous fix) avoided the "button inside
 * `role=menuitem`" shape, but left it a plain `<div>` wrapper with no
 * connection to the PARENT menu's collection at all — confirmed twice live:
 * 12 consecutive ArrowDown presses through the open account menu never once
 * focused it, because Radix's roving-focus/typeahead collection only tracks
 * registered collection items, and this wasn't one.
 *
 * `DropdownMenu.Sub` is Radix's own primitive for exactly this shape — "a
 * menu item that opens another list of choices" — and it does not create a
 * second Root: `DropdownMenuSubTrigger` is built on the identical
 * `MenuItemImpl` every plain `DropdownMenuItem` uses (verified in the
 * installed package, `@radix-ui/react-menu@2.1.4/dist/index.mjs:617-716` —
 * it goes through `Collection.ItemSlot` + `RovingFocusGroup.Item`, so it IS
 * a real, single-DOM-node member of the PARENT's roving/typeahead
 * collection, registered against the parent's own scope), while
 * `DropdownMenuSubContent` (the 9-language list) still portals its own
 * floating panel. Opening/closing follows the same `data-radix-menu-content`
 * marker the account menu's own Tab-close handler already keys off, so nothing
 * there needed to change — a Tab pressed while the language list is open is
 * still correctly recognised as "inside a nested content," and a Tab pressed
 * on the trigger row itself still closes the account menu exactly like every
 * other row does today.
 *
 * The standalone `renderAs="menu"` path (default) is unchanged and stays
 * available for any future call site that is NOT nested inside another menu.
 */
export default function LangToggle({
  logged,
  className,
  renderAs = 'menu'
}: {
  logged: Boolean;
  className?: string;
  renderAs?: 'menu' | 'submenu';
}) {
  const router = useRouter();
  const [lang, setLang] = useState(getLanguage());
  const { t } = useTranslation('common_blog');

  const handleLanguageChange = (locale: string) => {
    setLanguage(locale);
    setLang(locale);
    router.refresh();
  };

  const currentLocale = lang && LANGUAGE_ENDONYMS[lang] ? lang : defaultLocale;
  const currentLabel = LANGUAGE_ENDONYMS[currentLocale];

  const languageItems = languages.map(({ locale, name }) => (
    <DropdownMenuItem
      key={locale}
      onClick={() => handleLanguageChange(locale)}
      // The selected row has to be announceable, not just visually obvious --
      // this list is the one place a reader who cannot read the current UI
      // language has to be able to orient themselves.
      aria-current={locale === currentLocale ? 'true' : undefined}
      className="flex items-center justify-between gap-6"
    >
      <span lang={locale} dir={RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'}>
        {name}
      </span>
      <span data-testid={locale} className={META_CLASS}>
        {locale}
      </span>
    </DropdownMenuItem>
  ));

  // The row reads like every other row in the account menu: what it is on the
  // left, its current value quietly on the right ("Your tokens ... 3 held",
  // "Language ... Polski"). Before this it led with the (unrenderable) flag and
  // ran it straight into the word, giving "🇵🇱Language".
  const currentValue = (
    <span
      lang={currentLocale}
      dir={RTL_LOCALES.has(currentLocale) ? 'rtl' : 'ltr'}
      // ★ Visual alignment (2026-09-05, owner: account-menu polish). In
      // submenu mode this span is the right-hand meta of an ACCOUNT-MENU row,
      // sitting directly under "3 held" / "◈ @handle" — which render via
      // user-menu.tsx's META_CLASS (14px caption on the rows' 22px line box).
      // META_CLASS here is the 12px tracked-uppercase LABEL treatment, so the
      // meta column read as two different type styles one row apart. Written
      // out literally (not clsx(META_CLASS, ...)) because clsx does no
      // conflict resolution: emitting text-label AND text-caption together
      // would leave the winner to stylesheet order. The standalone
      // header-button path keeps the exact classes it had.
      className={
        renderAs === 'submenu'
          ? // ★ 2026-09-05, owner: put the value ("English") at the far right, aligned with
            // the other rows' metas ("3 held"), with the submenu chevron to its LEFT. The
            // shared SubTrigger appends `<ChevronRight class="ml-auto">` AFTER children, so
            // `order-last` renders this value after that chevron, and the chevron's ml-auto
            // pushes the [chevron, value] pair to the right. (Row uses justify-start below,
            // so this is the only thing positioning the pair.)
            'order-last shrink-0 font-sans text-caption leading-[22px] text-ink-9'
          : clsx(META_CLASS, 'ml-auto normal-case')
      }
      data-testid="current-language"
    >
      {currentLabel}
    </span>
  );

  if (renderAs === 'submenu') {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="toggle-language" className={cn(className, 'justify-start')}>
          <span>{logged ? t('navigation.user_menu.toggle_lang') : t('navigation.main_nav_bar.language')}</span>
          {currentValue}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="rounded-2xl border border-line-9 bg-surface-1 p-2 shadow-[0_12px_34px_rgba(20,18,10,0.12)]">
          {languageItems}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenu>
      <TooltipContainer title={t('navigation.main_nav_bar.language')}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={clsx('flex h-10 w-full gap-2 p-0 text-start font-normal', className, {
              'h-6': logged
            })}
            data-testid="toggle-language"
          >
            <span>{logged ? t('navigation.user_menu.toggle_lang') : t('navigation.main_nav_bar.language')}</span>
            {currentValue}
          </Button>
        </DropdownMenuTrigger>
      </TooltipContainer>
      <DropdownMenuContent align="end">{languageItems}</DropdownMenuContent>
    </DropdownMenu>
  );
}
