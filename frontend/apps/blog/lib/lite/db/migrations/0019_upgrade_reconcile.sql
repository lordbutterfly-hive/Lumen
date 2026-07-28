-- 0019_upgrade_reconcile.sql — follow-up to 0018 (client-side keys).
--
-- Split out rather than folded into 0018 because migrations are forward-only: a
-- database that already applied 0018 would never see statements added to it.

-- Any attempt already in flight when this ran predates the owner-key column, so it can
-- never be PROVEN to belong to the user it was started for. Reconciliation refuses to
-- adopt without that proof, so retire those rows explicitly rather than leaving them to
-- block their owners forever.
UPDATE upgrade_event
   SET status = 'failed', last_error = 'pre_client_side_keys', updated_at = now()
 WHERE status = 'creating' AND owner_public_key IS NULL;

-- Reconciliation looks up in-flight attempts by (user, status) on every upgrade view.
CREATE INDEX IF NOT EXISTS ix_upgrade_event_user_status ON upgrade_event (user_id, status);
