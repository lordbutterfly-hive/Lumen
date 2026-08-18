"use client";

import { Dispatch, SetStateAction } from "react";
import { Icons } from "@ui/components/icons";
import { useTranslation } from "@/blog/i18n/client";

interface PostFormHeaderProps {
  sideBySide: boolean;
  setSideBySide: Dispatch<SetStateAction<boolean>>;
  preview: boolean;
  setPreview: Dispatch<SetStateAction<boolean>>;
}

/**
 * ★ TWO CONTROLS THAT DID NOT LOOK LIKE CONTROLS (2026-08-10, fuckery list C-11).
 *
 * Measured live before this change: both were `variant="ghost"` buttons rendering
 * at `background rgba(0,0,0,0)`, `border-width 0px`, `color rgb(100,116,139)` —
 * i.e. plain grey sentences sitting on a grey strip. Nothing said "click me": no
 * border, no fill, no underline, and `tabIndex={-1}` also kept them out of the
 * keyboard order, so a keyboard reader could not reach them at all. Two of the
 * three layout switches in the composer were effectively invisible affordances.
 *
 * They are now bordered pills on the house radius (14px rows/buttons) with an
 * icon that states which way the switch is pointing, and they are focusable.
 * The `data-testid`s are unchanged — `playwright/tests/support/pages/
 * postEditorPage.ts` addresses both by testid.
 */
// ★ `line-brand-10` / `ink-brand-6`, not `#c0392b` (2026-08-14 token-migration
// pass): rgb(192,57,43), byte-identical to the literal in light mode, and
// picks up the dark-mode lift the literal never had. `--destructive` renders
// a visibly different red (rgb(218,43,43)) and is reserved for the vote
// control only.
const TOGGLE_CLASS =
  "inline-flex items-center gap-1.5 rounded-card border border-[#ebebeb] bg-white px-3 py-1.5 text-xs font-medium text-[#6b7280] transition-colors hover:border-line-brand-10 hover:text-ink-brand-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10/40";

export function PostFormHeader({ sideBySide, setSideBySide, preview, setPreview }: PostFormHeaderProps) {
  const { t } = useTranslation("common_blog");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={TOGGLE_CLASS}
        onClick={() => setSideBySide((prev) => !prev)}
        data-testid="enable-disable-side-by-side-editor"
        aria-pressed={sideBySide}
      >
        {sideBySide ? (
          <Icons.layoutList className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Icons.layoutGrid className="h-3.5 w-3.5" aria-hidden />
        )}
        {sideBySide ? t("submit_page.disable_side") : t("submit_page.enable_side")}
      </button>
      <button
        type="button"
        onClick={() => setPreview((prev) => !prev)}
        className={TOGGLE_CLASS}
        data-testid="hide-show-preview"
        aria-pressed={preview}
      >
        {preview ? (
          <Icons.eyeOff className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Icons.eye className="h-3.5 w-3.5" aria-hidden />
        )}
        {preview ? t("submit_page.hide_preview") : t("submit_page.show_preview")}
      </button>
    </div>
  );
}
