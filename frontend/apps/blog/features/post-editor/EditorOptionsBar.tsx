"use client";

import { FC } from "react";
import { Checkbox } from "@ui/components/checkbox";
import { Icons } from "@ui/components/icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import { EDITOR_OPTIONS_LABEL } from "./lib/composer-copy";

interface EditorOptionsBarProps {
  isBlockedUser: boolean;
  convertHiveLinks: boolean;
  setConvertHiveLinks: (value: boolean) => void;
  optimizeImages: boolean;
  setOptimizeImages: (value: boolean) => void;
  t: (key: string) => string;
}

/**
 * ★ PERSISTENT SETTINGS, OUT OF THE FORMATTING TOOLBAR (2026-08-10, C-5 / A-3).
 *
 * These two switches used to be raw `<input type="checkbox">` elements wedged
 * into the right-hand end of the formatting toolbar. Two things were wrong with
 * that, both measured on the live page:
 *
 *  1. OFF-SYSTEM. `getComputedStyle(...).appearance` came back `auto` for both,
 *     i.e. the browser's own native checkbox, which matches nothing else in
 *     Lumen. They are now the house `Checkbox` (Radix + the design tokens),
 *     the same control the advanced-settings dialog uses.
 *  2. WRONG HOME. A formatting toolbar holds one-shot actions on the current
 *     selection: bold, quote, table. These two are neither. They are
 *     preferences kept in localStorage (`convert-hive-links`, `optimize-images`)
 *     that change what happens on a future paste or upload, and they outlive the
 *     document. Mixing a persistent setting in among sixteen momentary actions
 *     makes both harder to read.
 *
 * Also: neither had an accessible name (A-3). A `<label>` wrapping the control
 * plus visible text gives one, so this strip needs no `aria-label` of its own.
 */
const EditorOptionsBar: FC<EditorOptionsBarProps> = ({
  isBlockedUser,
  convertHiveLinks,
  setConvertHiveLinks,
  optimizeImages,
  setOptimizeImages,
  t,
}) => {
  const rowClass = "flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground";

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 border-x border-t border-border bg-background-secondary/50 px-3 py-2"
      data-testid="editor-options-bar"
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#c0392b]/70">
        {EDITOR_OPTIONS_LABEL}
      </span>

      <label className={rowClass} data-testid="convert-hive-links-option">
        <Checkbox
          checked={convertHiveLinks}
          onCheckedChange={(checked) => setConvertHiveLinks(checked === true)}
        />
        {t("submit_page.convert_hive_links")}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger type="button" tabIndex={-1} aria-hidden>
              <Icons.info className="h-3 w-3" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {t("submit_page.convert_hive_links_tooltip")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </label>

      {!isBlockedUser && (
        <label className={rowClass} data-testid="optimize-images-option">
          <Checkbox
            checked={optimizeImages}
            onCheckedChange={(checked) => setOptimizeImages(checked === true)}
          />
          {t("submit_page.optimize_images")}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger type="button" tabIndex={-1} aria-hidden>
                <Icons.info className="h-3 w-3" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {t("submit_page.optimize_images_tooltip")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </label>
      )}
    </div>
  );
};

export default EditorOptionsBar;
