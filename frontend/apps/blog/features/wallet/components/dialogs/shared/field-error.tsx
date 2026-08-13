/** Shared destructive-text error line under a form field. */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-[13px] leading-[20px] text-destructive">{message}</p>;
}
