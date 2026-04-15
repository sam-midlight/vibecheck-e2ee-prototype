'use client';

/**
 * First-sign-in modal (or settings "generate new phrase" trigger):
 *   1. Explain the tradeoff.
 *   2. Generate 24 words, show them in a grid.
 *   3. Require 3-word verification (user types the 4th, 11th, 20th etc).
 *   4. Wrap identity with the phrase and upload the ciphertext.
 *
 * This component does NOT persist "user opted out" — that's the parent's job
 * (store a localStorage flag like `recovery_skip_<userId>` if you want).
 */

import { useState } from 'react';
import {
  encodeRecoveryBlob,
  generateRecoveryPhrase,
  splitPhrase,
  wrapIdentityWithPhrase,
  type Identity,
} from '@/lib/e2ee-core';
import { putRecoveryBlob } from '@/lib/supabase/queries';

interface Props {
  userId: string;
  identity: Identity;
  onDone: (result: 'saved' | 'skipped') => void;
  /** If true, no "skip" button — used when rotating (must commit or cancel the rotate). */
  hideSkip?: boolean;
}

type Stage = 'intro' | 'display' | 'verify' | 'uploading' | 'error';

export function RecoveryPhraseModal({ userId, identity, onDone, hideSkip }: Props) {
  const [stage, setStage] = useState<Stage>('intro');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleStart() {
    setPhrase(generateRecoveryPhrase());
    setStage('display');
  }

  async function handleCommit() {
    if (!phrase) return;
    setStage('uploading');
    setError(null);
    try {
      const blob = await wrapIdentityWithPhrase(identity, phrase, userId);
      const encoded = await encodeRecoveryBlob(blob);
      await putRecoveryBlob({ userId, ...encoded });
      onDone('saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-900">
        {stage === 'intro' && (
          <IntroStage onStart={handleStart} onSkip={() => onDone('skipped')} hideSkip={hideSkip} />
        )}
        {stage === 'display' && phrase && (
          <DisplayStage phrase={phrase} onContinue={() => setStage('verify')} />
        )}
        {stage === 'verify' && phrase && (
          <VerifyStage
            phrase={phrase}
            onBack={() => setStage('display')}
            onOk={() => void handleCommit()}
          />
        )}
        {stage === 'uploading' && (
          <p className="text-sm">Encrypting and uploading recovery blob…</p>
        )}
        {stage === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-red-600 dark:text-red-400">
              Something went wrong: {error ?? 'unknown error'}
            </p>
            <button
              onClick={() => setStage('display')}
              className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
            >
              back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function IntroStage({
  onStart,
  onSkip,
  hideSkip,
}: {
  onStart: () => void;
  onSkip: () => void;
  hideSkip?: boolean;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Set up account recovery?</h2>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Your account is protected by a key stored on this device. If you lose
        this device and every other device you&apos;re signed into, you lose
        access permanently.
      </p>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        A 24-word recovery phrase is your emergency escape hatch. Anyone with
        this phrase can sign in as you from anywhere, so write it down and
        store it somewhere safe — <strong>not in this app, and not in your email</strong>.
      </p>
      <div className="flex flex-wrap gap-2 pt-2">
        <button
          onClick={onStart}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-neutral-900"
        >
          Generate recovery phrase
        </button>
        {!hideSkip && (
          <button
            onClick={onSkip}
            className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

function DisplayStage({ phrase, onContinue }: { phrase: string; onContinue: () => void }) {
  const words = splitPhrase(phrase);
  const [ack, setAck] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS origin). User can still
      // select the words manually.
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Your 24-word recovery phrase</h2>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Write these down, in order, on paper. Do not screenshot. Do not paste
        into a note app synced to the cloud. Do not email them.
      </p>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-neutral-300 bg-neutral-50 p-4 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950 sm:grid-cols-3">
        {words.map((w, i) => (
          <li key={i} className="tabular-nums">
            <span className="inline-block w-6 text-neutral-400">{i + 1}.</span>
            {w}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
        >
          {copied ? 'copied ✓' : 'copy phrase'}
        </button>
        <span className="text-xs text-neutral-500">
          Space-separated, ready to paste into recovery.
        </span>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-1"
        />
        <span>I&apos;ve written these down somewhere safe.</span>
      </label>
      <div className="flex gap-2 pt-1">
        <button
          onClick={onContinue}
          disabled={!ack}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function VerifyStage({
  phrase,
  onBack,
  onOk,
}: {
  phrase: string;
  onBack: () => void;
  onOk: () => void;
}) {
  const words = splitPhrase(phrase);
  const lastIndex = words.length;

  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const expected = words[lastIndex - 1];
    const given = answer.trim().toLowerCase();
    if (given !== expected) {
      setError(`Word #${lastIndex} doesn't match. Check your written copy.`);
      return;
    }
    setError(null);
    onOk();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-lg font-semibold">Verify your phrase</h2>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Type the last word (word #{lastIndex}) from your written copy. This
        confirms you actually wrote them down, not just glanced at the screen.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-500">Word #{lastIndex}</span>
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 font-mono dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
        >
          back
        </button>
        <button
          type="submit"
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-neutral-900"
        >
          Confirm and save
        </button>
      </div>
    </form>
  );
}
