# vibecheck-e2ee-prototype

A standalone prototype proving a **zero-knowledge, per-device E2EE foundation** for a real-time rooms/messaging app. Next.js 16 + Supabase + `libsodium-wrappers-sumo`. The `src/lib/e2ee-core/` module + `src/lib/bootstrap.ts` + all migrations are intentionally designed to be **lifted wholesale into a consuming app**.

- **Agent onboarding (read first if you're an AI):** `AGENTS.md`
- **e2ee-core API reference:** `src/lib/e2ee-core/README.md`
- **Port into a consuming app:** `docs/port-to-v2.md`

---

## Architecture at a glance (v3 per-device identities)

```
┌──────────────────────────── User account ────────────────────────────┐
│                                                                      │
│  User Master Key (UMK) — Ed25519 only                                │
│  ├── Signs: device issuance certs, device revocation certs           │
│  ├── Does NOT encrypt messages, does NOT wrap room keys              │
│  ├── Private half: lives on primary device + (encrypted) in          │
│  │   recovery_blobs; NEVER transmitted in usable form                │
│  └── Wrapped by: 24-word BIP-39 phrase (Argon2id) + Passphrase lock  │
│                                                                      │
│  N Device Key Bundles (one per device)                               │
│  ├── Ed25519 — signs blobs, signs membership ops                     │
│  ├── X25519  — receives sealed room-key wraps                        │
│  ├── Private halves: generated locally; NEVER leave the device       │
│  └── Trust chain: devices.issuance_signature verifies against UMK    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Per-room, per-generation:
  • Room symmetric key (32 bytes, XChaCha20-Poly1305)
  • Wrapped per-DEVICE via crypto_box_seal to each device.x25519_pub
  • Rotation: admin creates new gen, re-wraps for every current member's
    devices, atomic via kick_and_rotate RPC (also purges < new_gen - 9)
```

### Blob wire format (v3)

```
blobs row:
  { sender_id, sender_device_id, generation, nonce, ciphertext }

AEAD plaintext (JSON envelope):
  { v: 3, s: sender_user_id, sd: sender_device_id, sig: <base64>, p: <payload> }
  • sig = sign(domain || room_id || gen || nonce || sha256(payload),
              sender_device_ed_priv)
  • Verifier: fetch devices row by (sender_id, sender_device_id),
              verify issuance cert against user's UMK, then check sig.
```

## Trust model (what we defend against)

| Attacker | Outcome |
|---|---|
| Supabase operator (curious) | Sees routing metadata (who posted to which room when). Cannot decrypt; cannot forge writes that verify. |
| Supabase operator (row-mutating, `service_role` leak, SQL injection) | Cannot add a "ghost device" to an account — missing UMK signature fails every client's `verifyPublicDevice`. Cannot impersonate an inviter — signed envelope fails on accept. |
| Compromised secondary device | Attacker has THAT device's bundle only. Cannot sign device certs (no UMK). Next UMK rotation evicts them; explicit revocation evicts them instantly. |
| Compromised primary device (UMK priv exfiltrated) | Full account takeover until user rotates UMK. Mitigation: Settings → "Rotate & generate new phrase" signs a fresh UMK + new phrase + cascades room-key rotation on every admin-owned room. |
| Attacker with mailbox, no phrase | Signs in, hits device-linking-chooser, needs either a 6-digit code from an existing device OR the phrase. Cannot enroll unilaterally. |
| Attacker with mailbox + phrase | Account compromise. Phrase is a standalone credential by design — store it offline. |
| Removed group member | Row deleted at kick time; they're excluded from new gen immediately. Cached past-gen keys stay decryptable on their device (no server-side revocation of what they already saw) but `< new_gen - 9` wraps are server-purged so fresh sessions can't rebuild them. |
| Stolen unlocked device (no passphrase set) | Full access to this device's room memberships. **But passphrase lock is enforced as default since Point 19 fix** — any newly-enrolled device must set one before reaching `/rooms`. |
| Stolen locked device | Argon2id (opslimit 3 / memlimit 256 MiB) protects the wrapped bundle. Attacker must brute-force the passphrase offline. |
| Server-side abuse scanning / CSAM detection | Impossible by design. Images are client-re-encoded (EXIF stripped), AEAD-encrypted under room key + bound to `{room_id, blob_id, generation}`, stored as opaque bytes. Policy decision — accept before shipping to a general audience. |

## Core design choices

- **Signal/Matrix-style per-device identity**, not Bitwarden-style single-root-key. A device compromise scopes to that one device; the UMK stays on one (or zero) device at a time.
- **`libsodium-wrappers-sumo`** — Argon2id + `crypto_box_seal` + XChaCha20-Poly1305 in one audited library.
- **XChaCha20-Poly1305 AEAD for all ciphertexts** — random 24-byte nonce is safe without state.
- **Sealed-box wrapping** (`crypto_box_seal`) for room keys — anonymous sender, keyed only by recipient device's X25519 pubkey. Correct semantics for "post this key for a specific device."
- **Per-generation shared room key** (not per-message ratcheting) — O(1) send, O(N·devices) re-wrap on membership change. 10-generation retention window for "read history on fresh sessions" UX, paired with aggressive server-side purge of older wraps.
- **Atomic `kick_and_rotate` RPC** — evictee delete + new-gen wraps + gen bump + stale-invite purge + FS purge in one SECURITY DEFINER transaction. Conditional `current_generation = old_gen` guard rejects concurrent rotations.
- **Blob sigs inside AEAD** — the outer `blobs.signature` column is null on new rows; the Ed25519 signature rides inside the encrypted envelope. Server no longer stores a per-sender fingerprint linkable across blobs.
- **Transcript-bound 6-digit approval code** — `hash = SHA-256(domain || salt || code || linking_pubkey || link_nonce)` + server-side `verify_approval_code` RPC with 5-attempt limit and 2-minute TTL. Not a PAKE (deferred), but closes the active row-swap attack.
- **Mandatory PIN-lock** — first sign-in / first unlock / first enrollment all pass through `require-pin-setup`. Identity is Argon2id-wrapped in IndexedDB; plaintext-in-IDB is no longer the default posture.
- **UMK rotation cascades to room rotation** — rotating the master key also re-keys every room the user admins, so ghost devices can't retain room access.
- **Implicit auth flow, not PKCE** — `src/lib/supabase/client.ts` uses `flowType: 'implicit'`. Email magic link comes back in URL hash rather than needing a verifier stored in the requesting browser. Lets users request in Browser B and open the email in Browser A. If porting to SSR-first, switch back to `pkce` with `@supabase/ssr` cookie storage.

## Project layout

```
src/
├── app/
│   ├── page.tsx                          Landing + magic-link form
│   ├── auth/callback/page.tsx            Identity bootstrap, approval,
│   │                                     recovery, unlock, enforce-PIN gate
│   ├── api/dev/magic-link/route.ts       ⚠ TEMP dev shortcut — revert
│   │                                     before real-audience deploy
│   ├── rooms/page.tsx                    Rooms list + create + invite
│   ├── rooms/[id]/page.tsx               Room detail, messages, rotate,
│   │                                     in-room invite, nicknames
│   ├── settings/page.tsx                 Safety number, recovery phrase,
│   │                                     device list + revoke, PIN-lock
│   └── status/page.tsx                   Green-dot diagnostic dashboard
├── components/                           AppShell, PinSetupModal,
│                                         RecoveryPhraseModal, ...
├── lib/
│   ├── e2ee-core/                        ★ Pure crypto — copy verbatim
│   │   ├── device.ts                     UMK + DeviceKeyBundle + certs
│   │   ├── membership.ts                 Invite + wrap signatures
│   │   ├── blob.ts                       v3 envelope (sig inside AEAD)
│   │   ├── room.ts                       Keygen, wrap, unwrap, rotate
│   │   ├── pin-lock.ts                   Argon2id-wrapped device state
│   │   ├── recovery.ts                   BIP-39 phrase wraps UMK priv
│   │   ├── attachment.ts                 Image re-encode + AEAD
│   │   ├── approval.ts                   6-digit code hash
│   │   ├── linking.ts                    (legacy — kept for back-compat)
│   │   ├── storage.ts                    IndexedDB for device/umk/wrapped
│   │   ├── tofu.ts                       Key-change detection
│   │   ├── identity.ts                   Sign/verify primitives
│   │   └── sodium.ts                     Lazy libsodium init + encoders
│   ├── bootstrap.ts                      ★ App-glue helpers: bootstrapNewUser,
│   │                                     enrollDeviceWithUmk, rotateUserMasterKey,
│   │                                     rotateAllRoomsIAdmin, loadEnrolledDevice
│   └── supabase/                         Client + typed queries
supabase/
└── migrations/
    0001_init                           core schema + RLS + realtime
    0002_device_approval_and_recovery   device_approval_requests, recovery_blobs
    0003_room_name                      encrypted room display names
    0004_room_delete                    rooms_creator_delete policy
    0005_tighten_handoff_rls            handoffs_owner_all
    0006_attachments_bucket             room-attachments bucket + RLS
    0007_pair_cap_and_admin_delete      pair=2 trigger + admin-only kick
    0008_backport_live_helpers          is_room_member_at + my_room_ids +
                                        room_current_generation (SECURITY DEFINER)
    0009_atomic_kick_and_rotate         kick_and_rotate RPC, same-gen RLS
    0010_approval_attempt_limiter       verify_approval_code RPC
    0011_signed_membership              inviter_signature + wrap_signature
    0012_identity_epoch                 auto-bump trigger on UMK change
    0013_auto_rotate_and_purge          last_rotated_at + FS purge
    0014_blob_signature_nullable        sig moves inside AEAD
    0015_per_device_identities          ★ STRUCTURAL PIVOT — UMK + device keys
    0016_display_name_and_not_null      sealed-to-self display_name + NOT NULL
    0017_public_read_devices            devices SELECT = authenticated
    0018_purge_stale_invites_on_rotate  kick_and_rotate also wipes stale invites
    0019_retain_10_generations          FS window 2 → 10 gens
```

## Getting started

```bash
cp .env.example .env.local    # fill NEXT_PUBLIC_SUPABASE_URL + ANON_KEY
npm install
npm run dev                   # http://localhost:3000
```

### Supabase setup (one-time)

1. Create a project at [supabase.com](https://supabase.com).
2. Settings → API → copy URL + anon key to `.env.local`. (For dev magic-link shortcut, also copy `service_role` to `SUPABASE_SERVICE_ROLE_KEY` — server-only env var, never bundle to browser.)
3. Auth → Providers → enable Email.
4. Auth → URL Configuration → add `http://localhost:3000/auth/callback` to redirect allow-list.
5. SQL Editor → paste each file in `supabase/migrations/` in order and run. (Or use the Supabase CLI's `db push`.)
6. Database → Replication → ensure Realtime is on for `blobs`, `room_invites`, `device_approval_requests`. (`room_members` is intentionally NOT published — migration 0009 removed it.)

### Verification walkthrough

1. `/status` — every check green within a few seconds.
2. Open the app in a second browser profile. Sign up with a different email.
3. User A: Rooms → copy user ID → create a "pair" room → paste B's user ID → send invite.
4. User B: Rooms → accept invite (safety-number shown at accept time).
5. Both users → open the room. Send a message. Realtime delivery.
6. Supabase Table Editor → `blobs` → ciphertext is opaque base64.
7. Settings → "Your safety number" matches between the two browsers (read it out to confirm).
8. Kick a member → `rooms.current_generation` bumps.

## Deploying to Vercel (test/preview only today — see warning below)

1. Push to GitHub.
2. Import on Vercel; set env vars.
3. Deploy. Add the `*.vercel.app/auth/callback` URL to Supabase redirect allow-list.

**⚠ Temporary state:** `src/app/api/dev/magic-link/route.ts` is an unguarded server endpoint that generates magic links for any email via service-role key. Intentional for today's friends-testing sessions. **Before any real-audience deploy**: delete that file and revert `src/components/MagicLinkForm.tsx` to `supabase.auth.signInWithOtp` (see `docs/port-to-v2.md` for exact steps).

## Known limitations / future upgrades

See `docs/port-to-v2.md` for the full deferred list. Highlights:

- **No PAKE** for device approval — transcript-bound hash closes the active attack; CPace/OPAQUE is the textbook fix.
- **No full Sealed Sender** — signature lives inside AEAD but `sender_id` column is still visible to the server. Full hide needs an Edge Function insert path.
- **No Megolm-style intra-generation ratchet** — gen-granular FS via rotation + 10-gen retention covers most of the same surface for small/medium groups.
- **No traffic padding** — ciphertext length reflects plaintext length.
- **No WebCrypto non-extractable keys** — byte-oriented libsodium is the bottleneck.
- **No "confirm trusted devices" picker during UMK rotation** — today's rotation re-signs every active device. A proper rotation UX asks the user to tick off ghost devices first.
- **No Key Transparency log** — TOFU is the anchor; a KT log would let clients auto-audit.
- **Single-device crypto ops (web only)** — for native mobile, mirror the primitives against the platform's preferred library.
