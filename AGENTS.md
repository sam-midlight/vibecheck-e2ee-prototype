# Agent orientation — read this first

If you're an AI coding assistant working on this repo, the **top 60 lines of this file are load-bearing**. Skim everything here before writing any code or answering architectural questions.

## 1. The framework warning

This is Next.js **16**. Breaking changes vs. what's in most training data — APIs, conventions, file structure. Before generating routing/RSC/caching/middleware code, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices.

## 2. What this project is

A **zero-knowledge E2EE foundation** proving Signal/Matrix-style per-device identity on Supabase + libsodium. The point is to prove the primitives on a minimal prototype so the `src/lib/e2ee-core/` module + `src/lib/bootstrap.ts` + migrations `0001..latest` can be **lifted verbatim** into a consuming app (historically called "V2").

Everything else — the Rooms UI, the status-check page, the magic-link form — is **reference UX**, not load-bearing foundation.

## 3. The critical architectural facts

### v3 per-device identities (the current model)

Each user has **three distinct key types** and mixing them up is the most common way to break this codebase:

| Concept | What it is | Who has the priv | What it signs / does |
|---|---|---|---|
| **UserMasterKey (UMK)** | One Ed25519 keypair per user | Only the primary device (or transiently a recovery-restored device) | Signs device issuance certs + revocation certs. Never encrypts messages. Never wraps room keys. |
| **DeviceKeyBundle** | Ed25519 + X25519 per device | Each device, locally generated, never copied | Ed signs blobs + membership-op rows. X receives sealed room-key wraps. |
| **DeviceCertificate** | UMK signature over `(user_id, device_id, device_ed_pub, device_x_pub, created_at_ms)` | Stored in `devices` table | Proves this device belongs to this user; verifier chains back to UMK. |

**Rules of thumb that must never be violated:**

- Never re-introduce "seal the root identity to a linking pubkey" — that was the v1/v2 device-approval flow and its exfil-the-root footgun is why we went per-device. B-side approval in v3 generates its OWN bundle locally; A signs B's cert; no private keys cross the network.
- Blob signatures are by **device ed25519**, not UMK. Verifiers resolve sender via `{sender_user_id, sender_device_id}` in the v3 envelope, then chain the device's cert to the user's UMK.
- Membership ops (`room_invites`, `room_members`) carry `inviter_device_id` / `signer_device_id` + signatures. Service-role row injection must fail these; clients reject unsigned rows.
- Room keys wrap per-**device**, not per-user. `room_members` PK is `(room_id, device_id, generation)`.

### Enforced invariants (don't regress)

- **PIN-lock is mandatory, not opt-in.** `auth/callback/page.tsx` has a `require-pin-setup` gate between "ready to navigate" and actual navigation. Any new auth flow must also pass through it.
- **Rotation is atomic via `kick_and_rotate` RPC.** Client orchestration of delete → insert → bump was the old model and was replaced because it left zombie states on partial failure. New membership-change logic goes into the RPC, not into a series of client calls.
- **UMK rotation cascades to room rotation.** After `rotateUserMasterKey` we call `rotateAllRoomsIAdmin` so a ghost device can't retain room access. If you add a new "change my keys" flow, it must include the cascade.
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
- `src/components/AppShell.tsx`, `PinSetupModal.tsx`, `RecoveryPhraseModal.tsx`, `RecoveryPhraseEntry.tsx`, `PendingApprovalBanner.tsx`, `KeyChangeBanner.tsx` — stateful UI that encapsulates security invariants (mandatory PIN gate, UMK-rotation cascade, ghost-session boot). Copy as starting point; changing the security semantics inside is risky.

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
