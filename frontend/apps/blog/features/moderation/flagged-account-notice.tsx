import { ensureSquatterList, squatterRecord } from '@/blog/lib/lite/moderation/squatter-list';

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
export async function FlaggedAccountNotice({
  username,
  accountTier
}: {
  username: string | null | undefined;
  accountTier: 'lite' | 'full' | null;
}) {
  /**
   * ★★★ THE TIER GATE IS THE WHOLE CORRECTNESS OF THIS COMPONENT (2026-09-10, owner,
   * within the hour of the first version shipping: "the griefing message appears on
   * the griefed account").
   *
   * It did, and it was this. The squatter list is keyed by NAME, because a name is
   * the only thing the two accounts share -- and the VICTIM's session username IS
   * that name. `chadmasters` the lite account and `chadmasters` the Hive account are
   * indistinguishable to `squatterRecord`, so the person who was impersonated was
   * shown the notice accusing them of impersonation. Exactly backwards, on the one
   * screen where being wrong is worst.
   *
   * The tier is what separates them and it was already on the session. A lite account
   * is by construction the one that had the name FIRST (signup proved it free on Hive
   * at that moment); the Hive account of the same name is the one that came after.
   * So: full accounts only, and a lite reader can never see this no matter what the
   * list says about their name.
   */
  if (accountTier !== 'full') return null;
  /**
   * ★ AWAITED, AND THAT IS THE DIFFERENCE BETWEEN THIS RENDERING AND NOT (2026-09-10,
   * owner: "I dont see the warning when i log in with keychain").
   *
   * `squatterRecord` is a synchronous read over a list loaded in the background, so on
   * a worker that has not loaded it yet it returns `null` and this component renders
   * NOTHING -- silently, with no error, which is the worst possible failure for a
   * notice whose whole job is to be seen. An async server component can simply wait,
   * and the wait is free whenever the list is already fresh.
   */
  await ensureSquatterList();
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
        already using here is impersonation, so this account is hidden across Lumen. You can
        appeal in the Magi Discord:{' '}
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
