'use client';

/**
 * A-side of device approval (v3, per-device identities).
 *
 * When a new device (B) posts a `device_approval_requests` row, any
 * already-signed-in device whose user is the UMK-holder can approve. Flow:
 *
 *   1. B's request carries B's freshly-generated device_ed_pub + device_x_pub
 *      + device_id + a bound code_hash.
 *   2. User of this device (A) types the 6-digit code shown on B.
 *   3. We verify the candidate hash against the row (server-side RPC that
 *      rate-limits failed attempts).
 *   4. On match, A's UMK priv signs an issuance certificate for B's pubs.
 *   5. A INSERTs a `devices` row with B's pubs + that cert.
 *   6. The approval request row is deleted.
 *   7. B polls, sees its own device_id in the device list with a valid cert,
 *      finishes enrollment locally.
 *
 * This device only offers the approve button if it currently holds the UMK
 * priv (stored in IndexedDB as the `userMasterKey` row). Non-UMK devices see
 * nothing — they can't issue certs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  concatBytes,
  fromBase64,
  getBackupKey,
  getDeviceBundle,
  getSelfSigningKey,
  getSodium,
  getUserMasterKey,
  getUserSigningKey,
  hashApprovalCode,
  signDeviceIssuanceV2,
  signMembershipWrap,
  toBase64,
  unwrapRoomKey,
  wrapRoomKeyFor,
  type Bytes,
  type SelfSigningKey,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  addRoomMember,
  deleteApprovalRequest,
  getMyWrappedRoomKey,
  listPendingApprovalRequests,
  listMyRooms,
  registerDevice,
  subscribeApprovalRequests,
  verifyApprovalCode,
  type DeviceApprovalRequestRow,
} from '@/lib/supabase/queries';

export function PendingApprovalBanner() {
  const [userId, setUserId] = useState<string | null>(null);
  const [umk, setUmk] = useState<UserMasterKey | null>(null);
  const [ssk, setSsk] = useState<SelfSigningKey | null>(null);
  const [requests, setRequests] = useState<DeviceApprovalRequestRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getUser();
      if (cancelled || !data.user) return;
      setUserId(data.user.id);
      const k = await getUserMasterKey(data.user.id);
      if (!cancelled && k) setUmk(k);
      const s = await getSelfSigningKey(data.user.id);
      if (!cancelled && s) setSsk(s);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const seenIds = useRef<Set<string>>(new Set());
  const addRequest = useCallback((row: DeviceApprovalRequestRow) => {
    if (seenIds.current.has(row.id)) return;
    seenIds.current.add(row.id);
    setRequests((prev) => [...prev, row]);
  }, []);
  const dropRequest = useCallback((id: string) => {
    seenIds.current.delete(id);
    setRequests((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // Can approve if we hold SSK (cross-signing) or UMK (pre-cross-signing).
  const canSign = !!(ssk || umk);

  useEffect(() => {
    if (!userId || !canSign) return;
    let cancelled = false;
    (async () => {
      try {
        const pending = await listPendingApprovalRequests(userId);
        if (cancelled) return;
        pending.forEach(addRequest);
      } catch (err) {
        console.error('listPendingApprovalRequests failed:', errorMessage(err));
      }
    })();
    const unsub = subscribeApprovalRequests(userId, addRequest);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [userId, canSign, addRequest]);

  if (!canSign || requests.length === 0) return null;

  return (
    <div className="space-y-2">
      {requests.map((req) => (
        <ApprovalCard
          key={req.id}
          request={req}
          umk={umk}
          ssk={ssk}
          onResolved={() => dropRequest(req.id)}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  request,
  umk,
  ssk,
  onResolved,
}: {
  request: DeviceApprovalRequestRow;
  umk: UserMasterKey | null;
  ssk: SelfSigningKey | null;
  onResolved: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      if (!/^[0-9]{6}$/.test(code)) {
        throw new Error('enter the 6 digits shown on the new device');
      }
      if (
        !request.device_ed25519_pub ||
        !request.device_x25519_pub ||
        !request.device_id ||
        request.created_at_ms == null
      ) {
        throw new Error(
          'approval row missing v3 fields (pre-0015 request? ask B to retry)',
        );
      }

      const devEdPub = await fromBase64(request.device_ed25519_pub);
      const devXPub = await fromBase64(request.device_x25519_pub);
      const linkNonce = await fromBase64(request.link_nonce);

      // Transcript-bound hash: if a row-mutating attacker swapped any of the
      // device pubs or nonce, the hash will mismatch and we refuse.
      const candidate = await hashApprovalCode(
        code,
        request.code_salt,
        devXPub,
        linkNonce,
      );
      const matched = await verifyApprovalCode(request.id, candidate);
      if (!matched) {
        throw new Error('code did not match — check the new device screen');
      }

      // Sign an issuance cert for B's device bundle.
      // Prefer SSK (v2 cert) if available; fall back to UMK/MSK (v1 cert).
      const signingKey = ssk?.ed25519PrivateKey ?? umk?.ed25519PrivateKey;
      if (!signingKey) {
        throw new Error('no signing key available (need SSK or UMK)');
      }
      const issuanceSig = ssk
        ? await signDeviceIssuanceV2(
            {
              userId: request.user_id,
              deviceId: request.device_id,
              deviceEd25519PublicKey: devEdPub,
              deviceX25519PublicKey: devXPub,
              createdAtMs: request.created_at_ms,
            },
            ssk.ed25519PrivateKey,
          )
        : await (async () => {
            const { signDeviceIssuance } = await import('@/lib/e2ee-core');
            return signDeviceIssuance(
              {
                userId: request.user_id,
                deviceId: request.device_id!,
                deviceEd25519PublicKey: devEdPub,
                deviceX25519PublicKey: devXPub,
                createdAtMs: request.created_at_ms!,
              },
              umk!.ed25519PrivateKey,
            );
          })();
      await registerDevice({
        userId: request.user_id,
        deviceId: request.device_id,
        deviceEd25519Pub: devEdPub,
        deviceX25519Pub: devXPub,
        issuanceCreatedAtMs: request.created_at_ms,
        issuanceSignature: issuanceSig,
        displayNameCiphertext: null,
      });

      // Re-wrap all current room keys for the new device.
      try {
        await rewrapRoomsForNewDevice({
          userId: request.user_id,
          newDeviceId: request.device_id,
          newDeviceX25519Pub: devXPub,
        });
      } catch (err) {
        console.warn('room re-wrap for new device failed:', errorMessage(err));
      }

      // Share SSK+USK with the new device by sealing to B's X25519 pub.
      // Also share the backup key. Both go on B's device row.
      try {
        const sodium = await getSodium();
        const supabaseLocal = (await import('@/lib/supabase/client')).getSupabase();
        const updates: Record<string, string> = {};

        // SSK + USK → signing_key_wrap
        const localSsk = await getSelfSigningKey(request.user_id);
        const localUsk = await getUserSigningKey(request.user_id);
        if (localSsk && localUsk) {
          const packed = concatBytes(
            localSsk.ed25519PrivateKey,
            localUsk.ed25519PrivateKey,
          );
          const sealedKeys = sodium.crypto_box_seal(packed, devXPub);
          sodium.memzero(packed);
          updates.signing_key_wrap = await toBase64(sealedKeys);
        }

        // Backup key → backup_key_wrap
        const bk = await getBackupKey(request.user_id);
        if (bk) {
          const sealedBk = sodium.crypto_box_seal(bk, devXPub);
          updates.backup_key_wrap = await toBase64(sealedBk);
        }

        if (Object.keys(updates).length > 0) {
          await supabaseLocal
            .from('devices')
            .update(updates)
            .eq('id', request.device_id);
        }
      } catch (err) {
        console.warn('key share to new device failed:', errorMessage(err));
      }

      await deleteApprovalRequest(request.id);
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await deleteApprovalRequest(request.id);
      onResolved();
    } catch (err) {
      console.error('dismiss approval failed:', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p>
        <strong>A new device is trying to sign in to your account.</strong>{' '}
        If that&apos;s you, enter the 6-digit code shown on it. If not,
        dismiss this.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="• • • • • •"
          className="w-32 rounded border border-neutral-300 px-2 py-1 text-center font-mono text-base tracking-widest dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          onClick={() => void approve()}
          disabled={busy || code.length !== 6}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? 'working…' : 'approve'}
        </button>
        <button
          onClick={() => void dismiss()}
          disabled={busy}
          className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
        >
          dismiss
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

/**
 * After approving a new device, re-wrap every room key THIS device holds
 * for the NEW device. Inserts one `room_members` row per room at the
 * current generation, sealed to B's x25519 pub, signed by A's device ed
 * priv. This gives B immediate access to all rooms A is currently in.
 */
async function rewrapRoomsForNewDevice(params: {
  userId: string;
  newDeviceId: string;
  newDeviceX25519Pub: Bytes;
}): Promise<void> {
  const { userId, newDeviceId, newDeviceX25519Pub } = params;

  const myBundle = await getDeviceBundle(userId);
  if (!myBundle) throw new Error('no local device bundle');

  const rooms = await listMyRooms(userId);
  for (const room of rooms) {
    try {
      const myWrapped = await getMyWrappedRoomKey({
        roomId: room.id,
        deviceId: myBundle.deviceId,
        generation: room.current_generation,
      });
      if (!myWrapped) continue;

      const roomKey = await unwrapRoomKey(
        { wrapped: myWrapped, generation: room.current_generation },
        myBundle.x25519PublicKey,
        myBundle.x25519PrivateKey,
      );

      const wrap = await wrapRoomKeyFor(roomKey, newDeviceX25519Pub);
      const sig = await signMembershipWrap(
        {
          roomId: room.id,
          generation: room.current_generation,
          memberUserId: userId,
          memberDeviceId: newDeviceId,
          wrappedRoomKey: wrap.wrapped,
          signerDeviceId: myBundle.deviceId,
        },
        myBundle.ed25519PrivateKey,
      );
      await addRoomMember({
        roomId: room.id,
        userId,
        deviceId: newDeviceId,
        generation: room.current_generation,
        wrappedRoomKey: wrap.wrapped,
        signerDeviceId: myBundle.deviceId,
        wrapSignature: sig,
      });
    } catch (err) {
      console.warn(
        `rewrap failed for room ${room.id.slice(0, 8)}:`,
        errorMessage(err),
      );
    }
  }
}
