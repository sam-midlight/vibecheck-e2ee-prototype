'use client';

import { useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';

export const TOS_CURRENT_VERSION = '2026-04-18';

interface TosModalProps {
  userId: string;
  onAccepted?: () => void;
  readOnly?: boolean;
  onClose?: () => void;
}

export function TosModal({ userId, onAccepted, readOnly = false, onClose }: TosModalProps) {
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      setScrolledToBottom(true);
    }
  }

  async function handleAccept() {
    setAccepting(true);
    setErr(null);
    try {
      const { acceptTos } = await import('@/lib/supabase/queries');
      await acceptTos(userId, TOS_CURRENT_VERSION);
      onAccepted?.();
    } catch (e) {
      setErr(errorMessage(e));
      setAccepting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-neutral-900">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-6 py-4 dark:border-neutral-700">
          <div>
            <h2 className="text-base font-semibold">Terms of Service</h2>
            <p className="text-[11px] text-neutral-500">Version {TOS_CURRENT_VERSION}</p>
          </div>
          {readOnly && onClose && (
            <button
              onClick={onClose}
              className="rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-500 hover:text-neutral-800 dark:border-neutral-700 dark:hover:text-neutral-200"
            >
              close ✕
            </button>
          )}
        </div>

        {/* Scrollable body */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-6 py-4 text-sm leading-relaxed text-neutral-800 dark:text-neutral-200"
        >
          <div className="space-y-4">
            <section>
              <h3 className="font-semibold">1. Acceptance</h3>
              <p>
                By creating an account or using Vibecheck (&ldquo;Service&rdquo;), you agree to
                these Terms. If you do not agree, do not use the Service. You must be 18 or
                older to use the Service.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">2. End-to-End Encryption — What We Cannot Do</h3>
              <p>
                All messages, files, and calls transmitted through the Service are
                end-to-end encrypted using open cryptographic standards (libsodium /
                Signal Protocol-aligned key hierarchy). This means:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                <li>We do not hold encryption keys to your messages.</li>
                <li>
                  We cannot read, monitor, intercept, or produce the content of your
                  communications.
                </li>
                <li>
                  We cannot recover your messages if you lose your device and recovery
                  phrase.
                </li>
                <li>
                  Law enforcement requests for message content cannot be fulfilled
                  because the content does not exist in readable form on our servers.
                </li>
              </ul>
              <p className="mt-2">
                We can only provide metadata we hold: account creation date, last active
                timestamp, room membership lists, and device registration records.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">3. Your Responsibilities</h3>
              <p>
                You are solely responsible for all content you transmit through the
                Service. You agree not to use the Service to:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                <li>
                  Transmit content that is illegal under Australian law or the laws of
                  your jurisdiction.
                </li>
                <li>Harass, threaten, or harm other users.</li>
                <li>
                  Distribute child sexual abuse material (CSAM) or any content illegal
                  under the <em>Criminal Code Act 1995</em> (Cth).
                </li>
                <li>Coordinate criminal activity.</li>
              </ul>
              <p className="mt-2">
                Because messages are encrypted and inaccessible to us, enforcement of
                these terms relies on user reporting of metadata-level abuse and our
                right to terminate accounts.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">4. No Monitoring; Reporting</h3>
              <p>
                We do not and cannot monitor message content. If you become aware of
                illegal activity conducted through the Service, report it to the relevant
                law enforcement authority directly. We will cooperate with lawful legal
                process to the extent technically possible (metadata only).
              </p>
            </section>

            <section>
              <h3 className="font-semibold">5. Account Termination</h3>
              <p>
                We may suspend or terminate your account if we become aware of conduct
                that violates these Terms or applicable law, based on metadata signals
                available to us. You may delete your account at any time from Settings.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">6. Data and Privacy</h3>
              <p>
                We collect: email address, device public keys, room membership metadata,
                and encrypted message ciphertext (unreadable to us). We do not sell your
                data. See our Privacy Policy for full details.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">7. Disclaimer of Warranties</h3>
              <p>
                The Service is provided &ldquo;as is.&rdquo; We make no warranty that the
                Service will be uninterrupted, error-free, or secure against all attacks.
                Cryptographic security depends on your device not being compromised.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">8. Limitation of Liability</h3>
              <p>
                To the maximum extent permitted by Australian law, our liability for any
                claim arising from use of the Service is limited to AUD $100. We are not
                liable for loss of data, loss of communications, or any consequential
                damages.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">9. Governing Law</h3>
              <p>
                These Terms are governed by the laws of Australia. Disputes are subject
                to the exclusive jurisdiction of the courts of Australia.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">10. Changes</h3>
              <p>
                We may update these Terms. Material changes will require re-acceptance on
                next login. Continued use after notice of minor changes constitutes
                acceptance.
              </p>
            </section>

            <p className="pt-2 text-[11px] text-neutral-500">
              Version {TOS_CURRENT_VERSION} · Vibecheck
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-neutral-200 px-6 py-4 dark:border-neutral-700">
          {readOnly ? (
            <button
              onClick={onClose}
              className="rounded bg-neutral-900 px-4 py-2 text-xs text-white dark:bg-white dark:text-neutral-900"
            >
              close
            </button>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-neutral-500">
                {scrolledToBottom
                  ? 'Please click below to confirm you accept.'
                  : 'Scroll to the bottom to accept.'}
              </p>
              <div className="flex flex-col items-end gap-1">
                {err && <p className="text-[11px] text-red-600">{err}</p>}
                <button
                  onClick={() => void handleAccept()}
                  disabled={!scrolledToBottom || accepting}
                  className="rounded bg-neutral-900 px-4 py-2 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
                >
                  {accepting ? 'saving…' : 'I accept these terms'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
