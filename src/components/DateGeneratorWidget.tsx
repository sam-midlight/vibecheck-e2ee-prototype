'use client';

/**
 * DateGeneratorWidget — a tiny generative date-idea machine. Combines a
 * Base Activity with a Spicy Twist from curated seed tables to produce
 * thousands of possible combinations on demand.
 *
 * Independent from the full Dates feature (idea bank + voting + reflections).
 * This is the "we can't decide what to do tonight" quick fix. If you like
 * the output, there's an "Add to bank" action that appends a
 * `date_idea_add` event so it flows into the full feature.
 *
 * Uses the room-shared seed tables below — identical on every client so
 * the generator feels coherent between partners. Randomness is client-side
 * only (no events for the roll), so each person can spin independently.
 */

import { useMemo, useState } from 'react';
import { describeError } from '@/lib/domain/errors';
import { useRoom } from './RoomProvider';
import { toast } from 'sonner';

type Energy = 'low' | 'high';

interface ComboHalf {
  text: string;
}

const BASE_LOW: ComboHalf[] = [
  { text: 'Order Thai food' },
  { text: 'Put on a movie neither of you has seen' },
  { text: 'Build a blanket fort in the lounge' },
  { text: 'Do face masks together' },
  { text: 'Start a 1000-piece puzzle' },
  { text: 'Make pancakes for dinner' },
  { text: 'Read the opening chapters of a book aloud to each other' },
  { text: 'Play a slow 2-player board game' },
  { text: 'Bake something ridiculous' },
  { text: 'Run a warm bath' },
  { text: 'Do a couples tarot pull' },
  { text: 'Swap playlists and listen through each other\u2019s top 5' },
  { text: 'Scroll old photos together' },
  { text: 'Cook a recipe from a country you\u2019ve never been to' },
  { text: 'Light every candle in the house' },
  { text: 'Draw each other, badly' },
  { text: 'Plan a fake trip together' },
  { text: 'Watch the sunset from wherever you can see the sky' },
];

const TWIST_LOW: ComboHalf[] = [
  { text: 'but eat it on a floor picnic with candles' },
  { text: 'but the rule is no phones for the whole time' },
  { text: 'and take turns narrating what each other\u2019s childhood selves would think' },
  { text: 'but one of you has to compliment the other every ten minutes' },
  { text: 'and the winner picks the next weekend breakfast' },
  { text: 'and swap roles halfway through' },
  { text: 'but only use the light from candles / fairy lights' },
  { text: 'and take a "before" and "after" photo of your faces' },
  { text: 'while doing slow cat-cow stretches between rounds' },
  { text: 'and each pick one song that reminds you of the other' },
  { text: 'and keep a little running tally of things you\u2019re grateful for tonight' },
  { text: 'but only in whispers' },
  { text: 'and when one of you laughs, you have to kiss' },
  { text: 'and write a one-line love note to tuck into the other\u2019s bag tomorrow' },
  { text: 'and the loser gives a 5-minute back rub' },
];

const BASE_HIGH: ComboHalf[] = [
  { text: 'Go for a drive' },
  { text: 'Walk somewhere you\u2019ve never walked before' },
  { text: 'Go bouldering / rock climbing' },
  { text: 'Find a trampoline park / arcade / bowling alley' },
  { text: 'Do a grocery run' },
  { text: 'Run a 5k — even if you walk most of it' },
  { text: 'Explore a farmers market' },
  { text: 'Hit a dog park (bring treats for strangers\u2019 dogs)' },
  { text: 'Try the noisiest local food truck' },
  { text: 'Find a lookout point' },
  { text: 'Dance in the kitchen to three songs each' },
  { text: 'Ride bikes somewhere you\u2019ve never been' },
  { text: 'Go to an art gallery' },
  { text: 'Swim somewhere' },
  { text: 'Try a class you\u2019ve never taken — pottery, cooking, improv' },
  { text: 'Scavenger-hunt five weird things in the neighbourhood' },
  { text: 'Go to a mini-golf course' },
  { text: 'Pick up a last-minute live music ticket' },
];

const TWIST_HIGH: ComboHalf[] = [
  { text: 'but turn left every time you see a red car until you find a park' },
  { text: 'and keep a running tally of how many dogs you see' },
  { text: 'but you\u2019re only allowed to talk about the future for the first ten minutes' },
  { text: 'and end it with ice cream (non-negotiable)' },
  { text: 'and on the way back, each pick a song that feels like today' },
  { text: 'but the passenger picks all the turns' },
  { text: 'and take one selfie every time you cross the street' },
  { text: 'and neither of you can use your phone for directions' },
  { text: 'but one of you has to narrate in a fake British accent for 20 mins' },
  { text: 'and the first to spot a red door buys the snack' },
  { text: 'but you have to stop at the first weird thing you see and investigate' },
  { text: 'and collect one small thing each (leaf, receipt, flyer) for the memory jar' },
  { text: 'but time it so you end at sunset' },
  { text: 'and pretend you\u2019re tourists — ask each other "wait what is THAT?"' },
  { text: 'and give each other a stranger rating for each person you pass (out of 10 vibes)' },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomIdea(energy: Energy): { base: string; twist: string } {
  const bases = energy === 'low' ? BASE_LOW : BASE_HIGH;
  const twists = energy === 'low' ? TWIST_LOW : TWIST_HIGH;
  return { base: pick(bases).text, twist: pick(twists).text };
}

export function DateGeneratorWidget() {
  const { appendEvent } = useRoom();
  const [energy, setEnergy] = useState<Energy>('low');
  const [idea, setIdea] = useState<{ base: string; twist: string } | null>(null);
  const [rolling, setRolling] = useState(false);
  const [saving, setSaving] = useState(false);

  // Combinatorial math for the "infinite" tag in the corner.
  const totalCombinations = useMemo(
    () =>
      BASE_LOW.length * TWIST_LOW.length +
      BASE_HIGH.length * TWIST_HIGH.length,
    [],
  );

  function roll() {
    setRolling(true);
    // Tiny delay so the number swap reads as an intentional generate, not
    // a teleport. No network, no real latency.
    window.setTimeout(() => {
      setIdea(randomIdea(energy));
      setRolling(false);
    }, 220);
  }

  async function saveToBank() {
    if (!idea) return;
    setSaving(true);
    try {
      const title = `${idea.base} — ${idea.twist}`;
      await appendEvent({
        type: 'date_idea_add',
        ideaId: crypto.randomUUID(),
        title: title.slice(0, 200),
        energy: energy === 'low' ? 'low' : 'high',
        ts: Date.now(),
      });
      toast.success('added to the dates idea bank');
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/60 bg-white/70 p-5 text-sm shadow-lg backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.012] dark:border-white/10 dark:bg-neutral-900/55">
      <header className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
          <span aria-hidden>🎲</span>
          <span>Date idea generator</span>
        </h3>
        <span className="tabular-nums text-[10px] text-neutral-400" title="possible combinations">
          {totalCombinations.toLocaleString()} combos
        </span>
      </header>

      {/* Energy toggle */}
      <div className="mt-3 inline-flex rounded-full border border-neutral-200 bg-white/60 p-1 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900/60">
        {(['low', 'high'] as const).map((e) => {
          const active = energy === e;
          return (
            <button
              key={e}
              type="button"
              onClick={() => setEnergy(e)}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 font-display italic text-xs transition-all ${
                active
                  ? e === 'low'
                    ? 'scale-[1.02] bg-indigo-900 text-white shadow-sm dark:bg-indigo-200 dark:text-indigo-950'
                    : 'scale-[1.02] bg-rose-700 text-white shadow-sm dark:bg-rose-300 dark:text-rose-950'
                  : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
              }`}
            >
              {e === 'low' ? '🛋️ Low energy' : '⚡ High energy'}
            </button>
          );
        })}
      </div>

      {/* Idea body */}
      <div className="mt-4 min-h-[90px]">
        {idea ? (
          <div
            className="space-y-2 rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
            style={{
              opacity: rolling ? 0.35 : 1,
              transform: rolling ? 'scale(0.98)' : 'scale(1)',
              transition: 'opacity 180ms, transform 180ms',
            }}
          >
            <p className="font-display italic text-base leading-snug text-neutral-900 dark:text-neutral-50">
              {idea.base}
            </p>
            <p className="font-display text-base italic leading-snug text-neutral-700 dark:text-neutral-300">
              … {idea.twist}.
            </p>
          </div>
        ) : (
          <p className="pt-3 text-sm italic leading-relaxed text-neutral-500">
            Hit the roll button and see what you get. Reroll as many times as
            you want.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={roll}
          disabled={rolling}
          className="rounded-full bg-gradient-to-br from-violet-300 via-violet-400 to-indigo-500 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(124,58,237,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(67,56,202,0.3)] ring-1 ring-violet-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {rolling ? 'rolling…' : idea ? '🎲 Reroll' : '🎲 Roll an idea'}
        </button>
        {idea && (
          <button
            type="button"
            onClick={() => void saveToBank()}
            disabled={saving}
            className="rounded-full border border-emerald-200 bg-white/80 px-4 py-2 font-display italic text-sm text-emerald-800 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-emerald-800 dark:bg-neutral-900/60 dark:text-emerald-200"
          >
            {saving ? 'saving…' : '+ Add to bank'}
          </button>
        )}
      </div>
    </section>
  );
}
