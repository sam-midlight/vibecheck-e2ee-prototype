-- ============================================================================
-- 0002: device approval requests + recovery-phrase escrow blobs
--
-- Two additions for the multi-device UX:
--
-- 1. `device_approval_requests`
--      When a new device (B) signs in via magic link and has no local identity,
--      it creates a row here carrying its ephemeral linking pubkey + a hash of
--      the short 6-digit code shown on B. Any already-signed-in device (A) sees
--      this row via realtime, prompts the user to enter the code, then on a
--      match seals its identity and writes a `device_link_handoffs` row keyed
--      by the same link_nonce. B picks up the handoff via realtime and opens
--      it. Short TTL (~5 minutes).
--
-- 2. `recovery_blobs`
--      Optional. When a user opts into a recovery phrase, the client derives
--      a wrapping key from the phrase (Argon2id) and stores the ciphertext
--      of their identity private keys here. Exactly one row per user.
--      The phrase never leaves the client. Server only sees opaque ciphertext.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- device_approval_requests: short-lived "new device wants in" signal
-- ---------------------------------------------------------------------------
create table device_approval_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  linking_pubkey  text not null,                       -- B's ephemeral X25519 pub (base64)
  code_hash       text not null,                       -- libsodium generichash(code||salt), hex
  code_salt       text not null,                       -- 16-byte random, hex
  link_nonce      text not null unique,                -- 32-byte random, base64; keys the eventual handoff row
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '10 minutes'
);

create index device_approval_requests_user_id_idx on device_approval_requests (user_id);

alter table device_approval_requests enable row level security;

-- Both B (creating) and A (approving) are the same auth.uid(). Only that user
-- can touch these rows. Even if B hasn't finished onboarding, its session is
-- already valid post-magic-link exchange, so auth.uid() is stable.
create policy device_approval_requests_owner_all on device_approval_requests
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Best-effort expired-row cleanup (pg_cron would be nicer but this works).
-- We also delete on claim from the client side.
create or replace function cleanup_expired_approval_requests()
returns void
language sql
security definer
set search_path = public
as $$
  delete from device_approval_requests where expires_at < now();
$$;


-- ---------------------------------------------------------------------------
-- recovery_blobs: optional phrase-wrapped identity escrow
-- ---------------------------------------------------------------------------
create table recovery_blobs (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  ciphertext     text not null,                        -- XChaCha20-Poly1305 seal of { ed_priv, x_priv }, base64
  nonce          text not null,                        -- 24-byte, base64
  kdf_salt       text not null,                        -- Argon2id salt, base64
  kdf_opslimit   int  not null,                        -- libsodium opslimit used
  kdf_memlimit   bigint not null,                      -- libsodium memlimit used (bytes)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table recovery_blobs enable row level security;

create policy recovery_blobs_owner_all on recovery_blobs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- Realtime publications
--   B side listens on device_link_handoffs (already in publication from 0001).
--   A side listens on device_approval_requests.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table device_approval_requests;
