-- ============================================================================
-- 0006_attachments_bucket.sql — encrypted image attachments in Supabase Storage
--
-- Design:
--   - Private bucket `room-attachments`. Never world-readable.
--   - Object path convention: `{room_id}/{blob_id}.bin` — the first path
--     segment is the UUID of the room the attachment belongs to.
--   - Clients upload *already-encrypted* ciphertext. The bucket holds raw
--     bytes, not an `image/*` content type. The server cannot decrypt or
--     even identify what's inside.
--   - RLS policies gate access by deriving the room_id from the path prefix
--     and checking room_members (same pattern as the `blobs` table).
--
-- The `blobs` row for an image attachment carries its encrypted JSON header
-- (type/mime/dimensions/placeholder/storageKey) — no schema change needed
-- on `blobs` itself. The only server-visible linkage is the path convention,
-- which is enough for RLS but leaks nothing about content.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('room-attachments', 'room-attachments', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- SELECT: any-generation member of the room can download.
--
-- Old members (rotated out) retain the ability to read attachments they
-- already had a key for — consistent with the `blobs` read policy. They
-- can't decrypt anything posted after their rotation anyway.
-- ---------------------------------------------------------------------------
drop policy if exists attachments_read on storage.objects;
create policy attachments_read on storage.objects
  for select to authenticated using (
    bucket_id = 'room-attachments'
    and (
      case
        when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        then (split_part(name, '/', 1))::uuid in (
          select room_id from room_members where user_id = auth.uid()
        )
        else false
      end
    )
  );

-- ---------------------------------------------------------------------------
-- INSERT: only current-generation members can upload new attachments.
-- Mirrors the blobs_member_insert policy.
-- ---------------------------------------------------------------------------
drop policy if exists attachments_insert on storage.objects;
create policy attachments_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'room-attachments'
    and (
      case
        when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        then (split_part(name, '/', 1))::uuid in (
          select rm.room_id
          from room_members rm
          join rooms r on r.id = rm.room_id
          where rm.user_id = auth.uid()
            and rm.generation = r.current_generation
        )
        else false
      end
    )
  );

-- ---------------------------------------------------------------------------
-- DELETE: room creator (for `deleteRoom` cleanup) OR any current-generation
-- member (so a member can tidy up their own upload failures).
--
-- We don't enforce "sender only" because the blob_id in the second path
-- segment isn't cryptographically bound to an auth identity at the storage
-- layer. The app-level UX only deletes on room delete or upload rollback.
-- ---------------------------------------------------------------------------
drop policy if exists attachments_delete on storage.objects;
create policy attachments_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'room-attachments'
    and (
      case
        when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        then (split_part(name, '/', 1))::uuid in (
          select id from rooms where created_by = auth.uid()
        ) or (split_part(name, '/', 1))::uuid in (
          select rm.room_id
          from room_members rm
          join rooms r on r.id = rm.room_id
          where rm.user_id = auth.uid()
            and rm.generation = r.current_generation
        )
        else false
      end
    )
  );
