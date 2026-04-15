-- ============================================================================
-- vibecheck-e2ee-prototype — initial schema
--
-- Note on column types:
--   Every key/signature/ciphertext column is `text` holding URL-safe base64
--   without padding (matches libsodium's `base64_variants.URLSAFE_NO_PADDING`).
--   We picked text over bytea because PostgREST's bytea encoding is quirky
--   and version-dependent; since the payloads are opaque ciphertext anyway,
--   text is simpler and trivially correct on the wire.
--
-- Tables:
--   identities            One row per user; published public keys ("Front Desk").
--   devices               One row per logged-in browser/device.
--   device_link_handoffs  Short-lived rows carrying sealed identity keys
--                         from an existing device to a newly linking one.
--   rooms                 A shared encrypted space (pair or group).
--   room_members          Many-to-many: which users hold which generation of
--                         which room's vault key, each copy wrapped for them.
--   room_invites          Pending invites holding a wrapped room key for the
--                         invitee to claim and move into room_members.
--   blobs                 All encrypted events (messages, slider moves, etc.)
--                         — server only sees ciphertext + routing metadata.
--
-- Every table uses RLS. The pattern: users can only touch rows they own
-- (same user_id) or rooms they are a current member of.
-- ============================================================================

-- Supabase provides `auth.users` and `auth.uid()` out of the box.

-- ---------------------------------------------------------------------------
-- identities: public keys per user
-- ---------------------------------------------------------------------------
create table identities (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  ed25519_pub    text not null,              -- long-term signing pubkey
  x25519_pub     text not null,              -- DH pubkey for receiving wrapped keys
  self_signature text not null,              -- sign(ed25519_pub||x25519_pub) with ed25519 priv
  created_at     timestamptz not null default now()
);

alter table identities enable row level security;

-- Anyone authenticated can read any identity (needed to invite someone you
-- haven't met yet). The data here is public keys only.
create policy identities_read_all on identities
  for select to authenticated using (true);

create policy identities_insert_self on identities
  for insert to authenticated with check (user_id = auth.uid());

create policy identities_update_self on identities
  for update to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- devices: each browser/device registered for a user
-- ---------------------------------------------------------------------------
create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_pub    text not null,
  display_name  text not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index on devices (user_id);

alter table devices enable row level security;

create policy devices_self_all on devices
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- device_link_handoffs: short-lived sealed-payload rows for QR device linking
--
-- Flow: new device generates ephemeral X25519 keypair, puts pubkey + link_nonce
-- into a QR. Existing device scans, seals identity priv keys for that pubkey,
-- inserts one row here. New device polls by link_nonce, decrypts, deletes.
-- ---------------------------------------------------------------------------
create table device_link_handoffs (
  link_nonce        text primary key,        -- random 32 bytes from QR
  inviting_user_id  uuid not null references auth.users(id) on delete cascade,
  sealed_payload    text not null,           -- crypto_box_seal of identity privkeys
  expires_at        timestamptz not null
);

create index on device_link_handoffs (expires_at);

alter table device_link_handoffs enable row level security;

-- Reads/deletes: any authenticated user. The link_nonce is a 256-bit secret
-- that only the holder of the QR knows; unguessable. We rely on that, not on
-- auth.uid() (the new device may still be logging in as the same user).
create policy handoffs_any_authed on device_link_handoffs
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- rooms: an encrypted shared space
-- ---------------------------------------------------------------------------
create table rooms (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('pair','group')),
  parent_room_id     uuid references rooms(id) on delete set null,
  current_generation integer not null default 1,
  created_by         uuid not null references auth.users(id),
  created_at         timestamptz not null default now()
);

alter table rooms enable row level security;

-- Read: any member (at any generation). Create: anyone. Update generation:
-- creator OR any current member.
create policy rooms_member_read on rooms
  for select to authenticated using (
    id in (select room_id from room_members where user_id = auth.uid())
  );

create policy rooms_insert_any on rooms
  for insert to authenticated with check (created_by = auth.uid());

create policy rooms_member_update on rooms
  for update to authenticated using (
    id in (
      select room_id from room_members
      where user_id = auth.uid() and generation = rooms.current_generation
    )
  );

-- ---------------------------------------------------------------------------
-- room_members: who holds which generation of which room's key
-- ---------------------------------------------------------------------------
create table room_members (
  room_id          uuid not null references rooms(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  generation       integer not null,
  wrapped_room_key text not null,           -- seal(roomKey, user's x25519_pub)
  joined_at        timestamptz not null default now(),
  primary key (room_id, user_id, generation)
);

create index on room_members (user_id);
create index on room_members (room_id, generation);

alter table room_members enable row level security;

-- You can read all rows for any room you're in (so you can enumerate co-members).
create policy room_members_read on room_members
  for select to authenticated using (
    room_id in (select room_id from room_members m2 where m2.user_id = auth.uid())
  );

-- Inserts: either you're adding yourself (accepting an invite) OR you're already
-- a member of that room at the current generation and you're re-wrapping during
-- a key rotation. We allow both.
create policy room_members_insert on room_members
  for insert to authenticated with check (
    user_id = auth.uid()
    or room_id in (
      select room_id from room_members m2
      where m2.user_id = auth.uid() and m2.generation = (
        select current_generation from rooms where id = room_members.room_id
      )
    )
  );

-- Deletes: member removes themselves, OR current-generation member removes others
-- during a rotation.
create policy room_members_delete on room_members
  for delete to authenticated using (
    user_id = auth.uid()
    or room_id in (
      select room_id from room_members m2
      where m2.user_id = auth.uid() and m2.generation = (
        select current_generation from rooms where id = room_members.room_id
      )
    )
  );

-- ---------------------------------------------------------------------------
-- room_invites: pending wrapped keys for a user who hasn't accepted yet
-- ---------------------------------------------------------------------------
create table room_invites (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references rooms(id) on delete cascade,
  invited_user_id    uuid not null references auth.users(id) on delete cascade,
  invited_x25519_pub text not null,         -- snapshot at invite time (TOFU anchor)
  generation         integer not null,
  wrapped_room_key   text not null,
  created_by         uuid not null references auth.users(id),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz
);

create index on room_invites (invited_user_id);
create index on room_invites (room_id);

alter table room_invites enable row level security;

-- Invitee reads their own invites. Current-generation member of the room reads invites
-- sent for the room (so UI can show pending). Insert: must be current-gen member.
-- Delete: invitee or inviter.
create policy room_invites_read on room_invites
  for select to authenticated using (
    invited_user_id = auth.uid()
    or created_by = auth.uid()
    or room_id in (
      select room_id from room_members
      where user_id = auth.uid() and generation = room_invites.generation
    )
  );

create policy room_invites_insert on room_invites
  for insert to authenticated with check (
    created_by = auth.uid()
    and room_id in (
      select room_id from room_members
      where user_id = auth.uid() and generation = room_invites.generation
    )
  );

create policy room_invites_delete on room_invites
  for delete to authenticated using (
    invited_user_id = auth.uid() or created_by = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- blobs: every encrypted event in every room
-- ---------------------------------------------------------------------------
create table blobs (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  sender_id  uuid not null references auth.users(id),
  generation integer not null,
  nonce      text not null,                 -- 24 bytes for XChaCha20-Poly1305
  ciphertext text not null,                 -- AEAD output, includes auth tag
  signature  text not null,                 -- Ed25519(sender) over nonce||ciphertext
  created_at timestamptz not null default now()
);

create index on blobs (room_id, created_at desc);
create index on blobs (room_id, generation);

alter table blobs enable row level security;

create policy blobs_member_read on blobs
  for select to authenticated using (
    room_id in (select room_id from room_members where user_id = auth.uid())
  );

create policy blobs_member_insert on blobs
  for insert to authenticated with check (
    sender_id = auth.uid()
    and room_id in (
      select room_id from room_members
      where user_id = auth.uid() and generation = blobs.generation
    )
  );

-- Blobs are append-only: no update, no delete by default. (Add a delete policy
-- if you want self-delete-message UX later.)

-- ---------------------------------------------------------------------------
-- Realtime publication
--
-- Supabase creates the `supabase_realtime` publication automatically. Add the
-- tables that clients subscribe to. If the publication doesn't exist in your
-- project, this block is safe to skip — enable Realtime from the dashboard.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table blobs';
    execute 'alter publication supabase_realtime add table room_invites';
    execute 'alter publication supabase_realtime add table device_link_handoffs';
    execute 'alter publication supabase_realtime add table room_members';
  end if;
exception
  when duplicate_object then null;   -- already added, no-op
end $$;
