"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useStorageWithTTL } from "@ui/hooks/useStorageWithTTL";
import { StorageTTL, getItemsByPrefix, getStorageItem, removeStorageItem } from "@ui/lib/storage-with-ttl";
import { Entry } from "@hive/common-hiveio-packages/wax";
import { DEFAULT_PREFERENCES, Preferences } from "@/blog/lib/utils";
import { useTranslation } from "@/blog/i18n/client";
import { AccountFormValues, createAccountFormSchema } from "@/blog/features/post-editor/types";

interface UsePostFormStateParams {
  username: string;
  editMode: boolean;
  post_s?: Entry;
  categoryParam?: string;
}

export function usePostFormState({ username, editMode, post_s, categoryParam }: UsePostFormStateParams) {
  const { t } = useTranslation("common_blog");
  const [preferences] = useStorageWithTTL<Preferences>(
    `user-preferences-${username}`,
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );

  const defaultValues: AccountFormValues = {
    title: "",
    postArea: "",
    postSummary: "",
    tags: "",
    author: "",
    category: "blog",
    beneficiaries: [],
    maxAcceptedPayout: preferences.blog_rewards === "0%" ? 0 : 1000000,
    payoutType: preferences.blog_rewards,
  };

  // Hoisted so the reactive storage hook below and the direct-read hydrate
  // effect further down can never disagree on which draft they mean.
  const draftKey = editMode ? `postData-edit-${post_s?.permlink}` : `postData-new-${username}`;

  const [storedPost, storePost, removePost] = useStorageWithTTL<AccountFormValues>(
    draftKey,
    defaultValues,
    StorageTTL.DRAFT
  );

  // Check if we have a draft with actual changes (different from original post)
  const hasDraftChanges =
    editMode &&
    storedPost &&
    ((storedPost.postArea && storedPost.postArea !== post_s?.body) ||
      (storedPost.title && storedPost.title !== post_s?.title));

  // In edit mode: use draft if it has changes, otherwise use original post
  // In new mode: use draft if available
  const entryValues: AccountFormValues = {
    title: hasDraftChanges
      ? storedPost?.title || post_s?.title || ""
      : post_s?.title || storedPost?.title || "",
    postArea: hasDraftChanges
      ? storedPost?.postArea || post_s?.body || ""
      : post_s?.body || storedPost?.postArea || "",
    postSummary: hasDraftChanges
      ? storedPost?.postSummary || post_s?.json_metadata?.summary || ""
      : post_s?.json_metadata?.summary || storedPost?.postSummary || "",
    tags: hasDraftChanges
      ? storedPost?.tags ||
        (Array.isArray(post_s?.json_metadata?.tags) ? post_s.json_metadata.tags.join(" ") : "") ||
        ""
      : (Array.isArray(post_s?.json_metadata?.tags) ? post_s.json_metadata.tags.join(" ") : "") ||
        storedPost?.tags ||
        "",
    author: hasDraftChanges
      ? storedPost?.author || post_s?.json_metadata?.author || ""
      : post_s?.json_metadata?.author || storedPost?.author || "",
    category: editMode
      ? (post_s?.category ?? categoryParam ?? "")
      : (categoryParam ?? storedPost?.category ?? post_s?.category ?? ""),
    beneficiaries: storedPost?.beneficiaries || [],
    maxAcceptedPayout: post_s
      ? Number(post_s.max_accepted_payout.split(" ")[0])
      : (storedPost?.maxAcceptedPayout ?? (preferences.blog_rewards === "0%" ? 0 : 1000000)),
    payoutType: post_s
      ? parseFloat(post_s.max_accepted_payout) === 0
        ? "0%"
        : post_s.percent_hbd === 0
          ? "100%"
          : "50%"
      : storedPost?.payoutType || preferences.blog_rewards,
  };

  const accountFormSchema = createAccountFormSchema(t);

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: entryValues,
  });

  // Track if we've hydrated from localStorage to avoid resetting form during typing
  const hasHydratedRef = useRef(false);
  // The stored payout preference is applied AT MOST ONCE per composer (S9 fix
  // below). The hydrate effect is re-armed on `draftKey`, and `draftKey` contains
  // `username`, so without this a late-resolving username would re-apply the
  // preference over a payout the writer had already changed by hand.
  const preferenceAppliedRef = useRef(false);
  // Track if post was successfully submitted to prevent auto-save from re-creating draft
  const hasSubmittedRef = useRef(false);

  const [previewContent, setPreviewContent] = useState<string | undefined>(storedPost.postArea);

  // Shadow draft recovery — scan for orphaned shadow drafts from crashed sessions
  const [shadowDraftRecovery, setShadowDraftRecovery] = useState<{
    key: string;
    value: { title: string; body: string; tags: string[]; category: string; summary: string };
  } | null>(null);

  useEffect(() => {
    if (editMode || !username) return;

    const shadowDrafts = getItemsByPrefix<{
      title: string;
      body: string;
      tags: string[];
      category: string;
      summary: string;
    }>(`shadow-post-${username}-`);

    if (shadowDrafts.length > 0) {
      setShadowDraftRecovery(shadowDrafts[0]);
    }
  }, [username, editMode]);

  /**
   * ★★★ A SILENT RESTORE IS INDISTINGUISHABLE FROM A BUG (2026-08-10, C-1).
   *
   * The composer auto-saves every 500 ms and hydrates from that draft on the
   * next visit. Measured live: it opened with a title and a full body already in
   * it, out of `postData-new-<username>`, and said NOTHING. There was no way to
   * tell, from the screen, whether you were looking at work you had abandoned
   * weeks ago, a half-typed post you meant to throw away, or a bug that had
   * pre-filled somebody else's text into your editor — and the only route out
   * was a button labelled "Clean", which is not a word anyone reads as "discard
   * the draft you did not know you had".
   *
   * So: record whether this session's form was populated from storage, and let
   * the composer say so. The flag is set once, at hydration, and only for a NEW
   * post — an EDIT is expected to arrive pre-filled, and there the existing
   * `hasDraftChanges` logic already distinguishes the saved post from the draft.
   */
  const [restoredFromDraft, setRestoredFromDraft] = useState(false);

  // Re-armed on `draftKey` change rather than latched "once ever": `username`
  // can still be resolving when this mounts (server-session.tsx prefers the
  // cookie first, the client's `/api/users/me` answer second), and a key
  // change means a different draft to look for.
  const hydratedKeyRef = useRef<string | null>(null);

  // Hydrate form from localStorage after initial render.
  //
  // ★★★ READ LOCALSTORAGE DIRECTLY HERE — NOT `storedPost` (2026-08-13).
  //
  // `storedPost` comes from `useStorageWithTTL`, i.e.
  // `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`.
  // `/submit.html` renders a client component that Next still SSRs, so the
  // FIRST client render of this hook is a HYDRATION render, and React's
  // documented behaviour there is to use `getServerSnapshot()` — which
  // `useStorageWithTTL` hard-codes to the empty `defaultValues` — without
  // ever consulting `getSnapshot()` for that render. The hook's own passive
  // effect then notices the mismatch and schedules a re-render, but passive
  // effects on one fiber run in HOOK-DECLARATION ORDER, and this hydrate
  // effect is declared after `useStorageWithTTL`, so it runs in the very
  // same pass — still closed over the empty `storedPost`. By the time the
  // real draft would have arrived on the next render, this effect had
  // already latched `hasHydratedRef` and would never run again: the draft
  // was never read into the form for the life of the page.
  //
  // `localStorage` is synchronous, and a passive effect is by definition
  // already running in the browser, so reading it directly here — once,
  // ourselves — has no such race to lose.
  useEffect(() => {
    if (!draftKey || hydratedKeyRef.current === draftKey) return;
    hydratedKeyRef.current = draftKey;

    const draft = getStorageItem<AccountFormValues>(draftKey);

    /**
     * ★★★ THE PAYOUT PREFERENCE LOSES THE SAME RACE THE DRAFT JUST WON
     * (2026-08-13, adversarial review S9). Read this next to the paragraph above —
     * it is the identical fault, one hook earlier, and it costs money rather than
     * keystrokes.
     *
     * `preferences` also comes from `useStorageWithTTL`, so on the hydration render
     * it is `DEFAULT_PREFERENCES` (`blog_rewards: '50%'`), not what the writer
     * actually chose. Two things then conspire:
     *
     *   1. `defaultValues` is built from that empty snapshot, and
     *      `useStorageWithTTL` captures its `initialValue` ONCE, in a ref, on the
     *      first render (its own doc says the value must be a stable reference).
     *      So `storedPost` falls back to an object carrying `maxAcceptedPayout:
     *      1000000` / `payoutType: '50%'` — the DEFAULTS — whenever there is no
     *      draft on disk.
     *   2. `entryValues` therefore reads `storedPost?.maxAcceptedPayout ??
     *      (preferences.blog_rewards === '0%' ? 0 : 1000000)`, and the left side is
     *      never `undefined`, so `??` can never reach the real preference. Same for
     *      `storedPost?.payoutType || preferences.blog_rewards`.
     *
     * `useForm` reads `entryValues` exactly once, so for a NEW post with no draft a
     * writer whose stored preference is "0% — decline payout" silently got a normal
     * 50/50 post. The preference was unreachable, not merely awkward to reach.
     *
     * Fix is the same shape as the draft fix: read localStorage DIRECTLY here, in a
     * passive effect that is by definition already in the browser, and apply it —
     * but only to the payout pair, only when nothing more specific has already
     * spoken for them. Precedence, strongest first: an EDIT's on-chain values
     * (`post_s`) > a saved draft's own payout choice > the stored preference. The
     * effect is still keyed on `draftKey` only, so it cannot re-fire mid-typing.
     */
    const storedPreferences = username ? getStorageItem<Preferences>(`user-preferences-${username}`) : null;
    const preferredPayoutType = storedPreferences?.blog_rewards;
    const preferredMaxAcceptedPayout = preferredPayoutType === '0%' ? 0 : 1000000;
    // An edit is governed by what is already on chain, never by a preference; and
    // a preference is a STARTING VALUE, so it is applied once and never re-applied
    // over a choice the writer has since made by hand.
    const preferenceApplies =
      !editMode && !post_s && !!preferredPayoutType && !preferenceAppliedRef.current;

    // Recomputed from the draft we just read directly, NOT from the
    // module-level `hasDraftChanges` above — that one is derived from the
    // same raced `storedPost` and is falsy on this very first render.
    const draftDiffersFromPost =
      !!draft &&
      ((!!draft.postArea && draft.postArea !== post_s?.body) ||
        (!!draft.title && draft.title !== post_s?.title));
    const shouldHydrate = editMode ? draftDiffersFromPost : !!(draft?.postArea || draft?.title || draft?.tags);

    if (preferenceApplies) preferenceAppliedRef.current = true;

    if (shouldHydrate && draft) {
      if (!editMode) setRestoredFromDraft(true);
      form.reset({
        ...entryValues,
        title: draft.title || entryValues.title,
        postArea: draft.postArea || entryValues.postArea,
        postSummary: draft.postSummary || entryValues.postSummary,
        tags: draft.tags || entryValues.tags,
        author: draft.author || entryValues.author,
        category: editMode ? entryValues.category : draft.category || entryValues.category,
        beneficiaries: draft.beneficiaries || entryValues.beneficiaries,
        // A draft's own payout choice is a deliberate act and outranks the standing
        // preference; the preference only fills a gap the draft left.
        maxAcceptedPayout:
          draft.maxAcceptedPayout ??
          (preferenceApplies ? preferredMaxAcceptedPayout : entryValues.maxAcceptedPayout),
        payoutType:
          draft.payoutType || (preferenceApplies ? preferredPayoutType : entryValues.payoutType),
      });
      setPreviewContent(draft.postArea);
    } else if (preferenceApplies) {
      // ★ NO DRAFT, NEW POST — this is the path the race actually broke, and the
      // one nothing used to reset at all. `form.reset` here replaces the payout
      // pair `useForm` captured from the pre-hydration `entryValues` snapshot with
      // the writer's real stored preference.
      //
      // Spread `form.getValues()`, NOT `entryValues`: this effect is re-armed on
      // `draftKey`, and `draftKey` contains `username`, which can still be
      // resolving when the composer mounts. Spreading the stale render-time
      // snapshot would overwrite anything typed between the two passes with the
      // empty defaults — the exact destruction the draft fix above exists to stop.
      // Current values change nothing except the two fields named below.
      const current = form.getValues();
      if (
        current.payoutType !== preferredPayoutType ||
        current.maxAcceptedPayout !== preferredMaxAcceptedPayout
      ) {
        form.reset({
          ...current,
          maxAcceptedPayout: preferredMaxAcceptedPayout,
          payoutType: preferredPayoutType,
        });
      }
    }
    hasHydratedRef.current = true;
    // Deliberately key-only. `entryValues` and `form` are read, not tracked:
    // `entryValues` is a fresh object every render, and tracking it would
    // turn this back into a reactive effect that can re-fire mid-typing —
    // which is the exact race this rewrite exists to remove. See "Why not
    // the obvious alternative" in the O1 build map for the rejected fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // useWatch provides reactive values that update on every form change
  const formValues = useWatch({
    control: form.control,
  });

  // Memoize beneficiaries separately
  const beneficiaries = useMemo(
    () =>
      (formValues.beneficiaries ?? []).map((b) => ({
        account: b.account ?? "",
        weight: b.weight ?? "",
      })),
    [formValues.beneficiaries]
  );

  // Memoize other form values with granular dependencies
  const watchedValues = useMemo(
    () => ({
      title: formValues.title ?? "",
      postArea: formValues.postArea ?? "",
      postSummary: formValues.postSummary ?? "",
      tags: formValues.tags ?? "",
      author: formValues.author ?? "",
      category: formValues.category ?? "blog",
      beneficiaries,
      maxAcceptedPayout: formValues.maxAcceptedPayout ?? 1000000,
      payoutType: formValues.payoutType ?? "50%",
    }),
    [
      formValues.title,
      formValues.postArea,
      formValues.postSummary,
      formValues.tags,
      formValues.author,
      formValues.category,
      beneficiaries,
      formValues.maxAcceptedPayout,
      formValues.payoutType,
    ]
  );

  return {
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
    setShadowDraftRecovery,
    removeShadowDraft: (key: string) => {
      removeStorageItem(key);
      setShadowDraftRecovery(null);
    },
  };
}
