-- key_forward_requests: a device that can't decrypt a Megolm session posts here;
-- sibling devices (same user, different device) see the request via realtime,
-- check their IDB, and respond by inserting megolm_session_shares rows.

CREATE TABLE key_forward_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requester_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id          text NOT NULL,
  room_id             uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (requester_device_id, session_id)
);

CREATE INDEX key_forward_requests_user_idx ON key_forward_requests (user_id, created_at);

ALTER TABLE key_forward_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all" ON key_forward_requests
  FOR ALL USING (user_id = auth.uid());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE key_forward_requests';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'megolm_session_shares'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE megolm_session_shares';
    END IF;
  END IF;
END $$;
