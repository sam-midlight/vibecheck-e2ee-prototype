'use client';

/**
 * Minimal E2EE video call reference UI.
 *
 * REFERENCE UX — not portable foundation. Rewrites welcome in any consuming
 * app's design system. The foundation pieces this leans on are:
 *   - bootstrap.startCallInRoom / fetchAndUnwrapCallKey
 *   - src/lib/livekit/LiveKitAdapter (E2EE + QVGA + token renewal)
 *   - queries.subscribeRoomCalls / fetchActiveCallForRoom
 *
 * Phase 4 scope: 2-participant happy path. Mid-call join / rotator election /
 * leave-cascade handling lands in phase 5 + 6.
 */

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { CallChatPanel } from '@/components/CallChatPanel';
import { getSupabase } from '@/lib/supabase/client';
import { errorMessage } from '@/lib/errors';
import type { DeviceKeyBundle, CallKey } from '@/lib/e2ee-core';
import { zeroCallKey } from '@/lib/e2ee-core';
import {
  fetchAndUnwrapCallKey,
  filterActiveCallMembers,
  isDesignatedRotator,
  listStaleCallDeviceIds,
  loadEnrolledDevice,
  rotateCallKeyForCurrentMembers,
  startCallInRoom,
} from '@/lib/bootstrap';
import { listCallMembers } from '@/lib/supabase/queries';
import {
  broadcastCallSignaling,
  endCall as rpcEndCall,
  fetchActiveCallForRoom,
  heartbeatCall as rpcHeartbeatCall,
  joinCall as rpcJoinCall,
  leaveCall as rpcLeaveCall,
  subscribeCallSignaling,
  subscribeRoomCalls,
  type CallRow,
} from '@/lib/supabase/queries';
import {
  LiveKitAdapter,
  browserSupportsE2EE,
  makeDefaultTokenFetcher,
  type EncryptionState,
  type LiveKitAdapterEvent,
} from '@/lib/livekit';
import {
  RoomEvent,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Participant,
  type Track,
} from 'livekit-client';

export default function CallPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: roomId } = use(params);
  return (
    <AppShell requireAuth>
      <CallInner roomId={roomId} />
    </AppShell>
  );
}

type CallUiState = 'idle' | 'starting' | 'joining' | 'in_call' | 'ended';

interface ParticipantTile {
  identity: string;
  /** null until a video track is subscribed. */
  videoTrack: Track | null;
  /** All audio tracks currently subscribed for this participant. Remote only;
   *  local audio is never played back (would echo into the mic). */
  audioTracks: Track[];
  isLocal: boolean;
}

interface DiagEntry {
  ts: number;
  kind: 'info' | 'ok' | 'err';
  step: string;
  detail?: string;
}

function CallInner({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceKeyBundle | null>(null);
  const [activeCall, setActiveCall] = useState<CallRow | null>(null);
  const [uiState, setUiState] = useState<CallUiState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorStack, setErrorStack] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagEntry[]>([]);
  const [tiles, setTiles] = useState<ParticipantTile[]>([]);
  const [encryptionState, setEncryptionState] = useState<EncryptionState>('pending');
  const [encryptionDetail, setEncryptionDetail] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [receiveOnly, setReceiveOnly] = useState(false);
  const [receiveOnlyReason, setReceiveOnlyReason] = useState<string | null>(null);

  const logDiag = useCallback(
    (kind: DiagEntry['kind'], step: string, detail?: string) => {
      console.log(`[call-diag] ${kind}: ${step}`, detail ?? '');
      setDiag((prev) => [...prev, { ts: Date.now(), kind, step, detail }]);
    },
    [],
  );

  /** Run `op`, log ok/err, and re-throw with step prefix for outer catch. */
  const step = useCallback(
    async <T,>(label: string, op: () => Promise<T>): Promise<T> => {
      logDiag('info', label);
      try {
        const out = await op();
        logDiag('ok', label);
        return out;
      } catch (err) {
        const msg = errorMessage(err);
        const stack = err instanceof Error ? err.stack : undefined;
        logDiag('err', label, msg);
        if (stack) setErrorStack(stack);
        throw err;
      }
    },
    [logDiag],
  );

  const adapterRef = useRef<LiveKitAdapter | null>(null);
  const callKeyRef = useRef<CallKey | null>(null);
  /** Highest generation we have a valid CallKey for, or 0 if none. */
  const keyedGenRef = useRef<number>(0);
  const deviceRef = useRef<DeviceKeyBundle | null>(null);
  /** Are we mid-`joining` and waiting for the rotator to include us? */
  const waitingForEnvelopeRef = useRef<boolean>(false);
  /** Call the joiner is trying to enter (used by the calls UPDATE handler). */
  const joiningCallIdRef = useRef<string | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  // ---- init: load user + device ------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getUser();
        if (!data.user) return;
        setUserId(data.user.id);
        const enrolled = await loadEnrolledDevice(data.user.id);
        if (!enrolled) throw new Error('no device bundle on this browser');
        setDevice(enrolled.deviceBundle);

        const existing = await fetchActiveCallForRoom(roomId);
        setActiveCall(existing);
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [roomId]);

  // ---- subscribe: realtime on `calls` for this room ----------------------
  useEffect(() => {
    const unsub = subscribeRoomCalls(roomId, (row, event) => {
      if (event === 'INSERT') {
        setActiveCall((prev) => prev ?? row);
      } else {
        // UPDATE — either current_generation bumped, or ended_at set.
        if (row.ended_at != null) {
          setActiveCall((prev) => (prev?.id === row.id ? null : prev));
          // Boot everyone on this call page back to the room when it ends.
          const wasInCall =
            adapterRef.current && adapterRef.current.callId === row.id;
          if (wasInCall) {
            void teardown('ended').then(() => router.push(`/rooms/${roomId}`));
          } else if (uiState === 'idle' || uiState === 'joining') {
            router.push(`/rooms/${roomId}`);
          }
          return;
        }
        setActiveCall(row);
        // Generation bump: re-key everywhere we're in this call. Covers BOTH
        // the "already-connected, rotate LiveKit key" and "joining-waiting-for-
        // envelope, now have it" paths.
        void onGenerationMaybeBumped(row);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  /**
   * Handle a possible generation bump on the calls row. Idempotent — if we
   * already have a key at or past this generation, it's a no-op.
   */
  const onGenerationMaybeBumped = useCallback(
    async (row: CallRow) => {
      const dev = deviceRef.current;
      if (!dev) return;
      if (row.current_generation <= keyedGenRef.current) return;

      try {
        const newKey = await fetchAndUnwrapCallKey({
          callId: row.id,
          generation: row.current_generation,
          device: dev,
        });
        if (!newKey) {
          // Envelope not present for us — we've been excluded (e.g. revoked)
          // or the rotator hasn't included us yet. Leave keyedGen untouched;
          // we'll retry on the next bump.
          return;
        }

        if (adapterRef.current && adapterRef.current.callId === row.id) {
          // Already in the call: swap LiveKit's frame key. LiveKit handles
          // the cutover window for in-flight frames.
          await adapterRef.current.rotateKey(newKey);
          if (callKeyRef.current) await zeroCallKey(callKeyRef.current);
          callKeyRef.current = newKey;
          keyedGenRef.current = row.current_generation;
        } else if (
          waitingForEnvelopeRef.current &&
          joiningCallIdRef.current === row.id
        ) {
          // We were waiting on a rotator to include us — now do it.
          waitingForEnvelopeRef.current = false;
          joiningCallIdRef.current = null;
          callKeyRef.current = newKey;
          keyedGenRef.current = row.current_generation;
          await connectAdapterWith(row.id, newKey);
        }
      } catch (e) {
        console.error('onGenerationMaybeBumped failed', errorMessage(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Initialise LiveKitAdapter with a ready CallKey and connect + publish. */
  const connectAdapterWith = useCallback(
    async (callId: string, initialCallKey: CallKey) => {
      const dev = deviceRef.current;
      if (!dev) throw new Error('no device');
      const adapter = await step('new LiveKitAdapter', async () => {
        return new LiveKitAdapter({
          callId,
          deviceId: dev.deviceId,
          initialCallKey,
          tokenFetcher: makeDefaultTokenFetcher(),
        });
      });
      adapter.on(onAdapterEvent);
      adapterRef.current = adapter;
      await step('adapter.connect (fetch JWT + ws + setE2EE)', () =>
        adapter.connect(),
      );
      attachRoomEvents(adapter);
      await step('publishLocalMedia', () => adapter.publishLocalMedia());
      setUiState('in_call');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [step],
  );

  // ---- heartbeat: every 10s while in_call, update last_seen_at ---------
  //
  // Drives the 30s reconnection-grace window (§6.5). Clients treat a peer
  // as "present" while last_seen_at is within grace; a drop past 30s kicks
  // the stale-sweep below into rotating them out.
  useEffect(() => {
    if (uiState !== 'in_call' || !activeCall || !device) return;
    const callId = activeCall.id;
    const deviceId = device.deviceId;

    let cancelled = false;
    const tick = async () => {
      try {
        await rpcHeartbeatCall({ callId, deviceId });
      } catch (e) {
        // Transient RPC failures are fine — the next tick catches up.
        if (!cancelled) console.warn('heartbeat failed', errorMessage(e));
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, activeCall?.id, device?.deviceId]);

  // ---- stale sweep: rotate out devices past the 30s grace window --------
  //
  // Every 15s, each connected client checks for stale devices. If any are
  // present AND this client is the designated rotator (among non-stale
  // peers), it rotates with them excluded. Concurrent rotators lose on
  // the DB's new-gen constraint — the race is benign.
  useEffect(() => {
    if (uiState !== 'in_call' || !activeCall || !device) return;
    const callId = activeCall.id;

    let cancelled = false;
    const sweep = async () => {
      try {
        const stale = await listStaleCallDeviceIds(callId);
        if (stale.length === 0) return;
        const amRotator = await isDesignatedRotator({
          callId,
          myDeviceId: device.deviceId,
        });
        if (!amRotator) return;
        const oldGen = keyedGenRef.current;
        if (oldGen < 1) return;
        const newKey = await rotateCallKeyForCurrentMembers({
          callId,
          device,
          oldGeneration: oldGen,
          excludeDeviceIds: stale,
        });
        // Gen-bump UPDATE on `calls` will arrive via postgres_changes and
        // onGenerationMaybeBumped will swap our adapter key. Drop this key.
        await zeroCallKey(newKey);
      } catch (e) {
        if (cancelled) return;
        const msg = errorMessage(e);
        if (!/serialization|new generation|stale/i.test(msg)) {
          console.warn('stale sweep', msg);
        }
      }
    };
    const interval = setInterval(() => void sweep(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, activeCall?.id, device?.deviceId]);

  // ---- subscribe: call-scoped signaling (member_joined / member_left) ----
  //
  // Triggers rotator election on join/leave. The DB source-of-truth gen
  // bump rides on the `calls` postgres_changes UPDATE above — this channel
  // is only for "something happened, wake up and check if you should rotate."
  useEffect(() => {
    if (uiState !== 'in_call' || !activeCall || !device) return;
    const callId = activeCall.id;
    const unsub = subscribeCallSignaling(callId, () => {
      void maybeRotateAfterEvent(callId);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, activeCall?.id, device?.deviceId]);

  const maybeRotateAfterEvent = useCallback(
    async (callId: string) => {
      const dev = deviceRef.current;
      if (!dev) return;
      // Small delay so the joiner's / leaver's DB row has definitely landed
      // (realtime doesn't strictly guarantee write-vs-broadcast ordering).
      await new Promise((r) => setTimeout(r, 250));
      try {
        const amRotator = await isDesignatedRotator({
          callId,
          myDeviceId: dev.deviceId,
        });
        if (!amRotator) return;
        const oldGen = keyedGenRef.current;
        if (oldGen < 1) return;
        const newKey = await rotateCallKeyForCurrentMembers({
          callId,
          device: dev,
          oldGeneration: oldGen,
        });
        await zeroCallKey(newKey); // the gen-bump UPDATE will re-fetch + set
      } catch (e) {
        // Losing the race (another rotator beat us) is expected and benign.
        // The DB rejects with a serialization_failure; we silently move on.
        const msg = errorMessage(e);
        if (!/serialization|new generation|stale/i.test(msg)) {
          console.warn('rotator election race / failure', msg);
        }
      }
    },
    [],
  );

  // ---- tile management: wire LiveKit room events to state ---------------
  const attachRoomEvents = useCallback((adapter: LiveKitAdapter) => {
    const room = adapter.rawRoom;

    const refreshTiles = () => {
      const next: ParticipantTile[] = [];
      const local = room.localParticipant;
      next.push({
        identity: local.identity,
        videoTrack: firstVideoTrack(local),
        audioTracks: [], // never play local audio — would echo
        isLocal: true,
      });
      room.remoteParticipants.forEach((p: RemoteParticipant) => {
        next.push({
          identity: p.identity,
          videoTrack: firstVideoTrack(p),
          audioTracks: subscribedAudioTracks(p),
          isLocal: false,
        });
      });
      setTiles(next);
    };

    room.on(RoomEvent.ParticipantConnected, refreshTiles);
    room.on(RoomEvent.ParticipantDisconnected, refreshTiles);
    room.on(RoomEvent.TrackSubscribed, refreshTiles);
    room.on(RoomEvent.TrackUnsubscribed, refreshTiles);
    room.on(RoomEvent.LocalTrackPublished, refreshTiles);
    room.on(RoomEvent.LocalTrackUnpublished, refreshTiles);

    refreshTiles();
  }, []);

  // ---- start ---------------------------------------------------------------
  const doStart = useCallback(async () => {
    if (!userId || !device) return;
    setUiState('starting');
    setError(null);
    setErrorStack(null);
    setDiag([]);
    try {
      const { callId, callKey } = await step('startCallInRoom', () =>
        startCallInRoom({ roomId, userId, device }),
      );
      callKeyRef.current = callKey;
      keyedGenRef.current = callKey.generation;
      await connectAdapterWith(callId, callKey);
    } catch (e) {
      setError(errorMessage(e));
      setUiState('idle');
      await teardown('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectAdapterWith, device, roomId, userId, step]);

  // ---- join ----------------------------------------------------------------
  const doJoin = useCallback(
    async (call: CallRow) => {
      if (!device) return;
      setUiState('joining');
      setError(null);
      setErrorStack(null);
      setDiag([]);
      try {
        const { currentGeneration } = await step('join_call RPC', () =>
          rpcJoinCall({ callId: call.id, deviceId: device.deviceId }),
        );

        const existing = await step('fetchAndUnwrapCallKey', () =>
          fetchAndUnwrapCallKey({
            callId: call.id,
            generation: currentGeneration,
            device,
          }),
        );
        if (existing) {
          callKeyRef.current = existing;
          keyedGenRef.current = currentGeneration;
          await connectAdapterWith(call.id, existing);
          await step('broadcast member_joined (post-connect)', () =>
            broadcastCallSignaling(call.id, {
              type: 'member_joined',
              deviceId: device.deviceId,
            }),
          );
          return;
        }

        // No envelope for us at current_gen. Two sub-cases:
        //
        // (a) Another device is actively in the call — they'll pick up our
        //     broadcast, rotate, and our `calls` UPDATE subscription will
        //     finish the connect.
        // (b) No one's actively there — zombie call. Nobody to rotate us in.
        //     We self-rotate to take over, seamlessly claiming the call.
        //
        // We check active-ness against the heartbeat grace window so a
        // recently-connected peer isn't mistaken for a zombie. If the
        // other party is just slow to respond, we fall back to self-rotate
        // after a 7s watchdog anyway (see below).
        const members = await step('listCallMembers (zombie check)', () =>
          listCallMembers(call.id),
        );
        const activeOthers = filterActiveCallMembers(members).filter(
          (m) => m.device_id !== device.deviceId,
        );

        if (activeOthers.length === 0) {
          // Zombie or solo — self-rotate to take ownership.
          const newKey = await step('self-rotate (zombie takeover)', () =>
            rotateCallKeyForCurrentMembers({
              callId: call.id,
              device,
              oldGeneration: currentGeneration,
            }),
          );
          callKeyRef.current = newKey;
          keyedGenRef.current = newKey.generation;
          await connectAdapterWith(call.id, newKey);
          await broadcastCallSignaling(call.id, {
            type: 'member_joined',
            deviceId: device.deviceId,
          });
          return;
        }

        // Wait for the rotator to let us in. Also set a 7s watchdog: if
        // nobody rotates us in, self-rotate as a fallback. Concurrent
        // rotations lose on the DB's `new_gen = current + 1` check — benign.
        waitingForEnvelopeRef.current = true;
        joiningCallIdRef.current = call.id;
        await step('broadcast member_joined (awaiting rotation)', () =>
          broadcastCallSignaling(call.id, {
            type: 'member_joined',
            deviceId: device.deviceId,
          }),
        );
        watchdogRef.current = setTimeout(() => {
          watchdogRef.current = null;
          if (
            !waitingForEnvelopeRef.current ||
            joiningCallIdRef.current !== call.id ||
            adapterRef.current
          ) {
            return;
          }
          void (async () => {
            try {
              logDiag('info', 'watchdog: no rotation arrived in 7s — taking over');
              // Read current generation at fire time, not at join time,
              // to avoid stale closure if a rotation landed during the wait.
              const genAtFire = keyedGenRef.current || currentGeneration;
              const newKey = await rotateCallKeyForCurrentMembers({
                callId: call.id,
                device,
                oldGeneration: genAtFire,
              });
              // Only proceed if we're still waiting — the gen-bump UPDATE
              // handler might have connected us first.
              if (waitingForEnvelopeRef.current && !adapterRef.current) {
                waitingForEnvelopeRef.current = false;
                joiningCallIdRef.current = null;
                callKeyRef.current = newKey;
                keyedGenRef.current = newKey.generation;
                await connectAdapterWith(call.id, newKey);
              } else {
                await zeroCallKey(newKey);
              }
            } catch (err) {
              // Losing the race (someone rotated between our check and RPC)
              // is benign: our subscription will pick up the new gen.
              const msg = errorMessage(err);
              if (!/serialization|new generation|stale/i.test(msg)) {
                console.warn('watchdog takeover failed', msg);
              }
            }
          })();
        }, 7_000);
      } catch (e) {
        waitingForEnvelopeRef.current = false;
        joiningCallIdRef.current = null;
        setError(errorMessage(e));
        setUiState('idle');
        await teardown('error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectAdapterWith, device, step],
  );

  // ---- leave / end ---------------------------------------------------------
  const doLeave = useCallback(async () => {
    if (!device || !adapterRef.current) return;
    const callId = adapterRef.current.callId;
    try {
      const members = await listCallMembers(callId);
      const activeOthers = filterActiveCallMembers(members).filter(
        (m) => m.device_id !== device.deviceId,
      );
      if (activeOthers.length === 0) {
        // Last person in the call — end it entirely rather than leaving a
        // zombie call that blocks rejoining and never gets cleaned up.
        await rpcEndCall(callId);
      } else {
        await rpcLeaveCall({ callId, deviceId: device.deviceId });
        broadcastCallSignaling(callId, {
          type: 'member_left',
          deviceId: device.deviceId,
        }).catch((e) => console.warn('leave broadcast failed', errorMessage(e)));
      }
    } catch (e) {
      console.warn('leave/end call rpc failed', errorMessage(e));
    }
    await teardown('local');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  const doEndForEveryone = useCallback(async () => {
    if (!adapterRef.current) return;
    if (!confirm('End call for all participants?')) return;
    try {
      await rpcEndCall(adapterRef.current.callId);
    } catch (e) {
      console.warn('end_call rpc failed', errorMessage(e));
    }
    await teardown('local');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const teardown = useCallback(async (reason: 'local' | 'error' | 'ended') => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    const adapter = adapterRef.current;
    adapterRef.current = null;
    if (adapter) {
      try {
        await adapter.disconnect(reason === 'ended' ? 'local' : reason);
      } catch {
        // ignore
      }
    }
    if (callKeyRef.current) {
      await zeroCallKey(callKeyRef.current);
      callKeyRef.current = null;
    }
    setTiles([]);
    setEncryptionState('pending');
    setEncryptionDetail(null);
    setReceiveOnly(false);
    setReceiveOnlyReason(null);
    setMicEnabled(true);
    setCameraEnabled(true);
    setUiState(reason === 'ended' ? 'ended' : 'idle');
  }, []);

  // cleanup on unmount — also fires leave_call so the user's call_members
  // row gets left_at set immediately (otherwise next joiner sees them as
  // active until the 30s heartbeat sweep).
  useEffect(() => {
    return () => {
      const adapter = adapterRef.current;
      const dev = deviceRef.current;
      if (adapter && dev) {
        rpcLeaveCall({ callId: adapter.callId, deviceId: dev.deviceId }).catch(
          () => undefined,
        );
      }
      void teardown('local');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab-close cleanup: on pagehide/beforeunload while in a call, fire a
  // best-effort leave_call RPC via `fetch({keepalive: true})` so our
  // `call_members.left_at` is set immediately instead of waiting for the
  // 30s heartbeat grace to kick us out. keepalive fetch is the modern
  // replacement for navigator.sendBeacon when custom headers are needed.
  useEffect(() => {
    if (uiState !== 'in_call' || !device || !activeCall) return;
    const callId = activeCall.id;
    const deviceId = device.deviceId;
    let accessToken: string | null = null;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    void getSupabase()
      .auth.getSession()
      .then(({ data }) => {
        accessToken = data.session?.access_token ?? null;
      });

    const onPageHide = () => {
      if (!accessToken || !supabaseUrl || !supabaseAnonKey) return;
      try {
        fetch(`${supabaseUrl}/rest/v1/rpc/leave_call`, {
          method: 'POST',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            p_call_id: callId,
            p_device_id: deviceId,
          }),
        });
      } catch {
        // page is being torn down; nothing useful we can do on error
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, activeCall?.id, device?.deviceId]);

  // ---- render --------------------------------------------------------------
  return (
    <div className="mx-auto max-w-5xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`/rooms/${roomId}`}
            className="text-xs text-blue-600 hover:underline"
          >
            ← back to room
          </Link>
          <h1 className="text-xl font-semibold mt-1">Video call</h1>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs text-neutral-500">
          <EncryptionBadge
            state={encryptionState}
            detail={encryptionDetail}
            preflight={uiState === 'idle'}
          />
          <div>
            state: <span className="font-mono">{uiState}</span>
            {activeCall && (
              <>
                {' '}| gen:{' '}
                <span className="font-mono">{activeCall.current_generation}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {uiState === 'in_call' && encryptionState !== 'active' && (
        <div className="rounded bg-red-100 border-2 border-red-500 p-3 text-sm text-red-900 font-semibold">
          ⚠ ENCRYPTION IS NOT ACTIVE on this call.{' '}
          {encryptionState === 'failed' && 'The E2EE pipeline failed — the SFU may be able to see plaintext frames.'}{' '}
          {encryptionState === 'pending' && 'Still handshaking — if this persists, leave the call.'}{' '}
          {encryptionState === 'unsupported' && 'Your browser cannot enforce E2EE. Leave this call.'}
          <button
            onClick={doLeave}
            className="ml-2 rounded bg-red-600 text-white px-2 py-0.5 text-xs hover:bg-red-700"
          >
            leave now
          </button>
        </div>
      )}

      {error && (
        <div className="rounded bg-red-50 border border-red-200 p-3 text-sm text-red-800 space-y-2">
          <div>
            <span className="font-semibold">Error:</span> {error}
          </div>
          {errorStack && (
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-red-700 hover:underline">
                stack trace
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] leading-snug">
                {errorStack}
              </pre>
            </details>
          )}
        </div>
      )}

      {diag.length > 0 && (
        <details
          className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs"
          open={process.env.NODE_ENV === 'development' || (typeof localStorage !== 'undefined' && localStorage.getItem('debugCall') === '1')}
        >
          <summary className="cursor-pointer select-none font-semibold text-neutral-700">
            diagnostics ({diag.length} step{diag.length === 1 ? '' : 's'})
          </summary>
          <ol className="mt-2 space-y-0.5 font-mono text-[11px]">
            {diag.map((d, i) => (
              <li
                key={i}
                className={
                  d.kind === 'err'
                    ? 'text-red-700'
                    : d.kind === 'ok'
                      ? 'text-green-700'
                      : 'text-neutral-600'
                }
              >
                <span className="opacity-50">
                  {new Date(d.ts).toISOString().slice(11, 23)}
                </span>{' '}
                {d.kind === 'err' ? '✗' : d.kind === 'ok' ? '✓' : '·'} {d.step}
                {d.detail && (
                  <div className="ml-6 whitespace-pre-wrap break-all text-[10px]">
                    {d.detail}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}

      {uiState === 'idle' && !activeCall && (
        <button
          onClick={doStart}
          disabled={!device}
          className="rounded bg-blue-600 text-white px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
        >
          Start E2EE call
        </button>
      )}

      {uiState === 'idle' && activeCall && (
        <button
          onClick={() => doJoin(activeCall)}
          disabled={!device}
          className="rounded bg-green-600 text-white px-4 py-2 hover:bg-green-700 disabled:opacity-50"
        >
          Join call (gen {activeCall.current_generation})
        </button>
      )}

      {(uiState === 'starting' || uiState === 'joining') && (
        <div className="text-sm text-neutral-600">
          {uiState === 'starting' ? 'Starting call…' : 'Joining call…'}
        </div>
      )}

      {uiState === 'in_call' && receiveOnly && (
        <div className="rounded bg-amber-50 border border-amber-300 p-2 text-xs text-amber-900">
          You joined in <strong>listening-only</strong> mode ({receiveOnlyReason ?? 'camera/mic unavailable'}). Others can&rsquo;t see or hear you. Fix permissions and rejoin to publish.
        </div>
      )}

      {uiState === 'in_call' && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {tiles.map((t) => (
                <VideoTile key={t.identity} tile={t} />
              ))}
            </div>
            {userId && device && (
              <div className="h-[480px] lg:h-auto lg:min-h-[320px]">
                <CallChatPanel roomId={roomId} userId={userId} device={device} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!receiveOnly && (
              <>
                <button
                  onClick={async () => {
                    try {
                      await adapterRef.current?.setMicrophoneEnabled(!micEnabled);
                    } catch (e) {
                      console.warn('mic toggle failed', errorMessage(e));
                    }
                  }}
                  className={
                    micEnabled
                      ? 'rounded bg-neutral-700 text-white px-4 py-2 hover:bg-neutral-800'
                      : 'rounded bg-red-600 text-white px-4 py-2 hover:bg-red-700'
                  }
                  aria-pressed={!micEnabled}
                  title={micEnabled ? 'Mute your mic' : 'Unmute your mic'}
                >
                  {micEnabled ? 'mute' : 'unmute'}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await adapterRef.current?.setCameraEnabled(!cameraEnabled);
                    } catch (e) {
                      console.warn('camera toggle failed', errorMessage(e));
                    }
                  }}
                  className={
                    cameraEnabled
                      ? 'rounded bg-neutral-700 text-white px-4 py-2 hover:bg-neutral-800'
                      : 'rounded bg-red-600 text-white px-4 py-2 hover:bg-red-700'
                  }
                  aria-pressed={!cameraEnabled}
                  title={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
                >
                  {cameraEnabled ? 'camera off' : 'camera on'}
                </button>
              </>
            )}
            <button
              onClick={doLeave}
              className="rounded bg-neutral-600 text-white px-4 py-2 hover:bg-neutral-700"
            >
              Leave
            </button>
            <button
              onClick={doEndForEveryone}
              className="rounded bg-red-600 text-white px-4 py-2 hover:bg-red-700"
            >
              End for everyone
            </button>
          </div>
        </>
      )}

      {uiState === 'ended' && (
        <div className="text-sm text-neutral-600">Call ended.</div>
      )}
    </div>
  );

  function onAdapterEvent(ev: LiveKitAdapterEvent): void {
    if (ev.type === 'disconnected' && ev.reason === 'revoked') {
      setError('this device was revoked — disconnecting');
      void teardown('error');
    } else if (ev.type === 'token_refresh_failed') {
      console.warn('livekit token refresh failed:', ev.error);
    } else if (ev.type === 'encryption_state') {
      setEncryptionState(ev.state);
      setEncryptionDetail(ev.detail ?? null);
      logDiag(
        ev.state === 'active' ? 'ok' : ev.state === 'pending' ? 'info' : 'err',
        `encryption ${ev.state}`,
        ev.detail,
      );
    } else if (ev.type === 'receive_only') {
      setReceiveOnly(true);
      setReceiveOnlyReason(ev.reason);
      logDiag('info', 'joined receive-only', ev.reason);
    } else if (ev.type === 'media_state') {
      setMicEnabled(ev.micEnabled);
      setCameraEnabled(ev.cameraEnabled);
    }
  }
}

function EncryptionBadge({
  state,
  detail,
  preflight,
}: {
  state: EncryptionState;
  detail: string | null;
  preflight: boolean;
}) {
  // `preflight` = we haven't connected yet. Show browser-capability check.
  if (preflight) {
    if (!browserSupportsE2EE()) {
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-mono text-red-800"
          title="This browser does not support insertable streams. E2EE cannot engage — a call started here would be plaintext-visible to the SFU. Use Chrome, Edge, or Safari 17+."
        >
          <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
          E2EE UNSUPPORTED
        </span>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded border border-neutral-300 bg-neutral-50 px-2 py-0.5 text-[11px] font-mono text-neutral-600"
        title="Browser supports E2EE. Will verify engagement on connect."
      >
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
        E2EE ready
      </span>
    );
  }

  const styles: Record<EncryptionState, string> = {
    pending:
      'border-amber-300 bg-amber-50 text-amber-800 [&>.dot]:bg-amber-500',
    active:
      'border-green-300 bg-green-50 text-green-800 [&>.dot]:bg-green-600',
    failed: 'border-red-400 bg-red-100 text-red-900 [&>.dot]:bg-red-600',
    unsupported:
      'border-red-400 bg-red-100 text-red-900 [&>.dot]:bg-red-600',
  };
  const label: Record<EncryptionState, string> = {
    pending: 'E2EE handshaking',
    active: 'E2EE active',
    failed: 'E2EE FAILED',
    unsupported: 'E2EE UNSUPPORTED',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-mono ${styles[state]}`}
      title={detail ?? label[state]}
    >
      <span className="dot h-1.5 w-1.5 rounded-full" />
      {label[state]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function firstVideoTrack(p: Participant): Track | null {
  const pubs = Array.from(p.trackPublications.values());
  for (const pub of pubs) {
    if (pub.kind === 'video' && pub.track) return pub.track;
    if (
      pub.kind === 'video' &&
      (pub as RemoteTrackPublication).isSubscribed &&
      (pub as RemoteTrackPublication).track
    ) {
      return (pub as RemoteTrackPublication).track as Track;
    }
  }
  return null;
}

/** All subscribed audio tracks for a participant. Used for remote playback. */
function subscribedAudioTracks(p: Participant): Track[] {
  const out: Track[] = [];
  for (const pub of p.trackPublications.values()) {
    if (pub.kind !== 'audio') continue;
    const track = pub.track;
    if (!track) continue;
    const isSubscribed =
      !('isSubscribed' in pub) || (pub as RemoteTrackPublication).isSubscribed;
    if (isSubscribed) out.push(track);
  }
  return out;
}

function VideoTile({ tile }: { tile: ParticipantTile }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const track = tile.videoTrack;
    if (!track) return;
    try {
      track.attach(el);
    } catch (err) {
      console.warn('attach failed', err);
    }
    return () => {
      try {
        track.detach(el);
      } catch {
        // ignore
      }
    };
  }, [tile.videoTrack]);

  // Remote audio playback. Each subscribed audio track gets its own
  // <audio> element (created by track.attach() when we pass null — LiveKit
  // builds the element for us). We attach to a container we control so
  // cleanup on unsubscribe is easy.
  useEffect(() => {
    const container = audioContainerRef.current;
    if (!container || tile.isLocal) return;
    const elements: HTMLMediaElement[] = [];
    for (const track of tile.audioTracks) {
      try {
        const el = track.attach();
        el.autoplay = true;
        container.appendChild(el);
        elements.push(el);
      } catch (err) {
        console.warn('audio attach failed', err);
      }
    }
    return () => {
      for (const el of elements) {
        try {
          el.remove();
        } catch {
          /* ignore */
        }
      }
      for (const track of tile.audioTracks) {
        try {
          track.detach();
        } catch {
          /* ignore */
        }
      }
    };
  }, [tile.audioTracks, tile.isLocal]);

  // Retro CRT look: thin horizontal scanlines + slight green tint + pixelated
  // upscale. Pure CSS (no canvas pipeline) so it composes cleanly with the
  // LiveKit track attachment. Aspect ratio is 4:3 to match native QVGA.
  return (
    <div className="relative rounded border border-green-700/60 bg-black overflow-hidden aspect-[4/3] shadow-[0_0_20px_rgba(0,255,120,0.15)]">
      {tile.videoTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={tile.isLocal}
          className="w-full h-full object-cover"
          style={{
            imageRendering: 'pixelated',
            filter: 'contrast(1.05) saturate(1.1) hue-rotate(-4deg)',
          }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-green-500/70 text-xs font-mono tracking-wider">
          NO SIGNAL
        </div>
      )}
      {/* Scanline overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-30 mix-blend-overlay"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.7) 0px, rgba(0,0,0,0.7) 1px, transparent 1px, transparent 3px)',
        }}
      />
      {/* Vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.5) 100%)',
        }}
      />
      <div className="absolute bottom-1 left-1 rounded bg-black/70 text-green-400 text-[10px] px-1.5 py-0.5 font-mono border border-green-700/40">
        {tile.isLocal ? 'YOU' : tile.identity.slice(0, 16).toUpperCase()}
        {!tile.isLocal && tile.audioTracks.length > 0 && (
          <span className="ml-1" title="Audio subscribed">♪</span>
        )}
      </div>
      {/* Hidden container for LiveKit-created <audio> elements. */}
      <div ref={audioContainerRef} className="hidden" aria-hidden="true" />
    </div>
  );
}
