"use client";

import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { Input } from "@hive/ui/components/input";
import { Button } from "@hive/ui/components/button";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@hive/ui/components/form";
import { Icons } from "@ui/components/icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import { Separator } from "@ui/components";
import { CircleSpinner } from "react-spinners-kit";
import { Entry } from "@hive/common-hiveio-packages/wax";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { getCommunity } from "@transaction/lib/bridge-api";
import { DEFAULT_OBSERVER } from "@/blog/lib/utils";
import { getLogger } from "@ui/lib/logging";
import { configuredImagesEndpoint } from "@ui/config/public-vars";
import { isCommunity } from "@ui/lib/utils";
import { useTranslation } from "@/blog/i18n/client";
import { useUserClient } from "@smart-signer/lib/auth/use-user-client";
import { useSignerContext } from "@smart-signer/components/signer-provider";
import { useLoggedUserContext } from "@/blog/features/votes/hooks/use-logged-user";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@hive/ui/components/alert-dialog";
import dynamic from "next/dynamic";
import { imagePicker, validateTagInput, validateSummaryInput, validateAltUsernameInput } from "@/blog/features/post-editor/lib/utils";
import { usePostFormState } from "@/blog/features/post-editor/hooks/use-post-form-state";
import { usePostFormActions } from "@/blog/features/post-editor/hooks/use-post-form-actions";
import { useScrollSync } from "@/blog/features/post-editor/hooks/use-scroll-sync";
import { PostFormHeader } from "@/blog/features/post-editor/PostFormHeader";
import { PostMetadataSection } from "@/blog/features/post-editor/PostMetadataSection";
import { PostPublishingSection } from "@/blog/features/post-editor/PostPublishingSection";
import { PostPreviewPanel } from "@/blog/features/post-editor/PostPreviewPanel";
import { chainObserver } from '@/blog/lib/utils';
import {
  ALTERNATIVE_AUTHOR_LABEL,
  DISCARD_DRAFT,
  DISCARD_DRAFT_CONFIRM_TITLE,
  RESTORED_DRAFT_DESCRIPTION,
  RESTORED_DRAFT_DISCARD,
  RESTORED_DRAFT_KEEP,
  RESTORED_DRAFT_TITLE
} from "@/blog/features/post-editor/lib/composer-copy";

const MdEditor = dynamic(() => import("@/blog/features/post-editor/md-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[500px] w-full items-center justify-center rounded-md border border-border bg-background-secondary/30">
      <CircleSpinner loading size={24} color="#dc2626" />
    </div>
  ),
});

const logger = getLogger("app");

/** Check if markdown content contains external image URLs that would need proxying. */
function contentHasExternalImage(content: string, proxyBase: string): boolean {
  const mdImageRegex = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = mdImageRegex.exec(content)) !== null) {
    if (!match[1].startsWith(proxyBase)) return true;
  }
  const bareImageRegex =
    /(?:^|\n)\s*(https?:\/\/[^\s]+\.(?:jpe?g|png|gif|webp|svg|bmp)(?:\?[^\s]*)?)\s*(?:\n|$)/gi;
  while ((match = bareImageRegex.exec(content)) !== null) {
    if (!match[1].startsWith(proxyBase)) return true;
  }
  const htmlImgRegex = /<img\s[^>]*src=["'](https?:\/\/[^"']+)["']/gi;
  while ((match = htmlImgRegex.exec(content)) !== null) {
    if (!match[1].startsWith(proxyBase)) return true;
  }
  return false;
}

export default function PostForm({
  username,
  editMode = false,
  sideBySidePreview = true,
  post_s,
  setEditMode,
  refreshPage,
  setIsSubmitting,
}: {
  username: string;
  editMode: boolean;
  sideBySidePreview: boolean;
  post_s?: Entry;
  setEditMode?: Dispatch<SetStateAction<boolean>>;
  refreshPage?: () => void;
  setIsSubmitting: (submitting: boolean) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const { user } = useUserClient();
  const { signer } = useSignerContext();
  const observer = chainObserver(user);
  const searchParams = useSearchParams();
  const categoryParam = searchParams?.get("category") ?? undefined;
  const { t } = useTranslation("common_blog");
  const { reputation } = useLoggedUserContext();

  const [preview, setPreview] = useState(true);
  const [selectedImg, setSelectedImg] = useState(
    editMode && post_s?.json_metadata?.image?.[0] ? post_s.json_metadata.image[0] : ""
  );
  const [sideBySide, setSideBySide] = useState(sideBySidePreview);
  const [syncScroll, setSyncScroll] = useState(true);
  const isLgScreen = useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia("(min-width: 1024px)");
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false
  );
  const effectiveSideBySide = sideBySide && isLgScreen;
  const [imagePickerState, setImagePickerState] = useState("");
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const [proxyAuthToken, setProxyAuthToken] = useState<string | undefined>();
  const proxyAuthRequested = useRef(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  // --- State hook ---
  const {
    form,
    defaultValues,
    storedPost,
    storePost,
    removePost,
    entryValues,
    hasDraftChanges,
    hasHydratedRef,
    hasSubmittedRef,
    watchedValues,
    previewContent,
    setPreviewContent,
    restoredFromDraft,
    setRestoredFromDraft,
    shadowDraftRecovery,
    removeShadowDraft,
  } = usePostFormState({ username, editMode, post_s, categoryParam });

  // --- Actions hook ---
  const {
    postMutation,
    handlePostAreaChange,
    onSubmit,
    handleCancel,
    handleCancelConfirm,
    handleLoadTemplate,
    draftSaveFailed,
  } = usePostFormActions({
    form,
    username,
    editMode,
    post_s,
    selectedImg,
    reputation,
    defaultValues,
    watchedValues,
    storedPost,
    storePost,
    removePost,
    hasHydratedRef,
    hasSubmittedRef,
    previewContent,
    setPreviewContent,
    setEditMode,
    refreshPage,
    setIsSubmitting,
    setCancelDialogOpen,
    btnRef,
  });

  // --- Scroll sync hook ---
  useScrollSync({
    editorContainerRef,
    previewContainerRef,
    syncScroll,
    effectiveSideBySide,
    preview,
    previewContent,
  });

  // --- Proxy auth token ---
  const fetchProxyAuthToken = useCallback(async () => {
    if (!user.isLoggedIn || !signer) {
      proxyAuthRequested.current = false;
      return;
    }
    try {
      const timestamp = Date.now();
      const imageOwner = signer.authorityUsername || signer.username;
      const message = `Authorize image proxy preview for ${imageOwner} at ${new Date(timestamp).toISOString()}`;
      const sig = await signer.signChallenge({ message, password: "" });
      const baseUrl = configuredImagesEndpoint.replace(/\/+$/, "");
      const resp = await fetch(`${baseUrl}/proxy-auth/${imageOwner}/${sig}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setProxyAuthToken(data.token);
      } else {
        logger.error("Failed to obtain proxy auth token: %s", resp.status);
      }
    } catch (error) {
      logger.error("Error obtaining proxy auth token: %o", error);
    }
  }, [user.isLoggedIn, signer]);

  useEffect(() => {
    if (proxyAuthRequested.current || !previewContent) return;
    if (contentHasExternalImage(previewContent, configuredImagesEndpoint)) {
      proxyAuthRequested.current = true;
      fetchProxyAuthToken();
    }
  }, [previewContent, fetchProxyAuthToken]);

  useEffect(() => {
    if (!proxyAuthToken) return;
    const interval = setInterval(fetchProxyAuthToken, 25 * 60 * 1000);
    return () => clearInterval(interval);
  }, [proxyAuthToken, fetchProxyAuthToken]);

  // --- NSFW tag injection ---
  const { data: communityData } = useQuery({
    queryKey: ["community", categoryParam, observer],
    queryFn: () => getCommunity(categoryParam ?? storedPost.category, observer),
    enabled: isCommunity(categoryParam) || isCommunity(storedPost.category),
  });
  const nsfwTagCheck = communityData?.is_nsfw && !storedPost.tags?.includes("nsfw");
  useEffect(() => {
    form.setValue("tags", nsfwTagCheck ? `nsfw ${entryValues.tags}` : entryValues.tags);
  }, [!!communityData?.is_nsfw]);

  useEffect(() => {
    setImagePickerState(imagePicker(selectedImg));
  }, [selectedImg]);

  // --- Validation checks for submit button ---
  const tagsRequired = !categoryParam && watchedValues.category === "blog";
  const tagsCheck = validateTagInput(watchedValues.tags, tagsRequired, t);
  const summaryCheck = validateSummaryInput(watchedValues.postSummary, t);
  const altUsernameCheck = validateAltUsernameInput(watchedValues.author, t);
  const tagsRequiredAndEmpty = tagsRequired && (!watchedValues.tags || !watchedValues.tags.trim());

  const { postArea } = watchedValues;

  // The restore notice is true only while there is restored work still on
  // screen: discarding the draft empties both fields and the notice goes with
  // it, without needing a second piece of state to keep in step.
  const showRestoredDraftNotice =
    restoredFromDraft && Boolean(watchedValues.title?.trim() || watchedValues.postArea?.trim());

  return (
    /* ★ THE PAGE OWNS THE PAGE PADDING (2026-08-10).
       `/submit.html` now renders inside the standard Lumen shell (nav column +
       content column, see app/submit.html/content.tsx), which already supplies
       the outer gutters. Keeping `container` and `p-8` here as well meant 76px
       of left padding on a large screen, and — worse — `container` switched ON
       the moment you turned side-by-side OFF, so a layout toggle also re-centred
       and re-width-limited the whole form under you. Both are now scoped to
       `editMode`, which is the OTHER caller: the inline editor on a post page,
       which has no shell of its own and does need them. */
    <div className={clsx({ container: editMode && (!sideBySide || !preview) })}>
      <div
        className={clsx("relative flex flex-col gap-4 bg-background", {
          "p-4 sm:p-6 lg:p-8": editMode,
          "lg:flex-row": sideBySide,
        })}
        data-testid="form-and-preview-container"
      >
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className={clsx("flex flex-col gap-6 lg:w-1/2", {
              "lg:w-full": !preview || !sideBySide,
            })}
            data-testid="form-container"
          >
            {/* ★ BOTH BANNERS BELONG INSIDE THE FORM COLUMN (2026-08-10).
                `<Form>` is a context provider and renders no DOM of its own, so
                a banner placed as its sibling-of-`<form>` child was a direct
                child of the `lg:flex-row` container — i.e. a THIRD column beside
                the form and the preview once side-by-side was on. Inside the
                form they sit above the fields at full column width, which is
                where they were meant to be. */}
            {/* ★ NEVER LET A DRAFT DIE QUIETLY (2026-08-09). Auto-save writes the
                whole body to localStorage every 500 ms; when it no longer fits,
                the write throws and used to be swallowed, so the editor looked
                identical to a saved document right up until the work was gone.
                This is deliberately a persistent banner and not a toast: a toast
                disappears, and the writer needs to see this for as long as it is
                true. It also says what to DO, because the app cannot rescue the
                text on the writer's behalf. */}
            {draftSaveFailed ? (
              <div
                role="alert"
                data-testid="draft-save-failed"
                className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
              >
                <strong className="font-semibold">This draft is not being saved.</strong> It is too
                large for your browser&apos;s storage, so it will be lost if you close or reload this
                tab. Copy your text somewhere safe, or shorten the post.
              </div>
            ) : null}
            {/* ★★★ SAY THAT THIS IS A RESTORED DRAFT (2026-08-10, C-1).
                See use-post-form-state.ts for what was measured. Two rules this
                follows: it names what happened in plain words, and it offers the
                way out in the same breath, because the only previous exit was a
                button labelled "Clean". `role="status"` and not `role="alert"` on
                purpose: restoring your own work is good news, not a warning, and
                an alert interrupts a screen reader mid-sentence. */}
            {showRestoredDraftNotice ? (
              <div
                role="status"
                data-testid="restored-draft"
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border border-[#ebebeb] bg-white px-4 py-3 text-sm"
              >
                <div className="min-w-[240px] flex-1">
                  <strong className="font-semibold text-[#161511]">
                    {RESTORED_DRAFT_TITLE}
                  </strong>{" "}
                  <span className="text-[#6b7280]">
                    {RESTORED_DRAFT_DESCRIPTION}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {/* ★ `line-brand-10` / `ink-brand-6`, not `#c0392b`
                      (2026-08-14): rgb(192,57,43), byte-identical to the
                      literal in light mode. */}
                  <button
                    type="button"
                    className="rounded-[14px] border border-[#ebebeb] bg-white px-3 py-1.5 text-xs font-medium text-[#6b7280] transition-colors hover:border-line-brand-10 hover:text-ink-brand-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10/40"
                    onClick={() => setRestoredFromDraft(false)}
                    data-testid="restored-draft-keep"
                  >
                    {RESTORED_DRAFT_KEEP}
                  </button>
                  {/* ★ `line-brand-10` / `ink-brand-6` / `surface-brand-12`,
                      not `#c0392b` (2026-08-14): this is the solid variant of
                      the same brand token, per role (border/text/fill) —
                      rgb(192,57,43) in every case, byte-identical to the
                      literal in light mode. `--destructive` is a visibly
                      different red (rgb(218,43,43)) reserved for the vote
                      control only. */}
                  <button
                    type="button"
                    className="rounded-[14px] border border-line-brand-10 bg-white px-3 py-1.5 text-xs font-medium text-ink-brand-6 transition-colors hover:bg-surface-brand-12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10/40"
                    onClick={() => handleCancel()}
                    data-testid="restored-draft-discard"
                  >
                    {RESTORED_DRAFT_DISCARD}
                  </button>
                </div>
              </div>
            ) : null}
            <PostFormHeader
              sideBySide={sideBySide}
              setSideBySide={setSideBySide}
              preview={preview}
              setPreview={setPreview}
            />

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      placeholder={t("submit_page.title")}
                      className="h-12 border-0 border-b border-border bg-transparent px-1 text-lg font-semibold placeholder:font-normal placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-destructive rounded-none"
                      {...field}
                      data-testid="post-title-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="postArea"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div ref={editorContainerRef}>
                      <MdEditor
                        windowheight={500}
                        onChange={handlePostAreaChange}
                        persistedValue={field.value}
                        ariaLabel={t('submit_page.post_body')}
                      />
                    </div>
                  </FormControl>
                  <div className="flex items-center rounded-b-md border-x border-b border-border bg-background-secondary/50 px-3 py-1.5 text-xs text-muted-foreground">
                    {t("submit_page.insert_images_by_dragging")} {t("submit_page.selecting_them")}
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger type="button" tabIndex={-1}>
                          <Icons.info className="ml-1 w-3" />
                        </TooltipTrigger>
                        <TooltipContent>{t("submit_page.insert_images_info")}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Separator />

            <PostMetadataSection
              form={form}
              watchedValues={watchedValues}
              postArea={postArea}
              selectedImg={selectedImg}
              setSelectedImg={setSelectedImg}
              proxyAuthToken={proxyAuthToken}
              categoryParam={categoryParam}
            />

            <PostPublishingSection
              form={form}
              username={username}
              observer={observer}
              editMode={editMode}
              post_s={post_s}
              watchedValues={watchedValues}
              storedPost={storedPost}
              storePost={storePost}
              categoryParam={categoryParam}
              handleLoadTemplate={handleLoadTemplate}
            />

            <div className="flex flex-col gap-2 pt-2">
              <div className="flex items-center gap-3">
                <Button
                  ref={btnRef}
                  type="submit"
                  variant="redHover"
                  /* ★★★ ZERO RADIUS IN A 14px SYSTEM (2026-08-10, C-8).
                     Measured on the live page: the most important button in the
                     composer rendered `background rgb(156,163,175)`,
                     `border-radius 0px` — a flat grey rectangle, in a product
                     whose rows and buttons are all 14px. Being DISABLED before
                     you have typed a title is correct; looking like a dead
                     rectangle while disabled is not, and the enabled state
                     inherited the same square corners.

                     The shared `redHover` variant is not touched: it is used by
                     the reply box, the advanced-settings dialog and elsewhere,
                     and re-cutting it here would move all of them. These
                     overrides are local, and `cn`/tailwind-merge lets the later
                     class win. `disabled:bg-*` needs its own override because a
                     modifier class is a different key to twMerge than the bare
                     one. */
                  // ★ `bg-surface-brand-12`, not `#c0392b` (2026-08-14) —
                  // rgb(192,57,43), byte-identical to the literal in light
                  // mode. `hover:bg-[#a93226]` is a separate, untokenised
                  // literal and is out of scope here.
                  className="w-28 rounded-[14px] bg-surface-brand-12 text-white shadow-none hover:bg-[#a93226] hover:shadow-none disabled:border disabled:border-[#ebebeb] disabled:bg-[#f5f5f5] disabled:text-[#6b7280] disabled:opacity-100"
                  disabled={
                    // ★ GATE ON WHAT IS ON SCREEN, NOT ON THE SAVED DRAFT.
                    //
                    // This read `storedPost` — the localStorage draft. Two ways
                    // that goes wrong, both measured 2026-08-06:
                    //
                    //  * EDITING: the draft still holds the ORIGINAL title and
                    //    body, so clearing both fields left Submit fully
                    //    enabled with no warning, while the create form
                    //    correctly refuses the same empty state. Whatever the
                    //    server then does with an empty payload, the UI should
                    //    never have offered it — and there is no undo here.
                    //  * WHITESPACE: a title of four spaces is a truthy string,
                    //    so it passed, and the refusal arrived from the server
                    //    afterwards.
                    //
                    // `watchedValues` is the live form state; trimming makes
                    // "  " mean empty, which is what a reader means by it.
                    !watchedValues.title?.trim() ||
                    !watchedValues.postArea?.trim() ||
                    Boolean(tagsCheck) ||
                    Boolean(summaryCheck) ||
                    Boolean(altUsernameCheck) ||
                    postMutation.isPending
                  }
                  data-testid="submit-post-button"
                >
                  {postMutation.isPending ? (
                    <CircleSpinner loading={postMutation.isPending} size={18} color="#dc2626" />
                  ) : (
                    t("submit_page.submit")
                  )}
                </Button>
                {/* ★★★ "CLEAN" IS NOT A WORD FOR THROWING WORK AWAY (C-9).
                    This button deletes the draft. It sits one gap away from
                    Submit, and it was labelled "Clean" in ghost grey, which
                    reads as tidy-up, not as destroy. It is now "Discard draft"
                    (locale key `submit_page.clean`) and carries the destructive
                    outline, so what it does is legible before it is clicked.
                    The confirmation dialog it opens is unchanged — verified
                    live, `handleCancel` only opens the dialog and the deletion
                    happens in `handleCancelConfirm`. */}
                <Button
                  disabled={postMutation.isPending}
                  onClick={() => handleCancel()}
                  type="reset"
                  variant="ghost"
                  // ★ `line-brand-10` / `ink-brand-6`, not `#c0392b`
                  // (2026-08-14): rgb(192,57,43), byte-identical to the
                  // literal in light mode.
                  className="rounded-[14px] border border-[#ebebeb] text-[#6b7280] hover:border-line-brand-10 hover:bg-transparent hover:text-ink-brand-6"
                  data-testid="clean-post-button"
                >
                  {editMode ? t("submit_page.cancel") : DISCARD_DRAFT}
                </Button>
              </div>
              {/* ★ SAY WHY SUBMIT IS OFF, INCLUDING WHEN THE REASON IS HIDDEN.
                  The alternative-author field now lives inside the Advanced
                  settings dialog (C-3), so a bad value there could disable
                  Submit with nothing on screen to explain it. It is checked
                  first for that reason. */}
              {/* ★ AND THE HINT READS THE SAME STATE THE BUTTON DOES (2026-08-16).
                  The `disabled` gate above was moved to `watchedValues` on
                  2026-08-06 for the reasons in its own note; this hint was left
                  on `storedPost`, the localStorage draft, which lags the form by
                  a debounce. A QA pass typed a full title and body, and the
                  button correctly stayed off for a missing TAG while the line
                  underneath it said "Enter content to submit" — naming a field
                  that was visibly full. A disabled control with a wrong reason
                  is worse than a disabled control with none: the reader fixes
                  the thing that was never broken. Same source, same trim, so the
                  two can no longer disagree. */}
              {!postMutation.isPending &&
                (altUsernameCheck ||
                  !watchedValues.title?.trim() ||
                  !watchedValues.postArea?.trim() ||
                  tagsRequiredAndEmpty) && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="submit-requirements-hint"
                  >
                    {altUsernameCheck
                      ? `${ALTERNATIVE_AUTHOR_LABEL}: ${altUsernameCheck}`
                      : !watchedValues.title?.trim() && !watchedValues.postArea?.trim()
                        ? t("submit_page.enter_title_and_content")
                        : !watchedValues.title?.trim()
                          ? t("submit_page.enter_title")
                          : !watchedValues.postArea?.trim()
                            ? t("submit_page.enter_content")
                            : t("submit_page.enter_tags")}
                  </p>
                )}
            </div>
          </form>
        </Form>

        <PostPreviewPanel
          preview={preview}
          sideBySide={sideBySide}
          syncScroll={syncScroll}
          setSyncScroll={setSyncScroll}
          previewContainerRef={previewContainerRef}
          previewContent={previewContent}
          proxyAuthToken={proxyAuthToken}
        />
      </div>

      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {editMode ? t("post_content.close_post_editor") : DISCARD_DRAFT_CONFIRM_TITLE}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("submit_page.cancel_confirmation_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("submit_page.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("submit_page.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!shadowDraftRecovery} onOpenChange={(open) => {
        if (!open && shadowDraftRecovery) {
          removeShadowDraft(shadowDraftRecovery.key);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("submit_page.shadow_draft_found")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("submit_page.shadow_draft_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              if (shadowDraftRecovery) removeShadowDraft(shadowDraftRecovery.key);
            }}>
              {t("submit_page.shadow_draft_discard")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (shadowDraftRecovery) {
                const { value, key } = shadowDraftRecovery;
                form.reset({
                  ...defaultValues,
                  title: value.title,
                  postArea: value.body,
                  tags: value.tags.join(" "),
                  category: value.category,
                  postSummary: value.summary,
                });
                setPreviewContent(value.body);
                removeShadowDraft(key);
              }
            }}>
              {t("submit_page.shadow_draft_recover")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
