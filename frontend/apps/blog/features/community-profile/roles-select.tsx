'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui/components/select';
import { Roles, rolesLevels } from './lib/utils';
import { useTranslation } from '@/blog/i18n/client';

const RolesSelect = ({
  loggedUserLevel,
  value,
  onValueChange,
  disabled,
  testId
}: {
  loggedUserLevel: number;
  value: Roles;
  onValueChange: (value: Roles) => void;
  disabled: boolean;
  testId?: string;
}) => {
  const { t } = useTranslation('common_blog');

  return (
    <Select value={value} onValueChange={(e: Roles) => onValueChange(e)} disabled={disabled}>
      {/* Same class as post-select-filter.tsx: role="combobox" does not get an
          accessible name from content, so the visible current role value
          ("Member", "Mod", …) left this nameless (verified via the a11y tree).
          `communities.role` ("Role") already labels this exact control
          visibly in one of the two call sites (add-role.tsx); used directly
          here since this component owns both call sites and neither's
          adjacent markup is reachable from inside it. */}
      <SelectTrigger data-testid={testId} aria-label={t('communities.role')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {rolesLevels.map((role) =>
          role.value < loggedUserLevel ? (
            <SelectItem
              key={role.name}
              value={role.name}
              data-testid={`community-role-option-${role.name}`}
            >
              {t(`communities.${role.name}`)}
            </SelectItem>
          ) : null
        )}
      </SelectContent>
    </Select>
  );
};
export default RolesSelect;
