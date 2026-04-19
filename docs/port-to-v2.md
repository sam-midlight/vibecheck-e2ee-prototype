# Porting this foundation into VibeCheck V2

Checklist to move from "prototype verified" to "V2 app building on the proven E2EE core."

---

## Sync notes — what changed since the last stable cut

> **If you already integrated a prior version of this prototype**, use this section to catch up. Each dated entry lists the migrations to apply, new files to copy, and changed contracts. Apply entries in order.

### 2026-04-19 — Fix: UX blockers in device approval, revocation, and recovery-phrase flows

**No migrations required.** Pure React/UI changes; safe to apply to any existing deployment.

**Five hard blockers closed:**

1. **`RecoveryPhraseModal` — `loading-picker` stage had no escape.** When rotation found ≥2 active devices, the modal entered a "Loading devices…" state with no cancel button. A hanging Supabase call would trap the user in the full-screen modal indefinitely. Fixed by adding a `cancelledRef` (via `useRef`) that is checked after each `await` in `handleVerified`. Clicking cancel sets the ref and calls `onDone('skipped')`, causing any in-flight async to short-circuit on its next checkpoint.

2. **`RecoveryPhraseModal` — `uploading` stage had no escape.** Argon2id wrapping + Supabase writes ran behind a single "Encrypting and uploading…" screen with no cancel. Split `'uploading'` into two sub-stages: `'uploading-pre-commit'` (before `putRecoveryBlob`) shows a cancel button; `'uploading-post-commit'` (after) shows "Almost done…" with no cancel — the blob is already written and cancelling would leave a half-committed rotation. The pre-commit cancel is safe: no data has been published yet.

3. **`PendingApprovalBanner` — `approve()` network hang permanently disabled dismiss.** A single shared `busy` state gated both the approve and dismiss buttons, so a hanging `registerDevice` call left `dismiss` disabled with no escape short of a page refresh. Split into `approveBusy` and `dismissBusy` so the dismiss button stays live while approval is in-flight. If the user dismisses mid-approve, the approval row is deleted and the in-flight approve op eventually fails cleanly.

4. **`PendingApprovalBanner` — `dismiss()` silently swallowed errors.** The catch block only called `console.error`; no error was surfaced to the user. Added `setError(errorMessage(err))` so a failed dismiss shows the same inline error `<p>` already used for approve failures.

5. **`settings/page.tsx` — `onDone` async callbacks were not awaited.** Both `RecoveryPhraseModal.onDone` and `PromoteDeviceModal.onDone` were declared `async` in the settings page but called without `await` from inside the modals (`onDone('saved')` / `onDone('promoted')`). If the subsequent IDB reads (`getUserMasterKey` etc.) threw, the rejection was unhandled and the page's `umk`/`ssk`/`usk` state silently stayed stale — causing revoke buttons to vanish after a rotation, or `canRevoke` to stay false after a promote. Fixed by: (a) widening the `onDone` prop types to `void | Promise<void>`, (b) adding `await` at the call sites inside the modals (both already inside `try/catch`), (c) wrapping the settings-page callback bodies in `try/catch { setError(...) }` with the `setShowModal(false)` call placed before the `try` so the modal always closes even on failure.

**V2 porting notes:**

- No new files or contracts. All changes are scoped to the four files listed below.
- If you copied `RecoveryPhraseModal` into V2 already: apply the `useRef` import, `cancelledRef`, stage-split, and abort-guard changes. The `Stage` union type change (`'uploading'` → `'uploading-pre-commit'` | `'uploading-post-commit'`) is a compile-time break — TypeScript will surface any switch/conditional that references the old `'uploading'` literal.
- If you copied `PendingApprovalBanner` into V2 already: rename `busy`/`setBusy` to the two separate state pairs; update the three JSX `disabled` / label references accordingly.
- If you copied the `onDone` pattern from settings into a consuming app: widen the prop type and add `await` + `try/catch` as described in blocker 5.

**Files changed:** `src/app/settings/page.tsx`, `src/components/RecoveryPhraseModal.tsx`, `src/components/PendingApprovalBanner.tsx`, `src/components/PromoteDeviceModal.tsx`

---

### 2026-04-19 — Refactor: backoff + mutex extracted; /status overhaul (26 checks)

**No migrations required.** Pure JS/React changes; safe to apply to any existing deployment.

**Refactors:**

1. **`src/lib/backoff.ts` (new)** — `computeBackoffDelay(retryCount, base, cap)` extracted from the inline `Math.min(500 * 2^n, 5000)` expression in the rooms page. Rooms page now imports this. Status page check #24 verifies the full sequence [500, 1000, 2000, 4000, 5000] and the cap against the production function, not a local copy.

2. **`src/lib/load-mutex.ts` (new)** — `createLoadMutex()` extracted from the `isLoadingRef` / `pendingRef` React-ref pair in the rooms page. Semantics: `acquire()` returns `'run'` (no contention), `'queue'` (one slot queued), or `'drop'` (already have a queued call). `release()` returns `true` if a queued call should now run. Rooms page now holds a single `mutexRef = useRef(createLoadMutex())` instead of two boolean refs. Status page check #25 verifies the full acquire/release cycle including the drain path.

**`/status` page overhaul — 22 → 26 checks:**

*Retired (−2):*
- Check 4 "Sign + verify roundtrip" — covered by checks 0 and 3; no independent failure mode.
- Check 18 "V2 device cert chain" — duplicate of check 3 (same `verifySskCrossSignature` + `verifyPublicDevice` calls, different label).

*Fixed (2 in-place):*
- Check 8 (was 9) "Ciphertext opacity" — was a display-only hex dump that always passed. Now asserts: (a) ciphertext ≥ payload + AEAD overhead, (b) the literal `status-probe` marker is not present in the ciphertext bytes (hex search).
- Check 17 (was 19) "Megolm ratchet" — previously only asserted `blob.sessionId != null`. Now captures the chain key via `exportSessionSnapshot` before the first ratchet (giving `startIndex=0`), encrypts a real payload with `encryptBlobV4`, decrypts via `decryptBlob` + `resolveMegolmKey` callback using `deriveMessageKeyAtIndex`, asserts payload round-trip equality, and asserts tampered ciphertext is rejected with `CryptoError`.

*New (+6):*
- Check 20 "Megolm session seal/unseal roundtrip" — `sealSessionSnapshot` → `unsealSessionSnapshot` with a temp recipient bundle; asserts all fields (sessionId, chainKey, startIndex, senderUserId, senderDeviceId) survive the round-trip; tamper-flips one byte of the sealed blob and asserts `CryptoError`.
- Check 21 "Ratchet one-way integrity" — advances a session to index 5, exports snapshot (startIndex=5), calls `deriveMessageKeyAtIndex(snapshot, 2)`, asserts `CryptoError(BAD_GENERATION)`. Proves IDB cursor cannot roll back.
- Check 22 "Ratchet cursor O(1) advance" — derives index 49 from startIndex=0 (50 ratchet steps); asserts `nextSnapshot.startIndex=50`; derives index 50 from the cursor (1 step); asserts the key at index 50 from both paths is identical. Reports both timings so regressions to O(n) are visible.
- Check 23 "Plaintext cache second-pass timing" — encrypts a blob, decrypts once into a local `Map`, reads from the Map on a second call, asserts Map.get completes in <1ms (no WASM re-entry). Tests the pattern used by `plaintextCache` in the rooms page; `plaintextCache` itself is module-private so this uses a local Map replica.
- Check 24 "Missing key backoff sequence" — imports `computeBackoffDelay` directly and asserts the five-step sequence [500, 1000, 2000, 4000, 5000] plus the hard cap. Because it imports the production function (not a local copy), any change to the formula fails this check automatically.
- Check 25 "Mutex concurrency drop" — imports `createLoadMutex` directly, fires 5 synchronous `acquire()` calls, asserts the result vector `['run', 'queue', 'drop', 'drop', 'drop']`, then exercises the full `release()` → queued-runs → drain → fresh-acquire cycle.

**V2 porting notes:**

- Copy `src/lib/backoff.ts` and `src/lib/load-mutex.ts` alongside the room page. Both are pure (no Supabase, no React, no crypto imports) — safe to unit-test in isolation.
- The mutex's `'queue'` slot is load-bearing: without it, a `loadAll` triggered during a running load would be silently dropped. The queued re-run ensures the most recent state is always fetched exactly once after each load completes.
- The new status checks (20–25) are all in-memory or use only already-imported utilities. No new Supabase contracts.

---

### 2026-04-19 — PERF: plaintext cache, ratchet cursor safety, exponential backoff

**No migrations required.** Pure JS/React changes; safe to apply to any existing deployment.

**Background — three architectural bottlenecks closed:**

1. **O(n) full cache re-decode on every `loadAll`** — every triggered load (30 s poll, `visibilitychange`, metadata event, Megolm share event) re-ran `decodeAndVerify` across all 500 cached blobs regardless of whether they had already been decrypted. Added a module-level `plaintextCache: Map<string, DecodedBlob>` keyed by blob ID. `loadAll` checks the cache first; only new blobs or previously-failed ones (`missingKey: true`) go through crypto. Verified results are written back. `onDelete` evicts the entry. Reduces per-poll crypto work from O(cache_size) to O(new_or_failed_blobs).

2. **IDB cursor advancement during batch re-decodes** — `resolveMegolmMessageKey` called `deriveMessageKeyAtIndexAndAdvance` unconditionally, writing the advanced cursor to IDB after every decode pass. On the next `loadAll` call, cached v4 messages with `messageIndex < new cursor` failed the IDB guard and fell through to a live `fetchMegolmShareForSession` server round trip — one per unique session per poll cycle. Fixed by adding a `readOnly` parameter to `resolveMegolmMessageKey` and `decodeAndVerify`. Batch re-decode paths (`loadAll` allCached loop, `loadEarlier`) pass `readOnly = true` and use `deriveMessageKeyAtIndex` (non-mutating). Cursor advancement via `deriveMessageKeyAtIndexAndAdvance` + `putInboundSession` is now strictly reserved for `ingestBlobRow` (the live realtime path).

3. **Missing-key retry feedback loop** — when a realtime blob arrived with `missingKey: true`, `ingestBlobRow` armed a flat 1000 ms timer that fired `loadAll`. Each new message before the key arrived reset the timer, and once `loadAll` ran it posted key-forward requests and exited — but the next incoming blob restarted the cycle, keeping `loadAll` running back-to-back in active rooms. Replaced with exponential backoff: `min(500ms × 2^retryCount, 5000ms)`. Counter increments on each missing-key blob, resets to 0 on a successful decode in `ingestBlobRow` (non-missing wave) and when `subscribeMegolmShares` fires (key arrived). Once key-forward requests are posted, no further retries are scheduled from `loadAll` — the `subscribeMegolmShares` subscription is the authoritative trigger for re-decode after a key arrives.

**Files changed:**

- `src/app/rooms/[id]/page.tsx` — all three fixes above

**Matrix alignment notes:**

- `readOnly` decode matches libolm / vodozemac's distinction between "batch decrypt for history replay" (no state mutation) and "live decrypt" (advance ratchet state). Batch replay must not mutate state so that the live cursor remains correct and the same session can be re-decoded without server round trips.
- `plaintextCache` is intentionally module-level (not `useRef`) so it survives room navigation within the same tab session. Orphaned entries for deleted blobs waste a bounded amount of memory (UUIDs not reused); `onDelete` evicts proactively. Plaintext is in JS heap only — not persisted to IDB or cache-store — preserving the ciphertext-only persistence invariant.
- Exponential backoff with a 5 s cap and subscription-driven reset matches Signal's key-request retry semantics: don't spam the server, but recover promptly when the responder replies.

**V2 porting notes:**

- `plaintextCache` is module-level in `page.tsx`. If you split the room page into sub-modules, promote it to the module that owns `decodeAndVerify`.
- Pass `readOnly = true` to any `decodeAndVerify` call that is re-processing previously-seen blobs. Pass `readOnly = false` (or omit, it's the default) only for fresh realtime blobs where ratchet advance is correct.
- The `missingKeyRetryCountRef` resets are load-bearing: without the reset in `subscribeMegolmShares`, a room that receives one wave of missing-key blobs and then recovers will take up to 5 s to retry for the next unrelated missing-key event.

---

### 2026-04-19 — PERF: loadAll serialization, O(1) ratchet cursor, stable Map prop, virtualised timeline

**No migrations required.** Pure JS/React changes; safe to apply to any existing deployment.

**Background — three architectural bottlenecks closed:**

1. **`loadAll` concurrent invocations** — five async sources (RT metadata subscription, 30 s poll, `visibilitychange`, Megolm shares subscription, missing-key debounce) could fire `loadAll` simultaneously, racing on `setBlobs` / `setRoomKeysByGen`. Fixed with a serialization guard: a second caller while a load is in flight sets a pending flag; after the first finishes it re-runs exactly once.

2. **O(n²) Megolm ratchet loop** — `resolveMegolmMessageKey` called `deriveMessageKeyAtIndex` and discarded the intermediate chain state. On the next `loadAll` the same IDB snapshot was read with `startIndex=0`, re-running the full ratchet loop for every message. For a 500-message session: ~125 000 WASM HMAC calls per page load. Fixed by adding `deriveMessageKeyAtIndexAndAdvance` to `megolm.ts` — derives the message key and returns the session snapshot advanced to `targetIndex+1` in one pass. The resolver writes the advanced snapshot to IDB so subsequent decrypts start at the current index (O(1) per already-seen message). The `Promise.all(allCached.map(...))` batch in `loadAll` and `loadEarlier` is replaced with sequential iteration to eliminate the IDB cursor race that parallel writes created.

3. **Spurious BlobFeed re-renders and unbounded DOM** — `setRoomKeysByGen(new Map(byGen))` produced a new Map object on every `loadAll`, triggering a full BlobFeed reconcile even when no generation changed. BlobFeed also rendered all messages as a flat DOM list with no virtualisation. Fixed with: (a) a `stableRoomKeysByGen` memo keyed on the sorted generation list, (b) `@tanstack/react-virtual` virtualised scroll container — only visible rows are in the DOM, (c) initial load capped at 50 messages (was 500), (d) `loadEarlier` trims the in-memory list at 300 total to bound memory, (e) scroll-to-top replaces the manual "load earlier" button.

**Files changed:**

- `src/lib/e2ee-core/megolm.ts` — new export `deriveMessageKeyAtIndexAndAdvance`
- `src/app/rooms/[id]/page.tsx` — all five fixes above
- `package.json` / `package-lock.json` — added `@tanstack/react-virtual`

**Matrix alignment notes:**

- Ratchet cursor persistence matches libolm / vodozemac: the stored inbound session reflects the highest-decrypted index, not the original snapshot start index. Recipients that join mid-session receive a snapshot at the current index; earlier messages remain undecryptable (forward secrecy by design).
- Sequential decode (no `Promise.all`) mirrors Element Web's serial event-queue processing. Eliminates a class of IDB write races without sacrificing throughput — with O(1) ratchet, per-message cost is one IDB read + one HMAC + one ChaCha20 decrypt.
- Virtualised windowed timeline matches the Matrix "windowed timeline" concept: a fixed live window with backwards pagination that evicts from the live end when the prepend buffer exceeds 300 rows.
- Plaintext is never persisted (neither in IDB nor in the blob cache). Ciphertext-only invariant preserved.

**V2 porting notes:**

- Copy the updated `megolm.ts` in full — `deriveMessageKeyAtIndexAndAdvance` is a new public API.
- `BlobFeed` now requires three additional props: `onLoadEarlier: () => void`, `loadingEarlier: boolean`, `hasMoreHistory: boolean`. If you rewrite the message-feed UI, replicate the scroll-trigger pattern and the 300-row trim in `loadEarlier`.
- The 50-message initial load and 300-row memory cap are conservative for the current prototype scale. Tune via the literal constants in `loadAll` (`listBlobs(roomId, 50)`) and `loadEarlier` (`combined.length > 300`) — larger values are safe; smaller values increase pagination frequency.
- `@tanstack/react-virtual` is now a required dependency. Pin to the same minor version to avoid virtualiser API drift.

**Delta sync documentation update** (supersedes the note in §14):
- First visit: `listBlobs(roomId, 50)` — was 500. Cursor is set after the 50-row seed; subsequent `loadAll` calls fetch only new rows via `listBlobsAfter`.
- `loadEarlier` still fetches 100 rows at a time from the server via `listBlobsBefore`, but now trims the in-memory list to 300 rather than growing without bound.

---

### 2026-04-19 — SECURITY: ghost-membership via mismatched device_id/user_id in kick_and_rotate

**Migration to apply:** `0040_kick_rotate_device_ownership_check.sql`

**Root cause:** `kick_and_rotate` validated that `p_signer_device_id` is owned by the caller but applied no ownership constraint to the `(user_id, device_id)` pairs inside the `p_wraps` JSON array. A malicious room creator could call the RPC with wrap entries where `device_id` belongs to an attacker-controlled device while `user_id` names a victim user. Three consequences:

1. **Metadata leak after effective eviction.** `my_generations_for_room` is user-keyed (`WHERE user_id = auth.uid()`). A poisoned row with `user_id=Victim` causes the victim to pass the `room_members_read` RLS generation arm — letting them SELECT all new-gen `room_members` rows (other members' wrapped-key ciphertext) and all new blobs — even though their actual devices hold no usable key.
2. **Attacker gets a second room-key copy.** The wrap sealed to the attacker's device is stored under the victim's `user_id` label; the attacker can decrypt the room key from their own device while the victim's real devices find no row at all.
3. **No client-side tamper signal.** The `wrap_signature` for the mismatched row is cryptographically valid (the creator's device signs over the stated fields), so `verifyMembershipWrap` passes; the victim only learns something is wrong when `unwrapRoomKey` fails to open the sealed box.

**What changed:**

- **Migration 0040** adds an ownership check inside the `kick_and_rotate` wrap loop, immediately after the null/malformed-field check:
  ```sql
  if not exists (
    select 1 from devices
    where id = v_wrap_device and user_id = v_wrap_user and revoked_at_ms is null
  ) then
    raise exception 'wrap entry: device % does not belong to user % or is revoked', ...
  ```
  No schema change; pure function replacement.

**V2 port actions:**
- Apply migration 0040. It is a pure `CREATE OR REPLACE FUNCTION` — no schema change, no data migration.
- If you have a custom version of `kick_and_rotate`, add the equivalent ownership check to your wrap loop. Any SECURITY DEFINER RPC that inserts `room_members` rows must independently verify `devices.user_id = room_members.user_id` — the FK on `device_id` only checks existence, not ownership.

---

### 2026-04-19 — Fix: restore creator arm in room_members_insert

**Migration to apply:** `0039_restore_creator_arm_room_members_insert.sql`

**Root cause:** Migration 0038 dropped the `created_by = auth.uid()` arm from `room_members_insert` on the grounds that `kick_and_rotate` (SECURITY DEFINER) handles all post-creation membership inserts. That reasoning is correct for rotations but misses the initial room-creation path: `createRoom → wrapRoomKeyForAllMyDevices → addRoomMember` is a direct client-side insert. For a brand-new room the caller has no outstanding invite and is not yet a current-gen member, so both 0038 arms fail. `wrapRoomKeyForAllMyDevices` catches the RLS error per-device and warns without re-throwing, so the caller receives an in-memory `RoomKey` with no corresponding `room_members` row. Any subsequent blob insert then fails (42501) because `blobs_member_insert` checks `room_members` for the user at that generation.

**What changed:**

- **Migration 0039** adds arm *(c)* back to `room_members_insert`: `created_by = auth.uid()` on the parent room. This is safe because `kick_and_rotate` is creator-only — a creator can never be evicted by other members — so this arm does not reopen the post-eviction re-insertion hole closed by 0038. A creator who self-leaves (kick_and_rotate with themselves as evictee) retaining the ability to re-add themselves is consistent with room ownership.

**V2 port actions:**
- Apply migration 0039. Pure RLS policy replacement — no schema change, no data migration.
- If you applied 0038 and created rooms in the gap period, those rooms have no creator `room_members` row. Delete and recreate them, or use `kick_and_rotate` (which is SECURITY DEFINER) to bootstrap a new generation with correct membership.

---

### 2026-04-19 — CRITICAL: post-eviction self-re-insertion + rotator ghost-row gap

**Migrations to apply:** `0038_tighten_room_members_insert_policy.sql`

**Root cause (two related vulnerabilities):**

1. **Post-eviction self-re-insertion (HIGH).** The `room_members_insert` RLS policy (set in migration 0008) allowed `user_id = auth.uid()` with no generation or membership constraint. A user who was kicked via `kick_and_rotate` retained a valid Supabase session and could immediately re-INSERT themselves into `room_members` at the new current generation with arbitrary (garbage) content. Because `rotateOneRoomAsAdmin` builds its re-wrap list by reading raw `room_members` rows, the re-inserted user would be included in the next admin rotation and receive a valid new-generation room key — restoring their access without any invite or crypto ceremony.

2. **Rotator does not verify existing member row signatures (HIGH).** `rotateOneRoomAsAdmin` and `verifiedMemberDevices` in `bootstrap.ts` collected re-wrap targets by calling `listRoomMembers` then `fetchAndVerifyDevices` per user. They verified device certificates but never called `verifyMembershipWrap` on the existing `room_members` rows. A ghost row (injected via service_role bypassing RLS, or via the self-re-insert above) with any or null `wrap_signature` passed through silently. The intent of migration 0011's signed-membership defense — that rows with unverifiable signatures must be rejected — was enforced only at key-load time (when the receiving device unwraps its own key), not at rotation time when the rotator decides whom to re-wrap for.

**What changed:**

- **Migration 0038** rewrites `room_members_insert` to two narrow arms:
  - *(a)* Device has a valid outstanding invite for this room (`invited_device_id` match + `expires_at_ms` check) — the standard accept-invite path.
  - *(b)* Caller is already a current-generation member (`is_room_member_at(room_id, auth.uid(), room_current_generation(room_id))`) — covers co-device self-wrap (`wrapRoomKeyForAllMyDevices`) and sibling-device key-forwarding (`respondToKeyForwardRequests`, which inserts at historical generations — the generation constraint is intentionally absent from this arm). The creator arm is dropped entirely: `kick_and_rotate` is `SECURITY DEFINER` and bypasses RLS; no direct-insert path in the codebase requires it.

- **`rotateOneRoomAsAdmin` (bootstrap.ts)** — after filtering to current-gen rows, batch-fetches signer Ed25519 pubs via `fetchDeviceEd25519PubsByIds` and calls `verifyMembershipWrap` on every row. Rows whose signature does not verify (ghost rows, garbage self-re-inserts) are silently excluded from `keeperUserIds` and therefore receive no key in the next generation.

- **`verifiedMemberDevices` (bootstrap.ts)** — same verification pass applied to the call-key and Megolm session distribution path. Ghost rows no longer receive call-key envelopes or session shares.

- **`RoomMemberRow.signer_device_id`** type corrected from `string` to `string | null` in `queries.ts` to match the DB state after migration 0037 (`ON DELETE SET NULL`).

**V2 port actions:**
- Apply migration 0038 before deploying. It is a pure RLS policy replacement — no schema change, no data migration needed.
- If you have a custom `room_members_insert` policy, verify it enforces the same two conditions. An unconstrained `user_id = auth.uid()` arm is the attack surface; remove it.
- Ensure any code path that determines "who to re-wrap for" during key rotation calls `verifyMembershipWrap` on existing rows before including users in the wrap target list. Relying solely on device-cert verification (`fetchAndVerifyDevices`) is insufficient — it proves the device is legitimate but not that its `room_members` row was legitimately written.

### 2026-04-18 — CRITICAL: wrap-signature verification bypass + nuke FK fix

**Migration to apply:**
- `0036_signer_device_id_on_delete_set_null.sql` — changes `room_members.signer_device_id` FK from `ON DELETE RESTRICT` to `ON DELETE SET NULL`. Required: without this, `nuke_identity` raises FK violation 23503 when other users' `room_members` rows still reference a device belonging to the nuked user as `signer_device_id`. The SET NULL semantics mean a null signer is treated the same as an unresolvable signer — the client rejects the row.

**Root cause (CRITICAL — ghost key injection):** The `wrap_signature` field added in migration 0011 was only verified at one callsite (`rooms/[id]/page.tsx`) and even there incorrectly: the `unwrapRoomKey` call sat *outside* the `if (signerPub)` guard, so a missing signer would fall through and decrypt the row anyway — rendering the signature check an effective no-op. All other callsites (`rooms/page.tsx`, `CallChatPanel.tsx`, `PendingApprovalBanner.tsx`, `status/page.tsx`, `bootstrap.ts`) used `getMyWrappedRoomKey` which returned only `wrapped_room_key` with no signature fields, so verification was structurally impossible. A Supabase service-role attacker (or malicious RLS bypass) could have injected a `room_members` row with arbitrary `wrapped_room_key` content that would be silently accepted by every client. `PendingApprovalBanner.tsx` was especially dangerous: on approval it re-wraps the corrupt key for the newly-enrolled device, spreading the injection to every future device.

**`src/lib/supabase/queries.ts`:**
- **New:** `getMyRoomKeyRow({ roomId, deviceId, generation })` — fetches `wrapped_room_key, signer_device_id, wrap_signature, user_id` for a single `(room_id, device_id, generation)` row. `signer_device_id` typed `string | null` (SET NULL FK). This is the canonical fetch for verified unwrap.

**`src/lib/bootstrap.ts`:**
- **New export:** `verifyAndUnwrapMyRoomKey({ roomId, userId, device, generation })` — the single verified-unwrap path. Calls `getMyRoomKeyRow`, rejects null signer (`signer_device_id = null` means the signing device was deleted — row unverifiable, throws), batch-resolves the signer's Ed25519 pub via `fetchDeviceEd25519PubsByIds`, calls `verifyMembershipWrap`, then unwraps. Returns `RoomKey | null` (null = no row). Throws on verification or decrypt failure — callers must not silently swallow these.
- **Fixed:** `rotateOneRoomAsAdmin` and `respondToKeyForwardRequests` — both replaced bare `getMyWrappedRoomKey` + `unwrapRoomKey` with `verifyAndUnwrapMyRoomKey`.

**`src/app/rooms/[id]/page.tsx`:**
- **Fix (critical):** The `unwrapRoomKey` call is now inside the signer-pub guard, not outside it. A row with no resolvable signer pub is now skipped with `continue` rather than decrypted anyway.

**`src/app/rooms/page.tsx`:**
- **Fixed:** Room-name decrypt and invite-send paths both replaced with `verifyAndUnwrapMyRoomKey`. A corrupt key sealed into an outgoing invite would have spread to the invitee.

**`src/components/CallChatPanel.tsx`:**
- **Fixed:** Key-load loop now batch-resolves signer pubs, calls `verifyMembershipWrap` per row, and `continue`s on missing signer — matching the fix in `rooms/[id]/page.tsx`. Previously fetched signature fields from `listMyRoomKeyRows` but never read or verified them.

**`src/components/PendingApprovalBanner.tsx`:**
- **Fixed (highest-risk callsite):** Replaced `getMyWrappedRoomKey` + `unwrapRoomKey` with `verifyAndUnwrapMyRoomKey`. On device approval, this iterates ALL rooms and re-wraps keys for the new device — an unverified corrupt key here would have spread silently to every newly-enrolled device.

**`src/app/status/page.tsx`:**
- **Fixed:** Both diagnostic-test callsites replaced with `verifyAndUnwrapMyRoomKey`.

---

### 2026-04-18 — Security fixes: u64BE timestamp truncation + wrap signature verification (partial — superseded by entry above)

**No new migrations.** All changes are client-side only.

**`src/lib/e2ee-core/membership.ts`, `device.ts`, `sas.ts`:**
- **Fix:** `u64BE(n)` was encoding `BigInt(n | 0)` — `ToInt32` coercion silently discarded the upper 32 bits of any millisecond-epoch timestamp before the BigInt conversion. This meant only the lower 32 bits of `expiresAtMs`, `createdAtMs`, and `revokedAtMs` were covered by their respective Ed25519 signatures. Changed to `BigInt.asUintN(64, BigInt(Math.trunc(n)))` in all three files.
  - **Impact on existing signed material:** Any cert, revocation, or invite envelope signed with the old code will fail verification against new code (the canonical message is different). Existing enrolled devices and pending invites will need to be re-issued after deploying. In practice, `Math.trunc(n) % 2^32 === n % 2^32` for non-negative integers, so the lower 32 bits are identical — only certs where `createdAtMs >= 2^32 ms` (never, epoch is ~1.74e12) would have had a wrong lower half. The real bug was the *upper 32 bits* being zeroed; the canonical messages change because `BigInt(n | 0)` for current timestamps produces a different BigInt than `BigInt(Math.trunc(n))` when the sign bit of the 32-bit residue is set (i.e., the 31st bit is 1, which happens periodically). **You must re-enroll devices and re-invite members after deploying this fix.**

**`src/lib/supabase/queries.ts`:**
- **Extended:** `listMyRoomKeyRows` now selects `user_id, signer_device_id, wrap_signature` alongside `generation` and `wrapped_room_key`. Return type updated accordingly.
- **New:** `fetchDeviceEd25519PubsByIds(deviceIds)` — batch-fetches `device_ed25519_pub` for a set of device IDs in one query. Used by the wrap-signature verification path.

**`src/app/rooms/[id]/page.tsx`:**
- **Fix (partial — see critical fix above for the complete correction):** The key-load loop now verifies `wrap_signature` on each `room_members` row before accepting it. Batch-resolves signer Ed25519 pubkeys via `fetchDeviceEd25519PubsByIds`, then calls `verifyMembershipWrap` for each row. Rows that fail verification are rejected. NOTE: the original version of this entry stated "a missing signer device row logs a warning but does not block load" — that was incorrect; missing signer now throws/rejects via `verifyAndUnwrapMyRoomKey`.
- **Removed:** Dead `void verifyMembershipWrap` expression and its stale comment.

---

### 2026-04-18 — Megolm session resolution hardening (race fix + key-forward correctness)

**No new migrations.** All changes are client-side only.

**`src/lib/supabase/queries.ts`:**
- **New:** `fetchMegolmShareForSession({ sessionId, recipientDeviceId })` — targeted single-row lookup on `megolm_session_shares` by `(session_id, recipient_device_id)`. No room-id join needed; `session_id` is globally unique. Used by the two server-fallback paths below.

**`src/app/rooms/[id]/page.tsx`:**
- `resolveMegolmMessageKey` now accepts `device: DeviceKeyBundle` and gains a **server-side fallback path**: on IDB miss, calls `fetchMegolmShareForSession`, unseals the snapshot, writes it to IDB via `putInboundSession`, then derives the message key inline. Eliminates the **first-message Megolm race** where a realtime blob notification arrived before the session share had been hydrated into IDB — the message would display as undecryptable for up to 1 second then fix itself. The 1-second `missingKeyReloadRef` retry remains as a safety net for the edge case where the share write is literally in-flight.

**`src/lib/bootstrap.ts`:**
- `respondToKeyForwardRequests` — two correctness fixes:
  1. **Outbound session ID guard (Bug A):** The outbound-session branch now verifies `outbound.sessionId === req.session_id` before exporting. Previously, if the session had been rotated (100 messages or 7 days), `getOutboundSession` returned the *current* session (S2) while the forward request was for the old session (S1). The code exported S2's key material but stored it under S1's `session_id` — a corrupt share that would silently fail to decrypt. With the guard, a mismatch sets `snapshot = null` and the existing `if (!snapshot) continue` skips cleanly.
  2. **Inbound IDB fallback (Bug B):** The inbound-session branch now falls back to `fetchMegolmShareForSession` + unseal + `putInboundSession` when `getInboundSession` misses. Previously, if the responder device held the share in `megolm_session_shares` on the server but hadn't run `loadAll` for that room recently, the forward request was silently skipped and the requester never got the key. Same server-fallback pattern as the `resolveMegolmMessageKey` fix above.
- `putInboundSession` and `unsealSessionSnapshot` added to the top-level e2ee-core static import (were previously only in a dynamic import inside `restoreSessionsFromBackup`).

**Auth callback (`src/app/auth/callback/page.tsx`):**
- PIN setup `onSave` handler now clears all four plaintext IDB stores (`deviceBundle`, `userMasterKey`, `selfSigningKey`, `userSigningKey`) immediately after `putWrappedIdentity`. Previously, the stores remained populated after PIN setup so any page load before the first explicit "lock now" could access plaintext keys without entering the PIN. The device is now locked from the moment setup completes.

---

### 2026-04-19 — CRITICAL: post-eviction self-re-insertion + rotator ghost-row gap

See full entry at the top of this section. Migrations: `0038_tighten_room_members_insert_policy.sql` then `0039_restore_creator_arm_room_members_insert.sql`.

---

### 2026-04-18 — Matrix-aligned key forwarding, backup restore, multi-device healing

**Migrations to apply (in order):**
- `0035_key_forward_requests.sql` — adds `key_forward_requests` table. A device that can't decrypt a Megolm session posts a row here; sibling devices (same user) see it via realtime and respond by inserting `megolm_session_shares` rows. Also adds `megolm_session_shares` to the realtime publication (required for the subscriber to wake immediately). Required for cross-device session healing.

**Updated foundation files to copy (`src/lib/bootstrap.ts`):**
- `respondToKeyForwardRequests(userId, device)` — new export. Polls `key_forward_requests` for the user, finds the session in IDB (as outbound or inbound snapshot), seals it to the requester's X25519 pub, signs the share, **inserts the `room_members` row for the requester first** (so the room key is present before `megolm_session_shares` triggers the requester's `loadAll`), then inserts the session share. Room key forwarding ensures image attachments (room-key encrypted) also decrypt — not just text.
- `restoreSessionsFromBackup(userId)` — return type extended to include `roomKeys: Array<{roomId, generation, key}>`. Flat-key room key backup rows (`session_id = null` in `key_backup`) are now decrypted and returned alongside Megolm session restorations. **Previously these rows were fetched but silently ignored**, which is why image attachments couldn't decrypt on a new device even when text messages could (text uses Megolm session from backup; images need the room key).

**Updated contracts in `src/lib/supabase/queries.ts`:**
- **New:** `KeyForwardRequestRow` interface + `insertKeyForwardRequest`, `listKeyForwardRequestsForUser`, `listMyPendingKeyForwardRequests`, `deleteKeyForwardRequest`, `subscribeKeyForwardRequests` — full CRUD + realtime for `key_forward_requests`.
- **New:** `MegolmSessionInfoRow` interface + `fetchMegolmSessionInfo(sessionId)` — looks up `(room_id, sender_device_id, generation)` from `megolm_sessions` by session_id. Used by `respondToKeyForwardRequests` to find the sender so it can look up the IDB snapshot.
- **New:** `subscribeMegolmShares(deviceId, onRow)` — realtime INSERT subscription on `megolm_session_shares` filtered to `recipient_device_id`. Required: the receiving device needs to know immediately when a share arrives so it can re-run `loadAll` and decode previously-failing blobs.
- **New:** `listMyPendingKeyForwardRequests(deviceId)` — returns forward requests posted BY this device that haven't been answered yet. Used by the debug panel.

**Room page (`src/app/rooms/[id]/page.tsx`):**
- `loadAll` now calls `respondToKeyForwardRequests` at start — phones respond to pending requests on every page load.
- `subscribeKeyForwardRequests` effect added — phone responds immediately via realtime when the laptop posts a new request, rather than waiting for the next `loadAll` tick.
- `subscribeMegolmShares` effect triggers `loadAll` when a new share arrives — the requester re-decodes immediately.
- Proxy forward requests for missing-room-key generations: for flat-key blobs with no `session_id` (images), find any `session_id` from the same generation and use it as a proxy request — the responder forwards both the session and the room key.
- `resolveMegolmMessageKey` simplified to IDB-only (removed `listMegolmSharesForDevice` server fallback that was firing for every failing blob on every `loadAll` — **22 extra network roundtrips per 30-second poll**). `loadAll` already hydrates all shares into IDB before decoding.
- Backed-up room keys (from `restoreSessionsFromBackup`) merged into `byGen` after backup restore, so generations with no `room_members` row but a backup entry can decrypt image attachments.

**Key architectural insight (document for V2):** backup restores Megolm sessions (text) and room keys (images) separately. Megolm sessions restore text. Room keys restore the ability to decrypt image attachment bytes. Both must be restored — if only sessions are restored, text shows but images don't. `restoreSessionsFromBackup` now handles both; `loadAll` merges the room keys into `byGen`.

**Known limitation — old messages unrecoverable on new devices (parked):** A new device enrolled after several room rotations may find some historical messages and image attachments permanently undecryptable. Root causes, in order of impact:

1. **Pre-0027 outbound sessions lost from IDB.** The phone's own outbound Megolm sessions for old generations are overwritten in IDB when a new session is created. If the sibling device was the sender, it can no longer forward the session. The `fetchSessionInfoFromBlobs` fallback recovers the `sender_device_id` from a blob row, but if no IDB snapshot exists there is nothing to forward.

2. **Pre-0027 room key backups absent.** Room keys for early generations were created before `encryptRoomKeyForBackup` was wired into `wrapRoomKeyForAllMyDevices`. Those generations have no `key_backup` rows, so `restoreSessionsFromBackup` returns zero room keys for them. Image attachments (room-key encrypted) from those generations cannot decrypt even when their Megolm blob headers can.

3. **`key_forward_requests` is intra-user only.** The RLS policy `user_id = auth.uid()` means only sibling devices (same user account) can see and respond to requests. The other user in a chat cannot receive the request and cannot forward their own sessions.

**Practical impact:** text and images sent after migration 0027 and after `encryptRoomKeyForBackup` was wired up are fully recoverable on any new sibling device. Content from the very early prototype period (gens 1–12 in the test room) is not. This is acceptable forward-secrecy behaviour — V2 will not have this gap because 0027 and room key backup both apply from day one.

---

### 2026-04-18 — Phase 1–4 (sync fixes, ToS gate, room UX, Matrix-aligned local cache)

**Migrations to apply (in order):**
- `0033_room_limit.sql` — enforces a per-user room cap via a DB trigger. Required; the room-creation RPC will reject inserts without it.
- `0034_tos_acceptances.sql` — adds `tos_acceptances (user_id, accepted_at)`. Required if you're using the ToS gate; harmless to apply if you're not.

**New foundation files to copy:**
- `src/lib/cache-store.ts` — Matrix-aligned local blob cache (separate `vibecheck-cache` IndexedDB). See §14 for full architecture. Wire into your room page the same way `src/app/rooms/[id]/page.tsx` does.
- `src/components/TosModal.tsx` — ToS acceptance modal + gate. Copy if your app needs a ToS flow; skip if not.

**Updated contracts in `src/lib/supabase/queries.ts`:**
- **New:** `listBlobsAfter(roomId, fromCreatedAt)` — delta-fetch blobs at-or-after a cursor timestamp.
- **New:** `listBlobsBefore(roomId, beforeCreatedAt, limit)` — backward pagination for "load earlier messages".
- **New:** `hasTosAccepted(userId)` + `acceptTos(userId)` — ToS gate helpers. Only needed if you're using the ToS flow.

**Updated auth callback (`src/app/auth/callback/page.tsx`):**
- `handleNuclearConfirmed` now calls `wipeAppCache()` (from `cache-store.ts`) before the nuke sequence. If you've already ported `auth/callback/page.tsx`, add this call — without it, stale ciphertext from the old identity accumulates with no keys to decrypt it.

**Room page (`src/app/rooms/[id]/page.tsx`):**
- Full cache integration — `loadAll` uses delta sync via `listBlobsAfter`, `ingestBlobRow` writes to cache, `loadEarlier` falls back to server. See §14 for the pattern. If you've already ported this page, the old `listBlobs`-on-every-load approach still works but skips the cache performance wins.

---

## 1. Bring the core module across

Copy these things verbatim:

- `src/lib/e2ee-core/` — the crypto module (approval + recovery + room-name sealing + image attachments + signed-membership primitives + passphrase lock)
- `supabase/migrations/0001_init.sql` — core schema + RLS
- `supabase/migrations/0002_device_approval_and_recovery.sql` — device_approval_requests + recovery_blobs (needed for the code-approval device-sync UX and phrase-based account recovery)
- `supabase/migrations/0003_room_name.sql` — adds `name_ciphertext` + `name_nonce` to `rooms` for encrypted display names (see §5)
- `supabase/migrations/0004_room_delete.sql` — adds the `rooms_creator_delete` RLS policy so creators can tear a room down (cascades all children)
- `supabase/migrations/0005_tighten_handoff_rls.sql` — replaces the permissive `handoffs_any_authed` policy with `handoffs_owner_all` so only the user whose device is linking can read/write/delete their `device_link_handoffs` rows. Blocks cross-account enumeration and DoS against the QR/approval-code linking flow. Must be applied alongside the initial schema.
- `supabase/migrations/0006_attachments_bucket.sql` — creates the private `room-attachments` Storage bucket and RLS policies gating access by the `{roomId}/{blobId}.bin` path prefix. Current-gen members can INSERT; any-gen members can SELECT; room creator + current-gen members can DELETE. Required for encrypted image attachments — see §10 below.
- `supabase/migrations/0007_pair_cap_and_admin_delete.sql` — two rules baked into the DB: (a) pair rooms are strictly 2 people, enforced by a trigger on `room_members` + `room_invites` that counts distinct users and rejects a 3rd. (b) only the room creator (admin) may delete OR insert other users' `room_members` rows — previously any current-gen member could, which let non-admins kick each other. Self-delete (a user leaving their own rows) stays open so the "leave" flow works. See §11 for the admin model.
- `supabase/migrations/0008_backport_live_helpers.sql` — back-ports two previously-live-only migrations (`rooms_creator_can_read_own`, `fix_room_members_recursion`). Adds the SECURITY DEFINER helpers `is_room_member_at`, `room_current_generation`, and `my_room_ids` used by subsequent policies to avoid RLS recursion.
- `supabase/migrations/0009_atomic_kick_and_rotate.sql` — ships the `kick_and_rotate` RPC (atomic delete-evictee-first / insert-new-gen / bump-gen sequence), tightens `room_members_read` to same-generation scope via `my_generations_for_room`, and drops `room_members` from the realtime publication.
- `supabase/migrations/0010_approval_attempt_limiter.sql` — adds `failed_attempts` to `device_approval_requests` and a SECURITY DEFINER `verify_approval_code` RPC that atomically compares, increments on miss, and deletes on the 5th miss. Shortens default TTL to 2 minutes.
- `supabase/migrations/0011_signed_membership.sql` — adds nullable `inviter_signature` + `invited_ed25519_pub` + `expires_at_ms` columns on `room_invites` and nullable `signer_user_id` + `wrap_signature` on `room_members`. Extends `kick_and_rotate` to persist the per-wrap signature. **V2 port action: after users re-accept their invites and rotate their rooms, change these columns to NOT NULL and delete any remaining legacy unsigned rows to lock out ghost-user injection.**
- `supabase/migrations/0012_identity_epoch.sql` — adds `identities.identity_epoch` with a BEFORE-UPDATE trigger that bumps it whenever the published ed/x pubkeys change. Binds `device_approval_requests.identity_epoch` so approval rows across a master-key rotation are auto-invalidated.
- `supabase/migrations/0013_auto_rotate_and_purge.sql` — adds `rooms.last_rotated_at` (used by the admin UX to hint at stale keys) and extends `kick_and_rotate` to DELETE all `room_members` rows at `generation < new_gen - 1` in the same transaction. Provides lazy generation-granular forward secrecy: an attacker who later steals DB ciphertext cannot resurrect room keys older than the previous generation.
- `supabase/migrations/0014_blob_signature_nullable.sql` — makes `blobs.signature` nullable. New (v2) blobs carry the Ed25519 signature INSIDE the AEAD payload; the outer column is left null so the server no longer sees a per-sender fingerprint linkable across blobs. Legacy v1 blobs remain decryptable via the outer-signature fallback in `decryptBlob`.
- `supabase/migrations/0015_per_device_identities.sql` — **structural pivot to per-device identities.** `identities.ed25519_pub` becomes the User Master Key (UMK) pub; `x25519_pub` + `self_signature` are retired (nullable for compat). `devices` rows now carry each device's own ed25519/x25519 pubs plus a UMK-issued issuance cert (and optional UMK-signed revocation). `room_members` keys on `(room_id, device_id, generation)` — the room key is wrapped to each recipient DEVICE, not each user. `room_invites` gains `invited_device_id` + `inviter_device_id`. `blobs` gains `sender_device_id`. `kick_and_rotate` rewritten to accept per-device wraps + a `signer_device_id`. Linked devices no longer receive a copy of the root identity; each generates its own bundle locally, and the UMK holder (primary device) signs its cert. See `src/lib/e2ee-core/device.ts`, `src/lib/e2ee-core/membership.ts`, and `src/lib/bootstrap.ts` for the cert primitives and enrollment helpers.
- `supabase/migrations/0016_display_name_and_not_null.sql` — (1) encrypts `devices.display_name` at rest via `display_name_ciphertext` (sealed-box-to-self; each device encrypts its own label to its own x25519 pub so the Supabase operator no longer sees "Sam's iPhone"). Other co-devices of the same user see the row but can't decrypt the label — UI falls back to `device_id` + `created_at`. (2) sets NOT NULL on `room_invites.invited_ed25519_pub`, `room_invites.inviter_signature`, `room_invites.expires_at_ms`, `room_invites.invited_device_id`, `room_invites.inviter_device_id`, `room_members.signer_device_id`, `room_members.wrap_signature` — the legacy-nullable grace window that Fix 5 opened is now closed.
- `supabase/migrations/0017_public_read_devices.sql` — splits `devices_self_all` (owner-only for everything) into `devices_read_all` (public SELECT) + per-operation owner-only write policies. Required for v3: peer clients need to read each other's device_ed25519_pub / device_x25519_pub / issuance_signature to verify certs and wrap room keys. Device rows carry public key material + UMK-signed certs + an opaque `display_name_ciphertext` — all safe to expose.
- `supabase/migrations/0018_purge_stale_invites_on_rotate.sql` — extends `kick_and_rotate` to DELETE `room_invites` at `generation < new_gen` in the same transaction. Closes a race where a stale invite (wrapping a superseded gen's key) could be accepted after a rotation, leaving the invitee with a row that's immediately purged by the next rotation's FS cleanup.
- `supabase/migrations/0019_retain_10_generations.sql` — widens the FS purge window from 2 gens to 10. `kick_and_rotate`'s purge clause is now `< p_new_gen - 9`. Returning members on a fresh session can decrypt ~9 rotations of past history instead of ~1. Retrospective-only security surface (sealed bytes remain opaque at rest).

- `supabase/migrations/0020_nullable_linking_pubkey.sql` — drops NOT NULL on the legacy `device_approval_requests.linking_pubkey` column (v3 approval flow doesn't populate it; was blocking mobile sign-in).

- `supabase/migrations/0021_blob_self_delete.sql` — single RLS policy `blobs_sender_delete` letting a user DELETE their own blob rows (messages + images). SELECT/INSERT policies already enforce room membership; this adds the matching DELETE so the "unsend" UX has a path. Load-bearing for sender-controlled deletion; without it, the server is the only actor that can remove a sent blob.

- `supabase/migrations/0022_key_backup.sql` — adds the server-side room-key backup table (Matrix-style key-backup). `key_backup (user_id, room_id, generation, ciphertext, nonce)` stores per-generation room keys encrypted under a user-scoped 32-byte backup key. RLS: `key_backup_owner` locks SELECT/INSERT/UPDATE/DELETE to `user_id = auth.uid()`. Also adds nullable `devices.backup_key_wrap` — a sealed (`crypto_box_seal`) copy of the backup key, written by the approving device and picked up by the newly-enrolled device so it can pull and decrypt the backup on first load. The backup key itself is escrowed inside the v3 recovery blob (see §12) so recovery-phrase entry on a fresh device recovers both UMK priv AND backup key.

- `supabase/migrations/0024_one_active_call_per_room.sql` — partial unique index on `calls (room_id) WHERE ended_at IS NULL`. Prevents two simultaneous `start_call` RPCs from producing parallel active calls. The first one wins; the second falls back to joining the winner. Migration also cleans up any pre-existing duplicates by ending all but the most recent per room.

- `supabase/migrations/0025_cross_signing_keys.sql` — **Matrix-aligned cross-signing hierarchy.** Splits the monolithic UMK into three Ed25519 keys:
  - **MSK** (`identities.ed25519_pub` — unchanged from v2's UMK pub, so no TOFU break). Root. Signs SSK + USK cross-sigs only. Stays cold on the original primary + inside the recovery blob.
  - **SSK** (`identities.ssk_pub` + `ssk_cross_signature`). Signs device issuance + revocation certs day-to-day. Lives on every co-primary device (shared via sealed box during approval — see 0026).
  - **USK** (`identities.usk_pub` + `usk_cross_signature`). Signs other users' MSK pubs after SAS verification (see 0030).
  Cross-sig canonical messages: `"vibecheck:crosssig:ssk:v1" || msk_pub || ssk_pub` (90 bytes) and `"vibecheck:crosssig:usk:v1" || msk_pub || usk_pub`. New columns are nullable for backward compat — pre-0025 identities continue to work via the v1 cert fallback in `verifyPublicDevice`. The `bump_identity_epoch` trigger is extended so any of MSK/SSK/USK rotating bumps `identity_epoch`. **V2 verifier invariant:** when `ssk_pub` is present, verify the MSK→SSK cross-sig (`verifyCrossSigningChain`) BEFORE trusting an SSK-signed device cert; otherwise an attacker-controlled server could substitute its own SSK and issue forged certs.

- `supabase/migrations/0026_signing_key_wrap.sql` — adds nullable `devices.signing_key_wrap`: `crypto_box_seal(ssk_priv(64) || usk_priv(64), target_device_x25519_pub)`. Written by the approving device during device-approval; the new device unseals post-enrollment to become a co-primary. **MSK never travels** — only SSK+USK. Null on the original primary (which generated SSK+USK locally via `generateSigningKeys`). Also null on the auth-callback's "first-sign-in" path.

- `supabase/migrations/0027_megolm_sessions.sql` — **per-sender Megolm ratchet tables.** Architectural pivot: pre-0027, room blobs used a flat per-generation room key; post-0027 every sender maintains their own forward-secret chain within a generation. Two new tables:
  - `megolm_sessions (id, room_id, sender_user_id, sender_device_id, session_id, generation, message_count, created_at)` — server tracks `message_count` so the 0029 hard-cap trigger can fire. `UNIQUE (room_id, sender_device_id, generation)` — one outbound session per sender-device-per-room-per-gen. RLS: any room member can SELECT (need `session_id` to look up inbound snapshots); only the sender may INSERT/UPDATE.
  - `megolm_session_shares (session_id, recipient_device_id, sealed_snapshot, start_index, signer_device_id, share_signature, created_at)` — sealed inbound snapshots (`crypto_box_seal` of `session_id || chain_key_at_index || start_index || sender_user_id || sender_device_id`, bound by Ed25519 share signature). PK `(session_id, recipient_device_id)`. Read policy: rows addressed to a device owned by `auth.uid()`. **Insert policy is `WITH CHECK (true)`** because senders insert rows addressed to *peer* devices. This is exactly the RLS+ON CONFLICT trap (§2): writes to this table MUST use plain `.insert()` + client-side 23505 swallow, never `.upsert()` or `onConflict`. `insertMegolmSessionShare` in `queries.ts` does this correctly; any new call site must follow suit.
  - Plus `blobs.session_id` + `blobs.message_index` columns (non-null on v4 Megolm blobs, null on v3/v2/v1 flat-key blobs).

- `supabase/migrations/0028_key_backup_megolm.sql` — extends `key_backup` with nullable `session_id` + `start_index`, so the backup table can hold both flat-key rows (pre-Megolm + pair-room bootstrap) and Megolm session snapshots. Existing flat-key backup rows keep working with both new columns null; restoration logic branches on `session_id IS NULL`.

- `supabase/migrations/0029_auto_rotation_enforcement.sql` — **server-side Megolm safety net.** Two `SECURITY DEFINER SET search_path = public` triggers on `blobs`:
  - `AFTER INSERT → increment_session_message_count()` bumps `megolm_sessions.message_count` (needs DEFINER to bypass the session's UPDATE RLS).
  - `BEFORE INSERT → check_session_message_cap()` rejects any INSERT whose session has `message_count >= 200` with a `check_violation`.
  The client is authoritative — `shouldRotateSession` rotates at 100 messages / 7 days. The 200-msg server cap is defense-in-depth against a misbehaving client running a chain key indefinitely; the 100→200 gap accommodates rotation races. **V2 must keep both triggers;** raising or removing the cap breaks forward-secrecy-within-a-generation.

- `supabase/migrations/0030_sas_verification.sql` — two tables for emoji-based identity verification (Matrix MSC1267-adapted):
  - `cross_user_signatures (signer_user_id, signed_user_id, signature, signed_at)` — **persistent** USK attestation that "I (signer) verified this user's (signed) MSK is authentic." PK `(signer_user_id, signed_user_id)`. Public SELECT (attestations are public trust statements, same model as PGP keysignings); INSERT + DELETE gated to `signer_user_id = auth.uid()`. Drives the verified-badge UX and escalates key-change alerts — if a verified contact's MSK drifts, that's a security event, not a routine re-enrollment.
  - `sas_verification_sessions` — **ephemeral** protocol state, 10-minute TTL. State machine: `initiated → key_exchanged → sas_compared → completed | cancelled`. Carries initiator+responder ephemeral X25519 pubs, the SHA-256 commitment binding initiator's ephemeral to its device-ed pub, and both HMAC MACs. RLS: participants only (`initiator_user_id = auth.uid() OR responder_user_id = auth.uid()`).
  Both tables are added to `supabase_realtime` so the SAS wizard drives progress via subscription — server-side expiry cleanup is not yet implemented (rows age out naturally on RLS reads but stay in the table; V2 can add a pg_cron job if row bloat becomes visible).
  **V2 verifier invariant:** before trusting an incoming `cross_user_signatures` row, call `verifyUserMskSignature` against the signer's USK pub (which itself must have a valid MSK→USK cross-sig). A server that can inject rows would otherwise claim fake attestations.

- `supabase/migrations/0031_nuke_identity_rpc.sql` — `SECURITY DEFINER` RPC `nuke_identity(p_user_id uuid)` for the nuclear-reset escape hatch in auth callback. **Required because** `calls` / `call_members` / `call_key_envelopes` tables have SELECT-only RLS (no DELETE policy) — client-side deletes silently returned zero rows and left FK references that blocked the subsequent `devices` delete. The RPC:
  1. Asserts `auth.uid() = p_user_id` (you can only nuke yourself) — raises `insufficient_privilege` otherwise.
  2. Deletes in FK-safe order: `call_key_envelopes` → `call_members` → `calls` → `megolm_session_shares` → `megolm_sessions` → `sas_verification_sessions` → `cross_user_signatures` → `room_members` → `room_invites` → `key_backup` → `device_approval_requests` → `devices` → `recovery_blobs`.
  3. EXECUTE granted to `authenticated` only.
  Replaces the previous client-side delete cascade; `nukeIdentityServer` in `queries.ts` now just calls this RPC. **V2 port action:** if you add a new table that references `devices` or `auth.users`, extend this RPC's delete list (FK order matters), or the nuke path will leave orphans.

- `supabase/migrations/0032_rooms_members_realtime.sql` — publishes `rooms` on `supabase_realtime` so clients react to `current_generation` bumps within milliseconds instead of the prior 10-second poll. Closes a Megolm correctness hole: during the poll window between "peer accepts invite → kick_and_rotate" and "my next send", `ensureFreshSession` reused the pre-join outbound session, so the new member had no `megolm_session_shares` row and couldn't decrypt. **Respects 0009's decision to exclude `room_members` from realtime** — every membership change flows through `kick_and_rotate` which UPDATEs `rooms.current_generation` in the same transaction, so the `rooms` event is sufficient signal; the client then re-fetches members + the user's wrapped_room_key row on its own. Consumer helper: `subscribeRoomMetadata(roomId, onChange)` in `queries.ts`. Used by `src/app/rooms/[id]/page.tsx` which also keeps a 30-second poll as a backstop against transient realtime disconnects.

- `supabase/migrations/0035_key_forward_requests.sql` — **Matrix-aligned intra-user key forwarding.** Adds `key_forward_requests (id, user_id, requester_device_id, session_id, room_id, created_at, expires_at)`. A device that can't decrypt a Megolm session (joined after it was created) posts a row; sibling devices (same user, different device) subscribe via realtime and respond by inserting a `megolm_session_shares` row for the requester's device. Also adds `megolm_session_shares` to the realtime publication so the requesting device wakes immediately on arrival. RLS: `owner_all` — `user_id = auth.uid()` — so only the user's own sibling devices can see and respond. PK `UNIQUE(requester_device_id, session_id)` so duplicate requests upsert cleanly. The responding device also inserts a `room_members` row for the requester's device (room key) BEFORE inserting the share — this ordering is critical: the share INSERT triggers the requester's `loadAll`, and the room key must already exist for images to decrypt. **Known limitation:** cross-user forwarding (sessions from the other person in the chat) is not supported — the other user's device can't see your requests. Sessions predating migration 0027 may also be unresolvable if `megolm_sessions` has no row for them. Both are working-as-intended forward-secrecy properties for old history.

- `supabase/migrations/0023_calls.sql` — E2EE video-call scaffolding. Adds three tables (`calls`, `call_members`, `call_key_envelopes`) plus six RPCs (`start_call`, `join_call`, `leave_call`, `rotate_call_key`, `heartbeat_call`, `end_call`) and two helpers (`is_active_call_member`, `assert_caller_owns_device`). `call_key_envelopes` is the call-scoped analogue of `room_members.wrapped_room_key`: each row is a sealed CallKey addressed to one target device, signed by the sender device. `rotate_call_key` enforces `p_new_gen = current_gen + 1` so concurrent rotators serialize via the DB — no leader lease. `calls` is published on realtime; `call_members` and `call_key_envelopes` are not (publication churn on every heartbeat would be intolerable). **V2 must also port:** `src/lib/e2ee-core/call.ts` (pure crypto — joins the blob/membership/etc module family); `src/lib/livekit/` (new peer module — adapter + token renewal, portable as one directory, requires `npm install livekit-client`); `supabase/functions/livekit-token/` (Deno edge function that mints 5-min LiveKit JWTs after verifying device + call membership); `src/components/IncomingCallToast.tsx` + `subscribeAllCalls` in queries.ts (global incoming-call notifier — mounted in AppShell, subscribes realtime `calls` without a filter and lets the `calls_read` RLS policy scope delivery to rooms the user is in). See `docs/video-call-design.md` for the full design.

**E2EE video call gotchas V2 WILL hit (learned the hard way on the prototype):**
- **`supabase.functions.invoke` does not reliably send the `apikey` header** under some supabase-js versions, and the Supabase Edge gateway rejects the request before it reaches the function (`"No API key found in request"`). The prototype's `src/lib/livekit/token-fetcher.ts` uses plain `fetch` with **both** `apikey` (the anon key) and `Authorization: Bearer <user_jwt>` headers explicit. Reuse that pattern for any new edge-function call, not just `livekit-token`.
- **Turbopack cannot resolve bare module specifiers for Worker URLs.** `new Worker(new URL('livekit-client/e2ee-worker', import.meta.url))` throws a minified `e.indexOf is not a function` at runtime from inside Next.js 16's module loader. The prototype ships the worker as a static file at `public/livekit-e2ee-worker.mjs`, kept in sync by `scripts/sync-livekit-worker.mjs` via `postinstall` + `prebuild` hooks. If V2 uses webpack instead of Turbopack, the bare-specifier approach may work — but the static-file path works in both, so keep it.
- **LiveKit WS URL must have the `wss://` scheme.** A bare hostname passes our edge function's env-var check and blows up inside LiveKit client's URL parser with the same cryptic `indexOf` error. Validate the `LIVEKIT_WS_URL` env var includes the scheme.
- **`@experimental` encryption option:** we use `encryption: { keyProvider, worker }` on the LiveKit `Room` options. The older `e2ee` field is marked deprecated but is more stable in some examples; if a future SDK upgrade breaks us, try `e2ee` as a fallback before hunting other bugs.
- **macOS requires mic permission before the OS will release the camera.** On Safari and Chrome on macOS, calling `getUserMedia({ video: true, audio: true })` fails silently for video if the user hasn't granted microphone permission at the System Settings → Privacy & Security → Microphone level for that browser. Symptom: user clicks "Start call", browser prompts are accepted, but the local video tile stays black. Fix is OS-level, not app-level. Document this in V2's call-page empty state — a one-liner "On Mac? Check System Settings → Privacy → Microphone" saves a support ticket.
- **Deploy the edge function with `verify_jwt: false`.** Supabase projects with ES256-signed auth tokens (the newer asymmetric default) cannot pass the edge-function gateway's HS256-only verification — you'll get `UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM` 401s. Our function does its own JWT verification via `supabase.auth.getUser()` inside the handler, which hits the auth service and works regardless of signing algorithm. The gateway-level check is redundant; turn it off. If you deploy a new edge function that relies on user auth, pair `verify_jwt: false` at the gateway with an explicit `supabase.auth.getUser()` call inside.

**E2EE video call invariants (V2 must preserve):**
- `rotateCallKeyForCurrentMembers` excludes any device NOT in the new envelope set — that's the eviction mechanism for leave + revoke. If V2 adds a new "kick from call" flow, it must call the rotation RPC with the kicked device omitted from envelopes, not attempt to directly delete rows.
- The elected rotator is deterministic: lowest `(joined_at ASC, device_id ASC)` among non-stale, non-left members. Concurrent rotators are resolved by the DB's `new_gen = current + 1` uniqueness constraint; losers read the new gen and move on. Do not add a leader-lease scheme.
- **LiveKit token renewal is mandatory, not optional.** Tokens are 5-minute TTL to support the revocation-cascade path — any call longer than 5 min without silent renewal drops randomly. `livekit-adapter.ts`'s `scheduleRenewal` + `visibilitychange` handler own this; never call `Room.connect` manually or without going through `LiveKitAdapter`.
- **Revocation cascades into active calls.** `revokeDevice` in `src/app/settings/page.tsx` calls BOTH `rotateAllRoomsIAdmin` AND `cascadeRevocationIntoActiveCalls` — the latter re-keys every active call the acting device is currently in, omitting the revoked device from new envelopes. Calls the acting device is NOT in are handled via the heartbeat-grace loop on remaining participants (30s window). Any new "revoke device" UX must replicate both cascades.
- **Heartbeat grace is 30 seconds** (`HEARTBEAT_GRACE_SECONDS` in bootstrap.ts). Shrinking it causes UX-hostile flapping on normal network flaps; widening it extends the window where a maliciously offlined device can lurk with the CallKey. Document and discuss before changing.
- QVGA capture constraints (320×240 @ 15fps, simulcast off) are hardcoded in `src/lib/livekit/adapter.ts`. Consuming apps may override per-call but the foundation default is the retro mode, because it also simplifies frame-key management (no simulcast = no per-layer keys).
- **Never call `keyProvider.setKey()` outside of initial seed + `adapter.rotateKey()`.** `ExternalE2EEKeyProvider.setKey()` auto-increments an internal keyIndex on every call; any extra call drifts our index ahead of remote participants and causes a positive-feedback cascade of `InvalidKey: Decryption failed` errors. A prior "recovery nudge" implementation did this and killed calls after ~60s. Trust LiveKit's `KeyProviderEvent.KeyRatcheted` auto-ratchet instead. If V2 adds any new `setKey()` call site, remove it.
- **Receive-only is a first-class mode.** `publishLocalMedia` catches `NotAllowedError` / `NotFoundError` / `NotReadableError` / `SecurityError` from `enableCameraAndMicrophone` and joins without publishing. Security holds (nothing plaintext leaves); the UI shows a "listening-only" banner. V2 must preserve this fallback — throwing on permission denied means buddies without camera/mic can't join at all.
- **Call-ended navigation:** when `calls.ended_at` UPDATE fires, the call UI routes back to the parent room via `router.push(/rooms/${roomId})` after teardown. Without this, users hit a "Call ended." dead-end.

**Crash-safe rotation + key-backup invariants (V2 must preserve):**
- Recovery-blob write MUST precede UMK-pub publish during any rotation. The split helpers `generateRotatedUmk` / `commitRotatedUmk` in `bootstrap.ts` make this explicit. A browser crash between the blob write and the pub publish leaves the user recoverable via phrase; a crash the other way around would lock them out. Matrix-SSSS pattern.
- **Rotation expels untrusted devices through the picker.** `generateRotatedUmk` accepts `options.devicesToRevoke`; passed device IDs receive fresh SSK-signed revocation certs alongside the cert reissuance, and `commitRotatedUmk` writes them atomically. The prototype's `RecoveryPhraseModal` surfaces this as a checklist stage between phrase-verify and commit (fires only with 2+ active devices; fast-paths out when only the current device is active). Current device is pinned-checked so the user can't self-lockout. **V2 port action:** preserve the picker UX in whatever shape the target app uses; without it, a ghost device added by a leaked phrase survives every rotation. The underlying invariant (MSK cascade into rooms via `rotateAllRoomsIAdmin`) still does the heavy lifting of actually cutting off key access — the picker is what makes the cascade exclude the ghost.
- Every `wrapRoomKeyForAllMyDevices` call checks `getBackupKey(userId)` and, if present, uploads an encrypted room-key to `key_backup` alongside the `room_members` inserts. New rooms, accepted invites, and rotations all take this path — no other call sites should wrap a room key.
- Device-approval flow (A-side) reads the local backup key, seals it to the new device's x25519 pub, and writes it to `devices.backup_key_wrap`. B-side's auth callback picks it up post-enrollment and calls `putBackupKey` locally. Without this hand-off, newly-approved devices couldn't decrypt pre-existing backup rows.
- Recovery-phrase entry (`RecoveryPhraseEntry.tsx`) calls `putBackupKey` with the blob-recovered backup key BEFORE `enrollDeviceWithUmk`, so any backup-restore logic that fires post-enrollment finds the key available.
- **Sibling-tab identity sync** — `src/lib/tab-sync.ts` broadcasts on `commitRotatedUmk`, `revokeDevice`, and post-nuke. `AppShell` subscribes and reloads on receipt. Reload is safe because sibling tabs share IDB; the second tab just re-reads the post-rotation keys and re-runs the post-mount chain check. If V2 uses a `BroadcastChannel`-incompatible environment, document the limitation rather than shipping a half-baked replacement.

**Multi-device sync note (critical for V2):** all membership-changing actions must use `wrapRoomKeyForAllMyDevices` (not single-device `addRoomMember`) and all invite-send paths must use `sendInviteToAllDevices` (not single-device `createInvite`). These helpers in `bootstrap.ts` ensure every device on the user's account gets immediate access to every room, and invites can be accepted from any device. If you add a new room-join flow, use these helpers. See the rotation paths in `rooms/[id]/page.tsx` for how keepers' devices are enumerated during key rotation.

**Additional top-level files to copy beyond `src/lib/e2ee-core/`:**
- `src/lib/bootstrap.ts` — app-glue layer above e2ee-core. Contains `bootstrapNewUser`, `enrollDeviceWithUmk`, `loadEnrolledDevice`, `rotateUserMasterKey`, `rotateAllRoomsIAdmin`. Not portable the same way e2ee-core is — imports from `supabase/queries` — so either copy verbatim alongside the queries module, or re-implement against your own data layer.
- `src/components/PinSetupModal.tsx` — shared mandatory-capable passphrase setup modal. Used by auth callback (enforced default) and settings (change passphrase).
- `src/components/RecoveryPhraseModal.tsx` and `RecoveryPhraseEntry.tsx` — phrase setup/rotation and recovery UX. Both know about the UMK rotation cascade.
- `src/components/PendingApprovalBanner.tsx` — A-side of device approval; uses UMK priv to sign issuance certs for B-side requests.
- `src/components/AppShell.tsx` — wraps all authed pages with the post-mount UMK-vs-device-cert sanity check that boots orphaned sessions.

**⚠ TEMP dev shortcut to revert before real-audience deploy:**
- `src/app/api/dev/magic-link/route.ts` — unguarded endpoint that generates magic-link URLs server-side using the Supabase service-role key. Any caller can mint a link for any email. Delete the file AND revert `src/components/MagicLinkForm.tsx` to call `supabase.auth.signInWithOtp(...)` instead of the fetch.

Install in V2:

```
npm install libsodium-wrappers-sumo idb @scure/bip39 livekit-client
```

`livekit-client` is the SFU client SDK used by `src/lib/livekit/`. Required only if porting the video-call surface (migration 0023 + `e2ee-core/call.ts`).

The LiveKit edge function (`supabase/functions/livekit-token/`) needs these env vars set in Supabase:

```
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_URL=wss://<project>.livekit.cloud
```

(LiveKit Cloud's dashboard gives you these three; `LIVEKIT_URL` is the canonical name. The function also accepts the older `LIVEKIT_WS_URL` alias.)

Deploy with `supabase functions deploy livekit-token`. Prototype uses LiveKit Cloud (free tier caps call duration at 60 min); V2 should self-host `livekit-server` alongside Supabase to remove that cap.

(`@scure/bip39` is what `src/lib/e2ee-core/recovery.ts` uses for the 24-word phrase.)

Everything else in the prototype (magic-link form, status page, rooms UI) is reference UX you can copy as a starting point or rebuild behind VibeCheck's design system.

## 2. Hook up Supabase

Either reuse the prototype's `src/lib/supabase/` wholesale, or write the V2 app's own data layer that satisfies the same contract: every `bytea`-looking column is URL-safe base64 on the wire, every table has typed insert/fetch/list/subscribe helpers.

If V2 wants to pre-generate TypeScript types from the DB, run `supabase gen types typescript` after the migration is applied; the row shapes in `src/lib/supabase/queries.ts` are a manual mirror of that.

**Postgres RLS + `ON CONFLICT` gotcha (learned the hard way 2026-04-17):** on any table with RLS, a statement that includes `ON CONFLICT (...)` — including supabase-js `.upsert()` with or without `ignoreDuplicates: true` — causes Postgres to evaluate the table's **SELECT policy USING expression against the NEW row being inserted**, even when no conflict exists and even with `DO NOTHING`. If the SELECT policy restricts visibility to a subset of rows the writer legitimately inserts to (e.g., `megolm_session_shares.recipient_device_id` must belong to `auth.uid()`, but senders insert shares for *peer* devices), every cross-user insert fails with 42501. Workaround that `insertMegolmSessionShare` uses: plain `.insert()` + client-side swallow of 23505 (duplicate-key). When designing future "sealed blob addressed to a specific recipient" tables in V2, either follow this pattern, widen the SELECT policy to cover writes, or route through a SECURITY DEFINER RPC.

## 3. Port the auth bootstrap

The critical path is in `src/app/auth/callback/page.tsx`:

1. Let Supabase's `detectSessionInUrl` parse the implicit-flow hash during client init. **Do not** manually strip `window.location.hash` before awaiting the session — it races the parser and kills the sign-in. Instead call `await supabase.auth.getSession()` to gate on init completion, then call `getUser()`.
2. Fetch the user's row from `identities`.
3. Check IndexedDB for a local identity copy.
4. Five cases:
   - **server yes + local yes** → returning user. **Must** chain-check the local device cert against the published UMK (`verifyLocalChainOrMarkOrphan` helper); if orphan, wipe local state and route to recovery before attempting to navigate.
   - **server yes + local-plaintext no + wrapped-blob yes** → passphrase lock engaged; show the unlock form. **After a successful unlock**, run the same chain-check as above: the wrapped blob may hold stale keys (UMK rotated elsewhere, device revoked), and skipping the check causes an infinite sign-in loop (AppShell's post-mount guard kicks the user back to `/`, where the still-present wrapped blob routes them right back to unlock). On orphan verdict, also delete the wrapped blob — its contents are dead and keeping it would re-trigger the loop on next sign-in.
   - **server yes + local no + no wrapped blob** → new device. Show the chooser: "request approval from another device" (6-digit code path — `device_approval_requests`) or "enter recovery phrase" (`recovery_blobs`, only enabled if one exists).
   - **server no + local no** → first sign-in, generate identity, publish pubkeys, register device, then offer to set up a recovery phrase.
   - **server no + local yes** → shouldn't happen, but treat as "first sign-in" safely.

The unlock form must also expose a "forgot passphrase" affordance that routes to the same chooser the "server yes + local no" case uses — same three options (approve from another device / 24-word phrase / nuclear reset). A pin-locked device with no escape hatch is a lockout footgun.

V2 should keep this exact decision tree. Any variation risks dropping users into the wrong funnel.

## 4. Keep /status

The `/status` page is more valuable in V2 than it was here — it's your canary when integrating third-party features (e.g. file storage, presence, typing indicators). Keep it in V2 behind a dev-only flag, or always-on but hidden from the nav.

Add one check per E2EE-touching feature you add (e.g. "File attachments roundtrip," "Typing event AEAD roundtrip"). The principle: any code path that moves a cipher through the server should have a green dot you can look at.

**Current check index (26 checks as of 2026-04-19):**

| # | Name | What it proves |
|---|---|---|
| 0 | Sodium WASM ready | libsodium WASM initialised |
| 1 | Identity keys in IDB | device bundle present |
| 2 | Published pubkey matches local | server/local UMK pub in sync |
| 3 | Self-signature valid | full MSK→SSK→device cert chain |
| 4 | Encrypt + decrypt roundtrip | v3 AEAD + sig end-to-end |
| 5 | Test room exists | Supabase probe room reachable |
| 6 | Write encrypted blob | row insert + ciphertext stored |
| 7 | Realtime subscription | WebSocket echo latency |
| 8 | Ciphertext opacity | AEAD overhead + no plaintext in bytes |
| 9 | Tamper detection | AEAD rejects 1-bit flip |
| 10 | Devices linked | account device list readable |
| 11 | Approval code hash | code hash determinism + pubkey binding |
| 12 | Recovery phrase wrap/unwrap | Argon2id + XChaCha20 KDF chain |
| 13 | Image attachment roundtrip | chunked AEAD encrypt/upload/download/decrypt |
| 14 | Multi-device room key wrap/unwrap | sealed-box wrap + unwrap for temp device |
| 15 | Call envelope roundtrip | CallKey sealed + signed + tamper-rejected |
| 16 | Browser E2EE streams | insertable streams API present |
| 17 | Megolm ratchet roundtrip | v4 encrypt → snapshot → decrypt + tamper |
| 18 | Cross-signing chain | MSK → SSK and MSK → USK cross-sigs |
| 19 | Blob cache IDB | write/read/delete round-trip + cursor state |
| 20 | Session seal/unseal | `sealSessionSnapshot` → `unsealSessionSnapshot` + tamper |
| 21 | Ratchet one-way integrity | `deriveMessageKeyAtIndex` rejects index < startIndex |
| 22 | Ratchet cursor O(1) advance | `deriveMessageKeyAtIndexAndAdvance` key equality, both timings |
| 23 | Plaintext cache timing | Map.get cache hit completes in <1ms |
| 24 | Missing key backoff sequence | `computeBackoffDelay` sequence [500, 1k, 2k, 4k, 5k]ms |
| 25 | Mutex concurrency drop | `createLoadMutex` acquire/release full cycle |

## 5. Layer VibeCheck domain on top of blobs

VibeCheck V1's domain is sliders, Mind Reader guesses, Safe Space messages with Time-Out, Date Proposals, Therapy Reports. In V2, every one of those is an encrypted blob payload:

```ts
type VibeBlob =
  | { type: 'slider'; metric: Metric; value: number }
  | { type: 'message'; text: string; draft?: boolean }
  | { type: 'date_proposal'; proposalId: string; title: string; slots: Slot[] }
  | { type: 'date_response'; proposalId: string; response: 'accept'|'counter'|'decline' }
  | { type: 'mind_reader_guess'; metric: Metric; guess: number }
  | { type: 'therapy_homework_update'; ... }
  | ...;
```

Use a discriminated union + a `zod` schema at the decrypt boundary to validate payloads before you trust them. That schema lives in the V2 app (since it's domain-specific), NOT in e2ee-core.

Tip: keep the Therapy Session Report an aggregation *in the client* across many blobs, not a server-side query. That's how the zero-knowledge guarantee survives clinical tooling.

### Encrypted room names

`rooms` carries optional `name_ciphertext` + `name_nonce` columns (migration 0003). The name is sealed under the current-generation room key using XChaCha20-Poly1305 with AD bound to `(room_id, generation, "vibecheck:name:v1")` — so a name ciphertext cannot be swapped for a message blob even though they share the same key. Unsigned on purpose: any current member can rename.

V2 implications:
- On member removal / key rotation, re-encrypt the name under the new key (see the `rotateOut` flow in `src/app/rooms/[id]/page.tsx`). If the re-encrypt fails, clear the name rather than block the rotation.
- Use `encryptRoomName` / `decryptRoomName` from `e2ee-core`; the server never sees plaintext.
- This supersedes the earlier "consider a separate `room_meta` table" note — names live on the `rooms` row directly.

## 6. Features out-of-scope for prototype that V2 needs

| Feature                      | Where to put it                                                 |
| ---------------------------- | --------------------------------------------------------------- |
| File/photo attachments       | Upload ciphertext + a small header blob. Use `crypto_secretstream_*` (streaming AEAD) for large files. |
| Presence / typing indicators | Supabase Realtime presence channel keyed by room_id             |
| Push / email notifications   | Server only sees sender/room + timestamp. Include a room display name only if that display name is also encrypted client-side into a tiny "room meta" blob. |
| Invite by email              | Add an `email` column on `identities` that each user writes for themselves (RLS: self-insert). Or add an RPC `find_user_id_by_email` (SECURITY DEFINER) if you want stricter privacy. |
| Account deletion             | Deleting `auth.users` cascades to identities, rooms created_by, etc. Surviving members keep working because their wrapped keys are local and current-generation. |

## 7. V2-only changes to the DB schema

Anticipated, none yet mandatory:

- Add `email text` to `identities` if you go the invite-by-email route.
- If you want room avatars, extend the room-name sealing pattern (XChaCha20-Poly1305 under the current-gen room key, with a distinct AD field tag) rather than spinning up a separate table.
- If you want to support file attachments, add a `blob_attachments` table mirroring `blobs` but referencing Supabase Storage object paths + per-object wrap keys.

Everything else in the prototype's schema should survive untouched.

## 9. Portable query + realtime helpers to copy

`src/lib/supabase/queries.ts` grew a few helpers during prototyping that V2 will want as-is:

- **`renameRoom` / `deleteRoom`** — mirror the `rooms_member_update` and `rooms_creator_delete` RLS policies.
- **`nukeIdentityServer(userId)`** — the "nuclear reset" escape hatch used when a user is locked out with no other device and no recovery phrase. Wipes their `room_members`, `room_invites`, `device_approval_requests`, `devices`, and `recovery_blobs` rows so a fresh identity can be published in place. Blobs in rooms they were in are left behind as append-only ciphertext nobody can decrypt — the intended trust model. Surface it behind a typed-confirmation gate; see `src/app/auth/callback/page.tsx` for the copy + gating pattern.
- **`subscribeInvites(userId, onRow, onStatus?)`** — realtime `INSERT` on `room_invites` filtered by `invited_user_id=eq.<uid>`. Use it so incoming invites land without a refresh; the callback signature matches `subscribeBlobs` and `subscribeApprovalRequests`.

### Optimistic-append + realtime-dedupe pattern

The room feed (`src/app/rooms/[id]/page.tsx`) demonstrates a pattern worth keeping in V2: on send, the composer passes the inserted row straight into the same ingest function the realtime subscription uses, and the ingest dedupes by row `id` before appending. This gives instant self-render without flicker when the realtime echo arrives. Apply the same shape to any feature that reads a table via realtime AND writes to it (typing indicators, presence, etc.).

## 10. Image attachments (portable path)

The prototype ships a full encrypted-image pipeline; V2 should copy it wholesale and only rewrite the composer/feed UI.

Portable pieces (copy verbatim):

- `supabase/migrations/0006_attachments_bucket.sql` — the `room-attachments` bucket + RLS.
- `src/lib/e2ee-core/attachment.ts` — `prepareImageForUpload`, `decryptImageAttachment`, `ImageAttachmentHeader`, `attachmentStorageKey`, the AD helper.
- `src/lib/supabase/queries.ts` → `uploadAttachment`, `downloadAttachment`, `deleteAttachment`, `deleteAttachmentsForRoom`. Also keep the `insertBlob({ id? })` overload — image sends need to know the blob id *before* insert so the storage path can be computed.

Encryption shape:

- Re-encode client-side via `createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 1600 })` → `OffscreenCanvas.convertToBlob({ type: 'image/webp', quality: 0.82 })`. This automatically strips EXIF (including GPS).
- Encrypt bytes with `crypto_aead_xchacha20poly1305_ietf_encrypt`, AD = `uuid(roomId) || uuid(blobId) || u32be(generation) || "vibecheck:attachment:v1"`. The distinct AD tag and `blobId` inclusion prevent cross-room, cross-generation, and cross-attachment swap attacks even if the server misbehaves.
- Upload the resulting `nonce || ciphertext` to `{roomId}/{blobId}.bin` in the bucket.
- The outer `blobs` row carries a small JSON payload: `{type:'image', mime, w, h, byteLen, placeholder}` where `placeholder` is a tiny blurred WebP base64 data URL for instant feed rendering.

V2 implications:

- **Key rotation** does not require re-encrypting attachments. Old members keep access to pre-rotation images (same as pre-rotation text blobs — append-only trust model). `deleteRoom` calls `deleteAttachmentsForRoom` before the row cascade because Storage has no FK relationship.
- **Larger files** (video, PDFs) should switch from `crypto_aead_xchacha20poly1305_ietf_*` to `crypto_secretstream_xchacha20poly1305_*` so you can encrypt/decrypt in chunks without holding the whole plaintext in memory. The bucket, RLS, and header-in-blob pattern stay the same.
- **Server-side moderation is fundamentally impossible** with this design. Decide in advance whether VibeCheck's audience accepts the Signal-style tradeoff, and put it in the product's Trust-and-Safety copy.

/status in V2 should keep the "image attachment roundtrip" check — it uses a synthetic canvas-generated `File` so it works without any picker UI, and it catches regressions across the full encrypt/upload/download/decrypt pipeline.

## 11. Admin model + room kinds

**Pair rooms are strictly 2 people.** Groups have no cap in the prototype — pick one in V2 based on the UX (8? 50?) and encode it in the trigger. Either way, the enforcement lives in `0007_pair_cap_and_admin_delete.sql`: a BEFORE INSERT trigger on both `room_members` and `room_invites` counts distinct `user_id` values across both tables and rejects insertions that would exceed the cap. Existing users (re-wraps during rotation, invite-acceptance paths) short-circuit so the trigger never blocks legitimate churn.

**Client-side pair-fullness checks must count distinct users, not rows.** Since migration 0015, `room_members` keys on `(room_id, device_id, generation)`, so a single user with multiple devices produces multiple rows. UI code that disables the invite button based on `count(*)` will flag a one-user-two-device pair as full and the invite will never be attempted. Both `src/app/rooms/page.tsx` (rooms-list invite form) and `src/app/rooms/[id]/page.tsx` (in-room invite form) use a `new Set(user_id).size` pattern to match the DB trigger's `distinct user_id` semantics. V2 must replicate this shape for any new pair-cap-aware UI.

**The room creator is the admin.** That single bit — `rooms.created_by = auth.uid()` — is what determines who can:
- kick other members (the "remove + rotate" button in `MemberList`),
- delete the whole room (via `rooms_creator_delete` policy from 0004),
- insert new members during rotation (via the tightened `room_members_insert` policy from 0007).

**Everyone else can leave but not kick.** Non-admin members see a "leave" button on their own row. Under the hood it uses the same `rotateAndRemove` helper as admin-kick, just with `keep = members \ self` and `remove = [self]`. The tightened `room_members_delete` RLS policy lets them delete only their own rows.

**Edge cases baked in:**
- Creator cannot "leave" — they must delete the room. The MemberList UI shows no action on the creator's own row; the delete-room button above it is the intended escape hatch.
- A rotation that ends with zero remaining members (last leaver in a solo room) skips the re-wrap step entirely and just deletes the leaver's rows. The room becomes an empty-shell owned by the original creator until they delete it.
- In a pair room, both members can "leave" (non-creator ≥ creator — the creator must use "delete room" instead).

**Client/server consistency:**
- `listMyRoomKeyRows` returns *every* generation of `room_members` rows the viewer still has, unwrapped into a `Map<generation, RoomKey>`. `decodeAndVerify` picks the right key by `blob.generation`. `ImageAttachment` does the same lookup. This is what lets post-rotation members still read pre-rotation messages — the data was always there, the prototype just wasn't using it.
- Sending always uses the current-gen key (`roomKey` state, mirrored in a ref for callbacks).
- Rotation inserts new rows at `new_generation` for every remaining member **and** (separately) cascades old rows for the removed user. Old-gen `room_members` rows for remaining users are intentionally kept so the viewer retains the ability to decrypt historical blobs on this device and across future devices (re-sync from server).

**V2 additions likely wanted:**
- Admin transfer: allow the creator to hand off admin to another member before leaving. Minimum viable: add an `admin_user_id` column to `rooms`, default it to `created_by`, gate kick/delete on that column instead of `created_by`. An RPC `transfer_admin(room_id, new_admin_id)` with `SECURITY DEFINER` runs the swap atomically.
- Named group size cap: change the trigger's hard-coded `2` into a per-room column (`member_cap int`) and have the pair kind default it to 2.
- "You've been removed" banner: when the RLS kicks in (a leaver/kickee tries to read the room), show a graceful empty-state instead of the raw "not a current-gen member" error. The bones are already in `loadAll`.

## 12. Server-side room-key backup (Matrix key-backup)

Migration 0022 + the v3 recovery blob format give us a cross-device history-restore path without relaxing the zero-knowledge posture. The server never sees the backup key.

**Recovery blob v3 format** (backward-compatible with v2 64-byte blobs):

```
plaintext = [ UMK_ed25519_priv (64 bytes) || backup_key (32 bytes) ]   (96 bytes, v3)
         or [ UMK_ed25519_priv (64 bytes) ]                            (64 bytes, v2)
AD        = "vibecheck:recovery:v3:${userId}"  (v3)
         or "vibecheck:recovery:v2:${userId}"  (v2 fallback)
```

`unwrapUserMasterKeyWithPhrase` tries v3 AD first and falls back to v2. New blobs always use v3.

**Backup encryption** (`encryptRoomKeyForBackup` in `e2ee-core/recovery.ts`):

```
ciphertext = XChaCha20-Poly1305(
  key       = backup_key,
  nonce     = random 24 bytes,
  plaintext = [ generation(u32be) || roomKey(32 bytes) ],
  AD        = "vibecheck:key-backup:v1:${roomId}:${generation}",
)
```

Row shape: `key_backup (user_id, room_id, generation, ciphertext, nonce, created_at)`. Primary key `(user_id, room_id, generation)` — re-wrapping an existing generation is idempotent.

**Three paths by which a device gets the backup key:**

1. **Primary device, first phrase setup** — `generateBackupKey()` in `RecoveryPhraseModal`, stashed via `putBackupKey` + baked into the v3 recovery blob.
2. **New device via recovery phrase** — `unwrapUserMasterKeyWithPhrase` returns `{ ed25519PrivateKey, backupKey? }`; callback stores backup key locally before `enrollDeviceWithUmk` (so future restore logic can fire). Key lives on.
3. **New device via approval flow** — A-side `PendingApprovalBanner` seals the local backup key to B's x25519 pub via `crypto_box_seal`, writes to `devices.backup_key_wrap`. B's auth callback reads the row post-enrollment, unseals with its x25519 priv, calls `putBackupKey`.

**V2 port considerations:**

- Backup key ≠ UMK priv. UMK signs; backup key encrypts. Don't conflate or reuse bytes across them.
- A user who never sets up a recovery phrase never has a backup key → `key_backup` stays empty → no history restore. That's the correct behaviour; the recovery phrase IS the opt-in for key backup.
- Losing all devices AND the phrase = permanent loss of `room_members` wraps older than `current_generation - 9`. The backup is only useful when at least one credential survives.
- Server-side reads of `key_backup` ciphertext leak the room/generation graph (same as `room_members` already does) but not keys. Accept the shape parity.
- If V2 adds a key-backup "prune" UX (e.g. drop old generations to limit row count), rotate the backup key first via a new recovery-blob write — otherwise a server snapshot keeps the pruned rows readable.

**Check #14** in `/status` is the canary: it constructs a synthetic temp device, signs its cert with the real UMK, runs the full wrap/unwrap roundtrip, cleans up. Keep it in the V2 port.

## 13. Multi-primary via "promote this device" (Matrix-style)

v3's approval flow deliberately does not transmit UMK priv (see AGENTS.md §3 — "no private keys cross the network"). So a device linked via approval holds a device bundle but no UMK, which means `PendingApprovalBanner` hides itself on that device and a user with 2+ linked devices can only approve new devices from the original primary. Losing / logging out of the primary blocks all further device sign-ins short of a full recovery-phrase re-enrollment.

`src/components/PromoteDeviceModal.tsx` + the "Promote this device" button in `src/app/settings/page.tsx` give any linked device a way to unwrap UMK from the recovery blob on demand, becoming a co-primary. After promotion, `PendingApprovalBanner` shows up on that device and can approve further sign-ins.

**What the flow does (tight):**

1. Fetches the recovery blob, unwraps it via `unwrapUserMasterKeyWithPhrase`.
2. Derives UMK pub from the unwrapped priv and rejects if it doesn't match the published UMK pub (guards against tampered blobs / wrong-account confusion).
3. `putUserMasterKey` locally. If the blob was v3, also `putBackupKey`.
4. If pin-lock is enabled on this device, asks for the pin passphrase, trial-unwraps the existing wrapped identity to verify it, then re-wraps device+UMK under the same passphrase via `wrapDeviceStateWithPin` and overwrites `putWrappedIdentity`. Without this, UMK would be lost on the next lock cycle and the user would need to promote again.

**Why this doesn't violate the "no UMK across the wire" invariant:** the recovery phrase is the pre-existing UMK-recovery credential. A user who has the phrase can already unwrap UMK on any device (via the fresh-device recovery path). Promote-this-device just exposes the same capability as a mid-session action. No bytes move; UMK stays client-side.

**Security tradeoff vs. strict single-primary:**
- Multiple devices can now hold UMK priv simultaneously. Split-brain is possible if two primaries issue conflicting device certs or revocations at the same time. Rare in practice (requires two users acting on the same account within the same replication window) and the failure mode is a merge conflict on the device list, not a key compromise.
- Compromise surface for UMK priv grows linearly with the number of promoted devices. The phrase's compromise surface was already the union of "devices that ran the setup flow"; promote-device just widens it to "devices that the user explicitly promoted."

**V2 port actions:**

- Copy `src/components/PromoteDeviceModal.tsx` verbatim. It's purely stateful UX over e2ee-core helpers — no new Supabase contract.
- If V2 adds a new pin-lock or recovery flow, make sure promote-device's trial-unwrap + re-wrap sequence still works. Specifically: `wrapDeviceStateWithPin(deviceBundle, umk, passphrase, userId)` must continue to accept a non-null UMK and pack it into the blob. `unwrapDeviceStateWithPin` must return `{ deviceBundle, umk }` where `umk` is non-null on a promoted device.
- **Do NOT re-introduce UMK transport in the approval flow as an "automatic promote."** The phrase-entry gate is load-bearing — it's what makes the user explicitly opt in to widening their UMK compromise surface. Silent auto-promote on every linked device is the v1/v2 "seal the root identity" footgun AGENTS.md §3 forbids.

## 8. Things to test on each port

Before calling V2 ready:

- Run the prototype's verification scenarios against V2's deployment (same 1–8 from the root README).
- Send every blob type through encrypt + decrypt on localhost, then confirm the Supabase row contents look like random bytes in base64.
- Rotate a group member out and confirm new blobs are unreadable without the new key; old blobs are still readable by historical members but not by the removed one.
- Link a device, sign out on the primary, confirm the secondary still has full access.
- Lose all devices (clear IndexedDB on both), confirm the user is correctly routed to "no identity on device, but identity exists on server" state — and guided to re-pair, not to a broken dead-end.
- Rotate the recovery phrase on device A, refresh the tab between "new UMK generated" and "UMK pub published" (devtools → disable cache + throttle), then reload and re-enter the new phrase. The account should recover via the new blob rather than lock out. (Proves SSSS ordering.)
- Create a room on A, approve a new device B, confirm B's `devices.backup_key_wrap` gets populated and B can decrypt backed-up history. Then on a third device C, enter the recovery phrase and confirm C downloads + decrypts `key_backup` rows for every room. (Proves the three backup-key paths.)

## 14. Local blob cache (Matrix-aligned)

`src/lib/cache-store.ts` is a portable app-level cache layer. It lives in a separate `vibecheck-cache` IndexedDB so the e2ee-core crypto store stays pure. Copy it verbatim alongside `e2ee-core/` and wire it into your room page as the prototype does.

**Architecture:**

```
Server (Supabase)
  └── blobs: ciphertext rows (authoritative, unbounded)

vibecheck-cache IndexedDB (this device)
  ├── blobCache  key: "${roomId}:${blobId}"   value: BlobRow (ciphertext)
  │              index byRoomTime: [roomId, createdAt]
  └── roomSyncCursor  key: roomId             value: { lastCreatedAt }

In-memory React state
  └── DecodedBlob[]  — plaintext, ephemeral, never persisted
```

**Delta sync pattern** (implemented in `src/app/rooms/[id]/page.tsx` `loadAll`):
- No cursor → first visit → `listBlobs(roomId, 50)` → seed cache → set cursor to latest `created_at`
- Cursor present → `listBlobsAfter(roomId, cursor)` → merge new rows → advance cursor
- After delta: re-decode cached rows sequentially (not `Promise.all`) to avoid IDB ratchet-cursor races

**Realtime path** (`ingestBlobRow`): each arriving blob is also written to cache and advances the cursor so the next delta fetch is minimal.

**Pagination** (`loadEarlier`): fetches from server via `listBlobsBefore(roomId, oldest.createdAt, 100)`. Older rows are prepended to React state but NOT cached — they're intentionally outside the 500-row window. `hasMoreHistory` is set to false when the server returns 0 rows.

**`MAX_CACHE_ROWS_PER_ROOM = 500`**: trim fires after every delta write, keeping the newest 500 rows. Returns deleted IDs so React state can be updated. V2 apps with larger payloads (notes, rich data) can tune this constant. The server always has the full history for reports and pagination.

**Invariants V2 must preserve:**

- `wipeAppCache()` must be called alongside identity nuke (`handleNuclearConfirmed` in `auth/callback/page.tsx`). Without it, stale ciphertext from the old identity accumulates in the cache with no corresponding decryption keys.
- `clearBlobCacheForRoom(roomId)` on leave room, delete room, and stale-membership abandon. Prevents a re-joined user from seeing a stale pre-join cache on first load.
- `removeBlobFromCache(roomId, blobId)` on blob delete. Keeps cache consistent with server state.
- Ciphertext only — never store `DecodedBlob` (plaintext) in IndexedDB. Same posture as Element Web.

**Security note:** the cache is not additionally encrypted. Same-origin isolation is the security boundary, same as Element Web. Keys stay PIN-protected in the e2ee-core store; the cache is meaningless without them. Future hardening path: encrypt `blobCache` entries under the device X25519 key — documented as deferred, not yet implemented.

**Reports / export:** bypass the cache entirely and query the server directly via `listBlobs` (or a paginated equivalent). The cache is a display convenience; it is bounded at 500 rows and may be stale. Any feature that needs complete authoritative history must go to the server.
