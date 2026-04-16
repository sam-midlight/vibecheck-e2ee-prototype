-- ============================================================================
-- 0022_key_backup.sql — server-side room-key backup (Matrix key-backup style)
--
-- A `backup_key` (32 random bytes) is generated at recovery-phrase-setup
-- time and escrowed inside the recovery blob alongside the UMK priv. Every
-- time a room key is obtained (create, accept, rotation), the room key is
-- encrypted under the backup key and uploaded to `key_backup`. On new
-- device enrollment (via approval or recovery phrase), all backed-up room
-- keys are downloaded and decrypted, giving the new device access to the
-- full room history without requiring per-room re-invites.
--
-- The backup key is also shared with newly-approved devices by sealing it
-- to their X25519 pub and writing the ciphertext to `devices.backup_key_wrap`.
-- ============================================================================

create table key_backup (
  user_id    uuid not null references auth.users(id) on delete cascade,
  room_id    uuid not null references rooms(id) on delete cascade,
  generation int  not null,
  ciphertext text not null,
  nonce      text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, room_id, generation)
);

alter table key_backup enable row level security;

create policy key_backup_owner on key_backup
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Column for sharing the backup key with newly-approved devices.
alter table devices
  add column if not exists backup_key_wrap text;

comment on column devices.backup_key_wrap is
  'crypto_box_seal of the user''s backup key to this device''s X25519 pub. '
  'Written by the approving device; read by this device on enrollment.';
