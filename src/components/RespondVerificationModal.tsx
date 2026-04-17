'use client';

/**
 * SAS verification wizard — responder side.
 *
 * When another user initiates a verification session targeting us, this
 * modal drives the responder half:
 *   1. Generate ephemeral X25519, send eb_pub
 *   2. Wait for initiator to reveal ea_pub
 *   3. Verify commitment = SHA256(ea_pub || initiator_device_ed_pub)
 *   4. Derive shared secret + emoji
 *   5. User confirms emoji match
 *   6. Send MAC, wait for initiator MAC
 *   7. Cross-sign initiator's MSK pub with our USK
 */

import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';
import {
  computeSasMac,
  computeSasSharedSecret,
  deriveSasEmoji,
  fromBase64,
  getDeviceBundle,
  getSodium,
  getUserSigningKey,
  signUserMsk,
  toBase64,
  verifySasCommitment,
  type Bytes,
} from '@/lib/e2ee-core';
import {
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  getSasSession,
  insertCrossUserSignature,
  subscribeSasSessions,
  updateSasSession,
  type SasVerificationSessionRow,
} from '@/lib/supabase/queries';

interface Props {
  userId: string;
  session: SasVerificationSessionRow;
  onDone: (result: 'verified' | 'cancelled' | 'failed') => void;
}

type Stage =
  | 'accepting'
  | 'waiting-for-reveal'
  | 'comparing-emoji'
  | 'exchanging-mac'
  | 'waiting-for-initiator-mac'
  | 'signing'
  | 'done'
  | 'error';

export function RespondVerificationModal({ userId, session, onDone }: Props) {
  const [stage, setStage] = useState<Stage>('accepting');
  const [emoji, setEmoji] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const ephemeralRef = useRef<{ pub: Bytes; priv: Bytes } | null>(null);
  const sharedSecretRef = useRef<Bytes | null>(null);
  const commitmentRef = useRef<Bytes | null>(null);
  const ranRef = useRef(false);
  // Idempotency guards so repeat events (own UPDATE triggers another tick,
  // poller + realtime both fire for same row) don't re-run side-effectful
  // stages. Closure-captured `stage` and `emoji.length` are stale.
  const didDeriveRef = useRef(false);
  const didFinalizeRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let unsub: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const device = await getDeviceBundle(userId);
        if (!device) throw new Error('no device bundle');
        const sodium = await getSodium();

        // Save the initiator's commitment for later verification
        if (!session.initiator_commitment) throw new Error('session has no commitment');
        commitmentRef.current = await fromBase64(session.initiator_commitment);

        // Generate our ephemeral X25519
        const kp = sodium.crypto_box_keypair();
        ephemeralRef.current = { pub: kp.publicKey, priv: kp.privateKey };

        // Send our ephemeral pub + accept
        await updateSasSession(session.id, {
          state: 'key_exchanged',
          responder_device_id: device.deviceId,
          responder_ephemeral_pub: await toBase64(kp.publicKey),
        });
        if (cancelled) return;
        setStage('waiting-for-reveal');

        // Wrap handler so errors surface to UI instead of being swallowed by
        // realtime callback / setInterval (they silently drop rejections).
        const safeHandle = async (row: SasVerificationSessionRow) => {
          try {
            await handleUpdate(row);
          } catch (err) {
            console.error('[sas-responder] handler failed', err);
            if (!cancelled) {
              setError(errorMessage(err));
              setStage('error');
            }
          }
        };

        // Subscribe for initiator's reveal
        unsub = subscribeSasSessions(userId, (row) => {
          if (row.id !== session.id || cancelled) return;
          void safeHandle(row);
        });

        // Poll fallback
        const poller = setInterval(() => {
          if (cancelled) { clearInterval(poller); return; }
          void (async () => {
            try {
              const row = await getSasSession(session.id);
              if (row) await safeHandle(row);
            } catch (err) {
              console.error('[sas-responder] poll failed', err);
            }
          })();
        }, 2000);

        async function handleUpdate(row: SasVerificationSessionRow) {
          if (cancelled) return;

          // Initiator revealed their ephemeral pub → derive emoji.
          // Use a ref guard (closure-captured `stage` / `emoji.length` are
          // stale, and we'd otherwise re-run on every duplicate event).
          if (row.initiator_ephemeral_pub && !didDeriveRef.current) {
            didDeriveRef.current = true;
            const eph = ephemeralRef.current;
            const commitment = commitmentRef.current;
            if (!eph || !commitment) {
              throw new Error('missing ephemeral keypair or commitment');
            }

            const initiatorEph = await fromBase64(row.initiator_ephemeral_pub);

            // Verify commitment: SHA256(ea_pub || initiator_device_ed_pub) == commitment
            const initiatorDevices = await fetchPublicDevices(session.initiator_user_id);
            const initiatorDevice = initiatorDevices.find(
              (d) => d.deviceId === session.initiator_device_id,
            );
            if (!initiatorDevice) throw new Error('initiator device not found');

            const commitmentValid = await verifySasCommitment(
              commitment,
              initiatorEph,
              initiatorDevice.ed25519PublicKey,
            );
            if (!commitmentValid) {
              throw new Error(
                'commitment verification failed — possible MITM attack. Aborting.',
              );
            }

            const shared = await computeSasSharedSecret(eph.priv, initiatorEph);
            sharedSecretRef.current = shared;

            const myMskPub = await fetchUserMasterKeyPub(userId);
            const peerMskPub = await fetchUserMasterKeyPub(session.initiator_user_id);
            if (!myMskPub || !peerMskPub) throw new Error('MSK pubs not found');

            // IMPORTANT: emoji derivation uses the same alice/bob ordering as
            // the initiator. The initiator is always "alice".
            const emojiList = await deriveSasEmoji({
              sharedSecret: shared,
              aliceMskPub: peerMskPub.ed25519PublicKey, // initiator = alice
              bobMskPub: myMskPub.ed25519PublicKey,     // responder = bob
              aliceEphemeralPub: initiatorEph,
              bobEphemeralPub: eph.pub,
            });
            if (!cancelled) {
              setEmoji(emojiList);
              setStage('comparing-emoji');
            }
          }

          // Finalize only when BOTH MACs are present. row.initiator_mac means
          // the initiator confirmed emoji; row.responder_mac means WE (the
          // responder) have confirmed too (set in our own confirmEmoji). If
          // we finalize on initiator_mac alone we silently skip the
          // responder's "they match" click — user-visible bug was: responder
          // modal auto-closes as soon as initiator confirms, responder never
          // sends responder_mac, initiator stalls forever on exchanging-mac.
          if (
            row.state === 'sas_compared' &&
            row.initiator_mac &&
            row.responder_mac &&
            sharedSecretRef.current &&
            !didFinalizeRef.current
          ) {
            didFinalizeRef.current = true;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmEmoji() {
    if (!sharedSecretRef.current) return;
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
      await updateSasSession(session.id, {
        state: 'sas_compared',
        responder_mac: await toBase64(mac),
      });
      setStage('waiting-for-initiator-mac');
    } catch (e) {
      setError(errorMessage(e));
      setStage('error');
    }
  }

  async function finalizeSas(row: SasVerificationSessionRow) {
    setStage('signing');
    try {
      const peerMskPub = await fetchUserMasterKeyPub(session.initiator_user_id);
      if (!peerMskPub) throw new Error('no peer MSK pub');

      const usk = await getUserSigningKey(userId);
      if (!usk) throw new Error('no USK — promote to co-primary first');
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
        signedUserId: session.initiator_user_id,
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
        <h2 className="text-lg font-semibold">Verification request</h2>

        {stage === 'accepting' && (
          <p className="text-sm text-neutral-500">Accepting verification...</p>
        )}

        {stage === 'waiting-for-reveal' && (
          <p className="text-sm text-neutral-500">
            Waiting for the other person to continue...
          </p>
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
                  void updateSasSession(session.id, { state: 'cancelled' });
                  onDone('failed');
                }}
                className="rounded border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:text-red-400"
              >
                They don&apos;t match
              </button>
            </div>
          </div>
        )}

        {(stage === 'exchanging-mac' || stage === 'waiting-for-initiator-mac') && (
          <p className="text-sm text-neutral-500">Exchanging verification proof...</p>
        )}

        {stage === 'signing' && (
          <p className="text-sm text-neutral-500">Signing verified identity...</p>
        )}

        {stage === 'done' && (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            Verification complete. This contact is now verified.
          </p>
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

        {(stage === 'accepting' || stage === 'waiting-for-reveal') && (
          <button
            onClick={() => {
              void updateSasSession(session.id, { state: 'cancelled' });
              onDone('cancelled');
            }}
            className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
          >
            decline
          </button>
        )}
      </div>
    </div>
  );
}
