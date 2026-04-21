'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { displayName } from '@/lib/domain/displayName';
import { describeError } from '@/lib/domain/errors';
import { ReactionBar } from './Reactions';
import {
  useRoomCore,
  useRoomEvents,
  type RoomEventRecord,
  type RoomBlobFailure,
} from './RoomProvider';
import { SectionHeader } from './design/SectionHeader';
import {
  decryptImageAttachment,
  prepareImageForUpload,
} from '@/lib/e2ee-core';
import {
  deleteAttachment,
  downloadAttachment,
  uploadAttachment,
} from '@/lib/supabase/queries';
import type { RoomEvent } from '@/lib/domain/events';

export function Messages() {
  const { events, failures } = useRoomEvents();
  const { myUserId, displayNames, memberEmojis } = useRoomCore();

  const { messages, deletedIds } = useMemo(() => {
    const deletes = new Map<string, string>();
    for (const rec of events) {
      if (rec.event.type === 'message_delete') {
        deletes.set(rec.event.messageId, rec.senderId);
      }
    }
    const out: RoomEventRecord[] = [];
    const dropped = new Set<string>();
    for (const rec of events) {
      if (rec.event.type !== 'message') continue;
      const mid = rec.event.messageId;
      if (mid && deletes.get(mid) === rec.senderId) {
        dropped.add(mid);
        continue;
      }
      out.push(rec);
    }
    return { messages: out, deletedIds: dropped };
  }, [events]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevCountRef.current = messages.length;
  }, [messages.length]);

  if (!myUserId) return null;

  return (
    <section className="space-y-2 rounded-2xl border border-white/50 bg-white/60 p-5 shadow-xl backdrop-blur-md sm:p-6 dark:border-white/10 dark:bg-neutral-900/50">
      <SectionHeader label="VibeChat" emoji="💬" />
      {/* iMessage-style feed inside the section card: bubbles grouped
          by sender with tails on the last bubble in a group. */}
      {messages.length === 0 && failures.length === 0 && deletedIds.size === 0 && (
        <p className="px-4 py-8 text-center text-sm text-neutral-500">
          No messages yet — say hi 👋
        </p>
      )}
      {(messages.length > 0 || failures.length > 0) && (
        <div
          ref={scrollRef}
          className="max-h-[460px] overflow-y-auto px-2 py-3"
        >
          <ul className="space-y-[2px]">
            <AnimatePresence mode="popLayout" initial={false}>
              {messages.map((rec, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                const next = i < messages.length - 1 ? messages[i + 1] : null;
                // Group by sender + 60s timestamp gap, iMessage-style.
                const prevTs = prev ? new Date(prev.createdAt).getTime() : 0;
                const curTs = new Date(rec.createdAt).getTime();
                const sameSenderAsPrev =
                  !!prev && prev.senderId === rec.senderId && curTs - prevTs < 60_000;
                const nextTs = next ? new Date(next.createdAt).getTime() : Infinity;
                const sameSenderAsNext =
                  !!next && next.senderId === rec.senderId && nextTs - curTs < 60_000;
                return (
                  <MessageRow
                    key={rec.id}
                    rec={rec}
                    selfUserId={myUserId}
                    displayNames={displayNames}
                    memberEmojis={memberEmojis}
                    isFirstInGroup={!sameSenderAsPrev}
                    isLastInGroup={!sameSenderAsNext}
                  />
                );
              })}
            </AnimatePresence>
            {failures.map((f) => (
              <FailureRow
                key={f.id}
                failure={f}
                displayNames={displayNames}
                myUserId={myUserId}
              />
            ))}
          </ul>
        </div>
      )}
      <Composer />
    </section>
  );
}

function MessageRow({
  rec,
  selfUserId,
  displayNames,
  memberEmojis,
  isFirstInGroup,
  isLastInGroup,
}: {
  rec: RoomEventRecord;
  selfUserId: string;
  displayNames: Record<string, string>;
  memberEmojis: Record<string, string>;
  /** True when this message starts a new sender-group (or starts the
   *  feed). Drives whether we show the partner's name header above. */
  isFirstInGroup: boolean;
  /** True when this message ends a sender-group (next message is from
   *  someone else, or there's a big timestamp gap, or it's the last
   *  message in the feed). Drives the bubble "tail" (flattened corner
   *  on the sender's side) and whether we show a timestamp below. */
  isLastInGroup: boolean;
}) {
  const { appendEvent } = useRoomCore();
  const [deleting, setDeleting] = useState(false);

  if (rec.event.type !== 'message') return null;
  const isSelf = rec.senderId === selfUserId;
  const messageId = rec.event.messageId;
  const attachment = rec.event.attachment;
  const canDelete = isSelf && !!messageId;

  async function handleDelete() {
    if (!messageId) return;
    setDeleting(true);
    try {
      await appendEvent({
        type: 'message_delete',
        messageId,
        ts: Date.now(),
      });
    } catch {
      setDeleting(false);
    }
  }

  // iMessage tail: the bottom corner on the SENDER's side flattens on
  // the last bubble in a group so the bubble reads as having a pointer.
  // All other corners stay rounded. Each bubble's full radius is 20px.
  const bubbleRadius = {
    borderRadius: '20px',
    ...(isLastInGroup && isSelf
      ? { borderBottomRightRadius: '6px' }
      : isLastInGroup
        ? { borderBottomLeftRadius: '6px' }
        : {}),
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.88, filter: 'blur(6px)' }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className={`group relative flex flex-col ${
        isSelf ? 'items-end' : 'items-start'
      } ${isFirstInGroup ? 'mt-2' : ''}`}
    >
      {/* Partner-only: emoji + name header above the first bubble in a
          group. Emoji sits inline with the name as a small avatar. */}
      {!isSelf && isFirstInGroup && (
        <span className="mb-1 ml-3 flex items-center gap-1.5 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
          {memberEmojis[rec.senderId] && (
            <span aria-hidden className="text-sm leading-none">
              {memberEmojis[rec.senderId]}
            </span>
          )}
          {displayName(rec.senderId, displayNames, selfUserId)}
        </span>
      )}

      <div
        className={`relative max-w-[78%] px-3.5 py-2 text-[15px] leading-[1.35] ${
          isSelf
            ? 'text-white'
            : 'text-neutral-900 dark:text-neutral-100'
        }`}
        style={{
          ...bubbleRadius,
          background: isSelf
            ? 'linear-gradient(to bottom, #3b9bff 0%, #0a7ff2 100%)'
            : 'rgba(255, 247, 235, 0.9)',
          boxShadow: isSelf
            ? '0 1px 2px rgba(10, 127, 242, 0.18)'
            : '0 1px 2px rgba(31, 26, 22, 0.08), inset 0 1px 0 rgba(255,255,255,0.5)',
          backdropFilter: isSelf ? undefined : 'blur(10px)',
          WebkitBackdropFilter: isSelf ? undefined : 'blur(10px)',
        }}
      >
        <ParticleDissolve />
        {attachment && (
          <div className="-mx-3.5 -mt-2 mb-2 overflow-hidden" style={{ borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
            <ImageAttachment header={attachment} />
          </div>
        )}
        {rec.event.text && (
          <p className="whitespace-pre-wrap break-words">{rec.event.text}</p>
        )}

        {canDelete && (
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            aria-label="delete this message"
            title="delete this message"
            className={`absolute -right-1 -top-1 rounded-full p-1 opacity-0 shadow-sm transition-opacity hover:bg-red-500/20 focus:opacity-100 group-hover:opacity-100 disabled:opacity-40 ${
              isSelf ? 'bg-sky-600 text-white' : 'bg-white text-neutral-500'
            }`}
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {/* Reactions sit just under the bubble, aligned to the sender side. */}
      {!rec.id.startsWith('temp-') && (
        <div
          className={`mt-0.5 ${isSelf ? 'self-end' : 'self-start'}`}
          style={isSelf ? { marginRight: 8 } : { marginLeft: 8 }}
        >
          <ReactionBar targetId={rec.id} />
        </div>
      )}

      {/* Timestamp only at the end of a group (iMessage-style). */}
      {isLastInGroup && (
        <span
          className={`mt-1 text-[10px] text-neutral-500 dark:text-neutral-300 ${
            isSelf ? 'mr-3' : 'ml-3'
          }`}
        >
          {new Date(rec.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
      )}
    </motion.li>
  );
}

/**
 * ParticleDissolve — sibling of the message row's content. Renders nothing
 * while the row is mounted. When the row exits (deletion), useIsPresent flips
 * to false and we spawn a cloud of small dots that drift outward and fade.
 * Deterministic angles + distances per index so the dust looks the same on
 * every delete (no jitter from per-render randomness).
 */
function ParticleDissolve({ count = 12 }: { count?: number }) {
  const isPresent = useIsPresent();
  if (isPresent) return null;
  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const angle = (i / count) * Math.PI * 2 + (i % 3) * 0.4;
        const dist = 36 + (i % 5) * 14;
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist - 12;
        const size = 2 + (i % 4);
        const duration = 0.45 + (i % 3) * 0.08;
        return (
          <motion.span
            key={i}
            aria-hidden
            initial={{ x: 0, y: 0, opacity: 0.85, scale: 1 }}
            animate={{ x, y, opacity: 0, scale: 0.3 }}
            transition={{ duration, ease: 'easeOut' }}
            className="pointer-events-none absolute left-1/2 top-1/2 rounded-full bg-current"
            style={{
              width: size,
              height: size,
              marginLeft: -size / 2,
              marginTop: -size / 2,
            }}
          />
        );
      })}
    </>
  );
}

function ImageAttachment({
  header,
}: {
  header: NonNullable<Extract<RoomEvent, { type: 'message' }>['attachment']>;
}) {
  const { room, roomKey } = useRoomCore();
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

  // Reserve the correct aspect ratio so the feed doesn't jump when the
  // decrypted image swaps in.
  const aspectRatio = header.w / Math.max(1, header.h);

  return (
    <div
      className="mb-2 overflow-hidden rounded-lg"
      style={{ aspectRatio: `${aspectRatio}` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={objectUrl ?? header.placeholder}
        alt="attachment"
        className={`h-full w-full object-cover ${
          objectUrl ? '' : 'blur-sm'
        } transition-[filter] duration-300`}
      />
      {error && (
        <p className="mt-1 text-[10px] text-red-600 dark:text-red-400">
          attachment decrypt failed: {error}
        </p>
      )}
    </div>
  );
}

function FailureRow({
  failure,
  displayNames,
  myUserId,
}: {
  failure: RoomBlobFailure;
  displayNames: Record<string, string>;
  myUserId: string | null;
}) {
  return (
    <li className="rounded-xl border border-red-300/60 bg-red-50/70 px-5 py-3 text-sm shadow-sm backdrop-blur-md dark:border-red-900/40 dark:bg-red-950/40">
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wide">
        <span>{displayName(failure.senderId, displayNames, myUserId)} · ✗ invalid</span>
        <span className="font-normal">{new Date(failure.createdAt).toLocaleTimeString()}</span>
      </div>
      <p className="text-sm leading-relaxed text-red-700 dark:text-red-300">error: {failure.error}</p>
    </li>
  );
}

function Composer() {
  const { room, roomKey, appendEvent } = useRoomCore();
  const [text, setText] = useState('');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pickedFile) return;
    const url = URL.createObjectURL(pickedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pickedFile]);

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setPickedFile(f);
    // Reset input so the user can pick the same file twice in a row.
    e.target.value = '';
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !pickedFile) return;
    setBusy(true);
    setError(null);
    try {
      let attachmentHeader: Extract<RoomEvent, { type: 'message' }>['attachment'];
      if (pickedFile) {
        if (!room || !roomKey) throw new Error('room not ready');
        const blobId = crypto.randomUUID();
        const { encryptedBytes, header } = await prepareImageForUpload({
          file: pickedFile,
          roomKey,
          roomId: room.id,
          blobId,
        });
        try {
          await uploadAttachment({
            roomId: room.id,
            blobId,
            encryptedBytes,
          });
        } catch (uploadErr) {
          throw uploadErr;
        }
        attachmentHeader = {
          type: 'image',
          blobId,
          mime: header.mime,
          w: header.w,
          h: header.h,
          byteLen: header.byteLen,
          placeholder: header.placeholder,
        };
        // If the outer appendEvent fails below, roll back the uploaded
        // object so Storage doesn't accumulate orphans.
        try {
          await appendEvent({
            type: 'message',
            messageId: crypto.randomUUID(),
            text,
            attachment: attachmentHeader,
            ts: Date.now(),
          });
        } catch (sendErr) {
          await deleteAttachment({ roomId: room.id, blobId }).catch(() => {});
          throw sendErr;
        }
      } else {
        await appendEvent({
          type: 'message',
          messageId: crypto.randomUUID(),
          text,
          ts: Date.now(),
        });
      }
      setText('');
      setPickedFile(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const canSend = !busy && (text.trim().length > 0 || !!pickedFile);

  return (
    <form onSubmit={send} className="space-y-2 px-2 pb-2">
      {pickedFile && previewUrl && (
        <div className="relative ml-10 inline-block max-w-[160px] overflow-hidden rounded-2xl border border-white/60 shadow-sm dark:border-white/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="preview" className="max-h-32" />
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
      <div className="flex items-end gap-2">
        {/* Attach button — circle-in-pill like iMessage's plus */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label="attach image"
          title="attach image"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-neutral-200/80 text-neutral-600 transition-colors hover:bg-neutral-300/80 hover:text-neutral-900 disabled:opacity-50 dark:bg-neutral-800/80 dark:text-neutral-300 dark:hover:bg-neutral-700/80"
        >
          <PaperclipIcon />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handlePick}
          className="hidden"
        />

        {/* Pill input — grows with content, stays rounded. Wrapped in a
            container so the circular send button can sit to the right
            of the pill and match its height. */}
        <div
          className="flex min-h-[36px] flex-1 items-center rounded-full border border-neutral-300/80 bg-white/80 pl-4 pr-1 shadow-sm backdrop-blur-md dark:border-neutral-700/80 dark:bg-neutral-900/70"
        >
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={pickedFile ? 'Add a caption…' : 'VibeChat'}
            className="flex-1 bg-transparent py-1.5 text-[15px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100"
          />
          {/* Send — circular arrow-up, appears when there's content */}
          <button
            type="submit"
            disabled={!canSend}
            aria-label="send message"
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-all duration-150 ${
              canSend
                ? 'scale-100 opacity-100 hover:brightness-110 active:scale-95'
                : 'scale-75 opacity-0 pointer-events-none'
            }`}
            style={{
              background: 'linear-gradient(to bottom, #3b9bff 0%, #0a7ff2 100%)',
              color: 'white',
              boxShadow: '0 1px 2px rgba(10, 127, 242, 0.3)',
            }}
          >
            <SendArrowIcon />
          </button>
        </div>
      </div>
      {error && <p className="px-3 text-xs text-red-600">{error}</p>}
    </form>
  );
}

function SendArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="h-3.5 w-3.5">
      <path d="M8 13V3M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
      className="h-3.5 w-3.5"
    >
      <path d="M3 4h10M6 4V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V4M4.5 4l.5 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
      className="h-4 w-4"
    >
      <path
        d="M10.5 4.5v6a2.5 2.5 0 01-5 0v-7a1.5 1.5 0 013 0v6a.5.5 0 01-1 0v-5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
