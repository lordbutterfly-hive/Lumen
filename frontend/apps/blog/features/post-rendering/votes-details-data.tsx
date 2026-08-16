import { prepareVotes } from '@ui/lib/utils';
import { Entry, IVote } from '@hive/common-hiveio-packages/wax';
import BasePathLink from '../../components/base-path-link';
import { useActiveVotesQuery } from '../../components/hooks/use-active-votes';
import { useTranslation } from '@/blog/i18n/client';

const VotersDetailsData = ({ post }: { post: Entry }) => {
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
      {votes && votes.length > 20 && post.stats ? (
        <li className="pt-1.5 text-sm text-ink-10">
          {t('post_content.footer.and_more', { value: post.stats.total_votes - 20 })}
        </li>
      ) : null}
    </ul>
  );
};
export default VotersDetailsData;
