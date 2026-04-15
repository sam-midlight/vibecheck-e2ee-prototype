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
  fromBase64,
  getUserMasterKey,
  hashApprovalCode,
  signDeviceIssuance,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  deleteApprovalRequest,
  listPendingApprovalRequests,
  registerDevice,
  subscribeApprovalRequests,
  verifyApprovalCode,
  type DeviceApprovalRequestRow,
} from '@/lib/supabase/queries';

export function PendingApprovalBanner() {
  const [userId, setUserId] = useState<string | null>(null);
  const [umk, setUmk] = useState<UserMasterKey | null>(null);
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

  useEffect(() => {
    if (!userId || !umk) return;
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
  }, [userId, umk, addRequest]);

  if (!umk || requests.length === 0) return null;

  return (
    <div className="space-y-2">
      {requests.map((req) => (
        <ApprovalCard
          key={req.id}
          request={req}
          umk={umk}
          onResolved={() => dropRequest(req.id)}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  request,
  umk,
  onResolved,
}: {
  request: DeviceApprovalRequestRow;
  umk: UserMasterKey;
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
      const issuanceSig = await signDeviceIssuance(
        {
          userId: request.user_id,
          deviceId: request.device_id,
          deviceEd25519PublicKey: devEdPub,
          deviceX25519PublicKey: devXPub,
          createdAtMs: request.created_at_ms,
        },
        umk.ed25519PrivateKey,
      );
      await registerDevice({
        userId: request.user_id,
        deviceId: request.device_id,
        deviceEd25519Pub: devEdPub,
        deviceX25519Pub: devXPub,
        issuanceCreatedAtMs: request.created_at_ms,
        issuanceSignature: issuanceSig,
        // A (this device) can't seal B's display name — only B has the x
        // priv for B's own device. B fills this in via
        // setDeviceDisplayNameCiphertext after it picks up the cert.
        displayNameCiphertext: null,
      });
      await deleteApprovalRequest(request.id);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
