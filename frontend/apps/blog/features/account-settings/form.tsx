'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAccountFull } from '@transaction/lib/hive-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { fetchLiteProfile, saveLiteProfile } from '@/blog/lib/lite/client/lite-profile';
import { MutableRefObject, ReactNode, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, Settings, processAndUploadImg, validation } from './lib/utils';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useUpdateProfileMutation } from './hooks/use-update-profile-mutation';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@ui/components/select';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { DEFAULT_PREFERENCES, Preferences } from '@/blog/lib/utils';
import { CircleSpinner } from 'react-spinners-kit';
import { Signer } from '@smart-signer/lib/signer/signer';
import { useSignerContext } from '@smart-signer/components/signer-provider';
import {
  SETTINGS_CARD,
  SETTINGS_CARD_HINT,
  SETTINGS_CARD_TITLE,
  SETTINGS_INPUT,
  SETTINGS_LABEL
} from './lib/card';

/** Radix select drawn in the house style — same border, radius and focus ink as
 *  the text fields beside it, so the two controls read as one form. */
const SELECT_TRIGGER =
  'h-10 w-full rounded-[10px] border border-[#e4e6e9] bg-white px-3 font-sans text-[13.5px] text-[#161511] focus:ring-0 focus:ring-offset-0 focus-visible:border-[#c0392b] [&>svg]:opacity-100 [&>svg]:text-[#6b7280]';
const SELECT_CONTENT = 'rounded-[12px] border border-[#e4e6e9] bg-white p-1 shadow-[0_8px_24px_rgba(20,18,10,0.10)]';
const SELECT_ITEM =
  'cursor-pointer rounded-[9px] py-2 font-sans text-[13.5px] text-[#161511] focus:bg-[#fdf2f0] focus:text-[#c0392b]';

/**
 * ★ S7 — DIRTY-FIELD CUE (2026-08-11). The Update button already goes from
 * grey to red the moment ANY field differs from what was loaded, but nothing
 * on the page said WHICH field caused that — a reader who touched one of nine
 * inputs had to remember which one themselves. `isDirty` marks that one field:
 * a small dot beside its label, `aria-hidden` because it is reinforcement of
 * something the value itself already conveys, not new information — and
 * `data-dirty` so this is checkable in a test without relying on color.
 */
const Field = ({
  htmlFor,
  label,
  error,
  isDirty,
  children
}: {
  htmlFor: string;
  label: string;
  error?: string | null;
  isDirty?: boolean;
  children: ReactNode;
}) => (
  <div data-dirty={isDirty ? 'true' : 'false'}>
    <label className={SETTINGS_LABEL} htmlFor={htmlFor}>
      {label}
      {isDirty ? (
        <span
          className="ml-1.5 inline-block h-[6px] w-[6px] rounded-full bg-[#c0392b] align-middle"
          aria-hidden="true"
          data-testid="field-dirty-dot"
        />
      ) : null}
    </label>
    {children}
    {error ? <p className="mt-1.5 text-[12px] text-[#c0392b]">{error}</p> : null}
  </div>
);

const SettingsForm = ({ username }: { username: string }) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // A Lumen lite account has no Hive account behind it, so there is nothing to read
  // from chain and nothing to broadcast an update to. Its profile lives in our own
  // database and is read and written over /api/lite/profile; every field below
  // behaves the same either way.
  const isLite = user?.account_tier === 'lite';
  const { data } = useQuery({
    queryKey: ['profileData', username],
    queryFn: () => getAccountFull(username),
    enabled: !isLite
  });
  const { data: liteProfile } = useQuery({
    queryKey: ['liteProfile', username],
    queryFn: () => fetchLiteProfile(),
    enabled: isLite
  });
  // User preferences are permanent (no TTL) - username is guaranteed here since this is a settings page
  const [preferences, setPreferences] = useStorageWithTTL<Preferences>(
    `user-preferences-${username}`,
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );
  /**
   * ★ S6 — PREFERENCES SAVE SILENTLY (2026-08-11). Unlike the profile card
   * above (an explicit Update button, a toast on success), every Preferences
   * combobox wrote straight to localStorage on `onValueChange` with no
   * feedback at all — a reader who picked "Always hide" for NSFW content had
   * no way to tell it took effect versus the click having done nothing. This
   * writes AND confirms in one place, reusing the same `changes_saved` copy
   * the profile save already uses (it is generically true here too — a
   * preference changed and was saved), so this doesn't need a second
   * translation key or a second design language for "it worked".
   */
  const updatePreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPreferences((prev) => ({ ...prev, [key]: value }));
    toast({ title: t('settings_page.changes_saved'), variant: 'success' });
  };
  const chainProfile = data?.profile;
  const profileData: Partial<Settings> = (isLite ? liteProfile : chainProfile) ?? {};

  const { signer } = useSignerContext();
  const queryClient = useQueryClient();
  const [savingLite, setSavingLite] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [insertImg, setInsertImg] = useState('');
  const inputProfileRef = useRef<HTMLInputElement>(null) as MutableRefObject<HTMLInputElement>;
  const inputCoverRef = useRef<HTMLInputElement>(null) as MutableRefObject<HTMLInputElement>;
  const validationCheck = validation(settings, t);
  const profileSettings: Settings = {
    profile_image: profileData?.profile_image ? profileData.profile_image : '',
    cover_image: profileData?.cover_image ? profileData.cover_image : '',
    name: profileData?.name ? profileData.name : '',
    about: profileData?.about ? profileData.about : '',
    location: profileData?.location ? profileData.location : '',
    website: profileData?.website ? profileData.website : '',
    blacklist_description: profileData?.blacklist_description ? profileData.blacklist_description : '',
    muted_list_description: profileData?.muted_list_description ? profileData.muted_list_description : ''
  };

  const updateProfileMutation = useUpdateProfileMutation();

  const sameData =
    profileSettings.profile_image === settings.profile_image &&
    profileSettings.cover_image === settings.cover_image &&
    profileSettings.name === settings.name &&
    profileSettings.location === settings.location &&
    profileSettings.website === settings.website &&
    profileSettings.about === settings.about &&
    profileSettings.blacklist_description === settings.blacklist_description &&
    profileSettings.muted_list_description === settings.muted_list_description;

  const disabledBtn = Object.values(validationCheck).some((value) => typeof value === 'string');

  async function onSubmit() {
    if (isLite) {
      setSavingLite(true);
      const result = await saveLiteProfile({
        name: settings.name,
        about: settings.about,
        location: settings.location,
        website: settings.website,
        profile_image: settings.profile_image,
        cover_image: settings.cover_image
      });
      setSavingLite(false);
      if (result.status === 'error') {
        handleError(new Error(result.message), { method: 'saveLiteProfile', params: {} });
        return;
      }
      // Re-read rather than assume: the server normalises what it stores (a website
      // that isn't a real URL is dropped), so showing the submitted value would tell
      // the user something was saved that was not.
      await queryClient.invalidateQueries({ queryKey: ['liteProfile', username] });
      toast({ title: t('settings_page.changes_saved'), variant: 'success' });
      return;
    }

    const updateProfileParams = {
      profile_image: settings.profile_image !== '' ? settings.profile_image : undefined,
      cover_image: settings.cover_image !== '' ? settings.cover_image : undefined,
      name: settings.name !== '' ? settings.name : undefined,
      about: settings.about !== '' ? settings.about : undefined,
      location: settings.location !== '' ? settings.location : undefined,
      website: settings.website !== '' ? settings.website : undefined,
      witness_owner: chainProfile?.witness_owner,
      witness_description: chainProfile?.witness_description,
      blacklist_description:
        settings.blacklist_description !== '' ? settings.blacklist_description : undefined,
      muted_list_description:
        settings.muted_list_description !== '' ? settings.muted_list_description : undefined
    };

    try {
      await updateProfileMutation.mutateAsync(updateProfileParams);

      toast({
        title: t('settings_page.changes_saved'),
        variant: 'success'
      });
    } catch (error) {
      handleError(error, { method: 'updateProfile', params: updateProfileParams });
    }
  }

  const inputProfileHandler = async (event: { target: { files: FileList } }) => {
    if (event.target.files && event.target.files.length === 1) {
      setInsertImg('');
      const url = await onImageUpload(event.target.files[0], username, signer);
      setSettings((prev) => ({ ...prev, profile_image: url }));
    }
  };

  const onImageUpload = async (file: File, username: string, signer: Signer) => {
    const url = await processAndUploadImg(file, username, signer);
    return url;
  };
  const inputCoverHandler = async (event: { target: { files: FileList } }) => {
    if (event.target.files && event.target.files.length === 1) {
      setInsertImg('');
      const url = await onImageUpload(event.target.files[0], username, signer);
      setSettings((prev) => ({ ...prev, cover_image: url }));
    }
  };

  // ★ SEED WHEN THE PROFILE ARRIVES, NOT WHEN THE COMPONENT MOUNTS (2026-08-10).
  //
  // This was `useEffect(..., [])`, which copies whatever the profile query holds
  // at mount — and on a client-side navigation into settings that is nothing at
  // all. Every field then rendered EMPTY over a profile that has a name, a bio
  // and a location, and because `settings` no longer matched the loaded profile
  // the Update button lit up offering to save that emptiness. Seeding is still
  // one-shot, so a refetch can never overwrite something being typed.
  const seeded = useRef(false);
  const source = isLite ? liteProfile : data;
  useEffect(() => {
    if (seeded.current || !source) return;
    seeded.current = true;
    setSettings(profileSettings);
    // `profileSettings` is derived from `source` and would change identity on
    // every render; `source` is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const busy = updateProfileMutation.isPending || savingLite;

  return (
    <>
      <section className={SETTINGS_CARD} data-testid="settings-public-profile">
        <h2 className={SETTINGS_CARD_TITLE}>{t('settings_page.public_profile_settings')}</h2>
        <p className={SETTINGS_CARD_HINT}>{t('settings_page.settings_intro')}</p>

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field
            htmlFor="profileImage"
            label={t('settings_page.profile_image_url')}
            error={validationCheck.profile_image}
            isDirty={settings.profile_image !== profileSettings.profile_image}
          >
            <input
              type="text"
              id="profileImage"
              name="profileImage"
              className={SETTINGS_INPUT}
              value={settings.profile_image}
              onChange={(e) => setSettings((prev) => ({ ...prev, profile_image: e.target.value }))}
            />
            <label
              className="mt-1.5 inline-block cursor-pointer text-[12.5px] font-semibold text-[#c0392b] hover:text-[#96271b]"
              htmlFor="profilePicture"
            >
              {t('settings_page.upload_image')}
            </label>
            <input
              id="profilePicture"
              type="file"
              className="hidden"
              ref={inputProfileRef}
              accept=".jpg,.png,.jpeg,.jfif,.gif,.webp,.heic,.heif"
              name="avatar"
              value={insertImg}
              //@ts-expect-error the handler narrows `files` to a non-null FileList
              onChange={inputProfileHandler}
            />
          </Field>

          <Field
            htmlFor="coverImage"
            label={t('settings_page.cover_image_url')}
            error={validationCheck.cover_image}
            isDirty={settings.cover_image !== profileSettings.cover_image}
          >
            <input
              type="text"
              id="coverImage"
              name="coverImage"
              className={SETTINGS_INPUT}
              value={settings.cover_image}
              onChange={(e) => setSettings((prev) => ({ ...prev, cover_image: e.target.value }))}
            />
            <label
              className="mt-1.5 inline-block cursor-pointer text-[12.5px] font-semibold text-[#c0392b] hover:text-[#96271b]"
              htmlFor="coverPicture"
            >
              {t('settings_page.upload_image')}
            </label>
            <input
              id="coverPicture"
              type="file"
              className="hidden"
              ref={inputCoverRef}
              accept=".jpg,.png,.jpeg,.jfif,.gif,.webp,.heic,.heif"
              name="avatar"
              value={insertImg}
              //@ts-expect-error the handler narrows `files` to a non-null FileList
              onChange={inputCoverHandler}
            />
          </Field>

          <Field
            htmlFor="name"
            label={t('settings_page.profile_name')}
            error={validationCheck.name}
            isDirty={settings.name !== profileSettings.name}
          >
            <input
              type="text"
              id="name"
              name="name"
              className={SETTINGS_INPUT}
              value={settings.name}
              onChange={(e) => setSettings((prev) => ({ ...prev, name: e.target.value }))}
            />
          </Field>

          <Field
            htmlFor="about"
            label={t('settings_page.profile_about')}
            error={validationCheck.about}
            isDirty={settings.about !== profileSettings.about}
          >
            <input
              // ★ A BIO IS NOT AN EMAIL ADDRESS (2026-08-07). This was
              // `type="email"`, so a normal sentence tripped the browser's own
              // validity check ("Please include an '@'…") and phones offered an
              // email keyboard for a free-text bio.
              type="text"
              id="about"
              name="about"
              className={SETTINGS_INPUT}
              value={settings.about}
              onChange={(e) => setSettings((prev) => ({ ...prev, about: e.target.value }))}
            />
          </Field>

          <Field
            htmlFor="location"
            label={t('settings_page.profile_location')}
            error={validationCheck.location}
            isDirty={settings.location !== profileSettings.location}
          >
            <input
              type="text"
              id="location"
              name="location"
              className={SETTINGS_INPUT}
              value={settings.location}
              onChange={(e) => setSettings((prev) => ({ ...prev, location: e.target.value }))}
            />
          </Field>

          <Field
            htmlFor="website"
            label={t('settings_page.profile_website')}
            error={validationCheck.website}
            isDirty={settings.website !== profileSettings.website}
          >
            <input
              type="text"
              id="website"
              name="website"
              className={SETTINGS_INPUT}
              value={settings.website}
              onChange={(e) => setSettings((prev) => ({ ...prev, website: e.target.value }))}
            />
          </Field>

          {/*
            Blacklists and mute lists are on-chain follow lists published by an
            account. A lite user has no account to publish them from, so these two
            describe something they cannot have — hidden rather than shown broken.
          */}
          {isLite ? null : (
            <>
              <Field
                htmlFor="blacklistDescription"
                label={t('settings_page.blacklist_description')}
                error={validationCheck.blacklist_description}
                isDirty={settings.blacklist_description !== profileSettings.blacklist_description}
              >
                <input
                  type="text"
                  id="blacklistDescription"
                  name="blacklistDescription"
                  className={SETTINGS_INPUT}
                  value={settings.blacklist_description}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, blacklist_description: e.target.value }))
                  }
                />
              </Field>

              <Field
                htmlFor="mutedListDescription"
                label={t('settings_page.mute_list_description')}
                error={validationCheck.muted_list_description}
                isDirty={settings.muted_list_description !== profileSettings.muted_list_description}
              >
                <input
                  type="text"
                  id="mutedListDescription"
                  name="mutedListDescription"
                  className={SETTINGS_INPUT}
                  value={settings.muted_list_description}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, muted_list_description: e.target.value }))
                  }
                />
              </Field>
            </>
          )}
        </div>

        {/* House button: brand red, 14px radius, bold Open Sans. Still disabled
            when there is nothing to save — but it now looks like the product's
            own button doing that, not a dead grey pill. */}
        <button
          type="button"
          onClick={() => onSubmit()}
          data-testid="pps-update-button"
          className="mt-6 inline-flex h-11 min-w-[176px] items-center justify-center rounded-[14px] bg-[#c0392b] px-6 text-[14px] font-bold text-white transition-colors hover:bg-[#96271b] disabled:cursor-not-allowed disabled:bg-[#e6e2df] disabled:text-[#9ca3af]"
          disabled={
            sameData ||
            disabledBtn ||
            busy ||
            // `_temporary` marks a stand-in account object (an unconfirmed chain
            // write). It never applies to the lite path, which does not read chain
            // data at all — leaving it in would permanently disable this button for
            // every lite user.
            (!isLite && data?._temporary)
          }
        >
          {busy ? <CircleSpinner loading size={18} color="#ffffff" /> : t('settings_page.update')}
        </button>
        {/* ★ THE GREY STATE HAD NO EXPLANATION (audit item 13). The colour swap
            (red = something to save, grey = nothing to save) reads correctly
            once you know the rule, but nothing on the page states the rule
            itself — so a reader who has not yet touched a field sees a
            greyed-out button with no way to tell "not done loading", "broken"
            and "nothing changed yet" apart. Static text, not state-dependent:
            it is true regardless of which of those three is why the button
            looks the way it does right now. */}
        {sameData && !busy ? (
          <p className="mt-2 text-[12.5px] text-[#6b7280]">{t('settings_page.update_hint')}</p>
        ) : null}
      </section>

      <section className={SETTINGS_CARD} data-testid="settings-preferences">
        <h2 className={SETTINGS_CARD_TITLE}>{t('settings_page.preferences')}</h2>

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          <div data-testid="not-safe-for-work-content">
            <label className={SETTINGS_LABEL} htmlFor="not-safe-for-work-content">
              {t('settings_page.not_safe_for_work_nsfw_content')}
            </label>
            <Select
              value={preferences.nsfw}
              onValueChange={(e: 'hide' | 'warn' | 'show') => updatePreference('nsfw', e)}
              name="not-safe-for-work-content"
            >
              {/* ★ S5 — `id` MATCHING THE LABEL'S `htmlFor` (2026-08-11). The
                  `<label htmlFor>` above already pointed at this id; nothing
                  in this tree ever carried it, so the a11y tree reported a
                  bare `combobox` with an empty accessible name on all four of
                  these — verified via the accessibility tree, not by eye.
                  `button` is a labelable element, so this alone wires the
                  association (no `aria-labelledby` needed). */}
              <SelectTrigger id="not-safe-for-work-content" className={SELECT_TRIGGER}>
                <SelectValue placeholder={t('settings_page.not_safe_for_work_nsfw_content')} />
              </SelectTrigger>
              <SelectContent className={SELECT_CONTENT}>
                <SelectGroup>
                  <SelectItem className={SELECT_ITEM} value="hide">
                    {t('settings_page.always_hide')}
                  </SelectItem>
                  <SelectItem className={SELECT_ITEM} value="warn">
                    {t('settings_page.always_warn')}
                  </SelectItem>
                  <SelectItem className={SELECT_ITEM} value="show">
                    {t('settings_page.always_show')}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div data-testid="blog-post-rewards">
            <label className={SETTINGS_LABEL} htmlFor="blog-post-rewards">
              {t('settings_page.choose_default_blog_payout')}
            </label>
            <Select
              value={preferences.blog_rewards}
              onValueChange={(e: '0%' | '50%' | '100%') => updatePreference('blog_rewards', e)}
              name="blog-post-rewards"
            >
              <SelectTrigger id="blog-post-rewards" className={SELECT_TRIGGER}>
                <SelectValue placeholder={t('settings_page.choose_default_blog_payout')} />
              </SelectTrigger>
              <SelectContent className={SELECT_CONTENT}>
                <SelectGroup>
                  <SelectItem className={SELECT_ITEM} value="0%">
                    {t('settings_page.decline_payout')}
                  </SelectItem>
                  <SelectItem className={SELECT_ITEM} value="50%">
                    {'50% HBD / 50% HP'}
                  </SelectItem>
                  <SelectItem className={SELECT_ITEM} value="100%">
                    {t('settings_page.power_up')}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div data-testid="comment-post-rewards">
            <label className={SETTINGS_LABEL} htmlFor="comment-post-rewards">
              {t('settings_page.choose_default_comment_payout')}
            </label>
            <Select
              name="comment-post-rewards"
              value={preferences.comment_rewards}
              onValueChange={(e: '0%' | '50%' | '100%') => updatePreference('comment_rewards', e)}
            >
              <SelectTrigger id="comment-post-rewards" className={SELECT_TRIGGER}>
                <SelectValue placeholder={t('settings_page.choose_default_comment_payout')} />
              </SelectTrigger>
              <SelectContent className={SELECT_CONTENT}>
                <SelectGroup>
                  <SelectItem className={SELECT_ITEM} value="0%">
                    {t('settings_page.decline_payout')}
                  </SelectItem>
                  <SelectItem className={SELECT_ITEM} value="50%">
                    {'50% HBD / 50% HP'}
                  </SelectItem>
                  <SelectItem className={SELECT_ITEM} value="100%">
                    {t('settings_page.power_up')}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div data-testid="referral-system">
            <label className={SETTINGS_LABEL} htmlFor="referral-system">
              {t('settings_page.default_beneficiaries')}
            </label>
            <Select
              name="referral-system"
              value={preferences.referral_system}
              onValueChange={(e: 'enabled' | 'disabled') => updatePreference('referral_system', e)}
            >
              <SelectTrigger id="referral-system" className={SELECT_TRIGGER}>
                <SelectValue placeholder={t('settings_page.default_beneficiaries')} />
              </SelectTrigger>
              <SelectContent className={SELECT_CONTENT}>
                <SelectGroup>
                  <SelectItem className={SELECT_ITEM} value="enabled">
                    {t('settings_page.default_beneficiaries_enabled')}
                  </SelectItem>
                  <SelectItem className={SELECT_ITEM} value="disabled">
                    {t('settings_page.default_beneficiaries_disabled')}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>
    </>
  );
};

export default SettingsForm;
