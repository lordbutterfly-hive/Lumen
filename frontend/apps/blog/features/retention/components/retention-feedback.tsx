'use client';

import { useEffect } from 'react';
import { toast } from '@ui/components/hooks/use-toast';
import { useTranslation } from '@/blog/i18n/client';
import { subscribeRetentionMoments, type RetentionMoment } from './retention-moments';

/**
 * Headless. Renders no DOM. Its only job is to hold a real `t` and turn the
 * moments emitted by retention-moments.ts into toasts, so that the emitter
 * itself can stay a plain module callable from non-React code (lite-write.ts).
 *
 * Mounted once, inside <LeagueShowcase /> — which the left rail renders on every
 * page — so no new mount point has to be threaded through a layout somebody else
 * owns. It deliberately mounts even when the showcase itself renders nothing:
 * a lite account has no league block to show and is exactly who these moments
 * are for.
 *
 * Uses the app's existing toast infrastructure (@ui/components/hooks/use-toast,
 * already used in 20+ places, Toaster already mounted in layouts/providers.tsx).
 * No modals. The ceilings live in retention-moments.ts, not here.
 */
export function RetentionFeedback() {
  const { t } = useTranslation('common_blog');

  useEffect(() => {
    const show = (moment: RetentionMoment) => {
      if (moment.key === 'streak-2') {
        toast({
          title: t('retention.moment.streak_2.title'),
          description: t('retention.moment.streak_2.body')
        });
        return;
      }
      // The milestone toast is gone with the milestone nudge (owner ruling,
      // 2026-08-10): its body was "Nobody made you do it.", which is the app
      // congratulating a reader for choosing to be there. See lib/nudge.ts.
      // The goal-met toast is gone with the daily goal itself (owner ruling,
      // 2026-08-18). The first act of the day is the only thing left worth a word, and
      // it already has better copy than "goal met" ever did.
      // First genuine act of the session — copy is per-act, because "you did a
      // thing" is not feedback and a vote is not a post.
      toast({
        title: t(`retention.moment.first_act.${moment.kind}.title`, {
          defaultValue: t('retention.moment.first_act.generic.title')
        }),
        description: t(`retention.moment.first_act.${moment.kind}.body`, {
          defaultValue: t('retention.moment.first_act.generic.body')
        })
      });
    };
    return subscribeRetentionMoments(show);
  }, [t]);

  return null;
}
