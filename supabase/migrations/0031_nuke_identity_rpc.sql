-- ============================================================================
-- 0031_nuke_identity_rpc.sql — SECURITY DEFINER RPC for nuclear identity reset
--
-- The client-side nuke was failing because calls/call_members/call_key_envelopes
-- have RLS with SELECT-only policies (no DELETE). Deletes silently returned 0
-- rows, leaving FK references that blocked the devices delete.
--
-- This RPC runs as SECURITY DEFINER (bypasses RLS) and handles the full
-- teardown in the correct FK order.
-- ============================================================================

CREATE OR REPLACE FUNCTION nuke_identity(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'can only nuke your own identity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Delete in FK-safe order: children before parents.
  -- call_key_envelopes references devices (no cascade)
  DELETE FROM call_key_envelopes
  WHERE target_device_id IN (SELECT id FROM devices WHERE user_id = p_user_id)
     OR sender_device_id IN (SELECT id FROM devices WHERE user_id = p_user_id);

  -- call_members references devices (no cascade)
  DELETE FROM call_members WHERE user_id = p_user_id;

  -- calls references devices (no cascade)
  DELETE FROM calls WHERE initiator_user_id = p_user_id;

  -- megolm_session_shares.signer_device_id references devices (no cascade)
  DELETE FROM megolm_session_shares
  WHERE signer_device_id IN (SELECT id FROM devices WHERE user_id = p_user_id);

  -- megolm_sessions (has ON DELETE CASCADE on sender_device_id, but clean explicitly)
  DELETE FROM megolm_sessions WHERE sender_user_id = p_user_id;

  -- sas verification sessions
  DELETE FROM sas_verification_sessions
  WHERE initiator_user_id = p_user_id OR responder_user_id = p_user_id;

  -- cross-user signatures
  DELETE FROM cross_user_signatures
  WHERE signer_user_id = p_user_id OR signed_user_id = p_user_id;

  -- room_members (has ON DELETE CASCADE on device_id, but clean explicitly)
  DELETE FROM room_members WHERE user_id = p_user_id;

  -- room_invites
  DELETE FROM room_invites WHERE invited_user_id = p_user_id;

  -- key_backup
  DELETE FROM key_backup WHERE user_id = p_user_id;

  -- device_approval_requests
  DELETE FROM device_approval_requests WHERE user_id = p_user_id;

  -- devices (now safe — all FK references are gone)
  DELETE FROM devices WHERE user_id = p_user_id;

  -- recovery_blobs
  DELETE FROM recovery_blobs WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION nuke_identity(uuid) FROM public;
GRANT EXECUTE ON FUNCTION nuke_identity(uuid) TO authenticated;
