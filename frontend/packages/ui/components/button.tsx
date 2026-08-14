import * as React from 'react';
import { VariantProps, cva } from 'class-variance-authority';

import { cn } from '@ui/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-80',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive border hover:border-destructive',
        outline: 'border border-input hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        outlineRed:
          'border border-input hover:bg-accent hover:text-ink-brand-7 hover:border-line-brand-9 border-line-info-5 text-ink-info-1',
        link: 'underline-offset-4 hover:underline text-primary',
        redHover:
          'text-base disabled:bg-surface-34 hover:bg-surface-brand-11 bg-surface-39 rounded-none text-ink-27 shadow-[3px_3px_0px_var(--tw-shadow-color)] shadow-line-brand-9 hover:shadow-line-26  disabled:shadow-none',
        basic: 'h-2 border-input text-ink-1 hover:text-ink-brand-7'
      },
      size: {
        default: 'h-10 py-2 px-4',
        xs: 'h6 px-1 rounded0md',
        sm: 'h-9 px-3 rounded-md',
        lg: 'h-11 px-8 rounded-md'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, type = 'button', size, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} type={type} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
