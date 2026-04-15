'use client';

/**
 * Shown on already-signed-in devices (device A) when a new device (B) has
 * posted a pending `device_approval_requests` row for this account.
 *
 * Flow on A:
 *   1. Banner appears for each pending request.
 *   2. User enters the 6-digit code displayed on B.
 *   3. On match: seal identity with B's linking pubkey, write handoff row,
 *      delete the approval request.
 *   4. On mismatch: show error, let user try again (or ignore).
 *   5. Request TTL on the server also deletes stale rows.
 *
 * We deliberately do NOT show any fingerprint/metadata that would let an
 * attacker (who has compromised this auth) push the user into tapping Approve
 * out of habit. The only way forward is entering the code printed on B.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fromBase64,
  hashApprovalCode,
  getIdentity,
  sealIdentityForLink,
  type Identity,
} from '@/lib/e2ee-core';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  deleteApprovalRequest,
  listPendingApprovalRequests,
  postLinkHandoff,
  subscribeApprovalRequests,
  type DeviceApprovalRequestRow,
} from '@/lib/supabase/queries';

export function PendingApprovalBanner() {
  const [userId, setUserId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [requests, setRequests] = useState<DeviceApprovalRequestRow[]>([]);

  // Load session + local identity (we need it to seal when we fulfil).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getUser();
      if (cancelled || !data.user) return;
      setUserId(data.user.id);
      const id = await getIdentity(data.user.id);
      if (!cancelled && id) setIdentity(id);
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

  // Load already-pending requests + subscribe to new ones.
  useEffect(() => {
    if (!userId || !identity) return;
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
  }, [userId, identity, addRequest]);

  if (!identity || requests.length === 0) return null;

  return (
    <div className="space-y-2">
      {requests.map((req) => (
        <ApprovalCard
          key={req.id}
          request={req}
          identity={identity}
          onResolved={() => dropRequest(req.id)}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  request,
  identity,
  onResolved,
}: {
  request: DeviceApprovalRequestRow;
  identity: Identity;
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
      const expected = await hashApprovalCode(code, request.code_salt);
      if (expected !== request.code_hash) {
        throw new Error('code did not match — check the new device screen');
      }
      const linkingPub = await fromBase64(request.linking_pubkey);
      const sealed = await sealIdentityForLink(identity, linkingPub);
      const linkNonce = await fromBase64(request.link_nonce);
      await postLinkHandoff({
        linkNonce,
        invitingUserId: request.user_id,
        sealedPayload: sealed,
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
