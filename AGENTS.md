# Agent orientation — read this first

If you're an AI coding assistant working on this repo, read this whole file before writing code or answering architectural questions.

## 1. The framework warning

This is Next.js **16**. Before generating routing/RSC/caching/middleware code, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices.

## 2. What this project is

A **zero-knowledge E2EE foundation**: Signal/Matrix-style per-device identity on Supabase + libsodium. `src/lib/e2ee-core/` + `src/lib/bootstrap.ts` + `src/lib/livekit/` + `supabase/migrations/` are the portable foundation. The Rooms UI, status page, and magic-link form are **reference UX**, not load-bearing foundation.

## 3. The critical architectural facts

### Cross-signing key hierarchy (Matrix-aligned)

Each user has **five distinct key types**. Mixing them up is the most common way to break this codebase:

| Concept | What it is | Who has the priv | What it signs / does |
|---|---|---|---|
| **MasterSigningKey (MSK)** | One Ed25519 keypair per user | Recovery blob + original primary only. Stays cold. | Signs SSK and USK cross-signatures. Never signs device certs directly. `identities.ed25519_pub` is the MSK pub. |
| **SelfSigningKey (SSK)** | One Ed25519 keypair per user | Every co-primary device (shared via sealed box during approval). | Signs device issuance certs + revocation certs. Day-to-day operational key. |
| **UserSigningKey (USK)** | One Ed25519 keypair per user | Every co-primary device (shared alongside SSK). | Signs other users' MSK pubs after SAS emoji verification. Stored in `cross_user_signatures`. |
| **DeviceKeyBundle** | Ed25519 + X25519 per device | Each device, locally generated, never copied | Ed signs blobs + membership-op rows. X receives sealed room-key wraps. |
| **DeviceCertificate** | SSK signature over `(user_id, device_id, device_ed_pub, device_x_pub, created_at_ms)` | Stored in `devices` table | Proves this device belongs to this user. Chain: device cert ← SSK ← MSK cross-sig ← MSK (TOFU anchor). |

**Megolm ratchet:** Room messages use per-sender Megolm sessions with HMAC-SHA256 chain keys. Forward secrecy within a generation. Sessions auto-rotate at 100 messages or 7 days. Server hard-caps at 200 messages via BEFORE-INSERT trigger on `blobs`; counter is monotonic per `session_id` via BEFORE-UPDATE trigger on `megolm_sessions`.

**SAS verification:** Interactive emoji-based identity verification between two users. 7 emoji from ephemeral ECDH + HKDF. On success, USK cross-signs peer's MSK pub. Verified contacts get escalated key-change alerts.

**Rules of thumb that must never be violated:**

- **MSK never travels.** SSK+USK are sealed to the new device's X25519 pub during approval (via `devices.signing_key_wrap`). MSK lives only in the recovery blob and on the original primary. Do NOT re-introduce MSK transport.
- Blob signatures are by **device ed25519**, not MSK or SSK. Verifiers resolve sender via `{sender_user_id, sender_device_id}` in the envelope, then chain the device's cert through SSK → MSK.
- Membership ops (`room_invites`, `room_members`) carry `inviter_device_id` / `signer_device_id` + signatures. Service-role row injection must fail these; clients reject unsigned rows.
- Room keys wrap per-**device**, not per-user. `room_members` PK is `(room_id, device_id, generation)`.
- **Megolm sessions are per-sender.** Each sender has an independent outbound session. Compromising one sender's chain key does not reveal other senders' messages.

### Enforced invariants (don't regress)

- **PIN-lock is mandatory, not opt-in.** `auth/callback/page.tsx` has a `require-pin-setup` gate between "ready to navigate" and actual navigation. Any new auth flow must also pass through it.
- **Rotation is atomic via `kick_and_rotate` RPC.** Membership-change logic goes into the RPC, not into a series of client calls.
- **Rotation / kick is creator-only.** UI: `isAdmin = room.created_by === selfUserId` gates the Rotate button and `rotateNow()`. Server: `kick_and_rotate` authorizes caller as (a) room creator, or (b) leaving themselves. Do not propose broadening.
- **`rooms` invariant columns are RPC-only.** Migration `0047` column-grants authenticated UPDATE to `name_ciphertext`, `name_nonce`, `parent_room_id` only. `created_by`, `current_generation`, `last_rotated_at`, `kind` are writable solely by SECURITY DEFINER RPCs (`kick_and_rotate`) via table-owner bypass. Re-granting UPDATE on these re-opens the creator-takeover chain (any member → `UPDATE rooms SET created_by = auth.uid()` → `kick_and_rotate` auths them as creator).
- **MSK rotation cascades to room rotation.** After `rotateUserMasterKey` we call `rotateAllRoomsIAdmin` so a ghost device can't retain room access. MSK rotation also generates fresh SSK+USK+cross-sigs. Any new "change my keys" flow must include the cascade.
- **MSK rotation offers a device-trust picker.** `RecoveryPhraseModal`'s rotation path fires `DevicePicker` when ≥2 active devices exist. Unchecked devices get fresh SSK-signed revocations committed atomically with the cert reissuance. Current device is non-togglable.
- **Retention window is 10 generations.** `kick_and_rotate`'s FS purge clause is `generation < new_gen - 9`. Changing this is a security trade-off — discuss first.
- **`devices_read_all` must stay public.** Peers need to read each other's device_pubs to wrap room keys. Write policies stay owner-only.

### Temporary dev shortcut (remove before real deploy)

- `src/app/api/dev/magic-link/route.ts` is **unguarded**: any caller can mint a sign-in link for any email. Intentional for friends-testing. Before any real-audience deploy: delete the route + revert `MagicLinkForm.tsx` to call `supabase.auth.signInWithOtp`.

## 4. The foundation vs. reference-UX split

**Foundation (copy verbatim into any consuming app):**
- `src/lib/e2ee-core/` — pure crypto, no React, no Supabase. Includes `call.ts` (CallKey primitive for video calls).
- `src/lib/livekit/` — LiveKit SFU adapter + silent JWT renewal + QVGA defaults + encryption-error tolerance window + browser-capability check. Required only for video calls.
- `src/lib/bootstrap.ts` — app-glue helpers (requires the Supabase queries layer).
- `src/lib/supabase/queries.ts` — typed data layer; either copy or satisfy the same contract.
- `supabase/migrations/` — apply linearly to a fresh Postgres+Supabase project.
- `supabase/functions/livekit-token/` — Deno edge function that mints 5-min LiveKit JWTs. Required for video calls.
- `public/livekit-e2ee-worker.mjs` — prebuilt LiveKit E2EE worker, kept in sync by `scripts/sync-livekit-worker.mjs`. Required for video calls under Turbopack.
- `src/components/AppShell.tsx`, `PinSetupModal.tsx`, `RecoveryPhraseModal.tsx`, `RecoveryPhraseEntry.tsx`, `PendingApprovalBanner.tsx`, `KeyChangeBanner.tsx`, `PromoteDeviceModal.tsx`, `VerifyContactModal.tsx`, `RespondVerificationModal.tsx`, `IncomingCallToast.tsx` — stateful UI that encapsulates security invariants. Copy as starting point; changing the security semantics inside is risky.
- `src/lib/tab-sync.ts` — `BroadcastChannel`-based cross-tab identity-change signal. Sibling tabs reload on MSK rotation / device revocation / identity nuke.
- `src/lib/cache-store.ts` — local blob cache. Separate `vibecheck-cache` IndexedDB (keeps app cache out of the e2ee-core crypto store). Two stores: `blobCache` (ciphertext `BlobRow` keyed `roomId:blobId`, indexed by `[roomId, createdAt]`) and `roomSyncCursor` (per-room delta-sync watermark). Invariants: plaintext never persists; `MAX_CACHE_ROWS_PER_ROOM = 500`; `wipeAppCache()` fires alongside identity nuke.

**Reference UX (feel free to rewrite in the consuming app's design system):**
- `src/app/page.tsx` (magic-link landing)
- `src/app/onboarding/page.tsx` (first-time name + create-room/accept-invite step)
- `src/app/rooms/**` (rooms list, detail, invite forms, member list, `[id]/call/` for video, plus per-feature sub-routes: `date-night/`, `dates/[dateId]/`, `safe-space/`, `sunday/`, `report/`)
- `src/app/invites/page.tsx` (pending-invites inbox)
- `src/app/about/page.tsx` (user-facing tour + plain-language privacy explainer)
- `src/app/status/page.tsx` (diagnostic dashboard — recommended to port as a regression harness, style is yours)
- `src/app/settings/page.tsx` (settings — reuse the handlers, rewrite the presentation)
- `src/app/loaders/page.tsx` (internal loader-variant gallery — drop entirely if not useful)
- Per-feature components (`Dates`, `DateVault`, `SafeSpace`, `SafeSpaceLantern`, `LoveTank`, `Gratitude`, `Wishlist`, `MindReader`, `TimeCapsules`, `MemoryBank`, `MemoryJar`, `Roulette`, `BribeForm`, `MemberVibePopover`, `OrbActionMenu`, `FeatureLauncher`, `FeatureSheet`, `HomeworkBanner`, `ConfettiBurst`, `DateGeneratorWidget`, `DateNightPortal`, …) — claymorphic UX skin over the foundation. Rewrite freely; **do not re-implement crypto inside them** — they should call into `src/lib/e2ee-core/` + `src/lib/bootstrap.ts` for any blob/key operation.

## 5. Pointers for deeper questions

- **Crypto primitives + e2ee-core API** — `src/lib/e2ee-core/README.md`
- **High-level README** — `README.md`

## 6. How to work on this with the user

- They expect thorough reasoning on security tradeoffs. When the user names a tradeoff explicitly ("I know this is a vulnerability, just ship it"), match that scope. Don't add defensive env-var gates they didn't ask for.
- Never invoke destructive git or Supabase operations without explicit confirmation. Migrations via `mcp__supabase__apply_migration` are OK autonomously once the plan is agreed.
- Next.js version-check every page/layout/middleware change against `node_modules/next/dist/docs/`.
