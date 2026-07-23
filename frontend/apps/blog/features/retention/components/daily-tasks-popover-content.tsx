'use client';

import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useAppStore } from '@/blog/store/app';
import { DAILY_TASKS } from '../lib/tasks';
import type { DailyTask, DailyTaskId } from '../types';

// The Daily 5 checklist (HABIT layer). On-chain tasks are server-truth (from the
// summary); forgeable ones (show-up / read) are claimed client-side through the
// store's retention slice, which persists via storage-with-ttl (UTC-date-keyed,
// SESSION TTL) — never raw localStorage. Editing that only cheats your own
// cosmetic bar; it is firewalled from the league tier.

const LABEL_BY_ID: Record<DailyTaskId, string> = DAILY_TASKS.reduce(
  (acc, task) => {
    acc[task.id] = task.labelKey;
    return acc;
  },
  {} as Record<DailyTaskId, string>
);

export interface DailyTasksPopoverContentProps {
  tasks: DailyTask[];
}

export function DailyTasksPopoverContent({ tasks }: DailyTasksPopoverContentProps) {
  const { t } = useTranslation('common_blog');
  const claims = useAppStore((s) => s.retentionClaims);
  const claimForgeableTask = useAppStore((s) => s.claimForgeableTask);

  const rows = useMemo(
    () =>
      tasks.map((task) => ({
        ...task,
        // Forgeable tasks may be locally claimed on top of the server value.
        done: task.verifiable ? task.done : task.done || Boolean(claims[task.id])
      })),
    [tasks, claims]
  );

  const doneCount = rows.filter((r) => r.done).length;

  const onClaim = (task: DailyTask, done: boolean) => {
    if (task.verifiable || done) return;
    claimForgeableTask(task.id);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-sans text-[14px] font-semibold text-[#161511]">
          {t('retention.daily_tasks')}
        </span>
        <span className="text-[13px] tabular-nums text-[#6b7280]">
          {t('retention.tasks_progress', { done: doneCount, total: rows.length })}
        </span>
      </div>

      <ul className="mt-2.5 flex flex-col gap-1.5">
        {rows.map((task) => {
          const interactive = !task.verifiable && !task.done;
          return (
            <li key={task.id}>
              <button
                type="button"
                disabled={!interactive}
                onClick={() => onClaim(task, task.done)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors',
                  interactive ? 'cursor-pointer hover:bg-[#f1f3f5]' : 'cursor-default'
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    task.done ? 'border-[#161511] bg-[#161511] text-white' : 'border-[#d1d5db] bg-white'
                  )}
                  aria-hidden="true"
                >
                  {task.done && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span
                  className={cn(
                    'flex-1 text-[14px]',
                    task.done ? 'text-[#9ca3af] line-through' : 'text-[#374151]'
                  )}
                >
                  {t(LABEL_BY_ID[task.id])}
                </span>
                <span className="text-[12px] font-medium tabular-nums text-[#9ca3af]">
                  +{task.xp}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
