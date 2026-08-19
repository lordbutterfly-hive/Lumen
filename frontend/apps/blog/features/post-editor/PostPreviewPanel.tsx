"use client";

import { Dispatch, RefObject, SetStateAction, useState } from "react";
import clsx from "clsx";
import { Link } from "@hive/ui";
import { Button } from "@hive/ui/components/button";
import { Icons } from "@ui/components/icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import { useTranslation } from "@/blog/i18n/client";
import RendererContainer from "@/blog/features/post-rendering/rendererContainer";
import { postClassName } from "@/blog/features/post-editor/lib/utils";
import { previewGateHolds } from "@/blog/features/post-editor/lib/preview-gate";
import { stripUnfilledTrailingMarker } from "@/blog/features/post-editor/lib/list-markers";
import { SYNC_SCROLL_OFF, SYNC_SCROLL_ON } from "@/blog/features/post-editor/lib/composer-copy";

interface PostPreviewPanelProps {
  preview: boolean;
  sideBySide: boolean;
  syncScroll: boolean;
  setSyncScroll: Dispatch<SetStateAction<boolean>>;
  previewContainerRef: RefObject<HTMLDivElement>;
  previewContent: string | undefined;
  proxyAuthToken: string | undefined;
}

export function PostPreviewPanel({
  preview,
  sideBySide,
  syncScroll,
  setSyncScroll,
  previewContainerRef,
  previewContent,
  proxyAuthToken,
}: PostPreviewPanelProps) {
  const { t } = useTranslation("common_blog");
  /**
   * ★★★ THE ESCAPE HATCH USED TO BE PERMANENT, WHICH DISARMED THE GUARD (2026-08-10).
   *
   * "Render preview anyway" set a plain boolean that nothing ever reset, so one
   * click at 250k characters left the 200k gate off for the rest of the session —
   * and the next paste, at any size, went straight to the renderer. The feature
   * whose entire job is to stop a multi-MB paste freezing the tab could be turned
   * off by a click at a size that was never dangerous, and the freeze it exists to
   * prevent came back on the following paste.
   *
   * So the opt-in is stored as a SIZE, not a flag: the number of characters the
   * writer accepted the wait for. Rendering stays allowed while the document is
   * within one more gate's worth of that — ordinary typing never covers 200,000
   * characters, so it never re-arms mid-sentence, while a multi-MB paste blows
   * straight past it and the gate closes again. Cost is what the guard actually
   * cares about: main-thread time is proportional to size, and this is a budget on
   * size.
   */
  const [approvedChars, setApprovedChars] = useState<number | null>(null);
  const previewChars = previewContent?.length ?? 0;
  const previewBlocked = previewGateHolds(previewChars, approvedChars);

  return (
    /* ★★★ THE RIGHT HALF OF THE PAGE WAS DEAD BELOW THE FOLD (2026-08-10, C-12).
       Measured: the form column ran 1519px tall while this panel was a fixed
       `h-[80vh]` block at the top of the row. Scroll past the first screen and
       the preview had scrolled away with it, leaving the entire right half of
       the composer as empty white for the rest of the page. A preview you cannot
       see while you write is not a preview.

       `self-start` + `sticky` pins the panel to the viewport as the form scrolls
       underneath it, so it stays beside whatever you are editing. `self-start`
       is not optional: this is a flex row, and a stretched item is as tall as
       the row, which leaves sticky nothing to travel in. Its own inner scroller
       is unchanged, so the sync-scroll pairing still works. */
    <div
      className={clsx("relative flex flex-col lg:w-1/2", {
        hidden: !preview,
        "lg:w-full": !sideBySide,
        "h-[80vh] lg:sticky lg:top-24 lg:h-[calc(100vh-8rem)] lg:self-start": sideBySide,
      })}
      data-testid="preview-container"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-card border border-b-0 border-[#ebebeb] bg-white px-4 py-2">
        {/* Same section-label treatment as the metadata and publishing cards
            (C-14). ★ `ink-brand-6`, not `#c0392b` (2026-08-14): see
            `PostMetadataSection.tsx` for the full reasoning. */}
        <span className="text-label font-semibold uppercase tracking-label text-ink-brand-6/70 dark:text-ink-brand-6">
          {t("submit_page.preview")}
        </span>

        <div className="flex items-center gap-2">
          {/* ★★★ AN UNLABELLED ICON FLOATING IN THE GUTTER (2026-08-10, C-13).
              The scroll-sync toggle used to be a 40px round button parked in the
              7px gap between the two panes, at `opacity: 0.2`, holding a link
              icon and NOTHING else: no `aria-label`, no visible text, and a
              tooltip that only a mouse hover could ever summon. Measured at
              x=701 between the columns. Nobody who did not already know what it
              did could find out.

              It is now a labelled control in the preview header, where the thing
              it governs lives, and it says which state it is in rather than
              which state it would move to. Both `data-testid`s are kept on the
              same elements so `playwright/tests/e2e/syncScroll.spec.ts` (which
              hovers the container, then clicks the toggle) still addresses it. */}
          {sideBySide && (
            <div data-testid="sync-scroll-container">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      // ★ `line-brand-10` / `ink-brand-6`, not `#c0392b`
                      // (2026-08-14): rgb(192,57,43), byte-identical to the
                      // literal in light mode. `--destructive` is a visibly
                      // different red reserved for the vote control only.
                      className="inline-flex items-center gap-1.5 rounded-card border border-[#ebebeb] bg-white px-3 py-1.5 text-caption font-medium text-[#6b7280] transition-colors hover:border-line-brand-10 hover:text-ink-brand-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10/40"
                      onClick={() => setSyncScroll((prev) => !prev)}
                      data-testid="sync-scroll-toggle"
                      aria-pressed={syncScroll}
                    >
                      {syncScroll ? (
                        <Icons.link2 className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Icons.link2Off className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {syncScroll ? SYNC_SCROLL_ON : SYNC_SCROLL_OFF}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {syncScroll
                      ? t("submit_page.disable_sync_scroll")
                      : t("submit_page.enable_sync_scroll")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {/* ★ A LINK THAT LOOKED LIKE A CAPTION (C-11). Measured
              `text-decoration: none`, muted grey, `tabIndex={-1}`: an
              off-site help link with no link affordance and no way to reach it
              from the keyboard. Underlined, given the external-link glyph, and
              put back in the tab order. */}
          <Link
            target="_blank"
            rel="noreferrer"
            href="https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax"
            className="inline-flex items-center gap-1 text-caption text-[#6b7280] underline underline-offset-2 transition-colors hover:text-ink-brand-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10/40"
          >
            {t("submit_page.markdown_styling_guide")}
            <Icons.externalLink className="h-3 w-3" aria-hidden />
          </Link>
        </div>
      </div>
      <div
        ref={previewContainerRef}
        data-testid="preview-scroller"
        className="flex h-full overflow-y-auto overscroll-contain rounded-b-card border border-[#ebebeb] bg-white"
      >
        {previewContent && previewBlocked ? (
          /* ★★★ THE FREEZE, STOPPED AT ITS SOURCE (2026-08-09).
             Debouncing the preview keeps typing responsive, but it does not help
             a single huge PASTE: 300 ms later the whole document still goes to
             the markdown renderer in one synchronous pass. At the 4-5 MB a
             tester measured, the main thread never comes back — the tab is
             killed and the unsaved work goes with it. Debounce fixes repetition;
             only a size limit fixes magnitude, and both were needed.

             Above the limit the preview becomes opt-in instead of automatic. The
             EDITOR stays fully live — nothing about writing or auto-saving is
             degraded — and the reader is told plainly why, with the button to
             render it anyway if they accept the wait.

             ★ And the opt-in is bounded by SIZE, so accepting the wait for this
             document does not silently accept it for a 5 MB one pasted later. See
             `approvedChars` above. */
          <div
            className="flex w-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground"
            data-testid="preview-too-large"
          >
            <Icons.eye className="h-8 w-8 opacity-20" />
            <span className="text-sm">
              Live preview is paused. This draft is {Math.round(previewContent.length / 1000)}k
              characters, and rendering it on every change would freeze the tab. Your text is safe
              and still saving.
            </span>
            <Button
              type="button"
              variant="outlineRed"
              onClick={() => setApprovedChars(previewChars)}
              data-testid="render-huge-preview"
            >
              Render preview anyway
            </Button>
          </div>
        ) : previewContent ? (
          <RendererContainer
            // ★ LOW 12 (2026-08-16): strip a still-empty auto-inserted list/quote
            // marker off the last line before it reaches the renderer — see
            // `stripUnfilledTrailingMarker` in `lib/list-markers.ts` for why this
            // is safe (last line only) and why that helper lives in a
            // `@codemirror/*`-free file rather than in `lib/list-continuation.ts`.
            body={stripUnfilledTrailingMarker(previewContent)}
            author=""
            previewMode
            proxyAuthToken={proxyAuthToken}
            className={postClassName + " w-full min-w-full self-center break-words p-4"}
          />
        ) : (
          <div className="flex w-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
            <Icons.eye className="h-8 w-8 opacity-20" />
            <span className="text-sm">{t("submit_page.preview_placeholder")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
