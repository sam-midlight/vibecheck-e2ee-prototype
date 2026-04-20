'use client';

/**
 * MemoryBank — masonry archive of "locked" dates (completed by all
 * members or past their `scheduledAt + 24h` window).
 *
 * Each card shows the date title, energy, memory count, and a
 * polaroid-style preview of up to 3 photos. Clicking a card opens a
 * fuller view with every captured highlight + photo + the winning
 * roulette spin from that night.
 *
 * Pure projection — no events written. Auto-archive lives entirely
 * in the projection, never touches the server side.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { uniqueMembers } from '@/lib/domain/members';
import { inferCategoryForTitle } from '@/lib/domain/dateHeuristics';
import { hueForUser } from '@/lib/domain/userTheme';
import { decryptImageAttachment } from '@/lib/e2ee-core';
import { downloadAttachment } from '@/lib/supabase/queries';
import type { ImageAttachmentHeader } from '@/lib/domain/events';
import { FeatureSheet } from './FeatureSheet';
import {
  useRoom,
  useRoomProjection,
  type RoomEventRecord,
} from './RoomProvider';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ArchivedMemory {
  memoryId: string;
  senderId: string;
  kind: 'text' | 'photo';
  text?: string;
  attachment?: ImageAttachmentHeader;
  ts: number;
}

interface ArchivedWallPost {
  postId: string;
  senderId: string;
  kind: 'text' | 'photo';
  text?: string;
  attachment?: ImageAttachmentHeader;
  ts: number;
}

interface ArchivedSpin {
  winnerLabel: string;
  ts: number;
}

interface CompletionReflection {
  feedback: string;
  ts: number;
}

interface ArchivedDate {
  ideaId: string;
  title: string;
  energy: 'low' | 'medium' | 'high';
  scheduledTs: number | null;
  completedBy: Set<string>;
  /** Per-user comment captured at the moment of marking complete.
   *  Latest-ts wins per user (in case they re-submitted before the
   *  vault locked). Once the vault locks these are frozen — there's
   *  no UI to re-emit a date_idea_complete event. */
  completionReflections: Record<string, CompletionReflection>;
  /** Per-user reflections (date_memory events). Side-by-side polaroid
   *  columns in the archive. */
  memories: ArchivedMemory[];
  /** Wall-of-intent posts (date_post events) saved into a flippable
   *  "pile" you next-through. Survives the vault locking. */
  wallPile: ArchivedWallPost[];
  spins: ArchivedSpin[];
}

export function MemoryBank() {
  const { events, members, room, myUserId, displayNames } = useRoom();
  const [openId, setOpenId] = useState<string | null>(null);

  const memberIds = useMemo(
    () =>
      room ? uniqueMembers(members, room.current_generation).map((m) => m.user_id) : [],
    [members, room],
  );
  const now = Date.now();

  const archived = useMemo(() => {
    interface Working extends ArchivedDate {
      deleted: boolean;
    }
    const all: Record<string, Working> = {};
    /** Per-post deletion tombstones (date_post_delete) — applied after
     *  the main pass so order doesn't matter. */
    const deletedPosts = new Set<string>();
    for (const rec of events) {
      const ev = rec.event;
      switch (ev.type) {
        case 'date_idea_add':
          if (!all[ev.ideaId]) {
            all[ev.ideaId] = {
              ideaId: ev.ideaId,
              title: ev.title,
              energy: ev.energy,
              scheduledTs: null,
              completedBy: new Set(),
              completionReflections: {},
              memories: [],
              wallPile: [],
              spins: [],
              deleted: false,
            };
          }
          break;
        case 'date_idea_delete':
          if (all[ev.ideaId]) all[ev.ideaId].deleted = true;
          break;
        case 'date_idea_schedule':
          if (all[ev.ideaId]) {
            all[ev.ideaId].scheduledTs = Date.parse(ev.scheduledAt) || null;
          }
          break;
        case 'date_idea_complete': {
          const d = all[ev.ideaId];
          if (!d) break;
          d.completedBy.add(rec.senderId);
          // Latest-ts wins per user — they may have re-submitted
          // before the vault locked. Once locked, the UI doesn't
          // surface a re-emit path, so this is effectively frozen.
          if (ev.feedback) {
            const prior = d.completionReflections[rec.senderId];
            if (!prior || ev.ts >= prior.ts) {
              d.completionReflections[rec.senderId] = {
                feedback: ev.feedback,
                ts: ev.ts,
              };
            }
          }
          break;
        }
        case 'date_memory':
          if (all[ev.dateId]) {
            all[ev.dateId].memories.push({
              memoryId: ev.memoryId,
              senderId: rec.senderId,
              kind: ev.kind,
              text: ev.text,
              attachment: ev.attachment,
              ts: ev.ts,
            });
          }
          break;
        case 'date_post':
          if (all[ev.dateId]) {
            all[ev.dateId].wallPile.push({
              postId: ev.postId,
              senderId: rec.senderId,
              kind: ev.kind,
              text: ev.text,
              attachment: ev.attachment,
              ts: ev.ts,
            });
          }
          break;
        case 'date_post_delete':
          deletedPosts.add(ev.postId);
          break;
        case 'date_roulette_spin':
          if (ev.dateId && all[ev.dateId]) {
            const winnerLabel =
              ev.slicesSnapshot.find((s) => s.sliceId === ev.winnerSliceId)?.label ??
              '?';
            all[ev.dateId].spins.push({ winnerLabel, ts: ev.ts });
          }
          break;
      }
    }
    // Apply post deletions across the board.
    for (const d of Object.values(all)) {
      d.wallPile = d.wallPile.filter((p) => !deletedPosts.has(p.postId));
    }
    // Filter to "archived": all-completed OR scheduledAt + 24h past.
    const out: ArchivedDate[] = [];
    for (const d of Object.values(all)) {
      if (d.deleted) continue;
      const allCompleted =
        memberIds.length > 0 &&
        memberIds.every((u) => d.completedBy.has(u));
      const expiredAt = d.scheduledTs != null ? d.scheduledTs + DAY_MS : null;
      const expired = expiredAt != null && now > expiredAt;
      if (!allCompleted && !expired) continue;
      // Newest spin first within each date.
      d.spins.sort((a, b) => b.ts - a.ts);
      d.memories.sort((a, b) => b.ts - a.ts);
      const { deleted: _, ...stripped } = d;
      void _;
      out.push(stripped);
    }
    // Newest dates first.
    out.sort((a, b) => (b.scheduledTs ?? 0) - (a.scheduledTs ?? 0));
    return out;
  }, [events, memberIds, now]);

  if (!room || !myUserId) return null;

  if (archived.length === 0) {
    return (
      <section className="rounded-3xl border border-white/40 bg-white/45 p-5 text-center shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
        <p className="font-display italic text-lg text-neutral-900 dark:text-neutral-50">
          No memories yet.
        </p>
        <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
          Once a date wraps up, the vault locks and lands here.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-700 dark:text-neutral-300">
          Memory bank
        </span>
        <span className="font-mono text-[10px] tabular-nums text-neutral-500">
          {archived.length} {archived.length === 1 ? 'memory' : 'memories'}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {archived.map((d) => (
          <ArchiveCard key={d.ideaId} date={d} onOpen={() => setOpenId(d.ideaId)} />
        ))}
      </ul>
      {openId && (
        <FeatureSheet
          key={`memory-${openId}`}
          title={archived.find((d) => d.ideaId === openId)?.title ?? 'Memory'}
          emoji="📸"
          onClose={() => setOpenId(null)}
        >
          <PolaroidView
            date={archived.find((d) => d.ideaId === openId)!}
            displayNames={displayNames}
            myUserId={myUserId}
          />
        </FeatureSheet>
      )}
    </section>
  );
}

function ArchiveCard({
  date,
  onOpen,
}: {
  date: ArchivedDate;
  onOpen: () => void;
}) {
  // Preview surface mixes reflection photos + wall photos so the card
  // shows whatever was visually captured, regardless of source.
  const photos = [
    ...date.memories.filter((m) => m.attachment).map((m) => m.attachment!),
    ...date.wallPile.filter((p) => p.attachment).map((p) => p.attachment!),
  ].slice(0, 3);
  const category = inferCategoryForTitle(date.title, date.energy);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full rounded-3xl border border-white/40 bg-white/55 p-4 text-left shadow-lg backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.02] dark:border-white/10 dark:bg-neutral-900/55"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-neutral-600 dark:text-neutral-400">
              {category} · {date.energy} energy
            </p>
            <h3 className="mt-0.5 font-display italic text-lg leading-tight text-neutral-900 dark:text-neutral-50">
              {date.title}
            </h3>
            <p className="mt-0.5 font-mono text-[10px] tabular-nums text-neutral-500">
              {date.scheduledTs
                ? new Date(date.scheduledTs).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : 'undated'}
            </p>
          </div>
          <div className="rounded-full bg-neutral-900/10 px-2 py-0.5 font-mono text-[10px] tabular-nums text-neutral-700 dark:bg-white/15 dark:text-neutral-200">
            {date.memories.length}
          </div>
        </div>
        {photos.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-1">
            {photos.map((header, i) => (
              <PolaroidThumb key={`${header.blobId}-${i}`} header={header} />
            ))}
          </div>
        )}
        {date.spins.length > 0 && (
          <p className="mt-2 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-600 dark:text-neutral-400">
            🏆 {date.spins[0].winnerLabel}
          </p>
        )}
      </button>
    </li>
  );
}

function PolaroidThumb({ header }: { header: ImageAttachmentHeader }) {
  const { room, roomKey } = useRoom();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    (async () => {
      if (!room || !roomKey) return;
      try {
        const encryptedBytes = await downloadAttachment({
          roomId: room.id,
          blobId: header.blobId,
        });
        const plaintext = await decryptImageAttachment({
          encryptedBytes,
          roomKey,
          roomId: room.id,
          blobId: header.blobId,
          generation: roomKey.generation,
        });
        if (cancelled) return;
        const blob = new Blob([plaintext.slice().buffer as ArrayBuffer], {
          type: header.mime,
        });
        const url = URL.createObjectURL(blob);
        revoke = url;
        setSrc(url);
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [header, room, roomKey]);
  return (
    <div className="overflow-hidden rounded-md bg-neutral-200 aspect-square dark:bg-neutral-800">
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="memory" className="block h-full w-full object-cover" />
      )}
    </div>
  );
}

function PolaroidView({
  date,
  displayNames,
  myUserId,
}: {
  date: ArchivedDate;
  displayNames: Record<string, string>;
  myUserId: string;
}) {
  const reflectionEntries = Object.entries(date.completionReflections);
  const hasAnyArtefact =
    date.memories.length > 0 ||
    date.wallPile.length > 0 ||
    date.spins.length > 0 ||
    reflectionEntries.length > 0;
  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600 dark:text-neutral-400">
          {date.energy} · {inferCategoryForTitle(date.title, date.energy)}
        </p>
        {date.scheduledTs && (
          <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
            {new Date(date.scheduledTs).toLocaleString()}
          </p>
        )}
      </div>
      {date.spins.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50/80 p-3 dark:border-amber-700 dark:bg-amber-950/60">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-700 dark:text-amber-200">
            Roulette winners
          </p>
          <ul className="mt-1 space-y-0.5">
            {date.spins.map((s, i) => (
              <li key={i} className="font-display italic text-sm text-amber-900 dark:text-amber-100">
                🏆 {s.winnerLabel}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Frozen completion comments — captured at the moment each
          person marked the date complete. No edits possible after
          the vault locks. */}
      {reflectionEntries.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
            How it went
          </p>
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, Math.min(reflectionEntries.length, 2))}, minmax(0, 1fr))`,
            }}
          >
            {reflectionEntries.map(([senderId, entry]) => {
              const hue = hueForUser(senderId);
              const isMe = senderId === myUserId;
              const name = isMe
                ? 'you'
                : firstWord(fmtDisplayName(senderId, displayNames, myUserId, null));
              return (
                <div
                  key={senderId}
                  className="rounded-2xl border bg-white/85 p-3 shadow-sm dark:bg-neutral-900/65"
                  style={{
                    borderColor: hue,
                    boxShadow: isMe ? `0 0 0 2px ${hue}22` : undefined,
                  }}
                >
                  <p
                    className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em]"
                    style={{ color: hue }}
                  >
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: hue }}
                    />
                    <span>{name} · frozen</span>
                  </p>
                  <p className="whitespace-pre-wrap break-words font-display italic text-sm leading-snug text-neutral-900 dark:text-neutral-50">
                    {entry.feedback}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Wall pile: every wall post saved into a flippable carousel. */}
      {date.wallPile.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
            From the wall · {date.wallPile.length} {date.wallPile.length === 1 ? 'pin' : 'pins'}
          </p>
          <WallPile
            posts={date.wallPile}
            displayNames={displayNames}
            myUserId={myUserId}
          />
        </div>
      )}
      {/* Per-user reflections (date_memory) — side-by-side polaroid columns. */}
      {date.memories.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
            Reflections
          </p>
          <ReflectionColumns
            memories={date.memories}
            displayNames={displayNames}
            myUserId={myUserId}
          />
        </div>
      )}
      {!hasAnyArtefact && (
        <p className="text-sm italic text-neutral-600 dark:text-neutral-400">
          Nothing was captured during this date.
        </p>
      )}
    </div>
  );
}

/**
 * WallPile — flippable polaroid stack. Wall posts (text + photo) from
 * the date's vault are saved into a "pile" you next-through after the
 * date completes. One card on screen at a time with prev/next pills
 * and a small dot indicator.
 */
function WallPile({
  posts,
  displayNames,
  myUserId,
}: {
  posts: ArchivedWallPost[];
  displayNames: Record<string, string>;
  myUserId: string;
}) {
  // Newest pin shown first — feels most natural when looking back.
  const sorted = useMemo(
    () => [...posts].sort((a, b) => b.ts - a.ts),
    [posts],
  );
  const [idx, setIdx] = useState(0);
  const safeIdx = sorted.length === 0 ? 0 : idx % sorted.length;
  const active = sorted[safeIdx];
  if (!active) return null;
  const senderName =
    active.senderId === myUserId
      ? 'you'
      : firstWord(fmtDisplayName(active.senderId, displayNames, myUserId, null));
  const next = () => setIdx((i) => (sorted.length === 0 ? 0 : (i + 1) % sorted.length));
  const prev = () =>
    setIdx((i) => (sorted.length === 0 ? 0 : (i - 1 + sorted.length) % sorted.length));
  return (
    <div className="space-y-2">
      <div
        key={active.postId}
        className="relative mx-auto max-w-md rounded-2xl border border-white/60 bg-white/90 p-3 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/80"
        style={{ transform: `rotate(${(active.ts % 5) - 2}deg)` }}
      >
        {active.attachment && <PolaroidThumb header={active.attachment} />}
        {active.text && (
          <p
            className={`px-1 ${active.attachment ? 'pt-2' : ''} font-display italic text-base leading-snug text-neutral-900 dark:text-neutral-50`}
          >
            {active.attachment ? active.text : <>&ldquo;{active.text}&rdquo;</>}
          </p>
        )}
        <p className="mt-2 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
          {senderName} ·{' '}
          {new Date(active.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </p>
      </div>
      {sorted.length > 1 && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={prev}
            className="rounded-full border border-white/60 bg-white/80 px-3 py-1 font-display italic text-xs text-neutral-800 transition-all hover:scale-[1.04] active:scale-[1.02] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-200"
          >
            ← prev
          </button>
          <div className="flex items-center gap-1">
            {sorted.map((p, i) => (
              <button
                key={p.postId}
                type="button"
                aria-label={`pin ${i + 1} of ${sorted.length}`}
                onClick={() => setIdx(i)}
                className="h-1.5 rounded-full transition-all"
                style={{
                  width: i === safeIdx ? 18 : 6,
                  backgroundColor: i === safeIdx ? 'rgb(244,63,94)' : 'rgba(0,0,0,0.18)',
                }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={next}
            className="rounded-full border border-white/60 bg-white/80 px-3 py-1 font-display italic text-xs text-neutral-800 transition-all hover:scale-[1.04] active:scale-[1.02] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-200"
          >
            next →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Side-by-side per-user reflection columns. Each user gets their own
 * vertical stack of polaroids tinted in their theme hue. Within a
 * column, polaroids render with the photo on top and the user's
 * caption below — a "visual journal" entry.
 */
function ReflectionColumns({
  memories,
  displayNames,
  myUserId,
}: {
  memories: ArchivedMemory[];
  displayNames: Record<string, string>;
  myUserId: string;
}) {
  // Group memories by sender (preserving the natural sort order).
  const grouped = useMemo(() => {
    const map = new Map<string, ArchivedMemory[]>();
    for (const m of memories) {
      const arr = map.get(m.senderId) ?? [];
      arr.push(m);
      map.set(m.senderId, arr);
    }
    return Array.from(map.entries());
  }, [memories]);

  return (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, Math.min(grouped.length, 3))}, minmax(0, 1fr))`,
      }}
    >
      {grouped.map(([senderId, items]) => {
        const hue = hueForUser(senderId);
        const isMe = senderId === myUserId;
        const name = isMe
          ? 'you'
          : firstWord(fmtDisplayName(senderId, displayNames, myUserId, null));
        return (
          <div key={senderId} className="space-y-2">
            <header
              className="flex items-center gap-1.5 rounded-full border bg-white/70 px-2.5 py-0.5 text-[11px] shadow-sm backdrop-blur-md dark:bg-neutral-900/60"
              style={{
                borderColor: hue,
                boxShadow: isMe ? `0 0 0 2px ${hue}33` : undefined,
              }}
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ background: hue }}
              />
              <span className="font-medium text-neutral-900 dark:text-neutral-50">
                {name}&apos;s reflection
              </span>
            </header>
            <ul className="space-y-2">
              {items.map((m) => (
                <li
                  key={m.memoryId}
                  className="space-y-1 rounded-xl border bg-white/90 p-2 shadow-md dark:bg-neutral-900/70"
                  style={{
                    borderColor: `${hue}55`,
                    transform: `rotate(${(m.ts % 5) - 2}deg)`,
                  }}
                >
                  {/* Polaroid: photo on top, caption below. */}
                  {m.attachment && <PolaroidThumb header={m.attachment} />}
                  {m.text && (
                    <p
                      className={`px-0.5 ${m.attachment ? 'pt-1' : ''} font-display italic text-sm leading-snug text-neutral-900 dark:text-neutral-50`}
                    >
                      {m.attachment ? m.text : <>&ldquo;{m.text}&rdquo;</>}
                    </p>
                  )}
                  <p className="px-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-500">
                    {new Date(m.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

export type { RoomEventRecord };
