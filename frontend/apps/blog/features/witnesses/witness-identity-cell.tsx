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
        {/* ★ W-10: the avatars raced and failed. The first General render showed none
            at all, and the Params tab rendered them as broken-image icons inline in
            the table (naturalWidth 0). A monogram sits UNDER the image, so a failed or
            slow load lands on the witness's initial instead of a broken glyph, and the
            image removes itself rather than leaving one behind. The alt was empty on
            every row, which for a link to somebody's profile is a missing name, not a
            decorative image. */}
        <span
          className={`relative flex h-[38px] w-[38px] shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-[#f1f3f5] font-sans text-[15px] font-bold uppercase text-[#9ca3af] ${row.isDisabled ? 'opacity-40 grayscale' : ''}`}
          aria-hidden="true"
        >
          {row.owner.slice(0, 1)}
          <img
            src={getUserAvatarUrl(row.owner, 'medium')}
            alt=""
            width={38}
            height={38}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
            className="absolute inset-0 h-[38px] w-[38px] rounded-[11px] object-cover"
          />
        </span>
        <span className="sr-only">{t('witnesses.profile_link_aria', { witness: row.owner })}</span>
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
        {/* ★ W-12: General truncated the statement at a different width from Params, so
            the column visibly reflowed on tab switch, and the EMPTY-STATE string was
            being truncated too ("No witness statement p..."), which is the one string
            that can never be too long. One fixed width for both tabs, and the fallback
            is never clipped. */}
        <div
          className={`max-w-[340px] font-sans text-[12.5px] text-[#9ca3af] ${row.description ? 'truncate' : ''}`}
        >
          {row.description || t('witnesses.no_description')}
        </div>
      </div>
    </div>
  );
}
