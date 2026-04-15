-- ============================================================================
-- 0015_per_device_identities.sql
--
-- Structural rewrite to per-device identities (Matrix/Signal/iMessage model).
--
-- BEFORE:
--   identities holds one { ed25519_pub, x25519_pub, self_signature } per user.
--   Every device that links via approval or recovery gets a COPY of those
--   privkeys. One device compromise = forever-compromised account.
--
-- AFTER:
--   identities.ed25519_pub becomes the User Master Key (UMK) pub. Its priv
--     signs nothing but device certs + revocations, and lives only where
--     explicitly placed (primary device; transient during recovery).
--   Each device generates its own Ed25519 + X25519 key bundle locally.
--   The UMK holder issues a device certificate (ed signature over canonical
--     device tuple) per device at enrollment. Devices are trusted iff their
--     issuance cert verifies against the user's UMK and no revocation cert
--     contradicts.
--   Messages and membership ops are signed by device keys; verifiers chain
--     to UMK via the device cert.
--
-- This is a breaking schema change. Existing rooms, invites, blobs,
-- memberships, device rows, approvals, handoffs, and recovery blobs are
-- wiped. Existing `identities` rows are preserved (ed25519_pub stays as the
-- UMK pub). Users re-register their current browser on next sign-in.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Wipe data that cannot survive the structural change.
--    Order matters for FK cascades.
-- ---------------------------------------------------------------------------
truncate table
  room_members,
  room_invites,
  blobs,
  device_approval_requests,
  device_link_handoffs,
  recovery_blobs
restart identity;

truncate table devices restart identity cascade;

-- rooms stays — users can keep room IDs if they want, but since no blobs
-- survive and no memberships remain, they'll effectively re-create anyway.
-- Leave the rows; no harm.

-- ---------------------------------------------------------------------------
-- 2. identities: ed25519_pub is now the UMK pub.
--
-- x25519_pub + self_signature become obsolete (no user-wide X25519 anymore;
-- the self-sig was bound to the combined pair, which no longer exists).
-- Make them nullable and clear. Drop in a follow-up migration after clients
-- have updated and no readers depend on them.
-- ---------------------------------------------------------------------------
alter table identities
  alter column x25519_pub drop not null,
  alter column self_signature drop not null;

update identities set x25519_pub = null, self_signature = null;

comment on column identities.ed25519_pub is
  'User Master Key (UMK) Ed25519 pub. Root of trust — signs device certs + revocations only.';
comment on column identities.x25519_pub is
  'LEGACY. Pre-0015 per-user DH key. Unused since 0015; drop in a later migration.';
comment on column identities.self_signature is
  'LEGACY. Pre-0015 self-sig binding ed+x. Unused since 0015.';

-- ---------------------------------------------------------------------------
-- 3. devices: add per-device key bundle columns + UMK-issued cert + revoke.
--
-- We truncated the table above, so NOT NULL on the new columns is clean.
-- ---------------------------------------------------------------------------
alter table devices
  drop column device_pub;  -- legacy, unused

alter table devices
  add column device_ed25519_pub       text   not null,
  add column device_x25519_pub        text   not null,
  add column issuance_created_at_ms   bigint not null,
  add column issuance_signature       text   not null,
  add column revoked_at_ms            bigint,
  add column revocation_signature     text;

create index if not exists devices_user_id_active_idx
  on devices (user_id) where revoked_at_ms is null;

comment on column devices.device_ed25519_pub is
  'Per-device Ed25519 pub. Signs blobs + membership ops. Never leaves the device privately.';
comment on column devices.device_x25519_pub is
  'Per-device X25519 pub. Receives sealed room-key wraps.';
comment on column devices.issuance_signature is
  'Ed25519 signature by UMK over (user_id, device_id, ed_pub, x_pub, created_at_ms).';
comment on column devices.revocation_signature is
  'Ed25519 signature by UMK over (user_id, device_id, revoked_at_ms). Null iff active.';

-- ---------------------------------------------------------------------------
-- 4. room_members: per-device keying.
--
-- PK changes from (room_id, user_id, generation) to
-- (room_id, device_id, generation). signer_user_id becomes signer_device_id.
-- Old wrap_signature tuple changes; existing sigs are invalidated by the
-- truncate above.
-- ---------------------------------------------------------------------------
alter table room_members
  drop constraint if exists room_members_pkey,
  add column device_id        uuid not null references devices(id) on delete cascade,
  drop column signer_user_id,
  add column signer_device_id uuid references devices(id);

alter table room_members
  add primary key (room_id, device_id, generation);

create index if not exists room_members_user_id_idx on room_members (user_id);
create index if not exists room_members_room_gen_idx on room_members (room_id, generation);

comment on column room_members.device_id is
  'The device this wrap is addressed to. Room key is sealed to this device.x25519_pub.';
comment on column room_members.signer_device_id is
  'The device whose ed25519 priv signed wrap_signature. Verified via its issuance cert.';

-- my_generations_for_room helper: still per-user, still fine (a user may
-- hold the same generation on multiple devices, but the policy checks
-- existence of any row with the caller's user_id at that generation).
create or replace function my_generations_for_room(_room_id uuid)
returns setof int
language sql
security definer
stable
set search_path = public
as $$
  select distinct generation from room_members
  where room_id = _room_id and user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 5. room_invites: addressed to a specific device; signed by a specific
--    inviter device.
-- ---------------------------------------------------------------------------
alter table room_invites
  add column invited_device_id uuid not null references devices(id) on delete cascade,
  add column inviter_device_id uuid not null references devices(id) on delete cascade;

comment on column room_invites.invited_device_id is
  'Device the invite is sealed for. Accepter device must match this id.';
comment on column room_invites.inviter_device_id is
  'Inviter device that signed the envelope.';

-- ---------------------------------------------------------------------------
-- 6. blobs: carry sender_device_id so verifier knows which key to check.
-- ---------------------------------------------------------------------------
alter table blobs
  add column sender_device_id uuid references devices(id) on delete set null;

comment on column blobs.sender_device_id is
  'Device that signed this blob. Null only for legacy pre-0015 rows (table was truncated so none in practice).';

-- ---------------------------------------------------------------------------
-- 7. device_approval_requests: new device transport carries its own bundle.
--
-- We no longer seal a root identity to a linking pubkey (there is no root
-- priv to transport). Instead B generates its own bundle locally, the
-- approval row carries the new device's pubkeys + device_id, and A (the
-- UMK-holder) signs an issuance cert that B can pick up.
-- ---------------------------------------------------------------------------
alter table device_approval_requests
  add column device_id              uuid,
  add column device_ed25519_pub     text,
  add column device_x25519_pub      text,
  add column created_at_ms          bigint;

-- Kept for back-compat column shape; new flow doesn't use linking_pubkey.
comment on column device_approval_requests.linking_pubkey is
  'LEGACY. Pre-0015 ephemeral X25519 pub for sealed-root-identity handoff. Ignored since 0015.';
comment on column device_approval_requests.device_id is
  'Device UUID the new device generated locally.';
comment on column device_approval_requests.device_ed25519_pub is
  'New device Ed25519 pub. Included in the issuance cert A signs.';
comment on column device_approval_requests.device_x25519_pub is
  'New device X25519 pub. Included in the issuance cert A signs.';
comment on column device_approval_requests.created_at_ms is
  'Timestamp bound into the issuance cert A produces.';

-- ---------------------------------------------------------------------------
-- 8. kick_and_rotate: wraps are per-device.
-- ---------------------------------------------------------------------------
drop function if exists kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text);

create or replace function kick_and_rotate(
  p_room_id uuid,
  p_evictee_user_ids uuid[],
  p_old_gen int,
  p_new_gen int,
  p_wraps jsonb,    -- [{user_id, device_id, wrapped_room_key, wrap_signature}]
  p_signer_device_id uuid,
  p_name_ciphertext text,
  p_name_nonce text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_creator uuid;
  v_current int;
  v_is_self_leave bool;
  v_wrap jsonb;
  v_wrap_user uuid;
  v_wrap_device uuid;
  v_wrap_key text;
  v_wrap_sig text;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select created_by, current_generation
    into v_creator, v_current
    from rooms where id = p_room_id for update;

  if v_creator is null then
    raise exception 'room not found' using errcode = 'no_data_found';
  end if;

  -- Verify the claimed signer device belongs to the caller.
  if not exists (
    select 1 from devices
    where id = p_signer_device_id
      and user_id = v_caller
      and revoked_at_ms is null
  ) then
    raise exception 'signer_device_id must be an active device owned by the caller'
      using errcode = 'insufficient_privilege';
  end if;

  v_is_self_leave := (p_evictee_user_ids is not null)
                  and (cardinality(p_evictee_user_ids) = 1)
                  and (p_evictee_user_ids[1] = v_caller);

  if v_caller <> v_creator and not v_is_self_leave then
    raise exception 'only the room creator may kick other members'
      using errcode = 'insufficient_privilege';
  end if;

  if v_current is distinct from p_old_gen then
    raise exception 'stale generation (expected %, have %)', p_old_gen, v_current
      using errcode = 'serialization_failure';
  end if;

  if p_new_gen <> p_old_gen + 1 then
    raise exception 'new generation must be old + 1'
      using errcode = 'check_violation';
  end if;

  if p_evictee_user_ids is not null then
    delete from room_members
    where room_id = p_room_id
      and user_id = any(p_evictee_user_ids)
      and user_id <> v_caller;
  end if;

  for v_wrap in select * from jsonb_array_elements(coalesce(p_wraps, '[]'::jsonb))
  loop
    v_wrap_user   := (v_wrap->>'user_id')::uuid;
    v_wrap_device := (v_wrap->>'device_id')::uuid;
    v_wrap_key    := v_wrap->>'wrapped_room_key';
    v_wrap_sig    := v_wrap->>'wrap_signature';
    if v_wrap_user is null or v_wrap_device is null
       or v_wrap_key is null or v_wrap_sig is null then
      raise exception 'malformed wrap entry' using errcode = 'check_violation';
    end if;
    insert into room_members (room_id, user_id, device_id, generation,
                              wrapped_room_key, signer_device_id, wrap_signature)
    values (p_room_id, v_wrap_user, v_wrap_device, p_new_gen,
            v_wrap_key, p_signer_device_id, v_wrap_sig);
  end loop;

  update rooms
     set current_generation = p_new_gen,
         name_ciphertext    = p_name_ciphertext,
         name_nonce         = p_name_nonce,
         last_rotated_at    = now()
   where id = p_room_id and current_generation = p_old_gen;

  if not found then
    raise exception 'concurrent generation update'
      using errcode = 'serialization_failure';
  end if;

  -- Forward-secrecy purge: drop rows older than prev_gen.
  delete from room_members
  where room_id = p_room_id
    and generation < p_new_gen - 1;

  if v_is_self_leave then
    delete from room_members
    where room_id = p_room_id and user_id = v_caller;
  end if;
end;
$$;

revoke all on function kick_and_rotate(uuid, uuid[], int, int, jsonb, uuid, text, text) from public;
grant execute on function kick_and_rotate(uuid, uuid[], int, int, jsonb, uuid, text, text) to authenticated;
