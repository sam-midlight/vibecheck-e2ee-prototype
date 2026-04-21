# vibecheck-e2ee

A standalone real-time rooms/messaging + video-calling app built on a **zero-knowledge, per-device E2EE foundation**. Next.js 16 + Supabase + `libsodium-wrappers-sumo` + LiveKit. The crypto core (`src/lib/e2ee-core/`), LiveKit adapter (`src/lib/livekit/`), bootstrap glue (`src/lib/bootstrap.ts`), and migrations are designed to be **lifted wholesale into any downstream E2EE app** — Matrix-aligned cross-signing and per-sender Megolm ratchet on a Supabase backend, ready to reuse.

The reference UX layered on top is now a **fully-fleshed-out couples / shared-space app**: per-room features for Dates, Date Night, Safe Space, Love Tank, Gratitude, Wishlist, Mind Reader, Time Capsules, Memory Bank/Jar, Bribes, Roulette, Sunday rituals, and homework-style nudges — every event still flows through the same encrypted-blob primitive, so the foundation is exercised end-to-end. Treat the feature components as a worked example: rewrite the look-and-feel for your app, but read them first to see what calling into `e2ee-core` looks like in practice.

- **Agent onboarding (read first if you're an AI):** `AGENTS.md`
- **e2ee-core API reference:** `src/lib/e2ee-core/README.md`

---

## Architecture at a glance

```
┌──────────────────────────── User account ────────────────────────────┐
│                                                                      │
│  MasterSigningKey (MSK) — Ed25519                                    │
│  ├── Signs: SSK + USK cross-signatures                               │
│  ├── Never signs device certs directly                               │
│  ├── Private half: lives on original primary + (encrypted) in        │
│  │   recovery_blobs; NEVER transmitted in usable form                │
│  └── Wrapped by: 24-word BIP-39 phrase (Argon2id) + Passphrase lock  │
│                                                                      │
│  SelfSigningKey (SSK) + UserSigningKey (USK) — Ed25519 each          │
│  ├── SSK signs device issuance + revocation certs                    │
│  ├── USK signs other users' MSK pubs after SAS verification          │
│  └── Both sealed to each co-primary device via crypto_box_seal       │
│                                                                      │
│  N Device Key Bundles (one per device)                               │
│  ├── Ed25519 — signs blobs, membership ops, Megolm session shares    │
│  ├── X25519  — receives sealed room-key wraps + Megolm snapshots     │
│  ├── Private halves: generated locally; NEVER leave the device       │
│  └── Trust chain: device cert ← SSK ← MSK cross-sig ← MSK            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Per-room, per-generation:
  • Room symmetric key (32 bytes, XChaCha20-Poly1305) — used for
    attachments, sealed room names, bootstrap wrapping
  • Wrapped per-DEVICE via crypto_box_seal to each device.x25519_pub
  • Rotation: admin creates new gen, re-wraps for every current member's
    devices, atomic via kick_and_rotate RPC (purges rows < new_gen - 9)
  • Also uploaded to key_backup encrypted under a per-user backup key
    (escrowed in the recovery blob; sealed to new devices on approval)

Per-sender, per-(room, generation):
  • Megolm outbound session with HMAC-SHA256 chain key
  • Ratchets forward on every message
  • Auto-rotates at 100 msgs / 7 days; server hard-cap 200 msgs
  • Snapshot sealed per-recipient-device via crypto_box_seal
```

### Blob wire format

```
blobs row:
  { sender_id, sender_device_id, generation, nonce, ciphertext,
    session_id?, message_index? }

AEAD plaintext (JSON envelope, v4 — Megolm):
  { v: 4, s: sender_user_id, sd: sender_device_id, sid: session_id,
    mi: message_index, sig: <base64>, p: <payload> }
  • sig = sign(domain || room_id || session_id || message_index
              || nonce || payloadBytes, sender_device_ed_priv)
  • Verifier: resolve device via {sender_id, sender_device_id},
    chain-verify cert (SSK → MSK), derive message_key from inbound
    Megolm snapshot at index, AEAD-decrypt, verify sig.

AEAD AD:
  • v4 = room_id(16) || session_id(32) || message_index(4 BE).
    Binding to (room, session, index) means replay fails.
  • v3 = room_id(16) || generation(4 BE). Binding to (room, gen)
    means replay across rooms / generations fails.
```

## Trust model

| Attacker | Outcome |
|---|---|
| Supabase operator (curious) | Sees routing metadata (who posted to which room when). Cannot decrypt; cannot forge writes that verify. |
| Supabase operator (row-mutating, service_role leak, SQL injection) | Cannot add a "ghost device" — missing SSK signature (chained to MSK) fails every client's `verifyPublicDevice`. Cannot impersonate an inviter — signed envelope fails on accept. Cannot bypass Megolm 200-cap or rewind a session counter — BEFORE-INSERT / BEFORE-UPDATE triggers reject. |
| Compromised secondary device | Attacker has THAT device's bundle + SSK + USK. Cannot sign cross-sigs (no MSK). Next MSK rotation with device-trust picker evicts them; explicit revocation evicts them instantly. |
| Compromised primary device (MSK priv exfiltrated) | Full account takeover until user rotates MSK. Mitigation: Settings → "Rotate & generate new phrase" signs a fresh MSK + SSK + USK + new phrase, optionally revokes ghost devices via the picker, and cascades room-key rotation on every admin-owned room. |
| Attacker with mailbox, no phrase | Signs in, hits device-linking-chooser, needs either a 6-digit approval code from an existing device OR the phrase. Cannot enroll unilaterally. |
| Attacker with mailbox + phrase | Account compromise. Phrase is a standalone credential by design — store it offline. |
| Removed group member | Row deleted at kick time; excluded from new gen immediately. Cached past-gen keys stay decryptable on their device. `< new_gen - 9` wraps are server-purged so fresh sessions can't rebuild them. |
| Stolen unlocked device (no passphrase set) | Full access to this device's room memberships. Mitigation: passphrase lock is enforced as default — any newly-enrolled device must set one before reaching `/rooms`. |
| Stolen locked device | Argon2id (opslimit 3 / memlimit 256 MiB) protects the wrapped bundle. Attacker must brute-force the passphrase offline. |
| Server-side abuse scanning / CSAM detection | Impossible by design. Images are client-re-encoded (EXIF stripped), AEAD-encrypted under room key bound to `{room_id, blob_id, generation}`, stored as opaque bytes. |
| Unverified contact MSK swap | TOFU alerts the user on MSK change. SAS-verified contacts get an escalated alert because their USK-cross-signature breaks. |

## Core design choices

- **Matrix-aligned cross-signing** (MSK / SSK / USK) with per-device key bundles. Device compromise scopes to one device + SSK/USK; MSK stays cold.
- **Per-sender Megolm ratchet** for forward secrecy within a generation. Compromise of `message_key[N]` does not reveal `message_key[<N]`.
- **`libsodium-wrappers-sumo`** — Argon2id + `crypto_box_seal` + XChaCha20-Poly1305 in one audited library.
- **XChaCha20-Poly1305 AEAD** — random 24-byte nonce is safe without state.
- **Sealed-box wrapping** (`crypto_box_seal`) for room keys + Megolm snapshots + SSK+USK + backup key.
- **Per-generation shared room key** with 10-generation retention + aggressive server-side purge of older wraps.
- **Atomic `kick_and_rotate` RPC** — evictee delete + new-gen wraps + gen bump + stale-invite purge + FS purge in one SECURITY DEFINER transaction. Conditional `current_generation = old_gen` guard rejects concurrent rotations.
- **Transcript-bound 6-digit approval code** — `hash = SHA-256(domain || salt || code || linking_pubkey || link_nonce)` + server-side `verify_approval_code` RPC with 5-attempt limit and 2-minute TTL.
- **Mandatory PIN-lock** — first sign-in / first unlock / first enrollment all pass through `require-pin-setup`. Identity is Argon2id-wrapped in IndexedDB.
- **Crash-safe MSK rotation** — new recovery blob persists BEFORE the new MSK pub is published. A browser crash mid-rotation leaves the user recoverable via phrase instead of locked out.
- **MSK rotation cascades to room rotation** and offers a **device-trust picker** to revoke ghost devices atomically with cert reissuance.
- **Server-side room-key backup (Matrix-style)** — per-user backup key (escrowed in the recovery blob; sealed to new devices via `devices.backup_key_wrap`) encrypts every room key + Megolm snapshot into `key_backup`. New devices restore full history.
- **SAS emoji verification** — 7 emoji from ephemeral ECDH + HKDF; on success, USK cross-signs peer's MSK pub in `cross_user_signatures`.
- **Implicit auth flow, not PKCE** — `src/lib/supabase/client.ts` uses `flowType: 'implicit'`. Magic link comes back in URL hash rather than needing a verifier stored in the requesting browser. Users can request in Browser B and open the email in Browser A.
- **E2EE video calls via LiveKit SFrame** — `CallKey` primitive wraps per-device; LiveKit SFU sees only opaque SFrame-encrypted media.

## Project layout

```
src/
├── app/
│   ├── page.tsx                          Landing + magic-link form
│   ├── auth/callback/page.tsx            Identity bootstrap, approval,
│   │                                     recovery, unlock, enforce-PIN gate
│   ├── api/dev/magic-link/route.ts       ⚠ TEMP dev shortcut
│   ├── onboarding/page.tsx               First-time name capture +
│   │                                     create-room / accept-invite step
│   ├── rooms/page.tsx                    Rooms list + create + invite
│   ├── rooms/[id]/page.tsx               Room detail, messages, rotate,
│   │                                     in-room invite, nicknames, plus
│   │                                     feature surfaces (dates, safe
│   │                                     space, love tank, gratitude, …)
│   ├── rooms/[id]/call/                  E2EE video call (LiveKit SFrame)
│   ├── rooms/[id]/{date-night,dates/
│   │   [dateId],safe-space,sunday,
│   │   report}/                          Per-feature sub-routes
│   ├── invites/page.tsx                  Pending-invites inbox
│   ├── about/page.tsx                    User-facing tour + privacy explainer
│   ├── settings/page.tsx                 Safety number, recovery phrase,
│   │                                     device list + revoke, PIN-lock,
│   │                                     SAS verification launch, dev mode
│   ├── status/page.tsx                   Diagnostic dashboard (dev-mode only)
│   └── loaders/page.tsx                  Internal loader-variant gallery
├── components/                           Foundation security UI (AppShell,
│                                         PinSetupModal, RecoveryPhraseModal,
│                                         PromoteDeviceModal, VerifyContact-
│                                         Modal, IncomingCallToast, KeyChange-
│                                         Banner, PendingApprovalBanner, …)
│                                         + reference feature UX (Dates,
│                                         DateVault, SafeSpace, SafeSpace-
│                                         Lantern, LoveTank, Gratitude,
│                                         Wishlist, MindReader, TimeCapsules,
│                                         MemoryBank, MemoryJar, Roulette,
│                                         BribeForm, MemberVibePopover,
│                                         OrbActionMenu, FeatureLauncher,
│                                         FeatureSheet, HomeworkBanner,
│                                         ConfettiBurst, DateGeneratorWidget,
│                                         DateNightPortal, …)
├── lib/
│   ├── e2ee-core/                        ★ Pure crypto — copy verbatim
│   │   ├── device.ts                     MSK + DeviceKeyBundle + certs
│   │   ├── cross-signing.ts              SSK + USK + cross-sig chain
│   │   ├── sas.ts                        SAS emoji verification
│   │   ├── megolm.ts                     Per-sender ratchet
│   │   ├── membership.ts                 Invite + wrap signatures
│   │   ├── blob.ts                       v4 Megolm / v3 flat-key envelope
│   │   ├── room.ts                       Keygen, wrap, unwrap, rotate
│   │   ├── pin-lock.ts                   Argon2id-wrapped device state
│   │   ├── recovery.ts                   BIP-39 phrase wraps MSK priv
│   │   ├── attachment.ts                 Image re-encode + AEAD
│   │   ├── approval.ts                   6-digit code hash
│   │   ├── linking.ts                    QR handoff
│   │   ├── call.ts                       CallKey primitive (LiveKit E2EE)
│   │   ├── storage.ts                    IndexedDB for device/MSK/SSK/USK/...
│   │   ├── tofu.ts                       MSK-pub change detection
│   │   ├── identity.ts                   Sign/verify primitives
│   │   └── sodium.ts                     Lazy libsodium init + encoders
│   ├── livekit/                          ★ LiveKit SFU adapter (video)
│   ├── bootstrap.ts                      ★ App-glue helpers
│   ├── cache-store.ts                    Ciphertext blob cache + cursor
│   ├── tab-sync.ts                       BroadcastChannel identity signal
│   └── supabase/                         Client + typed queries
supabase/
├── migrations/                           Linear SQL schema
└── functions/
    └── livekit-token/                    Deno edge fn — 5-min JWTs
public/
└── livekit-e2ee-worker.mjs               Prebuilt LiveKit E2EE worker
```

## Getting started

```bash
cp .env.example .env.local    # fill NEXT_PUBLIC_SUPABASE_URL + ANON_KEY
npm install
npm run dev                   # http://localhost:3000
```

### Supabase setup (one-time)

1. Create a project at [supabase.com](https://supabase.com).
2. Settings → API → copy URL + anon key to `.env.local`. For the dev magic-link shortcut, also copy `service_role` to `SUPABASE_SERVICE_ROLE_KEY` — server-only env var, never bundle to browser.
3. Auth → Providers → enable Email.
4. Auth → URL Configuration → add `http://localhost:3000/auth/callback` to redirect allow-list.
5. SQL Editor → apply each file in `supabase/migrations/` in order. (Or use `supabase db push`.)
6. Database → Replication → migrations auto-add these tables to `supabase_realtime`: `blobs`, `room_invites`, `device_link_handoffs`, `device_approval_requests`, `rooms`, `calls`, `sas_verification_sessions`, `cross_user_signatures`, `key_forward_requests`, `megolm_session_shares`. Intentionally NOT published (scoped per-device / too chatty): `room_members`, `call_members`, `call_key_envelopes` — clients fetch these lazily on a generation-bump signal.
7. For video calls, deploy `supabase/functions/livekit-token/` and configure LiveKit host/API-key secrets.

### Verification walkthrough

1. `/status` — every check green within a few seconds.
2. Open the app in a second browser profile. Sign up with a different email.
3. User A: Rooms → copy user ID → create a "pair" room → paste B's user ID → send invite.
4. User B: Rooms → accept invite (safety-number shown at accept time).
5. Both users → open the room. Send a message. Realtime delivery.
6. Supabase Table Editor → `blobs` → ciphertext is opaque base64.
7. Settings → "Your safety number" matches between the two browsers.
8. Settings → verify contact via SAS emoji flow.
9. Kick a member → `rooms.current_generation` bumps.
10. Open any feature surface (Dates, Safe Space, Love Tank, Wishlist, …) → write something → confirm in the Supabase Table Editor that the corresponding `blobs` row is opaque ciphertext, not readable JSON.

## Testing

Three layers, each documented under `docs/`:

- **`docs/test-catalog.md`** — one-sentence-per-test reference for every script in `scripts/test-*.ts`, organized by the invariant defended. **79 tests** covering crypto primitives, RLS, Megolm ratchet behaviour, room-key rotation, identity/cross-signing, PIN-lock, video-call key wrap, and the per-feature attribution canaries from the Phase 4 ports.
- **`docs/integration-tests.md`** — the same suite organized as a 7-stage progression from happy-path through adversarial cases up to feature-layer event invariants.
- **`docs/mutation-testing-plan.md`** — **16 mutations** that deliberately weaken security-critical code. The runner (`scripts/run-mutations.ts`) applies each, confirms the kill-list tests fail, restores, and confirms they pass again. A test that doesn't catch the mutation it's supposed to catch is a coverage gap.

```bash
# Run a single test
npx tsx --env-file=.env.local scripts/test-happy-path.ts

# Run all mutations end-to-end (~15 min)
npx tsx --env-file=.env.local scripts/run-mutations.ts

# Run a single mutation by id
npx tsx --env-file=.env.local scripts/run-mutations.ts --only M16
```

## Deploying to Vercel (test/preview only today)

1. Push to GitHub.
2. Import on Vercel; set env vars.
3. Deploy. Add the `*.vercel.app/auth/callback` URL to Supabase redirect allow-list.

**⚠ `src/app/api/dev/magic-link/route.ts` is an unguarded server endpoint** that generates magic links for any email via service-role key. Intentional for today's friends-testing. **Before any real-audience deploy**: delete that file and revert `src/components/MagicLinkForm.tsx` to `supabase.auth.signInWithOtp`.

## Known limitations

- **No PAKE** for device approval — transcript-bound hash closes the active attack; CPace/OPAQUE is the textbook fix.
- **No full Sealed Sender** — signature lives inside AEAD but `sender_id` column is still visible to the server.
- **No traffic padding** — ciphertext length reflects plaintext length.
- **No WebCrypto non-extractable keys** — byte-oriented libsodium is the bottleneck.
- **No Key Transparency log** — TOFU + SAS is the anchor; a KT log would let clients auto-audit.
- **Single-device crypto ops (web only)** — for native mobile, mirror the primitives against the platform's preferred library.
