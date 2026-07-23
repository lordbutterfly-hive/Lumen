import ReturnThresholdCard from './return-threshold-card';
import ProxyCard from './proxy-card';

interface Props {
  thresholdHp: number | undefined;
  currentProxy: string;
}

/** The two page-specific right-rail cards (the shared RightRail widgets live elsewhere). */
export default function ProposalsRightRail({ thresholdHp, currentProxy }: Props) {
  return (
    <aside className="flex w-full flex-col gap-5" data-testid="proposals-right-rail">
      <ReturnThresholdCard thresholdHp={thresholdHp} />
      <ProxyCard currentProxy={currentProxy} />
    </aside>
  );
}
