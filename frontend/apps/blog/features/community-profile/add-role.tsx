'use client';

import { Button, Input, Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@ui/components';
import { useTranslation } from '@/blog/i18n/client';
import { CircleSpinner } from 'react-spinners-kit';
import { Roles } from './lib/utils';
import RolesSelect from './roles-select';
import { useSetRoleMutation } from '@/blog/features/community-profile/hooks/use-set-role-mutations';
import { useState } from 'react';
import type { EAvailableCommunityRoles } from '@hiveio/wax';
import { handleError } from '@ui/lib/handle-error';

const AddRole = ({ community, loggedUserLevel }: { loggedUserLevel: number; community: string }) => {
  const { t } = useTranslation('common_blog');
  const setRoleMutation = useSetRoleMutation();
  const [inputValue, setInputChange] = useState('');
  const [selectValue, setSelectValue] = useState<Roles>('member');
  const [open, setOpen] = useState('');

  const onUpdateRole = async () => {
    try {
      await setRoleMutation.mutateAsync({
        community,
        username: inputValue,
        role: selectValue as EAvailableCommunityRoles
      });
    } catch (error) {
      handleError(error, {
        method: 'setRole',
        params: { community, username: inputValue, role: selectValue as EAvailableCommunityRoles }
      });
    } finally {
      setOpen('');
      setInputChange('');
      setSelectValue('member');
    }
  };
  return (
    // ★ CARD, NOT A BARE ACCORDION ON THE PAGE BACKGROUND (2026-08-14 restyle).
    // `AccordionItem`'s own default is a single `border-b` hairline and
    // nothing else. Sitting directly under the new rounded `line-9`/
    // `surface-1` roles-table card above it, an unbordered block read as
    // unfinished, so this wraps it in the same card treatment. `border-b-0`
    // on `AccordionItem` below cancels the component's own line so there
    // isn't a second, redundant one drawn inside this outer card.
    <div className="mt-4 overflow-hidden rounded-panel border border-line-9 bg-surface-1">
      <Accordion
        type="single"
        collapsible
        value={open}
        onValueChange={(value) => setOpen((prev) => (prev === 'role-item' ? '' : value))}
      >
        <AccordionItem value="role-item" className="border-b-0">
          <AccordionTrigger
            data-testid="community-add-role-trigger"
            className="px-5 py-4 text-14 font-semibold text-ink-2 hover:no-underline hover:bg-surface-10 data-[state=open]:bg-surface-10"
          >
            {t('communities.add_user')}
          </AccordionTrigger>
          <AccordionContent className="px-5 pb-5">
            <div className="flex flex-col gap-5">
              <p className="text-14 text-ink-10">{t('communities.set_the_role_of_a_user_in_this_community')}</p>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="community-add-role-username" className="text-caption font-semibold text-ink-7">
                  {t('communities.username')}
                </label>
                <Input
                  id="community-add-role-username"
                  value={inputValue}
                  onChange={(e) => setInputChange(e.target.value)}
                  className="rounded-control border-line-9"
                  data-testid="community-add-role-username"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-caption font-semibold text-ink-7">{t('communities.role')}</span>
                <div className="w-48">
                  <RolesSelect
                    disabled={setRoleMutation.isLoading}
                    loggedUserLevel={loggedUserLevel}
                    value={selectValue}
                    onValueChange={(e) => setSelectValue(e)}
                    testId="community-add-role-select"
                  />
                </div>
              </div>

              {/* ★ TOKEN BRAND RED, NOT `variant="redHover"` (2026-08-14). That
                  variant is a separate, unrelated button language — rounded-none,
                  a hard offset shadow, a dark-slate resting fill
                  (`bg-surface-39` = #1f2937) that only turns red on hover — and
                  it doesn't appear anywhere in the current warm Lumen surfaces
                  this page now matches. Overridden to the same solid
                  brand-red control every other primary action uses:
                  `surface-brand-12`/`-14` are the SAME generated palette
                  entries as `account-lists/follow-list/tokens.ts`'s
                  `FOLLOW_BUTTON_PRIMARY` (`#c0392b` / `#a93226`), named
                  instead of typed as hex a second time. Verified this
                  className actually wins over the shared `<Button>`'s own
                  `bg-primary`/`rounded-md` via this repo's real
                  `tailwind-merge` build, not assumed. */}
              <Button
                onClick={onUpdateRole}
                size="sm"
                className="w-fit justify-self-end rounded-card bg-surface-brand-12 px-5 text-ink-27 hover:bg-surface-brand-14 hover:opacity-100"
                disabled={setRoleMutation.isLoading}
                data-testid="community-add-role-save"
              >
                {setRoleMutation.isLoading ? (
                  // White-on-red spinner, same convention as
                  // `FollowRowActions`'s busy state — `rgb(var(--ink-27))` is
                  // this palette's white token, not a fresh `#ffffff` literal.
                  <CircleSpinner loading={setRoleMutation.isLoading} size={18} color="rgb(var(--ink-27))" />
                ) : (
                  t('communities.save')
                )}
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
};

export default AddRole;
