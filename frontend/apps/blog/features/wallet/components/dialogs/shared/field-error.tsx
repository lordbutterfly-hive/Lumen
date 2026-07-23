/** Shared destructive-text error line under a form field. */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-[12.5px] text-destructive">{message}</p>;
}
