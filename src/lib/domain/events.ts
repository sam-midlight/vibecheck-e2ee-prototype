/**
 * Typed room-event schemas.
 *
 * Every encrypted blob in V2 carries a `{ type, ... }` payload. The schemas
 * below are the canonical shape for each feature's events. `RoomEventSchema`
 * is the discriminated union used at the decrypt boundary — zod-parsing
 * there guarantees feature code never sees malformed payloads, even if an
 * attacker could somehow forge a signed blob (they can't, but defense-in-
 * depth is cheap here).
 *
 * Adding a feature = add its event schema(s) here, add it to the union, then
 * write a small projection hook that reduces the event stream into feature
 * state.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Feature: plain message (kept from prototype for backwards feel)
// ---------------------------------------------------------------------------

/**
 * Optional encrypted-image attachment header attached to a `message` event.
 * The ciphertext itself lives in the `room-attachments` Storage bucket at
 * `{roomId}/{blobId}.bin` — this header carries the plaintext metadata the
 * renderer needs (mime, dimensions, inline blur placeholder) and the
 * `blobId` that names the storage object. Keyed to the SAME blobId as the
 * outer blob row so the AD binding in attachment.ts is reproducible.
 */
export const ImageAttachmentHeaderSchema = z.object({
  type: z.literal('image'),
  blobId: z.string().uuid(),
  mime: z.enum(['image/webp', 'image/jpeg']),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  byteLen: z.number().int().nonnegative(),
  placeholder: z.string(), // data URL, ~1–3 KB
});

export type ImageAttachmentHeader = z.infer<typeof ImageAttachmentHeaderSchema>;

export const MessageEventSchema = z.object({
  type: z.literal('message'),
  // Client-generated per-message ID. Optional so historical messages written
  // before this field existed still parse. Only messages that carry a
  // messageId can be tombstoned via `message_delete`.
  messageId: z.string().uuid().optional(),
  text: z.string(),
  attachment: ImageAttachmentHeaderSchema.optional(),
  ts: z.number(),
});

// Tombstone: author-only soft-delete of a prior message. Reducer drops any
// message whose `messageId` matches a delete authored by the original sender.
export const MessageDeleteEventSchema = z.object({
  type: z.literal('message_delete'),
  messageId: z.string().uuid(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Therapy Homework (latest-wins; empty text clears)
// ---------------------------------------------------------------------------

export const HomeworkSetEventSchema = z.object({
  type: z.literal('homework_set'),
  text: z.string(),            // empty string = cleared
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Love Tank (per-user 0–100 level + optional "actionable needs"
// breakdown of the remaining empty percentage, latest-wins per sender).
//
// The `needs` map lets each member allocate the empty portion of their tank
// across the 5 love-language categories. Invariant (enforced by UI + the
// projection reducer): level + Σ(needs) ≤ 100. We don't reject malformed
// values at parse time — the reducer clamps on read so legacy / forward-
// compat payloads still project.
// ---------------------------------------------------------------------------

export const LOVE_LANGUAGES = [
  'quality_time',
  'physical_affection',
  'words_of_affirmation',
  'acts_of_service',
  'gifts',
] as const;
export type LoveLanguage = (typeof LOVE_LANGUAGES)[number];

export const LoveTankSetEventSchema = z.object({
  type: z.literal('love_tank_set'),
  level: z.number().int().min(0).max(100),
  needs: z
    .record(z.enum(LOVE_LANGUAGES), z.number().int().min(0).max(100))
    .optional(),
  note: z.string().max(140).optional(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Wishlist (add/claim/delete; author-owned, claim is one-way)
// ---------------------------------------------------------------------------

export const WISHLIST_CATEGORIES = [
  'gift',
  'experience',
  'food',
  'activity',
  'other',
] as const;

export const WishlistAddEventSchema = z.object({
  type: z.literal('wishlist_add'),
  itemId: z.string().uuid(),            // client-generated; referenced by claim/delete
  title: z.string().min(1).max(200),
  notes: z.string().max(1000).optional(),
  category: z.enum(WISHLIST_CATEGORIES),
  ts: z.number(),
});

export const WishlistClaimEventSchema = z.object({
  type: z.literal('wishlist_claim'),
  itemId: z.string().uuid(),
  ts: z.number(),
});

export const WishlistDeleteEventSchema = z.object({
  type: z.literal('wishlist_delete'),
  itemId: z.string().uuid(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Vibe Sliders
//   slider_define — any user may define a slider (room-shared). Latest
//     definition by sliderId wins.
//   slider_set    — each member publishes their own value 0–100; latest-wins
//     per (sliderId, senderId).
// ---------------------------------------------------------------------------

/** Vibe-state dimension a slider participates in. Drives the
 *  vector-based oracle: per-dimension scores combine into a 3D vibe
 *  vector that maps to a named state. Missing on legacy events;
 *  parseRoomEvent backfills via title keyword. */
export const SLIDER_DIMENSIONS = ['physical', 'emotional', 'social'] as const;
export type SliderDimension = (typeof SLIDER_DIMENSIONS)[number];

/** "normal": high = good (Energy, Mood). "inverted": high = bad
 *  (Hunger, Anxiety, Stress). Polarity-adjusted score is used in
 *  vibe-state math so all sliders combine on the same axis. */
export const SLIDER_POLARITIES = ['normal', 'inverted'] as const;
export type SliderPolarity = (typeof SLIDER_POLARITIES)[number];

export const SliderDefineEventSchema = z.object({
  type: z.literal('slider_define'),
  sliderId: z.string().uuid(),
  title: z.string().min(1).max(60),
  leftLabel: z.string().max(30),
  rightLabel: z.string().max(30),
  emoji: z.string().max(8),
  /** Optional. When missing on legacy events, the projection layer
   *  derives a sensible default from the title keyword. */
  dimension: z.enum(SLIDER_DIMENSIONS).optional(),
  /** Optional. Defaults to 'normal' when absent. Inverted sliders
   *  (Hunger, Anxiety) flip the polarity in vibe-state math. */
  polarity: z.enum(SLIDER_POLARITIES).optional(),
  ts: z.number(),
});

export const SliderSetEventSchema = z.object({
  type: z.literal('slider_set'),
  sliderId: z.string().uuid(),
  value: z.number().int().min(0).max(100),
  note: z.string().max(140).optional(),
  ts: z.number(),
});

export const SliderDeleteEventSchema = z.object({
  type: z.literal('slider_delete'),
  sliderId: z.string().uuid(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Gratitude (append-only; 1–5 hearts + optional message)
// ---------------------------------------------------------------------------

export const GratitudeSendEventSchema = z.object({
  type: z.literal('gratitude_send'),
  to: z.string().uuid(),                // recipient's userId
  amount: z.number().int().min(1).max(5),
  message: z.string().max(500),         // empty string is fine
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Dates (idea bank + voting + scheduling + completion)
// ---------------------------------------------------------------------------

export const DATE_ENERGIES = ['low', 'medium', 'high'] as const;
export type DateEnergy = (typeof DATE_ENERGIES)[number];

export const DateIdeaAddEventSchema = z.object({
  type: z.literal('date_idea_add'),
  ideaId: z.string().uuid(),
  title: z.string().min(1).max(200),
  energy: z.enum(DATE_ENERGIES),
  /** Optional list of user_ids the idea is "for". Empty/missing means
   *  the whole room — back-compat with pre-targeting events. The match
   *  state is reached when every invited user has voted yes. */
  invitedUserIds: z.array(z.string().uuid()).optional(),
  ts: z.number(),
});

/**
 * Update the invited-guest list for an existing date without
 *  modifying the rest of the idea. Latest-ts wins. Used by the
 *  vault's "Manage Guests" UI so the date-room can re-roster
 *  independently of the main room's membership.
 */
export const DateInviteUpdateEventSchema = z.object({
  type: z.literal('date_invite_update'),
  ideaId: z.string().uuid(),
  /** Empty array means "open to whole room" (clears prior targeting). */
  invitedUserIds: z.array(z.string().uuid()),
  ts: z.number(),
});

export const DateIdeaVoteEventSchema = z.object({
  type: z.literal('date_idea_vote'),
  ideaId: z.string().uuid(),
  ts: z.number(),
});

export const DateIdeaUnvoteEventSchema = z.object({
  type: z.literal('date_idea_unvote'),
  ideaId: z.string().uuid(),
  ts: z.number(),
});

export const DateIdeaScheduleEventSchema = z.object({
  type: z.literal('date_idea_schedule'),
  ideaId: z.string().uuid(),
  scheduledAt: z.string(),              // ISO datetime string
  ts: z.number(),
});

export const DateIdeaCompleteEventSchema = z.object({
  type: z.literal('date_idea_complete'),
  ideaId: z.string().uuid(),
  feedback: z.string().max(1000),       // empty OK
  ts: z.number(),
});

export const DateIdeaDeleteEventSchema = z.object({
  type: z.literal('date_idea_delete'),
  ideaId: z.string().uuid(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Mind Reader (post a hint + secret keyword + thought; guess to reveal)
//
// Note on secrecy: everyone in the room decrypts every blob, so the
// "keyword" and "thought" fields in a post event are technically readable
// by all members. The game's mechanic is enforced by the UI, which hides
// those fields from non-authors until a solve event matches the keyword.
// Same trust model as V1 — acceptable in a couples/trusted-partners app.
// ---------------------------------------------------------------------------

export const MindReaderPostEventSchema = z.object({
  type: z.literal('mind_reader_post'),
  gameId: z.string().uuid(),
  hint: z.string().min(1).max(500),
  keyword: z.string().min(1).max(100),
  thought: z.string().min(1).max(2000),
  ts: z.number(),
});

export const MindReaderSolveEventSchema = z.object({
  type: z.literal('mind_reader_solve'),
  gameId: z.string().uuid(),
  guess: z.string().min(1).max(100),
  ts: z.number(),
});

export const MindReaderDeleteEventSchema = z.object({
  type: z.literal('mind_reader_delete'),
  gameId: z.string().uuid(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Safe Space + Time-Out
//
// Safe Space lets one member post sensitive content behind an OTP gate. The
// other member must enter the OTP to unlock; both then acknowledge and
// resolve independently (dual-confirm).
//
// Time-Out is a room-wide clinical lockout (default 20 min). While active,
// Safe Space posting and unlocking are disabled.
//
// Like Mind Reader, the OTP sits in the encrypted blob alongside the content
// and is visible to all members on decrypt — the gate is UX-enforced, not
// cryptographic. Same trust model.
// ---------------------------------------------------------------------------

export const IcebreakerPostEventSchema = z.object({
  type: z.literal('icebreaker_post'),
  entryId: z.string().uuid(),
  content: z.string().min(1).max(4000),
  otp: z.string().regex(/^\d{4}$/),       // four digits
  ts: z.number(),
});

export const IcebreakerUnlockEventSchema = z.object({
  type: z.literal('icebreaker_unlock'),
  entryId: z.string().uuid(),
  otp: z.string().regex(/^\d{4}$/),
  ts: z.number(),
});

export const IcebreakerAckEventSchema = z.object({
  type: z.literal('icebreaker_ack'),
  entryId: z.string().uuid(),
  ts: z.number(),
});

// Non-author signals they have processed the entry and are ready to
// discuss it out loud. Emitted by the receiving partner only.
export const IcebreakerReadyToTalkEventSchema = z.object({
  type: z.literal('icebreaker_ready_to_talk'),
  entryId: z.string().uuid(),
  ts: z.number(),
});

export const IcebreakerResolveEventSchema = z.object({
  type: z.literal('icebreaker_resolve'),
  entryId: z.string().uuid(),
  ts: z.number(),
});

// Author-only tombstone: soft-deletes a prior safe-space post. The
// reducer drops any entry whose authorId matches a delete event's
// senderId. Mirrors the message_delete / mind_reader_delete pattern.
export const IcebreakerDeleteEventSchema = z.object({
  type: z.literal('icebreaker_delete'),
  entryId: z.string().uuid(),
  ts: z.number(),
});

export const TimeOutStartEventSchema = z.object({
  type: z.literal('time_out_start'),
  durationSeconds: z.number().int().positive().max(60 * 60 * 24),
  ts: z.number(),
});

export const TimeOutEndEventSchema = z.object({
  type: z.literal('time_out_end'),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Room rename
//
// The server stores `kind`, `current_generation`, `parent_room_id`, etc. —
// but never a room display name (names can leak metadata about the
// relationship). The human-readable name lives purely in the encrypted
// event stream; latest-wins by ts. Empty string reverts to the default
// "Room {id8}" rendering.
// ---------------------------------------------------------------------------

export const RoomRenameEventSchema = z.object({
  type: z.literal('room_rename'),
  name: z.string().max(100),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Per-user display name (per-room, scoped to the event stream)
//
// Each member may set their own display name within a room. Latest-wins
// per sender. Empty string clears (falls back to the UUID prefix).
// Reducer enforces "only you can set your own name" — everyone sees it via
// the senderId of the `display_name_set` event.
// ---------------------------------------------------------------------------

export const DisplayNameSetEventSchema = z.object({
  type: z.literal('display_name_set'),
  name: z.string().max(60),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Per-member Room Avatar (emoji + optional nickname override)
//
// Each member may publish an emoji as their "room avatar" — shown on their
// roster pill and used as the thumb on Vibe Sliders so multi-member rooms
// don't rely on a colored dot to disambiguate whose marker is whose.
//
// The optional `nickname` field lets a member update their display name in
// the same event (semantic alias for display_name_set).
//
// Reducer rules:
//   - latest-ts per sender wins for emoji
//   - latest-ts per sender wins for nickname, AND the nickname stream is
//     merged with `display_name_set` so either path updates the same
//     per-sender display name
//   - empty emoji string clears the avatar (renders the fallback)
// ---------------------------------------------------------------------------

export const MemberUpdateEventSchema = z.object({
  type: z.literal('member_update'),
  emoji: z.string().max(16).optional(),
  nickname: z.string().max(60).optional(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Reactions
//
// Emoji reactions on any prior event, targeted by its blob-row UUID. Works
// for messages, slider notes, love-tank notes, gratitude — anything with a
// rendered record the user might want to ❤️, 👍, 🫂, etc.
//
// Reducer rule per (targetId, senderId, emoji):
//   active ⇔  max(add_reaction.ts)  >  max(remove_reaction.ts)
// So toggling is idempotent and last-action-wins per sender — two tabs can't
// race into an inconsistent "both on and off" state.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Feature: Time Capsules
//
// A member posts a message (+ optional encrypted image attachment) that the
// UI *hides* until the local device clock passes `unlockAt`. Same UX-only
// trust model as Safe Space and Mind Reader: the payload is still decrypted
// on arrival by every current member; the gate is enforced by the renderer,
// not the cryptography. If you ever want a true time lock, you'd encrypt
// the payload under a second key that only publishes at unlockAt.
//
// Reducer rules:
//   - capsuleId is the stable identifier (client-generated UUID)
//   - `time_capsule_delete` issued by the original author tombstones the
//     capsule before or after unlock (mirrors the message_delete pattern)
// ---------------------------------------------------------------------------

export const TimeCapsulePostEventSchema = z.object({
  type: z.literal('time_capsule_post'),
  capsuleId: z.string().uuid(),
  unlockAt: z.number(),
  message: z.string().max(4000).optional(),
  attachment: ImageAttachmentHeaderSchema.optional(),
  ts: z.number(),
});

export const TimeCapsuleDeleteEventSchema = z.object({
  type: z.literal('time_capsule_delete'),
  capsuleId: z.string().uuid(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Low-Stakes Roulette Wheel
//
// Collaborative decision wheel for 2–10 person rooms. "Who pays for dinner",
// "Who picks the movie", etc. Three events:
//   - roulette_slice_add    — any member adds a label (latest-add wins per id)
//   - roulette_slice_remove — author-unrestricted remove; tombstone the slice
//   - roulette_spin         — caller computes the winner locally, then emits
//                             the SAME event to the room so every client lands
//                             the wheel on the identical slice
//
// The spin event carries:
//   - slicesSnapshot : the slices at spin time (so stale local state on a
//                      receiver can't produce a visual mismatch)
//   - winnerSliceId  : authoritative winner for the UI
//   - fullRotations  : how many whole turns the animation should run. Each
//                      client converts this to a local target rotation that
//                      ends with the winner under the pointer, regardless of
//                      where their wheel currently sits. Animation count is
//                      identical everywhere; wall-clock start drifts by the
//                      realtime-channel round-trip only.
//
// Trust model: same as Mind Reader / Safe Space — the "randomness" happens
// on the spinner's device and is trusted by the room. If a member wanted to
// cheat they could, since the event is signed by them. For low-stakes
// decisions this is acceptable.
// ---------------------------------------------------------------------------

export const RouletteSliceAddEventSchema = z.object({
  type: z.literal('roulette_slice_add'),
  sliceId: z.string().uuid(),
  label: z.string().min(1).max(60),
  ts: z.number(),
});

export const RouletteSliceRemoveEventSchema = z.object({
  type: z.literal('roulette_slice_remove'),
  sliceId: z.string().uuid(),
  ts: z.number(),
});

export const RouletteSpinEventSchema = z.object({
  type: z.literal('roulette_spin'),
  spinId: z.string().uuid(),
  slicesSnapshot: z
    .array(
      z.object({
        sliceId: z.string().uuid(),
        label: z.string().min(1).max(60),
      }),
    )
    .min(2)
    .max(30),
  winnerSliceId: z.string().uuid(),
  fullRotations: z.number().int().min(1).max(20),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Date-Night Roulette (separate wheel living in the Date Night tab)
//
// Same mechanics and trust model as the regular Roulette — just a distinct
// event family so the slice pool on the Date Night tab doesn't bleed into
// the home orb's Roulette and vice versa. Lets couples seed their
// date-night wheel with slices like "Who pays", "Who picks the restaurant",
// "Who drives" without those bleeding into generic decisions and vice
// versa.
// ---------------------------------------------------------------------------

export const DateRouletteSliceAddEventSchema = z.object({
  type: z.literal('date_roulette_slice_add'),
  sliceId: z.string().uuid(),
  label: z.string().min(1).max(60),
  /** Optional. When present, this slice belongs to a specific date's
   *  vault — won't show up on the room-level date-night roulette.
   *  Omitted = legacy room-scoped slice. */
  dateId: z.string().uuid().optional(),
  ts: z.number(),
});

export const DateRouletteSliceRemoveEventSchema = z.object({
  type: z.literal('date_roulette_slice_remove'),
  sliceId: z.string().uuid(),
  /** Same scoping as add — optional, present means vault-scoped. */
  dateId: z.string().uuid().optional(),
  ts: z.number(),
});

export const DateRouletteSpinEventSchema = z.object({
  type: z.literal('date_roulette_spin'),
  spinId: z.string().uuid(),
  slicesSnapshot: z
    .array(
      z.object({
        sliceId: z.string().uuid(),
        label: z.string().min(1).max(60),
      }),
    )
    .min(2)
    .max(30),
  winnerSliceId: z.string().uuid(),
  fullRotations: z.number().int().min(1).max(20),
  /** Optional. Present means this spin belongs to a specific date's
   *  vault — surfaces in that vault and (later) in its archive. */
  dateId: z.string().uuid().optional(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Date Vault — per-date pop-up sub-room with its own wall (text +
// photo posts) and memory bank (locked-in highlights captured during
// or just after the date). All payloads stay encrypted and scoped by
// dateId so the vault is self-contained.
// ---------------------------------------------------------------------------

export const DatePostKindEnum = z.enum(['text', 'photo']);
export type DatePostKind = z.infer<typeof DatePostKindEnum>;

export const DatePostEventSchema = z.object({
  type: z.literal('date_post'),
  postId: z.string().uuid(),
  dateId: z.string().uuid(),
  kind: DatePostKindEnum,
  /** Free-text post body. Optional when kind=photo (caption). */
  text: z.string().max(2000).optional(),
  /** Attachment header for kind=photo. Reuses the encrypted-image
   *  attachment primitive (same as Messages). */
  attachment: ImageAttachmentHeaderSchema.optional(),
  ts: z.number(),
});

export const DatePostDeleteEventSchema = z.object({
  type: z.literal('date_post_delete'),
  postId: z.string().uuid(),
  ts: z.number(),
});

export const DateMemoryEventSchema = z.object({
  type: z.literal('date_memory'),
  memoryId: z.string().uuid(),
  dateId: z.string().uuid(),
  /** "highlight" = one-line text, "photo" = encrypted attachment. */
  kind: DatePostKindEnum,
  text: z.string().max(280).optional(),
  attachment: ImageAttachmentHeaderSchema.optional(),
  ts: z.number(),
});

export const AddReactionEventSchema = z.object({
  type: z.literal('add_reaction'),
  targetId: z.string().uuid(),
  emoji: z.string().min(1).max(16),
  ts: z.number(),
});

export const RemoveReactionEventSchema = z.object({
  type: z.literal('remove_reaction'),
  targetId: z.string().uuid(),
  emoji: z.string().min(1).max(16),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Bribe economy (hearts spent to unlock/boost things)
//
// Sender spends `amount` hearts; the target's author receives them. Valid
// targets:
//   - mind_reader — force-reveals the thought + keyword (the target game is
//     treated as solved, with the bribe sender as the "solver").
//   - date_idea — boosts the idea (accumulates visible bribe amount + an
//     optional comment on the idea).
//
// Reducer enforces:
//   - you can't bribe yourself
//   - unknown/deleted targets are ignored
//   - amount must be >= 1
//
// Balance is: Σ gratitude_send (received) + Σ bribes (received) − Σ bribes (sent).
// A client UI should gate submission on sufficient balance, but the reducer
// doesn't — if the math goes negative due to races or stale state, we still
// accept the event (it's signed) and let the UI surface it.
// ---------------------------------------------------------------------------

export const BRIBE_TARGET_TYPES = ['mind_reader', 'date_idea'] as const;
export type BribeTargetType = (typeof BRIBE_TARGET_TYPES)[number];

export const BribeEventSchema = z.object({
  type: z.literal('bribe'),
  targetType: z.enum(BRIBE_TARGET_TYPES),
  targetId: z.string().uuid(),
  amount: z.number().int().min(1).max(1000),
  comment: z.string().max(500).optional(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Feature: Rituals (morning / evening)
//
// Two slots per room — morning and evening. Either member defines or
// updates the ritual name (latest-wins per slot); empty name clears the
// slot. Each member publishes a per-day `ritual_complete` when they've
// done theirs, keyed by local `YYYY-MM-DD` so completion resets at
// midnight. The UI shows each member's emoji (or first initial) next to
// the slot once they've ticked it for the day.
// ---------------------------------------------------------------------------

export const RITUAL_SLOTS = ['morning', 'evening'] as const;
export type RitualSlot = (typeof RITUAL_SLOTS)[number];

export const RitualSetEventSchema = z.object({
  type: z.literal('ritual_set'),
  slot: z.enum(RITUAL_SLOTS),
  name: z.string().max(80),                // '' clears
  ts: z.number(),
});

export const RitualCompleteEventSchema = z.object({
  type: z.literal('ritual_complete'),
  slot: z.enum(RITUAL_SLOTS),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // local YYYY-MM-DD
  ts: z.number(),
});

export const RitualUncompleteEventSchema = z.object({
  type: z.literal('ritual_uncomplete'),
  slot: z.enum(RITUAL_SLOTS),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Affection — kiss / hug / high-five placed at a screen position. Persists
// in the encrypted ledger so a refresh doesn't lose them. Cleared by either
// the receiver tapping (→ goes to their bank) or the sender retracting.
// ---------------------------------------------------------------------------

export const AFFECTION_KINDS = ['kiss', 'hug', 'high_five'] as const;
export type AffectionKind = (typeof AFFECTION_KINDS)[number];

export const AffectionSendEventSchema = z.object({
  type: z.literal('affection_send'),
  affectionId: z.string().uuid(),
  to: z.string().uuid(),
  kind: z.enum(AFFECTION_KINDS),
  /** Viewport-relative coordinates (0–1). Lets the same gesture render at
   *  the right spot on screens of different sizes. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  ts: z.number(),
});

export const AffectionReceiveEventSchema = z.object({
  type: z.literal('affection_receive'),
  affectionId: z.string().uuid(),
  ts: z.number(),
});

export const AffectionRetractEventSchema = z.object({
  type: z.literal('affection_retract'),
  affectionId: z.string().uuid(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// The discriminated union covering every known room-event shape.
// Add a new member here when porting another V1 feature.
// ---------------------------------------------------------------------------

export const RoomEventSchema = z.discriminatedUnion('type', [
  MessageEventSchema,
  MessageDeleteEventSchema,
  HomeworkSetEventSchema,
  LoveTankSetEventSchema,
  WishlistAddEventSchema,
  WishlistClaimEventSchema,
  WishlistDeleteEventSchema,
  SliderDefineEventSchema,
  SliderSetEventSchema,
  SliderDeleteEventSchema,
  GratitudeSendEventSchema,
  DateIdeaAddEventSchema,
  DateInviteUpdateEventSchema,
  DateIdeaVoteEventSchema,
  DateIdeaUnvoteEventSchema,
  DateIdeaScheduleEventSchema,
  DateIdeaCompleteEventSchema,
  DateIdeaDeleteEventSchema,
  MindReaderPostEventSchema,
  MindReaderSolveEventSchema,
  MindReaderDeleteEventSchema,
  IcebreakerPostEventSchema,
  IcebreakerUnlockEventSchema,
  IcebreakerAckEventSchema,
  IcebreakerReadyToTalkEventSchema,
  IcebreakerResolveEventSchema,
  IcebreakerDeleteEventSchema,
  TimeOutStartEventSchema,
  TimeOutEndEventSchema,
  RoomRenameEventSchema,
  DisplayNameSetEventSchema,
  MemberUpdateEventSchema,
  TimeCapsulePostEventSchema,
  TimeCapsuleDeleteEventSchema,
  RouletteSliceAddEventSchema,
  RouletteSliceRemoveEventSchema,
  RouletteSpinEventSchema,
  DateRouletteSliceAddEventSchema,
  DateRouletteSliceRemoveEventSchema,
  DateRouletteSpinEventSchema,
  AddReactionEventSchema,
  RemoveReactionEventSchema,
  BribeEventSchema,
  RitualSetEventSchema,
  RitualCompleteEventSchema,
  RitualUncompleteEventSchema,
  AffectionSendEventSchema,
  AffectionReceiveEventSchema,
  AffectionRetractEventSchema,
  DatePostEventSchema,
  DatePostDeleteEventSchema,
  DateMemoryEventSchema,
]);

export type RoomEvent = z.infer<typeof RoomEventSchema>;

/**
 * Parse a decrypted payload into a known RoomEvent, or return null if it's
 * unrecognized (e.g. an older-version event our current schema doesn't know
 * about). Never throws — feature code decides how to treat unknowns.
 */
export function parseRoomEvent(payload: unknown): RoomEvent | null {
  const result = RoomEventSchema.safeParse(payload);
  return result.success ? result.data : null;
}
