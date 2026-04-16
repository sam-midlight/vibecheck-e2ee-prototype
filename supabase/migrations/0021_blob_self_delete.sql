-- Allow users to delete their own blobs (messages + images).
create policy blobs_sender_delete on blobs
  for delete to authenticated using (sender_id = auth.uid());
