import { Button } from '@ui/components/button';
import { Input } from '@ui/components/input';
import { Link } from '@hive/ui';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@ui/components/accordion';
import clsx from 'clsx';
import { IFollowList } from '@hive/common-hiveio-packages/wax';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { handleError } from '@ui/lib/handle-error';
import { CircleSpinner } from 'react-spinners-kit';
import { useResetAllListsMutation } from '@/blog/components/hooks/use-reset-mutations';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { LoginType } from '@smart-signer/types/common';
import { Search, UserPlus } from 'lucide-react';
import ListItem from './list-item';
import { useAddToListForm } from './hooks/use-add-to-list-form';
import ResetAllListsDialog from './reset-all-lists-dialog';

// ★ THE APP'S OWN CARD LANGUAGE (F9, 2026-08-11, buildmap item 15 — "/lists is a
// third design system: centred narrow column, lowercase pill buttons, a bare
// disclosure — shares nothing with the feed cards or the settings page"). Same
// white / rounded-18 / hairline-border / one-pixel-lift card the right rail and
// settings already use (`right-rail.tsx`'s `CARD_CLASS`, `account-settings/lib
// /card.ts`'s `SETTINGS_CARD`), not a fourth one invented for this page. The
// page is also no longer force-narrowed to `max-w-lg` (512px) — it now fills
// the same main-column width settings does.
const LIST_CARD =
  'w-full rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';
const LIST_CARD_TITLE = 'font-serif text-[18px] font-semibold leading-[28px] text-[#161511]';
const LIST_SECTION_HEADING = 'flex items-center gap-2 text-[15px] leading-[24px] font-semibold text-[#161511]';

const ListArea = ({
  titleBy,
  listTitle,
  resetTitle,
  listDescription,
  data,
  isLoading,
  resetListIsLoading,
  accountOwner,
  splitArrays,
  variant,
  handleAdd,
  handleReset,
  onSearchChange
}: {
  titleBy: string;
  listTitle: string;
  resetTitle: string;
  listDescription?: string;
  data: IFollowList[] | undefined;
  isLoading: boolean;
  resetListIsLoading: boolean;
  accountOwner: boolean;
  splitArrays: IFollowList[][];
  variant: 'blacklisted' | 'muted' | 'followBlacklist' | 'followMutedList';
  handleAdd: (name: string) => Promise<unknown>;
  handleReset: () => void;
  onSearchChange: (e: string) => void;
}) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const resetAllListsMutation = useResetAllListsMutation();
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    if (resetAllListsMutation.isPending || resetListIsLoading) {
      setDisabled(true);
    } else {
      setTimeout(() => {
        setDisabled(false);
      }, 3000);
    }
  }, [resetAllListsMutation.isPending, resetListIsLoading]);
  const resetAll = async () => {
    try {
      await resetAllListsMutation.mutateAsync();
    } catch (error) {
      handleError(error, { method: 'resetAll', params: {} });
    }
  };
  const [page, setPage] = useState(0);
  const [addValue, setAddValue] = useState('');
  const totalItems = data?.filter((e) => e.name !== 'null').length ?? 0;

  // B1/B3 — existing names (for dedupe + "already on list" rejection), fed to the
  // add-form state machine below. Recomputed only when the list itself changes.
  const existingNames = useMemo(() => (data ?? []).filter((e) => e.name !== 'null').map((e) => e.name), [data]);
  const { phase: addPhase, error: addError, submitRaw, cancel: cancelAdd } = useAddToListForm(existingNames, handleAdd);
  const addBusy = addPhase === 'checking' || addPhase === 'confirming';

  const triggerAdd = async () => {
    if (!addValue.trim() || addBusy) return;
    const ok = await submitRaw(addValue);
    if (ok) setAddValue('');
  };

  const addErrorText = (() => {
    if (!addError) return null;
    const names = addError.names?.join(', ');
    switch (addError.kind) {
      case 'empty_input':
        return t('user_profile.lists.list.error_empty_input');
      case 'already_on_list':
        return t('user_profile.lists.list.error_already_on_list', { names });
      case 'invalid_format':
        return t('user_profile.lists.list.error_invalid_format', { names });
      case 'not_found':
        return t('user_profile.lists.list.error_not_found', { names });
      case 'api_error':
        return t('user_profile.lists.list.error_api_error', { names });
      case 'timeout':
        return t('user_profile.lists.list.error_timeout');
      case 'rejected':
        return t('user_profile.lists.list.error_rejected');
      case 'cancelled':
        return t('user_profile.lists.list.error_cancelled');
      case 'broadcast_failed':
      default:
        return t('user_profile.lists.list.error_broadcast_failed', { message: addError.message ?? '' });
    }
  })();

  const confirmingLabel =
    user.loginType === LoginType.keychain
      ? t('user_profile.lists.list.confirm_in_keychain')
      : t('user_profile.lists.list.confirm_waiting_signature');

  return (
    <div data-testid="user-list-area" className="flex w-full flex-col gap-4">
      <Accordion type="single" collapsible className={LIST_CARD}>
        <AccordionItem value="item-1" className="border-none">
          <AccordionTrigger className="py-0 text-sm font-medium text-[#6b7280] hover:text-[#c0392b] hover:no-underline">
            {t('user_profile.lists.list.what_is_this')}
          </AccordionTrigger>
          <AccordionContent className="pt-3 text-sm text-primary/70">
            {t('user_profile.lists.list.show_or_hide_descripton_one')}
            <Link href={`/@/settings`} className="text-destructive hover:underline">
              {t('user_profile.lists.list.settings')}
            </Link>
            {t('user_profile.lists.list.show_or_hide_descripton_two')}
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className={LIST_CARD}>
        <h1 data-testid="user-list-title" className={LIST_CARD_TITLE}>
          {titleBy}
        </h1>
        <p
          className={clsx('mt-1.5 text-[13px] leading-[20px] text-[#6b7280]', {
            hidden: !listDescription
          })}
        >
          {t('user_profile.lists.list.list_description')}
          {listDescription ?? t('user_profile.lists.list.description_not_added')}
        </p>

        {/* List */}
        <ul
          data-testid="user-list-container"
          className="mt-4 w-full overflow-hidden rounded-[14px] border border-[#ebebeb]"
        >
          {data && data.length === 0 && !isLoading ? (
            <li
              data-testid="user-list-empty"
              className="px-4 py-8 text-center text-sm text-primary/50"
            >
              {t('user_profile.lists.list.empty_list')}
            </li>
          ) : splitArrays.length > 0 ? (
            splitArrays[page].map((e: IFollowList) => (
              <ListItem
                item={e}
                loading={resetListIsLoading}
                accountOwner={accountOwner}
                listTitle={listTitle}
                variant={variant}
                key={e.name}
              />
            ))
          ) : null}
          {isLoading ? (
            <li className="flex items-center justify-center py-4">
              <CircleSpinner loading={isLoading} size={18} color="#dc2626" />
            </li>
          ) : null}
        </ul>

        {/* Pagination */}
        {splitArrays.length > 1 ? (
          <div className="mt-4 flex flex-col items-center gap-2">
          <div className="flex gap-1">
            <Button variant="outlineRed" disabled={page === 0} size="sm" onClick={() => setPage(0)}>
              {t('user_profile.lists.list.first_button')}
            </Button>
            <Button variant="outlineRed" disabled={page === 0} size="sm" onClick={() => setPage(page - 1)}>
              {t('user_profile.lists.list.previous_button')}
            </Button>
            <Button
              variant="outlineRed"
              disabled={page === splitArrays.length - 1}
              size="sm"
              onClick={() => setPage(page + 1)}
            >
              {t('user_profile.lists.list.next_button')}
            </Button>
            <Button
              variant="outlineRed"
              disabled={page === splitArrays.length - 1}
              size="sm"
              onClick={() => setPage(splitArrays.length - 1)}
            >
              {t('user_profile.lists.list.last_button')}
            </Button>
          </div>
          <span className="text-xs text-primary/50">
            {t('user_profile.lists.list.viewing_page', { current: page + 1, total: splitArrays.length })}
            {' \u00B7 '}
            {totalItems} {totalItems === 1 ? 'item' : 'items'}
          </span>
        </div>
      ) : totalItems > 0 ? (
        <span className="mt-3 block text-xs text-primary/50">
          {totalItems} {totalItems === 1 ? 'item' : 'items'}
        </span>
      ) : null}
      </div>

      {/* Add account */}
      {accountOwner ? (
        <div className={LIST_CARD}>
          <h2 className={LIST_SECTION_HEADING}>
            <UserPlus className="h-4 w-4 text-[#c0392b]" />
            {t('user_profile.lists.list.add_account_to_list')}
          </h2>
          <span className="mt-1 block text-xs text-[#6b7280]">{t('user_profile.lists.list.single_account')}</span>
          <div className="mt-3 flex w-full gap-2">
            <Input
              className="bg-background"
              placeholder="username"
              value={addValue}
              // ★ B1 fix: no `.trim()` here. A controlled input that trims on every
              // keystroke turns any space you type into a trailing character for one
              // render and strips it before the next key lands — every delimiter space
              // in "null, steemit, ned" was being eaten as you typed it. Splitting and
              // trimming now happen once, at submit time, in parseAccountListInput.
              onChange={(e) => setAddValue(e.target.value)}
              error={addPhase === 'error'}
              disabled={resetListIsLoading || resetAllListsMutation.isPending || addBusy}
              data-testid="add-to-list-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addValue && !isLoading && !disabled && !addBusy) {
                  void triggerAdd();
                }
              }}
            />
            {/* ★ ALWAYS ON SCREEN, NOT HIDDEN UNTIL TYPED (F9, 2026-08-11, O4).
                This rendered `null` for an empty field — so the section was a text
                box with nothing next to it and no visible way to submit, and a
                reader had to guess Enter was the only path in. A disabled submit
                reads as "type something, then press me" instead of looking
                unfinished. */}
            <Button
              disabled={!addValue.trim() || isLoading || disabled || addBusy}
              className="min-w-[90px] shrink-0"
              data-testid="add-to-list-submit"
              onClick={() => void triggerAdd()}
            >
              {addPhase === 'checking' ? (
                <span className="flex items-center gap-2">
                  <CircleSpinner loading size={16} color="#fff" />
                  {t('user_profile.lists.list.checking_accounts')}
                </span>
              ) : addPhase === 'confirming' ? (
                <CircleSpinner loading size={16} color="#fff" />
              ) : isLoading ? (
                <CircleSpinner loading={isLoading} size={16} color="#fff" />
              ) : (
                t('user_profile.lists.list.add_to_list')
              )}
            </Button>
          </div>

          {/* B2 fix — an explicit "confirm in your wallet" state instead of an
              unexplained spinner, plus a way out instead of spinning forever. */}
          {addPhase === 'confirming' ? (
            <div
              className="flex w-full items-center justify-between gap-2 rounded-md border border-border-primary/30 bg-background-tertiary/50 px-3 py-2 text-xs"
              data-testid="add-to-list-confirming"
            >
              <span className="flex items-center gap-2 text-primary/70">
                <CircleSpinner loading size={14} color="#dc2626" />
                {confirmingLabel}
              </span>
              <button
                type="button"
                className="shrink-0 text-destructive underline"
                data-testid="add-to-list-cancel"
                onClick={cancelAdd}
              >
                {t('user_profile.lists.list.cancel')}
              </button>
            </div>
          ) : null}

          {addErrorText ? (
            <p className="w-full text-center text-xs text-destructive" data-testid="add-to-list-error">
              {addErrorText}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Search */}
      <div className={LIST_CARD}>
        <h2 className={LIST_SECTION_HEADING}>
          <Search className="h-4 w-4 text-[#c0392b]" />
          {t('user_profile.lists.list.search_this_list')}
        </h2>
        <div className="mt-3 w-full">
          <Input
            onChange={(e) => onSearchChange(e.target.value)}
            className="bg-background"
            placeholder={t('user_profile.lists.list.search_this_list')}
          />
        </div>
      </div>

      {/* Reset options */}
      {accountOwner ? (
        <div className={LIST_CARD} data-testid="list-reset-options">
          <h2 className={LIST_SECTION_HEADING}>{t('user_profile.lists.list.reset_options')}</h2>
          <div className="mt-3">
            <Button
              onClick={() => {
                handleReset();
              }}
              size="sm"
              variant="outlineRed"
              className="min-w-[120px] text-xs"
              disabled={disabled}
            >
              {resetListIsLoading ? <CircleSpinner loading size={18} color="#dc2626" /> : resetTitle}
            </Button>
          </div>
          {/* ★★★ THE NUKE-EVERYTHING BUTTON, GATED (F9, 2026-08-11, buildmap item
              14 / O5). This used to be a second button in the row above — the
              DEFAULT (solid primary) variant, no confirmation, sitting right next
              to the outline single-list reset — so the action that clears all
              four lists in one broadcast carried the STRONGEST visual weight on
              the page and fired on one accidental click. It is now
              `ResetAllListsDialog`: a small muted text link, separated below a
              divider, that opens a type-RESET-to-confirm dialog before it does
              anything. See that file's own doc comment for the full reasoning. */}
          <div className="mt-4 border-t border-[#f1f3f5] pt-3">
            <ResetAllListsDialog
              onConfirm={resetAll}
              isPending={resetAllListsMutation.isPending}
              disabled={disabled}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};
export default ListArea;
