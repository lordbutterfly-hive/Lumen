import * as React from 'react';
import { VariantProps, cva } from 'class-variance-authority';

import { cn } from '@ui/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center border rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'bg-primary hover:bg-primary/80 border-transparent text-primary-foreground',
        secondary: 'bg-secondary hover:bg-secondary/80 border-transparent text-secondary-foreground',
        desctructive: 'bg-destructive hover:bg-secondary/80 border-transparent text-destructive-foreground',
        outline: 'text-foreground',
        red: 'text-ink-brand-8 cursor-default border-line-brand-8  bg-destructive bg-surface-1 cursor-text',
        lime: 'bg-surface-1 cursor-default border-line-ok-4 text-ink-ok-3 cursor-text',
        orange: 'bg-surface-1 border-line-warn-7 cursor-default text-ink-warn-5 cursor-text'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div
      data-testid="affiliation-tag-badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
