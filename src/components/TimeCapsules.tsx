'use client';

/**
 * Time Capsules — messages sealed until a future moment.
 *
 * Data model per capsule:
 *   - capsuleId  : client-generated UUID (stable reference for delete)
 *   - authorId   : derived from the envelope's senderId on decrypt
 *   - unlockAt   : epoch ms; the UI hides content until now >= unlockAt
 *   - message    : optional plaintext (trimmed, ≤4000 chars)
 *   - attachment : optional ImageAttachmentHeader (reuses the Messages
 *                  paperclip pipeline — encrypted bytes in Storage, header
 *                  in the event payload)
 *
 * Trust model (UX-enforced, not cryptographic): the payload is decrypted on
 * arrival by every current room member as normal; the "lock" is a renderer
 * choice. Matches Safe Space OTP + Mind Reader — any future "true" time lock
 * would need a second key published at unlockAt.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { displayName } from '@/lib/domain/displayName';
import { describeError } from '@/lib/domain/errors';
import {
  type ImageAttachmentHeader,
  type RoomEvent,
} from '@/lib/domain/events';
import {
  decryptImageAttachment,
  prepareImageForUpload,
} from '@/lib/e2ee-core';
import {
  deleteAttachment,
  downloadAttachment,
  uploadAttachment,
} from '@/lib/supabase/queries';
import { ReactionBar } from './Reactions';
import { useRoom, useRoomProjection } from './RoomProvider';

// ---- Domain types --------------------------------------------------------

interface TimeCapsule {
  capsuleId: string;
  authorId: string;
  createdAt: string;
  unlockAt: number;
  message?: string;
  attachment?: ImageAttachmentHeader;
  /** Underlying blob row id — used as the reaction target once unlocked. */
  recordId: string;
}

// ---- Main component ------------------------------------------------------

export function TimeCapsules() {
  const { appendEvent, myUserId, displayNames } = useRoom();

  const capsules = useRoomProjection<TimeCapsule[]>((acc, rec) => {
    const ev = rec.event;
    if (ev.type === 'time_capsule_post') {
      return [
        ...acc,
        {
          capsuleId: ev.capsuleId,
          authorId: rec.senderId,
          createdAt: rec.createdAt,
          unlockAt: ev.unlockAt,
          message: ev.message,
          attachment: ev.attachment,
          recordId: rec.id,
        },
      ];
    }
    if (ev.type === 'time_capsule_delete') {
      // Only the author can tombstone their own capsule. Filter by match on
      // capsuleId + original senderId.
      return acc.filter((c) => {
        if (c.capsuleId !== ev.capsuleId) return true;
        return c.authorId !== rec.senderId;
      });
    }
    return acc;
  }, [], []);

  // `now` ticks once a second. Effects that depend on now run through the
  // countdown + locked-→-unlocked transition cleanly.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  const { locked, unlocked } = useMemo(() => {
    const l: TimeCapsule[] = [];
    const u: TimeCapsule[] = [];
    for (const c of capsules) {
      if (c.unlockAt > now) l.push(c);
      else u.push(c);
    }
    l.sort((a, b) => a.unlockAt - b.unlockAt);
    u.sort((a, b) => b.unlockAt - a.unlockAt);
    return { locked: l, unlocked: u };
  }, [capsules, now]);

  const [composing, setComposing] = useState(false);

  if (!myUserId) return null;

  return (
    <section className="rounded-2xl border border-white/50 bg-indigo-50/70 p-6 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-indigo-950/40">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-300">
          Time capsules ⏳
        </div>
        {!composing && (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="rounded-full bg-indigo-900 px-3 py-1 text-xs text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] dark:bg-indigo-200 dark:text-indigo-950"
          >
            + new capsule
          </button>
        )}
      </div>

      {composing && (
        <ComposeForm
          onDone={() => setComposing(false)}
          appendEvent={appendEvent}
        />
      )}

      {locked.length === 0 && unlocked.length === 0 && !composing && (
        <p className="mt-3 text-indigo-800/70 dark:text-indigo-200">
          Seal a message for your future selves. Pick a date — the room
          can&apos;t read it until then.
        </p>
      )}

      {locked.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-700 dark:text-indigo-300">
            Sealed
          </h3>
          <ul className="mt-2 space-y-2">
            {locked.map((c) => (
              <LockedCapsule
                key={c.capsuleId}
                capsule={c}
                now={now}
                myUserId={myUserId}
                displayNames={displayNames}
              />
            ))}
          </ul>
        </>
      )}

      {unlocked.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-700 dark:text-indigo-300">
            Open
          </h3>
          <ul className="mt-2 space-y-2">
            {unlocked.map((c) => (
              <UnlockedCapsule
                key={c.capsuleId}
                capsule={c}
                myUserId={myUserId}
                displayNames={displayNames}
                appendEvent={appendEvent}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---- Locked capsule ------------------------------------------------------

function LockedCapsule({
  capsule,
  now,
  myUserId,
  displayNames,
}: {
  capsule: TimeCapsule;
  now: number;
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const remaining = capsule.unlockAt - now;
  const isAuthor = capsule.authorId === myUserId;
  const authorLabel = displayName(capsule.authorId, displayNames, myUserId);
  const unlockDate = new Date(capsule.unlockAt);

  return (
    <li className="rounded-2xl border border-indigo-300/50 bg-gradient-to-br from-indigo-100/80 via-violet-50/80 to-pink-50/80 p-4 shadow-md backdrop-blur-md dark:border-indigo-800/50 dark:from-indigo-950/60 dark:via-violet-950/50 dark:to-pink-950/40">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-900/10 text-lg dark:bg-white/10"
          >
            🔒
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-indigo-900 dark:text-indigo-100">
              Sealed{' '}
              {isAuthor ? 'by you' : `by ${authorLabel}`}
            </p>
            <p className="text-[10px] text-indigo-700/70 dark:text-indigo-200">
              Opens {formatAbsolute(unlockDate)}
            </p>
          </div>
        </div>
        <Countdown remaining={remaining} />
      </div>

      {isAuthor && (
        <p className="mt-3 text-[11px] italic text-indigo-700/70 dark:text-indigo-200">
          You can see what&apos;s inside because you wrote it. Partners see
          only the countdown.
        </p>
      )}
    </li>
  );
}

function Countdown({ remaining }: { remaining: number }) {
  const { label, tone } = formatCountdown(remaining);
  return (
    <div
      className={`flex-shrink-0 rounded-full px-3 py-1.5 text-center font-mono text-xs tabular-nums shadow-sm ${tone}`}
      role="timer"
      aria-live="off"
      aria-label={`unlocks in ${label}`}
    >
      {label}
    </div>
  );
}

// ---- Unlocked capsule ----------------------------------------------------

function UnlockedCapsule({
  capsule,
  myUserId,
  displayNames,
  appendEvent,
}: {
  capsule: TimeCapsule;
  myUserId: string;
  displayNames: Record<string, string>;
  appendEvent: (e: RoomEvent) => Promise<void>;
}) {
  const isAuthor = capsule.authorId === myUserId;
  const authorLabel = displayName(capsule.authorId, displayNames, myUserId);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!isAuthor) return;
    if (!confirm('Delete this capsule for everyone?')) return;
    setDeleting(true);
    try {
      await appendEvent({
        type: 'time_capsule_delete',
        capsuleId: capsule.capsuleId,
        ts: Date.now(),
      });
    } catch {
      setDeleting(false);
    }
  }

  return (
    <li className="rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-700/70 dark:text-indigo-200">
        <span>
          {isAuthor ? 'from you' : `from ${authorLabel}`} · opened{' '}
          {formatAbsolute(new Date(capsule.unlockAt))}
        </span>
        {isAuthor && (
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            aria-label="delete capsule"
            className="rounded-full px-2 py-0.5 text-[10px] text-neutral-500 hover:bg-red-500/10 hover:text-red-700 disabled:opacity-40"
          >
            delete
          </button>
        )}
      </div>
      {capsule.attachment && (
        <div className="mt-2">
          <EncryptedImage header={capsule.attachment} />
        </div>
      )}
      {capsule.message && (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200">
          {capsule.message}
        </p>
      )}
      {!capsule.recordId.startsWith('temp-') && (
        <ReactionBar targetId={capsule.recordId} />
      )}
    </li>
  );
}

// ---- Encrypted image display --------------------------------------------

function EncryptedImage({ header }: { header: ImageAttachmentHeader }) {
  const { room, roomKey } = useRoom();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!room || !roomKey) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
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
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [room, roomKey, header.blobId, header.mime]);

  const aspectRatio = header.w / Math.max(1, header.h);
  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{ aspectRatio: `${aspectRatio}` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={objectUrl ?? header.placeholder}
        alt="capsule attachment"
        className={`h-full w-full object-cover transition-[filter] duration-300 ${
          objectUrl ? '' : 'blur-sm'
        }`}
      />
      {error && (
        <p className="mt-1 text-[10px] text-red-600 dark:text-red-400">
          decrypt failed: {error}
        </p>
      )}
    </div>
  );
}

// ---- Compose form --------------------------------------------------------

const PRESETS: { label: string; ms: number }[] = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '1 month', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: '1 year', ms: 365 * 24 * 60 * 60 * 1000 },
];

function ComposeForm({
  onDone,
  appendEvent,
}: {
  onDone: () => void;
  appendEvent: (e: RoomEvent) => Promise<void>;
}) {
  const { room, roomKey } = useRoom();
  const [message, setMessage] = useState('');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Default unlock = tomorrow at the same wall-clock time.
  const [unlockAt, setUnlockAt] = useState<number>(
    () => Date.now() + 24 * 60 * 60 * 1000,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pickedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pickedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pickedFile]);

  function applyPreset(offsetMs: number) {
    setUnlockAt(Date.now() + offsetMs);
  }

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setPickedFile(f);
    e.target.value = '';
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed && !pickedFile) {
      setError('Add a message or a photo before sealing.');
      return;
    }
    if (unlockAt <= Date.now()) {
      setError('Unlock time must be in the future.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let attachment: ImageAttachmentHeader | undefined;
      if (pickedFile) {
        if (!room || !roomKey) throw new Error('room not ready');
        const blobId = crypto.randomUUID();
        const { encryptedBytes, header } = await prepareImageForUpload({
          file: pickedFile,
          roomKey,
          roomId: room.id,
          blobId,
        });
        await uploadAttachment({ roomId: room.id, blobId, encryptedBytes });
        attachment = {
          type: 'image',
          blobId,
          mime: header.mime,
          w: header.w,
          h: header.h,
          byteLen: header.byteLen,
          placeholder: header.placeholder,
        };
        try {
          await appendEvent({
            type: 'time_capsule_post',
            capsuleId: crypto.randomUUID(),
            unlockAt,
            message: trimmed || undefined,
            attachment,
            ts: Date.now(),
          });
        } catch (sendErr) {
          await deleteAttachment({ roomId: room.id, blobId }).catch(() => {});
          throw sendErr;
        }
      } else {
        await appendEvent({
          type: 'time_capsule_post',
          capsuleId: crypto.randomUUID(),
          unlockAt,
          message: trimmed,
          ts: Date.now(),
        });
      }
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 space-y-3 rounded-xl border border-indigo-200/60 bg-white/80 p-3 shadow-sm backdrop-blur-md dark:border-indigo-800/50 dark:bg-neutral-900/70"
    >
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, 4000))}
        placeholder="a note for your future selves…"
        rows={4}
        maxLength={4000}
        className="block w-full rounded-lg border border-indigo-200 bg-white/70 px-2 py-1 text-sm placeholder:italic placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-indigo-800 dark:bg-neutral-950/60"
      />

      {pickedFile && previewUrl && (
        <div className="relative inline-block max-w-[160px] overflow-hidden rounded-lg border border-white/60 shadow-sm dark:border-white/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="capsule preview" className="max-h-32" />
          <button
            type="button"
            onClick={() => setPickedFile(null)}
            aria-label="remove attachment"
            className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
          >
            <span className="block h-3 w-3 leading-none">×</span>
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="rounded-full border border-indigo-300 px-2.5 py-1 text-[11px] text-indigo-900 transition-colors hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-200 dark:hover:bg-indigo-950/50"
        >
          + photo
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handlePick}
          className="hidden"
        />
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-700 dark:text-indigo-300">
          Opens
        </p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.ms)}
              className="rounded-full border border-indigo-200 bg-white/70 px-2.5 py-1 text-[11px] text-indigo-900 transition-colors hover:bg-white/90 dark:border-indigo-800 dark:bg-neutral-900/60 dark:text-indigo-200"
            >
              +{p.label}
            </button>
          ))}
        </div>
        <input
          type="datetime-local"
          value={toInputValue(unlockAt)}
          onChange={(e) => setUnlockAt(parseInputValue(e.target.value))}
          className="mt-2 block w-full rounded-lg border border-indigo-200 bg-white/70 px-2 py-1 text-sm dark:border-indigo-800 dark:bg-neutral-950/60"
          aria-label="unlock time"
        />
        <p className="mt-1 text-[10px] text-indigo-700/70 dark:text-indigo-200">
          Unlocks at {formatAbsolute(new Date(unlockAt))} on every member&apos;s
          device.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-full bg-indigo-900 px-4 py-1.5 text-xs text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 dark:bg-indigo-200 dark:text-indigo-950"
        >
          {busy ? 'sealing…' : 'seal capsule'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="rounded-full border border-indigo-200 px-4 py-1.5 text-xs text-indigo-900 transition-colors hover:bg-white/80 disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-200"
        >
          cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

// ---- Helpers -------------------------------------------------------------

function formatCountdown(remainingMs: number): {
  label: string;
  tone: string;
} {
  const m = Math.max(0, remainingMs);
  const s = Math.floor(m / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  // Tone shifts as time grows short — quietly urgent in the last hour.
  const tone =
    m <= 60_000
      ? 'bg-rose-100 text-rose-900 dark:bg-rose-900/70 dark:text-rose-100'
      : m <= 3_600_000
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100'
        : 'bg-indigo-900/10 text-indigo-900 dark:bg-white/10 dark:text-indigo-100';

  let label: string;
  if (days > 0) label = `${days}d ${hours}h`;
  else if (hours > 0) label = `${hours}h ${minutes}m`;
  else if (minutes > 0) label = `${minutes}m ${seconds}s`;
  else label = `${seconds}s`;
  return { label, tone };
}

function formatAbsolute(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Convert epoch ms → the value a <input type="datetime-local"> expects
 *  (YYYY-MM-DDTHH:mm in local time). */
function toInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function parseInputValue(v: string): number {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}
