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

## Stage 4 — Adversarial Scenarios (T61–T66, T68)

| # | File | What it covers |
|---|------|----------------|
| T61 | test-out-of-order.ts | Out-of-order Megolm delivery: Bob receives index 2 first, then 0 and 1 — all correct; advancing cursor blocks retrograde access |
| T62 | test-spoofed-identity.ts | Eve inserts device under Alice's user_id — RLS blocks; Eve's self-signed cert rejected against Alice's SSK; verifyPublicDevice throws CERT_INVALID |
| T63 | test-malformed-payload.ts | 6 server-side corruption scenarios (truncated nonce, stripped MAC, zeroed ciphertext, empty, wrong key, generation mismatch) all throw safely; no WASM panic |
| T64 | test-stampede.ts | 15 concurrent Megolm triggers coalesced by LoadMutex into 2 batch calls; all 15 messages decrypted correctly; mutex unit semantics verified |
| T65 | test-cross-tab-race.ts | BroadcastChannel routes identity-change events to matching userId, filters mismatches, stops after close; two concurrent "tab" LoadMutex instances each independently decrypt all 10 messages |
| T66 | test-poison-pill.ts | 7 storage-corruption scenarios (zeroed key, empty key, half-length key, cursor past target, wrong session ID, tampered sealed bytes, zero-length resolved key) all throw DECRYPT_FAILED or BAD_GENERATION; no WASM panic |
| T68 | test-call-rpc-ownership-gate.ts | Migration 0041 gates: `start_call` rejects envelope where `device_id` is not owned by stated `user_id` (23514); both RPCs reject envelopes naming a non-room-member (42501); legitimate self-envelope still accepted; no ghost `call_members` row persists and `calls.current_generation` stays at 1 after rejected `rotate_call_key` rolls back |

---

## Stage 5 — Source-structural Invariants (T67+)

Tests in this stage assert properties over the source text itself, not runtime behaviour. They cover invariants that live in React/UI code where a full browser test (jsdom/Playwright) would be out of proportion with the regression shape. Each test is paired with mutations in `run-mutations.ts` that exercise the realistic regression cases.

| # | File | What it covers |
|---|------|----------------|
| T67 | test-appshell-pin-gate.ts | `AppShell` enforces the mandatory-PIN invariant: after the chain check passes, `hasWrappedIdentity` must be called on the success path, the falsy result must redirect to `/auth/callback` and `return`, and the guard must precede `setChecking(false)`. Paired with M13 (guard removed), M14 (guard after setChecking), M15 (wrong redirect target). Runs offline — no Supabase creds needed. |

---

## Stage 6 — Higher-Order Invariants (T68–T70)

Tests that fill gaps left by Stages 1–4: cryptographic paths exercised only through orchestration, or envelope-compatibility paths that span multiple generations/versions.

| # | File | What it covers |
|---|------|----------------|
| T68 | test-sas-mac.ts | Full SAS protocol: commitment / reveal / X25519 shared secret / 7-emoji derivation / MAC exchange. T45 only tested the post-SAS `signUserMsk`; T68 covers the tamper-detectors T45 skipped — commitment mismatch, MITM-substituted ephemeral (emoji diverge), single-byte MAC tamper, cross-identity MAC reuse. |
| T69 | test-msk-rotation-cascade.ts | N-room cascade: Alice with a trusted device A1 + ghost device A2 admins 3 rooms; MSK rotation re-signs A1 only; each room is kick_and_rotate'd with wraps for A1 + peer (not A2). Asserts per-room that A2 is absent at gen 2, that A2's cert no longer chains to the new SSK (CERT_INVALID), and that A1 round-trips a gen-2 blob. A buggy rotator that handles only the first room would leave the ghost in rooms 2 and 3; this test catches that. |
| T70 | test-pre-megolm-transition.ts | Mixed v3 (flat-key) + v4 (Megolm) blobs in the same room both decrypt via the router-style `decryptBlob`. Negative cases: gen-2 flat key rejects gen-1 v3 blob; a confused Megolm resolver returning S1's key for S2's sessionId fails AEAD. Enforces CLAUDE.md's "pre-Megolm rooms transition lazily on next generation bump." |
| T71 | test-megolm-counter-monotonic.ts | Migration 0042 BEFORE-UPDATE trigger on `megolm_sessions`: a sender UPDATEing `message_count = 0` while keeping the same `session_id` is rejected with `check_violation` — closes the direct-UPDATE bypass of the 0029 200-cap. Legitimate rotation (new `session_id` + `message_count = 0`) still succeeds, and 0029's AFTER-INSERT increment still fires on blob insert. |

## Stage 7 — Feature-Layer Event Invariants (T72–T79)

Tests that scope to a specific Phase-4-ported feature event. They split into two flavors: **author-attribution canaries** (forged sender rejected at the SIGNATURE_INVALID layer; honest event verifies — paired against the same primitive T56 tests, but per feature so a future schema regression surfaces under the relevant feature name) and **UX-only-gate documentation** (assert the data layer leaks the "secret" UX field, since enforcement lives in the renderer; if you ever harden the feature cryptographically, the test must be flipped).

| # | File | What it covers |
|---|------|----------------|
| T72 | test-time-capsule-unlock-gate.ts | UX-only gate: `time_capsule_post.unlockAt` is plaintext inside the encrypted payload — Bob decrypts a future-locked capsule and reads its message immediately. PASSES today (intentional per `events.ts` Time Capsules section); flip if unlockAt ever becomes AAD-bound + the per-capsule key is withheld until the unlock time. |
| T73 | test-safespace-otp-gate.ts | UX-only gate: `icebreaker_post.otp` is plaintext inside the encrypted payload — Bob reads the 4-digit OTP with no `icebreaker_unlock` event present. PASSES today (intentional per `events.ts` Safe Space section); flip if Safe Space is ever hardened to derive a per-entry key from the OTP. |
| T74 | test-datevault-membership-gate.ts | Real RLS invariant: a non-room-member (Eve) cannot SELECT `date_post` blobs or `room_members` rows in a room she's not in. Bonus assertion documents the UX-only sub-scoping: a room member decrypts every `date_post` regardless of `dateId` — per-date isolation is a renderer filter, not a crypto primitive. |
| T75 | test-lovetank-author-attribution.ts | Forged `love_tank_set` (Bob signs but stamps envelope with senderUserId=Alice) → the production-style resolver looks up Alice's published devices, doesn't find Bob's deviceId, returns null, and `decryptBlob` throws SIGNATURE_INVALID. Honest Bob event still decrypts with attribution to Bob. |
| T76 | test-gratitude-author-attribution.ts | Same forgery rejection for `gratitude_send` — confirms the `to:` recipient field round-trips and the sender claim cannot be impersonated to fabricate "Alice thanked you" notes or game the heart-balance ledger. |
| T77 | test-mindreader-author-attribution.ts | Same forgery rejection for `mind_reader_post` — Bob cannot publish a game claiming Alice authored it (which would let him "solve" it himself for credit on the leaderboard). |
| T78 | test-bribe-author-attribution.ts | Same forgery rejection for `bribe` — Bob cannot spend hearts "as Alice" to drain her balance or to force-reveal a `mind_reader` thought while attributing the solve to someone else. |
| T79 | test-wishlist-author-attribution.ts | Same forgery rejection for `wishlist_add` — Bob cannot inject items into Alice's wishlist (and by extension cannot forge `wishlist_claim` / `wishlist_delete` events on her items, since they share the same envelope-attribution mechanism). |

---

## Notes

**Why no Jest/Mocha?** These tests hit a live Supabase instance to exercise RLS policies, RPCs, and row-level constraints. A mock layer would miss the class of bugs these tests are designed to catch.

**Cross-tab IDB locking** (the race where two tabs both write the Megolm cursor) cannot be fully reproduced in Node because Node's IDB polyfill doesn't replicate the browser's per-origin transaction serialisation. T65 tests the coordination *mechanism* (BroadcastChannel + LoadMutex) rather than the IDB lock directly. Browser-level coverage requires a Playwright/Puppeteer test with two pages sharing the same origin.

**`CORRUPT_LOCAL_STATE`** is not a distinct error code in `e2ee-core`. Storage corruption is indistinguishable from a wrong key at the AEAD layer — both produce `DECRYPT_FAILED`. T66 asserts that the process survives gracefully; callers should treat any `CryptoError` during decrypt as a signal to refetch the session snapshot from the server.

**T57 clock-skew tripwire.** `test-approval-request-expiry.ts` inserts a row with `expires_at = localDate.now() - 1s`. If the local clock is more than ~1s ahead of the Supabase server's clock, Postgres still sees the row as fresh, `verify_approval_code` correctly returns `true` on a matching hash, and the assertion fires. The 1s window is intentional (doubles as a local-clock canary). On a first failure of this test specifically, resync the local clock (`w32tm /resync` on Windows) before investigating the RPC.

**Running the full suite.** `bash scripts/run-all-tests.sh` runs every `scripts/test-*.ts` sequentially and writes per-test logs to `/tmp/e2ee-test-run/logs/` plus a TSV summary. Sequential, not concurrent — tests share the live Supabase project.
