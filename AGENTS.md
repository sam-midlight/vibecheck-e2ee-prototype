# Agent orientation — read this first

If you're an AI coding assistant working on this repo, the **top 60 lines of this file are load-bearing**. Skim everything here before writing any code or answering architectural questions.

## 1. The framework warning

This is Next.js **16**. Breaking changes vs. what's in most training data — APIs, conventions, file structure. Before generating routing/RSC/caching/middleware code, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices.

## 2. What this project is

A **zero-knowledge E2EE foundation** proving Signal/Matrix-style per-device identity on Supabase + libsodium. The point is to prove the primitives on a minimal prototype so the `src/lib/e2ee-core/` module + `src/lib/bootstrap.ts` + migrations `0001..latest` can be **lifted verbatim** into a consuming app (historically called "V2").

Everything else — the Rooms UI, the status-check page, the magic-link form — is **reference UX**, not load-bearing foundation.

## 3. The critical architectural facts

### Cross-signing key hierarchy (Matrix-aligned, current model)

Each user has **five distinct key types**. Mixing them up is the most common way to break this codebase:

| Concept | What it is | Who has the priv | What it signs / does |
|---|---|---|---|
| **MasterSigningKey (MSK)** | One Ed25519 keypair per user | Recovery blob + original primary only. Stays cold. | Signs SSK and USK cross-signatures. Never signs device certs directly (that's SSK's job). `identities.ed25519_pub` is the MSK pub. |
| **SelfSigningKey (SSK)** | One Ed25519 keypair per user | Every co-primary device (shared via sealed box during approval). | Signs device issuance certs (v2 domain) + revocation certs. Day-to-day operational key. |
| **UserSigningKey (USK)** | One Ed25519 keypair per user | Every co-primary device (shared alongside SSK). | Signs other users' MSK pubs after SAS emoji verification. Stored in `cross_user_signatures`. |
| **DeviceKeyBundle** | Ed25519 + X25519 per device | Each device, locally generated, never copied | Ed signs blobs + membership-op rows. X receives sealed room-key wraps. |
| **DeviceCertificate** | SSK signature (v2) or MSK signature (v1, legacy) over `(user_id, device_id, device_ed_pub, device_x_pub, created_at_ms)` | Stored in `devices` table | Proves this device belongs to this user; verifier chains: device cert ← SSK ← MSK cross-sig ← MSK (TOFU anchor). |

**Backward compat:** `UserMasterKey` is a type alias for `MasterSigningKey`. v1 device certs (signed by MSK directly) still verify via fallback. `identities.ed25519_pub` is unchanged (= MSK pub = old UMK pub). No TOFU break.

**Megolm ratchet:** Room messages use per-sender Megolm sessions (v4 blob envelope) with HMAC-SHA256 chain keys. Forward secrecy within a generation. Sessions auto-rotate at 100 messages or 7 days. Server hard-caps at 200 messages (migration 0029 BEFORE-INSERT trigger) and counter is monotonic per `session_id` (migration 0042 BEFORE-UPDATE trigger, closes the direct-UPDATE bypass). Pre-Megolm rooms transition lazily on next generation bump.

**SAS verification:** Interactive emoji-based identity verification between two users. 7 emoji from ephemeral ECDH + HKDF. On success, USK cross-signs peer's MSK pub. Verified contacts get escalated key-change alerts.

**Rules of thumb that must never be violated:**

- **MSK never travels.** SSK+USK are sealed to the new device's X25519 pub during approval (via `devices.signing_key_wrap`). MSK lives only in the recovery blob and on the original primary. Do NOT re-introduce MSK transport.
- Blob signatures are by **device ed25519**, not MSK or SSK. Verifiers resolve sender via `{sender_user_id, sender_device_id}` in the v3/v4 envelope, then chain the device's cert through SSK → MSK.
- Membership ops (`room_invites`, `room_members`) carry `inviter_device_id` / `signer_device_id` + signatures. Service-role row injection must fail these; clients reject unsigned rows.
- Room keys wrap per-**device**, not per-user. `room_members` PK is `(room_id, device_id, generation)`.
- **Megolm sessions are per-sender.** Each sender has an independent outbound session. Compromising one sender's chain key does not reveal other senders' messages.

### Enforced invariants (don't regress)

- **PIN-lock is mandatory, not opt-in.** `auth/callback/page.tsx` has a `require-pin-setup` gate between "ready to navigate" and actual navigation. Any new auth flow must also pass through it.
- **Rotation is atomic via `kick_and_rotate` RPC.** Client orchestration of delete → insert → bump was the old model and was replaced because it left zombie states on partial failure. New membership-change logic goes into the RPC, not into a series of client calls.
- **Rotation / kick is creator-only.** UI: `isAdmin = room.created_by === selfUserId` gates the Rotate button and `rotateNow()`. Server: `kick_and_rotate` authorizes caller as (a) room creator, or (b) leaving themselves. Do not propose broadening to "any member can rotate" without an explicit design discussion.
- **MSK rotation cascades to room rotation.** After `rotateUserMasterKey` we call `rotateAllRoomsIAdmin` so a ghost device can't retain room access. MSK rotation also generates fresh SSK+USK+cross-sigs. If you add a new "change my keys" flow, it must include the cascade.
- **MSK rotation offers a device-trust picker.** `RecoveryPhraseModal`'s rotation path fires `DevicePicker` when ≥2 active devices exist. Unchecked devices get fresh SSK-signed revocations committed atomically with the cert reissuance (`generateRotatedUmk`'s `devicesToRevoke` option → `commitRotatedUmk`'s `revocations` argument). Current device is non-togglable. Do NOT regress to "blindly re-sign every active device" — that's the ghost-retention hole the picker closes.
- **Retention window is 10 generations.** `kick_and_rotate`'s FS purge clause is `generation < new_gen - 9`. Widening or narrowing is a security trade-off; document and discuss before changing.
- **`devices_read_all` must stay public.** Peers need to read each other's device_pubs to wrap room keys. The write policies stay owner-only.

### Temporary dev shortcut (remove before real deploy)

- `src/app/api/dev/magic-link/route.ts` is **unguarded**. Any caller can mint a sign-in link for any email, because the user explicitly accepted this tradeoff for testing with friends on a Vercel preview. Before any real-audience deploy: delete the route + revert `MagicLinkForm.tsx` to call `supabase.auth.signInWithOtp`. See `docs/port-to-v2.md` for the exact revert steps.

## 4. The foundation vs. reference-UX split

**Foundation (copy verbatim into any consuming app):**
- `src/lib/e2ee-core/` — pure crypto, no React, no Supabase. Includes `call.ts` (CallKey primitive for the video-call stack).
- `src/lib/livekit/` — LiveKit SFU adapter + silent JWT renewal loop + QVGA defaults + encryption-error tolerance window + browser-capability check. Peer module to `e2ee-core/`; portable as one directory. Required only if porting video calls (migrations 0023 + 0024).
- `src/lib/bootstrap.ts` — app-glue helpers (requires the Supabase queries layer)
- `src/lib/supabase/queries.ts` — typed data layer; either copy or satisfy the same contract
- `supabase/migrations/0001..latest` — apply linearly to a fresh Postgres+Supabase project
- `supabase/functions/livekit-token/` — Deno edge function that mints 5-min LiveKit JWTs. Required for video calls.
- `public/livekit-e2ee-worker.mjs` — prebuilt LiveKit E2EE worker, kept in sync by `scripts/sync-livekit-worker.mjs`. Required for video calls under Turbopack.
- `src/components/AppShell.tsx`, `PinSetupModal.tsx`, `RecoveryPhraseModal.tsx`, `RecoveryPhraseEntry.tsx`, `PendingApprovalBanner.tsx`, `KeyChangeBanner.tsx`, `PromoteDeviceModal.tsx`, `VerifyContactModal.tsx`, `RespondVerificationModal.tsx`, `IncomingCallToast.tsx` — stateful UI that encapsulates security invariants (mandatory PIN gate, MSK-rotation cascade with ghost-device picker, ghost-session boot, SSK secret sharing, SAS emoji verification with full MAC check, global call notification). Copy as starting point; changing the security semantics inside is risky.
- `src/lib/tab-sync.ts` — `BroadcastChannel`-based cross-tab identity-change signal. Sibling tabs reload on MSK rotation / device revocation / identity nuke so stale in-memory state can't produce failing operations.
- `src/lib/cache-store.ts` — Matrix-aligned local blob cache. Separate `vibecheck-cache` IndexedDB (keeps app cache out of the e2ee-core crypto store). Two stores: `blobCache` (ciphertext `BlobRow` keyed `roomId:blobId`, indexed by `[roomId, createdAt]`) and `roomSyncCursor` (per-room delta-sync watermark). Key invariants: plaintext never persists — only ciphertext rows; `MAX_CACHE_ROWS_PER_ROOM = 500` keeps the per-room footprint bounded; `wipeAppCache()` must be called alongside identity nuke. See §14 in `docs/port-to-v2.md` for the full porting notes.

**Reference UX (feel free to rewrite in the consuming app's design system):**
- `src/app/page.tsx` (magic-link landing)
- `src/app/rooms/**` (rooms list, detail, invite forms, member list, `[id]/call/` for video)
- `src/app/status/page.tsx` (diagnostic probe dashboard — recommended to port as a green-dot regression harness, but the UI style is yours)
- `src/app/settings/page.tsx` (settings surface — reuse the handlers, rewrite the presentation)

## 5. Pointers for deeper questions

- **Crypto primitives + e2ee-core API** — `src/lib/e2ee-core/README.md`
- **Full porting checklist + migration-by-migration rationale** — `docs/port-to-v2.md` (keep this current when you add migrations)
- **High-level README** — `README.md` (human-facing overview)
- **The security evolution of this prototype** — commit log from earliest commits forward is the source of truth; `docs/port-to-v2.md` summarizes the relevant load-bearing bits per migration

## 6. How to work on this with the user

- They expect thorough reasoning on security tradeoffs. "This is a deferred item" is a legitimate answer if the deferred list (`docs/port-to-v2.md`, bottom) already covers it — don't re-propose.
- When the user names a tradeoff explicitly ("I know this is a vulnerability, just ship it"), match that scope. Don't add defensive env-var gates they didn't ask for.
- Never invoke destructive git or Supabase operations without explicit confirmation. Migrations via `mcp__supabase__apply_migration` are OK autonomously once the plan is agreed; that's the one exception (documented in user memory).
- Next.js version-check every page/layout/middleware change against `node_modules/next/dist/docs/`.
