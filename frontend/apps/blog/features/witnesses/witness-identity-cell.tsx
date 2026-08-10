import { Link, getUserAvatarUrl } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { toSafeExternalUrl } from './lib/safe-external-url';
import { WitnessRow } from './lib/types';

interface WitnessIdentityCellProps {
  row: WitnessRow;
  /**
   * Extra classes for the cell's own box. The row uses it to pin this cell to
   * the left edge of the table's scroller — merged onto the existing element
   * rather than added as a wrapper, so the grid item stays exactly the one the
   * desktop layout was measured against.
   */
  className?: string;
}

/**
 * Avatar + name + running-version chip + short witness statement, with
 * the name linking to the witness's real profile page and (when the
 * witness published a valid https announcement URL) an external-link
 * icon linking out to it.
 */
export default function WitnessIdentityCell({ row, className }: WitnessIdentityCellProps) {
  const { t } = useTranslation('common_blog');
  const externalUrl = toSafeExternalUrl(row.url);

  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      <Link href={`/@${row.owner}`} className="shrink-0">
        <img
          src={getUserAvatarUrl(row.owner, 'medium')}
          alt=""
          width={38}
          height={38}
          className={`h-[38px] w-[38px] rounded-[11px] object-cover ${row.isDisabled ? 'opacity-40 grayscale' : ''}`}
        />
      </Link>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link
            href={`/@${row.owner}`}
            data-testid="witness-name-link"
            className={`font-sans text-[14.5px] font-bold ${row.isDisabled ? 'text-[#9ca3af] line-through' : 'text-[#161511]'}`}
          >
            {row.owner}
          </Link>
          <span className="rounded-md bg-[#eef2ff] px-[6px] py-px font-sans text-[10.5px] font-bold tabular-nums text-[#4f5bd5]">
            {row.running_version || t('witnesses.unknown_version')}
          </span>
          {externalUrl && (
            <Link
              href={externalUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t('witnesses.announcement_link_aria', { witness: row.owner })}
              className="text-[#9ca3af] hover:text-[#c0392b]"
            >
              <Icons.externalLink className="h-[13px] w-[13px]" />
            </Link>
          )}
        </div>
        <div className="max-w-[340px] truncate font-sans text-[12.5px] text-[#9ca3af]">
          {row.description || t('witnesses.no_description')}
        </div>
      </div>
    </div>
  );
}
