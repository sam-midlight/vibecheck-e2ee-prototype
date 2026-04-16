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
  getMyWrappedRoomKey,
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
  decryptBlob,
  decryptDeviceDisplayName,
  decryptImageAttachment,
  encryptBlob,
  generateDeviceKeyBundle,
  fromBase64,
  generateApprovalCode,
  generateApprovalSalt,
  generateRecoveryPhrase,
  generateCallKey,
  generateRoomKey,
  getSodium,
  getUserMasterKey,
  hashApprovalCode,
  isPhraseValid,
  prepareImageForUpload,
  randomBytes,
  signDeviceIssuance,
  signMessage,
  toHex,
  unwrapCallKey,
  unwrapRoomKey,
  unwrapUserMasterKeyWithPhrase,
  verifyCallEnvelope,
  verifyMessage,
  verifyPublicDevice,
  wrapAndSignCallEnvelope,
  wrapUserMasterKeyWithPhrase,
  type DeviceKeyBundle,
  type RoomKey,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { loadEnrolledDevice, wrapRoomKeyForAllMyDevices } from '@/lib/bootstrap';

const CHECK_NAMES = [
  'Sodium (libsodium WASM) ready',
  'Identity keys present in IndexedDB',
  'Published Ed25519 pubkey matches local',
  'Self-signature on published identity is valid',
  'Sign + verify roundtrip',
  'Encrypt + decrypt roundtrip (local, in-memory)',
  'Test room exists in Supabase',
  'Write encrypted blob',
  'Receive blob via realtime subscription',
  'Raw DB row is unreadable ciphertext (hex dump)',
  'Tamper detection (AEAD rejects modified ciphertext)',
  'Devices linked to this account',
  'Approval code hash round-trip',
  'Recovery phrase wrap + unwrap (local)',
  'Image attachment roundtrip (encrypt → upload → download → decrypt)',
  'Multi-device room key wrap + unwrap',
  'Call envelope sign + wrap + verify + unwrap roundtrip',
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
      try {
        const { detail, result } = await fn();
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

    await runStep(CHECK_NAMES[3], async () => {
      // In v3 the published "self_signature" is gone; we instead verify that
      // this device's cert chains to the published UMK pub.
      const umkPub = await fetchUserMasterKeyPub(userId);
      if (!umkPub) throw new Error('No UMK on server.');
      const devices = await fetchPublicDevices(userId);
      const me = devices.find((d) => d.deviceId === ctx.device!.deviceId);
      if (!me) throw new Error('This device not in published device list.');
      await verifyPublicDevice(me, umkPub.ed25519PublicKey);
      return { detail: 'device cert verifies against published UMK' };
    });

    await runStep(CHECK_NAMES[4], async () => {
      const msg = await randomBytes(64);
      const sig = await signMessage(msg, ctx.device!.ed25519PrivateKey);
      const ok = await verifyMessage(msg, sig, ctx.device!.ed25519PublicKey);
      if (!ok) throw new Error('signature did not verify');
      return { detail: `signed + verified 64 random bytes (sig=${sig.byteLength}B)` };
    });

    await runStep(CHECK_NAMES[5], async () => {
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

    const testRoom = await runStep(CHECK_NAMES[6], async () => {
      const existing = await findOrCreateTestRoom(userId, ctx.device!);
      return {
        detail: `room_id=${existing.roomId} gen=${existing.roomKey.generation}`,
        result: existing,
      };
    });
    if (!testRoom) return finish(allOk);
    ctx.roomId = testRoom.roomId;
    ctx.roomKey = testRoom.roomKey;

    ctx.lastBlobRow = await runStep(CHECK_NAMES[7], async () => {
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

    await runStep(CHECK_NAMES[8], async () => {
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

    await runStep(CHECK_NAMES[9], async () => {
      const row = ctx.lastBlobRow!;
      const cipherBytes = await fromBase64(row.ciphertext);
      const hex = await toHex(cipherBytes.slice(0, 48));
      return {
        detail: `raw DB bytes (first 48):\n${hex.match(/.{1,2}/g)!.join(' ')}\n...\nSupabase sees only this opaque ciphertext.`,
      };
    });

    await runStep(CHECK_NAMES[10], async () => {
      // Flip one byte of the last blob's ciphertext; decryptBlob must reject it.
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

    await runStep(CHECK_NAMES[11], async () => {
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

    await runStep(CHECK_NAMES[12], async () => {
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

    await runStep(CHECK_NAMES[13], async () => {
      // Local-only round-trip: generate a fresh phrase, wrap the current
      // identity, unwrap it, verify the private halves match. Never touches
      // recovery_blobs so the user's real escrow (if any) is untouched.
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

    await runStep(CHECK_NAMES[14], async () => {
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
        // Re-decode the plaintext to confirm it's still a valid image after the roundtrip.
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

    await runStep(CHECK_NAMES[15], async () => {
      // Create a temporary second device, sign its cert with UMK, verify
      // that wrapRoomKeyForAllMyDevices wraps for it, and confirm the
      // temp device can unwrap the room key. Full multi-device roundtrip.
      if (!ctx.umk) {
        return { detail: 'skipped — UMK not on this device' };
      }
      const tempId = crypto.randomUUID();
      const tempBundle = await generateDeviceKeyBundle(tempId);
      const tempCertSig = await signDeviceIssuance(
        {
          userId,
          deviceId: tempId,
          deviceEd25519PublicKey: tempBundle.ed25519PublicKey,
          deviceX25519PublicKey: tempBundle.x25519PublicKey,
          createdAtMs: Date.now(),
        },
        ctx.umk.ed25519PrivateKey,
      );
      // Register the temp device on the server so fetchPublicDevices
      // returns it, then wrap the test room's key for all devices.
      await registerDevice({
        userId,
        deviceId: tempId,
        deviceEd25519Pub: tempBundle.ed25519PublicKey,
        deviceX25519Pub: tempBundle.x25519PublicKey,
        issuanceCreatedAtMs: Date.now(),
        issuanceSignature: tempCertSig,
      });
      try {
        await wrapRoomKeyForAllMyDevices({
          roomId: ctx.roomId!,
          userId,
          roomKey: ctx.roomKey!,
          signerDevice: ctx.device!,
        });
        const tempWrapped = await getMyWrappedRoomKey({
          roomId: ctx.roomId!,
          deviceId: tempId,
          generation: ctx.roomKey!.generation,
        });
        if (!tempWrapped) throw new Error('no wrap created for temp device');
        const tempRk = await unwrapRoomKey(
          { wrapped: tempWrapped, generation: ctx.roomKey!.generation },
          tempBundle.x25519PublicKey,
          tempBundle.x25519PrivateKey,
        );
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

    await runStep(CHECK_NAMES[16], async () => {
      // Pure-crypto probe of call.ts: generate a CallKey, wrap it to a
      // temp recipient bundle, sign the envelope with the signer's bundle,
      // then verify + unwrap. Proves the envelope signature binds to call
      // id + gen + target and that the sealed bytes round-trip.
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

      // Tamper detection: flip one byte of the ciphertext and confirm the
      // signature no longer verifies.
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

    finish(allOk);

    function finish(ok: boolean) {
      setRunning(false);
      setSummary(ok ? 'All checks passed — E2EE is working end-to-end.' : 'One or more checks failed. See details above.');
    }
  }, [setCheck]);

  useEffect(() => {
    // Defer so we don't call setState synchronously inside the effect body.
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
    const wrapped = await getMyWrappedRoomKey({
      roomId: keep.id,
      deviceId: device.deviceId,
      generation: keep.current_generation,
    });
    if (wrapped) {
      const roomKey = await unwrapRoomKey(
        { wrapped, generation: keep.current_generation },
        device.x25519PublicKey,
        device.x25519PrivateKey,
      );
      return { roomId: keep.id, roomKey };
    }
  }

  const room = await createRoom({ kind: 'group', createdBy: userId });
  const roomKey = await generateRoomKey(room.current_generation);
  await wrapRoomKeyForAllMyDevices({
    roomId: room.id,
    userId,
    roomKey,
    signerDevice: device,
  });
  // Stamp the self-reference marker. Uses the existing `rooms_member_update`
  // policy — we just added ourselves as a current-gen member above.
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
