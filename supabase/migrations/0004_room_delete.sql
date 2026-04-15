-- 0004_room_delete.sql
--
-- Only the user who created the room may delete it. All child data
-- (room_members, room_invites, blobs) cascades via the existing
-- `on delete cascade` foreign keys defined in 0001_init.sql.

create policy rooms_creator_delete on rooms
  for delete to authenticated
  using (created_by = auth.uid());
