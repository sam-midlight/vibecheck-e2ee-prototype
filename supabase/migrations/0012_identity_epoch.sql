-- ============================================================================
-- 0012_identity_epoch.sql
--
-- Detect master-key rotations (e.g. "nuclear reset" after a suspected breach)
-- so stale orphan devices cannot silently re-register with their old keys,
-- and so in-flight approval requests cannot straddle an epoch transition.
--
-- Mechanism: an `identity_epoch` counter on `identities` that auto-bumps via
-- trigger whenever the published ed25519/x25519 pubkeys change. Other tables
-- whose rows are meaningful only inside a single epoch (approval requests,
-- handoffs) can snapshot the epoch at creation and be invalidated on mismatch.
-- ============================================================================

alter table identities
  add column if not exists identity_epoch int not null default 1;

create or replace function bump_identity_epoch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.ed25519_pub is distinct from OLD.ed25519_pub
     or NEW.x25519_pub is distinct from OLD.x25519_pub then
    NEW.identity_epoch := coalesce(OLD.identity_epoch, 0) + 1;
  end if;
  return NEW;
end;
$$;

drop trigger if exists identities_epoch_bump on identities;
create trigger identities_epoch_bump
  before update on identities
  for each row execute function bump_identity_epoch();

-- ---------------------------------------------------------------------------
-- Bind device_approval_requests to the epoch at creation time. Rows whose
-- epoch doesn't match the current `identities.identity_epoch` are stale and
-- must be rejected by the verifier — prevents an attacker from re-using a
-- captured approval row across a master-key rotation.
-- ---------------------------------------------------------------------------
alter table device_approval_requests
  add column if not exists identity_epoch int;

-- Extend verify_approval_code to additionally reject rows whose epoch no
-- longer matches the identity's current epoch. (Legacy rows with NULL epoch
-- are treated as stale — callers on pre-0012 clients should retry.)
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
  v_current_epoch int;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
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

  select identity_epoch into v_current_epoch from identities where user_id = v_caller;
  if v_row.identity_epoch is null or v_row.identity_epoch <> v_current_epoch then
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
