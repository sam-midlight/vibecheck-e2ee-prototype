-- ============================================================================
-- 0029_auto_rotation_enforcement.sql — server-side Megolm session rotation
--
-- The client is authoritative for rotation (100 messages or 7 days), but the
-- server enforces a hard cap at 200 messages as defense-in-depth against a
-- misbehaving client running a session forever.
-- ============================================================================

-- Increment megolm_sessions.message_count on each blob INSERT that carries
-- a session_id. Runs as SECURITY DEFINER to bypass RLS on megolm_sessions.
CREATE OR REPLACE FUNCTION increment_session_message_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.session_id IS NOT NULL THEN
    UPDATE megolm_sessions
    SET message_count = message_count + 1
    WHERE session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER blobs_session_counter
  AFTER INSERT ON blobs
  FOR EACH ROW EXECUTE FUNCTION increment_session_message_count();

-- Hard cap: reject blob inserts for sessions exceeding 200 messages.
-- This is a safety net, not the primary enforcement mechanism — the client
-- rotates at 100. The gap accommodates race conditions during rotation.
CREATE OR REPLACE FUNCTION check_session_message_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NEW.session_id IS NOT NULL THEN
    SELECT message_count INTO v_count
    FROM megolm_sessions WHERE session_id = NEW.session_id;
    IF v_count IS NOT NULL AND v_count >= 200 THEN
      RAISE EXCEPTION 'Megolm session has exceeded maximum message count (200)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER blobs_session_cap
  BEFORE INSERT ON blobs
  FOR EACH ROW EXECUTE FUNCTION check_session_message_cap();
