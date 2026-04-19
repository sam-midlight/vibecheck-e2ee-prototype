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

import { useState, useRef } from 'react';
import { errorMessage } from '@/lib/errors';
import {
  decryptDeviceDisplayName,
  encodeRecoveryBlob,
  filterActiveDevices,
  fromBase64,
  generateBackupKey,
  generateRecoveryPhrase,
  getBackupKey,
  putBackupKey,
  splitPhrase,
  verifySskCrossSignature,
  wrapUserMasterKeyWithPhrase,
  type DeviceKeyBundle,
  type PublicDevice,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import {
  commitRotatedUmk,
  generateRotatedUmk,
  rotateAllRoomsIAdmin,
} from '@/lib/bootstrap';
import {
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  listDeviceRows,
  putRecoveryBlob,
} from '@/lib/supabase/queries';

interface PickerEntry {
  pub: PublicDevice;
  /** Encrypted display name string (base64) — only decryptable on the device that wrote it. */
  displayNameCiphertext: string | null;
  /** Decrypted name, present only for the current (own) device row. */
  decryptedName: string | null;
}

interface Props {
  userId: string;
  umk: UserMasterKey;
  onDone: (result: 'saved' | 'skipped') => void | Promise<void>;
  /** If true, no "skip" button — used when rotating (must commit or cancel the rotate). */
  hideSkip?: boolean;
  /**
   * If true: rotate the UMK first (re-issue all device certs, bump
   * identity_epoch), then wrap the NEW UMK with the generated phrase.
   * The old blob becomes inert even if someone held a copy.
   */
  rotate?: boolean;
  /**
   * When rotate is true, pass the local device bundle so the modal can
   * also cascade a rotation into every room this user administrates
   * (fresh symmetric keys + bumped generations). Without this, the UMK
   * rotates but rooms stay on old symmetric keys.
   */
  device?: DeviceKeyBundle;
}

type Stage =
  | 'intro'
  | 'display'
  | 'verify'
  | 'loading-picker'
  | 'device-picker'
  | 'uploading-pre-commit'
  | 'uploading-post-commit'
  | 'error';

export function RecoveryPhraseModal({ userId, umk, onDone, hideSkip, rotate, device }: Props) {
  const [stage, setStage] = useState<Stage>('intro');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ghost-device picker state — populated between 'verify' and 'uploading'
  // when we're rotating AND the user has 2+ active devices. The user must
  // confirm which devices to keep before the new SSK re-issues their certs.
  const [pickerEntries, setPickerEntries] = useState<PickerEntry[] | null>(null);
  const cancelledRef = useRef(false);

  function handleStart() {
    setPhrase(generateRecoveryPhrase());
    setStage('display');
  }

  /**
   * After the user verifies their phrase, decide whether to show the
   * ghost-device picker. Only applies to rotation flows (rotate=true) with
   * a known current device (device prop passed). Skip the picker if there's
   * only one active device on the account — nothing to pick.
   */
  async function handleVerified() {
    if (!phrase) return;
    cancelledRef.current = false;
    setError(null);
    if (rotate && device) {
      setStage('loading-picker');
      try {
        const publishedOld = await fetchUserMasterKeyPub(userId);
        if (cancelledRef.current) return;
        if (!publishedOld) throw new Error('no published UMK — nothing to rotate');
        let oldSskPub: Uint8Array | undefined;
        if (publishedOld.sskPub && publishedOld.sskCrossSignature) {
          try {
            await verifySskCrossSignature(
              publishedOld.ed25519PublicKey,
              publishedOld.sskPub,
              publishedOld.sskCrossSignature,
            );
            oldSskPub = publishedOld.sskPub;
          } catch {
            // fall through to MSK-only verification
          }
        }
        const active = await filterActiveDevices(
          await fetchPublicDevices(userId),
          umk.ed25519PublicKey,
          oldSskPub,
        );
        if (cancelledRef.current) return;
        // Fast-path: only the current device is active → nothing to pick.
        if (active.length <= 1) {
          await performCommit([]);
          return;
        }
        // Fetch the DeviceRow list to pick up display-name ciphertext.
        // Only the device that wrote its own ciphertext can decrypt it, so
        // only OUR row yields a plaintext name; peer rows render as
        // fingerprint + createdAt instead.
        const rows = await listDeviceRows(userId);
        if (cancelledRef.current) return;
        const rowsById = new Map(rows.map((r) => [r.id, r]));
        const entries: PickerEntry[] = [];
        for (const pub of active) {
          const row = rowsById.get(pub.deviceId);
          const displayNameCiphertext = row?.display_name_ciphertext ?? null;
          let decryptedName: string | null = null;
          if (pub.deviceId === device.deviceId && displayNameCiphertext) {
            try {
              decryptedName = await decryptDeviceDisplayName(
                await fromBase64(displayNameCiphertext),
                device.x25519PublicKey,
                device.x25519PrivateKey,
              );
            } catch {
              // fall through
            }
          }
          entries.push({ pub, displayNameCiphertext, decryptedName });
        }
        setPickerEntries(entries);
        setStage('device-picker');
      } catch (e) {
        setError(errorMessage(e));
        setStage('error');
      }
      return;
    }
    // No rotation or no device context → proceed directly.
    await performCommit([]);
  }

  async function performCommit(devicesToRevoke: string[]) {
    if (!phrase) return;
    setStage('uploading-pre-commit');
    setError(null);
    try {
      // SSSS ordering (Matrix-style): escrow the new keys in the
      // recovery blob BEFORE publishing pubs. If the browser crashes
      // mid-flow, the user recovers via the phrase they just wrote down.
      let umkToWrap: UserMasterKey;
      let rotated: Awaited<ReturnType<typeof generateRotatedUmk>> | null = null;

      if (rotate) {
        // Step 1: generate new MSK + SSK + USK + re-sign certs IN MEMORY ONLY.
        // devicesToRevoke comes from the picker; empty array = default
        // "re-sign everyone" behaviour.
        rotated = await generateRotatedUmk(userId, umk, {
          devicesToRevoke,
        });
        umkToWrap = rotated.newUmk;
      } else {
        umkToWrap = umk;
      }

      // Step 2: wrap all keys with the phrase. v4 blob includes SSK+USK.
      let backupKey = await getBackupKey(userId);
      if (!backupKey) {
        backupKey = await generateBackupKey();
        await putBackupKey(userId, backupKey);
      }
      // Include SSK+USK in the blob if we have them (rotation generates
      // fresh ones; non-rotation wraps whatever this device holds).
      const { getSelfSigningKey: loadSsk, getUserSigningKey: loadUsk } =
        await import('@/lib/e2ee-core');
      const localSsk = rotated?.newSsk ?? (await loadSsk(userId));
      const localUsk = rotated?.newUsk ?? (await loadUsk(userId));
      const blob = await wrapUserMasterKeyWithPhrase(
        umkToWrap,
        phrase,
        userId,
        {
          backupKey,
          sskPriv: localSsk?.ed25519PrivateKey,
          uskPriv: localUsk?.ed25519PrivateKey,
        },
      );
      const encoded = await encodeRecoveryBlob(blob);

      // Step 3: COMMIT POINT — upload recovery blob.
      await putRecoveryBlob({ userId, ...encoded });
      setStage('uploading-post-commit');

      if (rotate && rotated) {
        // Step 4: save to local IDB.
        const { putUserMasterKey: saveUmk, putSelfSigningKey: saveSsk, putUserSigningKey: saveUsk } =
          await import('@/lib/e2ee-core');
        await saveUmk(userId, umkToWrap);
        await saveSsk(userId, rotated.newSsk);
        await saveUsk(userId, rotated.newUsk);

        // Step 5: publish new pubs + write re-signed device certs +
        // any revocations produced by the picker.
        await commitRotatedUmk(
          userId,
          umkToWrap,
          rotated.reissuedCerts,
          {
            ssk: rotated.newSsk,
            usk: rotated.newUsk,
            sskCrossSignature: rotated.sskCrossSignature,
            uskCrossSignature: rotated.uskCrossSignature,
          },
          rotated.revocations,
        );

        // Step 5b: invalidate the stale pin-locked blob. The old wrapped
        // identity contains the pre-rotation MSK; unlocking it would fail
        // the ghost check (old MSK ≠ published new MSK → orphan). Clearing
        // it forces a re-setup via the mandatory require-pin-setup gate on
        // next navigation. The user re-enters their passphrase once.
        const { hasWrappedIdentity, clearWrappedIdentity: clearWrap } =
          await import('@/lib/e2ee-core');
        if (await hasWrappedIdentity(userId)) {
          await clearWrap(userId);
        }

        // Step 6: cascade room rotations.
        if (device) {
          try {
            const result = await rotateAllRoomsIAdmin({ userId, device });
            if (result.failures.length > 0) {
              console.warn(
                `[recovery] ${result.rotated} room(s) rotated; ${result.failures.length} failed:`,
                result.failures,
              );
            }
          } catch (err) {
            console.warn('[recovery] room cascade failed', err);
          }
        }
      }
      await onDone('saved');
    } catch (e) {
      setError(errorMessage(e));
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
          <DisplayStage
            phrase={phrase}
            onContinue={() => setStage('verify')}
            onCancel={() => onDone('skipped')}
          />
        )}
        {stage === 'verify' && phrase && (
          <VerifyStage
            phrase={phrase}
            onBack={() => setStage('display')}
            onOk={() => void handleVerified()}
          />
        )}
        {stage === 'loading-picker' && (
          <div className="space-y-3">
            <p className="text-sm">Loading devices…</p>
            <button
              onClick={() => { cancelledRef.current = true; onDone('skipped'); }}
              className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
            >
              cancel
            </button>
          </div>
        )}
        {stage === 'device-picker' && pickerEntries && device && (
          <DevicePicker
            entries={pickerEntries}
            currentDeviceId={device.deviceId}
            onBack={() => setStage('verify')}
            onConfirm={(toRevoke) => void performCommit(toRevoke)}
          />
        )}
        {stage === 'uploading-pre-commit' && (
          <div className="space-y-3">
            <p className="text-sm">Encrypting and uploading recovery blob…</p>
            <button
              onClick={() => onDone('skipped')}
              className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
            >
              cancel
            </button>
          </div>
        )}
        {stage === 'uploading-post-commit' && (
          <p className="text-sm">Almost done…</p>
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
        this phrase can sign in as you from anywhere, so save it somewhere
        safe — <strong>not in this app, and not in your email</strong>.
      </p>
      {!hideSkip && (
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Skipping is possible but <strong>not recommended</strong>. Without a
          phrase, losing your devices means losing the account and everything
          in it — permanently.
        </p>
      )}
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
            className="rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-500 dark:border-neutral-700"
          >
            Skip (not recommended)
          </button>
        )}
      </div>
    </div>
  );
}

function DisplayStage({
  phrase,
  onContinue,
  onCancel,
}: {
  phrase: string;
  onContinue: () => void;
  onCancel: () => void;
}) {
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

  function handleSavePdf() {
    printPhrase(words);
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Your 24-word recovery phrase</h2>
      <div className="rounded-md border-2 border-red-400 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950">
        <p className="font-semibold text-red-900 dark:text-red-100">
          Save this now. You will never see it again.
        </p>
        <p className="mt-1 text-xs text-red-800 dark:text-red-200">
          The phrase is never stored on our server — only your encrypted data
          is. If you leave this screen without saving it, and you later lose
          your devices, your account and everything in it is gone for good.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-neutral-300 bg-neutral-50 p-4 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950 sm:grid-cols-3">
        {words.map((w, i) => (
          <li key={i} className="tabular-nums">
            <span className="inline-block w-6 text-neutral-400">{i + 1}.</span>
            {w}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSavePdf}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Save as PDF
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded border border-neutral-300 px-3 py-1.5 text-xs transition-transform duration-150 hover:bg-neutral-100 active:scale-95 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {copied ? 'copied ✓' : 'copy phrase'}
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        Do not screenshot. Do not paste into a cloud-synced note app. Do not
        email it to yourself. The PDF dialog includes the option to save to
        Files / Drive — or pick a real printer.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-1"
        />
        <span>
          I&apos;ve saved this phrase somewhere I can get to it later (PDF,
          password manager, or written down).
        </span>
      </label>
      <div className="flex gap-2 pt-1">
        <button
          onClick={onContinue}
          disabled={!ack}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Render the phrase into a hidden iframe and trigger the browser's print
 * dialog. The user picks "Save as PDF" (or a real printer) as the destination.
 * Staying in an iframe rather than a new window avoids popup-blocker prompts
 * and keeps the modal open in the background.
 */
function printPhrase(words: string[]) {
  const wordListHtml = words
    .map(
      (w, i) =>
        `<li><span class="n">${i + 1}.</span><span class="w">${escapeHtml(w)}</span></li>`,
    )
    .join('');
  const generatedAt = new Date().toLocaleString();

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Recovery phrase</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; color: #111; margin: 0; padding: 2rem; }
  h1 { font-size: 20pt; margin: 0 0 0.25rem; }
  .sub { font-size: 9pt; color: #666; margin-bottom: 1.5rem; }
  .warn { border: 1px solid #c00; background: #fff5f5; padding: 0.75rem 1rem; font-size: 10pt; margin-bottom: 1.5rem; border-radius: 4px; }
  ol { list-style: none; padding: 0; margin: 0 0 1.5rem; display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.35rem 1.5rem; border: 1px solid #999; padding: 1rem; border-radius: 4px; }
  ol li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12pt; }
  ol .n { display: inline-block; width: 2.2rem; color: #888; }
  ol .w { font-weight: 600; }
  .meta { font-size: 9pt; color: #666; border-top: 1px solid #ccc; padding-top: 0.75rem; }
  .meta div { margin: 0.25rem 0; }
  .meta .fillable { display: inline-block; min-width: 12rem; border-bottom: 1px solid #888; height: 1em; }
  @media print { body { padding: 1.25rem; } }
</style>
</head>
<body>
  <h1>VibeCheck — Recovery phrase</h1>
  <div class="sub">Generated ${escapeHtml(generatedAt)}</div>
  <div class="warn">
    <strong>Treat this page like cash.</strong> Anyone who has these 24 words and your email can sign in as you. Store it offline. Do not photograph, email, or upload. If lost, nobody can help you get back in.
  </div>
  <ol>${wordListHtml}</ol>
  <div class="meta">
    <div>Account email: <span class="fillable"></span></div>
    <div>Stored at: <span class="fillable"></span></div>
    <div>Date written: <span class="fillable"></span></div>
  </div>
</body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  // Wait for the iframe to finish parsing before printing; some browsers
  // (notably Safari) print a blank page otherwise.
  const fire = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    // The print dialog is modal; once it closes we can tear the iframe down.
    // Give it a generous delay — canceling a dialog on mobile can take a beat.
    setTimeout(() => iframe.remove(), 2000);
  };
  if (iframe.contentDocument?.readyState === 'complete') {
    fire();
  } else {
    iframe.addEventListener('load', fire, { once: true });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
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

/**
 * Ghost-device picker. Before the new SSK re-issues device certs, the user
 * confirms which devices to keep. Unchecked devices get a fresh SSK-signed
 * revocation cert instead of a re-issued issuance cert, expelling them from
 * future generations. The current device is pinned-checked so the user can't
 * lock themselves out.
 */
function DevicePicker({
  entries,
  currentDeviceId,
  onBack,
  onConfirm,
}: {
  entries: PickerEntry[];
  currentDeviceId: string;
  onBack: () => void;
  onConfirm: (devicesToRevoke: string[]) => void;
}) {
  // State: set of deviceIds the user has opted to KEEP (checked). Initialized
  // with every device checked (default is "trust all"); current device is
  // always present and non-togglable.
  const [kept, setKept] = useState<Set<string>>(
    () => new Set(entries.map((e) => e.pub.deviceId)),
  );

  const revokeCount = entries.filter(
    (e) => e.pub.deviceId !== currentDeviceId && !kept.has(e.pub.deviceId),
  ).length;

  function toggle(deviceId: string) {
    if (deviceId === currentDeviceId) return; // can't toggle current
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }

  function submit() {
    const toRevoke = entries
      .map((e) => e.pub.deviceId)
      .filter((id) => id !== currentDeviceId && !kept.has(id));
    onConfirm(toRevoke);
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Confirm your trusted devices</h2>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Rotation replaces your root key. Any device still trusted after this
        will be re-signed and keep access. Uncheck any device you don&apos;t
        recognize — it will be revoked and lose access to messages sent after
        rotation.
      </p>
      <ul className="space-y-2">
        {entries.map((entry) => {
          const isCurrent = entry.pub.deviceId === currentDeviceId;
          const checked = kept.has(entry.pub.deviceId);
          return (
            <li
              key={entry.pub.deviceId}
              className="rounded border border-neutral-300 p-3 dark:border-neutral-700"
            >
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isCurrent}
                  onChange={() => toggle(entry.pub.deviceId)}
                  className="mt-1"
                />
                <div className="flex-1 space-y-0.5">
                  <div className="font-medium">
                    {isCurrent && entry.decryptedName
                      ? `${entry.decryptedName} (this device)`
                      : isCurrent
                        ? 'This device'
                        : `Device ${entry.pub.deviceId.slice(0, 8)}…`}
                  </div>
                  <div className="text-xs font-mono text-neutral-500">
                    fingerprint {fingerprintHex(entry.pub.ed25519PublicKey)}
                  </div>
                  <div className="text-xs text-neutral-500">
                    added{' '}
                    {new Date(entry.pub.createdAtMs).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </div>
                </div>
              </label>
            </li>
          );
        })}
      </ul>
      {revokeCount > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950">
          {revokeCount === 1 ? '1 device' : `${revokeCount} devices`} will be
          revoked. They&apos;ll keep any messages already on their device but
          won&apos;t see new ones.
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
        >
          back
        </button>
        <button
          type="button"
          onClick={submit}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-neutral-900"
        >
          Rotate with {kept.size} trusted {kept.size === 1 ? 'device' : 'devices'}
        </button>
      </div>
    </div>
  );
}

/** First 8 hex bytes of the ed25519 pub, space-separated for readability. */
function fingerprintHex(edPub: Uint8Array): string {
  const hex = bytesToHexDebug(edPub.slice(0, 8));
  return hex.match(/.{1,4}/g)?.join(' ') ?? hex;
}

function bytesToHexDebug(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
