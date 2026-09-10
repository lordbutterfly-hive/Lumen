import { squatterRecord } from '@/blog/lib/lite/moderation/squatter-list';

/**
 * ★★★ THE ONE PLACE THE FLAGGED ACCOUNT ACTUALLY SEES IT (2026-09-10, owner: "flags
 * a warning, something like, this account has been flagged for griefing...").
 *
 * A squatting Hive account is hidden from every surface Lumen renders, and its name
 * on Lumen belongs to the lite account that had it first -- so `/@name` is the
 * VICTIM's profile and a warning banner there would smear the wrong person. The only
 * reader who needs this notice is the flagged account itself, and the only place it
 * is reliably in front of them is their own signed-in session. So it renders in the
 * app shell, for that account, on every page.
 *
 * Everyone else sees nothing: a reader who is not signed in as a flagged account gets
 * `null`, and the flagged account is simply absent from their feeds and threads.
 */
export function FlaggedAccountNotice({ username }: { username: string | null | undefined }) {
  const record = squatterRecord(username);
  if (!record) return null;
  const registered = record.hiveCreated.toISOString().slice(0, 10);
  const claimed = record.liteCreated.toISOString().slice(0, 10);
  return (
    <div
      role="status"
      data-testid="flagged-account-notice"
      className="border-b border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-ink-2"
    >
      <p className="mx-auto max-w-3xl">
        <strong className="font-semibold text-destructive">
          This account has been flagged for griefing.
        </strong>{' '}
        The Hive account <strong>@{record.name}</strong> was registered on {registered}, after a
        Lumen account had already claimed that name on {claimed}. Registering a name someone is
        already using here is impersonation, so this account is hidden across Lumen. To appeal or
        to be removed from the blacklist, come to the Magi Discord:{' '}
        <a
          className="font-medium underline underline-offset-2 hover:text-destructive"
          href="https://discord.gg/NAdHac8m77"
          target="_blank"
          rel="noreferrer noopener"
        >
          discord.gg/NAdHac8m77
        </a>
        .
      </p>
    </div>
  );
}

export default FlaggedAccountNotice;
