'use client';

/**
 * Mind Reader.
 *
 * One player (author) posts a game with three fields:
 *   - hint:    visible to everyone (what you're "thinking about")
 *   - keyword: the secret word the others must guess (hidden from non-authors
 *              until solved)
 *   - thought: the full thought that's revealed when solved (hidden from
 *              non-authors until solved)
 *
 * Anyone (except the author) can submit a guess. First guess whose
 * normalized text matches the keyword wins — game marked solved, fields
 * reveal to everyone. Author can delete their own game.
 *
 * Reveal matching is case-insensitive and whitespace-trimmed.
 */

import { useMemo, useState } from 'react';
import { displayName } from '@/lib/domain/displayName';
import { useMyHeartBalance } from '@/lib/domain/hearts';
import { describeError } from '@/lib/domain/errors';
import { BribeForm } from './BribeForm';
import { useRoom, useRoomProjection } from './RoomProvider';

interface Game {
  gameId: string;
  authorId: string;
  hint: string;
  keyword: string;
  thought: string;
  createdTs: number;
  solvedBy?: string;
  solveGuess?: string;
  solveTs: number;
  deletedTs: number;
  // Bribe-unlock metadata (non-zero amount → game was revealed via bribe,
  // not by guessing). The reducer sets solveTs/solvedBy too, so bribed
  // games flow through the same "solved" UI path.
  bribedAmount: number;
  bribeComment?: string;
}

type State = Record<string, Game>;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function MindReader() {
  const { myUserId, displayNames } = useRoom();

  const state = useRoomProjection<State>((acc, rec) => {
    const ev = rec.event;
    const uid = rec.senderId;
    switch (ev.type) {
      case 'mind_reader_post': {
        if (acc[ev.gameId]) return acc;
        return {
          ...acc,
          [ev.gameId]: {
            gameId: ev.gameId,
            authorId: uid,
            hint: ev.hint,
            keyword: ev.keyword,
            thought: ev.thought,
            createdTs: ev.ts,
            solveTs: 0,
            deletedTs: 0,
            bribedAmount: 0,
          },
        };
      }
      case 'bribe': {
        if (ev.targetType !== 'mind_reader') return acc;
        const game = acc[ev.targetId];
        if (!game) return acc;
        if (game.solveTs) return acc;           // already solved (or bribed)
        if (uid === game.authorId) return acc;  // can't bribe own game
        return {
          ...acc,
          [ev.targetId]: {
            ...game,
            solvedBy: uid,
            solveGuess: '[bribed]',
            solveTs: ev.ts,
            bribedAmount: ev.amount,
            bribeComment: ev.comment,
          },
        };
      }
      case 'mind_reader_solve': {
        const game = acc[ev.gameId];
        if (!game) return acc;
        if (game.solveTs) return acc;                        // first solve wins
        if (uid === game.authorId) return acc;               // author can't solve own
        if (normalize(ev.guess) !== normalize(game.keyword)) return acc;
        return {
          ...acc,
          [ev.gameId]: {
            ...game,
            solvedBy: uid,
            solveGuess: ev.guess,
            solveTs: ev.ts,
          },
        };
      }
      case 'mind_reader_delete': {
        const game = acc[ev.gameId];
        if (!game) return acc;
        if (game.authorId !== uid) return acc;
        if (game.deletedTs >= ev.ts) return acc;
        return { ...acc, [ev.gameId]: { ...game, deletedTs: ev.ts } };
      }
      default:
        return acc;
    }
  }, {});

  const { active, solved } = useMemo(() => {
    const a: Game[] = [];
    const s: Game[] = [];
    for (const g of Object.values(state)) {
      if (g.deletedTs) continue;
      if (g.solveTs) s.push(g);
      else a.push(g);
    }
    a.sort((x, y) => y.createdTs - x.createdTs);
    s.sort((x, y) => y.solveTs - x.solveTs);
    return { active: a, solved: s };
  }, [state]);

  const [posting, setPosting] = useState(false);

  if (!myUserId) return null;

  return (
    <section className="rounded-2xl border border-white/50 bg-indigo-50/70 p-6 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-indigo-950/40">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-300">
          Mind reader 🔮
        </div>
        {!posting && (
          <button
            onClick={() => setPosting(true)}
            className="rounded-full bg-gradient-to-br from-indigo-300 via-indigo-400 to-violet-500 px-4 py-1.5 font-display italic text-xs text-white shadow-[0_6px_16px_-4px_rgba(79,70,229,0.45),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-2px_4px_rgba(55,48,163,0.3)] ring-1 ring-indigo-200/60 transition-all hover:scale-[1.04] active:scale-[1.02]"
          >
            + new game
          </button>
        )}
      </div>

      {posting && <PostForm onDone={() => setPosting(false)} />}

      {active.length === 0 && !posting && (
        <p className="mt-2 text-indigo-800/70 dark:text-indigo-200">
          No games running. Post a hint and see if they can read your mind 🔮
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {active.map((g) => (
          <ActiveGameCard
            key={g.gameId}
            game={g}
            myUserId={myUserId}
            displayNames={displayNames}
          />
        ))}
      </ul>

      {solved.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-300">
            Solved ({solved.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {solved.map((g) => (
              <SolvedGameCard
                key={g.gameId}
                game={g}
                myUserId={myUserId}
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

function ActiveGameCard({
  game,
  myUserId,
  displayNames,
}: {
  game: Game;
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const { appendEvent } = useRoom();
  const isAuthor = game.authorId === myUserId;
  const myBalance = useMyHeartBalance();
  const [guess, setGuess] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [bribing, setBribing] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!guess.trim()) return;
    setBusy(true);
    setError(null);
    setWrong(false);
    try {
      if (normalize(guess) !== normalize(game.keyword)) {
        // Client-side short-circuit so wrong guesses don't spam the event log.
        setWrong(true);
        setBusy(false);
        return;
      }
      await appendEvent({
        type: 'mind_reader_solve',
        gameId: game.gameId,
        guess: guess.trim(),
        ts: Date.now(),
      });
      setGuess('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Delete this game?')) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'mind_reader_delete',
        gameId: game.gameId,
        ts: Date.now(),
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-indigo-200/60 bg-white/70 p-3 shadow-sm backdrop-blur-md dark:border-indigo-800/40 dark:bg-neutral-900/60">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-300">
            {isAuthor
              ? 'your hint'
              : `hint from ${displayName(game.authorId, displayNames, myUserId, null)}`}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words">{game.hint}</p>
        </div>
        {isAuthor && (
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-full border border-red-300 bg-white/70 px-3 py-1.5 font-display italic text-xs text-red-700 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-red-800 dark:bg-neutral-900/60 dark:text-red-400"
          >
            Delete
          </button>
        )}
      </div>

      {isAuthor ? (
        <div className="mt-2 rounded border border-indigo-100 bg-indigo-50 p-2 text-xs dark:border-indigo-800 dark:bg-indigo-950">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-300">
            (only you can see these until someone solves)
          </div>
          <p className="mt-1">
            <span className="font-semibold">keyword:</span> {game.keyword}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words">
            <span className="font-semibold">thought:</span> {game.thought}
          </p>
        </div>
      ) : (
        <>
          <form onSubmit={submit} className="mt-2 flex gap-2">
            <input
              type="text"
              value={guess}
              onChange={(e) => {
                setGuess(e.target.value);
                setWrong(false);
              }}
              placeholder="guess the keyword…"
              maxLength={100}
              className="flex-1 rounded-xl border border-indigo-200 bg-white/90 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-indigo-300 outline-none transition-colors focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/40 dark:border-indigo-800 dark:bg-neutral-950 dark:text-neutral-100"
            />
            <button
              type="submit"
              disabled={busy || !guess.trim()}
              className="rounded-full bg-indigo-900 px-4 py-2 font-display italic text-sm text-white shadow-sm transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50 dark:bg-indigo-200 dark:text-indigo-950"
            >
              {busy ? '…' : 'Guess'}
            </button>
          </form>
          {bribing ? (
            <BribeForm
              balance={myBalance}
              label="spend hearts to force-reveal the thought"
              onCancel={() => setBribing(false)}
              onSubmit={async (amount, comment) => {
                await appendEvent({
                  type: 'bribe',
                  targetType: 'mind_reader',
                  targetId: game.gameId,
                  amount,
                  comment,
                  ts: Date.now(),
                });
                setBribing(false);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setBribing(true)}
              className="mt-2 rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 text-[10px] text-rose-900 transition-all hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
            >
              🪙 bribe to reveal · you have {myBalance}♥
            </button>
          )}
        </>
      )}
      {wrong && (
        <p className="mt-1 text-xs text-indigo-700 dark:text-indigo-300">
          not it — try again
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------

function SolvedGameCard({
  game,
  myUserId,
  displayNames,
}: {
  game: Game;
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const solverName = game.solvedBy
    ? displayName(game.solvedBy, displayNames, myUserId)
    : 'someone';
  const wasBribed = game.bribedAmount > 0;
  return (
    <li className="rounded-xl border border-emerald-200/60 bg-emerald-50/60 p-3 shadow-sm backdrop-blur-md dark:border-emerald-800/40 dark:bg-emerald-950/40">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-300">
        {wasBribed
          ? `🪙 unlocked · ${solverName} bribed ${game.bribedAmount}♥`
          : `solved · ${solverName} guessed "${game.solveGuess}"`}
      </div>
      {wasBribed && game.bribeComment && (
        <p className="mt-1 rounded-lg border border-rose-200/60 bg-white/70 p-2 text-xs italic text-rose-900 shadow-sm backdrop-blur-md dark:border-rose-800/40 dark:bg-neutral-900/60 dark:text-rose-200">
          &ldquo;{game.bribeComment}&rdquo;
        </p>
      )}
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        hint: {game.hint}
      </p>
      <p className="mt-1 text-xs">
        <span className="font-semibold">keyword:</span> {game.keyword}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words">
        <span className="text-xs font-semibold">thought:</span> {game.thought}
      </p>
      <p className="mt-1 text-[10px] text-neutral-500">
        posted by {displayName(game.authorId, displayNames, myUserId)} ·{' '}
        {new Date(game.solveTs).toLocaleString()}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------

function PostForm({ onDone }: { onDone: () => void }) {
  const { appendEvent } = useRoom();
  const [hint, setHint] = useState('');
  const [keyword, setKeyword] = useState('');
  const [thought, setThought] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hint.trim() || !keyword.trim() || !thought.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'mind_reader_post',
        gameId: crypto.randomUUID(),
        hint: hint.trim(),
        keyword: keyword.trim(),
        thought: thought.trim(),
        ts: Date.now(),
      });
      setHint('');
      setKeyword('');
      setThought('');
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
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        placeholder="hint (everyone sees this)"
        required
        maxLength={500}
        className="block w-full rounded-xl border border-indigo-200 bg-white/90 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-indigo-300 outline-none transition-colors focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/40 dark:border-indigo-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <input
        type="text"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="secret keyword (what they must guess)"
        required
        maxLength={100}
        className="block w-full rounded-xl border border-indigo-200 bg-white/90 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-indigo-300 outline-none transition-colors focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/40 dark:border-indigo-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <textarea
        value={thought}
        onChange={(e) => setThought(e.target.value)}
        placeholder="full thought (revealed when solved)"
        required
        rows={3}
        maxLength={2000}
        className="block w-full rounded-2xl border border-indigo-200 bg-white/90 p-3 text-sm leading-relaxed text-neutral-900 placeholder:italic placeholder:text-indigo-300 outline-none transition-colors focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/40 dark:border-indigo-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !hint.trim() || !keyword.trim() || !thought.trim()}
          className="rounded-full bg-gradient-to-br from-indigo-300 via-indigo-400 to-violet-500 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(79,70,229,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(55,48,163,0.3)] ring-1 ring-indigo-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'posting…' : 'Post game'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="rounded-full border border-indigo-200 bg-white/80 px-4 py-2 font-display italic text-sm text-indigo-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-indigo-800 dark:bg-neutral-900/60 dark:text-indigo-200"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
