'use client';

/**
 * Single source of truth for everything inside a room.
 *
 * Responsibilities:
 *   - load the room row, current-generation roomKey, members
 *   - fetch + decrypt + signature-verify every blob
 *   - subscribe to realtime and merge new blobs into state
 *   - expose `appendEvent(event)` that encrypts + signs + inserts
 *
 * Feature components consume this via `useRoom()` and reduce the `events`
 * list into their own state with `useRoomProjection()`. No feature component
 * should touch the Supabase client directly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CryptoError,
  decryptBlob,
  encryptBlob,
  observeContact,
  unwrapRoomKey,
  type RoomKey,
} from '@/lib/e2ee-core';
import { loadEnrolledDevice, type EnrolledDevice } from '@/lib/bootstrap';
import { getSupabase } from '@/lib/supabase/client';
import {
  decodeBlobRow,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  getMyWrappedRoomKey,
  insertBlob,
  listBlobs,
  subscribeRoom,
  listBlobsSince,
  listRoomMembers,
  subscribeBlobs,
  type BlobRow,
  type RoomMemberRow,
  type RoomRow,
} from '@/lib/supabase/queries';
import {
  maxServerCreatedAt,
  readRoomCache,
  writeRoomCache,
} from '@/lib/domain/roomCache';
import { toast } from 'sonner';
import { parseRoomEvent, type RoomEvent } from '@/lib/domain/events';
import { useNicknames } from '@/lib/domain/nicknames';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { AffectionLayer } from './AffectionLayer';
import { HeartbeatLayer } from './HeartbeatLayer';
import { LiveEventNotifier } from './LiveEventNotifier';
import { describeEventForToast } from '@/lib/domain/notifications';
import { loadMyDisplayName } from '@/lib/domain/myDisplayName';
import { describeError } from '@/lib/domain/errors';

/** A decrypted + verified event with its envelope metadata. */
export interface RoomEventRecord {
  id: string;
  senderId: string;
  createdAt: string;
  event: RoomEvent;           // narrowed by zod
  verified: boolean;
}

/** Non-event blob (decrypt failed, signature invalid, or unrecognized type). */
export interface RoomBlobFailure {
  id: string;
  senderId: string;
  createdAt: string;
  error: string;
}

interface RoomContextValue {
  loading: boolean;
  error: string | null;
  room: RoomRow | null;
  roomKey: RoomKey | null;
  members: RoomMemberRow[];
  myUserId: string | null;
  myDevice: EnrolledDevice | null;
  events: RoomEventRecord[];
  failures: RoomBlobFailure[];
  /** Latest display name each sender has set for themselves (blank = cleared). */
  displayNames: Record<string, string>;
  /** Latest emoji avatar each sender has chosen for this room. */
  memberEmojis: Record<string, string>;
  /**
   * Active reactions grouped by target record id. Each entry is
   * `{ emoji, userIds }` with userIds in stable sender order. Empty array
   * (or missing key) means no active reactions for that target.
   */
  reactionsByTarget: Record<string, ReactionSummary[]>;
  /**
   * Supabase realtime channel status for the room's blob subscription.
   * 'SUBSCRIBED' when the live feed is connected; 'CLOSED' / 'TIMED_OUT'
   * / 'CHANNEL_ERROR' / 'connecting' otherwise. Useful for surfacing a
   * live/pending pill so the user can tell "my partner's send just hasn't
   * arrived yet" apart from "my connection dropped".
   */
  realtimeStatus: string;
  /**
   * User ids currently connected to this room's presence channel — i.e.,
   * actively looking at the room right now. Powers the "in the room" green
   * dot on user orbs. Presence is ephemeral (not stored anywhere); the
   * server only sees "user X present in room Y at time Z" — no content.
   */
  onlineUserIds: Set<string>;
  appendEvent: (event: RoomEvent) => Promise<void>;
  reload: () => Promise<void>;
}

export interface ReactionSummary {
  emoji: string;
  userIds: string[];
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error('useRoom must be called inside <RoomProvider>');
  return ctx;
}

export function RoomProvider({
  roomId,
  children,
}: {
  roomId: string;
  children: React.ReactNode;
}) {
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myDevice, setMyDevice] = useState<EnrolledDevice | null>(null);
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [roomKey, setRoomKey] = useState<RoomKey | null>(null);
  const [members, setMembers] = useState<RoomMemberRow[]>([]);
  const [events, setEvents] = useState<RoomEventRecord[]>([]);
  const [failures, setFailures] = useState<RoomBlobFailure[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [realtimeStatus, setRealtimeStatus] = useState<string>('connecting');
  const [error, setError] = useState<string | null>(null);
  const roomKeyRef = useRef<RoomKey | null>(null);

  const load = useCallback(
    async (
      uid: string,
      device: EnrolledDevice,
      opts: { useCache?: boolean } = {},
    ) => {
      const supabase = getSupabase();
      const { data: roomRow, error: roomErr } = await supabase
        .from('rooms')
        .select('*')
        .eq('id', roomId)
        .maybeSingle<RoomRow>();
      if (roomErr || !roomRow) throw new Error(roomErr?.message ?? 'room not found');
      setRoom(roomRow);

      const wrapped = await getMyWrappedRoomKey({
        roomId,
        deviceId: device.deviceBundle.deviceId,
        generation: roomRow.current_generation,
      });
      if (!wrapped) {
        throw new Error(
          'this device is not a current-generation member of this room (may need to be re-invited or wrapped)',
        );
      }
      const rk = await unwrapRoomKey(
        { wrapped, generation: roomRow.current_generation },
        device.deviceBundle.x25519PublicKey,
        device.deviceBundle.x25519PrivateKey,
      );
      setRoomKey(rk);
      roomKeyRef.current = rk;

      const mems = await listRoomMembers(roomId);
      setMembers(mems);

      // -------- Snapshot hydration ---------------------------------------
      let cursor: string | null = null;
      let hydratedFromCache = false;
      if (opts.useCache !== false) {
        const cache = await readRoomCache(uid, roomId);
        if (cache && cache.generation === roomRow.current_generation) {
          setEvents(cache.events);
          setFailures(cache.failures);
          cursor = cache.lastBlobCreatedAt;
          hydratedFromCache = true;
          setLoading(false);
        }
      }

      // -------- Delta fetch ----------------------------------------------
      const rows = cursor
        ? await listBlobsSince(roomId, cursor)
        : await listBlobs(roomId);
      await mergeBlobs(rows, rk, device, uid, { replace: !hydratedFromCache });
    },
    [roomId],
  );

  const mergeBlobs = useCallback(
    async (
      rows: BlobRow[],
      rk: RoomKey,
      device: EnrolledDevice,
      uid: string,
      opts: { replace?: boolean } = {},
    ) => {
      const decoded = await Promise.all(
        rows.map((row) => decodeBlobToEvent(row, rk, device, uid)),
      );
      const nextEvents: RoomEventRecord[] = [];
      const nextFailures: RoomBlobFailure[] = [];
      for (const d of decoded) {
        if (d.kind === 'event') nextEvents.push(d.record);
        else if (d.kind === 'failure') nextFailures.push(d.failure);
        // 'skip' → silently drop; benign forward-compat row.
      }
      setEvents((prev) => {
        if (opts.replace) return sortEvents(nextEvents);
        const seen = new Set(prev.map((e) => e.id));
        const merged = [...prev];
        for (const e of nextEvents) if (!seen.has(e.id)) merged.push(e);
        return sortEvents(merged);
      });
      setFailures((prev) => {
        if (opts.replace) return nextFailures;
        const seen = new Set(prev.map((f) => f.id));
        const merged = [...prev];
        for (const f of nextFailures) if (!seen.has(f.id)) merged.push(f);
        return merged;
      });
    },
    [],
  );

  // Initial bootstrap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getUser();
        if (!data.user) return;
        if (cancelled) return;
        // Push the session JWT to the realtime client BEFORE setting the
        // state that fans out to the blob-subscribe useEffect. Otherwise
        // setMyDevice triggers a re-render → subscribeBlobs runs while
        // realtime is still anon → the socket opens but RLS filters every
        // postgres_change event silently. The user sees "no realtime,
        // refresh required."
        const { data: sess } = await supabase.auth.getSession();
        if (sess.session?.access_token) {
          supabase.realtime.setAuth(sess.session.access_token);
        }
        setMyUserId(data.user.id);
        const dev = await loadEnrolledDevice(data.user.id);
        if (!dev) throw new Error('no enrolled device for this account on this browser');
        if (cancelled) return;
        setMyDevice(dev);
        await load(data.user.id, dev);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Keep the latest displayNames accessible to the realtime handler without
  // re-subscribing when nicknames or display-name events change.
  const displayNamesRef = useRef<Record<string, string>>({});

  // Realtime blob subscription.
  useEffect(() => {
    if (!myDevice || !myUserId) return;
    setRealtimeStatus('connecting');
    const unsub = subscribeBlobs(
      roomId,
      async (row) => {
      const rk = roomKeyRef.current;
      if (!rk) return;
      if (row.sender_id !== myUserId) {
        try {
          const decoded = await decodeBlobToEvent(row, rk, myDevice, myUserId);
          if (decoded.kind === 'event') {
            const partnerName = fmtDisplayName(
              decoded.record.senderId,
              displayNamesRef.current,
              myUserId,
              null,
            );
            const desc = describeEventForToast(
              decoded.record.event,
              partnerName,
              myUserId,
            );
            if (desc) {
              toast(desc.text, { icon: desc.emoji });
            }
          }
        } catch {
          // Decode failures handled by mergeBlobs below.
        }
      }
      await mergeBlobs([row], rk, myDevice, myUserId);
      },
      (status) => setRealtimeStatus(status),
    );
    return unsub;
  }, [roomId, myDevice, myUserId, mergeBlobs]);

  // Rooms-row updates — propagate column writes (name_ciphertext rename,
  // current_generation bumps) to every current member's local state so the
  // room name, generation-gated UI, etc. all stay in sync without a
  // refresh. Was the cause of the "owner renames but partner can't see it"
  // bug: the column was being written on the server, but every viewer's
  // local `room` object was frozen at the initial fetch.
  useEffect(() => {
    if (!roomId) return;
    // subscribeRoom (alias for subscribeRoomMetadata) only signals that
    // metadata changed; it doesn't carry the new row. Re-fetch the room
    // row on signal so name_ciphertext / current_generation stay in sync.
    const unsub = subscribeRoom(roomId, () => {
      const supabase = getSupabase();
      void supabase
        .from('rooms')
        .select('*')
        .eq('id', roomId)
        .maybeSingle<RoomRow>()
        .then(({ data }) => {
          if (data) setRoom(data);
        });
    });
    return unsub;
  }, [roomId]);

  // Presence channel — ephemeral "who's looking at this room right now".
  // Separate channel from the blob subscription so its lifecycle (track on
  // subscribe / untrack on unmount) doesn't entangle with event delivery.
  // Server sees presence metadata only; no encrypted content flows here.
  useEffect(() => {
    if (!myUserId) return;
    const supabase = getSupabase();
    // UUID suffix so two tabs for the same user don't collide at the
    // channel-name level (same pattern used for subscribeInvites).
    const channel = supabase.channel(`room-presence:${roomId}:${crypto.randomUUID()}`, {
      config: { presence: { key: myUserId } },
    });
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      setOnlineUserIds(new Set(Object.keys(state)));
    });
    void channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try {
          await channel.track({ online_at: Date.now() });
        } catch {
          // best-effort; presence isn't load-bearing.
        }
      }
    });
    return () => {
      void channel.untrack().catch(() => { /* noop */ });
      void supabase.removeChannel(channel);
    };
  }, [roomId, myUserId]);

  const appendEvent = useCallback(
    async (event: RoomEvent) => {
      if (!roomKey || !myDevice || !myUserId) {
        throw new Error('room not ready');
      }
      const tempId = `temp-${crypto.randomUUID()}`;
      const optimistic: RoomEventRecord = {
        id: tempId,
        senderId: myUserId,
        createdAt: new Date().toISOString(),
        event,
        verified: true,
      };
      setEvents((prev) => sortEvents([...prev, optimistic]));

      try {
        const blob = await encryptBlob({
          payload: event,
          roomId,
          roomKey,
          senderUserId: myUserId,
          senderDeviceId: myDevice.deviceBundle.deviceId,
          senderDeviceEd25519PrivateKey: myDevice.deviceBundle.ed25519PrivateKey,
        });
        const row = await insertBlob({
          roomId,
          senderId: myUserId,
          senderDeviceId: myDevice.deviceBundle.deviceId,
          blob,
        });

        // Swap the optimistic temp for the real server row. If realtime has
        // already delivered the row, `seen.has(row.id)` is true and we just
        // drop the temp without double-inserting.
        setEvents((prev) => {
          const withoutTemp = prev.filter((e) => e.id !== tempId);
          const seen = new Set(withoutTemp.map((e) => e.id));
          if (seen.has(row.id)) return sortEvents(withoutTemp);
          const real: RoomEventRecord = {
            id: row.id,
            senderId: myUserId,
            createdAt: row.created_at,
            event,
            verified: true,
          };
          return sortEvents([...withoutTemp, real]);
        });
      } catch (err) {
        // Rollback the optimistic record on failure.
        setEvents((prev) => prev.filter((e) => e.id !== tempId));
        throw err;
      }
    },
    [roomId, roomKey, myDevice, myUserId],
  );

  const reload = useCallback(async () => {
    if (!myUserId || !myDevice) return;
    setLoading(true);
    setError(null);
    try {
      await load(myUserId, myDevice, { useCache: false });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [myUserId, myDevice, load]);

  // Persist a snapshot whenever server-confirmed events or failures change.
  // Optimistic temp- records are filtered out so a cache hit never replays
  // a rolled-back local action. Best-effort — IDB write failures are
  // swallowed inside writeRoomCache.
  useEffect(() => {
    if (!myUserId || !room) return;
    const confirmedEvents = events.filter((e) => !e.id.startsWith('temp-'));
    const cursor = maxServerCreatedAt(confirmedEvents, failures);
    if (!cursor) return; // nothing to cache yet
    void writeRoomCache({
      userId: myUserId,
      roomId,
      generation: room.current_generation,
      events: confirmedEvents,
      failures,
      lastBlobCreatedAt: cursor,
    });
  }, [myUserId, roomId, room, events, failures]);

  // Project the latest display_name_set / member_update per sender. Only the
  // sender themselves can meaningfully set their own name; reducer enforces
  // this by keying on senderId.
  const eventDisplayNames = useMemo<Record<string, string>>(() => {
    const latestTs: Record<string, number> = {};
    const names: Record<string, string> = {};
    for (const rec of events) {
      if (rec.event.type === 'display_name_set') {
        const prior = latestTs[rec.senderId] ?? 0;
        if (rec.event.ts <= prior) continue;
        latestTs[rec.senderId] = rec.event.ts;
        const trimmed = rec.event.name.trim();
        if (trimmed.length > 0) names[rec.senderId] = trimmed;
        else delete names[rec.senderId];
      } else if (
        rec.event.type === 'member_update' &&
        rec.event.nickname !== undefined
      ) {
        const prior = latestTs[rec.senderId] ?? 0;
        if (rec.event.ts <= prior) continue;
        latestTs[rec.senderId] = rec.event.ts;
        const trimmed = rec.event.nickname.trim();
        if (trimmed.length > 0) names[rec.senderId] = trimmed;
        else delete names[rec.senderId];
      }
    }
    return names;
  }, [events]);

  // Reactions: per (targetId, senderId, emoji), track max add-ts + max
  // remove-ts. Active ⇔ addTs > removeTs. Then roll up into
  // { targetId → [{ emoji, userIds }] } for O(1) consumer reads.
  const reactionsByTarget = useMemo<Record<string, ReactionSummary[]>>(() => {
    // tuple[targetId][senderId][emoji] = [addTs, removeTs]
    const raw: Record<
      string,
      Record<string, Record<string, [number, number]>>
    > = {};
    for (const rec of events) {
      const ev = rec.event;
      if (ev.type !== 'add_reaction' && ev.type !== 'remove_reaction') continue;
      const t = raw[ev.targetId] ??= {};
      const s = t[rec.senderId] ??= {};
      const pair = (s[ev.emoji] ??= [0, 0]);
      const idx = ev.type === 'add_reaction' ? 0 : 1;
      if (ev.ts > pair[idx]) pair[idx] = ev.ts;
    }
    const out: Record<string, ReactionSummary[]> = {};
    for (const [targetId, bySender] of Object.entries(raw)) {
      const byEmoji: Record<string, string[]> = {};
      for (const [senderId, emojis] of Object.entries(bySender)) {
        for (const [emoji, [addTs, removeTs]] of Object.entries(emojis)) {
          if (addTs > removeTs) {
            (byEmoji[emoji] ??= []).push(senderId);
          }
        }
      }
      const summaries = Object.entries(byEmoji)
        .map(([emoji, userIds]) => ({ emoji, userIds }))
        .sort((a, b) => b.userIds.length - a.userIds.length);
      if (summaries.length > 0) out[targetId] = summaries;
    }
    return out;
  }, [events]);

  // Latest emoji per sender from member_update events. Empty string clears.
  const memberEmojis = useMemo<Record<string, string>>(() => {
    const latestTs: Record<string, number> = {};
    const emojis: Record<string, string> = {};
    for (const rec of events) {
      if (rec.event.type !== 'member_update') continue;
      if (rec.event.emoji === undefined) continue;
      const prior = latestTs[rec.senderId] ?? 0;
      if (rec.event.ts <= prior) continue;
      latestTs[rec.senderId] = rec.event.ts;
      const trimmed = rec.event.emoji.trim();
      if (trimmed.length > 0) emojis[rec.senderId] = trimmed;
      else delete emojis[rec.senderId];
    }
    return emojis;
  }, [events]);

  // Merge in device-local nicknames. Nicknames WIN over event names — they're
  // this viewer's personal preference and should override anything the other
  // person has set for themselves. "Sarah" (my nickname) beats "ktron" (their
  // published name) on my device, but they see "ktron" on theirs.
  const { nicknames } = useNicknames();
  const displayNames = useMemo(() => {
    // Nicknames are local, per-device overrides for OTHER people. Never
    // let a nickname override my own display name in MY view — if I've
    // ever written "partner" as a nickname for my own uid, I'd see
    // "partner" everywhere instead of my actual published name.
    const filtered: Record<string, string> = {};
    for (const [uid, nick] of Object.entries(nicknames)) {
      if (uid === myUserId) continue;
      filtered[uid] = nick;
    }
    return { ...eventDisplayNames, ...filtered };
  }, [eventDisplayNames, nicknames, myUserId]);
  // Mirror for the realtime handler (which can't have displayNames in deps
  // without re-subscribing on every change).
  useEffect(() => {
    displayNamesRef.current = displayNames;
  }, [displayNames]);

  // Auto-emit display_name_set on first room entry if the user has a
  // stored default name from onboarding and hasn't published one in this
  // room yet. One-shot per room (the ref resets on room change).
  const autoEmittedNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !room || !myUserId || !roomKey || !myDevice) return;
    if (autoEmittedNameRef.current === room.id) return;
    const alreadyPublished = events.some(
      (e) =>
        e.senderId === myUserId && e.event.type === 'display_name_set',
    );
    if (alreadyPublished) {
      autoEmittedNameRef.current = room.id;
      return;
    }
    const stored = loadMyDisplayName();
    if (!stored) return;
    autoEmittedNameRef.current = room.id;
    void appendEvent({
      type: 'display_name_set',
      name: stored,
      ts: Date.now(),
    }).catch(() => {
      // Non-fatal — user can still set it manually from Members.
      autoEmittedNameRef.current = null;
    });
  }, [loading, room, myUserId, roomKey, myDevice, events, appendEvent]);

  // Auto-rename a freshly-created room to "{name}'s room" the first time
  // the creator opens it, if nobody has named the room yet. Skips if a
  // room_rename already exists (respecting explicit renames, including a
  // deliberate clear). Only the creator auto-renames so two people
  // entering a brand-new pair don't race.
  const autoRenamedRoomRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !room || !myUserId || !roomKey || !myDevice) return;
    if (autoRenamedRoomRef.current === room.id) return;
    if (room.created_by !== myUserId) return;
    const alreadyRenamed = events.some(
      (e) => e.event.type === 'room_rename',
    );
    if (alreadyRenamed) {
      autoRenamedRoomRef.current = room.id;
      return;
    }
    const stored = loadMyDisplayName();
    if (!stored) return;
    autoRenamedRoomRef.current = room.id;
    void appendEvent({
      type: 'room_rename',
      name: `${stored}'s room`,
      ts: Date.now(),
    }).catch(() => {
      autoRenamedRoomRef.current = null;
    });
  }, [loading, room, myUserId, roomKey, myDevice, events, appendEvent]);

  const value = useMemo<RoomContextValue>(
    () => ({
      loading,
      error,
      room,
      roomKey,
      members,
      myUserId,
      myDevice,
      events,
      failures,
      displayNames,
      memberEmojis,
      reactionsByTarget,
      realtimeStatus,
      onlineUserIds,
      appendEvent,
      reload,
    }),
    [loading, error, room, roomKey, members, myUserId, myDevice, events, failures, displayNames, memberEmojis, reactionsByTarget, realtimeStatus, onlineUserIds, appendEvent, reload],
  );

  return (
    <RoomContext.Provider value={value}>
      <HeartbeatLayer>
        {children}
        <AffectionLayer />
        <LiveEventNotifier />
      </HeartbeatLayer>
    </RoomContext.Provider>
  );
}

/**
 * Reduce the room's event stream into a feature-specific projection.
 * Returns the fold of `reducer` over all known events in chronological order.
 */
export function useRoomProjection<T>(
  reducer: (state: T, event: RoomEventRecord) => T,
  initial: T,
): T {
  const { events } = useRoom();
  return useMemo(
    () => events.reduce((acc, rec) => reducer(acc, rec), initial),
    [events, reducer, initial],
  );
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type DecodeResult =
  | { kind: 'event'; record: RoomEventRecord }
  | { kind: 'failure'; failure: RoomBlobFailure }
  // Benign forward-compat: a decrypted blob whose payload didn't match any
  // known event schema (e.g. an event type added in a newer build, or
  // residue from older dev sessions). Not a security concern, not actionable
  // — silently drop instead of surfacing as a "✗ invalid" row in the chat.
  | { kind: 'skip' };

async function decodeBlobToEvent(
  row: BlobRow,
  rk: RoomKey,
  viewerDevice: EnrolledDevice,
  viewerUserId: string,
): Promise<DecodeResult> {
  try {
    const blob = await decodeBlobRow(row);
    if (blob.generation !== rk.generation) {
      return {
        kind: 'failure',
        failure: {
          id: row.id,
          senderId: row.sender_id,
          createdAt: row.created_at,
          error: `blob gen ${blob.generation}, current roomKey gen ${rk.generation}`,
        },
      };
    }
    // Per-device sender resolver: fetches the sender's device list once
    // per sender, caches by (userId, deviceId).
    const senderUserId = row.sender_id;
    let viewerSenderEd: Uint8Array | undefined;
    if (senderUserId === viewerUserId) {
      viewerSenderEd = viewerDevice.deviceBundle.ed25519PublicKey;
    }
    const resolveSenderDeviceEd25519Pub = async (
      userId: string,
      deviceId: string,
    ): Promise<Uint8Array | null> => {
      if (userId === viewerUserId && deviceId === viewerDevice.deviceBundle.deviceId) {
        return viewerDevice.deviceBundle.ed25519PublicKey;
      }
      try {
        const devices = await fetchPublicDevices(userId);
        const match = devices.find((d) => d.deviceId === deviceId);
        return match?.ed25519PublicKey ?? null;
      } catch {
        return null;
      }
    };
    // Legacy v1/v2 fallback: the sender's MSK pub via the (renamed)
    // identity helper. Best-effort observeContact for TOFU bookkeeping.
    let legacySenderEd: Uint8Array | undefined = viewerSenderEd;
    if (!legacySenderEd && senderUserId !== viewerUserId) {
      try {
        const pub = await fetchUserMasterKeyPub(senderUserId);
        if (pub) {
          legacySenderEd = pub.ed25519PublicKey;
          // v2-era observeContact required {ed, x, selfSig}; v3 only has
          // MSK pub. Synthesize an empty x/selfSig so the legacy TOFU
          // store still tracks "have we seen this MSK". Cross-signing is
          // the v3-native trust attestation (cross_user_signatures table).
          await observeContact(senderUserId, {
            ed25519PublicKey: pub.ed25519PublicKey,
            x25519PublicKey: new Uint8Array(0),
            selfSignature: new Uint8Array(0),
          });
        }
      } catch {
        /* legacy observe is best-effort */
      }
    }
    const decrypted = await decryptBlob<unknown>({
      blob,
      roomId: row.room_id,
      roomKey: rk,
      senderEd25519PublicKey: legacySenderEd ?? null,
      resolveSenderDeviceEd25519Pub,
    });
    const event = parseRoomEvent(decrypted.payload);
    if (!event) {
      // Benign — the sender wrote an event type this build doesn't know.
      // Surface nothing; the row stays in the encrypted ledger and a future
      // build that knows the schema will pick it up.
      return { kind: 'skip' };
    }
    return {
      kind: 'event',
      record: {
        id: row.id,
        senderId: row.sender_id,
        createdAt: row.created_at,
        event,
        verified: true,
      },
    };
  } catch (e) {
    const message =
      e instanceof CryptoError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      kind: 'failure',
      failure: {
        id: row.id,
        senderId: row.sender_id,
        createdAt: row.created_at,
        error: message,
      },
    };
  }
}

function sortEvents(list: RoomEventRecord[]): RoomEventRecord[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
