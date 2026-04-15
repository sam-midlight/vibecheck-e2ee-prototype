# e2ee-core

App-agnostic zero-knowledge encryption primitives used by `vibecheck-e2ee-prototype`. Designed to be **lifted into another Next.js/Supabase app unchanged**. No React, no UI, no domain-specific types.

## Install requirements (host app)

```
libsodium-wrappers-sumo
idb
@scure/bip39
```

Plus a Supabase (or equivalent) layer supplying the tables declared in:

```
../../../supabase/migrations/0001_init.sql                          core schema
../../../supabase/migrations/0002_device_approval_and_recovery.sql  device approval + recovery escrow
```

That is:

```
identities, devices, device_link_handoffs,
rooms, room_members, room_invites, blobs,
device_approval_requests, recovery_blobs
```

## Module map

| File           | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `sodium.ts`    | Lazy libsodium init + byte/base64/hex/UTF-8 helpers    |
| `identity.ts`  | Generate Ed25519 + X25519 keypairs; self-sign; verify; fingerprint |
| `room.ts`      | Room symmetric keys: generate, wrap, unwrap, rotate, zero |
| `blob.ts`      | AEAD encrypt/decrypt a JSON payload + Ed25519 sig      |
| `linking.ts`   | Seal an Identity into a handoff payload (QR OR code approval) |
| `approval.ts`  | 6-digit code generation + salted-SHA256 hashing for device-approval requests |
| `recovery.ts`  | 24-word BIP-39 phrase + Argon2id-wrapped identity escrow |
| `storage.ts`   | IndexedDB: identity, device record, known-contacts TOFU cache |
| `tofu.ts`      | Observe a contact's pubkey; emit key-change events     |
| `types.ts`     | All exported types and the `CryptoError`/`TrustError` classes |
| `index.ts`     | Barrel file that re-exports the public surface         |

## Quick API tour

### Identity

```ts
import {
  generateIdentity, toPublicIdentity, verifySelfSignature,
  signMessage, verifyMessage, publicIdentityFingerprint,
} from '@/lib/e2ee-core';

const identity = await generateIdentity();
const pub      = await toPublicIdentity(identity);
// `pub.selfSignature` is sign(ed_pub||x_pub) with ed_priv. Publish `pub`.
```

### Storage

```ts
import { putIdentity, getIdentity, clearIdentity } from '@/lib/e2ee-core';
await putIdentity(userId, identity);
const stored = await getIdentity(userId); // null if absent
```

### Room keys

```ts
import { generateRoomKey, wrapRoomKeyFor, unwrapRoomKey, rotateRoomKey } from '@/lib/e2ee-core';
const rk       = await generateRoomKey();                  // fresh 32 random bytes
const wrapped  = await wrapRoomKeyFor(rk, member.x25519Pub);
const opened   = await unwrapRoomKey(wrapped, myX25519Pub, myX25519Priv);

// Membership change:
const { next, wraps } = await rotateRoomKey(
  currentGeneration,
  remainingMembers.map(m => m.x25519Pub),
);
```

### Blobs

```ts
import { encryptBlob, decryptBlob } from '@/lib/e2ee-core';

const blob = await encryptBlob({
  payload: { type: 'message', text: 'hi' },
  roomId,
  roomKey,
  senderEd25519PrivateKey: identity.ed25519PrivateKey,
});
// ship {nonce, ciphertext, signature, generation} to the server.

// On receive:
const decoded = await decryptBlob<Payload>({
  blob,
  roomId,
  roomKey,
  senderEd25519PublicKey: senderPubkey,
});
```

Throws `CryptoError`:

- `BAD_GENERATION` — blob's generation doesn't match the supplied room key
- `SIGNATURE_INVALID` — the sender signature failed Ed25519 verify
- `DECRYPT_FAILED` — AEAD tag mismatch (tampered or wrong key)

### Device linking (QR handoff primitives)

```ts
import { buildLinkPayload, sealIdentityForLink, openSealedIdentity } from '@/lib/e2ee-core';

// New device (B):
const linkKeys = await buildLinkPayload();
// display linkKeys.x25519PublicKey + linkKeys.linkNonce in a QR.

// Existing device (A), after scanning:
const sealed = await sealIdentityForLink(aIdentity, bDevicePub);
// POST { link_nonce: bLinkNonce, inviting_user_id: aUserId, sealed_payload: sealed }

// New device (B), after picking up the row:
const identity = await openSealedIdentity(sealedFromServer, linkKeys);
await putIdentity(userId, identity);
```

### Device approval (6-digit code) — `approval.ts`

The app-facing primary onboarding path. No QR needed: B is already authenticated (same email magic-link session), shows a 6-digit code on screen; A enters the code, verifies the salted hash matches, then runs the same `sealIdentityForLink` → `device_link_handoffs` path.

```ts
import { generateApprovalCode, generateApprovalSalt, hashApprovalCode } from '@/lib/e2ee-core';

// B (new device) creates a request:
const code = await generateApprovalCode();            // 6 digits, shown on B's screen
const salt = await generateApprovalSalt();            // 16-byte hex
const codeHash = await hashApprovalCode(code, salt);  // sha256(salt||code), hex
// INSERT into device_approval_requests { linking_pubkey, code_hash, code_salt, link_nonce }

// A (existing device) sees the request via realtime, prompts for the code:
if (await hashApprovalCode(typedByUser, req.code_salt) !== req.code_hash) reject();
const sealed = await sealIdentityForLink(aIdentity, req.linking_pubkey);
// INSERT into device_link_handoffs { link_nonce, inviting_user_id, sealed_payload }
```

Why hash and not store plaintext: defense-in-depth for DB dumps. Real security is the 10-min TTL + single-use — 20 bits of code entropy means no KDF meaningfully slows brute-force.

### Recovery phrase — `recovery.ts`

Opt-in. User writes down a 24-word BIP-39 phrase once; Argon2id over (phrase, salt, user_id) wraps the identity privs; ciphertext goes into `recovery_blobs`. Phrase never leaves the client.

```ts
import {
  generateRecoveryPhrase, isPhraseValid, normalizePhrase, splitPhrase,
  wrapIdentityWithPhrase, unwrapIdentityWithPhrase,
  encodeRecoveryBlob, decodeRecoveryBlob,
} from '@/lib/e2ee-core';

// Setup:
const phrase = generateRecoveryPhrase();
// show to user, require them to verify at least one word back
const blob = await wrapIdentityWithPhrase(identity, phrase, userId);
// UPSERT into recovery_blobs { ...(await encodeRecoveryBlob(blob)) }

// Recovery on a fresh device:
if (!isPhraseValid(typed)) throw new Error('BIP-39 checksum failed — typo?');
const row = await getRecoveryBlob(userId);
const privs = await unwrapIdentityWithPhrase(await decodeRecoveryBlob(row), typed, userId);
// ALWAYS derive pubs from privs and confirm they match the server-published
// pubs in `identities` before installing — guards against a tampered blob.
```

`normalizePhrase` is deliberately lenient: it strips `1.`, `1)`, `(1)`, `1:` prefixes and collapses whitespace, so users can paste directly from a numbered grid. Argon2id parameters (`opslimit`, `memlimit`) are stored per row — honour the stored values at unwrap time so you can raise them for new users without orphaning old phrases.

### TOFU

```ts
import { observeContact, acceptKeyChange, onKeyChange } from '@/lib/e2ee-core';

// Every time you fetch a contact's identity from the server, funnel it through observeContact.
const result = await observeContact(userId, pub);
// result.status is 'new' | 'same' | 'changed'. On 'changed', result.event has details.

// Somewhere in UI (one-time on app mount):
onKeyChange(event => { /* render banner */ });

// When user decides to trust a change:
await acceptKeyChange(userId, pub);
```

## Conventions

- All bytes are `Uint8Array`. Strings crossing the server boundary are URL-safe base64 without padding — use `toBase64()` / `fromBase64()` from `sodium.ts`.
- The module makes exactly one browser assumption: `storage.ts` needs `indexedDB`. Everything else works in any JS env where libsodium loads (in particular, a WebWorker, if you want to move crypto off the main thread later).
- No throwing of plain `Error`s from the module. Callers can discriminate via `CryptoError.code` and `TrustError.code`.

## Porting into another app

1. Copy the `e2ee-core/` folder and both migrations (`0001_init.sql` + `0002_device_approval_and_recovery.sql`) verbatim.
2. Install `libsodium-wrappers-sumo`, `idb`, and `@scure/bip39` in the target app.
3. In the target app, implement a thin data layer equivalent to `src/lib/supabase/queries.ts` (or reuse it). The contract: for every table, a function to insert, fetch, list, delete, and subscribe; all byte columns base64-encoded on the wire.
4. Wire up the flows where the target app needs them:
   - signup → `generateIdentity` + `publishIdentity` + `registerDevice` (and optionally offer recovery-phrase setup).
   - callback → await `supabase.auth.getSession()` first, decide: returning / device-linking-chooser / first-sign-in (see decision tree in `../../docs/port-to-v2.md`).
   - room create → `generateRoomKey` + `wrapRoomKeyFor`.
   - invite → `observeContact` + `wrapRoomKeyFor` → insert `room_invites`.
   - accept → unwrap the invite's wrapped key + re-wrap for self into `room_members`.
   - send → `encryptBlob` + insert into `blobs`.
   - receive → `decryptBlob` on the realtime stream after `observeContact` on the sender.
   - link a second device → approval flow (B creates `device_approval_requests`; A verifies the code + writes `device_link_handoffs`; B reads and opens).
   - recover → phrase-entry UI + `unwrapIdentityWithPhrase` + pub/priv match check before install.
5. Keep the Supabase client on `flowType: 'implicit'` unless the target is SSR-first with `@supabase/ssr` cookie storage. PKCE breaks if the user opens the magic link in a different browser than the one that requested it.
6. Bring across `StatusCheck` / `status/page.tsx` if you want the live verification dashboard in the target app — it's a great regression harness.

None of the e2ee-core functions are specialized to the prototype's schema — they just operate on keys and bytes.
