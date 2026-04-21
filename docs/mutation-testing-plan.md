# Mutation Testing Plan

## Premise

Each integration test asserts that a specific security property holds. A test that only ever passes — even when the code is broken — is worthless. Mutation testing proves tests have teeth: deliberately weaken the production code, confirm the relevant tests fail, restore the code, confirm they pass again.

The runner applies each mutation, runs the tests that should catch it, verifies they all exit 1, then reverts and verifies they all exit 0. A mutation that is NOT caught by any test is a gap in coverage.

---

## Runner

**`scripts/run-mutations.ts`**

Each `Mutation` record specifies:

```ts
interface Mutation {
  id: string;           // e.g. 'M01'
  description: string;  // human label
  file: string;         // relative to repo root
  find: string;         // exact string to replace (must be unique in file)
  replace: string;      // the weakened version
  kills: string[];      // test-*.ts filenames that MUST exit 1 under this mutation
  survives?: string[];  // test-*.ts filenames that must still exit 0 (sanity)
}
```

Flow per mutation:
1. Read file, assert `find` string is present (fail fast if code changed).
2. Write mutant (find → replace).
3. Run each `kills` test with `npx tsx --env-file=.env.local scripts/<test>`.
   - A test that exits **0** under mutation = **uncaught** → mutation testing FAIL.
   - A test that exits **1** under mutation = **caught** → correct.
4. Run each `survives` test; assert exit 0 (confirm mutation didn't break unrelated paths).
5. Restore original file.
6. Re-run each `kills` test; assert exit 0 (confirm restored code is clean).
7. Print PASS / FAIL summary per mutation.

---

## Code-Level Mutations

### M01 — Retrograde guard disabled in `deriveMessageKeyAtIndex`

**File:** `src/lib/e2ee-core/megolm.ts`

**Find:**
```ts
  if (targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      `cannot derive key at index ${targetIndex} — snapshot starts at ${snapshot.startIndex}`,
      'BAD_GENERATION',
    );
  }
```

**Replace:**
```ts
  /* M01: retrograde guard disabled */
  if (false && targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      `cannot derive key at index ${targetIndex} — snapshot starts at ${snapshot.startIndex}`,
      'BAD_GENERATION',
    );
  }
```

**Effect:** `deriveMessageKeyAtIndex(snap50, 49)` returns a key (the wrong one — derived from chain key at 50, labelled index 49) instead of throwing. Any test that calls this with a below-start index and expects a throw sees it succeed.

**Must kill:**
- `test-forward-secrecy.ts` — T21: Bob tries index 49 on a snapshot starting at 50; expects throw, gets return.
- `test-megolm-index-gap.ts` — T50: after cursor advances to 6, tries index 4; expects throw.
- `test-out-of-order.ts` — T61: after advancing past 2, tries index 0 on snapAt3; expects throw.

**Survives:** `test-happy-path.ts` (no retrograde in happy path)

---

### M02 — Retrograde guard disabled in `deriveMessageKeyAtIndexAndAdvance`

**File:** `src/lib/e2ee-core/megolm.ts`

**Find:**
```ts
  if (targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      `cannot derive key at index ${targetIndex} — snapshot starts at ${snapshot.startIndex}`,
      'BAD_GENERATION',
    );
  }
  const sodium = await getSodium();
  let chain: Uint8Array = new Uint8Array(snapshot.chainKeyAtIndex);
  for (let i = snapshot.startIndex; i < targetIndex; i++) {
```

**Replace:**
```ts
  /* M02: retrograde guard disabled in AndAdvance variant */
  if (false && targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      `cannot derive key at index ${targetIndex} — snapshot starts at ${snapshot.startIndex}`,
      'BAD_GENERATION',
    );
  }
  const sodium = await getSodium();
  let chain: Uint8Array = new Uint8Array(snapshot.chainKeyAtIndex);
  for (let i = snapshot.startIndex; i < targetIndex; i++) {
```

*(The `find` string must be long enough to be unique in the file — this block only appears once in the `AndAdvance` function.)*

**Effect:** `deriveMessageKeyAtIndexAndAdvance(snap5, 4)` returns a key + nextSnapshot instead of throwing BAD_GENERATION.

**Must kill:**
- `test-advance-cursor-efficiency.ts` — T40: calls `AndAdvance(snapshot, 4)` with startIndex=5; expects throw.
- `test-megolm-snapshot-fastpath.ts` — T47: calls `AndAdvance(snap13, 12)` after cursor at 13; expects throw.

**Survives:** `test-out-of-order.ts` (its retrograde check uses the non-advancing variant → covered by M01)

---

### M03 — Megolm hard cap removed

**File:** `src/lib/e2ee-core/megolm.ts`

**Find:**
```ts
  if (session.messageIndex >= MEGOLM_HARD_CAP) {
    throw new CryptoError(
      `Megolm session exhausted at index ${session.messageIndex} (cap ${MEGOLM_HARD_CAP}). Rotate before sending.`,
      'BAD_INPUT',
    );
  }
```

**Replace:**
```ts
  /* M03: hard cap check removed */
```

**Must kill:**
- `test-megolm-hard-cap.ts` — T20: calls `ratchetAndDerive` 201 times; expects the 201st to throw; now it returns.

**Survives:** `test-stampede.ts` (only uses 15 ratchet steps)

---

### M04 — Auto-rotation count threshold raised

**File:** `src/lib/e2ee-core/megolm.ts`

**Find:**
```ts
export const DEFAULT_AUTO_ROTATION: AutoRotationConfig = {
  maxMessages: 100,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};
```

**Replace:**
```ts
export const DEFAULT_AUTO_ROTATION: AutoRotationConfig = {
  maxMessages: 100_000, /* M04: threshold raised — count trigger never fires */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};
```

**Must kill:**
- `test-session-auto-rotation.ts` — T12: expects `shouldRotateSession` to return true at messageIndex=100; with threshold=100,000 it returns false.

**Survives:** `test-age-based-rotation.ts` (age trigger is unchanged)

---

### M05 — Auto-rotation age threshold raised

**File:** `src/lib/e2ee-core/megolm.ts`

**Find:**
```ts
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
```

**Replace:**
```ts
  maxAgeMs: 9_999 * 365 * 24 * 60 * 60 * 1000, /* M05: age trigger never fires */
```

**Must kill:**
- `test-age-based-rotation.ts` — T24: creates a session with `createdAt` in the past (>7 days), expects `shouldRotateSession` to return true; with a 9999-year threshold it returns false.

**Survives:** `test-session-auto-rotation.ts` (count trigger is unchanged)

---

### M06 — Session share signature silently accepted

**File:** `src/lib/e2ee-core/megolm.ts`

**Find:**
```ts
  try {
    await verifyMessageOrThrow(msg, params.signature, params.signerEd25519Pub);
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('session share signature invalid', 'CERT_INVALID');
    }
    throw err;
  }
```

**Replace:**
```ts
  try {
    await verifyMessageOrThrow(msg, params.signature, params.signerEd25519Pub);
  } catch {
    /* M06: bad session share signature silently accepted */
  }
```

**Effect:** Any call to `verifySessionShare` with a wrong/tampered signature succeeds silently.

**Must kill:**
- `test-share-sig-tamper.ts` — T23: tampers sealed_snapshot bytes, calls `verifySessionShare`, expects throw.
- `test-wrong-recipient-unseal.ts` — T59: Carol attempts `verifySessionShare` with tampered bytes; expects throw.

**Survives:** `test-stale-key-forward.ts` (verifies a legitimate, untampered share)

---

### M07 — Device revocation check bypassed in `verifyPublicDevice`

**File:** `src/lib/e2ee-core/device.ts`

**Find:**
```ts
  if (device.revocation) {
    await verifyDeviceRevocation(
      {
        userId: device.userId,
        deviceId: device.deviceId,
        revokedAtMs: device.revocation.revokedAtMs,
      },
      device.revocation.signature,
      umkPublicKey,
      sskPublicKey,
    );
    throw new CryptoError(
      `device ${device.deviceId} is revoked (since ${new Date(device.revocation.revokedAtMs).toISOString()})`,
      'DEVICE_REVOKED',
    );
  }
```

**Replace:**
```ts
  /* M07: revocation check bypassed — revoked devices accepted */
```

**Must kill:**
- `test-revoked-device-cert.ts` — T60: calls `verifyPublicDevice` with a device that has a valid revocation cert; expects DEVICE_REVOKED; now returns normally.

**Survives:** `test-cert-chain-verification.ts` (tests issuance cert, not revocation)

---

### M08 — Sender device signature check skipped in `decryptBlob`

Two parallel changes in the same file — apply both as a single find+replace to keep M08 atomic.

**File:** `src/lib/e2ee-core/blob.ts`

**Find (v4 path):**
```ts
        if (!sigOk) {
          throw new CryptoError('v4 sender device signature invalid', 'SIGNATURE_INVALID');
        }
```

**Replace (v4 path):**
```ts
        if (!sigOk) {
          /* M08: v4 sender signature check disabled */
          void sigOk;
        }
```

*(Repeat for the v3 path — `'sender device signature invalid'` — in the same file. Run as two sequential find+replace operations within the same mutation application.)*

**Find (v3 path):**
```ts
        if (!sigOk) {
          throw new CryptoError('sender device signature invalid', 'SIGNATURE_INVALID');
        }
```

**Replace (v3 path):**
```ts
        if (!sigOk) {
          /* M08: v3 sender signature check disabled */
          void sigOk;
        }
```

**Must kill:**
- `test-blob-sender-verification.ts` — T56: `decryptBlob` with impostor pub; expects SIGNATURE_INVALID; now succeeds (returns plaintext with wrong attribution).

**Survives:** `test-happy-path.ts` (legit sender, sig passes anyway)

---

### M09 — Device issuance certificate verification bypassed

**File:** `src/lib/e2ee-core/device.ts`

**Find:**
```ts
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('device issuance cert did not verify', 'CERT_INVALID');
    }
    throw err;
  }
```

*(This is the catch block in `verifyDeviceIssuance`. The exact surrounding context must be used to avoid matching the `verifyDeviceRevocation` catch block.)*

**Find (precise — include preceding line):**
```ts
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('device issuance cert did not verify', 'CERT_INVALID');
    }
    throw err;
  }
}
```

**Replace:**
```ts
  } catch {
    /* M09: issuance cert signature check bypassed */
  }
}
```

**Effect:** `verifyDeviceIssuance(fields, eveSelfSignedCert, alice.ssk.pub, alice.ssk.pub)` no longer throws — Eve's cert is accepted against Alice's key.

**Must kill:**
- `test-spoofed-identity.ts` — T62: Attack 2 expects `verifyDeviceIssuance` to reject Eve's cert; now it accepts.
- `test-cert-chain-verification.ts` — T44: negative case — tampered issuance sig must throw CERT_INVALID; now doesn't.

**Survives:** `test-device-approval.ts` (issuance certs with correct signer pass either way)

---

### M10 — Minimum passphrase length check removed

**File:** `src/lib/e2ee-core/pin-lock.ts`

**Find:**
```ts
  if (!passphrase || passphrase.length < 4) {
    throw new CryptoError('passphrase must be at least 4 characters', 'BAD_INPUT');
  }
```

**Replace:**
```ts
  /* M10: passphrase length guard removed */
```

**Must kill:**
- `test-pin-lock-roundtrip.ts` — T43: calls `wrapDeviceStateWithPin(bundle, msk, 'abc', ...)` (3 chars); expects BAD_INPUT; now proceeds and wraps.

**Survives:** `test-pin-lock-roundtrip.ts` must still PASS the wrong-passphrase assertion (a different assertion in the same test). Run the sanity check as `test-happy-path.ts` instead to avoid confusing partial failure.

---

### M11 — userId stripped from PIN lock AD tag

**File:** `src/lib/e2ee-core/pin-lock.ts`

**Find:**
```ts
      adTag = `vibecheck:pinlock:v3:${userId}`;
```

**Replace:**
```ts
      adTag = `vibecheck:pinlock:v3:`; /* M11: userId removed from AD — wrong userId accepted */
```

**Effect:** Wrapping with `userId=A` and unwrapping with `userId=B` both produce the same AD `vibecheck:pinlock:v3:`, so decryption succeeds with any userId.

**Must kill:**
- `test-pin-lock-roundtrip.ts` — T43: wraps with correct userId then calls `unwrapDeviceStateWithPin(wrapped, correctPin, 'wrong-user-id')`; expects DECRYPT_FAILED; now succeeds.

*(Note: this kills a different assertion in T43 than M10. Both are needed.)*

---

### M12 — Cross-signing chain verification bypassed

**File:** `src/lib/e2ee-core/cross-signing.ts`

**Find:**
```ts
export async function verifyCrossSigningChain(params: {
  mskPub: Bytes;
  sskPub: Bytes;
  sskCrossSignature: Bytes;
  uskPub: Bytes;
  uskCrossSignature: Bytes;
}): Promise<void> {
  await verifySskCrossSignature(
    params.mskPub,
    params.sskPub,
    params.sskCrossSignature,
  );
  await verifyUskCrossSignature(
    params.mskPub,
    params.uskPub,
    params.uskCrossSignature,
  );
}
```

**Replace:**
```ts
export async function verifyCrossSigningChain(params: {
  mskPub: Bytes;
  sskPub: Bytes;
  sskCrossSignature: Bytes;
  uskPub: Bytes;
  uskCrossSignature: Bytes;
}): Promise<void> {
  /* M12: cross-signing chain verification bypassed */
  void params;
}
```

**Must kill:**
- `test-cert-chain-verification.ts` — T44: tampered `sskCrossSignature` must throw; bypassed chain returns normally.

**Survives:** `test-usk-cross-sign.ts` (T45 uses `verifyUserMskSignature`, not `verifyCrossSigningChain`)

---

### M13 — AppShell mandatory-PIN guard removed

**File:** `src/components/AppShell.tsx`

**Find:**
```tsx
      const hasPin = await hasWrappedIdentity(data.user.id).catch(() => false);
      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }
```

**Replace:**
```tsx
      /* M13: AppShell mandatory-PIN guard removed */
```

**Must kill:**
- `test-appshell-pin-gate.ts` — T67: structural assertion "`hasWrappedIdentity` called on success path" fails when the entire block is deleted.

**Survives:** `test-happy-path.ts` (crypto-path tests don't depend on UI routing).

---

### M14 — AppShell renders before PIN guard

**File:** `src/components/AppShell.tsx`

**Find:**
```tsx
      const hasPin = await hasWrappedIdentity(data.user.id).catch(() => false);
      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }
```

**Replace:**
```tsx
      setChecking(false); /* M14: renders before PIN guard — plaintext visible for one frame */
      const hasPin = await hasWrappedIdentity(data.user.id).catch(() => false);
      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }
```

**Must kill:**
- `test-appshell-pin-gate.ts` — T67: the structural test's "success branch" slice ends at the first `setChecking(false)`; moving the guard after it places the call outside the slice, failing the "hasWrappedIdentity called on success path" assertion.

**Survives:** `test-happy-path.ts`.

---

### M16 — v3 sender attribution block bypassed entirely

**File:** `src/lib/e2ee-core/blob.ts`

**Find:**
```ts
      const devicePub = await resolveSenderDeviceEd25519Pub(parsed.s, parsed.sd);
      if (!devicePub) {
        throw new CryptoError(
          `sender device ${parsed.sd} not found (or not trusted)`,
          'SIGNATURE_INVALID',
        );
      }
      const innerPayloadBytes = stringToBytes(JSON.stringify(parsed.p));
      try {
        const sigOk = await verifyMessage(
          await buildInnerSigMessage(
            BLOB_DOMAIN_V3,
            roomId,
            blob.generation,
            blob.nonce,
            innerPayloadBytes,
          ),
          await fromBase64(parsed.sig),
          devicePub,
        );
        if (!sigOk) {
          throw new CryptoError('sender device signature invalid', 'SIGNATURE_INVALID');
        }
      } finally {
        sodium.memzero(innerPayloadBytes);
      }
```

**Replace:**
```ts
      /* M16: v3 sender attribution checks bypassed entirely.
         Resolver still called for side-effect parity, but neither the
         device-lookup nor the signature is enforced — any forged sender
         flows through. */
      void (await resolveSenderDeviceEd25519Pub(parsed.s, parsed.sd));
```

**Why a separate mutation from M08:** The per-feature attribution tests (`test-{lovetank,gratitude,mindreader,bribe,wishlist}-author-attribution.ts`) construct a forgery where the *claimed sender* is Alice but the *deviceId* is Bob's. The in-test resolver, mirroring the production resolver in `RoomProvider.tsx`, looks up Alice's devices and returns `null` for an unknown deviceId. Decryption fails at the *device-not-found* branch (line 437), **before** ever reaching the signature check that M08 weakens (line 456). M08 alone cannot reach this code path; the only single-step mutation that lets the forgery flow through is one that bypasses the entire attribution block.

**Must kill:**
- `test-lovetank-author-attribution.ts` — T72: forged `tank_set` (Bob signs, claims Alice) must throw SIGNATURE_INVALID; bypassed block returns it as Alice's.
- `test-gratitude-author-attribution.ts` — T73: forged `gratitude_post`.
- `test-mindreader-author-attribution.ts` — T74: forged `mind_reader_solve`.
- `test-bribe-author-attribution.ts` — T75: forged `bribe`.
- `test-wishlist-author-attribution.ts` — T76: forged `wishlist_add`.
- `test-blob-sender-verification.ts` — T56: also killed (overlap with M08; both mutations independently catch the impostor-pub case).

**Survives:** `test-happy-path.ts` (legit sender flows through anyway).

---

### M15 — AppShell PIN-guard redirect target changed

**File:** `src/components/AppShell.tsx`

**Find:**
```tsx
      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }
```

**Replace:**
```tsx
      if (!hasPin) {
        router.replace('/rooms'); /* M15: redirect target changed — bypass */
        return;
      }
```

**Must kill:**
- `test-appshell-pin-gate.ts` — T67: assertion "router.replace('/auth/callback') called in success branch" fails when the target string is anything other than `/auth/callback`.

**Survives:** `test-happy-path.ts`.

---

## Coverage Summary

| Mutation | Security property killed | Tests caught |
|----------|--------------------------|-------------|
| M01 | No backward ratchet from snapshot (non-advancing) | T21, T50, T61 |
| M02 | No backward ratchet from snapshot (advancing) | T40, T47 |
| M03 | Megolm hard cap at 200 | T20 |
| M04 | Auto-rotation at 100 messages | T12 |
| M05 | Auto-rotation at 7-day age | T24 |
| M06 | Session share signatures are authenticated | T23, T59 |
| M07 | Revoked devices are rejected | T60 |
| M08 | Blob sender signatures are verified | T56 |
| M09 | Device issuance certs are verified | T44 (neg), T62 (crypto) |
| M10 | Short PINs are rejected | T43 (BAD_INPUT assert) |
| M11 | PIN lock is userId-bound (AD) | T43 (wrong-userId assert) |
| M12 | MSK → SSK/USK cross-sig chain is verified | T44 (chain assert) |
| M13 | AppShell enforces mandatory-PIN guard (guard removed) | T67 |
| M14 | AppShell guard runs before `setChecking(false)` (guard moved after) | T67 |
| M15 | AppShell PIN-guard redirect target is `/auth/callback` (target changed to `/rooms`) | T67 |
| M16 | v3 sender attribution block enforces both device-lookup AND signature | T56, T72, T73, T74, T75, T76 |

**16 mutations total** — 12 cryptographic (M01–M12), 3 source-structural for the AppShell mandatory-PIN guard (M13–M15), and 1 (M16) for the v3 sender-attribution invariant exercised by the per-feature attribution canaries.

---

## Tests Not Covered by Code Mutations

These tests verify properties enforced entirely by the **DB/RLS layer** or by the **libsodium AEAD primitive itself** — neither of which can be weakened by a TypeScript string replacement.

### AEAD-backed tests (libsodium primitive — not mutatable from TS)

Any test whose security guarantee is "AEAD fails with wrong key" falls here. The protection is `sodium.crypto_aead_xchacha20poly1305_ietf_decrypt` throwing — there is no TypeScript-level guard to remove. These tests are "inherently verified" by the correctness of libsodium.

| Test | Property |
|------|----------|
| T06 (test-tamper-aead.ts) | Single-bit ciphertext flip caught by MAC |
| T09 (test-wrong-generation.ts) | Wrong-gen key fails AEAD |
| T13 (test-room-name.ts) | Wrong key fails encryptRoomName AEAD |
| T22 (test-per-sender-isolation.ts) | Cross-sender key fails AEAD |
| T34 (test-rotate-then-cross-decrypt.ts) | Post-rotation blobs fail with old gen key |
| T49 (test-per-room-key-isolation.ts) | Wrong room key fails AEAD |
| T51 (test-generation-access-boundary.ts) | Gen-0 blob fails with gen-1 key |
| T63 (test-malformed-payload.ts) | Truncated/zeroed/wrong ciphertext throws |
| T66 (test-poison-pill.ts) | Corrupted chain key yields wrong HMAC → AEAD fails |

*Alternative for AEAD tests:* introduce a mutation that replaces `sodium.crypto_aead_xchacha20poly1305_ietf_decrypt` with a plain `sodium.crypto_secretstream_xchacha20poly1305_*` call that skips MAC verification — but this would require a WASM-level mock and is out of scope for a TypeScript mutation runner.

### RLS/DB constraint tests (require Supabase branch)

These tests verify behaviour enforced by Postgres RLS policies, triggers, and RPCs. The relevant check lives in the DB, not in `src/lib/`. To mutation-test them you would:

1. Create a Supabase branch (`supabase branches create mutation-rls`)
2. Apply a weakening migration (e.g., `DROP POLICY ... ON blobs`)
3. Run the affected test
4. Verify it fails
5. Delete the branch

| Test | Policy to weaken |
|------|-----------------|
| T11 (test-nonmember-read-block.ts) | Drop SELECT RLS on `blobs` |
| T25 (test-nonmember-blob-insert.ts) | Drop INSERT RLS on `blobs` |
| T26 (test-evicted-reinsert-block.ts) | Remove eviction check from `room_members` INSERT policy |
| T27 (test-unauthorized-kick-rotate.ts) | Remove creator-only check from `kick_and_rotate` RPC |
| T36 (test-membership-row-replay.ts) | Drop unique constraint on `(room_id, device_id, generation)` |
| T37 (test-identity-epoch-staleness.ts) | Remove epoch check from `verify_approval_code` |
| T57 (test-approval-request-expiry.ts) | Remove TTL check from `verify_approval_code` |
| T62 (test-spoofed-identity.ts) — RLS assertion | Drop `user_id = auth.uid()` policy on `devices` INSERT |

### Feature / integration tests (positive path — not mutation targets)

Positive-case tests (`test-happy-path.ts`, `test-late-joiner.ts`, etc.) confirm that legitimate flows succeed. They don't assert that something is *rejected*, so there is no security guard to remove. Their value is regression detection, not adversarial testing.

### Documented "intentional gap" tests (UX-enforced, no crypto guard exists)

Three of the Phase 4 feature-layer tests assert and *document* that a particular gate is UI-enforced rather than cryptographic. They PASS today precisely because no source-level guard exists to weaken — flipping them to FAIL is the codification of a future hardening, not a mutation.

| Test | Documented gap |
|------|-----------------|
| T77 (test-time-capsule-unlock-gate.ts) | `unlockAt` lives in plaintext payload; any current member can decrypt the blob the moment it lands. No source guard to remove — making it mutation-testable would require first binding `unlockAt` into AEAD AD and gating a second key on the unlock time. |
| T78 (test-safespace-otp-gate.ts) | The 4-digit OTP rides inside the encrypted payload; any current member can read it on decrypt without the partner re-entering it. Hardening path: derive a per-entry key from the OTP and only ship the wrap when re-entered. |
| T79 (test-datevault-membership-gate.ts) — sub-scoping half | The vault is `date_post` events scoped by `dateId`; the per-date isolation is a renderer filter, not a separate room key. The test's *outsider-blocked* half is covered by the existing T11 RLS test (and would be killed by dropping the `blobs` SELECT policy on a Supabase branch). |

---

## Running the Mutations

```bash
# Run all 16 code mutations
npx tsx --env-file=.env.local scripts/run-mutations.ts

# Run a single mutation by ID
npx tsx --env-file=.env.local scripts/run-mutations.ts --only M01

# Dry run: print mutations without applying them
npx tsx --env-file=.env.local scripts/run-mutations.ts --dry-run
```

Expected output per mutation:
```
M01 — Retrograde guard disabled (deriveMessageKeyAtIndex)
  ✓ test-forward-secrecy.ts            KILLED  (exit 1 as expected)
  ✓ test-megolm-index-gap.ts           KILLED  (exit 1 as expected)
  ✓ test-out-of-order.ts               KILLED  (exit 1 as expected)
  ✓ test-happy-path.ts                 SURVIVED (exit 0 as expected)
  ✓ Restored: all 3 tests now exit 0
  RESULT: PASS — mutation fully caught
```

If any expected-failure test exits 0 (passes when it should fail):
```
  ✗ test-forward-secrecy.ts            NOT KILLED (exit 0 — test did not catch the mutation)
  RESULT: FAIL — mutation escaped test-forward-secrecy.ts
```
