/**
 * High-level device-enrollment helpers (v3, per-device identities).
 *
 * These sit above `e2ee-core` and the Supabase query layer. They exist so
 * every caller that needs to "become a functional device for this user" goes
 * through the same code path: auth callback first-sign-in, recovery-based
 * device add, or a reset flow.
 */

import {
  encryptDeviceDisplayName,
  filterActiveDevices,
  generateDeviceKeyBundle,
  generateUserMasterKey,
  getDeviceBundle,
  getDeviceRecord,
  getUserMasterKey,
  putDeviceBundle,
  putDeviceRecord,
  putUserMasterKey,
  signDeviceIssuance,
  verifyPublicDevice,
  type DeviceKeyBundle,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { getSupabase } from '@/lib/supabase/client';
import {
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  publishUserMasterKey,
  registerDevice,
} from '@/lib/supabase/queries';
import { toBase64 } from '@/lib/e2ee-core';

export function inferDeviceName(): string {
  if (typeof navigator === 'undefined') return 'device';
  const ua = navigator.userAgent;
  if (/Mobile|Android|iPhone|iPad/i.test(ua)) return 'Mobile browser';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'Browser';
}

export interface EnrolledDevice {
  userId: string;
  deviceBundle: DeviceKeyBundle;
  /** Present only when this device holds UMK (first-sign-in or recovery). */
  umk: UserMasterKey | null;
}

/**
 * First-ever sign-in for a user: generate UMK + device bundle locally, sign
 * the device's issuance cert with UMK, publish UMK pub, register the device.
 */
export async function bootstrapNewUser(userId: string): Promise<EnrolledDevice> {
  const umk = await generateUserMasterKey();
  const deviceId = crypto.randomUUID();
  const bundle = await generateDeviceKeyBundle(deviceId);
  const createdAtMs = Date.now();
  const issuanceSignature = await signDeviceIssuance(
    {
      userId,
      deviceId,
      deviceEd25519PublicKey: bundle.ed25519PublicKey,
      deviceX25519PublicKey: bundle.x25519PublicKey,
      createdAtMs,
    },
    umk.ed25519PrivateKey,
  );

  await putUserMasterKey(userId, umk);
  await putDeviceBundle(userId, bundle);
  await publishUserMasterKey(userId, { ed25519PublicKey: umk.ed25519PublicKey });
  const displayName = inferDeviceName();
  const displayNameCiphertext = await encryptDeviceDisplayName(
    displayName,
    bundle.x25519PublicKey,
  );
  await registerDevice({
    userId,
    deviceId,
    deviceEd25519Pub: bundle.ed25519PublicKey,
    deviceX25519Pub: bundle.x25519PublicKey,
    issuanceCreatedAtMs: createdAtMs,
    issuanceSignature,
    displayNameCiphertext,
  });
  await putDeviceRecord(userId, deviceId, displayName);

  return { userId, deviceBundle: bundle, umk };
}

/**
 * Enroll a new device using a locally-held UMK (e.g. after a recovery
 * unwrap). Generates a fresh device bundle, signs its cert, writes the
 * server-side device row. The UMK priv is also persisted on this device so
 * the user can continue to add devices from here.
 */
export async function enrollDeviceWithUmk(
  userId: string,
  umk: UserMasterKey,
): Promise<EnrolledDevice> {
  const publishedPub = await fetchUserMasterKeyPub(userId);
  if (!publishedPub) {
    throw new Error('no published UMK for this user; refusing to enroll');
  }
  if (!bytesEq(publishedPub.ed25519PublicKey, umk.ed25519PublicKey)) {
    throw new Error(
      'UMK pub derived locally does not match the published UMK pub — refusing',
    );
  }
  const deviceId = crypto.randomUUID();
  const bundle = await generateDeviceKeyBundle(deviceId);
  const createdAtMs = Date.now();
  const issuanceSignature = await signDeviceIssuance(
    {
      userId,
      deviceId,
      deviceEd25519PublicKey: bundle.ed25519PublicKey,
      deviceX25519PublicKey: bundle.x25519PublicKey,
      createdAtMs,
    },
    umk.ed25519PrivateKey,
  );

  await putUserMasterKey(userId, umk);
  await putDeviceBundle(userId, bundle);
  const displayName = inferDeviceName();
  const displayNameCiphertext = await encryptDeviceDisplayName(
    displayName,
    bundle.x25519PublicKey,
  );
  await registerDevice({
    userId,
    deviceId,
    deviceEd25519Pub: bundle.ed25519PublicKey,
    deviceX25519Pub: bundle.x25519PublicKey,
    issuanceCreatedAtMs: createdAtMs,
    issuanceSignature,
    displayNameCiphertext,
  });
  await putDeviceRecord(userId, deviceId, displayName);

  return { userId, deviceBundle: bundle, umk };
}

/**
 * Load the locally-enrolled device state. Throws if this device isn't
 * enrolled (caller should route to the linking flow).
 */
export async function loadEnrolledDevice(
  userId: string,
): Promise<EnrolledDevice | null> {
  const bundle = await getDeviceBundle(userId);
  if (!bundle) return null;
  const umk = await getUserMasterKey(userId);
  return { userId, deviceBundle: bundle, umk };
}

/**
 * Fetch + verify the active devices for a user. Rejects devices whose
 * issuance cert doesn't verify against the user's UMK pub, or that are
 * revoked. Returns filtered list.
 */
export async function fetchAndVerifyDevices(userId: string) {
  const umkPub = await fetchUserMasterKeyPub(userId);
  if (!umkPub) return { umkPub: null, devices: [] as Awaited<ReturnType<typeof fetchPublicDevices>> };
  const all = await fetchPublicDevices(userId);
  const active = await filterActiveDevices(all, umkPub.ed25519PublicKey);
  return { umkPub, devices: active };
}

/**
 * Rotate the User Master Key. Generates a fresh UMK, UMK-signs new issuance
 * certs for every current device on the user's account (preserving each
 * device's existing ed/x pubs and created_at — only the cert signature
 * changes), publishes the new UMK pub (which trips the identity_epoch
 * bump trigger), and writes the new certs back to the devices rows.
 *
 * Side-effect: every OTHER device on this account becomes an orphan. Their
 * locally-cached UMK pub is stale, so on next app load the AppShell sanity
 * check will sign them out. They must re-enrol via approval (from this
 * device, now holding the new UMK) or via the new recovery phrase.
 *
 * Must be called from a device that currently holds the UMK priv.
 */
export async function rotateUserMasterKey(
  userId: string,
  oldUmk: UserMasterKey,
): Promise<UserMasterKey> {
  // Sanity: make sure the caller really has the current UMK priv. We derive
  // the pub from the priv and compare to published — if they differ, we're
  // already on a fork.
  const publishedOld = await fetchUserMasterKeyPub(userId);
  if (!publishedOld) throw new Error('no published UMK — nothing to rotate');
  if (!bytesEq(publishedOld.ed25519PublicKey, oldUmk.ed25519PublicKey)) {
    throw new Error(
      'local UMK does not match published UMK — refusing to rotate from a stale copy',
    );
  }

  // Fetch + verify all current devices under the OLD UMK. Revoked/broken
  // ones are skipped so we don't re-issue certs for ghost rows.
  const activeDevices = await filterActiveDevices(
    await fetchPublicDevices(userId),
    oldUmk.ed25519PublicKey,
  );
  if (activeDevices.length === 0) {
    throw new Error('no active devices to re-sign — rotation aborted');
  }

  const newUmk = await generateUserMasterKey();

  // Re-sign each device's issuance cert with the new UMK priv, keeping
  // everything else about the device stable.
  const reissued = await Promise.all(
    activeDevices.map(async (d) => {
      const sig = await signDeviceIssuance(
        {
          userId,
          deviceId: d.deviceId,
          deviceEd25519PublicKey: d.ed25519PublicKey,
          deviceX25519PublicKey: d.x25519PublicKey,
          createdAtMs: d.createdAtMs,
        },
        newUmk.ed25519PrivateKey,
      );
      return { deviceId: d.deviceId, issuanceSignature: sig };
    }),
  );

  // Publish the new UMK pub. The bump_identity_epoch trigger fires on this
  // UPDATE (ed25519_pub changed), so every stale client that caches a
  // previous epoch will be detectable.
  await publishUserMasterKey(userId, { ed25519PublicKey: newUmk.ed25519PublicKey });

  // Write the new issuance signatures back to the device rows. Each row is
  // this user's own, so RLS (devices_update_self) permits the updates. We
  // issue them in parallel — any individual failure leaves the account in
  // a partially-rotated state, which the next rotation will converge.
  const supabase = getSupabase();
  await Promise.all(
    reissued.map(async ({ deviceId, issuanceSignature }) => {
      const { error } = await supabase
        .from('devices')
        .update({ issuance_signature: await toBase64(issuanceSignature) })
        .eq('id', deviceId);
      if (error) throw error;
    }),
  );

  // Replace the locally-held UMK with the new one.
  await putUserMasterKey(userId, newUmk);

  return newUmk;
}

export { getDeviceRecord, verifyPublicDevice };

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
