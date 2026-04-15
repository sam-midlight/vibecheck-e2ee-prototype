-- ============================================================================
-- 0011_signed_membership.sql
--
-- Closes the "ghost user" attack surface: a Supabase operator (or anyone with
-- service_role / SQL-injection) could previously insert a rogue row into
-- `room_members` or `room_invites` and, on the next key rotation or invite
-- acceptance, receive a freshly wrapped room key. Nothing cryptographic
-- prevented it; RLS gated normal clients but service_role bypasses RLS.
--
-- New defense: every membership-state-change row carries an Ed25519
-- signature over a canonical, domain-tagged tuple. The client refuses to
-- act on rows whose signature doesn't verify against the signer's published
-- identity. Forging a row now requires a private-key compromise.
--
-- Signed fields (see e2ee-core/membership.ts for exact canonicalization):
--   room_invites : (domain, room_id, generation, invitee_uid, invitee_ed,
--                   invitee_x, sha256(wrapped), inviter_uid, expires_at_ms)
--   room_members : (domain, room_id, generation, member_uid,
--                   sha256(wrapped), signer_uid)
--
-- Columns added nullable to preserve prototype test rows (small dataset). The
-- application layer is strict: unsigned rows are rejected at trust
-- boundaries. The V2 port should set these NOT NULL and drop any legacy
-- unsigned rows. See docs/port-to-v2.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- room_invites: invite envelope signed by the inviter.
--
-- We also snapshot the invitee's Ed25519 pubkey at invite time so the
-- invitee can verify that the envelope was addressed to their CURRENT
-- identity (not to some replayed historical pubkey). `invited_x25519_pub`
-- was already captured; adding `invited_ed25519_pub` for completeness.
-- ---------------------------------------------------------------------------
alter table room_invites
  add column if not exists invited_ed25519_pub text,
  add column if not exists inviter_signature text,
  add column if not exists expires_at_ms bigint;

comment on column room_invites.inviter_signature is
  'Ed25519 signature over canonical invite envelope (see e2ee-core/membership.ts).';

-- ---------------------------------------------------------------------------
-- room_members: wrap row signed by the inserter (self on accept, room
-- creator on admin rotation).
-- ---------------------------------------------------------------------------
alter table room_members
  add column if not exists signer_user_id uuid references auth.users(id),
  add column if not exists wrap_signature text;

comment on column room_members.wrap_signature is
  'Ed25519 signature by signer_user_id over canonical membership tuple.';

-- ---------------------------------------------------------------------------
-- Extend kick_and_rotate to accept per-wrap signatures. The wrap jsonb entries
-- now carry three fields: user_id, wrapped_room_key, wrap_signature. The
-- signer is always the caller (since only room creator or self-leave invoke
-- this, and both cases the caller is the one wrapping).
-- ---------------------------------------------------------------------------
drop function if exists kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text);

create or replace function kick_and_rotate(
  p_room_id uuid,
  p_evictees uuid[],
  p_old_gen int,
  p_new_gen int,
  p_wraps jsonb,             -- [{user_id, wrapped_room_key, wrap_signature}]
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

  v_is_self_leave := (p_evictees is not null)
                  and (cardinality(p_evictees) = 1)
                  and (p_evictees[1] = v_caller);

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

  if p_evictees is not null then
    delete from room_members
    where room_id = p_room_id
      and user_id = any(p_evictees)
      and user_id <> v_caller;
  end if;

  for v_wrap in select * from jsonb_array_elements(coalesce(p_wraps, '[]'::jsonb))
  loop
    v_wrap_user := (v_wrap->>'user_id')::uuid;
    v_wrap_key  := v_wrap->>'wrapped_room_key';
    v_wrap_sig  := v_wrap->>'wrap_signature';
    if v_wrap_user is null or v_wrap_key is null then
      raise exception 'malformed wrap entry' using errcode = 'check_violation';
    end if;
    insert into room_members (room_id, user_id, generation, wrapped_room_key,
                              signer_user_id, wrap_signature)
    values (p_room_id, v_wrap_user, p_new_gen, v_wrap_key,
            v_caller, v_wrap_sig);
  end loop;

  update rooms
     set current_generation = p_new_gen,
         name_ciphertext    = p_name_ciphertext,
         name_nonce         = p_name_nonce
   where id = p_room_id and current_generation = p_old_gen;

  if not found then
    raise exception 'concurrent generation update'
      using errcode = 'serialization_failure';
  end if;

  if v_is_self_leave then
    delete from room_members
    where room_id = p_room_id and user_id = v_caller;
  end if;
end;
$$;

revoke all on function kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text) from public;
grant execute on function kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text) to authenticated;
