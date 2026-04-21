-- ============================================================================
-- 0048_megolm_shares_signer_check.sql — Lock down megolm_session_shares INSERT
--
-- Background: 0027:115 created the policy
--   CREATE POLICY megolm_shares_insert ON megolm_session_shares
--     FOR INSERT TO authenticated WITH CHECK (true);
-- which lets ANY authenticated user insert ANY (session_id, recipient_device_id)
-- pair with arbitrary sealed_snapshot + signer_device_id + share_signature.
--
-- Two impact paths:
--   1. DoS / cache poisoning: insert garbage ciphertext under a real session_id
--      keyed at recipient_device_id == victim. The victim's responder fallback
--      at bootstrap.ts:1416 (key-forward IDB-miss path) and resolveMegolm at
--      CallChatPanel.tsx:125 unseal directly with no signature check, then
--      cache the result in IDB. Subsequent decode attempts fail; the victim
--      cannot re-fetch a valid share until cache is wiped.
--   2. Forwarding-claim spoofing: a non-member inserts a share that LOOKS like
--      it came from a co-device or session sender. Catch is mitigated by the
--      sealed-box AEAD on the snapshot itself (recipient still needs the
--      X25519 priv to unseal), so this can't be used to OBTAIN a session — but
--      the receiver code does not verify share_signature today, so a malicious
--      inserter could substitute a known-bogus snapshot and trick a legit
--      recipient into caching it instead of the real one.
--
-- The matching client-side fix (in this commit) wires verifySessionShare into
-- the three receive sites (bootstrap.ts responder fallback, CallChatPanel
-- resolveMegolm, CallChatPanel initial hydration) and cross-checks the
-- snapshot's claimed sender_device_id against the authoritative
-- megolm_sessions.sender_device_id.
--
-- The RLS policy enforces two valid branches:
--   (A) DIRECT SHARE — signer is the session's own sender device.
--       The session sender publishing their own outbound session.
--   (B) CO-DEVICE FORWARD — signer is a different device of the SAME user
--       as the recipient. Covers key-forward responses where one of my
--       devices forwards an inbound session to my new co-device.
--
-- A naive "signer = sender" check (Branch A only) would break legitimate
-- co-device forwarding. A naive "signer is current user's device" check would
-- still let any current-gen room member insert garbage shares for cross-user
-- recipients (since the session sender could be a different user).
--
-- The Branch A check joins on megolm_sessions.session_id which requires that
-- column to be UNIQUE — added below. Live data has zero duplicates (verified
-- before applying), so adding the constraint is safe. Without the unique
-- constraint, a malicious user could pre-insert a parallel megolm_sessions
-- row with their own device as sender_device_id and then satisfy Branch A
-- for any session_id of their choosing.
--
-- Pre-0027 orphan sessions: 18 distinct session_ids exist in `blobs` without
-- corresponding megolm_sessions rows (checked at apply time). Branch A fails
-- for these by definition — but Branch B (co-device forward) still works,
-- which is the only legitimate need for forwarding historical sessions
-- (cross-user shares for orphan sessions never happen; cross-user recipients
-- only need shares for sessions they are ACTUALLY a current-generation
-- member of, and those are post-0027).
-- ============================================================================

-- Step 1: Add UNIQUE constraint on session_id. The existing unique constraint
-- is on (room_id, sender_device_id, generation), which does not prevent two
-- different sessions having the same session_id (a 32-byte random value, so
-- collision is cryptographically negligible — but a MALICIOUS insert IS the
-- threat we're defending). UNIQUE(session_id) makes the Branch A join
-- single-valued and thus safe to authorize on.
alter table megolm_sessions
  add constraint megolm_sessions_session_id_key unique (session_id);

-- Step 2: Replace the permissive WITH CHECK (true) with the two-branch policy.
drop policy if exists megolm_shares_insert on megolm_session_shares;

create policy megolm_shares_insert on megolm_session_shares
  for insert to authenticated
  with check (
    -- Identity: signer must be a non-revoked device owned by caller.
    exists (
      select 1
      from devices d
      where d.id = signer_device_id
        and d.user_id = auth.uid()
        and d.revoked_at_ms is null
    )
    and (
      -- Branch A: direct share — signer IS the session's sender device.
      -- Relies on UNIQUE(session_id) added above to prevent parallel-row
      -- spoofing (otherwise an attacker could pre-insert a megolm_sessions
      -- row with their own device as sender for any session_id).
      exists (
        select 1
        from megolm_sessions s
        where s.session_id = megolm_session_shares.session_id
          and s.sender_device_id = megolm_session_shares.signer_device_id
      )
      or
      -- Branch B: co-device forward — signer and recipient are devices of
      -- the SAME user. Covers key-forward responses to my own new devices.
      -- Note: recipient_device_id must belong to caller because key-forward
      -- requests are scoped to caller's own devices via key_forward_requests
      -- RLS (0035: USING user_id = auth.uid()), so this is structurally
      -- equivalent to "the responder forwards to one of my own devices".
      exists (
        select 1
        from devices d
        where d.id = recipient_device_id
          and d.user_id = auth.uid()
      )
    )
  );

comment on policy megolm_shares_insert on megolm_session_shares is
  'Two valid branches: (A) direct share where signer is the session sender, '
  'or (B) co-device forward where signer and recipient share a user_id. Both '
  'require signer to be a non-revoked device of the caller. UNIQUE(session_id) '
  'on megolm_sessions is required for Branch A to be safe (prevents parallel-'
  'row spoofing). Client-side verifySessionShare + snapshot sender cross-check '
  'are layered defences in bootstrap.ts and CallChatPanel.tsx.';
