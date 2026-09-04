import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTrigger } from '@ui/components/dialog';
import NotificationActivities from './notification-content';
import type { IAccountNotification } from '@hive/common-hiveio-packages/wax';

export function ActivityLogDialog({
  children,
  data,
  username,
  unavailable,
  pending
}: {
  children: ReactNode;
  data: IAccountNotification[] | null | undefined;
  username: string;
  /** The notifications read FAILED. `data` is undefined either way; only this tells them apart. */
  unavailable?: boolean;
  /** The notifications read has not answered yet. */
  pending?: boolean;
}) {
  return (
    <Dialog>
      <DialogTrigger>
        <div className="cursor-pointer text-destructive">{children}</div>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2/3 h-5/6 overflow-auto px-1 pt-1">
        <NotificationActivities
          data={data}
          username={username}
          unavailable={unavailable}
          pending={pending}
        />
      </DialogContent>
    </Dialog>
  );
}
