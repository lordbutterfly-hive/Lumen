'use client';

import { FC, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { fetchAccount } from '@/blog/lib/chain-fetch';
import { fetchLiteProfile, saveLiteProfile } from '@/blog/lib/lite/client/lite-profile';
import { useUpdateProfileMutation } from '@/blog/features/account-settings/hooks/use-update-profile-mutation';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { StaleTime } from '@/blog/lib/react-query';
import type { LumenProfile } from '@/blog/lib/lite/types';

/**
 * ONE INPUT, WRITTEN STRAIGHT TO THE PROFILE STORE (owner, 2026-08-30).
 *
 * "THEY NEED TO ADD THE LINK HERE... NOT SETTINGS." — this is the "here": a real
 * text input plus its own Save action, used from both the Meritum launch card
 * (`meritum/launch/launch-step-offers.tsx`) and Creator Studio's Market tab
 * (`studio/creator-studio.tsx`), sharing this one component rather than two
 * copies drifting apart.
 *
 * It writes to the exact same store Settings writes
 * (`features/account-settings/form.tsx`) — the `website` field of a Hive
 * account's `posting_json_metadata.profile`, or a lite account's
 * `lumen_user.profile` row — nothing about the launch transaction or the
 * contract's on-chain state is touched. Two tiers, two write paths, branched on
 * `account_tier === 'lite'` exactly like `form.tsx:125` does:
 *   - lite  -> `saveLiteProfile()` (POST /api/lite/profile, server-sanitised)
 *   - full  -> `useUpdateProfileMutation()` (broadcasts `account_update2`, prompts
 *              a wallet signature)
 *
 * ★★ BOTH WRITE PATHS REPLACE THE STORED PROFILE WHOLESALE, NOT PATCH IT.
 * `lib/lite/repositories/user-repository.ts`'s `updateProfile` says so directly
 * ("Written whole rather than merged"), and `packages/transaction/index.ts`'s
 * `updateProfile` builds `posting_json_metadata` from exactly the arguments it is
 * given — any field left `undefined` is simply absent from the JSON that gets
 * broadcast, i.e. erased. Sending `{ website }` alone would silently blank a
 * creator's name, bio, location and both images the instant they set a work
 * link. Every save below reads the CURRENT profile first and re-sends every
 * other field unchanged, exactly the way `form.tsx`'s `onSubmit` already does —
 * only `website` ever changes.
 */

/**
 * http/https only, parsed with `new URL()`, no embedded credentials — the same
 * rule B1's `SafeExternalLink` renders under and B2's route stores under. Empty
 * input is valid on purpose: it is how a creator clears a link they set earlier,
 * and silently discarding a value they DID type (the original bug this whole
 * feature answers) is worse than accepting an intentional blank.
 */
function isValidWorkLink(trimmed: string): boolean {
  if (!trimmed) return true;
  if (!URL.canParse(trimmed)) return false;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

export interface WorkLinkFieldProps {
  /**
   * Bare handle, no leading '@' — the signed-in creator's own account. Neither
   * write path is actually parameterised by this value (lite writes are
   * session-scoped via the auth cookie, the chain write is scoped to whatever
   * account the signer is bound to) — it only keys the two read queries, so a
   * prefill can never show one creator a value read for another, and so this
   * shares its React Query cache entry with Settings (`['liteProfile', x]` /
   * `['profileData', x]` are the exact keys `form.tsx` already uses).
   */
  account: string;
  /** Every visual class is required on purpose (2026-08-30): Meritum's
   *  `meritum-*` tokens are scoped to the Meritum screens and Creator Studio
   *  uses a completely different `ink-*` / `surface-*` set — a hardcoded
   *  default here would silently render wrong (or invisible) on whichever
   *  screen it wasn't written for. Structure (flex row, spacing) is owned by
   *  this component; colour and type are owned by each caller. */
  inputClassName: string;
  buttonClassName: string;
  errorClassName: string;
  statusClassName: string;
  /** Optional wrapper override; defaults to nothing (block-level, no margin). */
  containerClassName?: string;
}

const WorkLinkField: FC<WorkLinkFieldProps> = ({
  account,
  inputClassName,
  buttonClassName,
  errorClassName,
  statusClassName,
  containerClassName
}) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const isLite = user?.account_tier === 'lite';
  const queryClient = useQueryClient();

  const liteQuery = useQuery({
    queryKey: ['liteProfile', account],
    queryFn: fetchLiteProfile,
    enabled: isLite,
    staleTime: StaleTime.MEDIUM
  });
  // ★ SAME KEY AS SETTINGS (`features/account-settings/form.tsx`). Reading and
  // writing through the identical `['profileData', account]` cache entry means a
  // save here is instantly reflected if a creator also has Settings open, and
  // vice versa, with no extra plumbing.
  const hiveQuery = useQuery({
    queryKey: ['profileData', account],
    queryFn: () => fetchAccount(account),
    enabled: !isLite && account !== '',
    staleTime: StaleTime.MEDIUM
  });
  const updateProfileMutation = useUpdateProfileMutation();

  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedClean, setSavedClean] = useState(false);
  const seeded = useRef(false);
  const originalRef = useRef('');

  /**
   * ★ GATES THE SAVE, NOT JUST THE PREFILL. `liteQuery.data` is `undefined`
   * while the read is still in flight and `null` only when it actually failed
   * (`fetchLiteProfile` swallows its own errors down to `null` — see
   * `lib/lite/client/lite-profile.ts`); only a real object, even `{}`, means
   * "the current profile is known". `hiveQuery.isSuccess` is the chain
   * equivalent, since `fetchAccount` THROWS rather than resolving on a bad
   * response (`lib/chain-fetch.ts`'s `fetchJson`). Saving before either of
   * these is true is exactly the "wipe the other fields" failure mode above,
   * so the button stays disabled until this is true.
   */
  const profileLoaded = isLite ? liteQuery.data != null : hiveQuery.isSuccess;

  // Seed once, from whichever tier's query resolves first — never again, so a
  // background refetch can never clobber something the creator is mid-typing
  // (same reasoning as `form.tsx`'s own `seeded` ref).
  useEffect(() => {
    if (seeded.current || !profileLoaded) return;
    const stored = isLite ? (liteQuery.data?.website ?? '') : (hiveQuery.data?.profile?.website ?? '');
    seeded.current = true;
    originalRef.current = stored;
    setValue(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoaded]);

  const dirty = value.trim() !== originalRef.current;

  const handleChange = (next: string): void => {
    // ★ A KEYSTROKE COUNTS AS SEEDED (2026-08-30). Without this, a reader who
    // starts typing before the profile read resolves would have it silently
    // overwritten the instant that read completes — the seeding effect above
    // only checks `seeded.current`, and a fast typist can beat the network. The
    // save itself is still gated on `profileLoaded` regardless (see
    // `handleSave`), so this only affects the prefill race, never what gets
    // merged and sent.
    seeded.current = true;
    setValue(next);
    if (error) setError(null);
    if (savedClean) setSavedClean(false);
  };

  const handleSave = async (): Promise<void> => {
    const trimmed = value.trim();
    if (!isValidWorkLink(trimmed)) {
      // Never discard what was typed — the box keeps exactly what was written;
      // only the message beneath it changes. This is the original objection
      // ("an input that quietly discards what is typed is worse than no
      // input") and it must stay answered.
      setError(t('settings_page.invalid_url'));
      return;
    }
    if (!profileLoaded) return; // belt-and-suspenders: button is disabled for this too
    setError(null);
    setSaving(true);
    try {
      if (isLite) {
        const merged: LumenProfile = { ...(liteQuery.data ?? {}), website: trimmed };
        const result = await saveLiteProfile(merged);
        if (result.status === 'error') {
          handleError(new Error(result.message), { method: 'WorkLinkField.saveLiteProfile', params: {} });
          return;
        }
        originalRef.current = trimmed;
        setSavedClean(true);
        await queryClient.invalidateQueries({ queryKey: ['liteProfile', account] });
        toast({ title: t('settings_page.changes_saved'), variant: 'success' });
        return;
      }

      // ★★★ ITS OWN BUTTON, ITS OWN SIGNATURE (owner requirement, 2026-08-30).
      // `handleSave` only ever runs from a direct click on the button rendered
      // below — never from the launch flow's hold-to-strike action, and this
      // component is never given access to that flow's `block` /
      // `blockMessage` / `onContinue` to begin with, so there is no path by
      // which a refused or failed signature here could block or fail the
      // launch. `useUpdateProfileMutation` already toasts on success and
      // already calls `handleError` on failure (which quietly no-ops a
      // user-cancelled signature rather than showing a scary error — see
      // `packages/ui/lib/handle-error.tsx`), so this only needs to know
      // success/failure to decide whether to advance the local "saved"
      // baseline; it never re-announces either outcome itself.
      const chainProfile = hiveQuery.data?.profile;
      const params = {
        profile_image: chainProfile?.profile_image || undefined,
        cover_image: chainProfile?.cover_image || undefined,
        name: chainProfile?.name || undefined,
        about: chainProfile?.about || undefined,
        location: chainProfile?.location || undefined,
        website: trimmed || undefined,
        witness_owner: chainProfile?.witness_owner,
        witness_description: chainProfile?.witness_description,
        blacklist_description: chainProfile?.blacklist_description || undefined,
        muted_list_description: chainProfile?.muted_list_description || undefined,
        /*
         * ★★★ WITHOUT THIS, SAVING A WORK LINK DESTROYS THE CREATOR'S HIVE PROFILE
         * (2026-08-30). `updateProfile` used to broadcast a fresh object of exactly
         * the ten keys above as the account's WHOLE `posting_json_metadata`, so
         * every other key went with it — on chain, irreversibly, under a success
         * toast. Measured on 108 real accounts: 61% carry at least one key outside
         * that set (`pinned`, `tokens`, `badges`, `collections`, `twitter`, …).
         * The defect is older than this field and shared with account settings; what
         * this field changed is WHO reaches it — a creator launching a Meritum, who
         * has no reason to think they are rewriting their Hive profile.
         * Passing the current document makes the write a merge instead of a replace.
         */
        existingPostingJsonMetadata: hiveQuery.data?.posting_json_metadata
      };
      try {
        await updateProfileMutation.mutateAsync(params);
        originalRef.current = trimmed;
        setSavedClean(true);
      } catch {
        // Already surfaced by useUpdateProfileMutation's own onError above —
        // nothing more to do here except leave the field exactly as typed.
      }
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || updateProfileMutation.isPending;

  return (
    <div className={containerClassName}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          inputMode="url"
          value={value}
          disabled={busy}
          maxLength={200}
          placeholder={t('meritum_launch.work_link_placeholder')}
          aria-label={t('meritum_launch.work_link')}
          aria-invalid={error !== null}
          onChange={(e) => handleChange(e.target.value)}
          className={inputClassName}
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !dirty || !profileLoaded}
          className={buttonClassName}
        >
          {busy ? t('meritum_launch.work_saving') : t('meritum_launch.work_save')}
        </button>
      </div>
      {error ? (
        <p className={errorClassName} role="status">
          {error}
        </p>
      ) : savedClean && !dirty ? (
        <p className={statusClassName} role="status">
          {t('meritum_launch.work_saved')}
        </p>
      ) : null}
    </div>
  );
};

export default WorkLinkField;
