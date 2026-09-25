import { FC } from 'react';

/** Token amounts in the Studio: two decimals, as the contract's 0.01 unit. */
export const tok = (n: number) => n.toFixed(2);

/** The Studio's card. Shared with the requests list, which the inbox renders too. */
export const Card: FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div
    className={`rounded-panel border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)] ${className}`}
  >
    {children}
  </div>
);
