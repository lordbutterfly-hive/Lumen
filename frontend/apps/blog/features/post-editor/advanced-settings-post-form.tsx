'use client';

import { Checkbox, Input, Label, ScrollArea, Separator } from '@ui/components';
import { Button } from '@ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@ui/components/dialog';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { toast } from '@ui/components/hooks/use-toast';
import { DEFAULT_PREFERENCES, Preferences } from '@/blog/lib/utils';
import badActorList from '@ui/config/lists/bad-actor-list';
import clsx from 'clsx';
import { useTranslation } from '@/blog/i18n/client';
import { Beneficiary } from './beneficiary-item';
import { maxAcceptedPayout, validateAltUsernameInput } from './lib/utils';
import {
  ALTERNATIVE_AUTHOR_DESCRIPTION,
  ALTERNATIVE_AUTHOR_LABEL,
  ALTERNATIVE_AUTHOR_PLACEHOLDER
} from './lib/composer-copy';

type AccountFormValues = {
  title: string;
  postArea: string;
  postSummary: string;
  tags: string;
  author: string;
  category: string;
  beneficiaries: {
    account: string;
    weight: string;
  }[];
  maxAcceptedPayout: number;
  payoutType: string;
};
type Template = AccountFormValues & {
  templateTitle: string;
};

export function AdvancedSettingsPostForm({
  children,
  username,
  data,
  updateForm
}: {
  children: ReactNode;
  username: string;
  data: AccountFormValues;
  updateForm: (data: AccountFormValues) => void;
}) {
  const { t } = useTranslation('common_blog');
  // Username is guaranteed here since this is only accessible when logged in
  const [preferences] = useStorageWithTTL<Preferences>(
    `user-preferences-${username}`,
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );

  const maxPayoutOptions = [
    { value: 'no_max', label: t('submit_page.advanced_settings_dialog.no_limit') },
    { value: '0', label: t('submit_page.advanced_settings_dialog.decline_payout') },
    { value: 'custom', label: t('submit_page.advanced_settings_dialog.custom_value') }
  ];
  const authorRewardsOptions = [
    { value: '50%', label: '50% HBD / 50% HP' },
    { value: '100%', label: t('submit_page.advanced_settings_dialog.power_up') }
  ];

  const [rewards, setRewards] = useState(
    preferences.blog_rewards !== '100%' ? '50%' : preferences.blog_rewards
  );
  const [templateTitle, setTemplateTitle] = useState('');
  const [maxPayout, setMaxPayout] = useState<'no_max' | '0' | 'custom'>(
    preferences.blog_rewards === '100%' || preferences.blog_rewards === '50%' ? 'no_max' : '0'
  );
  const [selectTemplate, setSelectTemplate] = useState('/');
  const [beneficiaries, setBeneficiaries] = useState<{ weight: string; account: string }[]>(
    data.beneficiaries
  );
  const splitRewards = useMemo(() => {
    const combinedPercentage = beneficiaries.reduce<number>((acc, beneficiary) => {
      return acc + Number(beneficiary.weight);
    }, 0);
    return 100 - combinedPercentage;
  }, [beneficiaries]);
  const [customValue, setCustomValue] = useState(
    data.maxAcceptedPayout !== 1000000 ? data.maxAcceptedPayout : '100'
  );
  const [open, setOpen] = useState(false);
  /**
   * ★ THE ALTERNATIVE AUTHOR LIVES HERE NOW (2026-08-10, C-3). It used to be a
   * bare, unlabelled input in the main metadata card, seen by every writer. It
   * is a Condenser-era field that only writes `json_metadata.alternativeAuthor`
   * — it does not change who signs the post or who is paid — so it belongs with
   * the other settings a normal post never touches.
   *
   * Held as local dialog state, like every other control in here, and only
   * pushed into the form on Save. The value is re-seeded from the form each
   * time the dialog opens (see the `open` effect below) so Cancel really means
   * cancel.
   */
  const [altAuthor, setAltAuthor] = useState(data.author);
  const altAuthorError = validateAltUsernameInput(altAuthor, t);
  // Templates are permanent user data
  const [storedTemplates, storeTemplates] = useStorageWithTTL<Template[]>(
    `hivePostTemplates-${username}`,
    [],
    StorageTTL.PERMANENT
  );
  const hasDuplicateUsernames = beneficiaries.reduce((acc, beneficiary, index, array) => {
    const isDuplicate = array.slice(index + 1).some((b) => b.account === beneficiary.account);
    return acc || isDuplicate;
  }, false);
  const beneficiariesNames =
    beneficiaries.length !== 0 ? beneficiaries.some((beneficiary) => beneficiary.account.length < 3) : false;
  const selfBeneficiary =
    beneficiaries.length !== 0
      ? beneficiaries.some((beneficiary) => beneficiary.account === username)
      : false;
  const badActor = beneficiaries.some((beneficiary) => badActorList.includes(beneficiary.account));
  const smallWeight = beneficiaries.find((e) => Number(e.weight) <= 0);
  const isTemplateStored = storedTemplates.some((template) => template.templateTitle === templateTitle);
  const currentTemplate = storedTemplates.find((e) => e.templateTitle === selectTemplate);

  const getBeneficiaryError = (): string | null => {
    if (splitRewards < 0) return t('submit_page.advanced_settings_dialog.your_percent');
    if (hasDuplicateUsernames) return t('submit_page.advanced_settings_dialog.beneficiaries_cannot');
    if (beneficiariesNames) return t('submit_page.advanced_settings_dialog.account_name');
    if (selfBeneficiary) return t('submit_page.advanced_settings_dialog.beneficiary_cannot_be_self');
    if (smallWeight) return t('submit_page.advanced_settings_dialog.beneficiary_percent_invalid');
    if (badActor) return t('submit_page.advanced_settings_dialog.bad_actor');
    return null;
  };

  useEffect(() => {
    setMaxPayout(preferences.blog_rewards === '100%' || preferences.blog_rewards === '50%' ? 'no_max' : '0');
    setRewards(preferences.blog_rewards !== '100%' ? '50%' : preferences.blog_rewards);
  }, [preferences.blog_rewards]);

  useEffect(() => {
    setRewards(rewards);
    setMaxPayout(maxPayout);
    setBeneficiaries(beneficiaries);
    setCustomValue(customValue);
    // Re-seed from the form every time the dialog opens or closes, so closing
    // without saving leaves the post exactly as it was.
    setAltAuthor(data.author);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (maxPayout === '0') {
      setRewards('50%');
    }
  }, [maxPayout]);

  const handleAddAccount = () => {
    setBeneficiaries((prev) => [...prev, { weight: '0', account: '' }]);
  };

  const handleDeleteItem = (index: number) => {
    setBeneficiaries((prev) => {
      const newItems = [...prev];
      newItems.splice(index, 1);
      return newItems;
    });
  };

  const handleEditBeneficiary = (index: number, weight: string, account: string) => {
    setBeneficiaries((prev) =>
      prev.map((beneficiary, beneficiaryIndex) =>
        index !== beneficiaryIndex ? beneficiary : { weight, account }
      )
    );
  };

  function deleteTemplate(templateName: string) {
    // ★ `storeTemplates` reports whether the write landed (2026-08-09). Throwing
    //   that away meant a full localStorage silently kept the template: the row
    //   disappeared from the list, and came back on the next page load.
    const stored = storeTemplates(storedTemplates.filter((e) => e.templateTitle !== templateName));
    if (!stored) {
      toast({
        title: t('submit_page.advanced_settings_dialog.template_delete_failed'),
        variant: 'destructive'
      });
      return;
    }
    setSelectTemplate('/');
  }

  function handleTemplates(e: string) {
    const template = storedTemplates.find((template) => template.templateTitle === e);
    if (template) {
      setBeneficiaries(template.beneficiaries);
      setRewards(template.payoutType);
      if (template.maxAcceptedPayout === 1000000) {
        setMaxPayout('no_max');
      }
      if (template.maxAcceptedPayout === 0) {
        setMaxPayout('0');
      }
      if (Number(template.maxAcceptedPayout) > 0 && Number(template.maxAcceptedPayout) < 1000000) {
        setMaxPayout('custom');
        setCustomValue(Number(template.maxAcceptedPayout));
      }
    }
    setSelectTemplate(e);
  }
  function handleTemplateTitle(e: string) {
    setSelectTemplate('/');
    setTemplateTitle(e);
  }

  function loadTemplate() {
    updateForm({
      title: currentTemplate?.title || '',
      postArea: currentTemplate?.postArea || '',
      postSummary: currentTemplate?.postSummary || '',
      tags: currentTemplate?.tags || '',
      author: currentTemplate?.author || '',
      category: currentTemplate?.category || '',
      beneficiaries: beneficiaries,
      maxAcceptedPayout: maxAcceptedPayout(customValue, maxPayout),
      payoutType: rewards
    });
    setSelectTemplate('/');
    setOpen(false);
    toast({
      title: t('submit_page.advanced_settings_dialog.template_loaded'),
      variant: 'success'
    });
  }
  function onSave() {
    // ★★ SAVE TEMPLATE IGNORED ITS OWN RESULT (2026-08-10). Both writes below
    //    discarded the boolean and the function then toasted "changes saved"
    //    unconditionally, so a template that did not fit in localStorage was
    //    reported as saved and was simply gone next time. The settings half of
    //    this dialog always succeeds (it is in-memory form state); only the
    //    template half can fail, so the message below distinguishes them rather
    //    than claiming everything failed.
    let templateStored = true;
    if (selectTemplate !== '/') {
      templateStored = storeTemplates(
        storedTemplates.map((stored) =>
          stored.templateTitle !== selectTemplate
            ? stored
            : {
                title: data.title,
                postArea: data.postArea,
                postSummary: data.postSummary,
                tags: data.tags,
                author: altAuthor,
                category: data.category,
                templateTitle: selectTemplate,
                beneficiaries: beneficiaries,
                maxAcceptedPayout: maxAcceptedPayout(customValue, maxPayout),
                payoutType: rewards
              }
        )
      );
    }

    if (templateTitle !== '') {
      setTemplateTitle('');
      // `&&` not `=`: the two branches are mutually exclusive today (picking a
      // template clears the new-name field and vice versa) but nothing enforces
      // that, and a second write must not be able to erase the first one's answer.
      templateStored = storeTemplates([
        ...storedTemplates,
        {
          title: data.title,
          postArea: data.postArea,
          postSummary: data.postSummary,
          tags: data.tags,
          author: altAuthor,
          category: data.category,
          templateTitle: templateTitle,
          beneficiaries: beneficiaries,
          maxAcceptedPayout: maxAcceptedPayout(customValue, maxPayout),
          payoutType: rewards
        }
      ]) && templateStored;
    }
    updateForm({
      ...data,
      author: altAuthor,
      beneficiaries: beneficiaries,
      maxAcceptedPayout: maxAcceptedPayout(customValue, maxPayout),
      payoutType: rewards
    });
    setSelectTemplate('/');
    setOpen(false);
    toast({
      title: templateStored
        ? t('submit_page.advanced_settings_dialog.changes_saved')
        : t('submit_page.advanced_settings_dialog.template_save_failed'),
      variant: templateStored ? 'success' : 'destructive'
    });
  }

  function authorRewardsText(author_rewards: string): string {
    const def = '50% HBD / 50% HP';
    let text;
    switch (author_rewards) {
      case '0%':
        text = t('settings_page.decline_payout');
        break;
      case '50%':
        text = def;
        break;
      case '100%':
        text = t('settings_page.power_up');
        break;
      default:
        text = def;
    }
    return text;
  }

  return (
    <Dialog open={open} onOpenChange={() => setOpen((prev) => !prev)}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-[425px]"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-2xl" data-testid="advanced-settings-title">
            {t('submit_page.advanced_settings_dialog.advanced_settings')}
          </DialogTitle>
          <Separator />
        </DialogHeader>
        <div className="flex flex-col gap-4 text-caption">
          <div className="flex flex-col gap-3">
            <span className="text-lg font-bold">
              {t('submit_page.advanced_settings_dialog.maximum_accepted_payout')}
            </span>
            <span>{t('submit_page.advanced_settings_dialog.value_of_the_maximum')}</span>
            <div className="flex flex-col gap-1">
              <div className="my-3 grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:justify-center">
                {maxPayoutOptions.map((e) => (
                  <div key={e.value} className="text-center">
                    <Checkbox
                      id={e.value}
                      className="hidden"
                      onCheckedChange={() => setMaxPayout(e.value as 'no_max' | '0' | 'custom')}
                      data-testid={`maximum-accepted-payout-${e.value}`}
                    />
                    <Label
                      htmlFor={e.value}
                      className={clsx('inline-block cursor-pointer rounded-lg border p-2', {
                        'border-destructive bg-border': maxPayout === e.value,
                        'text-muted-foreground': maxPayout !== e.value
                      })}
                    >
                      {e.label}
                    </Label>
                  </div>
                ))}
              </div>
              {maxPayout === 'custom' ? (
                <>
                  <Input
                    type="number"
                    value={customValue}
                    onChange={(e) => setCustomValue(e.target.value)}
                    data-testid="maximum-accepted-payout-custom-value-input"
                  />
                  <div className="p-2 text-red-600">
                    {Number(customValue) < 0
                      ? t('submit_page.advanced_settings_dialog.cannot_be_less_than')
                      : Number(customValue) >= 1000000
                        ? t('submit_page.advanced_settings_dialog.cannot_be_more_than')
                        : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-lg font-bold">
              {t('submit_page.advanced_settings_dialog.author_rewards')}
            </span>
            <span>{t('submit_page.advanced_settings_dialog.what_type_of_tokens')}</span>
            <div className="my-3 grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:justify-center">
              {authorRewardsOptions.map((e) => (
                <div key={e.value} className="text-center">
                  <Checkbox
                    id={e.value}
                    className="hidden"
                    onCheckedChange={() => setRewards(e.value)}
                    disabled={maxPayout === '0'}
                    data-testid={`autor-rewards-${e.value}`}
                  />
                  <Label
                    htmlFor={e.value}
                    className={clsx('inline-block cursor-pointer rounded-lg border p-2', {
                      'border-destructive bg-border': rewards === e.value,
                      'text-muted-foreground': rewards !== e.value
                    })}
                  >
                    {e.label}
                  </Label>
                </div>
              ))}
            </div>
            <span>
              {t('submit_page.advanced_settings_dialog.default')}
              {authorRewardsText(preferences.blog_rewards)}
            </span>
            <Link href={`/@${username}/settings`} className="text-destructive">
              {t('submit_page.advanced_settings_dialog.update')}
            </Link>
          </div>
          <div>
            <ul className="flex flex-col gap-2">
              <li className="flex items-center gap-5">
                <Input value={splitRewards + '%'} disabled className="w-16" />
                <div className="relative col-span-3">
                  <Input disabled value={username} className="block w-full px-3 py-2.5 pl-11" />
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Icons.atSign className="h-5 w-5" />
                  </div>
                </div>
              </li>
              {beneficiaries.map((item, index) => (
                <div className="flex" key={index}>
                  <Beneficiary
                    onChangeBeneficiary={(weight, account) => handleEditBeneficiary(index, weight, account)}
                    beneficiary={item}
                  />
                  <Button
                    variant="link"
                    size="xs"
                    className="text-destructive"
                    onClick={() => handleDeleteItem(index)}
                  >
                    {t('submit_page.advanced_settings_dialog.delete')}
                  </Button>
                </div>
              ))}
            </ul>
            <div className="p-2 text-destructive">{getBeneficiaryError()}</div>
            {beneficiaries.length < 8 ? (
              <Button
                variant="link"
                className="h-fit w-fit px-0 py-1 text-caption text-destructive"
                onClick={handleAddAccount}
                data-testid="add-beneficiar-account"
              >
                {t('submit_page.advanced_settings_dialog.add_account')}
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-3" data-testid="alternative-author-box">
            <span className="text-lg font-bold">{ALTERNATIVE_AUTHOR_LABEL}</span>
            <span>{ALTERNATIVE_AUTHOR_DESCRIPTION}</span>
            <Input
              value={altAuthor}
              placeholder={ALTERNATIVE_AUTHOR_PLACEHOLDER}
              onChange={(e) => setAltAuthor(e.target.value)}
              className={clsx({ 'border-red-500 focus-visible:ring-red-500': altAuthorError })}
              aria-label={ALTERNATIVE_AUTHOR_LABEL}
              aria-invalid={Boolean(altAuthorError)}
              data-testid="alternative-author-input"
            />
            {altAuthorError ? <div className="text-destructive">{altAuthorError}</div> : null}
          </div>
          <div className="flex flex-col gap-3" data-testid="post-templates-box">
            <span className="text-lg font-bold">
              {t('submit_page.advanced_settings_dialog.post_templates')}
            </span>
            <span>{t('submit_page.advanced_settings_dialog.manage_your_post_templates')}</span>
            <div className="flex flex-col gap-1">
              <ScrollArea
                className=" h-fit max-h-48 rounded-md border p-4"
                data-testid="list-of-post-templates"
              >
                {storedTemplates && storedTemplates.length > 0
                  ? storedTemplates.map((e) => (
                      <div
                        key={e.templateTitle}
                        onClick={() => handleTemplates(e.templateTitle)}
                        data-testid="template-list-item"
                        data-template-name={e.templateTitle}
                        className={clsx(
                          'cursor-pointer border-b border-border p-1 text-base hover:bg-border',
                          {
                            'border-destructive': selectTemplate === e.templateTitle
                          }
                        )}
                      >
                        {e.templateTitle}
                      </div>
                    ))
                  : (
                      <span data-testid="no-templates-message">
                        {t('submit_page.advanced_settings_dialog.no_templates_found')}
                      </span>
                    )}
              </ScrollArea>
              <Input
                placeholder={t('submit_page.advanced_settings_dialog.name_of_a_new_template')}
                value={templateTitle}
                onChange={(e) => handleTemplateTitle(e.target.value)}
                data-testid="name-of-a-new-template-input"
              />
              {isTemplateStored ? (
                <div className="p-2 text-destructive" data-testid="template-name-taken-error">
                  {t('submit_page.advanced_settings_dialog.template_name_is_taken')}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="submit"
            variant="redHover"
            onClick={() => onSave()}
            disabled={
              Number(customValue) < 0 ||
              Number(customValue) >= 1000000 ||
              splitRewards < 0 ||
              hasDuplicateUsernames ||
              isTemplateStored ||
              beneficiariesNames ||
              selfBeneficiary ||
              Boolean(smallWeight) ||
              badActor ||
              Boolean(altAuthorError)
            }
            data-testid="advanced-settings-save-button"
          >
            {t('submit_page.advanced_settings_dialog.save')}
          </Button>
          {currentTemplate ? (
            <Button
              variant="redHover"
              onClick={() => loadTemplate()}
              data-testid="advanced-settings-load-template-button"
            >
              {t('submit_page.advanced_settings_dialog.load')}
            </Button>
          ) : null}
          {selectTemplate !== '/' ? (
            <Button
              variant="redHover"
              onClick={() => deleteTemplate(selectTemplate)}
              data-testid="advanced-settings-delete-template-button"
            >
              {t('submit_page.advanced_settings_dialog.delete_template')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
