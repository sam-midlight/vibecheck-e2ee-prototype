-- ============================================================================
-- 0010_approval_attempt_limiter.sql
--
-- Server-side rate-limit on the 6-digit device-approval flow. Previously the
-- verifier (device A) compared the typed hash to the row's code_hash entirely
-- client-side — meaning an attacker with A's session could burn 10^6 attempts
-- locally in under a second and guarantee a match.
--
-- Fix: add a `failed_attempts` column and a SECURITY DEFINER RPC that does the
-- comparison atomically, increments on miss, and deletes the row on the 5th
-- miss. Also drop the default TTL from 10 minutes to 2 minutes (matches
-- Signal/WhatsApp pairing windows).
-- ============================================================================

alter table device_approval_requests
  add column if not exists failed_attempts int not null default 0;

alter table device_approval_requests
  alter column expires_at set default now() + interval '2 minutes';

comment on column device_approval_requests.code_hash is
  'sha256(domain || salt || code || linking_pubkey || link_nonce), hex. '
  'Bound to the row''s linking_pubkey/link_nonce so row mutation invalidates '
  'the hash on the verifier side.';

-- ---------------------------------------------------------------------------
-- verify_approval_code(request_id, candidate_hash) -> boolean
--
-- Returns true on match. On mismatch, increments failed_attempts; on the 5th
-- mismatch deletes the row so any further probe fails at a different gate.
-- Constant-time comparison done via = on text, which is acceptable because
-- the attacker already holds (or generated) the candidate.
--
-- Only the owner (auth.uid() = user_id) may verify, matching the
-- device_approval_requests_owner_all RLS policy.
-- ---------------------------------------------------------------------------
create or replace function verify_approval_code(
  p_request_id uuid,
  p_candidate_hash text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_row device_approval_requests%rowtype;
begin
  if v_caller is null then
    raise exception 'authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row
    from device_approval_requests
   where id = p_request_id
   for update;

  if not found then
    return false;
  end if;

  if v_row.user_id <> v_caller then
    raise exception 'not authorized' using errcode = 'insufficient_privilege';
  end if;

  if v_row.expires_at < now() then
    delete from device_approval_requests where id = p_request_id;
    return false;
  end if;

  if v_row.code_hash = p_candidate_hash then
    return true;
  end if;

  if v_row.failed_attempts + 1 >= 5 then
    delete from device_approval_requests where id = p_request_id;
  else
    update device_approval_requests
       set failed_attempts = failed_attempts + 1
     where id = p_request_id;
  end if;
  return false;
end;
$$;

revoke all on function verify_approval_code(uuid, text) from public;
grant execute on function verify_approval_code(uuid, text) to authenticated;
