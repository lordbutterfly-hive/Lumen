"use client";

import clsx from "clsx";
import { UseFormReturn } from "react-hook-form";
import { Badge } from "@hive/ui/components/badge";
import { Input } from "@hive/ui/components/input";
import { FormControl, FormField, FormItem, FormMessage } from "@hive/ui/components/form";
import { Icons } from "@ui/components/icons";
import { useTranslation } from "@/blog/i18n/client";
import {
  validateTagInput,
  validateSummaryInput,
  parseTags,
  MAX_TAGS,
} from "@/blog/features/post-editor/lib/utils";
import { POST_SUMMARY_PLACEHOLDER } from "@/blog/features/post-editor/lib/composer-copy";
import SelectImageList from "@/blog/features/post-editor/select-image-list";
import { AccountFormValues } from "@/blog/features/post-editor/types";

interface PostMetadataSectionProps {
  form: UseFormReturn<AccountFormValues>;
  watchedValues: AccountFormValues;
  postArea: string;
  selectedImg: string;
  setSelectedImg: (img: string) => void;
  proxyAuthToken: string | undefined;
  categoryParam?: string;
}

export function PostMetadataSection({
  form,
  watchedValues,
  postArea,
  selectedImg,
  setSelectedImg,
  proxyAuthToken,
  categoryParam,
}: PostMetadataSectionProps) {
  const { t } = useTranslation("common_blog");

  const tagsRequired = !categoryParam && watchedValues.category === "blog";
  const tagsCheck = validateTagInput(watchedValues.tags, tagsRequired, t);
  const summaryCheck = validateSummaryInput(watchedValues.postSummary, t);

  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-[#ebebeb] bg-white p-4">
      {/* ★ ONE SECTION-LABEL TREATMENT, NOT A FIFTH ONE (2026-08-10, C-14).
          "METADATA" and "PUBLISHING" were 12px/500 uppercase at 0.6px tracking
          in slate — a heading style that appears nowhere else in Lumen. These
          now reuse the masthead's eyebrow exactly (11px/600 uppercase, 0.14em,
          #c0392b at 70%), see features/layouts/page-masthead.tsx, so the page
          has one small-label style rather than one per component. */}
      <span className="text-[12px] leading-[18px] font-semibold uppercase tracking-[0.14em] text-[#c0392b]/70">
        {t("submit_page.metadata_section")}
      </span>

      <FormField
        control={form.control}
        name="postSummary"
        render={({ field }) => (
          <FormItem>
            <FormControl>
              <div className="relative">
                <Input
                  placeholder={POST_SUMMARY_PLACEHOLDER}
                  className={clsx("pr-16 bg-background", {
                    "border-red-500 focus-visible:ring-red-500": summaryCheck,
                  })}
                  {...field}
                />
                <span
                  className={clsx(
                    "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums",
                    field.value.length > 140 ? "text-red-500" : "text-muted-foreground"
                  )}
                >
                  {field.value.length}/140
                </span>
              </div>
            </FormControl>
            <div className="text-xs text-destructive">{summaryCheck}</div>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* ★★★ NEVER FAIL-STATE AN UNTOUCHED FORM (2026-08-10, C-2).
          Measured on first open, before a single keystroke: the tags input had
          `border-color rgb(239,68,68)` and the words "Required when post to My
          Blog" under it in red. The composer greeted every writer by telling
          them they had already got something wrong. An empty field the reader
          has not visited is not an error, it is an empty field.

          The requirement itself has NOT been relaxed — Submit is still disabled
          and the hint under it still says which field is missing (see
          post-form.tsx). What changed is WHEN the red appears: only once the
          reader has actually been in the field (`fieldState.isTouched`) or has
          typed something we can judge. `showTagsError` gates both the border
          and the message, so the two can never disagree. */}
      <FormField
        control={form.control}
        name="tags"
        render={({ field, fieldState }) => {
          const showTagsError = Boolean(tagsCheck) && (fieldState.isTouched || field.value.trim() !== "");
          return (
          <FormItem>
            <FormControl>
              <div className="relative">
                <Input
                  placeholder={t("submit_page.enter_your_tags")}
                  className={clsx("pr-12 bg-background", {
                    "border-red-500 focus-visible:ring-red-500": showTagsError,
                  })}
                  {...field}
                  aria-invalid={showTagsError}
                  onChange={(e) => {
                    const normalized = e.target.value.replace(/,/g, " ");
                    field.onChange(normalized);
                  }}
                />
                {parseTags(field.value).length > 0 && (
                  <span
                    className={clsx(
                      "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums",
                      parseTags(field.value).length > MAX_TAGS ? "text-red-500" : "text-muted-foreground"
                    )}
                  >
                    {parseTags(field.value).length}/{MAX_TAGS}
                  </span>
                )}
              </div>
            </FormControl>
            {parseTags(field.value).length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="tag-chips">
                {parseTags(field.value).map((tag, index) => (
                  <Badge
                    key={`${tag}-${index}`}
                    variant="secondary"
                    className="cursor-pointer gap-1 pr-1 text-xs font-normal transition-colors hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      const tags = parseTags(field.value);
                      tags.splice(index, 1);
                      form.setValue("tags", tags.join(" "));
                    }}
                  >
                    {tag}
                    <Icons.x className="h-3 w-3 opacity-60 hover:opacity-100" />
                  </Badge>
                ))}
              </div>
            )}
            <div className="text-xs text-destructive">{showTagsError ? tagsCheck : null}</div>
            <FormMessage />
          </FormItem>
          );
        }}
      />

      {/* ★ THE ALTERNATIVE-AUTHOR FIELD IS GONE FROM HERE (2026-08-10, C-3).
          It sat in the open as a bare input placeholdered "Author(if different
          from current account)" — a Condenser developer field, offered to every
          first-time writer between their summary and their cover image, with no
          label and no explanation of what it does (it writes
          `json_metadata.alternativeAuthor`; it does NOT change who signs or who
          is paid). It now lives inside the Advanced settings dialog, next to
          the other post-level settings a normal post never touches. See
          advanced-settings-post-form.tsx. */}

      <SelectImageList
        content={postArea}
        value={selectedImg}
        onChange={setSelectedImg}
        proxyAuthToken={proxyAuthToken}
      />
    </div>
  );
}
