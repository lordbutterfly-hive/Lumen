'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { watchArm } from '@/blog/lib/inquisition/arm';
import BasePathLink from '@/blog/components/base-path-link';
import styles from '@/blog/features/layouts/left-rail.module.css';
import { cn } from '@ui/lib/utils';

/**
 * The rail's Inquisition row. Present only while the mode is armed (spec §2.4).
 *
 * ★ IT BORROWS THE RAIL'S OWN ROW CLASSES rather than inventing a shape. The active
 * treatment, the 2px rule and the hover all come from `left-rail.module.css`, so this
 * row cannot drift from the eight above it.
 */
export default function InquisitionRow() {
  const [armed, setArmed] = useState(false);
  const pathname = usePathname();
  useEffect(() => watchArm(setArmed), []);
  if (!armed) return null;
  const active = pathname === '/inquisition';
  return (
    <li>
      <BasePathLink href="/inquisition" data-testid="left-rail-inquisition" aria-current={active ? 'page' : undefined}>
        <span
          className={cn(
            'flex items-center gap-[15.4px] px-[15.4px] py-[12.1px] font-ui text-[16.5px] leading-[26.4px]',
            styles.row
          )}
          data-active={active ? 'true' : undefined}
        >
          <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] shrink-0" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.2" stroke="currentColor" strokeWidth="1.9" />
            <path d="M15.6 15.6 20 20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 truncate">Inquisition</span>
        </span>
      </BasePathLink>
    </li>
  );
}
