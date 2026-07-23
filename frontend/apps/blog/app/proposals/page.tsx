import ProposalsContent from '@/blog/features/proposals/components/proposals-content';
import {
  getHivePerMVestsLive,
  getProposalsList,
  getTreasuryHbdBalance,
  getUserProposalVoteIds
} from '@/blog/features/proposals/lib/proposals-api';
import { getObserver } from '@/blog/lib/auth-utils';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

const ProposalsPage = async () => {
  const observer = await getObserver();
  const isLoggedInHint = observer !== DEFAULT_OBSERVER;

  const [proposalsResult, treasuryResult, hivePerMVestsResult, votesResult] = await Promise.allSettled([
    getProposalsList(),
    getTreasuryHbdBalance(),
    getHivePerMVestsLive(),
    isLoggedInHint ? getUserProposalVoteIds(observer) : Promise.resolve(null)
  ]);

  if (proposalsResult.status === 'rejected') {
    logger.error(proposalsResult.reason, 'Error fetching DHF proposals list:');
  }
  if (treasuryResult.status === 'rejected') {
    logger.error(treasuryResult.reason, 'Error fetching DHF treasury balance:');
  }
  if (hivePerMVestsResult.status === 'rejected') {
    logger.error(hivePerMVestsResult.reason, 'Error computing hivePerMVests:');
  }
  if (votesResult.status === 'rejected') {
    logger.error(votesResult.reason, 'Error fetching user proposal votes:');
  }

  return (
    <ProposalsContent
      initialProposals={proposalsResult.status === 'fulfilled' ? proposalsResult.value : null}
      initialTreasuryHbdBalance={treasuryResult.status === 'fulfilled' ? treasuryResult.value : null}
      initialHivePerMVests={hivePerMVestsResult.status === 'fulfilled' ? hivePerMVestsResult.value : null}
      initialVotedProposalIds={
        votesResult.status === 'fulfilled' && votesResult.value ? Array.from(votesResult.value) : null
      }
    />
  );
};

export default ProposalsPage;
