-- ============================================================================
-- 0016_display_name_and_not_null.sql
--
-- Two hygiene items:
--
--   1. Encrypt device display_name at rest.
--      Each device now writes its human-readable name as a crypto_box_seal
--      ciphertext addressed to its own X25519 pub. Only that device can
--      decrypt; the Supabase operator no longer sees "Sam's iPhone" in the
--      devices table. Other co-devices fall back to device_id in the UI.
--
--   2. Tighten NOT NULL on the signed-membership columns added in 0011.
--      Migration 0015 truncated room_invites + room_members, so no legacy
--      null rows exist. From now on, any v3-aware insert must carry the
--      signature fields — forbidding NULL at the schema level is pure
--      defense-in-depth on top of the client checks.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. display_name becomes nullable (encrypted version is the new canonical
--    source); add the ciphertext column.
-- ---------------------------------------------------------------------------
alter table devices
  alter column display_name drop not null,
  add column if not exists display_name_ciphertext text;

comment on column devices.display_name is
  'LEGACY plaintext label. Pre-0016 rows. New inserts leave this null and populate display_name_ciphertext instead.';
comment on column devices.display_name_ciphertext is
  'crypto_box_seal of display_name to the device''s own X25519 pub. Only that device can decrypt.';

-- ---------------------------------------------------------------------------
-- 2. NOT NULL the v3 signed-membership columns.
-- ---------------------------------------------------------------------------
alter table room_invites
  alter column invited_ed25519_pub set not null,
  alter column inviter_signature  set not null,
  alter column expires_at_ms      set not null,
  alter column invited_device_id  set not null,
  alter column inviter_device_id  set not null;

alter table room_members
  alter column signer_device_id set not null,
  alter column wrap_signature   set not null;

-- device_id on room_members was already NOT NULL from 0015.
