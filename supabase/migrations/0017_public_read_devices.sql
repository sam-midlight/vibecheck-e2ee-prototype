-- ============================================================================
-- 0017_public_read_devices.sql
--
-- Fix: invite flow was failing with "invitee has no active signed devices"
-- because `devices_self_all` restricted SELECT to the owner. Under v3
-- per-device identities, peer clients MUST be able to read each other's
-- device rows to fetch the per-device x25519 pub (for wrapping room keys)
-- and verify the UMK-issued cert.
--
-- This is analogous to `identities_read_all` from 0001 — device rows carry
-- public key material and UMK-signed certs, all of which are inherently
-- public. The only per-device sensitive column is `display_name` (legacy
-- plaintext) which is nullable since 0016; `display_name_ciphertext`
-- remains readable by anyone but only decryptable by the owning device.
--
-- `last_seen_at` is the one timestamp that leaks a little activity metadata;
-- not a strong enough concern to hide the whole row.
-- ============================================================================

-- Replace the combined owner-only policy with split per-operation policies.
drop policy if exists devices_self_all on devices;

create policy devices_read_all on devices
  for select to authenticated using (true);

create policy devices_insert_self on devices
  for insert to authenticated with check (user_id = auth.uid());

create policy devices_update_self on devices
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy devices_delete_self on devices
  for delete to authenticated using (user_id = auth.uid());
