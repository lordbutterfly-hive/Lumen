"use client";

import { Dispatch, MutableRefObject, RefObject, SetStateAction, useCallback, useEffect, useRef } from "react";
import { UseFormReturn } from "react-hook-form";
import { useRouter } from "next/navigation";
import { createAsset, createPermlink } from "@transaction/lib/utils";
import { withBasePath } from "@ui/lib/path-utils";
import { getLogger } from "@ui/lib/logging";
import { handleError } from "@ui/lib/handle-error";
import { Entry } from "@hive/common-hiveio-packages/wax";
import { parseTags } from "@/blog/features/post-editor/lib/utils";
import { usePostMutation } from "@/blog/features/post-editor/hooks/use-post-mutation";
import { AccountFormValues } from "@/blog/features/post-editor/types";
import { useUserClient } from "@smart-signer/lib/auth/use-user-client";
import { createLitePost } from "@/blog/lib/lite/client/lite-write";

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
  storePost: (value: AccountFormValues) => void;
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

  // Debounce form.setValue for postArea to avoid re-rendering entire PostForm on every keystroke.
  const handlePostAreaChange = useCallback(
    (value: string) => {
      latestPostAreaRef.current = value;
      setPreviewContent(value);
      clearTimeout(postAreaSyncTimerRef.current);
      postAreaSyncTimerRef.current = setTimeout(() => {
        form.setValue("postArea", value);
      }, 300);
    },
    [form]
  );

  // Auto-save debounce
  useEffect(() => {
    if (hasSubmittedRef.current) return;
    if (!hasHydratedRef.current) return;
    clearTimeout(storeTimerRef.current);
    storeTimerRef.current = setTimeout(() => {
      storePost(watchedValues);
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
      const result = await createLitePost({
        tier: "advanced",
        title: data.title,
        body: postBody,
        summary: data.postSummary,
        tags,
        community: data.category
      });
      if (btnRef.current) btnRef.current.disabled = false;
      setIsSubmitting(false);
      if (result.status === "ok") {
        hasSubmittedRef.current = true;
        removePost();
        latestPostAreaRef.current = defaultValues.postArea;
        form.reset(defaultValues);
        setPreviewContent(undefined);
        await router.push(withBasePath("/"), undefined);
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
  };
}
