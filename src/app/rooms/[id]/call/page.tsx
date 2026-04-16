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
import { AppShell } from '@/components/AppShell';
import { getSupabase } from '@/lib/supabase/client';
import { errorMessage } from '@/lib/errors';
import type { DeviceKeyBundle, CallKey } from '@/lib/e2ee-core';
import { zeroCallKey } from '@/lib/e2ee-core';
import {
  fetchAndUnwrapCallKey,
  isDesignatedRotator,
  listStaleCallDeviceIds,
  loadEnrolledDevice,
  rotateCallKeyForCurrentMembers,
  startCallInRoom,
} from '@/lib/bootstrap';
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
  makeDefaultTokenFetcher,
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
  isLocal: boolean;
}

interface DiagEntry {
  ts: number;
  kind: 'info' | 'ok' | 'err';
  step: string;
  detail?: string;
}

function CallInner({ roomId }: { roomId: string }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceKeyBundle | null>(null);
  const [activeCall, setActiveCall] = useState<CallRow | null>(null);
  const [uiState, setUiState] = useState<CallUiState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorStack, setErrorStack] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagEntry[]>([]);
  const [tiles, setTiles] = useState<ParticipantTile[]>([]);

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
          if (adapterRef.current && adapterRef.current.callId === row.id) {
            void teardown('ended');
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
        isLocal: true,
      });
      room.remoteParticipants.forEach((p: RemoteParticipant) => {
        next.push({
          identity: p.identity,
          videoTrack: firstVideoTrack(p),
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

        // Waiting for rotator — the `calls` UPDATE subscription will pick us up.
        waitingForEnvelopeRef.current = true;
        joiningCallIdRef.current = call.id;
        await step('broadcast member_joined (awaiting rotation)', () =>
          broadcastCallSignaling(call.id, {
            type: 'member_joined',
            deviceId: device.deviceId,
          }),
        );
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
      await rpcLeaveCall({ callId, deviceId: device.deviceId });
      // Wake the next designated rotator so remaining members re-key
      // immediately (backward secrecy). Fire-and-forget is fine; if it
      // fails, the heartbeat-grace path (phase 7) will catch it within 30s.
      broadcastCallSignaling(callId, {
        type: 'member_left',
        deviceId: device.deviceId,
      }).catch((e) => console.warn('leave broadcast failed', errorMessage(e)));
    } catch (e) {
      console.warn('leave_call rpc failed', errorMessage(e));
    }
    await teardown('local');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  const doEndForEveryone = useCallback(async () => {
    if (!adapterRef.current) return;
    try {
      await rpcEndCall(adapterRef.current.callId);
    } catch (e) {
      console.warn('end_call rpc failed', errorMessage(e));
    }
    await teardown('local');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const teardown = useCallback(async (reason: 'local' | 'error' | 'ended') => {
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
    setUiState(reason === 'ended' ? 'ended' : 'idle');
  }, []);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      void teardown('local');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <div className="text-xs text-neutral-500">
          state: <span className="font-mono">{uiState}</span>
          {activeCall && (
            <>
              {' '}| gen:{' '}
              <span className="font-mono">{activeCall.current_generation}</span>
            </>
          )}
        </div>
      </div>

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
        <details className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs" open>
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

      {uiState === 'in_call' && (
        <>
          <div className="grid grid-cols-2 gap-4">
            {tiles.map((t) => (
              <VideoTile key={t.identity} tile={t} />
            ))}
          </div>
          <div className="flex gap-2">
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
    }
  }
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

function VideoTile({ tile }: { tile: ParticipantTile }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
      </div>
    </div>
  );
}
