-- ============================================================================
-- 0027_megolm_sessions.sql — Megolm-style per-sender ratchet sessions
--
-- Each sender maintains one outbound session per room per generation. The
-- session has a chain key that ratchets forward on every message, providing
-- forward secrecy within a generation. Recipients receive sealed snapshots
-- that allow decrypting from a given index forward.
-- ============================================================================

-- Server-side session metadata (message_count for auto-rotation enforcement).
CREATE TABLE megolm_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_user_id   uuid NOT NULL REFERENCES auth.users(id),
  sender_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id       text NOT NULL,
  generation       integer NOT NULL,
  message_count    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, sender_device_id, generation)
);

CREATE INDEX megolm_sessions_room_gen ON megolm_sessions (room_id, generation);

ALTER TABLE megolm_sessions ENABLE ROW LEVEL SECURITY;

-- Room members can read sessions (need session_id to look up inbound snapshots).
CREATE POLICY megolm_sessions_read ON megolm_sessions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM room_members
      WHERE room_members.room_id = megolm_sessions.room_id
        AND room_members.user_id = auth.uid()
    )
  );

-- Only the sender can insert their own sessions.
CREATE POLICY megolm_sessions_insert ON megolm_sessions
  FOR INSERT TO authenticated WITH CHECK (
    sender_user_id = auth.uid()
  );

-- Only the sender can update (message_count bump via trigger).
CREATE POLICY megolm_sessions_update ON megolm_sessions
  FOR UPDATE TO authenticated USING (
    sender_user_id = auth.uid()
  );

-- Sealed session snapshots shared with recipient devices.
CREATE TABLE megolm_session_shares (
  session_id          text NOT NULL,
  recipient_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sealed_snapshot     text NOT NULL,
  start_index         integer NOT NULL,
  signer_device_id    uuid NOT NULL REFERENCES devices(id),
  share_signature     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, recipient_device_id)
);

ALTER TABLE megolm_session_shares ENABLE ROW LEVEL SECURITY;

-- Recipients can read shares addressed to their devices.
CREATE POLICY megolm_shares_read ON megolm_session_shares
  FOR SELECT TO authenticated USING (
    recipient_device_id IN (
      SELECT id FROM devices WHERE user_id = auth.uid()
    )
  );

-- Any authed user can insert (senders share to recipients).
CREATE POLICY megolm_shares_insert ON megolm_session_shares
  FOR INSERT TO authenticated WITH CHECK (true);

-- Add session tracking columns to blobs for v4 (Megolm) messages.
ALTER TABLE blobs
  ADD COLUMN session_id     text,
  ADD COLUMN message_index  integer;

COMMENT ON COLUMN blobs.session_id IS
  'base64 Megolm session_id for v4 blobs. NULL for v3/v2/v1 flat-key blobs.';
COMMENT ON COLUMN blobs.message_index IS
  'Megolm message index within the session for v4 blobs. NULL for v3/v2/v1.';
