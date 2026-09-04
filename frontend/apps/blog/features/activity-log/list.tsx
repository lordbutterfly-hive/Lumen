'use client';

import NotificationListItem from './list-item';
import type { IAccountNotification } from '@hive/common-hiveio-packages/wax';

const NotificationList = ({
  data,
  lastRead,
  isOwner
}: {
  data: IAccountNotification[] | null | undefined;
  lastRead: Date;
  /**
   * Whose list this is. Passed straight through to the row, which cannot work
   * it out for itself any more — see the note on `NotificationListItem`.
   */
  isOwner?: boolean;
}) => {
  return (
    <div className="flex flex-col divide-y divide-border-secondary">
      {data?.map((notification: IAccountNotification, index: number) => (
        <NotificationListItem
          key={`${notification.id}-${notification.type}-${index}`}
          date={notification.date}
          msg={notification.msg}
          score={notification.score}
          type={notification.type}
          url={notification.url}
          lastRead={lastRead}
          isOwner={isOwner}
        />
      ))}
    </div>
  );
};

export default NotificationList;
