# Integration Test Catalog

A one-sentence-per-test reference to every script in `scripts/test-*.ts`, organized by the invariant each test defends. Use this as the "what is this test asserting?" lookup when triaging a failure or reasoning about coverage.

**79 tests total.** All run against a live Supabase project:

```
npx tsx --env-file=.env.local scripts/<test-file>.ts
# or the whole suite sequentially:
bash scripts/run-all-tests.sh
```

Required env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Tests are self-cleaning (create users, run assertions, `cleanupUser` in `finally`) and must not run concurrently — they share the DB.

**Note on numbering.** Each file's docstring carries its own "Test N" label. `docs/integration-tests.md` uses a separate T-number scheme that doesn't match the docstrings (e.g. `test-tamper-aead.ts`'s docstring says "Test 6" but the other doc lists it as T02). This catalog uses **filename** as the primary key; where a file has an internal number, it's shown in parentheses for cross-reference. If the two disagree, the docstring in the file is authoritative.

**What is NOT testable from scripts.** Browser-specific concerns — IndexedDB quota/purging, real WebSocket race storms, main-thread blocking on WebCrypto, React/Next.js hydration, split-browser auth — cannot be reproduced in Node. See `docs/mutation-testing-plan.md` §"Tests Not Covered by Code Mutations" for RLS tests that would require a Supabase branch to mutate.

---

## 1. Core cryptographic round-trip

Baseline confidence that the primitives compose correctly in the happy path. A failure here means something fundamental is broken; don't look at Stage 6 tests until these pass.

| File | Asserts |
|---|---|
| test-happy-path.ts | Alice wraps a room key for Bob, encrypts a v3 blob, Bob unwraps + decrypts — plaintext matches. |
| test-multi-device.ts | Alice's two devices both receive individually wrapped copies of the same room key and each decrypts the same blob. |
| test-multi-device-decrypt.ts | Three devices on one user, each with its own wrap, independently unwrap and decrypt the same blob to identical plaintext. |
| test-room-name.ts | `encryptRoomName` / `decryptRoomName` round-trips under the room key; wrong-key attempt fails AEAD binding. |
| test-per-room-key-isolation.ts | Three rooms with independent keys — a blob in room A fails AEAD under room B or C's key (room_id is in the AD). |

## 2. Identity, cert chain, cross-signing, SAS

The five-key hierarchy (MSK/SSK/USK/DeviceEd/DeviceX) and the signatures that chain them. Breaking anything here breaks trust for the whole user.

| File | Asserts |
|---|---|
| test-msk-rotation.ts | New MSK+SSK+USK with fresh cross-sigs; device cert re-signed under new SSK; old blobs still decrypt (room key unchanged). |
| test-msk-rotation-cascade.ts | Ghost-device scenario across 3 rooms: MSK rotation re-signs only the trusted device; each room is rotated excluding the ghost; the ghost's old cert no longer chains to the new SSK. |
| test-cert-chain-verification.ts | MSK→SSK cross-sig, SSK→device cert (v2), and v1 fallback all verify; revocation path breaks chain; tampered sigs throw CERT_INVALID. |
| test-usk-cross-sign.ts | Post-SAS USK signs peer's MSK pub; four negative cases (wrong key, wrong msk, wrong timestamp, wrong signed-pub) all throw CERT_INVALID. |
| test-sas-mac.ts | Full SAS protocol end-to-end: commitment/reveal, X25519 shared secret, 7-emoji derivation, HMAC exchange; commitment mismatch detected, MITM-substituted ephemeral produces diverging emoji, tampered MAC + cross-identity MAC both rejected. |
| test-revoked-device-cert.ts | Revoked-device cert resolves to `DEVICE_REVOKED` in `verifyPublicDevice`; `filterActiveDevices` omits it; wrong SSK pub on verify → CERT_INVALID. |
| test-revocation.ts | Post-revocation forward secrecy: revoked device is kicked and rotated out, new room key wrapped only for active devices, revoked device has no gen-N+1 wrap. |
| test-spoofed-identity.ts | Eve's attempt to insert a device row under Alice's user_id is blocked by RLS; her self-signed cert fails `verifyDeviceIssuance` against Alice's real SSK. |
| test-blob-sender-verification.ts | `decryptBlob` with the correct sender device-ed pub succeeds; with an impostor pub it throws SIGNATURE_INVALID (even though AEAD decryption would have succeeded — the envelope's inner signature catches attribution forgery). |
| test-corrupted-membership-sig.ts | `room_members.wrap_signature` with one byte flipped fails `verifyMembershipWrap` at the client; the original verifies; wrong signer pub also fails. |
| test-identity-epoch-staleness.ts | After MSK rotation bumps `identities.identity_epoch`, an approval request carrying the old epoch is deleted by `verify_approval_code` (returns false). |
| test-approval-epoch-positive.ts | Positive counterpart: a fresh approval request written at the new epoch verifies successfully — confirms the epoch check isn't over-zealous. |
| test-approval-request-expiry.ts | Request with `expires_at` in the past → `verify_approval_code` returns false and deletes the row; includes a clock-skew tripwire (see Notes). |

## 3. Membership, generations, rotation

Rotation bumps a monotonic generation counter and cascades access control. Tests here defend the "can you decrypt what you shouldn't?" invariant across gen boundaries.

| File | Asserts |
|---|---|
| test-wrong-generation.ts | A gen-1 blob's ciphertext fails AEAD under the gen-2 room key (generation is in the AD). |
| test-late-joiner.ts | Bob joins at gen-N — he decrypts gen-N blobs but not gen-(N-1) blobs; no retroactive access. |
| test-rotate-then-cross-decrypt.ts | After `kick_and_rotate`, the evicted user has no gen-N+1 row; remaining members cross-decrypt each other's new-gen messages. |
| test-generation-access-boundary.ts | Bob joining at gen-1 decrypts gen-1 but fails AEAD on gen-0; Alice retains access to gen-0. |
| test-room-name-rotation.ts | Encrypted room name rotates inside `kick_and_rotate` — the gen-1 name ciphertext does not decrypt under the gen-2 key. |
| test-group-churn.ts | Four generations with rolling member adds/evictions; per-generation membership set matches expectation; no zombie rows. |
| test-concurrent-rotation.ts | Two simultaneous `kick_and_rotate` calls on one room — exactly one wins, `current_generation` increments by exactly 1, no split-brain. |
| test-ghost-member.ts | Migration 0040 defence: `kick_and_rotate` rejects a wrap entry pairing Bob's user_id with Alice's device_id (device-ownership mismatch). |
| test-evicted-reinsert-block.ts | Post-eviction Carol cannot re-insert into `room_members` at any generation — all three arms of the INSERT policy fail (no invite, not a current member, not the creator). |
| test-unauthorized-kick-rotate.ts | Bob (member, non-creator) calling `kick_and_rotate` is rejected by the RPC's creator-only check. |
| test-membership-row-replay.ts | Inserting a gen-1 row with `generation=2` fails; replaying exact gen-1 row fails on the `(room_id, device_id, generation)` PK. |

## 4. Megolm session lifecycle

Per-sender-per-room ratchets with forward secrecy within a generation. These tests are the teeth of the Megolm implementation.

| File | Asserts |
|---|---|
| test-forward-secrecy.ts | Exposing the chain key at index 50 yields keys for 50+ but not earlier indices — ratchet is irreversible. |
| test-per-sender-isolation.ts | Alice's and Bob's outbound sessions are independent; Alice's chain key does not derive Bob's message key (AEAD fails under the wrong session). |
| test-session-auto-rotation.ts | `shouldRotateSession` returns false at message index 99, true at 100 (the configured threshold). |
| test-age-based-rotation.ts | Age-based rotation triggers independently: a fresh session at index 0 does not rotate, but one 8 days old at index 0 does. |
| test-megolm-hard-cap.ts | `ratchetAndDerive` throws BAD_INPUT at index 200; index 199 still succeeds (cap is exclusive). |
| test-megolm-counter-monotonic.ts | Migration 0042 BEFORE-UPDATE trigger: counter-stomp (`UPDATE message_count = 0` with same `session_id`) rejected with `check_violation`; legitimate rotation (new `session_id` + reset) allowed; 0029's AFTER-INSERT increment still fires on blob insert. Closes the direct-UPDATE bypass of the 200-cap. |
| test-megolm-snapshot-fastpath.ts | A cached snapshot at index 5 can fast-forward-derive to index 12 (matches the from-zero derivation); advancing cursor to 13 blocks re-deriving 12. |
| test-megolm-share-late-joiner.ts | Bob joining at index 5 receives a snapshot sealed for him; he derives index 5+; cannot go before 5; a non-recipient (Carol) can't unseal. |
| test-megolm-index-gap.ts | Skipped indices (3, 4) don't break forward derivation — index 5 still derives; after advancing cursor to 6, 4 is unreachable. |
| test-out-of-order.ts | Out-of-order delivery (message 2 arrives before 0 and 1) — non-advancing derive works in any order; advancing cursor's retrograde guard holds. |
| test-advance-cursor-efficiency.ts | Advancing variant produces identical keys to re-deriving from the earlier snapshot; `nextSnapshot.startIndex === targetIndex + 1`. |
| test-pre-megolm-transition.ts | A room can hold both v3 (flat-key) and v4 (Megolm) blobs; router-style `decryptBlob` handles both; gen-2 flat key does not decrypt gen-1 v3 blob; cross-session key fails AEAD. |

## 5. Key sharing, forwards, snapshots

How Megolm session keys and room keys travel safely between devices.

| File | Asserts |
|---|---|
| test-stale-key-forward.ts | Bob without a session share posts a `key_forward_request`; Alice seals her snapshot and inserts a share; Bob unseals + decrypts the original message. |
| test-key-forward-flow.ts | Full key-forward round-trip: Dev2 posts request, Dev1 seals snapshot, Dev2 unseals and decrypts — happy path of T8's setup. |
| test-share-sig-tamper.ts | One-byte modification of `sealed_snapshot` is caught by `verifySessionShare` (signature). |
| test-share-cross-recipient.ts | Alice's share for Bob is invisible to Carol under RLS (`recipient_device_id` filter on read). |
| test-wrong-recipient-unseal.ts | Share sealed to Bob's X25519 pub fails `DECRYPT_FAILED` if Carol tries to unseal; tampered bytes fail `verifySessionShare` CERT_INVALID even before unseal. |
| test-session-snapshot-backup.ts | Snapshot encrypted under the backup key round-trips through storage; wrong roomId in AD throws; wrong backup key throws. |

## 6. Device approval, recovery, backup, PIN

New-device onboarding and durable key escrow.

| File | Asserts |
|---|---|
| test-device-approval.ts | End-to-end approval: new device posts request with `linking_pubkey` and `code_hash`; approver verifies and seals SSK+USK; new device unseals and is usable. |
| test-approval-cascade.ts | After approval, a new device is added to every room the approving device is in; both devices decrypt the same blob independently. |
| test-recovery-phrase.ts | BIP-39 24-word phrase wraps full v4 identity (MSK+SSK+USK+backupKey); correct phrase unwraps all four; wrong phrase throws DECRYPT_FAILED. |
| test-recovery-restore-flow.ts | End-to-end recovery: wrap identity under phrase, back up a room key, simulate device loss, new device unwraps via phrase, recovers room key, decrypts a pre-loss message. |
| test-key-backup-recovery.ts | Room key encrypted under the backup key, stored, recovered on a new device, used to decrypt a pre-loss message; wrong backup key throws. |
| test-key-backup-multi-room.ts | Three backed-up keys across three rooms — all three recover correctly; using the wrong room's `key_backup` row fails AD binding. |
| test-pin-lock-roundtrip.ts | `wrapDeviceStateWithPin` / `unwrapDeviceStateWithPin` round-trip; wrong passphrase → DECRYPT_FAILED; wrong userId in AD → DECRYPT_FAILED; too-short passphrase → BAD_INPUT. |
| test-call-key-envelope.ts | `wrapAndSignCallEnvelope` / `verifyCallEnvelope` round-trip; tampered ciphertext throws; `zeroCallKey` zeroes memory. |

## 7. Server-side authorization: RLS policies & RPC gates

Invariants enforced by Postgres itself. Client-side bugs can't bypass these.

| File | Asserts |
|---|---|
| test-nonmember-read-block.ts | Non-member querying `blobs` gets zero rows (RLS SELECT). |
| test-nonmember-blob-insert.ts | Non-member attempting INSERT into `blobs` is rejected (RLS INSERT: not a member at any generation). |
| test-invite-expiry.ts | An invite with past `expires_at_ms` cannot be redeemed — RLS on `room_members` INSERT's invite arm rejects. |
| test-invite-accept-flow.ts | Happy-path invite accept: Alice invites Bob, Bob verifies envelope signature + unwraps, inserts `room_members`, decrypts Alice's message; Carol cannot re-use the same invite. |
| test-concurrent-invite-accept.ts | Two of Bob's devices race to accept the same invite — PK `(room_id, device_id, generation)` ensures exactly one succeeds. |
| test-call-rpc-ownership-gate.ts | Migration 0041 defence: `start_call` / `rotate_call_key` reject envelopes where `device_id` doesn't belong to `target_user_id`, and where `target_user_id` is not a current-gen room member; rotation rolls back atomically. |

## 8. Adversarial: tamper, replay, malformed input

What the decrypt path rejects when a malicious or corrupted value reaches it.

| File | Asserts |
|---|---|
| test-tamper-aead.ts | One-bit flip in ciphertext column of the DB makes `decryptBlob` throw AEAD authentication failure; no plaintext returned. |
| test-replay-attack.ts | Replayed blob row (duplicate `(sessionId, messageIndex)`) is rejected by application-level duplicate check; no silent re-delivery. |
| test-malformed-payload.ts | Six server-side corruption scenarios (truncated nonce, stripped MAC, zeroed ciphertext, empty, wrong key, generation mismatch) each throw a handled `CryptoError`; no WASM panic. |
| test-poison-pill.ts | Seven IDB-corruption scenarios (zeroed chain key, truncated, half-length, cursor past target, wrong session ID, tampered sealed bytes, zero-length key) all throw DECRYPT_FAILED or BAD_GENERATION; no hard crash. |

## 9. Concurrency, races, DoS resistance

Parallel operations that could produce inconsistent or duplicated state.

| File | Asserts |
|---|---|
| test-parallel-blob-inserts.ts | Ten concurrent blob inserts via `Promise.all` all succeed with distinct IDs and nonces; none lost. |
| test-stampede.ts | Fifteen concurrent Megolm message arrivals coalesce through `LoadMutex` (run / queue / drop pattern); all 15 plaintexts recovered exactly once; underlying `load()` called ≤ 15 times (coalescing works). |
| test-cross-tab-race.ts | Two independent `LoadMutex` instances simulating two browser tabs each decrypt the same blob sequence correctly; `BroadcastChannel` routes identity-change events only to the matching userId. |

## 10. Data lifecycle: delete & cleanup

Deletion actually deletes. Cleanup completeness matters for compliance and for test-isolation.

| File | Asserts |
|---|---|
| test-account-nuke.ts | `nuke_identity` RPC wipes `identities`, `devices`, `room_members`, and related rows for the caller; peer users' data in shared rooms survives. |
| test-cleanup-completeness.ts | Test harness `cleanupUser` leaves zero rows in `sas_verification_sessions`, `megolm_sessions`, `blobs`, `room_invites`, `room_members`, `key_backup` for the target user. |
| test-room-deletion-cascade.ts | Deleting a room cascades to `room_members`, `blobs`, `room_invites`, `megolm_sessions`, `key_backup`; peer users' data in other rooms is untouched. |

## 11. Source-structural invariants

Tests that assert over the source text itself — used when the regression would only manifest in a React/UI path that would need Playwright to fully exercise.

| File | Asserts |
|---|---|
| test-appshell-pin-gate.ts | `AppShell.tsx` calls `hasWrappedIdentity` in the auth-success branch and redirects to `/auth/callback` when missing — enforcing the "PIN-lock is mandatory, not opt-in" invariant that a URL-bar bypass of the callback page would otherwise break. |

## 12. Feature-layer event invariants (Phase 4 ports)

Tests scoped to a specific feature event type rather than the underlying primitive. Two flavors: per-feature **author-attribution** canaries (forged sender rejected at SIGNATURE_INVALID; honest event verifies) and **UX-only-gate documentation** (assert the data layer leaks "secret" UX fields, since enforcement lives in the renderer — flips to a real check if the feature is ever cryptographically hardened).

| File | Asserts |
|---|---|
| test-time-capsule-unlock-gate.ts | Documents that `time_capsule_post.unlockAt` is UI-only: a member decrypts a future-locked capsule and reads its message immediately. PASSES today; flip if you ever bind unlockAt into AEAD AD + withhold a per-capsule key. |
| test-safespace-otp-gate.ts | Documents that `icebreaker_post.otp` is UI-only: a member decrypts the post and reads the 4-digit OTP straight from the payload, no `icebreaker_unlock` event needed. PASSES today; flip if Safe Space ever derives a per-entry key from the OTP. |
| test-datevault-membership-gate.ts | Real RLS invariant: non-member of the room cannot read `date_post` blobs. Bonus: a member can decrypt every date_post regardless of `dateId` — per-date sub-scoping is a renderer filter, not a crypto isolation. |
| test-lovetank-author-attribution.ts | Forged `love_tank_set` (Bob signs, claims sender=Alice) → SIGNATURE_INVALID via the production-style resolver. Honest event from Bob decrypts with attribution to Bob. |
| test-gratitude-author-attribution.ts | Same forgery rejection for `gratitude_send` — confirms the `to:` recipient field round-trips and the sender claim cannot be impersonated to fabricate "Alice thanked you" notes or skew heart-balance bookkeeping. |
| test-mindreader-author-attribution.ts | Same forgery rejection for `mind_reader_post` — Bob cannot publish a game claiming Alice authored it (which would let him "solve" it himself for credit). |
| test-bribe-author-attribution.ts | Same forgery rejection for `bribe` — Bob cannot spend hearts "as Alice" to drain her balance or force-reveal a mind_reader game while attributing the solve elsewhere. |
| test-wishlist-author-attribution.ts | Same forgery rejection for `wishlist_add` — Bob cannot inject items into Alice's wishlist or claim/delete entries on her behalf. |

---

## Notes

**Test numbering drift.** The inline `Test N` labels in each file, the `T##` column in `docs/integration-tests.md`, and the `MN` mutation IDs in `docs/mutation-testing-plan.md` are three independent numbering schemes. Prefer filenames in bug reports; numbers are convenience labels.

**T57 clock-skew tripwire.** `test-approval-request-expiry.ts` sets `expires_at = local now − 1s`. If the local clock is >1s ahead of Postgres, the row still looks fresh and the RPC correctly returns true on a matching hash, failing the test. Resync (`w32tm /resync` on Windows) before treating the failure as a real regression.

**Cross-tab IDB locking** is tested at the coordination layer (`BroadcastChannel` + `LoadMutex`) only. The real per-origin IDB transaction serialisation is a browser primitive that Node's polyfill doesn't replicate — see T64/T65 / `test-cross-tab-race.ts`.

**`CORRUPT_LOCAL_STATE` is not a distinct error code.** Storage corruption is indistinguishable from a wrong key at the AEAD layer — both surface as `DECRYPT_FAILED`. Callers should treat any `CryptoError` during decrypt as a signal to refetch the session snapshot from the server.

**Mutation testing.** `scripts/run-mutations.ts` applies 12 code-level weakenings and confirms the matching kill-list tests detect each. See `docs/mutation-testing-plan.md` for the per-mutation mapping and the list of invariants that a pure TypeScript mutation cannot weaken (AEAD primitives and RLS policies — the latter would require a Supabase branch).
