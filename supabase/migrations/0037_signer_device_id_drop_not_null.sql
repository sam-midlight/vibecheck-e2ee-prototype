-- ============================================================================
-- 0037_signer_device_id_drop_not_null.sql
--
-- Fix: 0036 changed signer_device_id FK to ON DELETE SET NULL but the column
-- still had NOT NULL, so the SET NULL trigger raised 23502 on nuke_identity.
-- Drop the NOT NULL constraint so the FK can do its job.
-- ============================================================================

ALTER TABLE room_members ALTER COLUMN signer_device_id DROP NOT NULL;
