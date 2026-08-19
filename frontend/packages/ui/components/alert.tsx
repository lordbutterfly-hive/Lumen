import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@ui/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg]:absolute [&>svg]:text-foreground [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&:has(svg)]:pl-11',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive:
          'text-destructive border-destructive/50 [&>svg]:text-destructive text-destructive',
        success:
          'text-ink-ok-5 border-line-ok-2/50 [&>svg]:text-ink-ok-5 text-ink-ok-5'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = 'Alert';

/**
 * ★★★ `tracking-tight` REPLACED WITH `tracking-title` (2026-08-19, all-Lora).
 *
 * Tailwind's `tracking-tight` is -0.025em, and that value was chosen for Open
 * Sans. Lora has real bracketed serifs and COLLIDES at it — this app has already
 * proved that once, on the wordmark, where the tracking had to go -0.025em ->
 * -0.01em the day the wordmark became Lora (`features/layouts/app-header.tsx`:
 * "a serif with real bracketed serifs collides at that value, and 'Lumen' has an
 * m-n pair that shows it first").
 *
 * `tracking-title` is that same measured -0.01em, now a named token
 * (`packages/tailwindcss/tailwind.config.js`) so the next display face does not
 * need this comment written a third time.
 */
const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn('mb-1 font-medium leading-none tracking-title', className)} {...props} />
  )
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm [&_p]:leading-[24px]', className)} {...props} />
  )
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
