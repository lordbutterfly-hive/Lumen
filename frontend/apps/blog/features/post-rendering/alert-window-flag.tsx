import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@ui/components/alert-dialog';
import { Input, Separator } from '@ui/components';
import { ReactNode, useState } from 'react';
import ln2list from '../../lib/ln2list';
import { useTranslation } from '@/blog/i18n/client';
import { useFlagMutation } from '../../components/hooks/use-flag-mutation';
import { handleError } from '@ui/lib/handle-error';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

export function AlertDialogFlag({
  children,
  community,
  username,
  permlink,
  flagText
}: {
  children: ReactNode;
  community: string;
  username: string;
  flagText: string;
  permlink: string;
}) {
  const { user } = useUserClient();
  const [notes, setNotes] = useState('');
  const { t } = useTranslation('common_blog');
  const flagMutation = useFlagMutation();

  // Flagging is a chain operation (a community custom_json) and there is no
  // Lumen-local equivalent — a report that only exists in our database is not a
  // report to the community's moderators. A keyless lite account therefore cannot
  // do it, and this dialog is the ONE place to say so: it is shared by the post
  // page and every comment, both of which called it with no tier check at all and
  // surfaced a raw signer error.
  const isLite = user.account_tier === 'lite';

  const flag = async () => {
    if (isLite) {
      handleError(new Error(t('post_content.flag.lite_cannot_flag')), {
        method: 'flag',
        params: { community, username, permlink }
      });
      return;
    }
    try {
      await flagMutation.mutateAsync({ community, username, permlink, notes });
    } catch (error) {
      handleError(error, { method: 'flag', params: { community, username, permlink, notes } });
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent className="flex flex-col gap-8 sm:rounded-r-xl">
        <AlertDialogHeader className="gap-2">
          <div className="flex items-center justify-between">
            <AlertDialogTitle data-testid="flag-dialog-header">
              {t('post_content.flag.flag_post')}
            </AlertDialogTitle>
            <AlertDialogCancel className="border-none hover:text-destructive" data-testid="flag-dialog-close">
              X
            </AlertDialogCancel>
          </div>
          <AlertDialogDescription className="flex flex-col gap-2" data-testid="flag-dialog-description">
            <div>{t('post_content.flag.flag_description')}</div>

            <Separator />
            <h1 className="text-lg font-bold">{t('post_content.flag.community_rules')}</h1>
            {ln2list(flagText).map((x, i) => (
              <p key={i + 1}>{`${i + 1}. ${x}`}</p>
            ))}
            <Separator />

            <Input className="mt-2" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
          <AlertDialogCancel className="hover:text-destructive" data-testid="flag-dialog-cancel">
            {t('post_content.flag.cancel')}
          </AlertDialogCancel>
          {user && user.isLoggedIn ? (
            isLite ? (
              <p className="max-w-prose self-center text-sm text-destructive" data-testid="flag-dialog-lite">
                {t('post_content.flag.lite_cannot_flag')}
              </p>
            ) : (
              <AlertDialogAction
                className="rounded-none bg-foreground text-secondary shadow-lg shadow-destructive hover:bg-destructive hover:shadow-foreground disabled:bg-gray-400 disabled:shadow-none"
                data-testid="flag-dialog-ok"
                onClick={flag}
              >
                {t('post_content.flag.ok')}
              </AlertDialogAction>
            )
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
