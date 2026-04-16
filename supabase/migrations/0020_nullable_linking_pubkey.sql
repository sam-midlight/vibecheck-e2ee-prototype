-- ============================================================================
-- 0020_nullable_linking_pubkey.sql
--
-- The v3 device-approval flow (per-device identities, migration 0015) no
-- longer populates `linking_pubkey` — each device generates its own bundle
-- locally and posts its pubkeys directly in the approval-request row. The
-- old sealed-identity handoff that needed `linking_pubkey` is gone.
--
-- But the column was still NOT NULL from the original 0002 schema, so v3
-- inserts were failing with:
--   "null value in column linking_pubkey violates not-null constraint"
-- ============================================================================

alter table device_approval_requests
  alter column linking_pubkey drop not null;
