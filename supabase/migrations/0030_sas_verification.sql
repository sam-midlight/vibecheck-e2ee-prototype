-- ============================================================================
-- 0030_sas_verification.sql — SAS emoji verification + cross-user signatures
--
-- Adds two tables:
--   cross_user_signatures: USK-signed MSK pubs (persistent verification state)
--   sas_verification_sessions: ephemeral protocol state (short-lived rows)
-- ============================================================================

-- Persistent: USK signature attesting "I verified this user's MSK is authentic."
CREATE TABLE cross_user_signatures (
  signer_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signed_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signature       text NOT NULL,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signer_user_id, signed_user_id)
);

ALTER TABLE cross_user_signatures ENABLE ROW LEVEL SECURITY;

-- Anyone can read cross-user sigs (public trust attestations).
CREATE POLICY cross_sigs_read ON cross_user_signatures
  FOR SELECT TO authenticated USING (true);

-- Only the signer can write their own attestations.
CREATE POLICY cross_sigs_insert ON cross_user_signatures
  FOR INSERT TO authenticated WITH CHECK (signer_user_id = auth.uid());

-- Only the signer can revoke their own attestations.
CREATE POLICY cross_sigs_delete ON cross_user_signatures
  FOR DELETE TO authenticated USING (signer_user_id = auth.uid());

-- Ephemeral: SAS verification session state (10-minute TTL).
CREATE TABLE sas_verification_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_user_id       uuid NOT NULL REFERENCES auth.users(id),
  responder_user_id       uuid NOT NULL REFERENCES auth.users(id),
  initiator_device_id     uuid NOT NULL REFERENCES devices(id),
  responder_device_id     uuid REFERENCES devices(id),
  state                   text NOT NULL DEFAULT 'initiated'
    CHECK (state IN ('initiated','key_exchanged','sas_compared','completed','cancelled')),
  initiator_commitment    text,
  initiator_ephemeral_pub text,
  responder_ephemeral_pub text,
  initiator_mac           text,
  responder_mac           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

ALTER TABLE sas_verification_sessions ENABLE ROW LEVEL SECURITY;

-- Only participants can see/modify their sessions.
CREATE POLICY sas_sessions_participants ON sas_verification_sessions
  FOR ALL TO authenticated USING (
    initiator_user_id = auth.uid() OR responder_user_id = auth.uid()
  );

-- Publish both tables on realtime so the SAS wizard can drive via subscription.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE sas_verification_sessions';
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE cross_user_signatures';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
