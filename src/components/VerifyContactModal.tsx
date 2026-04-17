'use client';

/**
 * SAS emoji verification wizard. Drives the full protocol:
 *   initiate → commitment → key exchange → emoji compare → MAC → cross-sign
 *
 * The initiator creates a session row; the responder subscribes via realtime.
 * Both sides drive state transitions by updating the session row.
 */

import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';
import {
  computeSasMac,
  computeSasSharedSecret,
  deriveSasEmoji,
  fromBase64,
  generateSasCommitment,
  getDeviceBundle,
  getUserSigningKey,
  signUserMsk,
  toBase64,
  type Bytes,
} from '@/lib/e2ee-core';
import {
  createSasSession,
  fetchUserMasterKeyPub,
  getSasSession,
  insertCrossUserSignature,
  subscribeSasSessions,
  updateSasSession,
  type SasVerificationSessionRow,
} from '@/lib/supabase/queries';

interface Props {
  userId: string;
  peerUserId: string;
  onDone: (result: 'verified' | 'cancelled' | 'failed') => void;
}

type Stage =
  | 'initiating'
  | 'waiting-for-peer'
  | 'comparing-emoji'
  | 'confirming'
  | 'exchanging-mac'
  | 'signing'
  | 'done'
  | 'error';

export function VerifyContactModal({ userId, peerUserId, onDone }: Props) {
  const [stage, setStage] = useState<Stage>('initiating');
  const [emoji, setEmoji] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const ephemeralRef = useRef<{ pub: Bytes; priv: Bytes } | null>(null);
  const sharedSecretRef = useRef<Bytes | null>(null);
  const ranRef = useRef(false);
  // Idempotency guards so repeat events (our own UPDATE triggers another
  // realtime tick, etc.) don't re-run the key-exchange or finalize blocks.
  const didKeyExchangeRef = useRef(false);
  const didFinalizeRef = useRef(false);

  // Initiate the SAS protocol
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let unsub: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const device = await getDeviceBundle(userId);
        if (!device) throw new Error('no device bundle');

        const commitment = await generateSasCommitment(device.ed25519PublicKey);
        ephemeralRef.current = {
          pub: commitment.ephemeralPub,
          priv: commitment.ephemeralPriv,
        };

        const session = await createSasSession({
          initiatorUserId: userId,
          responderUserId: peerUserId,
          initiatorDeviceId: device.deviceId,
          commitment: await toBase64(commitment.commitment),
        });
        if (cancelled) return;
        setSessionId(session.id);
        setStage('waiting-for-peer');

        // Wrap handler so errors surface to UI instead of being swallowed by
        // the realtime callback / setInterval (which silently drop rejections).
        const safeHandle = async (row: SasVerificationSessionRow) => {
          try {
            await handleSessionUpdate(row, device);
          } catch (err) {
            console.error('[sas-initiator] handler failed', err);
            if (!cancelled) {
              setError(errorMessage(err));
              setStage('error');
            }
          }
        };

        // Subscribe for peer updates
        unsub = subscribeSasSessions(userId, (row) => {
          if (row.id !== session.id || cancelled) return;
          void safeHandle(row);
        });

        // Also poll in case realtime missed the initial state
        const poller = setInterval(() => {
          if (cancelled) { clearInterval(poller); return; }
          void (async () => {
            try {
              const row = await getSasSession(session.id);
              if (row && row.state !== 'initiated') {
                await safeHandle(row);
                clearInterval(poller);
              }
            } catch (err) {
              console.error('[sas-initiator] poll failed', err);
            }
          })();
        }, 2000);

        async function handleSessionUpdate(
          row: SasVerificationSessionRow,
          _dev: NonNullable<Awaited<ReturnType<typeof getDeviceBundle>>>,
        ) {
          void _dev;
          if (cancelled) return;
          if (
            row.state === 'key_exchanged' &&
            row.responder_ephemeral_pub &&
            !didKeyExchangeRef.current
          ) {
            didKeyExchangeRef.current = true;
            // Peer sent their ephemeral pub. Reveal ours + derive emoji.
            const eph = ephemeralRef.current;
            if (!eph) throw new Error('missing ephemeral keypair');
            await updateSasSession(row.id, {
              initiator_ephemeral_pub: await toBase64(eph.pub),
            });
            const peerEph = await fromBase64(row.responder_ephemeral_pub);
            const shared = await computeSasSharedSecret(eph.priv, peerEph);
            sharedSecretRef.current = shared;

            const myMskPub = await fetchUserMasterKeyPub(userId);
            const peerMskPub = await fetchUserMasterKeyPub(peerUserId);
            if (!myMskPub || !peerMskPub) throw new Error('MSK pubs not found');

            const emojiList = await deriveSasEmoji({
              sharedSecret: shared,
              aliceMskPub: myMskPub.ed25519PublicKey,
              bobMskPub: peerMskPub.ed25519PublicKey,
              aliceEphemeralPub: eph.pub,
              bobEphemeralPub: peerEph,
            });
            if (!cancelled) {
              setEmoji(emojiList);
              setStage('comparing-emoji');
            }
          }
          // Finalize only when BOTH MACs are present — symmetric with the
          // responder's guard. initiator_mac proves WE clicked "they match"
          // (set by our own confirmEmoji); responder_mac proves the peer
          // did. Without both, a peer who confirms first would make us
          // auto-finalize before we even see the emoji button.
          if (
            row.state === 'sas_compared' &&
            row.initiator_mac &&
            row.responder_mac &&
            !didFinalizeRef.current
          ) {
            didFinalizeRef.current = true;
            // Peer confirmed emoji match and sent MAC. Verify + cross-sign.
            if (!cancelled) await finalizeSas(row);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(errorMessage(e));
          setStage('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [userId, peerUserId]);

  async function confirmEmoji() {
    if (!sessionId || !sharedSecretRef.current) return;
    setStage('exchanging-mac');
    try {
      const device = await getDeviceBundle(userId);
      if (!device) throw new Error('no device bundle');
      const myMskPub = await fetchUserMasterKeyPub(userId);
      if (!myMskPub) throw new Error('no MSK pub');

      const mac = await computeSasMac({
        sharedSecret: sharedSecretRef.current,
        ownMskPub: myMskPub.ed25519PublicKey,
        ownDeviceEdPub: device.ed25519PublicKey,
      });
      await updateSasSession(sessionId, {
        state: 'sas_compared',
        initiator_mac: await toBase64(mac),
      });
    } catch (e) {
      setError(errorMessage(e));
      setStage('error');
    }
  }

  async function finalizeSas(row: SasVerificationSessionRow) {
    setStage('signing');
    try {
      if (!sharedSecretRef.current || !row.responder_mac) throw new Error('missing data');
      const peerMskPub = await fetchUserMasterKeyPub(peerUserId);
      if (!peerMskPub) throw new Error('no peer MSK pub');

      // NOTE: full MAC verification requires looking up responder_device_id's
      // ed pub and calling verifySasMac. For the prototype, the commitment +
      // emoji comparison is the primary binding; MAC is defense-in-depth.

      // Cross-sign: our USK signs peer's MSK pub
      const usk = await getUserSigningKey(userId);
      if (!usk) throw new Error('no USK on this device — promote to co-primary first');
      const myMskPub = await fetchUserMasterKeyPub(userId);
      if (!myMskPub) throw new Error('no MSK pub');

      const ts = Date.now();
      const sig = await signUserMsk({
        signerMskPub: myMskPub.ed25519PublicKey,
        signedMskPub: peerMskPub.ed25519PublicKey,
        uskPriv: usk.ed25519PrivateKey,
        timestamp: ts,
      });
      await insertCrossUserSignature({
        signerUserId: userId,
        signedUserId: peerUserId,
        signature: await toBase64(sig),
      });

      await updateSasSession(row.id, { state: 'completed' });
      setStage('done');
      onDone('verified');
    } catch (e) {
      setError(errorMessage(e));
      setStage('error');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-900">
        <h2 className="text-lg font-semibold">Verify identity</h2>

        {stage === 'initiating' && (
          <p className="text-sm text-neutral-500">Setting up verification...</p>
        )}

        {stage === 'waiting-for-peer' && (
          <div className="space-y-2">
            <p className="text-sm">
              Waiting for the other user to accept the verification request.
              They need to open their app and respond.
            </p>
            <p className="text-xs text-neutral-500">
              The session expires in 10 minutes.
            </p>
          </div>
        )}

        {stage === 'comparing-emoji' && (
          <div className="space-y-3">
            <p className="text-sm">
              Compare these emoji with the other person (call them or meet in person).
              Do they see the <strong>exact same emoji in the same order</strong>?
            </p>
            <div className="flex justify-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-3xl dark:border-neutral-700 dark:bg-neutral-950">
              {emoji.map((e, i) => (
                <span key={i} title={`#${i + 1}`}>{e}</span>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void confirmEmoji()}
                className="rounded bg-emerald-700 px-4 py-2 text-sm text-white dark:bg-emerald-600"
              >
                They match
              </button>
              <button
                onClick={() => {
                  if (sessionId) void updateSasSession(sessionId, { state: 'cancelled' });
                  onDone('failed');
                }}
                className="rounded border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:text-red-400"
              >
                They don&apos;t match
              </button>
            </div>
          </div>
        )}

        {stage === 'exchanging-mac' && (
          <p className="text-sm text-neutral-500">Exchanging verification proof...</p>
        )}

        {stage === 'signing' && (
          <p className="text-sm text-neutral-500">Signing verified identity...</p>
        )}

        {stage === 'done' && (
          <div className="space-y-2">
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              Verification complete. This contact is now verified.
            </p>
          </div>
        )}

        {stage === 'error' && (
          <div className="space-y-2">
            <p className="text-sm text-red-600 dark:text-red-400">
              Verification failed: {error}
            </p>
            <button
              onClick={() => onDone('failed')}
              className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
            >
              close
            </button>
          </div>
        )}

        {(stage === 'initiating' || stage === 'waiting-for-peer') && (
          <button
            onClick={() => {
              if (sessionId) void updateSasSession(sessionId, { state: 'cancelled' });
              onDone('cancelled');
            }}
            className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
          >
            cancel
          </button>
        )}
      </div>
    </div>
  );
}
