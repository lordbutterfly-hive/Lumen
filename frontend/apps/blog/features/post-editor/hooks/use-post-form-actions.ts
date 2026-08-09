"use client";

import { Dispatch, MutableRefObject, RefObject, SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { UseFormReturn } from "react-hook-form";
import { useRouter } from "next/navigation";
import { createAsset, createPermlink } from "@transaction/lib/utils";
import { withBasePath } from "@ui/lib/path-utils";
import { getLogger } from "@ui/lib/logging";
import { handleError } from "@ui/lib/handle-error";
import { toast } from "@ui/components/hooks/use-toast";
import { Entry } from "@hive/common-hiveio-packages/wax";
import { parseTags } from "@/blog/features/post-editor/lib/utils";
import { usePostMutation } from "@/blog/features/post-editor/hooks/use-post-mutation";
import { AccountFormValues } from "@/blog/features/post-editor/types";
import { useUserClient } from "@smart-signer/lib/auth/use-user-client";
import { createLitePost } from "@/blog/lib/lite/client/lite-write";
import { litePostIdOf } from "@/blog/lib/lite/render/lite-post-id";

const logger = getLogger("app");

interface UsePostFormActionsParams {
  form: UseFormReturn<AccountFormValues>;
  username: string;
  editMode: boolean;
  post_s?: Entry;
  selectedImg: string;
  reputation: number;
  defaultValues: AccountFormValues;
  watchedValues: AccountFormValues;
  storedPost: AccountFormValues;
  storePost: (value: AccountFormValues) => boolean;
  removePost: () => void;
  hasHydratedRef: MutableRefObject<boolean>;
  hasSubmittedRef: MutableRefObject<boolean>;
  previewContent: string | undefined;
  setPreviewContent: Dispatch<SetStateAction<string | undefined>>;
  setEditMode?: Dispatch<SetStateAction<boolean>>;
  refreshPage?: () => void;
  setIsSubmitting: (submitting: boolean) => void;
  setCancelDialogOpen: Dispatch<SetStateAction<boolean>>;
  btnRef: RefObject<HTMLButtonElement | null>;
}

export function usePostFormActions({
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
  setPreviewContent,
  setEditMode,
  refreshPage,
  setIsSubmitting,
  setCancelDialogOpen,
  btnRef,
}: UsePostFormActionsParams) {
  const router = useRouter();
  const postMutation = usePostMutation();
  const { user } = useUserClient();

  // Ref always holds the latest editor value (updated immediately, even before debounced form sync)
  const latestPostAreaRef = useRef(storedPost.postArea || defaultValues.postArea);
  const postAreaSyncTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const storeTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // True when the last auto-save could not be written (localStorage full / too
  // large). Surfaced in the editor so the writer can rescue their work.
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);

  // Debounce form.setValue for postArea to avoid re-rendering entire PostForm on every keystroke.
  const handlePostAreaChange = useCallback(
    (value: string) => {
      latestPostAreaRef.current = value;
      // ★ THE PREVIEW IS WHAT FROZE THE TAB (2026-08-09). `setPreviewContent`
      // ran on EVERY keystroke and on paste, synchronously handing the whole
      // document to the markdown renderer (and to `contentHasExternalImage`,
      // which regexes the entire body). At a few hundred KB that is slow; at the
      // 4–5 MB paste a tester measured, the main thread never comes back, the
      // tab is killed, and every unsaved keystroke dies with it. The draft loss
      // was a SYMPTOM of the hang — the auto-save below never got a turn.
      //
      // Debounced to the same 300 ms as the form sync, so the preview is a beat
      // behind instead of fighting the typist for the main thread.
      clearTimeout(postAreaSyncTimerRef.current);
      postAreaSyncTimerRef.current = setTimeout(() => {
        form.setValue("postArea", value);
        setPreviewContent(value);
      }, 300);
    },
    [form, setPreviewContent]
  );

  // Auto-save debounce
  useEffect(() => {
    if (hasSubmittedRef.current) return;
    if (!hasHydratedRef.current) return;
    clearTimeout(storeTimerRef.current);
    storeTimerRef.current = setTimeout(() => {
      // ★ A FAILED AUTO-SAVE MUST BE VISIBLE (2026-08-09). `storePost` used to
      // return nothing and swallow `QuotaExceededError`, so a draft too large
      // for localStorage looked exactly like a saved one until the writer
      // reloaded and found it gone. Now the write reports back and the editor
      // says so, once per transition, instead of failing quietly forever.
      const stored = storePost(watchedValues);
      setDraftSaveFailed((was) => {
        if (was === !stored) return was;
        if (!stored) logger.error("Auto-save failed: the draft did not fit in localStorage");
        return !stored;
      });
    }, 500);
    return () => clearTimeout(storeTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...Object.values(watchedValues)]);

  async function onSubmit(data: AccountFormValues) {
    // Flush pending debounce - use the latest editor value which may not have synced to form yet
    clearTimeout(postAreaSyncTimerRef.current);
    const postBody = latestPostAreaRef.current || data.postArea;

    const tags = parseTags(data.tags);

    // LITE fork: a keyless lite account cannot sign a comment op in-browser, so
    // its advanced post is proxied via /api/lite/posts (the frontend account
    // broadcasts it to Hive). Skip the entire wax/Keychain path below.
    if (user.account_tier === "lite") {
      setIsSubmitting(true);
      if (btnRef.current) btnRef.current.disabled = true;
      // EDIT vs CREATE. This branch used to ignore editMode entirely, so saving an
      // edit created a SECOND post instead of changing the first. The lite post id
      // travels in the entry's json_metadata (lumen_post_id), written by the
      // publisher — the on-chain permlink is not our row id.
      const liteEditId = editMode ? litePostIdOf(post_s) : undefined;
      // Checked BEFORE submitting. Without an id the server has no way to tell an edit
      // from a new post and treats it as a create — so running this guard afterwards
      // published the duplicate it exists to prevent, and then reported failure.
      if (editMode && !liteEditId) {
        if (btnRef.current) btnRef.current.disabled = false;
        setIsSubmitting(false);
        handleError(new Error("Could not identify which Lumen post to edit."), {
          method: "lite-post-edit",
          params: { title: data.title }
        });
        return;
      }
      const result = await createLitePost({
        tier: "advanced",
        title: data.title,
        body: postBody,
        summary: data.postSummary,
        tags,
        community: data.category,
        editOfPostId: liteEditId
      });
      if (btnRef.current) btnRef.current.disabled = false;
      setIsSubmitting(false);
      if (result.status === "ok") {
        hasSubmittedRef.current = true;
        removePost();
        latestPostAreaRef.current = defaultValues.postArea;
        form.reset(defaultValues);
        setPreviewContent(undefined);
        // ★ SAY SOMETHING. The chain path has always toasted here (see
        // usePostMutation.onSuccess) and then navigated to the new post. The
        // lite path did neither: it pushed the reader to the home feed in
        // silence, so the only way to learn whether your post existed was to go
        // to your profile and look for it. Measured 2026-08-06 at 300 ms, 1 s
        // and 2.5 s after Submit — nothing on screen at any of them, while the
        // 201 sat in the network log. Publishing is the scariest thing a
        // newcomer does here; an unacknowledged one reads as a failure.
        //
        // ★★★ AND SAY A TRUE THING (2026-08-08, UX tester on the full new-user
        // path). It said "already visible on Lumen", which sent a first-time
        // poster to look for their post in the places a reader looks — and it is
        // in none of them. Reproduced on a freshly created account: the post is
        // absent from For You (`/api/feed/for-you`, 20 entries, source recsys),
        // absent from Following (0 entries — you do not follow yourself), and
        // absent from #lumen (`?tag=lumen`, 30 entries). All three read HIVE, and
        // a lite post is not on Hive yet; when it does publish it goes out as a
        // COMMENT under a rolling container root (publisher/container.ts), so a
        // tag page will never list it at all.
        //
        // Where it IS, immediately and provably: the author's own profile
        // (`/api/lite/posts?author=`) and its own permalink page. So the copy
        // names that and the navigation goes there — a promise the next screen
        // keeps, instead of one three other screens break.
        toast({
          title: editMode ? "Changes saved" : "Post published",
          description: editMode
            ? "Your post has been updated."
            : "It's on your Lumen profile now, and queued to publish to Hive.",
          variant: "success"
        });
        // ★ An EDIT should return you to what you edited, not to the feed.
        //   A NEW post now also has somewhere to go: the author's profile, which
        //   is the one surface that has it the moment the 201 lands. It used to
        //   push to "/" — the home feed — on the reasoning that a lite post has
        //   no page yet; that is only true of its CHAIN page, and it dropped the
        //   reader on the single screen the toast had just promised.
        await router.push(
          withBasePath(editMode && post_s?.url ? post_s.url : `/@${user.username}`),
          undefined
        );
      } else {
        handleError(new Error(result.message), { method: "lite-post", params: { title: data.title } });
      }
      return;
    }

    const maxAcceptedPayout = await createAsset((data.maxAcceptedPayout * 1000).toString(), "HBD");
    const postPermlink = await createPermlink(data?.title ?? "", username);
    const permlinInEditMode = post_s?.permlink;

    let newPercentHbd = data.payoutType ? (data.payoutType === "100%" ? 0 : 10000) : 10000;
    const newMaxPayout = data.maxAcceptedPayout;
    let rewardOptionsChanged = false;

    if (editMode && post_s) {
      const originalPercentHbd = post_s.percent_hbd;
      const originalMaxPayout = parseFloat(post_s.max_accepted_payout);

      if (newMaxPayout === 0) {
        newPercentHbd = Math.min(newPercentHbd, originalPercentHbd);
      }

      newPercentHbd = Math.min(newPercentHbd, originalPercentHbd);

      const percentHbdChanged = newPercentHbd < originalPercentHbd;
      const maxPayoutChanged = newMaxPayout < originalMaxPayout;

      rewardOptionsChanged = percentHbdChanged || maxPayoutChanged;
    }

    try {
      if (btnRef.current) {
        btnRef.current.disabled = true;
      }
      const postParams = {
        permlink: editMode && permlinInEditMode ? permlinInEditMode : postPermlink,
        title: data.title,
        body: postBody,
        category: data.category,
        summary: data.postSummary,
        altAuthor: data.author,
        image: selectedImg,
        reputation,
        editMode,
        percentHbd: newPercentHbd,
        maxAcceptedPayout,
        tags,
        beneficiaries: data.beneficiaries
          ? data.beneficiaries
              .map(({ account, weight }) => ({
                account,
                weight: Number(weight) * 100,
              }))
              .filter((b) => b.weight > 0)
              .sort((a, b) => a.account.localeCompare(b.account))
          : [],
        rewardOptionsChanged,
      };
      try {
        await postMutation.mutateAsync(postParams);
      } catch (error) {
        setIsSubmitting(false);
        handleError(error, { method: "post", params: postParams });
        throw error;
      }

      hasSubmittedRef.current = true;
      removePost();
      latestPostAreaRef.current = defaultValues.postArea;
      form.reset(defaultValues);
      setPreviewContent(undefined);
      if (editMode) {
        if (refreshPage && setEditMode) {
          setIsSubmitting(false);
          setEditMode(!editMode);
          refreshPage();
        }
      } else {
        const postUrl = `/${postParams.category}/@${username}/${postParams.permlink}?pending=1`;
        await router.push(withBasePath(postUrl), undefined);
      }
      if (btnRef.current) {
        btnRef.current.disabled = false;
      }
    } catch (error) {
      if (btnRef.current) {
        btnRef.current.disabled = false;
      }
      logger.error(error);
    }
  }

  const handleCancel = () => {
    setCancelDialogOpen(true);
  };

  const handleCancelConfirm = () => {
    clearTimeout(postAreaSyncTimerRef.current);
    latestPostAreaRef.current = defaultValues.postArea;
    form.reset(defaultValues);
    removePost();
    if (editMode && setEditMode) {
      setEditMode(false);
    }
    setCancelDialogOpen(false);
  };

  const handleLoadTemplate = (data: AccountFormValues) => {
    clearTimeout(postAreaSyncTimerRef.current);
    latestPostAreaRef.current = data.postArea;
    form.setValue("author", data.author);
    form.setValue("beneficiaries", data.beneficiaries);
    form.setValue("category", data.category);
    form.setValue("maxAcceptedPayout", data.maxAcceptedPayout);
    form.setValue("payoutType", data.payoutType);
    form.setValue("postArea", data.postArea);
    form.setValue("postSummary", data.postSummary);
    form.setValue("tags", data.tags);
    form.setValue("title", data.title);
  };

  return {
    postMutation,
    handlePostAreaChange,
    onSubmit,
    handleCancel,
    handleCancelConfirm,
    handleLoadTemplate,
    draftSaveFailed,
  };
}
