import { cn } from '@ui/lib/utils';
import { Button } from './button';
import { ChevronDown, ClipboardCopy } from 'lucide-react';
import { useState } from 'react';

interface ErrorToastContentProps {
  errorTitle: string;
  fullError: string;
  displayControls?: boolean;
  className?: string;
}

const ICON_SIZE = 16;

const ErrorToastContent: React.FC<ErrorToastContentProps> = ({
  errorTitle,
  fullError,
  displayControls = false,
  className
}) => {
  const [showMoreOpen, setShowMoreOpen] = useState(false);

  const copyErrorToClipboard = () => {
    navigator.clipboard.writeText(fullError);
  };

  return (
    <div className={cn('text-ink-27', className)} data-testid="error-toast-content">
      <div className="flex flex-row items-center justify-between gap-x-16">
        <h1 className="mr-6 font-ui font-semibold">{errorTitle}</h1>
        {displayControls && (
          <div className="top-0 flex flex-row gap-x-2">
            <Button onClick={() => setShowMoreOpen(!showMoreOpen)} variant="link" className="p-0" data-testid="error-toast-content-trigger">
              <ChevronDown
                className={cn({
                  'rotate-180': showMoreOpen
                })}
                size={ICON_SIZE}
              />
            </Button>
            <Button onClick={copyErrorToClipboard} variant="link" className="p-0 transition active:scale-125">
              <ClipboardCopy size={ICON_SIZE} />
            </Button>
          </div>
        )}
      </div>
      {/* ★ RENDER IT OR DON'T — do not "hide" it at zero size.
          This was `h-0 w-0 overflow-hidden`, toggled to `h-full` on expand. A
          percentage height inside an auto-height toast has nothing to resolve
          against, so the box stayed measurably 0x0 even after the chevron was
          clicked: a UX tester found the text present in the accessibility tree
          at 0x0 px while the reader saw nothing at all. Mounting it only when
          it should be visible cannot fail that way. */}
      {displayControls && showMoreOpen && (
        <pre
          className="mt-2 max-h-[60vh] w-full overflow-y-auto whitespace-pre-wrap break-words px-4 font-mono text-caption md:max-h-[80vh]"
          data-testid="error-toast-content-message"
        >
          {fullError}
        </pre>
      )}
    </div>
  );
};

export default ErrorToastContent;
