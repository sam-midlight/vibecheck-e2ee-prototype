-- ============================================================================
-- 0028_key_backup_megolm.sql — Extend key_backup for Megolm session snapshots
--
-- Pre-Megolm: key_backup stores flat room keys encrypted under the backup key.
-- With Megolm: additionally stores session snapshots so a recovering device
-- can decrypt historical messages. session_id and start_index are nullable
-- to preserve backward compat with existing flat-key backup rows.
-- ============================================================================

ALTER TABLE key_backup
  ADD COLUMN session_id   text,
  ADD COLUMN start_index  integer;

COMMENT ON COLUMN key_backup.session_id IS
  'base64 Megolm session_id. NULL for flat-key backup rows.';
COMMENT ON COLUMN key_backup.start_index IS
  'Message index the backed-up session snapshot starts at. NULL for flat-key rows.';
