# Porting this foundation into VibeCheck V2

Checklist to move from "prototype verified" to "V2 app building on the proven E2EE core."

## 1. Bring the core module across

Copy these things verbatim:

- `src/lib/e2ee-core/` — the crypto module (approval + recovery + room-name sealing + image attachments + signed-membership primitives + passphrase lock)
- `supabase/migrations/0001_init.sql` — core schema + RLS
- `supabase/migrations/0002_device_approval_and_recovery.sql` — device_approval_requests + recovery_blobs (needed for the code-approval device-sync UX and phrase-based account recovery)
- `supabase/migrations/0003_room_name.sql` — adds `name_ciphertext` + `name_nonce` to `rooms` for encrypted display names (see §5)
- `supabase/migrations/0004_room_delete.sql` — adds the `rooms_creator_delete` RLS policy so creators can tear a room down (cascades all children)
- `supabase/migrations/0005_tighten_handoff_rls.sql` — replaces the permissive `handoffs_any_authed` policy with `handoffs_owner_all` so only the user whose device is linking can read/write/delete their `device_link_handoffs` rows. Blocks cross-account enumeration and DoS against the QR/approval-code linking flow. Must be applied alongside the initial schema.
- `supabase/migrations/0006_attachments_bucket.sql` — creates the private `room-attachments` Storage bucket and RLS policies gating access by the `{roomId}/{blobId}.bin` path prefix. Current-gen members can INSERT; any-gen members can SELECT; room creator + current-gen members can DELETE. Required for encrypted image attachments — see §10 below.
- `supabase/migrations/0007_pair_cap_and_admin_delete.sql` — two rules baked into the DB: (a) pair rooms are strictly 2 people, enforced by a trigger on `room_members` + `room_invites` that counts distinct users and rejects a 3rd. (b) only the room creator (admin) may delete OR insert other users' `room_members` rows — previously any current-gen member could, which let non-admins kick each other. Self-delete (a user leaving their own rows) stays open so the "leave" flow works. See §11 for the admin model.
- `supabase/migrations/0008_backport_live_helpers.sql` — back-ports two previously-live-only migrations (`rooms_creator_can_read_own`, `fix_room_members_recursion`). Adds the SECURITY DEFINER helpers `is_room_member_at`, `room_current_generation`, and `my_room_ids` used by subsequent policies to avoid RLS recursion.
- `supabase/migrations/0009_atomic_kick_and_rotate.sql` — ships the `kick_and_rotate` RPC (atomic delete-evictee-first / insert-new-gen / bump-gen sequence), tightens `room_members_read` to same-generation scope via `my_generations_for_room`, and drops `room_members` from the realtime publication.
- `supabase/migrations/0010_approval_attempt_limiter.sql` — adds `failed_attempts` to `device_approval_requests` and a SECURITY DEFINER `verify_approval_code` RPC that atomically compares, increments on miss, and deletes on the 5th miss. Shortens default TTL to 2 minutes.
- `supabase/migrations/0011_signed_membership.sql` — adds nullable `inviter_signature` + `invited_ed25519_pub` + `expires_at_ms` columns on `room_invites` and nullable `signer_user_id` + `wrap_signature` on `room_members`. Extends `kick_and_rotate` to persist the per-wrap signature. **V2 port action: after users re-accept their invites and rotate their rooms, change these columns to NOT NULL and delete any remaining legacy unsigned rows to lock out ghost-user injection.**
- `supabase/migrations/0012_identity_epoch.sql` — adds `identities.identity_epoch` with a BEFORE-UPDATE trigger that bumps it whenever the published ed/x pubkeys change. Binds `device_approval_requests.identity_epoch` so approval rows across a master-key rotation are auto-invalidated.
- `supabase/migrations/0013_auto_rotate_and_purge.sql` — adds `rooms.last_rotated_at` (used by the admin UX to hint at stale keys) and extends `kick_and_rotate` to DELETE all `room_members` rows at `generation < new_gen - 1` in the same transaction. Provides lazy generation-granular forward secrecy: an attacker who later steals DB ciphertext cannot resurrect room keys older than the previous generation.
- `supabase/migrations/0014_blob_signature_nullable.sql` — makes `blobs.signature` nullable. New (v2) blobs carry the Ed25519 signature INSIDE the AEAD payload; the outer column is left null so the server no longer sees a per-sender fingerprint linkable across blobs. Legacy v1 blobs remain decryptable via the outer-signature fallback in `decryptBlob`.
- `supabase/migrations/0015_per_device_identities.sql` — **structural pivot to per-device identities.** `identities.ed25519_pub` becomes the User Master Key (UMK) pub; `x25519_pub` + `self_signature` are retired (nullable for compat). `devices` rows now carry each device's own ed25519/x25519 pubs plus a UMK-issued issuance cert (and optional UMK-signed revocation). `room_members` keys on `(room_id, device_id, generation)` — the room key is wrapped to each recipient DEVICE, not each user. `room_invites` gains `invited_device_id` + `inviter_device_id`. `blobs` gains `sender_device_id`. `kick_and_rotate` rewritten to accept per-device wraps + a `signer_device_id`. Linked devices no longer receive a copy of the root identity; each generates its own bundle locally, and the UMK holder (primary device) signs its cert. See `src/lib/e2ee-core/device.ts`, `src/lib/e2ee-core/membership.ts`, and `src/lib/bootstrap.ts` for the cert primitives and enrollment helpers.
- `supabase/migrations/0016_display_name_and_not_null.sql` — (1) encrypts `devices.display_name` at rest via `display_name_ciphertext` (sealed-box-to-self; each device encrypts its own label to its own x25519 pub so the Supabase operator no longer sees "Sam's iPhone"). Other co-devices of the same user see the row but can't decrypt the label — UI falls back to `device_id` + `created_at`. (2) sets NOT NULL on `room_invites.invited_ed25519_pub`, `room_invites.inviter_signature`, `room_invites.expires_at_ms`, `room_invites.invited_device_id`, `room_invites.inviter_device_id`, `room_members.signer_device_id`, `room_members.wrap_signature` — the legacy-nullable grace window that Fix 5 opened is now closed.
- `supabase/migrations/0017_public_read_devices.sql` — splits `devices_self_all` (owner-only for everything) into `devices_read_all` (public SELECT) + per-operation owner-only write policies. Required for v3: peer clients need to read each other's device_ed25519_pub / device_x25519_pub / issuance_signature to verify certs and wrap room keys. Device rows carry public key material + UMK-signed certs + an opaque `display_name_ciphertext` — all safe to expose.
- `supabase/migrations/0018_purge_stale_invites_on_rotate.sql` — extends `kick_and_rotate` to DELETE `room_invites` at `generation < new_gen` in the same transaction. Closes a race where a stale invite (wrapping a superseded gen's key) could be accepted after a rotation, leaving the invitee with a row that's immediately purged by the next rotation's FS cleanup.
- `supabase/migrations/0019_retain_10_generations.sql` — widens the FS purge window from 2 gens to 10. `kick_and_rotate`'s purge clause is now `< p_new_gen - 9`. Returning members on a fresh session can decrypt ~9 rotations of past history instead of ~1. Retrospective-only security surface (sealed bytes remain opaque at rest).

- `supabase/migrations/0020_nullable_linking_pubkey.sql` — drops NOT NULL on the legacy `device_approval_requests.linking_pubkey` column (v3 approval flow doesn't populate it; was blocking mobile sign-in).

- `supabase/migrations/0022_key_backup.sql` — adds the server-side room-key backup table (Matrix-style key-backup). `key_backup (user_id, room_id, generation, ciphertext, nonce)` stores per-generation room keys encrypted under a user-scoped 32-byte backup key. RLS: `key_backup_owner` locks SELECT/INSERT/UPDATE/DELETE to `user_id = auth.uid()`. Also adds nullable `devices.backup_key_wrap` — a sealed (`crypto_box_seal`) copy of the backup key, written by the approving device and picked up by the newly-enrolled device so it can pull and decrypt the backup on first load. The backup key itself is escrowed inside the v3 recovery blob (see §12) so recovery-phrase entry on a fresh device recovers both UMK priv AND backup key.

- `supabase/migrations/0023_calls.sql` — E2EE video-call scaffolding. Adds three tables (`calls`, `call_members`, `call_key_envelopes`) plus six RPCs (`start_call`, `join_call`, `leave_call`, `rotate_call_key`, `heartbeat_call`, `end_call`) and two helpers (`is_active_call_member`, `assert_caller_owns_device`). `call_key_envelopes` is the call-scoped analogue of `room_members.wrapped_room_key`: each row is a sealed CallKey addressed to one target device, signed by the sender device. `rotate_call_key` enforces `p_new_gen = current_gen + 1` so concurrent rotators serialize via the DB — no leader lease. `calls` is published on realtime; `call_members` and `call_key_envelopes` are not (publication churn on every heartbeat would be intolerable). **V2 must also port:** `src/lib/e2ee-core/call.ts` (pure crypto — joins the blob/membership/etc module family); `src/lib/livekit/` (new peer module — adapter + token renewal, portable as one directory, requires `npm install livekit-client`); `supabase/functions/livekit-token/` (Deno edge function that mints 5-min LiveKit JWTs after verifying device + call membership). See `docs/video-call-design.md` for the full design.

**E2EE video call gotchas V2 WILL hit (learned the hard way on the prototype):**
- **`supabase.functions.invoke` does not reliably send the `apikey` header** under some supabase-js versions, and the Supabase Edge gateway rejects the request before it reaches the function (`"No API key found in request"`). The prototype's `src/lib/livekit/token-fetcher.ts` uses plain `fetch` with **both** `apikey` (the anon key) and `Authorization: Bearer <user_jwt>` headers explicit. Reuse that pattern for any new edge-function call, not just `livekit-token`.
- **Turbopack cannot resolve bare module specifiers for Worker URLs.** `new Worker(new URL('livekit-client/e2ee-worker', import.meta.url))` throws a minified `e.indexOf is not a function` at runtime from inside Next.js 16's module loader. The prototype ships the worker as a static file at `public/livekit-e2ee-worker.mjs`, kept in sync by `scripts/sync-livekit-worker.mjs` via `postinstall` + `prebuild` hooks. If V2 uses webpack instead of Turbopack, the bare-specifier approach may work — but the static-file path works in both, so keep it.
- **LiveKit WS URL must have the `wss://` scheme.** A bare hostname passes our edge function's env-var check and blows up inside LiveKit client's URL parser with the same cryptic `indexOf` error. Validate the `LIVEKIT_WS_URL` env var includes the scheme.
- **`@experimental` encryption option:** we use `encryption: { keyProvider, worker }` on the LiveKit `Room` options. The older `e2ee` field is marked deprecated but is more stable in some examples; if a future SDK upgrade breaks us, try `e2ee` as a fallback before hunting other bugs.
- **Deploy the edge function with `verify_jwt: false`.** Supabase projects with ES256-signed auth tokens (the newer asymmetric default) cannot pass the edge-function gateway's HS256-only verification — you'll get `UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM` 401s. Our function does its own JWT verification via `supabase.auth.getUser()` inside the handler, which hits the auth service and works regardless of signing algorithm. The gateway-level check is redundant; turn it off. If you deploy a new edge function that relies on user auth, pair `verify_jwt: false` at the gateway with an explicit `supabase.auth.getUser()` call inside.

**E2EE video call invariants (V2 must preserve):**
- `rotateCallKeyForCurrentMembers` excludes any device NOT in the new envelope set — that's the eviction mechanism for leave + revoke. If V2 adds a new "kick from call" flow, it must call the rotation RPC with the kicked device omitted from envelopes, not attempt to directly delete rows.
- The elected rotator is deterministic: lowest `(joined_at ASC, device_id ASC)` among non-stale, non-left members. Concurrent rotators are resolved by the DB's `new_gen = current + 1` uniqueness constraint; losers read the new gen and move on. Do not add a leader-lease scheme.
- **LiveKit token renewal is mandatory, not optional.** Tokens are 5-minute TTL to support the revocation-cascade path — any call longer than 5 min without silent renewal drops randomly. `livekit-adapter.ts`'s `scheduleRenewal` + `visibilitychange` handler own this; never call `Room.connect` manually or without going through `LiveKitAdapter`.
- **Revocation cascades into active calls.** `revokeDevice` in `src/app/settings/page.tsx` calls BOTH `rotateAllRoomsIAdmin` AND `cascadeRevocationIntoActiveCalls` — the latter re-keys every active call the acting device is currently in, omitting the revoked device from new envelopes. Calls the acting device is NOT in are handled via the heartbeat-grace loop on remaining participants (30s window). Any new "revoke device" UX must replicate both cascades.
- **Heartbeat grace is 30 seconds** (`HEARTBEAT_GRACE_SECONDS` in bootstrap.ts). Shrinking it causes UX-hostile flapping on normal network flaps; widening it extends the window where a maliciously offlined device can lurk with the CallKey. Document and discuss before changing.
- QVGA capture constraints (320×240 @ 15fps, simulcast off) are hardcoded in `src/lib/livekit/adapter.ts`. Consuming apps may override per-call but the foundation default is the retro mode, because it also simplifies frame-key management (no simulcast = no per-layer keys).

**Crash-safe rotation + key-backup invariants (V2 must preserve):**
- Recovery-blob write MUST precede UMK-pub publish during any rotation. The split helpers `generateRotatedUmk` / `commitRotatedUmk` in `bootstrap.ts` make this explicit. A browser crash between the blob write and the pub publish leaves the user recoverable via phrase; a crash the other way around would lock them out. Matrix-SSSS pattern.
- Every `wrapRoomKeyForAllMyDevices` call checks `getBackupKey(userId)` and, if present, uploads an encrypted room-key to `key_backup` alongside the `room_members` inserts. New rooms, accepted invites, and rotations all take this path — no other call sites should wrap a room key.
- Device-approval flow (A-side) reads the local backup key, seals it to the new device's x25519 pub, and writes it to `devices.backup_key_wrap`. B-side's auth callback picks it up post-enrollment and calls `putBackupKey` locally. Without this hand-off, newly-approved devices couldn't decrypt pre-existing backup rows.
- Recovery-phrase entry (`RecoveryPhraseEntry.tsx`) calls `putBackupKey` with the blob-recovered backup key BEFORE `enrollDeviceWithUmk`, so any backup-restore logic that fires post-enrollment finds the key available.

**Multi-device sync note (critical for V2):** all membership-changing actions must use `wrapRoomKeyForAllMyDevices` (not single-device `addRoomMember`) and all invite-send paths must use `sendInviteToAllDevices` (not single-device `createInvite`). These helpers in `bootstrap.ts` ensure every device on the user's account gets immediate access to every room, and invites can be accepted from any device. If you add a new room-join flow, use these helpers. See the rotation paths in `rooms/[id]/page.tsx` for how keepers' devices are enumerated during key rotation.

**Additional top-level files to copy beyond `src/lib/e2ee-core/`:**
- `src/lib/bootstrap.ts` — app-glue layer above e2ee-core. Contains `bootstrapNewUser`, `enrollDeviceWithUmk`, `loadEnrolledDevice`, `rotateUserMasterKey`, `rotateAllRoomsIAdmin`. Not portable the same way e2ee-core is — imports from `supabase/queries` — so either copy verbatim alongside the queries module, or re-implement against your own data layer.
- `src/components/PinSetupModal.tsx` — shared mandatory-capable passphrase setup modal. Used by auth callback (enforced default) and settings (change passphrase).
- `src/components/RecoveryPhraseModal.tsx` and `RecoveryPhraseEntry.tsx` — phrase setup/rotation and recovery UX. Both know about the UMK rotation cascade.
- `src/components/PendingApprovalBanner.tsx` — A-side of device approval; uses UMK priv to sign issuance certs for B-side requests.
- `src/components/AppShell.tsx` — wraps all authed pages with the post-mount UMK-vs-device-cert sanity check that boots orphaned sessions.

**⚠ TEMP dev shortcut to revert before real-audience deploy:**
- `src/app/api/dev/magic-link/route.ts` — unguarded endpoint that generates magic-link URLs server-side using the Supabase service-role key. Any caller can mint a link for any email. Delete the file AND revert `src/components/MagicLinkForm.tsx` to call `supabase.auth.signInWithOtp(...)` instead of the fetch.

Install in V2:

```
npm install libsodium-wrappers-sumo idb @scure/bip39 livekit-client
```

`livekit-client` is the SFU client SDK used by `src/lib/livekit/`. Required only if porting the video-call surface (migration 0023 + `e2ee-core/call.ts`).

The LiveKit edge function (`supabase/functions/livekit-token/`) needs these env vars set in Supabase:

```
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_WS_URL=wss://<project>.livekit.cloud
```

Deploy with `supabase functions deploy livekit-token`. Prototype uses LiveKit Cloud (free tier caps call duration at 60 min); V2 should self-host `livekit-server` alongside Supabase to remove that cap.

(`@scure/bip39` is what `src/lib/e2ee-core/recovery.ts` uses for the 24-word phrase.)

Everything else in the prototype (magic-link form, status page, rooms UI) is reference UX you can copy as a starting point or rebuild behind VibeCheck's design system.

## 2. Hook up Supabase

Either reuse the prototype's `src/lib/supabase/` wholesale, or write the V2 app's own data layer that satisfies the same contract: every `bytea`-looking column is URL-safe base64 on the wire, every table has typed insert/fetch/list/subscribe helpers.

If V2 wants to pre-generate TypeScript types from the DB, run `supabase gen types typescript` after the migration is applied; the row shapes in `src/lib/supabase/queries.ts` are a manual mirror of that.

## 3. Port the auth bootstrap

The critical path is in `src/app/auth/callback/page.tsx`:

1. Let Supabase's `detectSessionInUrl` parse the implicit-flow hash during client init. **Do not** manually strip `window.location.hash` before awaiting the session — it races the parser and kills the sign-in. Instead call `await supabase.auth.getSession()` to gate on init completion, then call `getUser()`.
2. Fetch the user's row from `identities`.
3. Check IndexedDB for a local identity copy.
4. Five cases:
   - **server yes + local yes** → returning user. **Must** chain-check the local device cert against the published UMK (`verifyLocalChainOrMarkOrphan` helper); if orphan, wipe local state and route to recovery before attempting to navigate.
   - **server yes + local-plaintext no + wrapped-blob yes** → passphrase lock engaged; show the unlock form. **After a successful unlock**, run the same chain-check as above: the wrapped blob may hold stale keys (UMK rotated elsewhere, device revoked), and skipping the check causes an infinite sign-in loop (AppShell's post-mount guard kicks the user back to `/`, where the still-present wrapped blob routes them right back to unlock). On orphan verdict, also delete the wrapped blob — its contents are dead and keeping it would re-trigger the loop on next sign-in.
   - **server yes + local no + no wrapped blob** → new device. Show the chooser: "request approval from another device" (6-digit code path — `device_approval_requests`) or "enter recovery phrase" (`recovery_blobs`, only enabled if one exists).
   - **server no + local no** → first sign-in, generate identity, publish pubkeys, register device, then offer to set up a recovery phrase.
   - **server no + local yes** → shouldn't happen, but treat as "first sign-in" safely.

The unlock form must also expose a "forgot passphrase" affordance that routes to the same chooser the "server yes + local no" case uses — same three options (approve from another device / 24-word phrase / nuclear reset). A pin-locked device with no escape hatch is a lockout footgun.

V2 should keep this exact decision tree. Any variation risks dropping users into the wrong funnel.

## 4. Keep /status

The `/status` page is more valuable in V2 than it was here — it's your canary when integrating third-party features (e.g. file storage, presence, typing indicators). Keep it in V2 behind a dev-only flag, or always-on but hidden from the nav.

Add one check per E2EE-touching feature you add (e.g. "File attachments roundtrip," "Typing event AEAD roundtrip"). The principle: any code path that moves a cipher through the server should have a green dot you can look at.

## 5. Layer VibeCheck domain on top of blobs

VibeCheck V1's domain is sliders, Mind Reader guesses, Safe Space messages with Time-Out, Date Proposals, Therapy Reports. In V2, every one of those is an encrypted blob payload:

```ts
type VibeBlob =
  | { type: 'slider'; metric: Metric; value: number }
  | { type: 'message'; text: string; draft?: boolean }
  | { type: 'date_proposal'; proposalId: string; title: string; slots: Slot[] }
  | { type: 'date_response'; proposalId: string; response: 'accept'|'counter'|'decline' }
  | { type: 'mind_reader_guess'; metric: Metric; guess: number }
  | { type: 'therapy_homework_update'; ... }
  | ...;
```

Use a discriminated union + a `zod` schema at the decrypt boundary to validate payloads before you trust them. That schema lives in the V2 app (since it's domain-specific), NOT in e2ee-core.

Tip: keep the Therapy Session Report an aggregation *in the client* across many blobs, not a server-side query. That's how the zero-knowledge guarantee survives clinical tooling.

### Encrypted room names

`rooms` carries optional `name_ciphertext` + `name_nonce` columns (migration 0003). The name is sealed under the current-generation room key using XChaCha20-Poly1305 with AD bound to `(room_id, generation, "vibecheck:name:v1")` — so a name ciphertext cannot be swapped for a message blob even though they share the same key. Unsigned on purpose: any current member can rename.

V2 implications:
- On member removal / key rotation, re-encrypt the name under the new key (see the `rotateOut` flow in `src/app/rooms/[id]/page.tsx`). If the re-encrypt fails, clear the name rather than block the rotation.
- Use `encryptRoomName` / `decryptRoomName` from `e2ee-core`; the server never sees plaintext.
- This supersedes the earlier "consider a separate `room_meta` table" note — names live on the `rooms` row directly.

## 6. Features out-of-scope for prototype that V2 needs

| Feature                      | Where to put it                                                 |
| ---------------------------- | --------------------------------------------------------------- |
| File/photo attachments       | Upload ciphertext + a small header blob. Use `crypto_secretstream_*` (streaming AEAD) for large files. |
| Presence / typing indicators | Supabase Realtime presence channel keyed by room_id             |
| Push / email notifications   | Server only sees sender/room + timestamp. Include a room display name only if that display name is also encrypted client-side into a tiny "room meta" blob. |
| Invite by email              | Add an `email` column on `identities` that each user writes for themselves (RLS: self-insert). Or add an RPC `find_user_id_by_email` (SECURITY DEFINER) if you want stricter privacy. |
| Account deletion             | Deleting `auth.users` cascades to identities, rooms created_by, etc. Surviving members keep working because their wrapped keys are local and current-generation. |

## 7. V2-only changes to the DB schema

Anticipated, none yet mandatory:

- Add `email text` to `identities` if you go the invite-by-email route.
- If you want room avatars, extend the room-name sealing pattern (XChaCha20-Poly1305 under the current-gen room key, with a distinct AD field tag) rather than spinning up a separate table.
- If you want to support file attachments, add a `blob_attachments` table mirroring `blobs` but referencing Supabase Storage object paths + per-object wrap keys.

Everything else in the prototype's schema should survive untouched.

## 9. Portable query + realtime helpers to copy

`src/lib/supabase/queries.ts` grew a few helpers during prototyping that V2 will want as-is:

- **`renameRoom` / `deleteRoom`** — mirror the `rooms_member_update` and `rooms_creator_delete` RLS policies.
- **`nukeIdentityServer(userId)`** — the "nuclear reset" escape hatch used when a user is locked out with no other device and no recovery phrase. Wipes their `room_members`, `room_invites`, `device_approval_requests`, `devices`, and `recovery_blobs` rows so a fresh identity can be published in place. Blobs in rooms they were in are left behind as append-only ciphertext nobody can decrypt — the intended trust model. Surface it behind a typed-confirmation gate; see `src/app/auth/callback/page.tsx` for the copy + gating pattern.
- **`subscribeInvites(userId, onRow, onStatus?)`** — realtime `INSERT` on `room_invites` filtered by `invited_user_id=eq.<uid>`. Use it so incoming invites land without a refresh; the callback signature matches `subscribeBlobs` and `subscribeApprovalRequests`.

### Optimistic-append + realtime-dedupe pattern

The room feed (`src/app/rooms/[id]/page.tsx`) demonstrates a pattern worth keeping in V2: on send, the composer passes the inserted row straight into the same ingest function the realtime subscription uses, and the ingest dedupes by row `id` before appending. This gives instant self-render without flicker when the realtime echo arrives. Apply the same shape to any feature that reads a table via realtime AND writes to it (typing indicators, presence, etc.).

## 10. Image attachments (portable path)

The prototype ships a full encrypted-image pipeline; V2 should copy it wholesale and only rewrite the composer/feed UI.

Portable pieces (copy verbatim):

- `supabase/migrations/0006_attachments_bucket.sql` — the `room-attachments` bucket + RLS.
- `src/lib/e2ee-core/attachment.ts` — `prepareImageForUpload`, `decryptImageAttachment`, `ImageAttachmentHeader`, `attachmentStorageKey`, the AD helper.
- `src/lib/supabase/queries.ts` → `uploadAttachment`, `downloadAttachment`, `deleteAttachment`, `deleteAttachmentsForRoom`. Also keep the `insertBlob({ id? })` overload — image sends need to know the blob id *before* insert so the storage path can be computed.

Encryption shape:

- Re-encode client-side via `createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 1600 })` → `OffscreenCanvas.convertToBlob({ type: 'image/webp', quality: 0.82 })`. This automatically strips EXIF (including GPS).
- Encrypt bytes with `crypto_aead_xchacha20poly1305_ietf_encrypt`, AD = `uuid(roomId) || uuid(blobId) || u32be(generation) || "vibecheck:attachment:v1"`. The distinct AD tag and `blobId` inclusion prevent cross-room, cross-generation, and cross-attachment swap attacks even if the server misbehaves.
- Upload the resulting `nonce || ciphertext` to `{roomId}/{blobId}.bin` in the bucket.
- The outer `blobs` row carries a small JSON payload: `{type:'image', mime, w, h, byteLen, placeholder}` where `placeholder` is a tiny blurred WebP base64 data URL for instant feed rendering.

V2 implications:

- **Key rotation** does not require re-encrypting attachments. Old members keep access to pre-rotation images (same as pre-rotation text blobs — append-only trust model). `deleteRoom` calls `deleteAttachmentsForRoom` before the row cascade because Storage has no FK relationship.
- **Larger files** (video, PDFs) should switch from `crypto_aead_xchacha20poly1305_ietf_*` to `crypto_secretstream_xchacha20poly1305_*` so you can encrypt/decrypt in chunks without holding the whole plaintext in memory. The bucket, RLS, and header-in-blob pattern stay the same.
- **Server-side moderation is fundamentally impossible** with this design. Decide in advance whether VibeCheck's audience accepts the Signal-style tradeoff, and put it in the product's Trust-and-Safety copy.

/status in V2 should keep the "image attachment roundtrip" check — it uses a synthetic canvas-generated `File` so it works without any picker UI, and it catches regressions across the full encrypt/upload/download/decrypt pipeline.

## 11. Admin model + room kinds

**Pair rooms are strictly 2 people.** Groups have no cap in the prototype — pick one in V2 based on the UX (8? 50?) and encode it in the trigger. Either way, the enforcement lives in `0007_pair_cap_and_admin_delete.sql`: a BEFORE INSERT trigger on both `room_members` and `room_invites` counts distinct `user_id` values across both tables and rejects insertions that would exceed the cap. Existing users (re-wraps during rotation, invite-acceptance paths) short-circuit so the trigger never blocks legitimate churn.

**The room creator is the admin.** That single bit — `rooms.created_by = auth.uid()` — is what determines who can:
- kick other members (the "remove + rotate" button in `MemberList`),
- delete the whole room (via `rooms_creator_delete` policy from 0004),
- insert new members during rotation (via the tightened `room_members_insert` policy from 0007).

**Everyone else can leave but not kick.** Non-admin members see a "leave" button on their own row. Under the hood it uses the same `rotateAndRemove` helper as admin-kick, just with `keep = members \ self` and `remove = [self]`. The tightened `room_members_delete` RLS policy lets them delete only their own rows.

**Edge cases baked in:**
- Creator cannot "leave" — they must delete the room. The MemberList UI shows no action on the creator's own row; the delete-room button above it is the intended escape hatch.
- A rotation that ends with zero remaining members (last leaver in a solo room) skips the re-wrap step entirely and just deletes the leaver's rows. The room becomes an empty-shell owned by the original creator until they delete it.
- In a pair room, both members can "leave" (non-creator ≥ creator — the creator must use "delete room" instead).

**Client/server consistency:**
- `listMyRoomKeyRows` returns *every* generation of `room_members` rows the viewer still has, unwrapped into a `Map<generation, RoomKey>`. `decodeAndVerify` picks the right key by `blob.generation`. `ImageAttachment` does the same lookup. This is what lets post-rotation members still read pre-rotation messages — the data was always there, the prototype just wasn't using it.
- Sending always uses the current-gen key (`roomKey` state, mirrored in a ref for callbacks).
- Rotation inserts new rows at `new_generation` for every remaining member **and** (separately) cascades old rows for the removed user. Old-gen `room_members` rows for remaining users are intentionally kept so the viewer retains the ability to decrypt historical blobs on this device and across future devices (re-sync from server).

**V2 additions likely wanted:**
- Admin transfer: allow the creator to hand off admin to another member before leaving. Minimum viable: add an `admin_user_id` column to `rooms`, default it to `created_by`, gate kick/delete on that column instead of `created_by`. An RPC `transfer_admin(room_id, new_admin_id)` with `SECURITY DEFINER` runs the swap atomically.
- Named group size cap: change the trigger's hard-coded `2` into a per-room column (`member_cap int`) and have the pair kind default it to 2.
- "You've been removed" banner: when the RLS kicks in (a leaver/kickee tries to read the room), show a graceful empty-state instead of the raw "not a current-gen member" error. The bones are already in `loadAll`.

## 12. Server-side room-key backup (Matrix key-backup)

Migration 0022 + the v3 recovery blob format give us a cross-device history-restore path without relaxing the zero-knowledge posture. The server never sees the backup key.

**Recovery blob v3 format** (backward-compatible with v2 64-byte blobs):

```
plaintext = [ UMK_ed25519_priv (64 bytes) || backup_key (32 bytes) ]   (96 bytes, v3)
         or [ UMK_ed25519_priv (64 bytes) ]                            (64 bytes, v2)
AD        = "vibecheck:recovery:v3:${userId}"  (v3)
         or "vibecheck:recovery:v2:${userId}"  (v2 fallback)
```

`unwrapUserMasterKeyWithPhrase` tries v3 AD first and falls back to v2. New blobs always use v3.

**Backup encryption** (`encryptRoomKeyForBackup` in `e2ee-core/recovery.ts`):

```
ciphertext = XChaCha20-Poly1305(
  key       = backup_key,
  nonce     = random 24 bytes,
  plaintext = [ generation(u32be) || roomKey(32 bytes) ],
  AD        = "vibecheck:key-backup:v1:${roomId}:${generation}",
)
```

Row shape: `key_backup (user_id, room_id, generation, ciphertext, nonce, created_at)`. Primary key `(user_id, room_id, generation)` — re-wrapping an existing generation is idempotent.

**Three paths by which a device gets the backup key:**

1. **Primary device, first phrase setup** — `generateBackupKey()` in `RecoveryPhraseModal`, stashed via `putBackupKey` + baked into the v3 recovery blob.
2. **New device via recovery phrase** — `unwrapUserMasterKeyWithPhrase` returns `{ ed25519PrivateKey, backupKey? }`; callback stores backup key locally before `enrollDeviceWithUmk` (so future restore logic can fire). Key lives on.
3. **New device via approval flow** — A-side `PendingApprovalBanner` seals the local backup key to B's x25519 pub via `crypto_box_seal`, writes to `devices.backup_key_wrap`. B's auth callback reads the row post-enrollment, unseals with its x25519 priv, calls `putBackupKey`.

**V2 port considerations:**

- Backup key ≠ UMK priv. UMK signs; backup key encrypts. Don't conflate or reuse bytes across them.
- A user who never sets up a recovery phrase never has a backup key → `key_backup` stays empty → no history restore. That's the correct behaviour; the recovery phrase IS the opt-in for key backup.
- Losing all devices AND the phrase = permanent loss of `room_members` wraps older than `current_generation - 9`. The backup is only useful when at least one credential survives.
- Server-side reads of `key_backup` ciphertext leak the room/generation graph (same as `room_members` already does) but not keys. Accept the shape parity.
- If V2 adds a key-backup "prune" UX (e.g. drop old generations to limit row count), rotate the backup key first via a new recovery-blob write — otherwise a server snapshot keeps the pruned rows readable.

**Check #16** in `/status` is the canary: it constructs a synthetic temp device, signs its cert with the real UMK, runs the full wrap/unwrap roundtrip, cleans up. Keep it in the V2 port.

## 8. Things to test on each port

Before calling V2 ready:

- Run the prototype's verification scenarios against V2's deployment (same 1–8 from the root README).
- Send every blob type through encrypt + decrypt on localhost, then confirm the Supabase row contents look like random bytes in base64.
- Rotate a group member out and confirm new blobs are unreadable without the new key; old blobs are still readable by historical members but not by the removed one.
- Link a device, sign out on the primary, confirm the secondary still has full access.
- Lose all devices (clear IndexedDB on both), confirm the user is correctly routed to "no identity on device, but identity exists on server" state — and guided to re-pair, not to a broken dead-end.
- Rotate the recovery phrase on device A, refresh the tab between "new UMK generated" and "UMK pub published" (devtools → disable cache + throttle), then reload and re-enter the new phrase. The account should recover via the new blob rather than lock out. (Proves SSSS ordering.)
- Create a room on A, approve a new device B, confirm B's `devices.backup_key_wrap` gets populated and B can decrypt backed-up history. Then on a third device C, enter the recovery phrase and confirm C downloads + decrypts `key_backup` rows for every room. (Proves the three backup-key paths.)
