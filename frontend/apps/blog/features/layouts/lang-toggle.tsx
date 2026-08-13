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
import { useTranslation } from '@/blog/i18n/client';
import TooltipContainer from '@ui/components/tooltip-container';
import { getLanguage, setLanguage } from '../../utils/language';
import { useRouter } from 'next/navigation';

const languages = [
  { locale: 'ar', label: 'عر' },
  { locale: 'en', label: '🇬🇧' },
  { locale: 'es', label: '🇪🇸' },
  { locale: 'fr', label: '🇫🇷' },
  { locale: 'it', label: '🇮🇹' },
  { locale: 'ja', label: '🇯🇵' },
  { locale: 'pl', label: '🇵🇱' },
  { locale: 'ru', label: '🇷🇺' },
  { locale: 'zh', label: '🇨🇳' }
];

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

  const currentLabel = lang ? languages.find((language) => language.locale === lang)?.label : null;

  const languageItems = languages.map(({ locale, label }) => (
    <DropdownMenuItem key={label} onClick={() => handleLanguageChange(locale)}>
      {label}
      <span data-testid={locale}>&nbsp;{locale}</span>
    </DropdownMenuItem>
  ));

  if (renderAs === 'submenu') {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="toggle-language" className={className}>
          <span>{currentLabel}</span>
          {logged ? <span className="ml-2">{t('navigation.user_menu.toggle_lang')}</span> : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="rounded-2xl border border-[#ebebeb] bg-white p-2 shadow-[0_12px_34px_rgba(20,18,10,0.12)]">
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
            className={clsx('flex h-10 w-full p-0 text-start font-normal', className, { 'h-6': logged })}
            data-testid="toggle-language"
          >
            <span>{currentLabel}</span>
            {logged ? <span className="ml-2 w-full">{t('navigation.user_menu.toggle_lang')}</span> : null}
          </Button>
        </DropdownMenuTrigger>
      </TooltipContainer>
      <DropdownMenuContent align="end">{languageItems}</DropdownMenuContent>
    </DropdownMenu>
  );
}
