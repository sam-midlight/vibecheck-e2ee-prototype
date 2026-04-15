# vibecheck-e2ee-prototype

A standalone prototype proving a **zero-knowledge, Signal/Bitwarden-style encryption foundation** for a real-time rooms/messaging app. Built with Next.js 16 + Supabase + `libsodium-wrappers-sumo`. The `src/lib/e2ee-core/` module is intentionally app-agnostic and ports wholesale into V2.

- **Spec and decision log:** this file
- **Module API reference:** `src/lib/e2ee-core/README.md`
- **Port into V2 checklist:** `docs/port-to-v2.md`

---

## Architecture at a glance

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│         Browser A           │        │         Browser B           │
│                             │        │                             │
│  IndexedDB: identity privs  │        │  IndexedDB: identity privs  │
│    ↑                        │        │    ↑                        │
│    │                        │        │    │                        │
│  e2ee-core                  │        │  e2ee-core                  │
│  encrypt + sign blob        │        │  verify + decrypt blob      │
│    ↓                        │        │    ↑                        │
└───────────┬─────────────────┘        └─────────────┬───────────────┘
            │ ciphertext + sig + nonce                │
            ▼                                         │
        ┌───────────────────── Supabase ─────────────────┐
        │  Postgres + RLS                                │
        │  • identities       (public keys only)         │
        │  • rooms            (kind, parent, generation) │
        │  • room_members     (wrapped room keys)        │
        │  • room_invites     (pending wrapped keys)     │
        │  • blobs            (nonce + ciphertext + sig) │
        │  • device_link_handoffs (ephemeral)            │
        │  • device_approval_requests (ephemeral)        │
        │  • recovery_blobs   (phrase-wrapped priv keys) │
        │  + Realtime pushes new rows to subscribers     │
        └─────────────────────────────────────────────────┘
```

Supabase sees routing metadata (who posted to which room when) but never any plaintext payload.

## Key hierarchy

```
User identity (per account, device-local only — no server backup)
├── Ed25519 signing keypair   — identity, write authenticity, self-signature
└── X25519 DH keypair         — used to receive wrapped room keys

Per-room (per generation)
└── Room symmetric key (32 bytes)
    ├── Wrapped per member via crypto_box_seal(roomKey, member.x25519_pub)
    └── Incremented on membership change; old blobs stay under old key
```

## Trust model (what we defend against)

| Attacker                             | Outcome                                               |
| ------------------------------------ | ----------------------------------------------------- |
| Supabase operator (curious)          | Sees only ciphertext + routing metadata               |
| Supabase operator (actively swapping pubkeys post-signup) | Detected by TOFU banner on next interaction |
| Supabase operator (MITM on *first* invite) | Not prevented — accepted tradeoff for zero friction   |
| Stolen JWT without the device        | Can read metadata; cannot decrypt; cannot forge writes (sig check) |
| Stolen unlocked device               | Full access. No extra re-auth gate.                   |
| Attacker with mailbox, no phrase     | Can sign in, but hits `device-linking-needed` chooser — needs a legitimate device to approve via 6-digit code, OR the recovery phrase |
| Attacker with mailbox + phrase       | Full account compromise. Phrase is a standalone credential by design — store it offline |
| Attacker pushing "approve" on A      | Defeated by code-entry flow: the 6-digit code lives on B's screen, so A has nothing to approve unless the real user types it |
| Lost all devices, have phrase        | Enter phrase on new device → unwrap from `recovery_blobs` → identity restored. Old room blobs remain decryptable |
| Lost all devices, no phrase          | No recovery. User resets; partners re-invite. Old room blobs permanently lost |
| Removed group member                 | Can still decrypt past blobs they cached; cannot decrypt anything new (key rotated) |

## Core decisions (and why)

- **`libsodium-wrappers-sumo` over WebCrypto** — Argon2id availability and a clean `crypto_box_seal` primitive beat WebCrypto's smaller surface; portable across platforms we might add later.
- **Ed25519 + X25519** — standard Signal-style split: signing separate from DH. Avoids accidental key reuse across purposes.
- **XChaCha20-Poly1305 for blobs** — random 24-byte nonce is safe without state, avoiding the AES-GCM nonce reuse footgun.
- **Per-room symmetric key wrapped per member** — Bitwarden-style. Simple to reason about, supports multi-member rooms, and key rotation is tractable.
- **`crypto_box_seal` for wrapping** — anonymous sender, keyed only by recipient's X25519 pubkey. Right semantics for "post this key for a specific user to pick up."
- **Two-path multi-device onboarding**:
  1. **Device approval (primary)** — new device (B) generates an ephemeral X25519 keypair + short 6-digit code, writes a `device_approval_requests` row. An already-signed-in device (A) sees a banner; the user types the code; A seals its identity with B's pub, writes a `device_link_handoffs` row; B decrypts and installs. Code-on-B-entered-on-A closes the social-engineering ("approve this push") attack that plagues push-based MFA.
  2. **Recovery phrase (optional, opt-in)** — 24-word BIP-39 phrase runs through Argon2id (256 MiB / opslimit 3) to derive a wrapping key; identity privs are sealed with XChaCha20-Poly1305 and the ciphertext is uploaded to `recovery_blobs`. The phrase never leaves the client. Enter it on a fresh device to restore without a legitimate other device. Forced 3-word verification step on generation catches "I didn't actually write it down" regret.
- **TOFU + key-change banners, not manual safety-number comparison** — chose low friction; WhatsApp's compromise. `tofu.ts` detects changes; banner surfaces them.
- **Email magic link (no password)** — Supabase Auth handles the directory; identity keys are the real trust anchor.
- **Implicit auth flow, not PKCE** — `src/lib/supabase/client.ts` sets `flowType: 'implicit'` so the magic-link token comes back in the URL hash rather than via a code-exchange that needs a verifier in the requesting browser's localStorage. This lets the user request the link in Browser B and open the email in Browser A (or vice-versa) without hitting "PKCE code verifier not found." The email itself remains the trust anchor. If V2 goes SSR-first, switch back to `pkce` with `@supabase/ssr` cookie storage.
- **Text (base64) columns, not bytea** — PostgREST's bytea encoding is quirky and version-dependent; the payloads are already opaque, so text is trivially correct.

## Project layout

```
src/
├── app/                         Next.js 16 App Router pages
│   ├── page.tsx                 Landing + magic-link form
│   ├── auth/callback/page.tsx   Post-magic-link bootstrap (identity gen / publish)
│   ├── link-device/page.tsx     QR show + scan for device linking
│   ├── status/page.tsx          Live 12-check E2EE verification dashboard
│   └── rooms/
│       ├── page.tsx             Rooms list, create, invite, accept
│       └── [id]/page.tsx        Encrypted feed + realtime + member rotate
├── components/
│   ├── AppShell.tsx             Auth-aware header + layout
│   ├── MagicLinkForm.tsx
│   ├── QrShow.tsx / QrScan.tsx
│   ├── KeyChangeBanner.tsx
│   └── StatusCheck.tsx
├── lib/
│   ├── e2ee-core/               ★ APP-AGNOSTIC CRYPTO MODULE (ported into V2)
│   └── supabase/                Typed client + query helpers
supabase/
└── migrations/
    ├── 0001_init.sql                          identities, devices, rooms,
    │                                          room_members, room_invites,
    │                                          blobs, device_link_handoffs
    │                                          + RLS + Realtime publication
    └── 0002_device_approval_and_recovery.sql  device_approval_requests
                                               (code-based device linking)
                                               + recovery_blobs (phrase-
                                               wrapped identity escrow)
```

## Getting started

```bash
cp .env.example .env.local    # fill in Supabase URL + anon key
npm install
npm run dev                   # http://localhost:3000
```

### Supabase project setup (one-time)

1. Create a new project at [supabase.com](https://supabase.com).
2. Settings → API → copy project URL and anon key into `.env.local`.
3. Authentication → Providers → enable Email (leave password optional / unused).
4. Authentication → URL Configuration → add `http://localhost:3000/auth/callback` to allowed redirect URLs.
5. SQL Editor → paste `supabase/migrations/0001_init.sql` → Run. Then paste `supabase/migrations/0002_device_approval_and_recovery.sql` → Run.
6. Database → Replication → ensure Realtime is enabled for `blobs`, `room_invites`, `device_link_handoffs`, `room_members`, and `device_approval_requests` (the migrations attempt to do this automatically).

### Verification walkthrough

After signup:

1. Open `/status` — every row should go green within a few seconds. This proves libsodium, IndexedDB, Supabase auth, RLS, encryption, realtime, and tamper detection are all live.
2. Open the app in a second browser profile (incognito = second user). Sign up with a different email.
3. On user A: Rooms → copy user ID → create a "pair" room → paste B's user ID into invite form → send.
4. On user B: Rooms → accept the invite.
5. Both users: click into the room. Send a message. Watch the other side receive it live.
6. In Supabase Table Editor → `blobs`: confirm the `ciphertext` column is an opaque base64 string you can't read.
7. Remove a member from a group room and confirm `rooms.current_generation` bumps.

## Deploying to Vercel (after local is green)

1. Push to GitHub.
2. Import on Vercel; paste the two env vars.
3. Deploy. Grab the `*.vercel.app` URL.
4. Back in Supabase → Auth → URL Configuration → add that URL + `/auth/callback`.

## Known limitations / future upgrades

- **No Key Transparency yet** — TOFU can be defeated if Supabase is compromised on first contact. Upgrade path: publish a KT log and have clients auto-audit their own keys.
- **No server-side Ed25519 signature verification** — signatures are checked on read. A pgsodium trigger on `blobs.insert` could reject forged writes server-side too. Skipped to keep the prototype portable.
- **Invite by user_id, not email** — inviting by email requires either an RPC function or an email column on `identities`. Left for V2 to choose.
- **No message history beyond the current generation after rotation** — old blobs can still be decrypted by anyone who holds the old key (e.g. the removed member), but new members won't be able to read pre-rotation blobs. This is expected.
- **No file/attachment encryption** — envelope-encrypt blobs in Supabase Storage using the room key; straightforward addition.
- **Single-device crypto ops** — libsodium is WASM in-browser. If V2 adds native mobile, mirror the primitives with the platform's preferred library.
