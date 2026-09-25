import { prepareVotes } from '@ui/lib/utils';
import type { Entry, IVote } from '@hive/common-hiveio-packages/wax';
import BasePathLink from '../../components/base-path-link';
import { useActiveVotesQuery } from '../../components/hooks/use-active-votes';
import { useTranslation } from '@/blog/i18n/client';

const VotersDetailsData = ({ post, onShowAll }: { post: Entry; onShowAll?: () => void }) => {
  const { t } = useTranslation('common_blog');
  const { data } = useActiveVotesQuery(post.author, post.permlink);

  /**
   * ★★★ DOWNVOTERS ARE NOT LISTED (2026-08-16, spec §3.7 of "Demote the downvote
   * to an overflow-menu action").
   *
   * The downvote arrow and every downvote tally are gone from the UI, so a list
   * that still named downvoters would be the one place the product advertised
   * downvoting, and it would disagree with the number beside the upvote arrow:
   * that tally counts upvotes only, while this list came straight from
   * `active_votes`, which contains both.
   *
   * Filtered on `rshares > 0` rather than on the formatted value: `prepareVotes`
   * derives a display amount from the reward pool, so a genuine upvote can round
   * to $0.00 on a small post and would be dropped by an amount-based test. The
   * sign of rshares is the actual direction of the vote.
   *
   * The MATHS is untouched: payout still reflects downvotes exactly as before
   * (they reduce net_rshares upstream of any display code). Only the roster is
   * filtered.
   */
  const votes = data && prepareVotes(post, data).filter((v) => v.rshares > 0);

  const sliced =
    votes &&
    votes
      .sort((a, b) => {
        const keyA = Math.abs(a.rshares);
        const keyB = Math.abs(b.rshares);
        if (keyA > keyB) return -1;
        if (keyA < keyB) return 1;
        return 0;
      })
      .slice(0, 20);

  return (
    <ul data-testid="list-of-voters">
      {sliced &&
        sliced.map((vote: IVote, index: number) => (
          <li key={index}>
            <BasePathLink href={`/@${vote.voter}`} className="hover:cursor-pointer hover:text-ink-brand-7">
              {vote.voter}
              {vote.reward
                ? Math.abs(parseFloat(vote.reward.toString())) < 0.0001
                  ? `: $0`
                  : `: $${Number(vote.reward).toFixed(2)}`
                : null}
              {vote.rshares < 0 ? '[-]' : ''}
            </BasePathLink>
          </li>
        ))}
      {/* ★ "AND N MORE" OPENS THE FULL LIST (2026-09-25, owner). It was plain text with
          nothing behind it. The count is the upvotes left after these 20, the same
          roster as the list above: `stats.total_votes` also counts downvotes, which
          this list deliberately leaves out. */}
      {votes && votes.length > 20 ? (
        <li className="pt-1.5 text-sm">
          {onShowAll ? (
            <button
              type="button"
              onClick={onShowAll}
              className="text-ink-10 underline-offset-2 hover:text-ink-brand-7 hover:underline"
              data-testid="list-of-voters-show-all"
            >
              {t('post_content.footer.and_more', { value: votes.length - 20 })}
            </button>
          ) : (
            <span className="text-ink-10">{t('post_content.footer.and_more', { value: votes.length - 20 })}</span>
          )}
        </li>
      ) : null}
    </ul>
  );
};
export default VotersDetailsData;
