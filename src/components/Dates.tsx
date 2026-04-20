'use client';

/**
 * Dates — shared idea bank + voting + scheduling + two-key completion.
 *
 * Event model:
 *   date_idea_add       { ideaId, title, energy }
 *   date_idea_vote      { ideaId }           (per-user latest-wins w/ unvote)
 *   date_idea_unvote    { ideaId }
 *   date_idea_schedule  { ideaId, scheduledAt }   (latest-wins)
 *   date_idea_complete  { ideaId, feedback }      (per-user — each member
 *                         submits their own reflection; the idea moves to
 *                         Memories only once every current-gen member has
 *                         a completion event on record)
 *   date_idea_delete    { ideaId }                (only author; reducer enforces)
 *
 * Match detection: an idea is "matched" when every current-gen member has a
 * current vote. Show scheduling once matched, "we did the date" per-user once
 * scheduled. Each member's completion is independent; the idea leaves the
 * active list (into Memories) only when the LAST member completes.
 *
 * Active sort: vote count desc, tiebreak newest first.
 */

import { useMemo, useState } from 'react';
import { DATE_ENERGIES, type DateEnergy } from '@/lib/domain/events';
import { displayName } from '@/lib/domain/displayName';
import { useMyHeartBalance } from '@/lib/domain/hearts';
import { describeError } from '@/lib/domain/errors';
import { uniqueMembers } from '@/lib/domain/members';
import { isDateMatched } from '@/lib/domain/dateMatch';
import {
  inferCategoryForTitle,
  matchScoreForUserIdea,
  useRoomVibeState,
} from '@/lib/domain/dateHeuristics';
import { BribeForm } from './BribeForm';
import { DateGeneratorWidget } from './DateGeneratorWidget';
import { useRoom, useRoomProjection } from './RoomProvider';

interface Completion {
  feedback: string;
  ts: number;
}

interface BribeEntry {
  senderId: string;
  amount: number;
  comment?: string;
  ts: number;
}

interface Idea {
  ideaId: string;
  title: string;
  energy: DateEnergy;
  authorId: string;
  createdTs: number;
  /** Empty = whole-room (legacy + untargeted). Otherwise the
   *  explicit invited set. Used by isDateMatched(). */
  invitedUserIds: string[];
  votes: Record<string, { voted: boolean; ts: number }>;
  scheduledAt?: string;
  scheduledTs: number;
  completions: Record<string, Completion>;   // senderId → completion
  deletedTs: number;
  bribes: BribeEntry[];
  totalBribeAmount: number;
}

type State = Record<string, Idea>;

const ENERGY_LABEL: Record<DateEnergy, string> = {
  low: 'Chill',
  medium: 'Moderate',
  high: 'Adventure',
};

// 18 curated defaults, 6 per energy bucket. Shown in the frontend Idea Bank;
// clicking one emits a normal `date_idea_add` event into the room.
const IDEA_BANK: Record<DateEnergy, string[]> = {
  low: [
    'Cozy movie night with popcorn',
    'Bake something together',
    'Living-room picnic with takeaway',
    'Read each other your favourite chapter',
    'Board game marathon',
    'Star-gazing from the backyard',
  ],
  medium: [
    'Walk a new neighbourhood and try a café',
    'Cook a three-course meal together',
    'Beach or park day with a frisbee',
    'Saturday farmers\u2019 market + brunch',
    'Visit a local gallery or museum',
    'Bike ride to somewhere for lunch',
  ],
  high: [
    'Hike a lookout you\u2019ve never been to',
    'Day trip to a new town',
    'Indoor or outdoor rock climbing',
    'Kayaking or paddle-boarding',
    'Cooking class for a cuisine you\u2019ve never made',
    'Overnight camping trip',
  ],
};

export function Dates() {
  const { myUserId, members, room, displayNames } = useRoom();

  const state = useRoomProjection<State>((acc, rec) => {
    const ev = rec.event;
    const uid = rec.senderId;
    switch (ev.type) {
      case 'date_idea_add': {
        if (acc[ev.ideaId]) return acc;
        return {
          ...acc,
          [ev.ideaId]: {
            ideaId: ev.ideaId,
            title: ev.title,
            energy: ev.energy,
            authorId: uid,
            createdTs: ev.ts,
            invitedUserIds: ev.invitedUserIds ?? [],
            votes: {},
            scheduledTs: 0,
            completions: {},
            deletedTs: 0,
            bribes: [],
            totalBribeAmount: 0,
          },
        };
      }
      case 'bribe': {
        if (ev.targetType !== 'date_idea') return acc;
        const idea = acc[ev.targetId];
        if (!idea) return acc;
        if (idea.authorId === uid) return acc;     // can't boost your own idea
        if (idea.deletedTs) return acc;
        return {
          ...acc,
          [ev.targetId]: {
            ...idea,
            bribes: [
              ...idea.bribes,
              { senderId: uid, amount: ev.amount, comment: ev.comment, ts: ev.ts },
            ],
            totalBribeAmount: idea.totalBribeAmount + ev.amount,
          },
        };
      }
      case 'date_idea_vote':
      case 'date_idea_unvote': {
        const idea = acc[ev.ideaId];
        if (!idea) return acc;
        const prior = idea.votes[uid];
        if (prior && prior.ts >= ev.ts) return acc;
        return {
          ...acc,
          [ev.ideaId]: {
            ...idea,
            votes: {
              ...idea.votes,
              [uid]: { voted: ev.type === 'date_idea_vote', ts: ev.ts },
            },
          },
        };
      }
      case 'date_idea_schedule': {
        const idea = acc[ev.ideaId];
        if (!idea) return acc;
        if (idea.scheduledTs >= ev.ts) return acc;
        return {
          ...acc,
          [ev.ideaId]: { ...idea, scheduledAt: ev.scheduledAt, scheduledTs: ev.ts },
        };
      }
      case 'date_idea_complete': {
        const idea = acc[ev.ideaId];
        if (!idea) return acc;
        const prior = idea.completions[uid];
        if (prior && prior.ts >= ev.ts) return acc;
        return {
          ...acc,
          [ev.ideaId]: {
            ...idea,
            completions: {
              ...idea.completions,
              [uid]: { feedback: ev.feedback, ts: ev.ts },
            },
          },
        };
      }
      case 'date_idea_delete': {
        const idea = acc[ev.ideaId];
        if (!idea) return acc;
        if (idea.authorId !== uid) return acc;
        if (idea.deletedTs >= ev.ts) return acc;
        return { ...acc, [ev.ideaId]: { ...idea, deletedTs: ev.ts } };
      }
      default:
        return acc;
    }
  }, {});

  const currentMemberIds = useMemo(
    () =>
      room
        ? members
            .filter((m) => m.generation === room.current_generation)
            .map((m) => m.user_id)
        : [],
    [members, room],
  );

  const { active, memories } = useMemo(() => {
    const activeOut: Idea[] = [];
    const memoriesOut: Idea[] = [];
    for (const i of Object.values(state)) {
      if (i.deletedTs) continue;
      const allDone =
        currentMemberIds.length > 0 &&
        currentMemberIds.every((uid) => i.completions[uid]);
      if (allDone) memoriesOut.push(i);
      else activeOut.push(i);
    }
    // Sort active by vote count desc, then boosted-hearts desc, then newest.
    activeOut.sort((a, b) => {
      const va = countVotes(a, currentMemberIds);
      const vb = countVotes(b, currentMemberIds);
      if (vb !== va) return vb - va;
      if (b.totalBribeAmount !== a.totalBribeAmount)
        return b.totalBribeAmount - a.totalBribeAmount;
      return b.createdTs - a.createdTs;
    });
    memoriesOut.sort((a, b) => latestCompletionTs(b) - latestCompletionTs(a));
    return { active: activeOut, memories: memoriesOut };
  }, [state, currentMemberIds]);

  const [adding, setAdding] = useState(false);
  const [showingBank, setShowingBank] = useState(false);
  const [showingGenerator, setShowingGenerator] = useState(false);

  if (!myUserId) return null;

  return (
    <section className="rounded-2xl border border-white/50 bg-emerald-50/70 p-6 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-emerald-950/40">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-300">
          Dates 💕
        </div>
        <div className="flex flex-wrap gap-2">
          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="rounded-full bg-gradient-to-br from-emerald-300 via-emerald-500 to-teal-600 px-4 py-1.5 font-display italic text-xs text-white shadow-[0_6px_16px_-4px_rgba(16,185,129,0.45),inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-2px_4px_rgba(6,95,70,0.3)] ring-1 ring-emerald-200/60 transition-all hover:scale-[1.04] active:scale-[1.02]"
            >
              + add idea
            </button>
          )}
          <button
            onClick={() => setShowingGenerator((v) => !v)}
            className="rounded-full border border-violet-300 bg-white/70 px-4 py-1.5 font-display italic text-xs text-violet-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-violet-700 dark:bg-neutral-900/60 dark:text-violet-100"
          >
            🎲 {showingGenerator ? 'hide generator' : 'generate'}
          </button>
          <button
            onClick={() => setShowingBank((v) => !v)}
            className="rounded-full border border-emerald-200 bg-white/70 px-4 py-1.5 font-display italic text-xs text-emerald-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-emerald-800 dark:bg-neutral-900/60 dark:text-emerald-200"
          >
            {showingBank ? 'hide idea bank' : 'idea bank'}
          </button>
        </div>
      </div>

      {showingGenerator && (
        <div className="mt-3">
          <DateGeneratorWidget />
        </div>
      )}

      {adding && <AddForm onDone={() => setAdding(false)} />}

      {showingBank && (
        <IdeaBank existingTitles={new Set(Object.values(state).filter((i) => !i.deletedTs).map((i) => i.title.toLowerCase()))} />
      )}

      {active.length === 0 && !adding && !showingBank && (
        <p className="mt-2 text-emerald-800/70 dark:text-emerald-200">
          No date ideas yet. Add one above, or dip into the idea bank ✨
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {active.map((i) => (
          <IdeaCard
            key={i.ideaId}
            idea={i}
            myUserId={myUserId}
            memberIds={currentMemberIds}
            displayNames={displayNames}
          />
        ))}
      </ul>

      {memories.length > 0 && (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-300">
            Memories ({memories.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {memories.map((i) => (
              <MemoryCard
                key={i.ideaId}
                idea={i}
                myUserId={myUserId}
                memberIds={currentMemberIds}
                displayNames={displayNames}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function countVotes(idea: Idea, memberIds: string[]): number {
  let n = 0;
  for (const uid of memberIds) if (idea.votes[uid]?.voted) n++;
  return n;
}

function latestCompletionTs(idea: Idea): number {
  let t = 0;
  for (const c of Object.values(idea.completions)) if (c.ts > t) t = c.ts;
  return t;
}

// ---------------------------------------------------------------------------

function IdeaCard({
  idea,
  myUserId,
  memberIds,
  displayNames,
}: {
  idea: Idea;
  myUserId: string;
  memberIds: string[];
  displayNames: Record<string, string>;
}) {
  const { appendEvent } = useRoom();
  const myBalance = useMyHeartBalance();
  // Vibe-match % against the room's current vibe vector. Inferred
  // from title + energy via dateHeuristics.
  const roomVibe = useRoomVibeState();
  const matchPct = matchScoreForUserIdea(roomVibe, {
    title: idea.title,
    energy: idea.energy,
  });
  const inferredCategory = inferCategoryForTitle(idea.title, idea.energy);

  const voters = memberIds.filter((uid) => idea.votes[uid]?.voted);
  const iVoted = !!idea.votes[myUserId]?.voted;
  // Match logic centralised in lib/domain/dateMatch — honours
  // invitedUserIds (targeted dates only need invited voters) AND
  // enforces the ≥2 voter floor. Used identically by DatesOracle,
  // MatchedDatesBoard, the Vault, and the Memory Bank.
  const isMatch = isDateMatched(
    {
      invitedUserIds: idea.invitedUserIds,
      voters: new Set(voters),
    },
    memberIds,
  );
  const mine = idea.authorId === myUserId;
  const scheduled = !!idea.scheduledAt;

  const myCompletion = idea.completions[myUserId];
  const othersCompleted = memberIds
    .filter((uid) => uid !== myUserId && idea.completions[uid])
    .map((uid) => ({ uid, c: idea.completions[uid] }));
  const completedCount = memberIds.filter((uid) => idea.completions[uid]).length;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [boosting, setBoosting] = useState(false);

  async function toggleVote() {
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: iVoted ? 'date_idea_unvote' : 'date_idea_vote',
        ideaId: idea.ideaId,
        ts: Date.now(),
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${idea.title}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'date_idea_delete',
        ideaId: idea.ideaId,
        ts: Date.now(),
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={`rounded border p-2 ${
        isMatch
          ? 'border-pink-300 bg-pink-50 dark:border-pink-800 dark:bg-pink-950'
          : 'border-emerald-200 bg-white dark:border-emerald-800 dark:bg-neutral-950'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]"
              style={{
                borderColor: 'rgba(16,185,129,0.35)',
                background: 'rgba(16,185,129,0.10)',
                color: 'rgb(6,95,70)',
              }}
            >
              {inferredCategory}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${
                matchPct >= 75
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200'
                  : matchPct >= 50
                    ? 'border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-500 dark:bg-amber-950/60 dark:text-amber-200'
                    : 'border-neutral-300 bg-white/60 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-300'
              }`}
              title="how well this matches the room's current vibe"
            >
              {matchPct}% match
            </span>
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
              {ENERGY_LABEL[idea.energy]}
            </span>
            {isMatch && (
              <span className="rounded bg-pink-600 px-1.5 py-0.5 text-[10px] uppercase text-white">
                💖 match
              </span>
            )}
            {idea.totalBribeAmount > 0 && (
              <span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] uppercase text-white">
                🚀 +{idea.totalBribeAmount}♥
              </span>
            )}
            <span className="font-medium break-words">{idea.title}</span>
          </div>
          <p className="mt-1 text-[10px] text-neutral-500">
            added by {displayName(idea.authorId, displayNames, myUserId)}
            {' · '}
            {voters.length}/{memberIds.length} voted
            {scheduled && (
              <>
                {' · '}
                scheduled {new Date(idea.scheduledAt!).toLocaleString()}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-col gap-1">
          <button
            onClick={() => void toggleVote()}
            disabled={busy}
            className={`rounded px-2 py-1 text-xs disabled:opacity-50 ${
              iVoted
                ? 'bg-emerald-900 text-white dark:bg-emerald-200 dark:text-emerald-950'
                : 'border border-emerald-300 text-emerald-900 dark:border-emerald-800 dark:text-emerald-200'
            }`}
          >
            {iVoted ? 'voted ✓' : 'vote'}
          </button>
          {!mine && !boosting && (
            <button
              onClick={() => setBoosting(true)}
              disabled={busy}
              className="rounded-full border border-rose-300 bg-rose-50 px-2 py-1 text-[10px] text-rose-900 transition-all hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
            >
              🚀 boost
            </button>
          )}
          {mine && (
            <button
              onClick={() => void remove()}
              disabled={busy}
              className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
            >
              delete
            </button>
          )}
        </div>
      </div>

      {boosting && (
        <BribeForm
          balance={myBalance}
          label="boost this idea"
          onCancel={() => setBoosting(false)}
          onSubmit={async (amount, comment) => {
            await appendEvent({
              type: 'bribe',
              targetType: 'date_idea',
              targetId: idea.ideaId,
              amount,
              comment,
              ts: Date.now(),
            });
            setBoosting(false);
          }}
        />
      )}

      {idea.bribes.length > 0 && (
        <details className="mt-2 rounded-lg border border-rose-200 bg-white/60 p-2 text-xs dark:border-rose-800 dark:bg-neutral-900/60">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.18em] text-rose-800 dark:text-rose-300">
            🚀 boosts ({idea.bribes.length})
          </summary>
          <ul className="mt-1 space-y-1">
            {idea.bribes.map((b, i) => (
              <li key={`${b.senderId}-${b.ts}-${i}`}>
                <span className="text-rose-700 dark:text-rose-300">
                  {displayName(b.senderId, displayNames, myUserId)} · {b.amount}♥
                </span>
                {b.comment && (
                  <span className="ml-1 italic text-neutral-700 dark:text-neutral-300">
                    &ldquo;{b.comment}&rdquo;
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Scheduling block — appears once matched */}
      {isMatch && !scheduled && <ScheduleForm ideaId={idea.ideaId} />}

      {/* Post-schedule two-key completion flow */}
      {isMatch && scheduled && (
        <div className="mt-2 space-y-2">
          {/* Partner(s) who have already reflected */}
          {othersCompleted.length > 0 && (
            <div className="rounded-xl border border-pink-200/60 bg-white/70 p-3 text-xs shadow-sm backdrop-blur-md dark:border-pink-800/40 dark:bg-neutral-900/60">
              <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-pink-800 dark:text-pink-300">
                partner reflections
              </div>
              <ul className="mt-1 space-y-1">
                {othersCompleted.map(({ uid, c }) => (
                  <li key={uid}>
                    <span className="text-[10px] text-neutral-500">
                      {displayName(uid, displayNames, myUserId, null)}
                    </span>
                    {c.feedback ? (
                      <p className="whitespace-pre-wrap break-words">
                        {c.feedback}
                      </p>
                    ) : (
                      <p className="italic text-neutral-500">(no note)</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* My completion state */}
          {myCompletion ? (
            <div className="rounded-xl border border-pink-200/60 bg-white/70 p-3 text-xs shadow-sm backdrop-blur-md dark:border-pink-800/40 dark:bg-neutral-900/60">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-pink-800 dark:text-pink-300">
                  your reflection
                </span>
                <button
                  onClick={() => setCompleting(true)}
                  className="rounded border border-pink-300 px-1.5 py-0.5 text-[10px] text-pink-900 dark:border-pink-800 dark:text-pink-200"
                >
                  edit
                </button>
              </div>
              {myCompletion.feedback ? (
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {myCompletion.feedback}
                </p>
              ) : (
                <p className="italic text-neutral-500">(no note)</p>
              )}
              <p className="mt-1 text-[10px] text-pink-800/70 dark:text-pink-200">
                {completedCount === memberIds.length
                  ? 'all set — moving to Memories…'
                  : `waiting for ${memberIds.length - completedCount} more to reflect`}
              </p>
            </div>
          ) : (
            !completing && (
              <button
                onClick={() => setCompleting(true)}
                disabled={busy}
                className="rounded-full bg-gradient-to-br from-pink-300 via-pink-500 to-rose-600 px-4 py-1.5 font-display italic text-xs text-white shadow-[0_6px_18px_-4px_rgba(236,72,153,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-2px_4px_rgba(159,18,57,0.3)] ring-1 ring-pink-200/60 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
              >
                {othersCompleted.length > 0
                  ? 'it\u2019s your turn to reflect'
                  : 'we did the date'}
              </button>
            )
          )}

          {/* Optional reschedule */}
          {!myCompletion && !completing && (
            <ScheduleForm ideaId={idea.ideaId} compact />
          )}
        </div>
      )}

      {completing && (
        <CompleteForm
          ideaId={idea.ideaId}
          initial={myCompletion?.feedback ?? ''}
          onDone={() => setCompleting(false)}
          onCancel={() => setCompleting(false)}
        />
      )}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------

function ScheduleForm({ ideaId, compact }: { ideaId: string; compact?: boolean }) {
  const { appendEvent } = useRoom();
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!when) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'date_idea_schedule',
        ideaId,
        scheduledAt: new Date(when).toISOString(),
        ts: Date.now(),
      });
      setWhen('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`mt-2 flex gap-2 ${compact ? '' : 'flex-wrap'}`}>
      <input
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        required
        className="rounded-xl border border-pink-200 bg-white/90 px-3 py-1.5 text-sm text-neutral-900 outline-none transition-colors focus:border-pink-300 focus:ring-2 focus:ring-pink-300/40 dark:border-pink-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <button
        type="submit"
        disabled={busy || !when}
        className="rounded-full bg-gradient-to-br from-pink-300 via-pink-500 to-rose-600 px-4 py-1.5 font-display italic text-xs text-white shadow-[0_6px_18px_-4px_rgba(236,72,153,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-2px_4px_rgba(159,18,57,0.3)] ring-1 ring-pink-200/60 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
      >
        {compact ? 'reschedule' : 'schedule'}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------

function CompleteForm({
  ideaId,
  initial,
  onDone,
  onCancel,
}: {
  ideaId: string;
  initial: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { appendEvent } = useRoom();
  const [feedback, setFeedback] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'date_idea_complete',
        ideaId,
        feedback: feedback.trim(),
        ts: Date.now(),
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-xl border border-pink-300/60 bg-pink-50/70 p-3 shadow-sm backdrop-blur-md dark:border-pink-800/40 dark:bg-pink-950/40">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-pink-800 dark:text-pink-300">
        your reflection (only you can edit this — your partner writes their own)
      </div>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="a short reflection (optional)"
        rows={3}
        maxLength={1000}
        className="block w-full rounded-2xl border border-pink-200 bg-white/90 p-3 text-sm leading-relaxed text-neutral-900 placeholder:italic placeholder:text-pink-300 outline-none transition-colors focus:border-pink-300 focus:ring-2 focus:ring-pink-300/40 dark:border-pink-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="rounded-full bg-gradient-to-br from-pink-300 via-pink-500 to-rose-600 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(236,72,153,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(159,18,57,0.3)] ring-1 ring-pink-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'saving…' : initial ? 'Save' : 'Mark your side done'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-pink-200 bg-white/80 px-4 py-2 font-display italic text-sm text-pink-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-pink-800 dark:bg-neutral-900/60 dark:text-pink-200"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------

function AddForm({ onDone }: { onDone: () => void }) {
  const { appendEvent, members, room, myUserId, displayNames, memberEmojis } = useRoom();
  const [title, setTitle] = useState('');
  const [energy, setEnergy] = useState<DateEnergy>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Targeting: "whole" (default — invitedUserIds empty) vs "specific"
  // (invite a chosen subset of room members). Only surfaces the picker
  // in 3+-member rooms; 2-person rooms always invite the partner.
  const others = room
    ? uniqueMembers(members, room.current_generation).filter((m) => m.user_id !== myUserId)
    : [];
  const isMultiPartner = others.length >= 2;
  const [targetMode, setTargetMode] = useState<'whole' | 'specific'>('whole');
  const [chosenIds, setChosenIds] = useState<Set<string>>(new Set());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Build the invited set. For whole-room or 2-person rooms,
      // omit invitedUserIds entirely (legacy behaviour).
      let invitedUserIds: string[] | undefined = undefined;
      if (isMultiPartner && targetMode === 'specific' && chosenIds.size > 0) {
        // Always include myself so my own vote can lock the match.
        invitedUserIds = [myUserId!, ...chosenIds];
      }
      await appendEvent({
        type: 'date_idea_add',
        ideaId: crypto.randomUUID(),
        title: title.trim(),
        energy,
        invitedUserIds,
        ts: Date.now(),
      });
      setTitle('');
      setEnergy('medium');
      setChosenIds(new Set());
      setTargetMode('whole');
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
      className="mt-3 space-y-3 rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="what's the idea?"
        required
        maxLength={200}
        className="block w-full rounded-xl border border-emerald-200 bg-white/90 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-emerald-300 outline-none transition-colors focus:border-emerald-300 focus:ring-2 focus:ring-emerald-300/40 dark:border-emerald-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <div className="flex flex-wrap gap-1.5">
        {DATE_ENERGIES.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEnergy(e)}
            aria-pressed={energy === e}
            className={`rounded-full px-3 py-1.5 font-display italic text-xs transition-all ${
              energy === e
                ? 'scale-[1.05] bg-emerald-900 text-white shadow-sm dark:bg-emerald-200 dark:text-emerald-950'
                : 'border border-emerald-200 text-emerald-900 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-200 dark:hover:bg-emerald-950/50'
            }`}
          >
            {ENERGY_LABEL[e]}
          </button>
        ))}
      </div>

      {/* Targeting picker — only surfaces in 3+-member rooms.
          Two-person rooms always invite the partner so this UX would
          just add noise. */}
      {isMultiPartner && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
            For
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setTargetMode('whole')}
              className={`flex-1 rounded-xl border px-2 py-1.5 text-[11px] transition-all ${
                targetMode === 'whole'
                  ? 'border-emerald-500 bg-white/95 font-medium shadow-sm dark:border-emerald-400 dark:bg-neutral-900/85'
                  : 'border-emerald-200 bg-white/60 hover:bg-white/80 dark:border-emerald-800/60 dark:bg-neutral-900/40'
              }`}
            >
              Whole room
            </button>
            <button
              type="button"
              onClick={() => setTargetMode('specific')}
              className={`flex-1 rounded-xl border px-2 py-1.5 text-[11px] transition-all ${
                targetMode === 'specific'
                  ? 'border-emerald-500 bg-white/95 font-medium shadow-sm dark:border-emerald-400 dark:bg-neutral-900/85'
                  : 'border-emerald-200 bg-white/60 hover:bg-white/80 dark:border-emerald-800/60 dark:bg-neutral-900/40'
              }`}
            >
              Specific people
            </button>
          </div>
          {targetMode === 'specific' && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {others.map((m) => {
                const selected = chosenIds.has(m.user_id);
                const name = displayName(m.user_id, displayNames, myUserId, null);
                const emoji = memberEmojis[m.user_id];
                return (
                  <button
                    key={m.user_id}
                    type="button"
                    onClick={() =>
                      setChosenIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(m.user_id)) next.delete(m.user_id);
                        else next.add(m.user_id);
                        return next;
                      })
                    }
                    className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-all ${
                      selected
                        ? 'border-emerald-400 bg-white/95 text-emerald-900 shadow-sm dark:border-emerald-500 dark:bg-neutral-900/80 dark:text-emerald-100'
                        : 'border-emerald-200 bg-white/60 text-emerald-800 hover:bg-white/80 dark:border-emerald-800/60 dark:bg-neutral-900/40 dark:text-emerald-200'
                    }`}
                  >
                    {emoji && <span aria-hidden>{emoji}</span>}
                    <span className="font-medium">{name.split(' ')[0]}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-full bg-gradient-to-br from-emerald-300 via-emerald-500 to-teal-600 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(16,185,129,0.5),inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-3px_6px_rgba(6,95,70,0.3)] ring-1 ring-emerald-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="rounded-full border border-emerald-200 bg-white/80 px-4 py-2 font-display italic text-sm text-emerald-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-emerald-800 dark:bg-neutral-900/60 dark:text-emerald-200"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------

function IdeaBank({ existingTitles }: { existingTitles: Set<string> }) {
  const { appendEvent } = useRoom();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addFromBank(title: string, energy: DateEnergy) {
    if (busy) return;
    setBusy(title);
    setError(null);
    try {
      await appendEvent({
        type: 'date_idea_add',
        ideaId: crypto.randomUUID(),
        title,
        energy,
        ts: Date.now(),
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-emerald-200/60 bg-white/70 p-3 shadow-sm backdrop-blur-md dark:border-emerald-800/40 dark:bg-neutral-900/60">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-300">
        idea bank — click to add to your room
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {DATE_ENERGIES.map((e) => (
          <div key={e} className="space-y-1">
            <div className="text-[10px] uppercase text-emerald-700 dark:text-emerald-400">
              {ENERGY_LABEL[e]}
            </div>
            <ul className="space-y-1">
              {IDEA_BANK[e].map((t) => {
                const already = existingTitles.has(t.toLowerCase());
                return (
                  <li key={t}>
                    <button
                      type="button"
                      disabled={busy !== null || already}
                      onClick={() => void addFromBank(t, e)}
                      className="w-full rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-left text-xs text-emerald-900 enabled:hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                    >
                      {already ? `✓ ${t}` : busy === t ? `adding… ${t}` : `+ ${t}`}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MemoryCard({
  idea,
  myUserId,
  memberIds,
  displayNames,
}: {
  idea: Idea;
  myUserId: string;
  memberIds: string[];
  displayNames: Record<string, string>;
}) {
  return (
    <li className="rounded-xl border border-emerald-200/60 bg-white/70 p-3 shadow-sm backdrop-blur-md dark:border-emerald-800/40 dark:bg-neutral-900/60">
      <div className="flex items-center gap-2">
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
          {ENERGY_LABEL[idea.energy]}
        </span>
        <span className="font-medium break-words">{idea.title}</span>
      </div>
      {idea.scheduledAt && (
        <p className="mt-1 text-[10px] text-neutral-500">
          scheduled for {new Date(idea.scheduledAt).toLocaleString()}
        </p>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {memberIds.map((uid) => {
          const c = idea.completions[uid];
          if (!c) return null;
          const isMe = uid === myUserId;
          return (
            <div
              key={uid}
              className="rounded border border-emerald-100 bg-emerald-50 p-2 dark:border-emerald-800 dark:bg-emerald-950"
            >
              <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-300">
                {isMe ? 'your reflection' : displayName(uid, displayNames, myUserId, null)}
              </div>
              {c.feedback ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs">
                  {c.feedback}
                </p>
              ) : (
                <p className="mt-1 italic text-xs text-neutral-500">(no note)</p>
              )}
              <p className="mt-1 text-[10px] text-neutral-500">
                {new Date(c.ts).toLocaleString()}
              </p>
            </div>
          );
        })}
      </div>
    </li>
  );
}
