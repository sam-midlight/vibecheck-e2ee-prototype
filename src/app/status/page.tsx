'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { StatusCheck, type CheckState } from '@/components/StatusCheck';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  addRoomMember,
  createRoom,
  decodeBlobRow,
  fetchIdentity,
  getMyWrappedRoomKey,
  insertBlob,
  listDevices,
  subscribeBlobs,
  type BlobRow,
  type RoomRow,
} from '@/lib/supabase/queries';
import {
  bytesEqual,
  CryptoError,
  decryptBlob,
  encryptBlob,
  fromBase64,
  generateApprovalCode,
  generateApprovalSalt,
  generateRecoveryPhrase,
  generateRoomKey,
  getIdentity,
  getSodium,
  hashApprovalCode,
  isPhraseValid,
  randomBytes,
  signMessage,
  toBase64,
  toHex,
  unwrapIdentityWithPhrase,
  unwrapRoomKey,
  verifyMessage,
  verifySelfSignature,
  wrapIdentityWithPhrase,
  wrapRoomKeyFor,
  type Identity,
  type RoomKey,
} from '@/lib/e2ee-core';

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
] as const;

type CheckName = (typeof CHECK_NAMES)[number];

interface Context {
  userId: string;
  identity: Identity;
  roomId: string;
  roomKey: RoomKey;
  lastBlobRow?: BlobRow;
}

const TEST_ROOM_TAG = '__status__';

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

    ctx.identity = await runStep(CHECK_NAMES[1], async () => {
      const identity = await getIdentity(userId);
      if (!identity) throw new Error('No identity found in IndexedDB for this user.');
      return {
        detail: `ed25519_pub=${(await toBase64(identity.ed25519PublicKey)).slice(0, 24)}…`,
        result: identity,
      };
    });
    if (!ctx.identity) return finish(allOk);

    await runStep(CHECK_NAMES[2], async () => {
      const pub = await fetchIdentity(userId);
      if (!pub) throw new Error('No identities row on server.');
      const match = await bytesEqual(pub.ed25519PublicKey, ctx.identity!.ed25519PublicKey);
      if (!match) throw new Error('Local Ed25519 pub does not match published one.');
      return { detail: 'local === server' };
    });

    await runStep(CHECK_NAMES[3], async () => {
      const pub = await fetchIdentity(userId);
      if (!pub) throw new Error('Identity not on server.');
      const ok = await verifySelfSignature(pub);
      if (!ok) throw new Error('self_signature does not verify against ed25519_pub.');
      return { detail: 'sign(ed_pub || x_pub) verified' };
    });

    await runStep(CHECK_NAMES[4], async () => {
      const msg = await randomBytes(64);
      const sig = await signMessage(msg, ctx.identity!.ed25519PrivateKey);
      const ok = await verifyMessage(msg, sig, ctx.identity!.ed25519PublicKey);
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
        senderEd25519PrivateKey: ctx.identity!.ed25519PrivateKey,
      });
      const back = await decryptBlob<typeof payload>({
        blob,
        roomId,
        roomKey,
        senderEd25519PublicKey: ctx.identity!.ed25519PublicKey,
      });
      if (back.probe !== 'hello') throw new Error('payload mismatch');
      return { detail: 'JSON roundtrip OK' };
    });

    const testRoom = await runStep(CHECK_NAMES[6], async () => {
      const existing = await findOrCreateTestRoom(userId, ctx.identity!);
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
        senderEd25519PrivateKey: ctx.identity!.ed25519PrivateKey,
      });
      const row = await insertBlob({
        roomId: ctx.roomId!,
        senderId: userId,
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
        const timer = setTimeout(() => {
          finish(() => reject(new Error('realtime subscription timeout (15s)')));
        }, 15000);
        const start = performance.now();
        let inserted = false;
        const insertOnce = async () => {
          if (inserted) return;
          inserted = true;
          const blob = await encryptBlob({
            payload,
            roomId: ctx.roomId!,
            roomKey: ctx.roomKey!,
            senderEd25519PrivateKey: ctx.identity!.ed25519PrivateKey,
          });
          await insertBlob({
            roomId: ctx.roomId!,
            senderId: userId,
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
                senderEd25519PublicKey: ctx.identity!.ed25519PublicKey,
              });
              if (decoded.probeId === probeId) {
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
        signature: await fromBase64(row.signature),
        generation: row.generation,
      };
      try {
        await decryptBlob({
          blob,
          roomId: ctx.roomId!,
          roomKey: ctx.roomKey!,
          senderEd25519PublicKey: ctx.identity!.ed25519PublicKey,
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
      const names = devices
        .map((d) => `  · ${d.display_name} (id ${d.id.slice(0, 8)}…)`)
        .join('\n');
      return { detail: `${devices.length} device(s):\n${names}` };
    });

    await runStep(CHECK_NAMES[12], async () => {
      const code = await generateApprovalCode();
      const salt = await generateApprovalSalt();
      const expected = await hashApprovalCode(code, salt);
      const redo = await hashApprovalCode(code, salt);
      if (expected !== redo) throw new Error('hash not deterministic');
      const wrong = await hashApprovalCode('000000', salt);
      if (wrong === expected && code !== '000000') {
        throw new Error('hash collided with different code (should not happen)');
      }
      return { detail: `code=${code} hash=${expected.slice(0, 16)}…` };
    });

    await runStep(CHECK_NAMES[13], async () => {
      // Local-only round-trip: generate a fresh phrase, wrap the current
      // identity, unwrap it, verify the private halves match. Never touches
      // recovery_blobs so the user's real escrow (if any) is untouched.
      const phrase = generateRecoveryPhrase();
      if (!isPhraseValid(phrase)) throw new Error('generated phrase failed own checksum');
      const wrapped = await wrapIdentityWithPhrase(
        ctx.identity!,
        phrase,
        ctx.userId!,
        { opslimit: 2, memlimit: 64 * 1024 * 1024 }, // lower Argon2 cost for the /status check only
      );
      const unwrapped = await unwrapIdentityWithPhrase(
        { ...wrapped, kdfOpslimit: 2, kdfMemlimit: 64 * 1024 * 1024 },
        phrase,
        ctx.userId!,
      );
      const edOk = await bytesEqual(
        unwrapped.ed25519PrivateKey,
        ctx.identity!.ed25519PrivateKey,
      );
      const xOk = await bytesEqual(
        unwrapped.x25519PrivateKey,
        ctx.identity!.x25519PrivateKey,
      );
      if (!edOk || !xOk) {
        throw new Error('unwrapped private keys do not match original');
      }
      return {
        detail: `24 words → Argon2id → XChaCha20 wrap → unwrap → priv halves identical`,
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
 * We use `parent_room_id` to mark it in a single place via a deterministic
 * marker: a self-reference. Actually simpler — we list the user's rooms and
 * find one of kind 'group' created by self with exactly one member (self).
 * On first call we create one. Returns unwrapped room key.
 */
async function findOrCreateTestRoom(
  userId: string,
  identity: Identity,
): Promise<{ roomId: string; roomKey: RoomKey }> {
  const supabase = getSupabase();
  // Look for an existing test room marked in our local state.
  // We store the test room id in sessionStorage to avoid re-querying.
  const cached = sessionStorage.getItem(TEST_ROOM_TAG);
  if (cached) {
    const { data: existingRoom, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', cached)
      .maybeSingle<RoomRow>();
    if (!error && existingRoom) {
      const wrapped = await getMyWrappedRoomKey({
        roomId: existingRoom.id,
        userId,
        generation: existingRoom.current_generation,
      });
      if (wrapped) {
        const roomKey = await unwrapRoomKey(
          { wrapped, generation: existingRoom.current_generation },
          identity.x25519PublicKey,
          identity.x25519PrivateKey,
        );
        return { roomId: existingRoom.id, roomKey };
      }
    }
  }
  // Create a new solo room.
  const room = await createRoom({ kind: 'group', createdBy: userId });
  const roomKey = await generateRoomKey(room.current_generation);
  const wrapped = await wrapRoomKeyFor(roomKey, identity.x25519PublicKey);
  await addRoomMember({
    roomId: room.id,
    userId,
    generation: room.current_generation,
    wrappedRoomKey: wrapped.wrapped,
  });
  sessionStorage.setItem(TEST_ROOM_TAG, room.id);
  return { roomId: room.id, roomKey };
}
