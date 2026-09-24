-- Quote reblogs (spec v2 7.6): a moderator can hide a Hive user's reblog comment on
-- Lumen (the chain keeps it; every Lumen surface drops it). The action is logged like a
-- user or post action, so the log must accept the new target type.
ALTER TABLE lumen_moderation_action DROP CONSTRAINT IF EXISTS lumen_moderation_action_target_type_check;
ALTER TABLE lumen_moderation_action
  ADD CONSTRAINT lumen_moderation_action_target_type_check CHECK (target_type IN ('user', 'post', 'quote'));
