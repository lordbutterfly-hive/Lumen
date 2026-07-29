import { useFollowListQuery } from '@/blog/components/hooks/use-follow-list';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useInitialFollowList } from '@/blog/components/observer-provider';
import { useUnmuteMutation } from '@/blog/features/mute-follow/hooks/use-mute-mutations';
import { useTranslation } from '@/blog/i18n/client';
import { Button } from '@ui/components/button';
import { handleError } from '@ui/lib/handle-error';
import { CircleSpinner } from 'react-spinners-kit';

const MutedList = ({ username }: { username: string }) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // ★ OWNERSHIP. This list belongs to `username` — the profile being VIEWED — but
  // the unmute mutation always signs as the LOGGED-IN user. Nothing gates
  // /@anyone/settings, so on someone else's settings page every Unmute button
  // broadcast an unmute from the viewer's own account against a name from a
  // stranger's list: a wasted chain write at best, and at worst it silently
  // undid a mute the viewer had deliberately set. A lite viewer has no signer at
  // all and got a raw crash.
  //
  // The list stays visible (it is public follow data); only the WRITE is gated.
  const canUnmute = user.isLoggedIn && user.account_tier !== 'lite' && user.username === username;
  const initialFollowList = useInitialFollowList();
  const mutedQuery = useFollowListQuery(username, 'muted', initialFollowList);
  const unmuteMutation = useUnmuteMutation();

  return mutedQuery.data ? (
    <div>
      <div>{t('settings_page.muted_users')}</div>
      <ul>
        {mutedQuery.data.map((mutedUser, index) => {
          const mute_item = unmuteMutation.isPending && unmuteMutation.variables?.username === mutedUser.name;
          return (
            <li key={mutedUser.name}>
              <span>{index + 1}. </span>
              <span className="text-destructive">{mutedUser.name}</span>
              {canUnmute ? (
              <Button
                className="h-fit p-1 text-destructive"
                variant="link"
                onClick={async () => {
                  if (!canUnmute) return;
                  const params = { username: mutedUser.name };
                  try {
                    await unmuteMutation.mutateAsync(params);
                  } catch (error) {
                    handleError(error, { method: 'unmute', params });
                  }
                }}
                disabled={mute_item}
              >
                [
                {mute_item ? (
                  <span className="flex items-center justify-center">
                    <CircleSpinner loading={unmuteMutation.isPending} size={18} color="#dc2626" />
                  </span>
                ) : (
                  t('settings_page.unmute')
                )}
                ]
              </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;
};

export default MutedList;
