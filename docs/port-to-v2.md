# Porting this foundation into VibeCheck V2

Checklist to move from "prototype verified" to "V2 app building on the proven E2EE core."

## 1. Bring the core module across

Copy these things verbatim:

- `src/lib/e2ee-core/` — the crypto module (approval + recovery + room-name sealing)
- `supabase/migrations/0001_init.sql` — core schema + RLS
- `supabase/migrations/0002_device_approval_and_recovery.sql` — device_approval_requests + recovery_blobs (needed for the code-approval device-sync UX and phrase-based account recovery)
- `supabase/migrations/0003_room_name.sql` — adds `name_ciphertext` + `name_nonce` to `rooms` for encrypted display names (see §5)
- `supabase/migrations/0004_room_delete.sql` — adds the `rooms_creator_delete` RLS policy so creators can tear a room down (cascades all children)
- `supabase/migrations/0005_tighten_handoff_rls.sql` — replaces the permissive `handoffs_any_authed` policy with `handoffs_owner_all` so only the user whose device is linking can read/write/delete their `device_link_handoffs` rows. Blocks cross-account enumeration and DoS against the QR/approval-code linking flow. Must be applied alongside the initial schema.

Install in V2:

```
npm install libsodium-wrappers-sumo idb @scure/bip39
```

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
4. Four cases:
   - **server yes + local yes** → returning user, ensure device registered, continue.
   - **server yes + local no** → user is on a new device. Show the chooser: "request approval from another device" (6-digit code path — `device_approval_requests`) or "enter recovery phrase" (`recovery_blobs`, only enabled if one exists).
   - **server no + local no** → first sign-in, generate identity, publish pubkeys, register device, then offer to set up a recovery phrase.
   - **server no + local yes** → shouldn't happen, but treat as "first sign-in" safely.

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

## 8. Things to test on each port

Before calling V2 ready:

- Run the prototype's verification scenarios against V2's deployment (same 1–8 from the root README).
- Send every blob type through encrypt + decrypt on localhost, then confirm the Supabase row contents look like random bytes in base64.
- Rotate a group member out and confirm new blobs are unreadable without the new key; old blobs are still readable by historical members but not by the removed one.
- Link a device, sign out on the primary, confirm the secondary still has full access.
- Lose all devices (clear IndexedDB on both), confirm the user is correctly routed to "no identity on device, but identity exists on server" state — and guided to re-pair, not to a broken dead-end.
