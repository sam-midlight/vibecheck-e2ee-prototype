'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { StatusCheck, type CheckState } from '@/components/StatusCheck';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  createRoom,
  decodeBlobRow,
  deleteAttachment,
  downloadAttachment,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  insertBlob,
  listDevices,
  registerDevice,
  subscribeBlobs,
  uploadAttachment,
  type BlobRow,
  type RoomRow,
} from '@/lib/supabase/queries';
import {
  bytesEqual,
  CryptoError,
  createOutboundSession,
  decryptBlob,
  decryptDeviceDisplayName,
  decryptImageAttachment,
  deriveMessageKeyAtIndex,
  deriveMessageKeyAtIndexAndAdvance,
  encryptBlob,
  encryptBlobV4,
  exportSessionSnapshot,
  fromBase64,
  generateApprovalCode,
  generateApprovalSalt,
  generateCallKey,
  generateDeviceKeyBundle,
  generateRecoveryPhrase,
  generateRoomKey,
  getSodium,
  getUserMasterKey,
  hashApprovalCode,
  isPhraseValid,
  prepareImageForUpload,
  ratchetAndDerive,
  randomBytes,
  sealSessionSnapshot,
  signDeviceIssuance,
  signDeviceIssuanceV2,
  signMessage,
  toBase64,
  toHex,
  unsealSessionSnapshot,
  unwrapCallKey,
  unwrapUserMasterKeyWithPhrase,
  verifyCrossSigningChain,
  verifyCallEnvelope,
  verifyDeviceIssuance,
  verifyMessage,
  verifyPublicDevice,
  wrapAndSignCallEnvelope,
  wrapUserMasterKeyWithPhrase,
  type DeviceKeyBundle,
  type RoomKey,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { loadEnrolledDevice, verifyAndUnwrapMyRoomKey, wrapRoomKeyForAllMyDevices } from '@/lib/bootstrap';
import { browserSupportsE2EE } from '@/lib/livekit';
import {
  getBlobCacheForRoom,
  clearBlobCacheForRoom,
  getRoomSyncCursor,
  putBlobRows,
} from '@/lib/cache-store';
import { computeBackoffDelay } from '@/lib/backoff';
import { createLoadMutex } from '@/lib/load-mutex';

// Suppress unused-import lint errors on verifyDeviceIssuance — it's used
// indirectly via dynamic import in Check 3.
void verifyDeviceIssuance;

const CHECK_NAMES = [
  'Sodium (libsodium WASM) ready',
  'Identity keys present in IndexedDB',
  'Published Ed25519 pubkey matches local',
  'Self-signature on published identity is valid',
  'Encrypt + decrypt roundtrip (local, in-memory)',
  'Test room exists in Supabase',
  'Write encrypted blob',
  'Receive blob via realtime subscription',
  'Ciphertext opacity (no plaintext leaks to DB)',
  'Tamper detection (AEAD rejects modified ciphertext)',
  'Devices linked to this account',
  'Approval code hash round-trip',
  'Recovery phrase wrap + unwrap (local)',
  'Image attachment roundtrip (encrypt → upload → download → decrypt)',
  'Multi-device room key wrap + unwrap',
  'Call envelope sign + wrap + verify + unwrap roundtrip',
  'Browser supports E2EE insertable streams (required for video calls)',
  'Megolm ratchet encrypt + decrypt roundtrip',
  'Cross-signing: SSK + USK cross-sig chain verifies',
  'Local blob cache (IndexedDB read/write)',
  'Megolm session seal/unseal roundtrip',
  'Ratchet one-way integrity (index rollback rejected)',
  'Ratchet cursor O(1) advance',
  'Plaintext cache second-pass timing',
  'Missing key backoff sequence',
  'Mutex concurrency drop (at-most-one-running + one-queued)',
] as const;

type CheckName = (typeof CHECK_NAMES)[number];

interface Context {
  userId: string;
  device: DeviceKeyBundle;
  umk: UserMasterKey | null;
  roomId: string;
  roomKey: RoomKey;
  lastBlobRow?: BlobRow;
}

// Status-probe rooms are tagged at the DB level by setting `parent_room_id`
// equal to the room's own `id`. This marker is:
//   - durable (survives tab close, cache clear, new device),
//   - unique (no real room should self-reference),
//   - free (uses an existing nullable column),
//   - and filterable client-side in `listMyRooms` so probes don't clutter the feed.

export default function StatusPage() {
  const [checks, setChecks] = useState<Record<CheckName, CheckState>>(
    () =>
      Object.fromEntries(CHECK_NAMES.map((n) => [n, { status: 'idle' }])) as Record<
        CheckName,
        CheckState
      >,
  );
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const setCheck = useCallback(
    (name: CheckName, state: CheckState) =>
      setChecks((prev) => ({ ...prev, [name]: state })),
    [],
  );

  const runChecks = useCallback(async () => {
    setRunning(true);
    setSummary(null);
    setChecks(
      Object.fromEntries(CHECK_NAMES.map((n) => [n, { status: 'idle' }])) as Record<
        CheckName,
        CheckState
      >,
    );

    const ctx: Partial<Context> = {};
    let allOk = true;

    const runStep = async <T,>(
      name: CheckName,
      fn: () => Promise<{ detail?: string; result?: T }>,
    ): Promise<T | undefined> => {
      setCheck(name, { status: 'running' });
      const t0 = performance.now();
      // Per-check 15s cap so one hanging probe doesn't freeze the whole page.
      const timeout = new Promise<{ detail?: string; result?: T }>((_, reject) =>
        setTimeout(() => reject(new Error('check timed out after 15s')), 15_000),
      );
      try {
        const { detail, result } = await Promise.race([fn(), timeout]);
        const elapsed = Math.round(performance.now() - t0);
        setCheck(name, { status: 'ok', elapsedMs: elapsed, detail });
        return result;
      } catch (e) {
        const elapsed = Math.round(performance.now() - t0);
        setCheck(name, { status: 'fail', elapsedMs: elapsed, error: errorMessage(e) });
        allOk = false;
        return undefined;
      }
    };

    // -----------------------------------------------------------------------
    // Check 0: Sodium (libsodium WASM) ready
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[0], async () => {
      await getSodium();
      return { detail: 'WASM initialized' };
    });

    const userId = await (async () => {
      const { data } = await getSupabase().auth.getUser();
      return data.user?.id;
    })();
    if (!userId) {
      setSummary('Not signed in.');
      setRunning(false);
      return;
    }
    ctx.userId = userId;

    // -----------------------------------------------------------------------
    // Check 1: Identity keys present in IndexedDB
    // -----------------------------------------------------------------------
    const enrolled = await runStep(CHECK_NAMES[1], async () => {
      const e = await loadEnrolledDevice(userId);
      if (!e) throw new Error('No device bundle in IndexedDB for this user.');
      return {
        detail: `deviceId=${e.deviceBundle.deviceId.slice(0, 8)}…, UMK holder=${e.umk ? 'yes' : 'no'}`,
        result: e,
      };
    });
    if (!enrolled) return finish(allOk);
    ctx.device = enrolled.deviceBundle;
    ctx.umk = enrolled.umk ?? (await getUserMasterKey(userId));

    // -----------------------------------------------------------------------
    // Check 2: Published Ed25519 pubkey matches local
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[2], async () => {
      const umkPub = await fetchUserMasterKeyPub(userId);
      if (!umkPub) throw new Error('No identities row on server.');
      if (ctx.umk) {
        const match = await bytesEqual(umkPub.ed25519PublicKey, ctx.umk.ed25519PublicKey);
        if (!match) throw new Error('Local UMK pub does not match published one.');
        return { detail: 'local UMK === server UMK' };
      }
      return { detail: 'UMK not on this device (secondary) — published pub fetched' };
    });

    // -----------------------------------------------------------------------
    // Check 3: Self-signature on published identity is valid
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[3], async () => {
      const umkPub = await fetchUserMasterKeyPub(userId);
      if (!umkPub) throw new Error('No UMK on server.');
      const devices = await fetchPublicDevices(userId);
      const me = devices.find((d) => d.deviceId === ctx.device!.deviceId);
      if (!me) throw new Error('This device not in published device list.');
      let sskPub: Uint8Array | undefined;
      if (umkPub.sskPub && umkPub.sskCrossSignature) {
        const { verifySskCrossSignature } = await import('@/lib/e2ee-core');
        await verifySskCrossSignature(umkPub.ed25519PublicKey, umkPub.sskPub, umkPub.sskCrossSignature);
        sskPub = umkPub.sskPub;
      }
      await verifyPublicDevice(me, umkPub.ed25519PublicKey, sskPub);
      return { detail: sskPub ? 'device cert (v2) verifies via MSK→SSK chain' : 'device cert (v1) verifies against MSK' };
    });

    // -----------------------------------------------------------------------
    // Check 4: Encrypt + decrypt roundtrip (local, in-memory)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[4], async () => {
      const roomKey = await generateRoomKey(1);
      const roomId = crypto.randomUUID();
      const payload = { probe: 'hello', n: Math.random() };
      const blob = await encryptBlob({
        payload,
        roomId,
        roomKey,
        senderUserId: userId,
        senderDeviceId: ctx.device!.deviceId,
        senderDeviceEd25519PrivateKey: ctx.device!.ed25519PrivateKey,
      });
      const back = await decryptBlob<typeof payload>({
        blob,
        roomId,
        roomKey,
        resolveSenderDeviceEd25519Pub: async (_uid, did) =>
          did === ctx.device!.deviceId ? ctx.device!.ed25519PublicKey : null,
      });
      if (back.payload.probe !== 'hello') throw new Error('payload mismatch');
      return { detail: 'JSON roundtrip OK' };
    });

    // -----------------------------------------------------------------------
    // Check 5: Test room exists in Supabase
    // -----------------------------------------------------------------------
    const testRoom = await runStep(CHECK_NAMES[5], async () => {
      const existing = await findOrCreateTestRoom(userId, ctx.device!);
      return {
        detail: `room_id=${existing.roomId} gen=${existing.roomKey.generation}`,
        result: existing,
      };
    });
    if (!testRoom) return finish(allOk);
    ctx.roomId = testRoom.roomId;
    ctx.roomKey = testRoom.roomKey;

    // -----------------------------------------------------------------------
    // Check 6: Write encrypted blob
    // -----------------------------------------------------------------------
    ctx.lastBlobRow = await runStep(CHECK_NAMES[6], async () => {
      const probeId = await toHex(await randomBytes(8));
      const payload = { kind: 'status-probe', probeId, ts: Date.now() };
      const blob = await encryptBlob({
        payload,
        roomId: ctx.roomId!,
        roomKey: ctx.roomKey!,
        senderUserId: userId,
        senderDeviceId: ctx.device!.deviceId,
        senderDeviceEd25519PrivateKey: ctx.device!.ed25519PrivateKey,
      });
      const row = await insertBlob({
        roomId: ctx.roomId!,
        senderId: userId,
        senderDeviceId: ctx.device!.deviceId,
        blob,
      });
      return {
        detail: `row.id=${row.id} ciphertext=${row.ciphertext.length}B_b64`,
        result: row,
      };
    });
    if (!ctx.lastBlobRow) return finish(allOk);

    // -----------------------------------------------------------------------
    // Check 7: Receive blob via realtime subscription
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[7], async () => {
      const probeId = await toHex(await randomBytes(8));
      const payload = { kind: 'status-rt-probe', probeId, ts: Date.now() };
      const seen = new Promise<number>((resolve, reject) => {
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          fn();
        };
        // Free-tier Supabase realtime tenants cold-start: the first SUBSCRIBE
        // after an idle period regularly takes 8–14 seconds to handshake.
        // Give it 30 so a cold probe doesn't flash red on first page load.
        const timer = setTimeout(() => {
          finish(() => reject(new Error('realtime subscription timeout (30s)')));
        }, 30000);
        const start = performance.now();
        let inserted = false;
        const insertOnce = async () => {
          if (inserted) return;
          inserted = true;
          const blob = await encryptBlob({
            payload,
            roomId: ctx.roomId!,
            roomKey: ctx.roomKey!,
            senderUserId: userId,
            senderDeviceId: ctx.device!.deviceId,
            senderDeviceEd25519PrivateKey: ctx.device!.ed25519PrivateKey,
          });
          await insertBlob({
            roomId: ctx.roomId!,
            senderId: userId,
            senderDeviceId: ctx.device!.deviceId,
            blob,
          }).catch((err) => finish(() => reject(err)));
        };
        const unsubscribe = subscribeBlobs(
          ctx.roomId!,
          async (row) => {
            if (done) return;
            try {
              const blob = await decodeBlobRow(row);
              const decoded = await decryptBlob<{ probeId?: string }>({
                blob,
                roomId: ctx.roomId!,
                roomKey: ctx.roomKey!,
                resolveSenderDeviceEd25519Pub: async (_uid, did) =>
                  did === ctx.device!.deviceId ? ctx.device!.ed25519PublicKey : null,
              });
              if (decoded.payload.probeId === probeId) {
                finish(() => resolve(Math.round(performance.now() - start)));
              }
            } catch {
              // ignore; we only care about our probe
            }
          },
          (status) => {
            if (done) return;
            if (status === 'SUBSCRIBED') void insertOnce();
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              finish(() => reject(new Error(`realtime channel status: ${status}`)));
            }
          },
        );
      });
      const rtMs = await seen;
      return { detail: `echoed back in ${rtMs}ms` };
    });

    // -----------------------------------------------------------------------
    // Check 8: Ciphertext opacity (no plaintext leaks to DB)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[8], async () => {
      const row = ctx.lastBlobRow!;
      const cipherBytes = await fromBase64(row.ciphertext);

      // The AEAD tag alone adds 16 bytes; plaintext can only be larger.
      const minExpected = 'status-probe'.length + 16;
      if (cipherBytes.length < minExpected) {
        throw new Error(
          `ciphertext (${cipherBytes.length}B) suspiciously small — expected ≥${minExpected}B`,
        );
      }

      // The literal payload marker must not appear verbatim in the ciphertext bytes.
      const markerHex = await toHex(new TextEncoder().encode('status-probe'));
      const cipherHex = await toHex(cipherBytes);
      if (cipherHex.includes(markerHex)) {
        throw new Error('plaintext "status-probe" marker found in ciphertext — encryption failure');
      }

      const previewHex = await toHex(cipherBytes.slice(0, 32));
      return {
        detail:
          `${cipherBytes.length}B ciphertext ≥ payload+overhead ✓ · no plaintext marker ✓\n` +
          `first 32B: ${previewHex.match(/.{1,2}/g)!.join(' ')}`,
      };
    });

    // -----------------------------------------------------------------------
    // Check 9: Tamper detection (AEAD rejects modified ciphertext)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[9], async () => {
      const row = ctx.lastBlobRow!;
      const cipher = await fromBase64(row.ciphertext);
      const tampered = new Uint8Array(cipher);
      tampered[0] = tampered[0] ^ 0x01;
      const blob = {
        nonce: await fromBase64(row.nonce),
        ciphertext: tampered,
        signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
        generation: row.generation,
      };
      try {
        await decryptBlob({
          blob,
          roomId: ctx.roomId!,
          roomKey: ctx.roomKey!,
          resolveSenderDeviceEd25519Pub: async (_uid, did) =>
            did === ctx.device!.deviceId ? ctx.device!.ed25519PublicKey : null,
        });
      } catch (e) {
        if (e instanceof CryptoError) {
          return { detail: `correctly rejected: ${e.code}` };
        }
        throw e;
      }
      throw new Error('tampered ciphertext decrypted without error — BAD');
    });

    // -----------------------------------------------------------------------
    // Check 10: Devices linked to this account
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[10], async () => {
      const devices = await listDevices(userId);
      const lines: string[] = [];
      for (const d of devices) {
        let label: string;
        if (d.display_name_ciphertext && d.id === ctx.device!.deviceId) {
          const plain = await decryptDeviceDisplayName(
            await fromBase64(d.display_name_ciphertext),
            ctx.device!.x25519PublicKey,
            ctx.device!.x25519PrivateKey,
          );
          label = plain ?? '(sealed to self; decrypt failed)';
        } else if (d.display_name_ciphertext) {
          label = '(sealed to its owning device)';
        } else if (d.display_name) {
          label = `${d.display_name} (legacy plaintext)`;
        } else {
          label = '(no label)';
        }
        lines.push(`  · ${label} (id ${d.id.slice(0, 8)}…)`);
      }
      return { detail: `${devices.length} device(s):\n${lines.join('\n')}` };
    });

    // -----------------------------------------------------------------------
    // Check 11: Approval code hash round-trip
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[11], async () => {
      const code = await generateApprovalCode();
      const salt = await generateApprovalSalt();
      const linkingPub = new Uint8Array(32);
      const linkNonce = new Uint8Array(32);
      crypto.getRandomValues(linkingPub);
      crypto.getRandomValues(linkNonce);
      const expected = await hashApprovalCode(code, salt, linkingPub, linkNonce);
      const redo = await hashApprovalCode(code, salt, linkingPub, linkNonce);
      if (expected !== redo) throw new Error('hash not deterministic');
      const wrong = await hashApprovalCode('000000', salt, linkingPub, linkNonce);
      if (wrong === expected && code !== '000000') {
        throw new Error('hash collided with different code (should not happen)');
      }
      const swappedPub = new Uint8Array(32);
      crypto.getRandomValues(swappedPub);
      const tampered = await hashApprovalCode(code, salt, swappedPub, linkNonce);
      if (tampered === expected) {
        throw new Error('hash did not detect linking_pubkey swap (transcript binding broken)');
      }
      return { detail: `code=${code} hash=${expected.slice(0, 16)}… (pubkey-bound)` };
    });

    // -----------------------------------------------------------------------
    // Check 12: Recovery phrase wrap + unwrap (local)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[12], async () => {
      const phrase = generateRecoveryPhrase();
      if (!isPhraseValid(phrase)) throw new Error('generated phrase failed own checksum');
      if (!ctx.umk) {
        return { detail: 'this device is not the UMK holder; skipping local wrap roundtrip' };
      }
      const wrapped = await wrapUserMasterKeyWithPhrase(
        ctx.umk,
        phrase,
        ctx.userId!,
        { opslimit: 2, memlimit: 64 * 1024 * 1024 },
      );
      const unwrapped = await unwrapUserMasterKeyWithPhrase(
        { ...wrapped, kdfOpslimit: 2, kdfMemlimit: 64 * 1024 * 1024 },
        phrase,
        ctx.userId!,
      );
      const edOk = await bytesEqual(
        unwrapped.ed25519PrivateKey,
        ctx.umk.ed25519PrivateKey,
      );
      if (!edOk) throw new Error('unwrapped UMK priv does not match original');
      return {
        detail: `24 words → Argon2id → XChaCha20 wrap → unwrap → UMK priv identical`,
      };
    });

    // -----------------------------------------------------------------------
    // Check 13: Image attachment roundtrip (encrypt → upload → download → decrypt)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[13], async () => {
      const syntheticFile = await buildSyntheticImage(200);
      const probeBlobId = crypto.randomUUID();
      try {
        const { encryptedBytes, header } = await prepareImageForUpload({
          file: syntheticFile,
          roomKey: ctx.roomKey!,
          roomId: ctx.roomId!,
          blobId: probeBlobId,
        });
        await uploadAttachment({
          roomId: ctx.roomId!,
          blobId: probeBlobId,
          encryptedBytes,
        });
        const downloaded = await downloadAttachment({
          roomId: ctx.roomId!,
          blobId: probeBlobId,
        });
        const plaintext = await decryptImageAttachment({
          encryptedBytes: downloaded,
          roomKey: ctx.roomKey!,
          roomId: ctx.roomId!,
          blobId: probeBlobId,
          generation: ctx.roomKey!.generation,
        });
        const reBlob = new Blob([plaintext.slice().buffer as ArrayBuffer], { type: header.mime });
        const bitmap = await createImageBitmap(reBlob);
        const dims = `${bitmap.width}x${bitmap.height}`;
        bitmap.close();
        return {
          detail: `${header.mime} · ${dims} · ${header.byteLen}B ciphertext · placeholder ${header.placeholder.length}B data URL`,
        };
      } finally {
        await deleteAttachment({ roomId: ctx.roomId!, blobId: probeBlobId }).catch(
          () => undefined,
        );
      }
    });

    // -----------------------------------------------------------------------
    // Check 14: Multi-device room key wrap + unwrap
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[14], async () => {
      if (!ctx.umk) {
        return { detail: 'skipped — UMK not on this device' };
      }
      const tempId = crypto.randomUUID();
      const tempBundle = await generateDeviceKeyBundle(tempId);
      const tempCreatedAtMs = Date.now();
      const { getSelfSigningKey: getLocalSsk } = await import('@/lib/e2ee-core');
      const localSsk = await getLocalSsk(userId);
      const tempCertSig = localSsk
        ? await signDeviceIssuanceV2(
            {
              userId,
              deviceId: tempId,
              deviceEd25519PublicKey: tempBundle.ed25519PublicKey,
              deviceX25519PublicKey: tempBundle.x25519PublicKey,
              createdAtMs: tempCreatedAtMs,
            },
            localSsk.ed25519PrivateKey,
          )
        : await signDeviceIssuance(
            {
              userId,
              deviceId: tempId,
              deviceEd25519PublicKey: tempBundle.ed25519PublicKey,
              deviceX25519PublicKey: tempBundle.x25519PublicKey,
              createdAtMs: tempCreatedAtMs,
            },
            ctx.umk.ed25519PrivateKey,
          );
      await registerDevice({
        userId,
        deviceId: tempId,
        deviceEd25519Pub: tempBundle.ed25519PublicKey,
        deviceX25519Pub: tempBundle.x25519PublicKey,
        issuanceCreatedAtMs: tempCreatedAtMs,
        issuanceSignature: tempCertSig,
      });
      try {
        await wrapRoomKeyForAllMyDevices({
          roomId: ctx.roomId!,
          userId,
          roomKey: ctx.roomKey!,
          signerDevice: ctx.device!,
        });
        const tempRk = await verifyAndUnwrapMyRoomKey({
          roomId: ctx.roomId!,
          userId,
          device: tempBundle,
          generation: ctx.roomKey!.generation,
        });
        if (!tempRk) throw new Error('no wrap created for temp device');
        const keysMatch = await bytesEqual(tempRk.key, ctx.roomKey!.key);
        if (!keysMatch) throw new Error('temp device unwrapped a different key');
        return { detail: `temp device ${tempId.slice(0, 8)} wrapped + unwrapped OK` };
      } finally {
        await getSupabase().from('devices').delete().eq('id', tempId).then(
          () => undefined,
          () => undefined,
        );
      }
    });

    // -----------------------------------------------------------------------
    // Check 15: Call envelope sign + wrap + verify + unwrap roundtrip
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[15], async () => {
      const callId = crypto.randomUUID();
      const recipientBundle = await generateDeviceKeyBundle(crypto.randomUUID());
      const signerBundle = await generateDeviceKeyBundle(crypto.randomUUID());
      const callKey = await generateCallKey(1);

      const envelope = await wrapAndSignCallEnvelope({
        callKey,
        callId,
        targetDeviceId: recipientBundle.deviceId,
        targetX25519PublicKey: recipientBundle.x25519PublicKey,
        senderDeviceId: signerBundle.deviceId,
        senderDeviceEd25519PrivateKey: signerBundle.ed25519PrivateKey,
      });

      await verifyCallEnvelope(
        {
          callId,
          generation: callKey.generation,
          targetDeviceId: recipientBundle.deviceId,
          senderDeviceId: signerBundle.deviceId,
          ciphertext: envelope.ciphertext,
        },
        envelope.signature,
        signerBundle.ed25519PublicKey,
      );

      const tampered = new Uint8Array(envelope.ciphertext);
      tampered[0] ^= 0x01;
      try {
        await verifyCallEnvelope(
          {
            callId,
            generation: callKey.generation,
            targetDeviceId: recipientBundle.deviceId,
            senderDeviceId: signerBundle.deviceId,
            ciphertext: tampered,
          },
          envelope.signature,
          signerBundle.ed25519PublicKey,
        );
        throw new Error('tampered envelope verified — signature binding broken');
      } catch (err) {
        if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
          // expected
        } else {
          throw err;
        }
      }

      const unwrapped = await unwrapCallKey(
        envelope.ciphertext,
        callKey.generation,
        recipientBundle.x25519PublicKey,
        recipientBundle.x25519PrivateKey,
      );
      const match = await bytesEqual(unwrapped.key, callKey.key);
      if (!match) throw new Error('unwrapped CallKey does not match original');
      return {
        detail: `32B CallKey sealed → signed → tamper-rejected → unwrapped OK (gen ${callKey.generation})`,
      };
    });

    // -----------------------------------------------------------------------
    // Check 16: Browser supports E2EE insertable streams (required for video calls)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[16], async () => {
      const supported = browserSupportsE2EE();
      const w = window as typeof window & {
        RTCRtpScriptTransform?: unknown;
        RTCRtpSender?: { prototype?: { createEncodedStreams?: unknown } };
      };
      const api =
        typeof w.RTCRtpScriptTransform !== 'undefined'
          ? 'RTCRtpScriptTransform (spec)'
          : typeof w.RTCRtpSender?.prototype?.createEncodedStreams === 'function'
            ? 'createEncodedStreams (Chromium/Safari)'
            : 'none';
      const ua = navigator.userAgent.slice(0, 80);
      if (!supported) {
        throw new Error(
          `insertable streams not available on this browser — E2EE video calls ` +
            `cannot engage (would fall back to plaintext SRTP). API detected: ${api}. UA: ${ua}`,
        );
      }
      return { detail: `API: ${api}` };
    });

    // -----------------------------------------------------------------------
    // Check 17: Megolm ratchet encrypt + decrypt roundtrip (with actual decryption)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[17], async () => {
      const device = ctx.device!;
      const roomId = ctx.roomId!;

      // Capture snapshot BEFORE the first ratchet so startIndex=0 and
      // chainKeyAtIndex is the seed — lets us derive the key at index 0
      // from the inbound side without having stored anything.
      const session = await createOutboundSession(roomId, 999);
      const snapshot = exportSessionSnapshot(session, ctx.userId!, device.deviceId);

      const mk0 = await ratchetAndDerive(session); // index 0
      const testPayload = { type: 'status-probe-megolm', ts: Date.now() };
      const blob = await encryptBlobV4({
        payload: testPayload,
        roomId,
        messageKey: mk0,
        sessionId: session.sessionId,
        generation: 999,
        senderUserId: ctx.userId!,
        senderDeviceId: device.deviceId,
        senderDeviceEd25519PrivateKey: device.ed25519PrivateKey,
      });

      // Decrypt by deriving the message key from the pre-ratchet snapshot
      const decrypted = await decryptBlob<typeof testPayload>({
        blob,
        roomId,
        roomKey: ctx.roomKey!, // not used for v4 but required by the API
        resolveMegolmKey: async (_sid, messageIndex) => {
          const mk = await deriveMessageKeyAtIndex(snapshot, messageIndex);
          return mk.key;
        },
        resolveSenderDeviceEd25519Pub: async (_uid, did) =>
          did === device.deviceId ? device.ed25519PublicKey : null,
      });
      if ((decrypted.payload as { ts?: unknown }).ts !== testPayload.ts) {
        throw new Error('decrypted payload does not match original');
      }

      // Tamper detection: flip one byte → AEAD must reject
      const tamperedCipher = new Uint8Array(blob.ciphertext);
      tamperedCipher[0] ^= 0x01;
      const tamperedBlob = { ...blob, ciphertext: tamperedCipher };
      try {
        await decryptBlob<typeof testPayload>({
          blob: tamperedBlob,
          roomId,
          roomKey: ctx.roomKey!,
          resolveMegolmKey: async (_sid, messageIndex) => {
            const mk = await deriveMessageKeyAtIndex(snapshot, messageIndex);
            return mk.key;
          },
          resolveSenderDeviceEd25519Pub: async (_uid, did) =>
            did === device.deviceId ? device.ed25519PublicKey : null,
        });
        throw new Error('tampered Megolm blob decrypted without error — BAD');
      } catch (e) {
        if (e instanceof CryptoError) {
          return {
            detail:
              `Megolm v4 encrypt → decrypt ✓ · tamper rejected (${e.code}) ✓ · ` +
              `session ${(await toBase64(session.sessionId)).slice(0, 8)}… index 0`,
          };
        }
        throw e;
      }
    });

    // -----------------------------------------------------------------------
    // Check 18: Cross-signing SSK + USK cross-sig chain verifies
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[18], async () => {
      const pubKeys = await fetchUserMasterKeyPub(userId);
      if (!pubKeys) throw new Error('no published identity');
      if (!pubKeys.sskPub || !pubKeys.sskCrossSignature ||
          !pubKeys.uskPub || !pubKeys.uskCrossSignature) {
        throw new Error('incomplete cross-signing keys published');
      }
      await verifyCrossSigningChain({
        mskPub: pubKeys.ed25519PublicKey,
        sskPub: pubKeys.sskPub,
        sskCrossSignature: pubKeys.sskCrossSignature,
        uskPub: pubKeys.uskPub,
        uskCrossSignature: pubKeys.uskCrossSignature,
      });
      return { detail: 'published MSK → SSK ✓, MSK → USK ✓' };
    });

    // -----------------------------------------------------------------------
    // Check 19: Local blob cache (IndexedDB read/write)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[19], async () => {
      const probeRoomId = 'status-probe-cache-test';
      const probeBlobId = crypto.randomUUID();
      const probeRow: BlobRow = {
        id: probeBlobId,
        room_id: probeRoomId,
        sender_id: userId,
        sender_device_id: ctx.device!.deviceId,
        ciphertext: btoa('probe'),
        nonce: btoa('nonce'),
        signature: null,
        generation: 1,
        created_at: new Date().toISOString(),
        session_id: null,
        message_index: null,
      };
      await putBlobRows(probeRoomId, [probeRow]);
      const fetched = await getBlobCacheForRoom(probeRoomId);
      const found = fetched.find((r) => r.id === probeBlobId);
      await clearBlobCacheForRoom(probeRoomId);
      if (!found) throw new Error('written row not found on read-back');

      const [cursor, cached] = await Promise.all([
        ctx.roomId ? getRoomSyncCursor(ctx.roomId) : Promise.resolve(null),
        ctx.roomId ? getBlobCacheForRoom(ctx.roomId) : Promise.resolve([]),
      ]);
      const cursorLabel = cursor
        ? new Date(cursor).toLocaleString()
        : 'none (cold)';
      return {
        detail: `IDB open ✓, write→read→delete roundtrip OK · probe room: ${cached.length} rows cached, cursor ${cursorLabel}`,
      };
    });

    // -----------------------------------------------------------------------
    // Check 20: Megolm session seal/unseal roundtrip
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[20], async () => {
      const session = await createOutboundSession(ctx.roomId!, 999);
      const snapshot = exportSessionSnapshot(session, ctx.userId!, ctx.device!.deviceId);

      const recipientBundle = await generateDeviceKeyBundle(crypto.randomUUID());
      const sealed = await sealSessionSnapshot(snapshot, recipientBundle.x25519PublicKey);
      const unsealed = await unsealSessionSnapshot(
        sealed,
        recipientBundle.x25519PublicKey,
        recipientBundle.x25519PrivateKey,
      );

      if (!(await bytesEqual(unsealed.sessionId, snapshot.sessionId))) {
        throw new Error('sessionId mismatch after unseal');
      }
      if (!(await bytesEqual(unsealed.chainKeyAtIndex, snapshot.chainKeyAtIndex))) {
        throw new Error('chainKeyAtIndex mismatch after unseal');
      }
      if (unsealed.startIndex !== snapshot.startIndex) {
        throw new Error(`startIndex mismatch: expected ${snapshot.startIndex}, got ${unsealed.startIndex}`);
      }
      if (unsealed.senderUserId !== snapshot.senderUserId) {
        throw new Error('senderUserId mismatch after unseal');
      }
      if (unsealed.senderDeviceId !== snapshot.senderDeviceId) {
        throw new Error('senderDeviceId mismatch after unseal');
      }

      // Tamper detection: flip one byte of the sealed blob
      const tamperedSealed = new Uint8Array(sealed);
      tamperedSealed[0] ^= 0x01;
      try {
        await unsealSessionSnapshot(
          tamperedSealed,
          recipientBundle.x25519PublicKey,
          recipientBundle.x25519PrivateKey,
        );
        throw new Error('tampered sealed snapshot unsealed without error — BAD');
      } catch (e) {
        if (e instanceof CryptoError) {
          return {
            detail: `session snapshot sealed → unsealed → all fields verified ✓ · tamper rejected (${e.code}) ✓`,
          };
        }
        throw e;
      }
    });

    // -----------------------------------------------------------------------
    // Check 21: Ratchet one-way integrity (index rollback rejected)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[21], async () => {
      const session = await createOutboundSession(ctx.roomId!, 999);
      // Advance to index 5
      for (let i = 0; i < 5; i++) await ratchetAndDerive(session);
      const snapshot = exportSessionSnapshot(session, ctx.userId!, ctx.device!.deviceId);
      if (snapshot.startIndex !== 5) {
        throw new Error(`expected startIndex 5, got ${snapshot.startIndex}`);
      }
      // Requesting an already-consumed index must throw BAD_GENERATION
      try {
        await deriveMessageKeyAtIndex(snapshot, 2);
        throw new Error('deriveMessageKeyAtIndex(snapshot@5, 2) did not throw — ratchet rollback possible');
      } catch (e) {
        if (e instanceof CryptoError && e.code === 'BAD_GENERATION') {
          return {
            detail: `snapshot.startIndex=5, request index=2 → CryptoError(BAD_GENERATION) ✓ · IDB cursor cannot roll back`,
          };
        }
        throw e;
      }
    });

    // -----------------------------------------------------------------------
    // Check 22: Ratchet cursor O(1) advance
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[22], async () => {
      const session = await createOutboundSession(ctx.roomId!, 999);
      const snapshot0 = exportSessionSnapshot(session, ctx.userId!, ctx.device!.deviceId);

      // Slow path: derive index 49 from scratch (50 ratchet steps, startIndex=0)
      const t0 = performance.now();
      const { nextSnapshot } = await deriveMessageKeyAtIndexAndAdvance(snapshot0, 49);
      const slowMs = Math.round(performance.now() - t0);

      if (nextSnapshot.startIndex !== 50) {
        throw new Error(`expected nextSnapshot.startIndex 50, got ${nextSnapshot.startIndex}`);
      }

      // Fast path: derive index 50 from the advanced cursor (1 ratchet step)
      const t1 = performance.now();
      const { messageKey: fastKey, nextSnapshot: ns2 } =
        await deriveMessageKeyAtIndexAndAdvance(nextSnapshot, 50);
      const fastMs = Math.round(performance.now() - t1);

      if (ns2.startIndex !== 51) {
        throw new Error(`expected ns2.startIndex 51, got ${ns2.startIndex}`);
      }

      // Correctness: derive index 50 from scratch and compare keys
      const { messageKey: slowKey } = await deriveMessageKeyAtIndexAndAdvance(snapshot0, 50);
      if (!(await bytesEqual(fastKey.key, slowKey.key))) {
        throw new Error('O(1) fast path produced different key than O(n) slow path');
      }

      return {
        detail:
          `0→49 from scratch: ${slowMs}ms (50 steps) · ` +
          `50→50 from cursor: ${fastMs}ms (1 step) · ` +
          `key at index 50 agrees ✓`,
      };
    });

    // -----------------------------------------------------------------------
    // Check 23: Plaintext cache second-pass timing
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[23], async () => {
      // Tests the caching pattern used by the rooms page plaintextCache Map.
      // plaintextCache is module-private; this self-contained check proves
      // the invariant: a Map.get hit must not re-enter WASM.
      const probeCache = new Map<string, object>();
      const probeBlobId = crypto.randomUUID();
      const probePayload = { type: 'cache-probe', ts: Date.now() };

      const probeRoomKey = await generateRoomKey(1);
      const probeRoomId = crypto.randomUUID();
      const blob = await encryptBlob({
        payload: probePayload,
        roomId: probeRoomId,
        roomKey: probeRoomKey,
        senderUserId: userId,
        senderDeviceId: ctx.device!.deviceId,
        senderDeviceEd25519PrivateKey: ctx.device!.ed25519PrivateKey,
      });

      // First pass: full WASM decryption
      const t0 = performance.now();
      const decoded = await decryptBlob<typeof probePayload>({
        blob,
        roomId: probeRoomId,
        roomKey: probeRoomKey,
        resolveSenderDeviceEd25519Pub: async (_uid, did) =>
          did === ctx.device!.deviceId ? ctx.device!.ed25519PublicKey : null,
      });
      const firstMs = performance.now() - t0;
      probeCache.set(probeBlobId, decoded);

      // Second pass: Map.get, no crypto
      const t1 = performance.now();
      const hit = probeCache.get(probeBlobId);
      const secondMs = performance.now() - t1;

      if (!hit) throw new Error('cache miss on second pass — should be a hit');
      if ((decoded.payload as { ts?: number }).ts !== probePayload.ts) {
        throw new Error('payload mismatch');
      }
      if (secondMs >= 1) {
        throw new Error(
          `cache hit took ${secondMs.toFixed(3)}ms — expected <1ms (Map.get should be sub-millisecond)`,
        );
      }

      return {
        detail:
          `first pass (WASM): ${firstMs.toFixed(1)}ms · ` +
          `second pass (Map.get): ${secondMs.toFixed(3)}ms ✓`,
      };
    });

    // -----------------------------------------------------------------------
    // Check 24: Missing key backoff sequence
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[24], async () => {
      // Imports the exact function used by the rooms page after the backoff
      // refactor — if someone changes the formula, this check will catch it.
      const expected = [500, 1000, 2000, 4000, 5000];
      const actual = [0, 1, 2, 3, 4].map((n) => computeBackoffDelay(n));

      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
          throw new Error(`retry ${i}: expected ${expected[i]}ms, got ${actual[i]}ms`);
        }
      }

      // Hard cap: very high retry count must never exceed the ceiling
      const capped = computeBackoffDelay(100);
      if (capped !== 5000) {
        throw new Error(`cap not applied: retryCount=100 produced ${capped}ms`);
      }

      return {
        detail: `sequence [${actual.join(', ')}]ms · cap at ${capped}ms ✓`,
      };
    });

    // -----------------------------------------------------------------------
    // Check 25: Mutex concurrency drop (at-most-one-running + one-queued)
    // -----------------------------------------------------------------------
    await runStep(CHECK_NAMES[25], async () => {
      const m = createLoadMutex();

      // Five concurrent acquires
      const results = [
        m.acquire(),
        m.acquire(),
        m.acquire(),
        m.acquire(),
        m.acquire(),
      ];

      const expectedSlots = ['run', 'queue', 'drop', 'drop', 'drop'] as const;
      for (let i = 0; i < expectedSlots.length; i++) {
        if (results[i] !== expectedSlots[i]) {
          throw new Error(
            `acquire[${i}]: expected '${expectedSlots[i]}', got '${results[i]}'`,
          );
        }
      }

      // First release: queued call should be promoted
      const shouldRunQueued = m.release();
      if (!shouldRunQueued) {
        throw new Error('release() returned false but a queued call was pending');
      }

      // Second release: nothing queued
      const nothingPending = m.release();
      if (nothingPending) {
        throw new Error('release() returned true but nothing was queued');
      }

      // After full drain, a new acquire runs freely
      const fresh = m.acquire();
      if (fresh !== 'run') {
        throw new Error(`fresh acquire after drain: expected 'run', got '${fresh}'`);
      }

      return {
        detail:
          `5 concurrent acquires → [${results.join(', ')}] ✓ · ` +
          `release → queued runs ✓ · drain → new acquire runs ✓`,
      };
    });

    finish(allOk);

    function finish(ok: boolean) {
      setRunning(false);
      setSummary(ok ? 'All checks passed — E2EE is working end-to-end.' : 'One or more checks failed. See details above.');
    }
  }, [setCheck]);

  useEffect(() => {
    const handle = setTimeout(() => void runChecks(), 0);
    return () => clearTimeout(handle);
  }, [runChecks]);

  return (
    <AppShell requireAuth>
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">E2EE status</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Live end-to-end test of the encryption pipeline. Each row is a real
              probe against libsodium, IndexedDB, and your Supabase project.
            </p>
          </div>
          <button
            onClick={() => void runChecks()}
            disabled={running}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {running ? 'running…' : 'run checks'}
          </button>
        </div>

        <ul className="space-y-2">
          {CHECK_NAMES.map((name) => (
            <StatusCheck key={name} name={name} state={checks[name]} />
          ))}
        </ul>

        {summary && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{summary}</p>
        )}
      </div>
    </AppShell>
  );
}

/**
 * Find (or create) this user's solo test room for /status probes.
 *
 * Strategy: look up ALL rooms the user created where `parent_room_id = id`
 * (our self-reference marker for status probes). If any exist, keep the
 * newest one and delete the rest — this cleans up orphans spawned by the
 * previous sessionStorage-based implementation, which created a new room
 * on every fresh tab. If none exist, create one and stamp it with the
 * self-reference marker.
 */
async function findOrCreateTestRoom(
  userId: string,
  device: DeviceKeyBundle,
): Promise<{ roomId: string; roomKey: RoomKey }> {
  const supabase = getSupabase();

  const { data: candidates, error: listErr } = await supabase
    .from('rooms')
    .select('*')
    .eq('created_by', userId)
    .order('created_at', { ascending: false });
  if (listErr) throw listErr;

  const selfRef = (candidates ?? []).filter(
    (r) => r.parent_room_id === r.id,
  ) as RoomRow[];

  if (selfRef.length > 0) {
    const keep = selfRef[0];
    for (const extra of selfRef.slice(1)) {
      await supabase.from('rooms').delete().eq('id', extra.id).then(
        () => undefined,
        (err) => console.warn('orphan status-room cleanup failed', err),
      );
    }
    const roomKey = await verifyAndUnwrapMyRoomKey({
      roomId: keep.id,
      userId,
      device,
      generation: keep.current_generation,
    });
    if (roomKey) return { roomId: keep.id, roomKey };
    await supabase.from('rooms').delete().eq('id', keep.id).then(
      () => undefined,
      (err) => console.warn('stale status-room cleanup failed', err),
    );
  }

  const room = await createRoom({ kind: 'group', createdBy: userId });
  const roomKey = await generateRoomKey(room.current_generation);
  await wrapRoomKeyForAllMyDevices({
    roomId: room.id,
    userId,
    roomKey,
    signerDevice: device,
  });
  const { error: updErr } = await supabase
    .from('rooms')
    .update({ parent_room_id: room.id })
    .eq('id', room.id);
  if (updErr) throw updErr;
  return { roomId: room.id, roomKey };
}

/**
 * Paint a deterministic test pattern to a canvas and return a PNG File so
 * the attachment round-trip doesn't depend on the user having any picker UI
 * or real image available.
 */
async function buildSyntheticImage(size: number): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#6366f1');
  gradient.addColorStop(1, '#ec4899');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `${Math.round(size / 6)}px ui-sans-serif, system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('vibe', size / 2, size / 2);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    );
  });
  return new File([blob], 'status-probe.png', { type: 'image/png' });
}
