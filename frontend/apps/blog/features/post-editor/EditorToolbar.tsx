import { FC, RefObject } from "react";
import { EditorView } from "@codemirror/view";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@ui/components/tooltip";
import { Icons } from "@ui/components/icons";
import type { ToolbarButton } from "./lib/toolbar-config";
import { ICON_CLASS } from "./lib/toolbar-config";
import { FORMATTING_TOOLBAR_LABEL, SPOILER_LABEL } from "./lib/composer-copy";

interface EditorToolbarProps {
  toolbarButtons: ToolbarButton[];
  isBlockedUser: boolean;
  onToolbarClick: (action: (view: EditorView) => void) => void;
  onSpoilerClick: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  t: (key: string) => string;
}

/**
 * ★ NAME EVERY GLYPH (2026-08-10, fuckery list C-10 / A-3).
 *
 * Measured before this change: sixteen icon-only buttons, and exactly ONE of
 * them ("Select image") carried an accessible name. The rest had no
 * `aria-label`, no `title` and no text — a screen reader announced them as
 * "button", and the Radix tooltip that holds the real name only appears on
 * hover, which a keyboard or touch reader never triggers. The name already
 * exists in `toolbar-config.tsx` (`btn.title`); it simply was not being handed
 * to the accessibility tree. It is now, keyboard shortcut included, so the
 * spoken name matches the tooltip exactly.
 *
 * ★ AND THIS BAR NO LONGER HOLDS SETTINGS (C-5). "Optimize images" and "Convert
 * Hive links" were two native OS checkboxes (measured `appearance: auto`, no
 * `aria-label`) parked at the right-hand end of a FORMATTING toolbar. They are
 * neither formatting nor per-click actions: they are persistent preferences
 * stored in localStorage that change what happens on paste and on upload. They
 * now live in their own strip under the editor — see `EditorOptionsBar`.
 */
const EditorToolbar: FC<EditorToolbarProps> = ({
  toolbarButtons,
  isBlockedUser,
  onToolbarClick,
  onSpoilerClick,
  inputRef,
  t,
}) => {
  return (
    <div
      className="flex flex-wrap items-center gap-0.5 border-b border-border bg-background-secondary/50 px-1 py-1"
      data-testid="editor-toolbar"
      role="toolbar"
      aria-label={FORMATTING_TOOLBAR_LABEL}
    >
      {toolbarButtons.map((btn) => {
        if (btn.name === "image" && isBlockedUser) return null;
        const label = btn.shortcut ? `${btn.title} (${btn.shortcut})` : btn.title;
        return (
          <TooltipProvider key={btn.name}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-name={btn.name}
                  tabIndex={-1}
                  aria-label={label}
                  className="flex h-7 w-7 items-center justify-center rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onToolbarClick(btn.action)}
                >
                  {btn.icon}
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}

      {!isBlockedUser && (
        <>
          <div className="mx-0.5 h-4 w-px bg-border" />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-name="text2image"
                  tabIndex={-1}
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={t("submit_page.insert_images_text")}
                  onClick={() => inputRef.current?.click()}
                >
                  <Icons.paperclip className={ICON_CLASS} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {t("submit_page.insert_images_text")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </>
      )}

      <div className="mx-0.5 h-4 w-px bg-border" />

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-name="spoiler"
              tabIndex={-1}
              aria-label={SPOILER_LABEL}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={onSpoilerClick}
            >
              <Icons.eyeOff className={ICON_CLASS} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{SPOILER_LABEL}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

export default EditorToolbar;
