# e2ee-core targeted security audit — 2026-04-20

Scope: every file in `src/lib/e2ee-core/` plus the last 10 commits touching that
directory. Brief: critical vulnerabilities specifically related to
(1) key leakage, (2) signature verification failing open,
(3) state race conditions during atomic key rotations.

**Result: no critical vulnerabilities found in the three categories.**

Post-audit fixes from commit `8045338` (2026-04-18) are in place:
`u64BE` uses `BigInt.asUintN(64, BigInt(Math.trunc(n)))` at
`membership.ts:49`, `device.ts:47`, `sas.ts:189`; `verifyMembershipWrap` is
available for callers at `membership.ts:145-152`.

---

## 1) Key leakage — no critical findings

- No Ed25519/X25519 private bytes are written to `console.*` anywhere in
  the module; only error objects are logged (`tofu.ts:70,79`).
- Recovery blobs wrap keys under Argon2id + XChaCha20-Poly1305 with
  versioned, user-bound AD (`recovery.ts:88-95,150-169`).
- PIN-lock uses identical Argon2id params and versioned AD
  (`pin-lock.ts:66-73,130,143-155`).
- `sodium.memzero` is called on transient buffers after slices are taken:
  `linking.ts:89`, `pin-lock.ts:154,207,216`, `recovery.ts:170,173,228,256,350,393`,
  `megolm.ts:135,185,189,216,221,264,295`, `room.ts:131,161`,
  `blob.ts:202,212,265,275,395,399,460,493,529`.
  `Uint8Array.slice()` copies, so the returned keys are preserved while the
  source buffer is zeroed — correct.

Non-critical note: `storage.ts:161-168` persists the device bundle in
plaintext IndexedDB unless PIN-lock is enabled. Enforcement lives at a
higher layer (`auth/callback/page.tsx`) per CLAUDE.md — a documented trust
boundary, not a leak inside the module.

## 2) Signature verification — no fail-open

All verify paths fail closed. `identity.ts:83-94` (`verifyMessage`) catches
libsodium exceptions and returns `false`; every caller throws on `!ok`:

- `blob.ts:390-393, 455-458, 488-491, 519-522` — v4/v3/v2/v1 throw
  `SIGNATURE_INVALID`.
- `identity.ts:104-109` (`verifyMessageOrThrow`) — throws.
- `membership.ts:108,151`, `call.ts:192`, `sas.ts:231-247`,
  `cross-signing.ts:59-72,92-106` — all route through `verifyMessageOrThrow`.

v2→v1 device-cert fallback (`device.ts:150-180, 230-260`) is safe: each
path requires a valid cryptographic signature under its own domain tag
(`CERT_DOMAIN_V1` vs `CERT_DOMAIN_V2`), and the outer catch re-throws as
`CERT_INVALID` if both fail.

Caller-resolver trust boundary (by design): `blob.ts:436-442,377-383` and
`call.ts:170-193` delegate device-cert-chain validation to the caller's
`SenderKeyResolver` (`blob.ts:305-308`, `call.ts:182-185`). Worth noting
because a resolver that forgets to run `verifyPublicDevice` against the
user's MSK would accept any pubkey the server returned — but this is a
documented contract, not a bug in e2ee-core.

Non-critical note: `device.ts:164-166, 244-246` use blanket `catch { }`
around v2 verification. If v2 threw a non-`CryptoError` (e.g., WASM init
failure), the fallback would mask the message. v1 would fail the same
way and throw `CERT_INVALID`, so fail-closed holds; only error fidelity
is lost.

## 3) State race conditions on atomic key rotations — one observation, not critical

Rotation atomicity is delegated to the `kick_and_rotate` RPC server-side
(per CLAUDE.md). e2ee-core does client-side wrap/sign only.

Megolm outbound-session race (`megolm.ts:121-139`, `ratchetAndDerive`):
reads `session.messageIndex`/`chainKey`, awaits two HMACs, then mutates in
place. Two concurrent await-interleaved callers sharing the same session
reference could both derive the same `messageIndex` before either advances.

Why it is not critical:
- XChaCha20-Poly1305 uses a random 24-byte nonce per message
  (`blob.ts:248`); duplicated `messageKey` is not keystream reuse.
- Migration 0029 enforces `(session_id, message_index)` uniqueness server-side.
- Commit `e1ebc899` added `loadAll` serialization guards at the caller
  layer precisely to close these interleavings.

Hardening candidate: `ratchetAndDerive` could take an internal mutex to
remove the responsibility from callers.

Pin-lock unwrap ordering (`pin-lock.ts:192-205`): strictly sequential
(v3 AD then v2 AD), no race.

TOFU observation race (`tofu.ts:95-168`): `getKnownContact` → compare →
`putKnownContact` is non-transactional. Worst case: duplicate
`emitKeyChange` calls, already mitigated by the module-level `emittedFor`
dedupe map (`tofu.ts:51,149-153`). No trust regression.

---

## Verified post-audit fixes in place (commit `8045338`, 2026-04-18)

- `u64BE` timestamp encoding uses `BigInt.asUintN(64, BigInt(Math.trunc(n)))`
  at `membership.ts:49`, `device.ts:47`, `sas.ts:189`, closing the ToInt32
  truncation that left 64-bit timestamps 32-bit-bound under Ed25519 signatures.
- Wrap-signature verification primitive available at
  `membership.ts:145-152` for callers at the queries layer.

## Items worth tracking (hardening, not live breaks)

1. `ratchetAndDerive` lacks an internal mutex; correctness currently relies
   on caller-side serialization plus server uniqueness constraints.
2. `SenderKeyResolver` contract is implicit — foundation ports must verify
   `PublicDevice` cert chains before handing a pubkey back.
3. `device.ts` blanket `catch { }` around v2 verification masks non-crypto
   exceptions; replace with a narrower `catch (e) { if (e instanceof
   CryptoError && e.code === 'SIGNATURE_INVALID') …}` for clearer diagnostics.
