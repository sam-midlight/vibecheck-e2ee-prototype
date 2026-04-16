# Video-call audit — 2026-04-17

Audit of the E2EE video-call feature shipped 2026-04-16 (17 commits from `ad60912` through `e00ba7f`). Covers implementation review, industry-standard comparison, bugs/correctness issues, and UX observations.

## 1. What actually shipped

**Foundation** (V2-portable):
- `src/lib/e2ee-core/call.ts` — `CallKey` primitive, `wrapAndSignCallEnvelope`, `verifyCallEnvelope`, `zeroCallKey`
- `src/lib/livekit/{adapter,token-fetcher,index}.ts` — QVGA-locked adapter, 4-min silent JWT renewal, encryption-state events, receive-only fallback
- `public/livekit-e2ee-worker.mjs` + `scripts/sync-livekit-worker.mjs` — Turbopack workaround for bare-module Worker URLs
- `supabase/functions/livekit-token/index.ts` — deployed `verify_jwt:false` (ES256 gateway workaround)
- `supabase/migrations/0023_calls.sql` + `0024_one_active_call_per_room.sql`
- `bootstrap.ts` additions — `startCallInRoom`, `fetchAndUnwrapCallKey`, `rotateCallKeyForCurrentMembers`, `cascadeRevocationIntoActiveCalls`, `isDesignatedRotator`, `filterActiveCallMembers`, `listStaleCallDeviceIds`

**Reference UX**:
- `src/app/rooms/[id]/call/page.tsx`
- Live-call badge in `src/app/rooms/[id]/page.tsx`
- Status probe #17 — browser E2EE-insertable-streams support

**Post-MVP polish (same session)**: mic/cam toggles, receive-only mode, boot-on-end, `pagehide` keepalive `leave_call`, zombie-call seamless takeover, 7 s join watchdog.

---

## 2. Bugs & correctness findings

Ordered by severity.

### 2.1 [SECURITY] Silent E2EE downgrade escapes detection
`src/lib/livekit/adapter.ts:230–246` only flips to `failed` on a `ParticipantEncryptionStatusChanged(enabled=false)` event **if the prior state was `active`**. If the SFrame worker fails to engage at startup, the state stays at `pending`; the `pending → false` transition is ignored; the UI never warns; the SFU potentially sees plaintext.

**Fix**: change the condition to `if (this._encryptionState !== 'failed' && this._encryptionState !== 'unsupported')` — any non-terminal downgrade should alarm.

### 2.2 [TIMER LEAK] 7 s join watchdog is uncancellable
`call/page.tsx:536` — `setTimeout(..., 7_000)` isn't stored, so unmount during join doesn't clear it. It fires post-unmount, attempts a rotation, logs noisily. The ref-guards (`waitingForEnvelopeRef`, `adapterRef`) prevent corruption but not the work.

**Fix**: `const watchdog = setTimeout(...); return () => clearTimeout(watchdog);` in the join path, plus `clearTimeout` in `teardown`.

### 2.3 [RACE] Watchdog closes over stale `currentGeneration`
`call/page.tsx:550` — if a normal rotation lands during the 7 s wait, the watchdog still calls `rotateCallKeyForCurrentMembers({ oldGeneration: currentGeneration })` with the now-stale generation. RPC fails with `serialization_failure` and the `if (!/serialization/.test(msg))` guard swallows it. Correct in outcome, spammy in logs, mentally brittle.

**Fix**: read `keyedGenRef.current` at fire time, not join time.

### 2.4 [DEFENSE-IN-DEPTH] `fetchAndUnwrapCallKey` trusts cert-chain to catch revoked senders
`bootstrap.ts:822–854` — a malicious service-role actor returning a fake envelope with a revoked `sender_device_id` is blocked only because the revocation check inside `verifyPublicDevice` fails. Add an explicit `if (senderRow.revoked_at_ms !== null) throw` before cert verification. One line, eliminates a future regression window.

### 2.5 [RENEWAL] Transient 5xx doesn't fast-fail
`adapter.ts:480–506` — token-renewal backoff (1 s / 2 s / 4 s) continues without disconnecting; the call runs on the stale token until either success or expiry. The 1-minute lead absorbs this for typical transients, but tight. Low-severity, MVP-acceptable.

### 2.6 [MOBILE] `pagehide` + `fetch({keepalive:true})` on iOS Safari
`call/page.tsx:662–698` — iOS Safari historically doesn't fire `pagehide` reliably under swipe-close and `keepalive` fetch size limits are 64 KB — OK here but worth a validation probe. The 30 s heartbeat grace is the safety net, so functional, but the design doc claims "zombie-member window ~0" which is only true on desktop Chrome.

### 2.7 Concerns already named
- **Diagnostics panel open by default** (`call/page.tsx:765` `<details … open>`) — design doc §14 flags this as dev-flag TODO; still not gated.
- **"End for everyone" sits one button-press away from "Leave"** with no confirm. Any participant can end the call, not just the initiator (worth verifying `end_call` RPC in `0023_calls.sql`).
- **Large `CallInner` (~900 lines)** — rotator election, heartbeat, stale-sweep, leave path, and render all in one component. Extracting `useRotatorElection`, `useHeartbeat` hooks would help future maintenance.

---

## 3. Industry-standard comparison

Against Signal group calls, WhatsApp, Matrix / Element Call (MatrixRTC), Jitsi Meet E2EE, Zoom E2EE, and Google Meet CSE.

### 3.1 What matches mainstream
- **LiveKit + SFrame + `ExternalE2EEKeyProvider`** — this is *literally* the Element Call stack.
- **Per-device key wrapping via sealed-box to X25519** — matches Signal/WhatsApp/Matrix pairwise-to-device distribution.
- **UMK-signed device cert as identity anchor** — **cleaner than** Matrix's cross-signing TOFU (which eprint 2023/1300 found issues in) and stronger than Jitsi's XMPP-auth anchor.
- **5-min JWT + silent renewal as revocation liveness bound** — same pattern as MatrixRTC's `lk-jwt-service`.
- **30 s reconnection grace** — analogous to MatrixRTC's `keyRotationGracePeriod`.

### 3.2 Notable divergences

1. **Shared-CallKey + rotator election is an unusual choice.** Signal, WhatsApp, Matrix, and Jitsi all use **per-sender keys** — each participant encrypts with their own key, distributes via pairwise Olm/Signal channels, and rotates their *own* key on leave. No rotator. No election. No race.

   This design trades simpler key-distribution (one wrap per recipient per generation, not per-sender-per-recipient) against election complexity + single-point-of-compromise-per-generation blast radius. **Defensible** for a 2–8 person prototype but worth owning explicitly in the design doc.

2. **The "Matrix/CRDT pattern" label in design doc §6.3 is inaccurate.** MatrixRTC does not elect a rotator — it has no rotator, because per-sender keys. The lowest-`(joined_at, device_id)` + DB-uniqueness-CAS approach is closer to **Raft leader-election degenerated into optimistic CAS**, or simply optimistic concurrency control. It's a fine pattern, just not what Matrix does. Worth correcting to avoid future engineers hunting for Matrix docs that describe it.

3. **10-generation retention is longer than mainstream.** Signal retains old ratchet state for reorder tolerance but narrower than 10 past shared keys. Consider whether 10 is still the right number for *call* keys (vs. room keys where history-replay matters).

4. **Rotation on every join** — matches Signal (with 3 s grace) and Zoom (with epoch-vs-period split). MatrixRTC and Jitsi **ratchet forward on join instead of redistributing** — the joiner derives a start key that can't decrypt pre-join frames. A property worth considering post-launch for bandwidth at higher participant counts; irrelevant at 2–8.

### 3.3 Source references
- Signal: https://signal.org/blog/how-to-build-encrypted-group-calls/
- RingRTC: https://github.com/signalapp/ringrtc
- MatrixRTC MSC4143: https://github.com/matrix-org/matrix-spec-proposals/blob/toger5/matrixRTC/proposals/4143-matrix-rtc.md
- Element Call E2EE (DeepWiki): https://deepwiki.com/element-hq/element-call/2.3-end-to-end-encryption
- Jitsi E2EE: https://github.com/jitsi/lib-jitsi-meet/blob/master/doc/e2ee.md
- Jitsi vulns (Albrecht et al. 2023): https://eprint.iacr.org/2023/1118
- Zoom whitepaper v4: https://css.csail.mit.edu/6.858/2023/readings/zoom_e2e_v4.pdf
- Zoom analysis (Rösler et al. 2021): https://eprint.iacr.org/2021/486.pdf
- Matrix formal analysis: https://eprint.iacr.org/2023/1300.pdf
- Messenger E2EE whitepaper (Dec 2023): https://engineering.fb.com/wp-content/uploads/2023/12/MessengerEnd-to-EndEncryptionOverview_12-6-2023.pdf
- Google Workspace CSE: https://developers.google.com/workspace/cse/guides/configure-service

---

## 4. UX / UI observations

### 4.1 Works well
- Three-state `EncryptionBadge` (preflight / pending / active / failed) with a mandatory "leave now" button when not active while connected — genuinely better than most commercial clients.
- Zombie-call seamless takeover removes a visible failure mode.
- Boot-on-end navigates everyone cleanly.
- CRT scanline aesthetic is on-brand and composes via pure CSS (no canvas pipeline tax).

### 4.2 Rough edges worth polishing
- **"End for everyone" has no confirmation modal.** Destructive, one click, same prominence as Leave. At minimum: `confirm()` or a two-step press.
- **Diagnostic panel is `<details … open>` by default.** Design doc §14 calls this out — gate behind a dev env flag or `localStorage.debugCall`.
- **No speaking indicator / audio level meter** (design doc §14 TODO).
- **No incoming-call notification outside `/rooms/[id]`.** If you're on `/rooms` (list) or `/settings`, you miss the badge entirely.
- **`getUserMedia` rejection** drops into receive-only mode with an amber banner — good, but no explicit "grant camera access" affordance or OS-permissions link (iOS Safari requires Settings → Safari → Camera).
- **No mic/camera device picker.** First-available device only. Fine for MVP; known limitation.
- **Tiles are a static 2-column grid** (`grid-cols-2`). At 3+ participants the layout gets lopsided; at 5+ some tiles are off-screen. Consider a responsive grid keyed on tile count.
- **`VideoTile` audio-element container doesn't expose per-track volume / mute-remote.** Power-user feature; deferrable.
- **Local-participant tile has no "muted" overlay** when `micEnabled=false` — the toggle visually changes the button but not the tile.

---

## 5. Outstanding from design doc §14

### 5.1 Shipped since the §14 list was written (commit 330ca16)
- Mic + camera toggles ✓
- Receive-only fallback ✓
- Boot on call end ✓
- De-nudge (reduced redundant key-provider nudges) ✓

### 5.2 Still deferred
- Incoming-call toast + sound
- Speaking indicator
- HD mode toggle
- Wire-level frame-opaque verification
- Diagnostics panel dev-flag gate

---

## 6. Recommended one-line fixes

Low-risk, high-value — none require migrations; items 1–3 and 5 are foundation-layer and ride verbatim into V2.

1. **Adapter encryption-state downgrade** (`adapter.ts:235`): change condition to catch any downgrade from non-terminal states. *Security.*
2. **Revoked-sender explicit check** (`bootstrap.ts:852`): `if (senderRow.revoked_at_ms !== null) throw`. *Defense-in-depth.*
3. **Watchdog cleanup** (`call/page.tsx:536`): store the `setTimeout` id and clear it in teardown + `useEffect` return.
4. **Confirmation on "End for everyone"**: `window.confirm('End call for all participants?')`.
5. **Diagnostics panel gate**: `<details open={process.env.NODE_ENV==='development'}>` or `localStorage.debugCall==='1'`.
6. **Design doc §6.3 terminology correction**: replace "Matrix/CRDT pattern" with "optimistic concurrency control with DB-arbitrated uniqueness" or similar — accuracy matters for future readers.
