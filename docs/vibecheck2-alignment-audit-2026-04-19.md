# vibecheck2 — Foundation Alignment Audit
**Date:** 2026-04-19  
**Audited against:** `vibecheck-e2ee-prototype` (current `main`)  
**Scope:** Database migrations, `e2ee-core/`, `bootstrap.ts`, `queries.ts`, `cache-store.ts`, `tab-sync.ts`, `livekit/`, security-critical UI components, auth flow  

---

## Executive Summary

The crypto foundation (`e2ee-core/`) and the LiveKit layer are copied verbatim and match exactly. The PIN-lock gate, tab-sync, and cache-store are present and aligned. The auth flow has been cleanly refactored into a dedicated `/auth/bootstrap` page — an improvement over the prototype.

However, **two critical database security patches** and **one component-level verification skip** were missed. These must be applied before exposing the app to any real users. One moderate performance regression in `megolm.ts` and one UX regression in `RecoveryPhraseModal` also need patching.

---

## CRITICAL — Must fix before launch

### 1. `room_members_insert` RLS policy allows post-eviction self-re-insertion

**Status:** Unpatched (prototype migrations `0038` + `0039` were never ported)

His current policy, last touched in `0012_backport_live_helpers.sql`, reads:

```sql
create policy room_members_insert on room_members
  for insert to authenticated with check (
    user_id = auth.uid()                        -- ← the hole
    or public.is_room_member_at(...)
  );
```

The first arm places no constraint on which room or generation a user can insert themselves into. A user who was kicked via `kick_and_rotate` retains their Supabase session and can call a direct `insert` to re-add themselves to the room at the new generation. `rotateOneRoomAsAdmin` builds its re-wrap list from raw `room_members` rows — a re-inserted user receives the next generation's key, completely defeating the eviction.

**Fix:** Apply the prototype's `0038` and `0039` migrations (renumber to `0043` and `0044` in his sequence). The corrected policy requires either (a) a valid, non-expired invite row for the device, (b) the caller is already a current-generation member (covers co-device key-forward), or (c) the caller is the room creator (covers the bootstrap-creation path).

---

### 2. `kick_and_rotate` — no device ownership check in the wrap loop

**Status:** Unpatched (prototype migration `0040` was never ported)

His latest `kick_and_rotate` definition (last redefined in `0023_retain_10_generations.sql`) validates that each wrap entry has non-null fields, then inserts directly:

```sql
if v_wrap_user is null or v_wrap_device is null
   or v_wrap_key is null or v_wrap_sig is null then
  raise exception 'malformed wrap entry';
end if;
-- No ownership check — inserts unconditionally:
insert into room_members (room_id, user_id, device_id, generation, ...);
```

A malicious room creator can call the RPC with a wrap entry where `device_id` belongs to an attacker-controlled device while `user_id` names a legitimate victim. This produces two compounding failures:

1. `my_generations_for_room` is user-keyed, so the victim's user account now has a row in the new generation — the victim passes the RLS generation arm and can read all new-gen `room_members` ciphertext rows and new blobs, granting post-eviction metadata access they should not have.
2. A silently duplicated room-key copy is routed to the attacker's device under the victim's name. The victim's legitimate devices find no row and cannot decrypt. The attacker's device can.
3. The `wrap_signature` over the mismatched row is cryptographically valid (signed by the creator's real device over the stated fields), so client-side signature verification passes and gives the victim no tamper signal — only a silent decryption failure.

**Fix:** Apply the prototype's `0040` migration (renumber to `0045`). It adds a pre-insert guard inside the wrap loop:

```sql
if not exists (
  select 1 from devices
  where id = v_wrap_device
    and user_id = v_wrap_user
    and revoked_at_ms is null
) then
  raise exception 'wrap entry: device % does not belong to user % or is revoked',
    v_wrap_device, v_wrap_user
    using errcode = 'check_violation';
end if;
```

---

### 3. `PendingApprovalBanner` skips wrap-signature verification

**Status:** Component divergence

The prototype's `PendingApprovalBanner` uses `verifyAndUnwrapMyRoomKey` from `bootstrap.ts`, which before decrypting:
- Confirms `signer_device_id` is non-null
- Fetches the signer's Ed25519 public key
- Calls `verifyMembershipWrap` to verify the `wrap_signature` over `(roomId, generation, memberUserId, memberDeviceId, wrappedRoomKey, signerDeviceId)`
- Only then calls `unwrapRoomKey`

His version calls raw `unwrapRoomKey` directly, skipping all signature verification. Combined with the missing `0038` insert-policy patch (item 1 above), this creates an attack path: a kicked user can self-insert a crafted `room_members` row, and a new pending device on the victim's account would accept the unsigned wrapped key without rejection. Even in isolation, bypassing signature verification on received room keys undermines the membership-op integrity model — any row that survives RLS is trusted without proof that a legitimate rotator signed it.

**Fix:** Replace the `unwrapRoomKey` call in `PendingApprovalBanner.tsx` with `verifyAndUnwrapMyRoomKey` from `@/lib/bootstrap`, matching the prototype at line 352.

---

## MODERATE — Apply before real-audience use

### 4. `megolm.ts` is 40 lines behind — missing ratchet cursor advancement

His `megolm.ts` is 315 lines; the prototype is 355. The diff shows two missing pieces:

- **`yieldToMain()`** — yields the main thread every 25 ratchet iterations via `setTimeout(resolve, 0)`. Without it, long ratchet walks (e.g. decrypting message index 150 cold) block the main thread and freeze UI.
- **`deriveMessageKeyAtIndexAndAdvance()`** — advances the snapshot cursor to `targetIndex + 1` and returns both the key and the next snapshot. Callers persist `nextSnapshot` so subsequent decrypts for the same session start from the advanced cursor (O(1)) rather than re-ratcheting from `startIndex` every time (O(n)). In a 200-message session, cold decryption of message 199 triggers 199 HMAC-SHA256 iterations — and then does it again for message 198, etc.

**Fix:** Copy the prototype's current `megolm.ts` verbatim.

---

## LOW — UX regression

### 5. `RecoveryPhraseModal` missing cancellation during upload

His `RecoveryPhraseModal` has a single `'uploading'` stage with no cancel button and no `cancelledRef` guard. The prototype splits this into `'uploading-pre-commit'` (cancellable — user hasn't committed yet) and `'uploading-post-commit'` (non-cancellable — blob is being finalised). Without the guard, a slow network can leave the modal stuck with no escape, and if the component unmounts mid-upload (navigation, tab close), a race against a stale closure can trigger a second `onDone` call.

**Fix:** Selectively apply the `cancelledRef` pattern and stage split from the prototype's `RecoveryPhraseModal.tsx`.

---

## Minor / Non-critical

### 6. `backoff.ts` and `load-mutex.ts` not ported

These utilities are used only in the prototype's reference-UX room page and status page — not in `e2ee-core/` or `bootstrap.ts`. His room page has its own equivalent logic. Not a foundation concern. If he ports the status page verbatim in future, he'll need to add both files.

---

## What is fully aligned (all verified)

| Area | Status |
|---|---|
| `e2ee-core/` — all 14 files | Exact line-for-line match |
| `livekit/` — adapter, index, token-fetcher | Exact match |
| `cache-store.ts` | Exact match |
| `tab-sync.ts` | Exact match |
| PIN-lock mandatory gate | Present — moved to `/auth/bootstrap/page.tsx` (cleaner than prototype) |
| Locked-device `hasWrappedIdentity` routing | Present in `/auth/bootstrap/page.tsx` |
| `bootOut` clears SSK + USK | Present — actually more complete than prototype |
| `KeyChangeBanner`, `PromoteDeviceModal`, `VerifyContactModal`, `RespondVerificationModal`, `IncomingCallToast` | All exact match |
| No dev/unguarded magic-link route | Confirmed absent — cleaner than prototype |
| `AGENTS.md` / `CLAUDE.md` present | Yes |
| 10-generation FS purge in `kick_and_rotate` | Present and correct |
| `signer_device_id ON DELETE SET NULL` (our `0036`/`0037`) | Present (`0041`/`0042`) |
| Megolm session rotation at 100 msgs / 7 days | Present in `e2ee-core/megolm.ts` |
| SAS emoji verification | Present and exact |

---

## Recommended action order

1. Apply migration `0043` (our `0038` content) — tighten `room_members_insert`  
2. Apply migration `0044` (our `0039` content) — restore creator bootstrap arm  
3. Apply migration `0045` (our `0040` content) — add device ownership check in `kick_and_rotate`  
4. Patch `PendingApprovalBanner.tsx` to use `verifyAndUnwrapMyRoomKey`  
5. Copy `megolm.ts` verbatim from prototype  
6. Apply `RecoveryPhraseModal` cancellation pattern (lower priority)

Items 1–4 are security-load-bearing. Items 5–6 are quality-of-life but should not be deferred long past launch.
