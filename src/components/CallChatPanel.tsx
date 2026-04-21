'use client';

/**
 * In-call chat side panel. Minimal text-only feed + composer so participants
 * can keep messaging while on video. Reuses e2ee-core + queries directly;
 * does not share state with the room page's chat (each route owns its own
 * subscription + decrypt cache).
 *
 * REFERENCE UX — not portable foundation. The resolver helpers here
 * (resolveSenderEd, resolveMegolm) are currently duplicated from
 * rooms/[id]/page.tsx. If a third consumer appears, lift them into a
 * shared lib module.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';
import {
  decryptBlob,
  deriveMessageKeyAtIndex,
  encryptBlobV4,
  fromBase64,
  observeContact,
  putInboundSession,
  putOutboundSession,
  ratchetAndDerive,
  toBase64,
  unsealSessionSnapshot,
  unwrapRoomKey,
  verifyMembershipWrap,
  verifyPublicDevice,
  verifySessionShare,
  type DeviceKeyBundle,
  type RoomKey,
} from '@/lib/e2ee-core';
import { ensureFreshSession } from '@/lib/bootstrap';
import {
  decodeBlobRow,
  fetchDeviceEd25519PubsByIds,
  fetchMegolmSessionInfo,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  insertBlob,
  listBlobs,
  listDevices,
  listMegolmSharesForDevice,
  listMyRoomKeyRows,
  subscribeBlobs,
  type BlobRow,
} from '@/lib/supabase/queries';

interface Props {
  roomId: string;
  userId: string;
  device: DeviceKeyBundle;
}

interface ChatMsg {
  id: string;
  senderId: string;
  createdAt: string;
  text: string;
  fromMe: boolean;
}

function isTextPayload(p: unknown): p is { text: string; ts: number } {
  if (typeof p !== 'object' || p === null) return false;
  const t = (p as { text?: unknown }).text;
  const ts = (p as { ts?: unknown }).ts;
  return typeof t === 'string' && typeof ts === 'number';
}

export function CallChatPanel({ roomId, userId, device }: Props) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const roomKeyRef = useRef<RoomKey | null>(null);
  const keysByGenRef = useRef<Map<number, RoomKey>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const deviceEdCacheRef = useRef<Map<string, Uint8Array | null>>(new Map());
  // sessionId(b64) -> authoritative sender_device_id from megolm_sessions.
  // Used by share-verification paths to cross-check that an unsealed snapshot
  // really belongs to the session it claims (catches forwarder substitution).
  const sessionSenderRef = useRef<Map<string, string>>(new Map());
  // My own device IDs — for authorizing share signers as Branch B
  // (co-device forward). RLS 0048 enforces this at insert; client re-checks
  // for defense in depth (service-role insert / future migration mistakes).
  const myDeviceIdsRef = useRef<Set<string>>(new Set());

  const resolveSenderEd = useCallback(
    async (senderUserId: string, senderDeviceId: string): Promise<Uint8Array | null> => {
      const cacheKey = `${senderUserId}:${senderDeviceId}`;
      const cache = deviceEdCacheRef.current;
      if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

      const umk = await fetchUserMasterKeyPub(senderUserId);
      if (!umk) {
        cache.set(cacheKey, null);
        return null;
      }
      let sskPub: Uint8Array | undefined;
      if (umk.sskPub && umk.sskCrossSignature) {
        try {
          const { verifySskCrossSignature } = await import('@/lib/e2ee-core');
          await verifySskCrossSignature(umk.ed25519PublicKey, umk.sskPub, umk.sskCrossSignature);
          sskPub = umk.sskPub;
        } catch { /* v1 fallback */ }
      }
      const devices = await fetchPublicDevices(senderUserId);
      const d = devices.find((x) => x.deviceId === senderDeviceId);
      if (!d) {
        cache.set(cacheKey, null);
        return null;
      }
      try {
        await verifyPublicDevice(d, umk.ed25519PublicKey, sskPub);
      } catch {
        cache.set(cacheKey, null);
        return null;
      }
      try {
        await observeContact(senderUserId, {
          ed25519PublicKey: umk.ed25519PublicKey,
          x25519PublicKey: d.x25519PublicKey,
          selfSignature: new Uint8Array(0),
        });
      } catch { /* non-fatal */ }
      cache.set(cacheKey, d.ed25519PublicKey);
      return d.ed25519PublicKey;
    },
    [],
  );

  const resolveMegolm = useCallback(
    async (sessionIdB64: string, messageIndex: number): Promise<Uint8Array | null> => {
      // Resolve the session's authoritative sender_device_id. Cached via the
      // initial-hydration pass; on miss (e.g. a session that arrived after
      // hydration) fetch fresh and memoize.
      let authoritativeSender = sessionSenderRef.current.get(sessionIdB64);
      if (!authoritativeSender) {
        const info = await fetchMegolmSessionInfo(sessionIdB64).catch(() => null);
        if (!info) return null;
        authoritativeSender = info.sender_device_id;
        sessionSenderRef.current.set(sessionIdB64, authoritativeSender);
      }
      const shares = await listMegolmSharesForDevice({
        roomId,
        recipientDeviceId: device.deviceId,
      });
      for (const share of shares) {
        if (share.session_id !== sessionIdB64) continue;
        // Authorize signer: session sender OR one of my co-devices.
        const signerOk =
          share.signer_device_id === authoritativeSender ||
          myDeviceIdsRef.current.has(share.signer_device_id);
        if (!signerOk) continue;
        try {
          const signerPubs = await fetchDeviceEd25519PubsByIds([share.signer_device_id]);
          const signerPub = signerPubs.get(share.signer_device_id);
          if (!signerPub) continue;
          const sealed = await fromBase64(share.sealed_snapshot);
          await verifySessionShare({
            sessionId: await fromBase64(sessionIdB64),
            recipientDeviceId: device.deviceId,
            sealedSnapshot: sealed,
            signerDeviceId: share.signer_device_id,
            signature: await fromBase64(share.share_signature),
            signerEd25519Pub: signerPub,
          });
          const snap = await unsealSessionSnapshot(
            sealed,
            device.x25519PublicKey,
            device.x25519PrivateKey,
          );
          // Cross-check the snapshot's claimed identity against the
          // authoritative megolm_sessions row.
          if (
            (await toBase64(snap.sessionId)) !== sessionIdB64 ||
            snap.senderDeviceId !== authoritativeSender
          ) {
            continue;
          }
          await putInboundSession(sessionIdB64, authoritativeSender, snap);
          if (messageIndex >= snap.startIndex) {
            const mk = await deriveMessageKeyAtIndex(snap, messageIndex);
            return mk.key;
          }
        } catch { /* try next */ }
      }
      return null;
    },
    [roomId, device],
  );

  const decode = useCallback(
    async (row: BlobRow): Promise<ChatMsg | null> => {
      try {
        const blob = await decodeBlobRow(row);
        let payload: unknown;
        let senderUserId: string;
        if (blob.sessionId && blob.messageIndex != null) {
          const decoded = await decryptBlob<unknown>({
            blob,
            roomId: row.room_id,
            roomKey: { key: new Uint8Array(0), generation: blob.generation },
            resolveSenderDeviceEd25519Pub: resolveSenderEd,
            resolveMegolmKey: (sid, mi) => resolveMegolm(sid, mi),
          });
          payload = decoded.payload;
          senderUserId = decoded.senderUserId ?? row.sender_id;
        } else {
          const rk = keysByGenRef.current.get(blob.generation);
          if (!rk) return null;
          const decoded = await decryptBlob<unknown>({
            blob,
            roomId: row.room_id,
            roomKey: rk,
            resolveSenderDeviceEd25519Pub: resolveSenderEd,
          });
          payload = decoded.payload;
          senderUserId = decoded.senderUserId ?? row.sender_id;
        }
        if (!isTextPayload(payload)) return null;
        return {
          id: row.id,
          senderId: senderUserId,
          createdAt: row.created_at,
          text: payload.text,
          fromMe: senderUserId === userId,
        };
      } catch {
        return null;
      }
    },
    [resolveSenderEd, resolveMegolm, userId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const rows = await listMyRoomKeyRows(roomId, device.deviceId);
        const signerPubs = await fetchDeviceEd25519PubsByIds(
          [...new Set(rows.map((r) => r.signer_device_id))],
        );
        const byGen = new Map<number, RoomKey>();
        let maxGen = 0;
        for (const r of rows) {
          try {
            const wrapped = await fromBase64(r.wrapped_room_key);
            const signerPub = signerPubs.get(r.signer_device_id);
            if (!signerPub) continue;
            await verifyMembershipWrap(
              {
                roomId,
                generation: r.generation,
                memberUserId: r.user_id,
                memberDeviceId: device.deviceId,
                wrappedRoomKey: wrapped,
                signerDeviceId: r.signer_device_id,
              },
              await fromBase64(r.wrap_signature),
              signerPub,
            );
            const rk = await unwrapRoomKey(
              { wrapped, generation: r.generation },
              device.x25519PublicKey,
              device.x25519PrivateKey,
            );
            byGen.set(r.generation, rk);
            if (r.generation > maxGen) maxGen = r.generation;
          } catch { /* skip */ }
        }
        if (cancelled) return;
        keysByGenRef.current = byGen;
        roomKeyRef.current = byGen.get(maxGen) ?? null;

        // Pre-warm caches needed by share verification (resolveMegolm reuses
        // both refs on cache miss for sessions arriving after hydration).
        const myDevs = await listDevices(userId).catch(() => []);
        myDeviceIdsRef.current = new Set(myDevs.map((d) => d.id));

        const shares = await listMegolmSharesForDevice({
          roomId,
          recipientDeviceId: device.deviceId,
        });
        // Resolve each share's authoritative session sender up-front. Cache for
        // resolveMegolm reuse. Sessions without a megolm_sessions row (pre-0027
        // orphans) cannot be hydrated through this path because their RLS
        // Branch A check fails — and Branch B forwards have a row with our
        // co-device as sender, so they DO appear here.
        const uniqueSessionIds = [...new Set(shares.map((s) => s.session_id))];
        const sessionInfos = await Promise.all(
          uniqueSessionIds.map((sid) =>
            fetchMegolmSessionInfo(sid).catch(() => null),
          ),
        );
        for (let i = 0; i < uniqueSessionIds.length; i++) {
          const info = sessionInfos[i];
          if (info) sessionSenderRef.current.set(uniqueSessionIds[i], info.sender_device_id);
        }

        // Resolve all unique signer pubs in one query.
        const signerIds = [...new Set(shares.map((s) => s.signer_device_id))];
        const sharePubs = await fetchDeviceEd25519PubsByIds(signerIds);

        for (const share of shares) {
          const authoritativeSender = sessionSenderRef.current.get(share.session_id);
          if (!authoritativeSender) continue;
          const signerOk =
            share.signer_device_id === authoritativeSender ||
            myDeviceIdsRef.current.has(share.signer_device_id);
          if (!signerOk) continue;
          const signerPub = sharePubs.get(share.signer_device_id);
          if (!signerPub) continue;
          try {
            const sealed = await fromBase64(share.sealed_snapshot);
            await verifySessionShare({
              sessionId: await fromBase64(share.session_id),
              recipientDeviceId: device.deviceId,
              sealedSnapshot: sealed,
              signerDeviceId: share.signer_device_id,
              signature: await fromBase64(share.share_signature),
              signerEd25519Pub: signerPub,
            });
            const snap = await unsealSessionSnapshot(
              sealed,
              device.x25519PublicKey,
              device.x25519PrivateKey,
            );
            if (
              (await toBase64(snap.sessionId)) !== share.session_id ||
              snap.senderDeviceId !== authoritativeSender
            ) {
              continue;
            }
            await putInboundSession(share.session_id, authoritativeSender, snap);
          } catch { /* skip */ }
        }

        const rawBlobs = await listBlobs(roomId);
        const decoded = (await Promise.all(rawBlobs.map(decode))).filter(
          (m): m is ChatMsg => m !== null,
        );
        if (cancelled) return;
        setMsgs(decoded);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, device, decode, userId]);

  useEffect(() => {
    const unsub = subscribeBlobs(roomId, (row) => {
      void (async () => {
        const m = await decode(row);
        if (!m) return;
        setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      })();
    });
    return unsub;
  }, [roomId, decode]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    const roomKey = roomKeyRef.current;
    if (!trimmed || !roomKey || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await ensureFreshSession({
        roomId,
        generation: roomKey.generation,
        userId,
        device,
      });
      const messageKey = await ratchetAndDerive(session);
      const blob = await encryptBlobV4({
        payload: { text: trimmed, ts: Date.now() },
        roomId,
        messageKey,
        sessionId: session.sessionId,
        generation: session.generation,
        senderUserId: userId,
        senderDeviceId: device.deviceId,
        senderDeviceEd25519PrivateKey: device.ed25519PrivateKey,
      });
      await putOutboundSession(roomId, device.deviceId, session);
      await insertBlob({
        roomId,
        senderId: userId,
        senderDeviceId: device.deviceId,
        blob,
      });
      setText('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded border border-green-700/40 bg-black/40 text-green-100">
      <div className="border-b border-green-900/50 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-green-400">
        chat
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5 font-mono text-[12px]"
      >
        {loading && <div className="text-green-500/60">loading…</div>}
        {!loading && msgs.length === 0 && (
          <div className="italic text-green-500/50">no messages yet</div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={m.fromMe ? 'text-right' : ''}>
            <span className={m.fromMe ? 'text-green-300' : 'text-green-400'}>
              {m.fromMe ? 'you' : m.senderId.slice(0, 8)}:
            </span>{' '}
            <span className="break-words text-green-100">{m.text}</span>
          </div>
        ))}
      </div>
      {error && (
        <div className="border-t border-red-900/50 bg-red-950/40 px-3 py-1.5 font-mono text-[11px] text-red-300">
          {error}
        </div>
      )}
      <form onSubmit={send} className="flex gap-2 border-t border-green-900/50 p-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="type a message…"
          disabled={busy || loading}
          className="flex-1 rounded border border-green-900/60 bg-black/60 px-2 py-1 font-mono text-[12px] text-green-100 placeholder:text-green-700 focus:border-green-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || loading || !text.trim()}
          className="rounded border border-green-700 bg-green-900/40 px-3 py-1 font-mono text-[11px] uppercase text-green-200 transition-transform duration-150 hover:bg-green-800/40 active:scale-95 disabled:opacity-40"
        >
          send
        </button>
      </form>
    </div>
  );
}
