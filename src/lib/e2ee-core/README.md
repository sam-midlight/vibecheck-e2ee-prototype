# e2ee-core

App-agnostic zero-knowledge encryption primitives used by `vibecheck-e2ee-prototype`. Designed to be **lifted into another Next.js/Supabase app unchanged**. No React, no UI, no domain-specific types.

Current model (v3): Matrix-aligned cross-signing (MSK / SSK / USK) + per-device key bundles + per-sender Megolm ratchet + SAS emoji verification. Older v2/v1 wire formats still verify (backward-compatible reads) but are never produced by new code.

## Install requirements (host app)

```
libsodium-wrappers-sumo
idb
@scure/bip39
```

Plus a Supabase (or equivalent) layer supplying the tables in migrations `0001..latest`. Apply them linearly to a fresh Postgres+Supabase project; the schema is designed to apply in order with no gaps. The critical surface is:

```
identities, devices, device_link_handoffs,
rooms, room_members, room_invites, blobs,
device_approval_requests, recovery_blobs,
key_backup,
megolm_sessions, megolm_session_shares,
cross_user_signatures, sas_verification_sessions,
calls, call_members, call_key_envelopes              (video-call scope — optional)
```

See `docs/port-to-v2.md` §1 for per-migration rationale.

## Module map

| File              | Purpose                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `sodium.ts`       | Lazy libsodium init + byte / base64 / hex / UTF-8 helpers                     |
| `identity.ts`     | Ed25519 + X25519 keypair generation, signing, verification, fingerprints      |
| `device.ts`       | `UserMasterKey` + `DeviceKeyBundle` generation, device issuance + revocation certs (v1 MSK-signed, v2 SSK-signed), chain verification, display-name sealing |
| `cross-signing.ts`| SSK + USK generation, MSK → SSK / USK cross-signatures, full-chain verifier   |
| `sas.ts`          | SAS emoji verification: commitment, shared secret, 7-emoji derivation, MAC exchange, USK cross-user signatures |
| `megolm.ts`       | Per-sender ratchet: outbound session, ratchet + derive, snapshot export / seal / unseal, share signature |
| `blob.ts`         | AEAD encrypt / decrypt + Ed25519 sig. v4 = Megolm; v3 = flat room key + device sig; v2 = user-root sig; v1 = outer-column sig (legacy reads only) |
| `room.ts`         | Room symmetric keys: generate, wrap, unwrap, rotate, zero                     |
| `membership.ts`   | Signed `room_invites` + `room_members` row canonicalization + verify          |
| `linking.ts`      | QR handoff: seal an Identity / device bundle into a handoff payload           |
| `approval.ts`     | 6-digit code generation + salted-SHA256 hashing for device-approval requests  |
| `recovery.ts`     | 24-word BIP-39 phrase + Argon2id-wrapped MSK priv + server-side room-key backup (Matrix key-backup) |
| `pin-lock.ts`     | Passphrase-wrap the local `DeviceKeyBundle` + optional MSK for at-rest lock   |
| `attachment.ts`   | Encrypted image attachments (XChaCha20-Poly1305 under the room key, EXIF-strip via `createImageBitmap`) |
| `call.ts`         | `CallKey` primitive for LiveKit SFrame E2EE: generate, wrap-per-device, sign envelope, verify, zero |
| `storage.ts`      | IndexedDB: device bundle, MSK, SSK, USK, backup key, wrapped identity, known-contacts TOFU cache, outbound + inbound Megolm sessions |
| `tofu.ts`         | Observe a contact's MSK pub; emit key-change events (v3 compares ed25519 only) |
| `types.ts`        | Exported types + `CryptoError` / `TrustError` classes                         |
| `index.ts`        | Barrel re-export of the public surface                                        |

## Key hierarchy (v3 cross-signing)

Five distinct key types. Mixing them up is the most common way to break things.

| Concept               | What it is                                                                 | Who has the priv                                          | What it signs / does                                                                             |
| --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **MasterSigningKey**  | One Ed25519 keypair per user                                               | Recovery blob + original primary only. Stays cold.        | Signs SSK + USK cross-sigs. Never signs device certs directly (that's SSK's job, post-0025).     |
| **SelfSigningKey**    | One Ed25519 keypair per user                                               | Every co-primary device (shared via sealed box on approval). | Signs device issuance + revocation certs (v2 domain).                                         |
| **UserSigningKey**    | One Ed25519 keypair per user                                               | Every co-primary device (shared alongside SSK).           | Signs other users' MSK pubs after SAS verification → `cross_user_signatures`.                    |
| **DeviceKeyBundle**   | Ed25519 + X25519 per device                                                | Each device, locally generated, never copied              | Ed signs blobs, session-shares, membership-op rows. X receives sealed snapshots + room-key wraps.|
| **DeviceCertificate** | Ed25519 signature over `(user_id, device_id, device_ed_pub, device_x_pub, createdAtMs)` | Stored in `devices` row | Proves this device belongs to this user. v2 = SSK-signed (chains `SSK ← MSK cross-sig ← MSK`), v1 = MSK-signed (legacy fallback). |

`identities.ed25519_pub` is the MSK pub — unchanged from the pre-cross-signing UMK pub, so no TOFU break across the 0025 upgrade. `UserMasterKey` is a type alias for `MasterSigningKey` so existing callers keep compiling.

**Verifier rule:** when resolving a device's cert, if `identities.ssk_pub` is populated you MUST call `verifyCrossSigningChain` before trusting an SSK-signed cert. If `ssk_pub` is null (legacy identity), fall back to v1 MSK-signed verification. `verifyPublicDevice(device, mskPub, sskPub?)` handles both.

```ts
import {
  generateUserMasterKey, generateDeviceKeyBundle,
  generateSigningKeys, verifyCrossSigningChain,
  signDeviceIssuanceV2, verifyPublicDevice,
} from '@/lib/e2ee-core';

// Primary onboarding:
const msk    = await generateUserMasterKey();
const bundle = await generateDeviceKeyBundle(deviceId);
const { ssk, usk, sskCrossSignature, uskCrossSignature } = await generateSigningKeys(msk);

// Issue this device's own cert with the SSK.
const sig = await signDeviceIssuanceV2({
  userId, deviceId,
  deviceEd25519PublicKey: bundle.ed25519PublicKey,
  deviceX25519PublicKey:  bundle.x25519PublicKey,
  createdAtMs: Date.now(),
}, ssk.ed25519PrivateKey);

// Peer verifying a device later:
await verifyCrossSigningChain({
  mskPub, sskPub, sskCrossSignature,
  uskPub, uskCrossSignature,
});
await verifyPublicDevice(peerDevice, mskPub, sskPub);
// Throws CERT_INVALID on bad chain or DEVICE_REVOKED on revoked.
```

## Storage

```ts
import {
  putDeviceBundle, getDeviceBundle,
  putUserMasterKey, getUserMasterKey,
  putSelfSigningKey, getSelfSigningKey,
  putUserSigningKey, getUserSigningKey,
  putBackupKey, getBackupKey,
  clearIdentity,
} from '@/lib/e2ee-core';

await putDeviceBundle(userId, bundle);
await putUserMasterKey(userId, msk);             // null on approval-linked secondaries
await putSelfSigningKey(userId, ssk);
await putUserSigningKey(userId, usk);
```

## Blobs

```ts
import { encryptBlob, decryptBlob } from '@/lib/e2ee-core';

const blob = await encryptBlob({
  payload: { type: 'message', text: 'hi' },
  roomId,
  roomKey,                                  // v3 path (flat room key)
  senderUserId, senderDeviceId,
  senderEd25519PrivateKey: bundle.ed25519PrivateKey,
});
// ship {nonce, ciphertext, signature, generation, sessionId?, messageIndex?} to the server.

// On receive:
const decoded = await decryptBlob<Payload>({
  blob,
  roomId,
  roomKey,                                  // OR: messageKey for v4
  senderEd25519PublicKey: senderDevicePub,
});
```

Envelope versions:
- **v4 (Megolm)** — `payload` sealed under a `messageKey` derived from a per-sender ratchet. Envelope carries `sessionId + messageIndex`; the verifier derives the matching key from its inbound snapshot and verifies the device-ed signature inside the AEAD.
- **v3 (flat room key + device sig)** — signature inside AEAD, signed by the sender's device Ed25519 priv; verifier resolves the device via `{senderUserId, senderDeviceId}` in the envelope.
- **v2 (pre-per-device)** — signature inside AEAD but signed by the user's root ed25519 priv. Still decryptable for back-compat.
- **v1 (legacy)** — outer `signature` column on the row. Read-only path.

AD = `room_id bytes || generation(u32 BE)`. Binding AD to `(room, generation)` means replay across rooms or generations fails AEAD. Distinct domain tag per version (`vibecheck:blob:v{2,3,4}`) prevents cross-version confusion.

`CryptoError` codes callers can discriminate on: `BAD_GENERATION`, `SIGNATURE_INVALID`, `DECRYPT_FAILED`, `CERT_INVALID`, `DEVICE_REVOKED`.

## Megolm sessions

Each sender holds one outbound session per `(room_id, generation)`. The chain key ratchets forward on every message; recipients receive a sealed snapshot that lets them derive message keys at any index ≥ `startIndex` but not before. Compromise of `message_key[N]` does NOT reveal `message_key[<N]`.

```ts
import {
  createOutboundSession, ratchetAndDerive, shouldRotateSession,
  exportSessionSnapshot, sealSessionSnapshot, unsealSessionSnapshot,
  deriveMessageKeyAtIndex, signSessionShare, verifySessionShare,
} from '@/lib/e2ee-core';

// Sender side — create + use:
let session = await createOutboundSession(roomId, generation);
const { key, index } = await ratchetAndDerive(session);   // mutates session
if (shouldRotateSession(session)) {                        // >=100 msgs or >=7 days
  session = await createOutboundSession(roomId, generation);
}

// Share to a new recipient device (after verifying their device cert):
const snapshot     = exportSessionSnapshot(session, senderUserId, senderDeviceId);
const sealedBytes  = await sealSessionSnapshot(snapshot, recipientX25519Pub);
const shareSig     = await signSessionShare({
  sessionId: snapshot.sessionId,
  recipientDeviceId,
  sealedSnapshot: sealedBytes,
  signerDeviceId: senderDeviceId,
  signerEd25519Priv: bundle.ed25519PrivateKey,
});
// INSERT INTO megolm_session_shares { session_id, recipient_device_id, sealed_snapshot, start_index, signer_device_id, share_signature }
// Use plain .insert() + swallow 23505 — the RLS+ON CONFLICT trap means .upsert() fails under RLS.

// Recipient side — unseal + derive:
const incoming = await unsealSessionSnapshot(sealedBytes, bundle.x25519PublicKey, bundle.x25519PrivateKey);
await verifySessionShare({ sessionId: incoming.sessionId, recipientDeviceId: myDeviceId,
  sealedSnapshot: sealedBytes, signerDeviceId: incoming.senderDeviceId,
  signature: shareSig, signerEd25519Pub: senderDeviceEdPub });
const messageKey = await deriveMessageKeyAtIndex(incoming, blob.messageIndex!);
```

**Server-side rotation safety net:** migration 0029 installs a trigger that rejects INSERTs into `blobs` whose session has ≥200 messages. The client is authoritative for rotation at 100 — the 100→200 gap accommodates rotation races. Do NOT bypass this by writing directly to the `blobs` table via service-role.

## SAS verification

Interactive emoji-based identity verification between two users (adapted from Matrix MSC1267). On success, each side's USK cross-signs the other's MSK pub → `cross_user_signatures`. Verified contacts get an escalated key-change alert if their MSK ever drifts.

```ts
import {
  generateSasCommitment, verifySasCommitment,
  computeSasSharedSecret, deriveSasEmoji,
  computeSasMac, verifySasMac,
  signUserMsk, verifyUserMskSignature,
} from '@/lib/e2ee-core';

// Alice:
const alice = await generateSasCommitment(aliceDeviceEdPub);  // { ephemeralPub, ephemeralPriv, commitment }
// send { commitment } → Bob  (via sas_verification_sessions row)

// Bob:
const bob = await generateSasCommitment(bobDeviceEdPub);
// send { commitment_bob, ephemeralPub_bob } → Alice

// Alice reveals ephemeralPub, Bob verifies commitment:
await verifySasCommitment(alice.commitment, alice.ephemeralPub, aliceDeviceEdPub);

// Both compute shared + derive emoji:
const shared = await computeSasSharedSecret(alice.ephemeralPriv, bob.ephemeralPub);
const emoji  = await deriveSasEmoji({
  sharedSecret: shared, aliceMskPub, bobMskPub,
  aliceEphemeralPub: alice.ephemeralPub, bobEphemeralPub: bob.ephemeralPub,
});
// show to user → they compare out-of-band. On "match" press → MAC exchange.

const myMac = await computeSasMac({ sharedSecret: shared, ownMskPub: aliceMskPub, ownDeviceEdPub: aliceDeviceEdPub });
// Exchange MACs via the sas_verification_sessions row, then:
await verifySasMac({ sharedSecret: shared, otherMskPub: bobMskPub, otherDeviceEdPub: bobDeviceEdPub, mac: bobMac });

// Both sides cross-sign:
const sig = await signUserMsk({ signerMskPub: aliceMskPub, signedMskPub: bobMskPub, uskPriv: aliceUsk.privateKey, timestamp: Date.now() });
// INSERT into cross_user_signatures { signer_user_id, signed_user_id, signature }
```

Emoji set is 64 animals/plants/symbols in `SAS_EMOJI`. 7 emoji × 6 bits = 42 bits of transcript entropy — attacker must MITM both ephemeral exchanges AND collide a 42-bit preimage in real time. `SAS_EMOJI` is part of the protocol definition; do not reorder without versioning the domain tag.

## Room keys (rotation + approval + backup)

Megolm supersedes flat room keys for blob encryption, but room keys are still used for: wrapping during rotation + approval, encrypted room-name sealing (`encryptRoomName` / `decryptRoomName`), and pair-room bootstrap before the first Megolm session.

```ts
import { generateRoomKey, wrapRoomKeyFor, unwrapRoomKey, rotateRoomKey } from '@/lib/e2ee-core';

const rk      = await generateRoomKey();
const wrapped = await wrapRoomKeyFor(rk, memberDeviceX25519Pub);
const opened  = await unwrapRoomKey(wrapped, myX25519Pub, myX25519Priv);

const { next, wraps } = await rotateRoomKey(currentGeneration, remainingMemberDevices.map(d => d.x25519Pub));
```

## Device linking (QR) — `linking.ts`

Original QR-based secondary-device flow. Kept for back-compat; the prototype uses the approval flow (`approval.ts`) as the primary linking path.

## Device approval (6-digit code) — `approval.ts`

Primary onboarding path for a second device: B is already authenticated via the same magic-link session, shows a 6-digit code; A enters it, verifies the salted hash, then seals the SSK + USK privs to B's X25519 pub via `crypto_box_seal` and writes the ciphertext to `devices.signing_key_wrap`.

**MSK does NOT travel.** Only SSK + USK are sealed. B becomes a co-primary (can approve further devices) but NOT a root primary — it cannot rotate MSK itself. Losing the original primary without a recovery phrase means no further device approvals until one co-primary "promotes" itself via `PromoteDeviceModal` (unwraps MSK from the recovery blob on demand).

```ts
import { generateApprovalCode, generateApprovalSalt, hashApprovalCode } from '@/lib/e2ee-core';

// B (new device) creates a request:
const code = await generateApprovalCode();
const salt = await generateApprovalSalt();
const codeHash = await hashApprovalCode(code, salt, bDeviceX25519Pub, bLinkNonce);
// INSERT into device_approval_requests { linking_pubkey: bDeviceX25519Pub, code_hash, code_salt, link_nonce }

// A (existing device) sees the request, verifies the code, then:
// 1. Signs B's device cert with A's SSK → devices row for B
// 2. Seals (ssk_priv || usk_priv) to B's x25519 pub → devices.signing_key_wrap
// 3. Seals backup_key to B's x25519 pub → devices.backup_key_wrap (so B can restore history)
```

Server RPC `verify_approval_code` enforces a 5-attempt cap; on the 5th miss the row is deleted. Transcript-binding `linking_pubkey + link_nonce` into the hash prevents a row-tampering attacker from swapping `linking_pubkey` for their own without invalidating the hash.

## Recovery phrase — `recovery.ts`

24-word BIP-39 phrase wraps the MSK priv (+ optional backup key) via Argon2id. The phrase never leaves the client. Entering the phrase on a fresh device unwraps both MSK priv and backup key, so history restore fires automatically post-enrollment.

```ts
import {
  generateRecoveryPhrase, isPhraseValid, normalizePhrase,
  wrapUserMasterKeyWithPhrase, unwrapUserMasterKeyWithPhrase,
  encodeRecoveryBlob, decodeRecoveryBlob,
  generateBackupKey,
} from '@/lib/e2ee-core';

// First setup:
const phrase    = generateRecoveryPhrase();
const backupKey = await generateBackupKey();
const blob      = await wrapUserMasterKeyWithPhrase(msk, phrase, userId, { backupKey });
// UPSERT into recovery_blobs { ...(await encodeRecoveryBlob(blob)) }

// Fresh-device recovery:
if (!isPhraseValid(typed)) throw new Error('BIP-39 checksum failed — typo?');
const { ed25519PrivateKey, backupKey: restoredBk } = await unwrapUserMasterKeyWithPhrase(
  await decodeRecoveryBlob(row), typed, userId,
);
// ALWAYS derive pub from ed25519PrivateKey and confirm it matches the server-published
// identities.ed25519_pub before installing — guards against a tampered blob.
```

Blob format:
- **v3 (current):** `[ MSK_priv(64) || backupKey(32) ]` (96 bytes). AD = `vibecheck:recovery:v3:${userId}`.
- **v2 (legacy):** `[ MSK_priv(64) ]` (64 bytes). AD = `vibecheck:recovery:v2:${userId}`.
- `unwrapUserMasterKeyWithPhrase` tries v3 AD first and falls back to v2. New writes always v3.

`normalizePhrase` is lenient — strips `1.`, `1)`, `(1)`, `1:` prefixes and collapses whitespace, so users can paste directly from numbered grids. Argon2id `opslimit` + `memlimit` are stored per row, so you can raise parameters for new users without orphaning old phrases.

## Key backup (Matrix key-backup)

Every room key + Megolm snapshot the user holds is encrypted under the 32-byte `backupKey` and uploaded to `key_backup`. The backup key lives inside the v3 recovery blob, so phrase entry on a fresh device recovers BOTH the MSK priv AND the backup key in one shot.

```ts
import {
  encryptRoomKeyForBackup, decryptRoomKeyFromBackup,
  putBackupKey, getBackupKey,
} from '@/lib/e2ee-core';

const { ciphertext, nonce } = await encryptRoomKeyForBackup({
  roomKey, backupKey, roomId, generation,
});
// UPSERT into key_backup { user_id, room_id, generation, ciphertext, nonce, session_id?, start_index? }
```

AD = `vibecheck:key-backup:v1:${roomId}:${generation}` — distinct from every other AD tag in the app, so a misbehaving server can't swap a key-backup ciphertext for a message or room-name blob.

**Three paths by which a device gets the backup key:**
1. **Primary first-phrase setup** — `generateBackupKey()` in `RecoveryPhraseModal`, stashed via `putBackupKey` + baked into the v3 recovery blob.
2. **New device via recovery phrase** — `unwrapUserMasterKeyWithPhrase` returns `{ ed25519PrivateKey, backupKey }`; callback writes the backup key locally BEFORE `enrollDeviceWithUmk` (so restore logic fires post-enrollment finds it).
3. **New device via approval flow** — A seals the backup key to B's x25519 pub via `crypto_box_seal`, writes to `devices.backup_key_wrap`. B's auth callback reads the row post-enrollment, unseals, calls `putBackupKey`.

A user with no recovery phrase never has a backup key → `key_backup` stays empty → no history restore is possible. That's the correct behaviour: the phrase is the opt-in for server-side backup.

## TOFU — `tofu.ts`

```ts
import { observeContact, acceptKeyChange, onKeyChange } from '@/lib/e2ee-core';

const result = await observeContact(peerUserId, peerMskPub);
// result.status is 'new' | 'same' | 'changed'. On 'changed', result.event has details.
onKeyChange(event => { /* render banner */ });
await acceptKeyChange(peerUserId, newPub);
```

`observeContact` compares **ed25519 (MSK pub) only** in v3. The MSK pub is the stable per-user anchor; the x25519 field is whichever device the contact is acting from right now, and a device switch is NOT a trust event. The cached x25519 is refreshed silently on each sighting. Callers must verify the contact's device cert against their MSK (`verifyPublicDevice` with the chain-verified SSK pub) BEFORE calling `observeContact` — that chain is what makes the silent x refresh safe.

## Conventions

- All bytes are `Uint8Array`. Strings crossing the server boundary are URL-safe base64 without padding — use `toBase64()` / `fromBase64()` from `sodium.ts`.
- One browser assumption: `storage.ts` needs `indexedDB`. Everything else works in any JS env where libsodium loads (including a WebWorker if you want to move crypto off the main thread).
- No plain `Error`s from the module. Callers discriminate via `CryptoError.code` and `TrustError.code`.
- **IndexedDB versioning:** `DB_VERSION = 6` at time of writing. v6 added the Megolm outbound / inbound session stores. Any downstream app that bumps the version must preserve the existing upgrade path — the module's `openDB` calls all migrations idempotently from v0.

## Porting into another app

1. Copy the `e2ee-core/` folder and ALL migrations (`0001..latest`) verbatim. See `docs/port-to-v2.md` §1 for per-migration rationale.
2. Install `libsodium-wrappers-sumo`, `idb`, and `@scure/bip39` in the target app. Also `livekit-client` if porting the video-call surface (migrations 0023 + 0024 + `e2ee-core/call.ts` + `src/lib/livekit/`).
3. In the target app, implement a thin data layer equivalent to `src/lib/supabase/queries.ts` (or reuse it). The contract: for every table, a function to insert, fetch, list, delete, and subscribe; all byte columns base64-encoded on the wire. **Note the RLS + ON CONFLICT trap** — any "sealed row addressed to a peer device" table (`megolm_session_shares`, plausibly future tables) MUST use plain `.insert()` + 23505 swallow, never `.upsert()`. See `docs/port-to-v2.md` §2.
4. Wire up the flows where the target app needs them:
   - **signup** → `generateUserMasterKey` + `generateDeviceKeyBundle` + `generateSigningKeys` + publish MSK/SSK/USK + issue + publish device cert (via `signDeviceIssuanceV2`). Offer recovery-phrase setup.
   - **callback** → await `supabase.auth.getSession()` first, then follow the 5-case decision tree in `docs/port-to-v2.md` §3 (returning / passphrase-locked / new-device chooser / first-sign-in / impossible-state).
   - **room create** → `generateRoomKey` + `wrapRoomKeyFor` (per-device) + seed a fresh Megolm outbound session on first send.
   - **invite** → `observeContact` on invitee's MSK + `verifyPublicDevice` for each of their devices + wrap + `createSignedInvite` (from `membership.ts`) → insert `room_invites`.
   - **accept** → unwrap the invite's wrapped key + re-wrap per this device + insert signed `room_members` row + seal Megolm snapshots from existing senders to the new device.
   - **send** → `ratchetAndDerive` on the outbound session, `encryptBlob` v4, insert into `blobs` (carries `session_id` + `message_index`).
   - **receive** → verify sender's device cert chain, look up inbound snapshot, `deriveMessageKeyAtIndex`, `decryptBlob` v4. Fall through to v3 for flat-key blobs.
   - **link a second device** → approval flow (B creates `device_approval_requests`; A verifies the code + writes the device row with signed cert + `devices.signing_key_wrap` + `devices.backup_key_wrap`; B reads all three, unseals SSK+USK+backup key, calls `putSelfSigningKey`/`putUserSigningKey`/`putBackupKey`).
   - **verify contact** → SAS flow (`sas.ts` + `sas_verification_sessions` row + realtime); on success, `signUserMsk` and insert `cross_user_signatures`.
   - **recover** → phrase-entry UI + `unwrapUserMasterKeyWithPhrase` + pub/priv match check before install + restore `backupKey` locally BEFORE enrolling the new device.
5. Keep the Supabase client on `flowType: 'implicit'` unless the target is SSR-first with `@supabase/ssr` cookie storage. PKCE breaks if the user opens the magic link in a different browser than the one that requested it.
6. Bring across `StatusCheck` / `status/page.tsx` if you want the live verification dashboard — it's a great regression harness. Add one check per E2EE-touching feature the consuming app adds.

None of the e2ee-core functions are specialized to the prototype's schema — they just operate on keys and bytes. The discriminated-union payload type (VibeBlob) and any `zod` validation at the decrypt boundary live in the consuming app, NOT in e2ee-core.
