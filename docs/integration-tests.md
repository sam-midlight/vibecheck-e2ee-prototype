# Integration Test Suite

All tests live in `scripts/test-*.ts` and run against a live Supabase project.

```
npx tsx --env-file=.env.local scripts/<test-file>.ts
```

Required env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

Each test is self-contained: it creates its own users, runs assertions, then deletes everything in a `finally` block. Tests do not share state and can run in any order (but not concurrently — they share the same Supabase project).

---

## Stage 1 — Core Crypto Primitives (T01–T35)

| # | File | What it covers |
|---|------|----------------|
| T01 | test-happy-path.ts | Full Alice→Bob v3 blob round-trip: room creation, membership, encrypt, decrypt |
| T02 | test-tamper-aead.ts | Single-bit flip in ciphertext rejected by AEAD |
| T03 | test-replay-attack.ts | Replayed blob row (duplicate nonce) rejected at DB or decrypt layer |
| T04 | test-wrong-generation.ts | gen-N blob rejected by gen-(N+1) room key |
| T05 | test-nonmember-read-block.ts | RLS blocks non-member from reading room_members + blobs |
| T06 | test-revocation.ts | Revoked device cert rejected by verifyPublicDevice |
| T07 | test-ghost-member.ts | Evicted user cannot read post-rotation blobs |
| T08 | test-late-joiner.ts | Late joiner decrypts only blobs from their generation onward |
| T09 | test-multi-device.ts | Two devices for the same user both decrypt the same blob |
| T10 | test-stale-key-forward.ts | key_forward_requests row triggers session share delivery |
| T11 | test-session-auto-rotation.ts | Outbound session auto-rotates at 100 messages |
| T12 | test-room-name.ts | encryptRoomName / decryptRoomName round-trip |
| T13 | test-msk-rotation.ts | MSK rotation cascades to room rotation; ghost device loses access |
| T14 | test-group-churn.ts | Multiple join/leave/rotate cycles stay consistent |
| T15 | test-key-backup-recovery.ts | Key backup encrypted with backupKey; recovered via recovery phrase |
| T16 | test-concurrent-rotation.ts | Concurrent kick_and_rotate calls: exactly one wins, no zombie state |
| T17 | test-invite-expiry.ts | Expired invite cannot be accepted |
| T18 | test-account-nuke.ts | nuke_identity wipes all user data; sibling rooms unaffected |
| T19 | test-device-approval.ts | Full approval flow: request, verify code, link second device |
| T20 | test-megolm-hard-cap.ts | ratchetAndDerive throws BAD_INPUT at index 200 |
| T21 | test-forward-secrecy.ts | Exposing chain key at index N does not reveal keys at index < N |
| T22 | test-per-sender-isolation.ts | Compromising Alice's chain key does not reveal Bob's messages |
| T23 | test-share-sig-tamper.ts | Tampered session share signature rejected (CERT_INVALID) |
| T24 | test-age-based-rotation.ts | Session rotates when createdAt > 7 days regardless of message count |
| T25 | test-nonmember-blob-insert.ts | RLS blocks non-member from inserting blobs |
| T26 | test-evicted-reinsert-block.ts | Evicted user cannot re-insert into room_members after kick_and_rotate |
| T27 | test-unauthorized-kick-rotate.ts | Non-creator cannot call kick_and_rotate |
| T28 | test-share-cross-recipient.ts | Session share sealed for Bob cannot be unsealed by Carol |
| T29 | test-recovery-phrase.ts | BIP-39 phrase wraps/unwraps MSK+SSK+USK; wrong phrase → DECRYPT_FAILED |
| T30 | test-session-snapshot-backup.ts | Snapshot sealed, stored, retrieved, unsealed; verified by Bob |
| T31 | test-call-key-envelope.ts | CallKey encrypt/decrypt round-trip; wrong key rejected |
| T32 | test-invite-accept-flow.ts | Full invite accept: wrap, insert, verify membership |
| T33 | test-approval-cascade.ts | Device approval cascade: SSK+USK shared to new device via signing_key_wrap |
| T34 | test-rotate-then-cross-decrypt.ts | Rotated room: gen-1 member cannot decrypt gen-2 blobs |
| T35 | test-corrupted-membership-sig.ts | Tampered membership wrap signature rejected at verify layer |

---

## Stage 2 — Edge Cases & Invariants (T36–T40)

| # | File | What it covers |
|---|------|----------------|
| T36 | test-membership-row-replay.ts | Gen-1 membership row cannot be replayed as gen-2 (PK constraint) |
| T37 | test-identity-epoch-staleness.ts | Stale-epoch approval code rejected; fresh code at new epoch accepted |
| T38 | test-cleanup-completeness.ts | cleanupUser wipes all 6 tables; unrelated user data unaffected |
| T39 | test-parallel-blob-inserts.ts | 10 concurrent blob inserts all succeed with distinct IDs |
| T40 | test-advance-cursor-efficiency.ts | Cursor advance chain; underflow on retrograde index throws BAD_GENERATION |

---

## Stage 3 — Normal User Flows (T41–T60)

| # | File | What it covers |
|---|------|----------------|
| T41 | test-recovery-restore-flow.ts | Recovery phrase unwrap restores MSK+SSK+USK; backup key decrypts stored room key |
| T42 | test-key-backup-multi-room.ts | 3 rooms each with a key_backup row; AD binding rejects wrong roomId |
| T43 | test-pin-lock-roundtrip.ts | PIN wrap/unwrap round-trip; wrong PIN → DECRYPT_FAILED; wrong userId → DECRYPT_FAILED |
| T44 | test-cert-chain-verification.ts | Full cert chain: MSK→SSK cross-sig, v1 fallback, revocation via SSK |
| T45 | test-usk-cross-sign.ts | USK signs peer MSK pub; 4 negative cases (wrong key/msk/timestamp) → CERT_INVALID |
| T46 | test-approval-epoch-positive.ts | Positive counterpart to T37: fresh request at bumped epoch verifies successfully |
| T47 | test-megolm-snapshot-fastpath.ts | Snapshot at index 5 fast-forwards to 12 in O(7) steps; retrograde blocked |
| T48 | test-megolm-share-late-joiner.ts | Late-joiner snapshot: Bob derives from startIndex=5; blocked at 4; Carol can't unseal |
| T49 | test-per-room-key-isolation.ts | Room-1 and room-2 keys each fail AEAD on room-0 blob |
| T50 | test-megolm-index-gap.ts | Skipped indices 3+4; key at 5 still derived; retrograde on advanced cursor blocked |
| T51 | test-generation-access-boundary.ts | Bob (joined gen-1) decrypts gen-1 blob; cannot decrypt gen-0 blob |
| T52 | test-room-deletion-cascade.ts | Room delete cascades: room_members, blobs, room_invites, key_backup all cleared |
| T53 | test-multi-device-decrypt.ts | 3 devices independently unwrap and decrypt the same blob |
| T54 | test-concurrent-invite-accept.ts | Two concurrent identical membership inserts: exactly 1 succeeds (PK) |
| T55 | test-room-name-rotation.ts | Encrypted room name rotates with kick_and_rotate; gen-1 name rejected by gen-2 key |
| T56 | test-blob-sender-verification.ts | Correct sender pub decrypts; impostor sender pub rejected |
| T57 | test-approval-request-expiry.ts | Expired approval request (past expires_at) returns false from verify_approval_code |
| T58 | test-key-forward-flow.ts | Dev2 posts key_forward_request; Dev1 seals snapshot; Dev2 unseals and decrypts |
| T59 | test-wrong-recipient-unseal.ts | Snapshot sealed for Bob fails unseal by Carol; tampered bytes fail verifySessionShare |
| T60 | test-revoked-device-cert.ts | Revoked device rejected by verifyPublicDevice; filterActiveDevices omits it |

---

## Stage 4 — Adversarial Scenarios (T61–T66)

| # | File | What it covers |
|---|------|----------------|
| T61 | test-out-of-order.ts | Out-of-order Megolm delivery: Bob receives index 2 first, then 0 and 1 — all correct; advancing cursor blocks retrograde access |
| T62 | test-spoofed-identity.ts | Eve inserts device under Alice's user_id — RLS blocks; Eve's self-signed cert rejected against Alice's SSK; verifyPublicDevice throws CERT_INVALID |
| T63 | test-malformed-payload.ts | 6 server-side corruption scenarios (truncated nonce, stripped MAC, zeroed ciphertext, empty, wrong key, generation mismatch) all throw safely; no WASM panic |
| T64 | test-stampede.ts | 15 concurrent Megolm triggers coalesced by LoadMutex into 2 batch calls; all 15 messages decrypted correctly; mutex unit semantics verified |
| T65 | test-cross-tab-race.ts | BroadcastChannel routes identity-change events to matching userId, filters mismatches, stops after close; two concurrent "tab" LoadMutex instances each independently decrypt all 10 messages |
| T66 | test-poison-pill.ts | 7 storage-corruption scenarios (zeroed key, empty key, half-length key, cursor past target, wrong session ID, tampered sealed bytes, zero-length resolved key) all throw DECRYPT_FAILED or BAD_GENERATION; no WASM panic |

---

## Stage 5 — Source-structural Invariants (T67+)

Tests in this stage assert properties over the source text itself, not runtime behaviour. They cover invariants that live in React/UI code where a full browser test (jsdom/Playwright) would be out of proportion with the regression shape. Each test is paired with mutations in `run-mutations.ts` that exercise the realistic regression cases.

| # | File | What it covers |
|---|------|----------------|
| T67 | test-appshell-pin-gate.ts | `AppShell` enforces the mandatory-PIN invariant: after the chain check passes, `hasWrappedIdentity` must be called on the success path, the falsy result must redirect to `/auth/callback` and `return`, and the guard must precede `setChecking(false)`. Paired with M13 (guard removed), M14 (guard after setChecking), M15 (wrong redirect target). Runs offline — no Supabase creds needed. |

---

## Notes

**Why no Jest/Mocha?** These tests hit a live Supabase instance to exercise RLS policies, RPCs, and row-level constraints. A mock layer would miss the class of bugs these tests are designed to catch.

**Cross-tab IDB locking** (the race where two tabs both write the Megolm cursor) cannot be fully reproduced in Node because Node's IDB polyfill doesn't replicate the browser's per-origin transaction serialisation. T65 tests the coordination *mechanism* (BroadcastChannel + LoadMutex) rather than the IDB lock directly. Browser-level coverage requires a Playwright/Puppeteer test with two pages sharing the same origin.

**`CORRUPT_LOCAL_STATE`** is not a distinct error code in `e2ee-core`. Storage corruption is indistinguishable from a wrong key at the AEAD layer — both produce `DECRYPT_FAILED`. T66 asserts that the process survives gracefully; callers should treat any `CryptoError` during decrypt as a signal to refetch the session snapshot from the server.

**T57 clock-skew tripwire.** `test-approval-request-expiry.ts` inserts a row with `expires_at = localDate.now() - 1s`. If the local clock is more than ~1s ahead of the Supabase server's clock, Postgres still sees the row as fresh, `verify_approval_code` correctly returns `true` on a matching hash, and the assertion fires. The 1s window is intentional (doubles as a local-clock canary). On a first failure of this test specifically, resync the local clock (`w32tm /resync` on Windows) before investigating the RPC.

**Running the full suite.** `bash scripts/run-all-tests.sh` runs every `scripts/test-*.ts` sequentially and writes per-test logs to `/tmp/e2ee-test-run/logs/` plus a TSV summary. Sequential, not concurrent — tests share the live Supabase project.
