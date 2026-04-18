/**
 * High-level device-enrollment helpers (v3, per-device identities).
 *
 * These sit above `e2ee-core` and the Supabase query layer. They exist so
 * every caller that needs to "become a functional device for this user" goes
 * through the same code path: auth callback first-sign-in, recovery-based
 * device add, or a reset flow.
 */

import {
  decryptRoomName,
  encryptDeviceDisplayName,
  encryptRoomName,
  encryptRoomKeyForBackup,
  filterActiveDevices,
  fromBase64,
  generateCallKey,
  generateSigningKeys,
  getBackupKey,
  generateDeviceKeyBundle,
  generateUserMasterKey,
  getDeviceBundle,
  getDeviceRecord,
  getUserMasterKey,
  putDeviceBundle,
  putDeviceRecord,
  putSelfSigningKey,
  putUserMasterKey,
  putUserSigningKey,
  rotateRoomKey,
  signDeviceIssuanceV2,
  signDeviceRevocationV2,
  signInviteEnvelope,
  signMembershipWrap,
  toBase64,
  unwrapRoomKey,
  verifyMembershipWrap,
  unwrapCallKey,
  verifySskCrossSignature,
  verifyCallEnvelope,
  verifyPublicDevice,
  wrapAndSignCallEnvelope,
  wrapRoomKeyFor,
  zeroCallKey,
  createOutboundSession,
  exportSessionSnapshot,
  getInboundSession,
  putInboundSession,
  sealSessionSnapshot,
  signSessionShare,
  unsealSessionSnapshot,
  getOutboundSession,
  putOutboundSession,
  shouldRotateSession,
  type AutoRotationConfig,
  type CallKey,
  type DeviceKeyBundle,
  type InboundSessionSnapshot,
  type RoomKey,
  type OutboundMegolmSession,
  type PublicDevice,
  type SelfSigningKey,
  type UserMasterKey,
  type UserSigningKey,
} from '@/lib/e2ee-core';
import { getSupabase } from '@/lib/supabase/client';
import { errorMessage } from '@/lib/errors';
import { broadcastIdentityChange } from '@/lib/tab-sync';
import {
  addRoomMember,
  createInvite,
  fetchDeviceEd25519PubsByIds,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  fetchCallKeyEnvelope,
  getMyRoomKeyRow,
  getMyWrappedRoomKey,
  insertMegolmSession,
  listKeyBackups,
  insertMegolmSessionShare,
  kickAndRotate,
  listCallMembers,
  listDevices,
  listRoomMembers,
  publishUserMasterKey,
  registerDevice,
  rotateCallKey as rpcRotateCallKey,
  startCall as rpcStartCall,
  upsertKeyBackup,
  fetchMegolmSessionInfo,
  fetchSessionInfoFromBlobs,
  fetchMegolmShareForSession,
  listKeyForwardRequestsForUser,
  deleteKeyForwardRequest,
  type CallEnvelopeInput,
  type RoomRow,
} from '@/lib/supabase/queries';

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
 * First-ever sign-in for a user: generate MSK + SSK + USK + device bundle,
 * sign the device's issuance cert with SSK, publish all identity keys,
 * register the device.
 */
export async function bootstrapNewUser(userId: string): Promise<EnrolledDevice> {
  const umk = await generateUserMasterKey();
  const { ssk, usk, sskCrossSignature, uskCrossSignature } =
    await generateSigningKeys(umk);

  const deviceId = crypto.randomUUID();
  const bundle = await generateDeviceKeyBundle(deviceId);
  const createdAtMs = Date.now();
  // Sign with SSK (v2 cert) — cross-sig chain: device ← SSK ← MSK
  const issuanceSignature = await signDeviceIssuanceV2(
    {
      userId,
      deviceId,
      deviceEd25519PublicKey: bundle.ed25519PublicKey,
      deviceX25519PublicKey: bundle.x25519PublicKey,
      createdAtMs,
    },
    ssk.ed25519PrivateKey,
  );

  await putUserMasterKey(userId, umk);
  await putSelfSigningKey(userId, ssk);
  await putUserSigningKey(userId, usk);
  await putDeviceBundle(userId, bundle);
  await publishUserMasterKey(
    userId,
    { ed25519PublicKey: umk.ed25519PublicKey },
    {
      sskPub: ssk.ed25519PublicKey,
      sskCrossSignature,
      uskPub: usk.ed25519PublicKey,
      uskCrossSignature,
    },
  );
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
 * Enroll a new device using a locally-held MSK (e.g. after a recovery
 * unwrap). Generates a fresh device bundle, signs its cert with SSK,
 * writes the server-side device row. If SSK/USK privs are provided
 * (v4 recovery blob), they're reused; otherwise fresh ones are generated
 * and the identity row is updated with the new cross-sigs.
 */
export async function enrollDeviceWithUmk(
  userId: string,
  umk: UserMasterKey,
  opts?: { ssk?: SelfSigningKey; usk?: UserSigningKey },
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

  // Resolve or generate SSK + USK
  let ssk = opts?.ssk ?? null;
  let usk = opts?.usk ?? null;
  if (!ssk || !usk) {
    // No SSK/USK from recovery blob (v2/v3 blob) — generate fresh ones
    // and publish them. This is a one-time upgrade path.
    const keys = await generateSigningKeys(umk);
    ssk = keys.ssk;
    usk = keys.usk;
    await publishUserMasterKey(
      userId,
      { ed25519PublicKey: umk.ed25519PublicKey },
      {
        sskPub: ssk.ed25519PublicKey,
        sskCrossSignature: keys.sskCrossSignature,
        uskPub: usk.ed25519PublicKey,
        uskCrossSignature: keys.uskCrossSignature,
      },
    );
  }

  const deviceId = crypto.randomUUID();
  const bundle = await generateDeviceKeyBundle(deviceId);
  const createdAtMs = Date.now();
  const issuanceSignature = await signDeviceIssuanceV2(
    {
      userId,
      deviceId,
      deviceEd25519PublicKey: bundle.ed25519PublicKey,
      deviceX25519PublicKey: bundle.x25519PublicKey,
      createdAtMs,
    },
    ssk.ed25519PrivateKey,
  );

  await putUserMasterKey(userId, umk);
  await putSelfSigningKey(userId, ssk);
  await putUserSigningKey(userId, usk);
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

  // Opportunistic pickup: if this device is missing SSK or backup key in IDB,
  // fetch the device row once and unseal whatever is available.
  // Covers devices approved before cross-signing was deployed, or where the
  // initial pickup in the auth callback failed/was swallowed.
  const { getSelfSigningKey: localSsk } = await import('@/lib/e2ee-core');
  const needsSsk = !(await localSsk(userId));
  const needsBk = !(await getBackupKey(userId));

  if (needsSsk || needsBk) {
    try {
      const rows = await listDevices(userId);
      const myRow = rows.find((r) => r.id === bundle.deviceId);
      const {
        fromBase64: b64d, getSodium,
        putSelfSigningKey, putUserSigningKey, putBackupKey: storeBk,
      } = await import('@/lib/e2ee-core');
      const sodium = await getSodium();

      if (needsSsk && myRow?.signing_key_wrap) {
        try {
          const sealed = await b64d(myRow.signing_key_wrap);
          const packed = sodium.crypto_box_seal_open(
            sealed, bundle.x25519PublicKey, bundle.x25519PrivateKey,
          );
          const sskPriv = packed.slice(0, 64);
          const uskPriv = packed.slice(64, 128);
          const sskPub = sodium.crypto_sign_ed25519_sk_to_pk(sskPriv);
          const uskPub = sodium.crypto_sign_ed25519_sk_to_pk(uskPriv);
          sodium.memzero(packed);
          await putSelfSigningKey(userId, { ed25519PublicKey: sskPub, ed25519PrivateKey: sskPriv });
          await putUserSigningKey(userId, { ed25519PublicKey: uskPub, ed25519PrivateKey: uskPriv });
          const supabase = (await import('@/lib/supabase/client')).getSupabase();
          await supabase.from('devices').update({ signing_key_wrap: null }).eq('id', bundle.deviceId);
        } catch (err) {
          console.warn('opportunistic SSK pickup failed:', err);
        }
      }

      if (needsBk && myRow?.backup_key_wrap) {
        try {
          const sealed = await b64d(myRow.backup_key_wrap);
          const bk = sodium.crypto_box_seal_open(
            sealed, bundle.x25519PublicKey, bundle.x25519PrivateKey,
          );
          await storeBk(userId, bk);
          console.log('opportunistic backup key pickup succeeded');
        } catch (err) {
          console.warn('opportunistic backup key pickup failed:', err);
        }
      }
    } catch (err) {
      console.warn('opportunistic key pickup failed:', err);
    }
  }

  return { userId, deviceBundle: bundle, umk };
}

/**
 * Fetch + verify the active devices for a user. Verifies device certs via
 * the MSK→SSK cross-sig chain when SSK is published; falls back to v1
 * (MSK-direct) certs otherwise. Returns filtered list.
 */
export async function fetchAndVerifyDevices(userId: string) {
  const umkPub = await fetchUserMasterKeyPub(userId);
  if (!umkPub) return { umkPub: null, devices: [] as Awaited<ReturnType<typeof fetchPublicDevices>> };
  // Verify SSK cross-sig if published; pass SSK pub for v2 cert verification.
  let sskPub: Uint8Array | undefined;
  if (umkPub.sskPub && umkPub.sskCrossSignature) {
    try {
      await verifySskCrossSignature(
        umkPub.ed25519PublicKey,
        umkPub.sskPub,
        umkPub.sskCrossSignature,
      );
      sskPub = umkPub.sskPub;
    } catch {
      // SSK cross-sig invalid — fall back to MSK-only verification
    }
  }
  const all = await fetchPublicDevices(userId);
  const active = await filterActiveDevices(all, umkPub.ed25519PublicKey, sskPub);
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
/** Result of the generate-only half of MSK rotation. */
export interface RotatedUmkResult {
  newUmk: UserMasterKey;
  newSsk: SelfSigningKey;
  newUsk: UserSigningKey;
  sskCrossSignature: Uint8Array;
  uskCrossSignature: Uint8Array;
  reissuedCerts: Array<{ deviceId: string; issuanceSignature: Uint8Array }>;
  /**
   * New-SSK-signed revocation certs for devices the caller opted to expel
   * during rotation. Empty on the default (re-sign everyone) path. Populated
   * only when `options.devicesToRevoke` is passed — the ghost-device picker
   * UX uses this to expel devices the user doesn't recognize.
   */
  revocations: Array<{
    deviceId: string;
    revokedAtMs: number;
    signature: Uint8Array;
  }>;
}

/**
 * Generate a fresh MSK + SSK + USK and re-sign active device issuance certs
 * with the new SSK. Pure computation — no server writes, no local saves.
 * Callers use it with `commitRotatedUmk` to control the escrow → save →
 * publish ordering (SSSS pattern).
 *
 * `options.devicesToRevoke` opts into the ghost-device picker model: listed
 * device IDs get a fresh SSK-signed revocation cert INSTEAD of a reissued
 * issuance cert. Kept devices get a new issuance cert as before. The caller
 * is responsible for keeping the current (acting) device OUT of the revoke
 * list — this helper does not assert that by itself, since it doesn't know
 * which device is "current".
 */
export async function generateRotatedUmk(
  userId: string,
  oldUmk: UserMasterKey,
  options?: { devicesToRevoke?: string[] },
): Promise<RotatedUmkResult> {
  const publishedOld = await fetchUserMasterKeyPub(userId);
  if (!publishedOld) throw new Error('no published UMK — nothing to rotate');
  if (!bytesEq(publishedOld.ed25519PublicKey, oldUmk.ed25519PublicKey)) {
    throw new Error(
      'local UMK does not match published UMK — refusing to rotate from a stale copy',
    );
  }

  // Verify old devices using SSK if available for backward-compat dispatch
  let oldSskPub: Uint8Array | undefined;
  if (publishedOld.sskPub && publishedOld.sskCrossSignature) {
    try {
      await verifySskCrossSignature(
        publishedOld.ed25519PublicKey,
        publishedOld.sskPub,
        publishedOld.sskCrossSignature,
      );
      oldSskPub = publishedOld.sskPub;
    } catch { /* fall back to MSK-only */ }
  }

  const activeDevices = await filterActiveDevices(
    await fetchPublicDevices(userId),
    oldUmk.ed25519PublicKey,
    oldSskPub,
  );
  if (activeDevices.length === 0) {
    throw new Error('no active devices to re-sign — rotation aborted');
  }

  const newUmk = await generateUserMasterKey();
  const { ssk: newSsk, usk: newUsk, sskCrossSignature, uskCrossSignature } =
    await generateSigningKeys(newUmk);

  const toRevoke = new Set(options?.devicesToRevoke ?? []);
  const kept = activeDevices.filter((d) => !toRevoke.has(d.deviceId));
  if (kept.length === 0) {
    throw new Error(
      'rotation would leave zero active devices — refusing. Keep at least the current device.',
    );
  }

  // Re-sign kept device certs with the new SSK (v2 domain)
  const reissuedCerts = await Promise.all(
    kept.map(async (d) => {
      const sig = await signDeviceIssuanceV2(
        {
          userId,
          deviceId: d.deviceId,
          deviceEd25519PublicKey: d.ed25519PublicKey,
          deviceX25519PublicKey: d.x25519PublicKey,
          createdAtMs: d.createdAtMs,
        },
        newSsk.ed25519PrivateKey,
      );
      return { deviceId: d.deviceId, issuanceSignature: sig };
    }),
  );

  // Sign revocations for expelled devices with the new SSK so the cert
  // chain resolves post-commit. Using old SSK here would leave the
  // revocation signature stranded (old SSK cross-sig gets replaced).
  const revokedAtMs = Date.now();
  const revocations = await Promise.all(
    activeDevices
      .filter((d) => toRevoke.has(d.deviceId))
      .map(async (d) => {
        const sig = await signDeviceRevocationV2(
          { userId, deviceId: d.deviceId, revokedAtMs },
          newSsk.ed25519PrivateKey,
        );
        return { deviceId: d.deviceId, revokedAtMs, signature: sig };
      }),
  );

  return {
    newUmk,
    newSsk,
    newUsk,
    sskCrossSignature,
    uskCrossSignature,
    reissuedCerts,
    revocations,
  };
}

/**
 * Publish a previously-generated identity key set: update the identities
 * row (which triggers identity_epoch bump), write re-issued device certs,
 * and save the new keys to local IDB.
 *
 * MUST be called AFTER the recovery blob has been committed (SSSS
 * pattern: escrow before publish). Otherwise a crash between publish
 * and save leaves the user locked out.
 */
export async function commitRotatedUmk(
  userId: string,
  newUmk: UserMasterKey,
  reissuedCerts: Array<{ deviceId: string; issuanceSignature: Uint8Array }>,
  crossSigning?: {
    ssk: SelfSigningKey;
    usk: UserSigningKey;
    sskCrossSignature: Uint8Array;
    uskCrossSignature: Uint8Array;
  },
  /**
   * Optional: device revocations produced by `generateRotatedUmk` when the
   * caller opted into the ghost-device picker. Written in the same batch as
   * the cert updates.
   */
  revocations?: Array<{
    deviceId: string;
    revokedAtMs: number;
    signature: Uint8Array;
  }>,
): Promise<void> {
  await publishUserMasterKey(
    userId,
    { ed25519PublicKey: newUmk.ed25519PublicKey },
    crossSigning
      ? {
          sskPub: crossSigning.ssk.ed25519PublicKey,
          sskCrossSignature: crossSigning.sskCrossSignature,
          uskPub: crossSigning.usk.ed25519PublicKey,
          uskCrossSignature: crossSigning.uskCrossSignature,
        }
      : undefined,
  );

  const supabase = getSupabase();
  await Promise.all([
    ...reissuedCerts.map(async ({ deviceId, issuanceSignature }) => {
      const { error } = await supabase
        .from('devices')
        .update({ issuance_signature: await toBase64(issuanceSignature) })
        .eq('id', deviceId);
      if (error) throw error;
    }),
    ...(revocations ?? []).map(async ({ deviceId, revokedAtMs, signature }) => {
      const { error } = await supabase
        .from('devices')
        .update({
          revoked_at_ms: revokedAtMs,
          revocation_signature: await toBase64(signature),
        })
        .eq('id', deviceId);
      if (error) throw error;
    }),
  ]);

  await putUserMasterKey(userId, newUmk);
  if (crossSigning) {
    await putSelfSigningKey(userId, crossSigning.ssk);
    await putUserSigningKey(userId, crossSigning.usk);
  }
  // Tell sibling tabs to reload — their in-memory MSK / SSK / USK are now
  // stale and operations using them will fail once the new cert chain
  // replaces the old one on the server. Covers BOTH the rotateUserMasterKey
  // wrapper AND the RecoveryPhraseModal path that calls commitRotatedUmk
  // directly.
  broadcastIdentityChange('msk-rotated', userId);
}

/**
 * Convenience wrapper that calls both halves sequentially — for callers
 * that don't need to interleave escrow between generate and publish.
 * The recovery blob is NOT committed here; callers who need crash safety
 * should use `generateRotatedUmk` + `commitRotatedUmk` directly.
 */
export async function rotateUserMasterKey(
  userId: string,
  oldUmk: UserMasterKey,
): Promise<UserMasterKey> {
  const result = await generateRotatedUmk(userId, oldUmk);
  await putUserMasterKey(userId, result.newUmk);
  await commitRotatedUmk(userId, result.newUmk, result.reissuedCerts, {
    ssk: result.newSsk,
    usk: result.newUsk,
    sskCrossSignature: result.sskCrossSignature,
    uskCrossSignature: result.uskCrossSignature,
  });
  // commitRotatedUmk broadcasts identity-change to sibling tabs.
  return result.newUmk;
}

/**
 * Rotate one room's symmetric key — a "refresh only" variant of
 * kick_and_rotate (no evictees, all current members retained). Each
 * current member's active devices all get freshly-wrapped new-gen keys.
 * Used by `rotateAllRoomsIAdmin` to cascade a UMK rotation into every
 * room the user administrates.
 *
 * Caller must be the room's `created_by` and hold the local device bundle
 * (signs the new membership wraps) + have a current-gen `room_members`
 * row (to unwrap the existing room key for re-encrypting the room name).
 */
async function rotateOneRoomAsAdmin(params: {
  userId: string;
  device: DeviceKeyBundle;
  room: RoomRow;
}): Promise<void> {
  const { device, room } = params;

  const roomKey = await verifyAndUnwrapMyRoomKey({
    roomId: room.id,
    userId: params.userId,
    device,
    generation: room.current_generation,
  });
  if (!roomKey) {
    throw new Error(
      `no current-gen wrapped key on this device for room ${room.id.slice(0, 8)}`,
    );
  }

  const members = await listRoomMembers(room.id);
  const currentMembers = members.filter(
    (m) => m.generation === room.current_generation,
  );
  const keeperUserIds = Array.from(new Set(currentMembers.map((m) => m.user_id)));

  type Target = { userId: string; device: PublicDevice };
  const targets: Target[] = [];
  for (const uid of keeperUserIds) {
    // Treat self the same as any other keeper — wrap for ALL active
    // devices, not just the one performing the rotation.
    const { umkPub: keeperUmk, devices: activeKeeperDevs } =
      await fetchAndVerifyDevices(uid);
    if (!keeperUmk) throw new Error(`no published UMK for keeper ${uid.slice(0, 8)}`);
    if (activeKeeperDevs.length === 0) {
      throw new Error(
        `keeper ${uid.slice(0, 8)} has no active signed devices`,
      );
    }
    for (const d of activeKeeperDevs) targets.push({ userId: uid, device: d });
  }

  const { next, wraps } = await rotateRoomKey(
    roomKey.generation,
    targets.map((t) => t.device.x25519PublicKey),
  );

  let newNameCiphertext: Uint8Array | null = null;
  let newNameNonce: Uint8Array | null = null;
  if (room.name_ciphertext && room.name_nonce) {
    try {
      const oldName = await decryptRoomName({
        ciphertext: await fromBase64(room.name_ciphertext),
        nonce: await fromBase64(room.name_nonce),
        roomId: room.id,
        roomKey,
      });
      if (oldName) {
        const enc = await encryptRoomName({
          name: oldName,
          roomId: room.id,
          roomKey: next,
        });
        newNameCiphertext = enc.ciphertext;
        newNameNonce = enc.nonce;
      }
    } catch {
      // If name re-encrypt fails we clear the ciphertext rather than wedging.
    }
  }

  const wrapSigs = await Promise.all(
    targets.map((t, i) =>
      signMembershipWrap(
        {
          roomId: room.id,
          generation: next.generation,
          memberUserId: t.userId,
          memberDeviceId: t.device.deviceId,
          wrappedRoomKey: wraps[i].wrapped,
          signerDeviceId: device.deviceId,
        },
        device.ed25519PrivateKey,
      ),
    ),
  );

  await kickAndRotate({
    roomId: room.id,
    evicteeUserIds: [],
    oldGeneration: roomKey.generation,
    newGeneration: next.generation,
    wraps: targets.map((t, i) => ({
      userId: t.userId,
      deviceId: t.device.deviceId,
      wrappedRoomKey: wraps[i].wrapped,
      wrapSignature: wrapSigs[i],
    })),
    signerDeviceId: device.deviceId,
    nameCiphertext: newNameCiphertext,
    nameNonce: newNameNonce,
  });
}

/**
 * Cascade a UMK rotation into room rotations for every room the user
 * administrates. Call this AFTER `rotateUserMasterKey` succeeds — each
 * room rotation bumps its generation, replaces its symmetric key, and
 * purges pre-rotation wraps (via kick_and_rotate's `< new_gen - 1`
 * clause). Partial failures are captured per-room so one bad room
 * doesn't abort the others.
 *
 * Known limitation (documented, deferred): if a ghost device was added
 * to this user's account under the old UMK, `rotateUserMasterKey`
 * currently re-signs ALL currently-active devices under the new UMK,
 * including the ghost — so this cascade still wraps new-gen keys for
 * the ghost. The proper fix is an interactive "which devices do you
 * trust?" confirmation during UMK rotation; see follow-ups.
 */
export async function rotateAllRoomsIAdmin(params: {
  userId: string;
  device: DeviceKeyBundle;
}): Promise<{ rotated: number; failures: Array<{ roomId: string; error: string }> }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('created_by', params.userId);
  if (error) throw error;
  const rooms = (data ?? []) as RoomRow[];
  let rotated = 0;
  const failures: Array<{ roomId: string; error: string }> = [];
  for (const room of rooms) {
    try {
      await rotateOneRoomAsAdmin({
        userId: params.userId,
        device: params.device,
        room,
      });
      rotated++;
    } catch (e) {
      failures.push({
        roomId: room.id,
        error: errorMessage(e),
      });
    }
  }
  return { rotated, failures };
}

/**
 * Wrap a room key for EVERY active device the user owns and insert a
 * `room_members` row for each. This is the multi-device-aware replacement
 * for the old pattern of wrapping only for the acting device.
 *
 * Skips devices that already have a row at this generation (idempotent —
 * safe to call even if some devices were already wrapped during rotation
 * or a prior call).
 *
 * `signerDevice` is the local device whose ed25519 priv signs the wraps.
 * Typically the device performing the action (room creation, invite accept).
 */
export async function wrapRoomKeyForAllMyDevices(params: {
  roomId: string;
  userId: string;
  roomKey: { key: Uint8Array; generation: number };
  signerDevice: DeviceKeyBundle;
}): Promise<void> {
  const { roomId, userId, roomKey, signerDevice } = params;

  const { devices: active } = await fetchAndVerifyDevices(userId);
  if (active.length === 0) return;

  for (const dev of active) {
    try {
      // Skip if this device already has a wrap at this generation.
      const existing = await getMyWrappedRoomKey({
        roomId,
        deviceId: dev.deviceId,
        generation: roomKey.generation,
      });
      if (existing) continue;

      const wrap = await wrapRoomKeyFor(roomKey, dev.x25519PublicKey);
      const sig = await signMembershipWrap(
        {
          roomId,
          generation: roomKey.generation,
          memberUserId: userId,
          memberDeviceId: dev.deviceId,
          wrappedRoomKey: wrap.wrapped,
          signerDeviceId: signerDevice.deviceId,
        },
        signerDevice.ed25519PrivateKey,
      );
      await addRoomMember({
        roomId,
        userId,
        deviceId: dev.deviceId,
        generation: roomKey.generation,
        wrappedRoomKey: wrap.wrapped,
        signerDeviceId: signerDevice.deviceId,
        wrapSignature: sig,
      });
    } catch (err) {
      // Per-device failure (e.g. unique constraint race) shouldn't
      // block wrapping for the remaining devices.
      console.warn(
        `wrap for device ${dev.deviceId.slice(0, 8)} in room ${roomId.slice(0, 8)} failed:`,
        errorMessage(err),
      );
    }
  }

  // Server-side key backup: if a backup key is available, encrypt the
  // room key under it and upload. This lets a new device (via recovery
  // phrase or approval-with-backup-key-wrap) restore historical room
  // keys without requiring per-room re-invites.
  try {
    const bk = await getBackupKey(userId);
    if (bk) {
      const { ciphertext, nonce } = await encryptRoomKeyForBackup({
        roomKey,
        backupKey: bk,
        roomId,
      });
      await upsertKeyBackup({
        userId,
        roomId,
        generation: roomKey.generation,
        ciphertext,
        nonce,
      });
    }
  } catch (err) {
    console.warn('key backup upload failed:', errorMessage(err));
  }
}

/**
 * Send an invite to ALL of an invitee's active devices (Matrix-style).
 * Creates one `room_invites` row per device, each sealed to that device's
 * X25519 pub with its own signed envelope. This way the invitee can
 * accept from any device — not just whichever one the inviter happened
 * to pick.
 *
 * The pair-room cap trigger (0007) counts distinct `invited_user_id`,
 * not distinct invite rows, so multiple rows for the same user are safe.
 */
export async function sendInviteToAllDevices(params: {
  roomId: string;
  generation: number;
  roomKey: { key: Uint8Array; generation: number };
  invitedUserId: string;
  invitedActiveDevices: PublicDevice[];
  inviterUserId: string;
  inviterDevice: DeviceKeyBundle;
  expiresAtMs: number;
}): Promise<void> {
  const {
    roomId,
    generation,
    roomKey,
    invitedUserId,
    invitedActiveDevices,
    inviterUserId,
    inviterDevice,
    expiresAtMs,
  } = params;

  for (const dev of invitedActiveDevices) {
    const wrap = await wrapRoomKeyFor(roomKey, dev.x25519PublicKey);
    const sig = await signInviteEnvelope(
      {
        roomId,
        generation,
        invitedUserId,
        invitedDeviceId: dev.deviceId,
        invitedDeviceEd25519PublicKey: dev.ed25519PublicKey,
        invitedDeviceX25519PublicKey: dev.x25519PublicKey,
        wrappedRoomKey: wrap.wrapped,
        inviterUserId,
        inviterDeviceId: inviterDevice.deviceId,
        expiresAtMs,
      },
      inviterDevice.ed25519PrivateKey,
    );
    await createInvite({
      roomId,
      invitedUserId,
      invitedDeviceId: dev.deviceId,
      invitedEd25519Pub: dev.ed25519PublicKey,
      invitedX25519Pub: dev.x25519PublicKey,
      generation,
      wrappedRoomKey: wrap.wrapped,
      createdBy: inviterUserId,
      inviterDeviceId: inviterDevice.deviceId,
      inviterSignature: sig,
      expiresAtMs,
    });
  }
}

// ---------------------------------------------------------------------------
// Call key distribution (v3 video calls — migration 0023 + e2ee-core/call.ts)
// ---------------------------------------------------------------------------

/**
 * Enumerate every active device for every current member of a room, and
 * chain-verify each device's issuance cert against its user's UMK pub.
 * Returns `(userId, device)` pairs suitable for envelope generation.
 *
 * Used by `startCallInRoom` to compute the initial envelope set, and by
 * `rotateCallKeyForCurrentMembers` to compute the re-wrap set.
 */
async function verifiedMemberDevices(roomId: string): Promise<
  Array<{ userId: string; device: PublicDevice }>
> {
  const members = await listRoomMembers(roomId);
  const currentGen = members.reduce((g, m) => Math.max(g, m.generation), 0);
  const uniqueUserIds = Array.from(
    new Set(members.filter((m) => m.generation === currentGen).map((m) => m.user_id)),
  );

  const out: Array<{ userId: string; device: PublicDevice }> = [];
  for (const userId of uniqueUserIds) {
    const { devices } = await fetchAndVerifyDevices(userId);
    for (const d of devices) out.push({ userId, device: d });
  }
  return out;
}

/** Default reconnection-grace window (§6.5). */
export const HEARTBEAT_GRACE_SECONDS = 30;

/**
 * Filter call_members to the subset considered "currently active" — left_at
 * is null AND last_seen_at is within `graceSeconds` of now.
 *
 * Separating stale from left matters because:
 *   - a "left" device is explicitly gone and should be evicted on rotation;
 *   - a "stale" device has dropped a heartbeat but might return within
 *     grace (§6.5) — we don't want to keep rotating on every flap, but we
 *     also don't want them to block rotation permanently.
 *
 * For rotator election we intersect the two: only non-stale, non-left
 * devices can be the rotator. For re-wrapping on rotation we include
 * non-left (including briefly-stale) so returning devices don't have to
 * rejoin from scratch — they were never evicted, only skipped for the
 * election.
 */

// ---------------------------------------------------------------------------
// Megolm session management
// ---------------------------------------------------------------------------

/**
 * Create a new Megolm outbound session for this device in a room, distribute
 * sealed snapshots to all active member devices, and register the session
 * on the server. Stores the outbound session in local IDB.
 */
export async function createAndDistributeSession(params: {
  roomId: string;
  generation: number;
  userId: string;
  device: DeviceKeyBundle;
}): Promise<OutboundMegolmSession> {
  const { roomId, generation, userId, device } = params;
  const session = await createOutboundSession(roomId, generation);
  const sessionIdB64 = await toBase64(session.sessionId);

  // Register the session on the server.
  await insertMegolmSession({
    roomId,
    senderUserId: userId,
    senderDeviceId: device.deviceId,
    sessionId: sessionIdB64,
    generation,
  });

  // Collect all active devices across all room members for this generation.
  const memberRows = await listRoomMembers(roomId);
  const currentGenMembers = memberRows.filter((m) => m.generation === generation);
  const memberUserIds = [...new Set(currentGenMembers.map((m) => m.user_id))];

  for (const uid of memberUserIds) {
    const { devices: activeDevices } = await fetchAndVerifyDevices(uid);
    for (const d of activeDevices) {
      const snapshot = exportSessionSnapshot(session, userId, device.deviceId);
      const sealed = await sealSessionSnapshot(snapshot, d.x25519PublicKey);
      const sig = await signSessionShare({
        sessionId: session.sessionId,
        recipientDeviceId: d.deviceId,
        sealedSnapshot: sealed,
        signerDeviceId: device.deviceId,
        signerEd25519Priv: device.ed25519PrivateKey,
      });
      await insertMegolmSessionShare({
        sessionId: sessionIdB64,
        recipientDeviceId: d.deviceId,
        sealedSnapshot: await toBase64(sealed),
        startIndex: snapshot.startIndex,
        signerDeviceId: device.deviceId,
        shareSignature: await toBase64(sig),
      });
    }
  }

  await putOutboundSession(roomId, device.deviceId, session);

  // Matrix-aligned backup: store the session at its INITIAL index (0) so any
  // device that restores from backup can decrypt ALL messages in this session.
  // We do this once at creation — upsertKeyBackup uses ignoreDuplicates so
  // subsequent calls (e.g. from old code paths) can never overwrite it.
  try {
    const bk = await getBackupKey(userId);
    if (bk) {
      const { encryptSessionSnapshotForBackup } = await import('@/lib/e2ee-core');
      const sessionIdB64 = await toBase64(session.sessionId);
      const enc = await encryptSessionSnapshotForBackup({
        snapshot: {
          chainKeyAtIndex: session.chainKey,
          startIndex: session.messageIndex, // = 0 at session creation
          senderUserId: userId,
          senderDeviceId: device.deviceId,
        },
        sessionId: sessionIdB64,
        backupKey: bk,
        roomId,
      });
      await upsertKeyBackup({
        userId,
        roomId,
        generation,
        ciphertext: await toBase64(enc.ciphertext),
        nonce: await toBase64(enc.nonce),
        sessionId: sessionIdB64,
        startIndex: 0,
      });
    }
  } catch (err) {
    console.warn('Megolm session backup at creation failed:', errorMessage(err));
  }

  return session;
}

/**
 * Re-share all existing Megolm outbound sessions in a room to a newly-joined
 * device. Called after invite acceptance or device approval rewrap so the new
 * device can decrypt messages sent since the last session creation.
 *
 * Only re-shares sessions that THIS device holds (outbound sessions). For
 * sessions owned by other senders, the new device will get them when those
 * senders create their next session (on their next send).
 */
export async function reshareSessionsToDevice(params: {
  roomId: string;
  userId: string;
  signerDevice: DeviceKeyBundle;
  targetDeviceId: string;
  targetX25519Pub: Uint8Array;
}): Promise<void> {
  const { roomId, userId, signerDevice, targetDeviceId, targetX25519Pub } = params;
  const session = await getOutboundSession(roomId, signerDevice.deviceId);
  if (!session) return; // no outbound session for this room on this device

  const snapshot = exportSessionSnapshot(session, userId, signerDevice.deviceId);
  const sealed = await sealSessionSnapshot(snapshot, targetX25519Pub);
  const sessionIdB64 = await toBase64(session.sessionId);
  const sig = await signSessionShare({
    sessionId: session.sessionId,
    recipientDeviceId: targetDeviceId,
    sealedSnapshot: sealed,
    signerDeviceId: signerDevice.deviceId,
    signerEd25519Priv: signerDevice.ed25519PrivateKey,
  });
  await insertMegolmSessionShare({
    sessionId: sessionIdB64,
    recipientDeviceId: targetDeviceId,
    sealedSnapshot: await toBase64(sealed),
    startIndex: snapshot.startIndex,
    signerDeviceId: signerDevice.deviceId,
    shareSignature: await toBase64(sig),
  });
}

/**
 * Ensure there's a fresh (non-rotated) outbound Megolm session for the
 * current room. Creates one if none exists or if auto-rotation triggers.
 * Returns the session for callers to ratchet + encrypt with.
 */
// Track which users have had backup restored this app session so we don't
// re-download and re-decrypt the full key_backup table on every room load.
const _backupRestoredUsers = new Set<string>();

/**
 * Restore Megolm session snapshots from server-side key_backup into local
 * IDB. Called once on device enrollment (or first room load) so this device
 * can decrypt historical v4 messages that were backed up by other devices.
 *
 * Only restores sessions that have a backup_key-encrypted snapshot in
 * key_backup AND the local device holds the backup key.
 * Runs at most once per user per app session (subsequent calls are no-ops).
 */
type BackupRestoreResult = { restored: number; failed: number; roomKeys: Array<{ roomId: string; generation: number; key: Uint8Array }> };

export async function restoreSessionsFromBackup(
  userId: string,
): Promise<BackupRestoreResult> {
  const empty: BackupRestoreResult = { restored: 0, failed: 0, roomKeys: [] };
  if (_backupRestoredUsers.has(userId)) return empty;
  _backupRestoredUsers.add(userId);

  const { getBackupKey: bk, fromBase64: b64d, putInboundSession } =
    await import('@/lib/e2ee-core');
  const backupKey = await bk(userId);
  if (!backupKey) return empty;

  const rows = await listKeyBackups(userId);
  const megolmRows = rows.filter((r) => r.session_id && r.start_index != null);
  const roomKeyRows = rows.filter((r) => !r.session_id);

  const { decryptSessionSnapshotFromBackup, decryptRoomKeyFromBackup } = await import('@/lib/e2ee-core');
  let restored = 0;
  let failed = 0;
  const roomKeys: Array<{ roomId: string; generation: number; key: Uint8Array }> = [];

  for (const row of megolmRows) {
    try {
      const ct = await b64d(row.ciphertext);
      const nonce = await b64d(row.nonce);
      const snapshot = await decryptSessionSnapshotFromBackup({
        ciphertext: ct,
        nonce,
        sessionId: row.session_id!,
        startIndex: row.start_index!,
        backupKey,
        roomId: row.room_id,
      });
      const sessionIdBytes = await b64d(row.session_id!);
      await putInboundSession(row.session_id!, snapshot.senderDeviceId, {
        sessionId: sessionIdBytes,
        chainKeyAtIndex: snapshot.chainKeyAtIndex,
        startIndex: snapshot.startIndex,
        senderUserId: snapshot.senderUserId,
        senderDeviceId: snapshot.senderDeviceId,
      });
      restored++;
    } catch (err) {
      failed++;
      console.warn(
        `session backup restore failed for ${row.room_id.slice(0, 8)} session ${row.session_id?.slice(0, 8)}:`,
        err,
      );
    }
  }

  // Also restore flat-key room keys. These are returned to the caller (loadAll)
  // to merge into byGen so image attachments can decrypt.
  for (const row of roomKeyRows) {
    try {
      const ct = await b64d(row.ciphertext);
      const nonce = await b64d(row.nonce);
      const rk = await decryptRoomKeyFromBackup({
        ciphertext: ct,
        nonce,
        generation: row.generation,
        backupKey,
        roomId: row.room_id,
      });
      roomKeys.push({ roomId: row.room_id, generation: row.generation, key: rk.key as Uint8Array });
    } catch (err) {
      console.warn(
        `room key backup restore failed for ${row.room_id.slice(0, 8)} gen ${row.generation}:`,
        err,
      );
    }
  }

  return { restored, failed, roomKeys };
}

/**
 * Fetch this device's wrapped room key for the given generation, verify the
 * wrap_signature against the signer device's published Ed25519 pub, then
 * unseal the box. Returns null if no row exists. Throws on signature mismatch
 * or decrypt failure so the caller can distinguish "not a member" from
 * "tampered row".
 */
export async function verifyAndUnwrapMyRoomKey(params: {
  roomId: string;
  userId: string;
  device: DeviceKeyBundle;
  generation: number;
}): Promise<RoomKey | null> {
  const { roomId, userId, device, generation } = params;
  const row = await getMyRoomKeyRow({ roomId, deviceId: device.deviceId, generation });
  if (!row) return null;
  if (!row.signer_device_id) {
    throw new Error('wrap signer device was deleted — row unverifiable, rejected');
  }
  const wrapped = await fromBase64(row.wrapped_room_key);
  const signerPubs = await fetchDeviceEd25519PubsByIds([row.signer_device_id]);
  const signerPub = signerPubs.get(row.signer_device_id);
  if (!signerPub) {
    throw new Error(
      `wrap_signature signer ${row.signer_device_id} not found — row rejected`,
    );
  }
  await verifyMembershipWrap(
    {
      roomId,
      generation,
      memberUserId: userId,
      memberDeviceId: device.deviceId,
      wrappedRoomKey: wrapped,
      signerDeviceId: row.signer_device_id,
    },
    await fromBase64(row.wrap_signature),
    signerPub,
  );
  return unwrapRoomKey({ wrapped, generation }, device.x25519PublicKey, device.x25519PrivateKey);
}

/**
 * Check for pending key-forward requests from sibling devices (same user,
 * different device) and respond to each by inserting a megolm_session_share.
 *
 * Called on every room load. If this device has the session in IDB (either as
 * an inbound share or as its own outbound session), it seals and signs a
 * snapshot addressed to the requesting device. The requester picks it up on
 * its next `loadAll` via `listMegolmSharesForDevice` + session hydration.
 */
export async function respondToKeyForwardRequests(
  userId: string,
  device: DeviceKeyBundle,
): Promise<{ fulfilled: number }> {
  const supabase = getSupabase();
  let requests: Awaited<ReturnType<typeof listKeyForwardRequestsForUser>>;
  try {
    requests = await listKeyForwardRequestsForUser(userId);
  } catch {
    return { fulfilled: 0 };
  }
  if (requests.length === 0) return { fulfilled: 0 };

  let fulfilled = 0;
  for (const req of requests) {
    // Skip our own requests — we can't forward to ourselves.
    if (req.requester_device_id === device.deviceId) continue;
    try {
      // Look up session metadata to find the sender device.
      // Primary: megolm_sessions table (exists for sessions created after migration 0027).
      // Fallback: derive sender_device_id + generation from a blob row (covers pre-0027 sessions).
      let sessionInfo = await fetchMegolmSessionInfo(req.session_id).catch(() => null);
      if (!sessionInfo) {
        const blobInfo = await fetchSessionInfoFromBlobs(req.session_id).catch(() => null);
        if (!blobInfo) continue;
        sessionInfo = {
          session_id: req.session_id,
          room_id: req.room_id,
          sender_user_id: '',
          sender_device_id: blobInfo.sender_device_id,
          generation: blobInfo.generation,
        };
      }

      let snapshot: InboundSessionSnapshot | null = null;

      if (sessionInfo.sender_device_id === device.deviceId) {
        // This is OUR outbound session — export from current IDB state.
        // Guard: IDB holds only the latest session per room. If this session
        // was rotated (100 messages / 7 days), the slot holds a different
        // session and we must NOT export it under the requested session_id —
        // that would produce a corrupt share with wrong key material.
        const outbound = await getOutboundSession(sessionInfo.room_id, device.deviceId);
        if (outbound && (await toBase64(outbound.sessionId)) === req.session_id) {
          snapshot = exportSessionSnapshot(outbound, userId, device.deviceId);
        }
        // If IDs don't match the session was rotated; snapshot stays null → skip.
      } else {
        // Inbound session from another sender — IDB first, server fallback.
        snapshot = await getInboundSession(req.session_id, sessionInfo.sender_device_id);
        if (!snapshot) {
          // IDB may be stale (loadAll not run for this room recently). Fetch
          // the share directly from the server and hydrate into IDB so we can
          // forward it now and decode it fast next time.
          try {
            const share = await fetchMegolmShareForSession({
              sessionId: req.session_id,
              recipientDeviceId: device.deviceId,
            });
            if (share) {
              const sealed = await fromBase64(share.sealed_snapshot);
              snapshot = await unsealSessionSnapshot(
                sealed,
                device.x25519PublicKey,
                device.x25519PrivateKey,
              );
              await putInboundSession(req.session_id, sessionInfo.sender_device_id, snapshot);
            }
          } catch {
            // share not available — skip
          }
        }
      }

      if (!snapshot) continue;

      // Fetch requester's X25519 pub to seal the snapshot to them.
      const { data: devRow } = await supabase
        .from('devices')
        .select('device_x25519_pub')
        .eq('id', req.requester_device_id)
        .maybeSingle<{ device_x25519_pub: string }>();
      if (!devRow) continue;

      const requesterX25519Pub = await fromBase64(devRow.device_x25519_pub);
      const sealed = await sealSessionSnapshot(snapshot, requesterX25519Pub);
      const sessionIdBytes = await fromBase64(req.session_id);
      const sig = await signSessionShare({
        sessionId: sessionIdBytes,
        recipientDeviceId: req.requester_device_id,
        sealedSnapshot: sealed,
        signerDeviceId: device.deviceId,
        signerEd25519Priv: device.ed25519PrivateKey,
      });

      // Wrap the room key for the requester BEFORE inserting the session share.
      // Image attachments are room-key-encrypted (not Megolm); inserting the
      // share triggers the requester's subscribeMegolmShares → loadAll, so the
      // room_members row must already exist by the time that loadAll runs.
      try {
        const existingRoomWrap = await getMyWrappedRoomKey({
          roomId: req.room_id,
          deviceId: req.requester_device_id,
          generation: sessionInfo.generation,
        }).catch(() => null);
        if (!existingRoomWrap) {
          const roomKey = await verifyAndUnwrapMyRoomKey({
            roomId: req.room_id,
            userId,
            device,
            generation: sessionInfo.generation,
          }).catch(() => null);
          if (roomKey) {
            const roomWrap = await wrapRoomKeyFor(roomKey, requesterX25519Pub);
            const roomSig = await signMembershipWrap(
              {
                roomId: req.room_id,
                generation: sessionInfo.generation,
                memberUserId: userId,
                memberDeviceId: req.requester_device_id,
                wrappedRoomKey: roomWrap.wrapped,
                signerDeviceId: device.deviceId,
              },
              device.ed25519PrivateKey,
            );
            await addRoomMember({
              roomId: req.room_id,
              userId,
              deviceId: req.requester_device_id,
              generation: sessionInfo.generation,
              wrappedRoomKey: roomWrap.wrapped,
              signerDeviceId: device.deviceId,
              wrapSignature: roomSig,
            });
          }
        }
      } catch {
        // Room key wrap failure is non-fatal — text messages still readable.
      }

      await insertMegolmSessionShare({
        sessionId: req.session_id,
        recipientDeviceId: req.requester_device_id,
        sealedSnapshot: await toBase64(sealed),
        startIndex: snapshot.startIndex,
        signerDeviceId: device.deviceId,
        shareSignature: await toBase64(sig),
      });

      await deleteKeyForwardRequest(req.id).catch(() => {});
      fulfilled++;
    } catch (err) {
      console.warn(`key forward respond failed for request ${req.id.slice(0, 8)}:`, errorMessage(err));
    }
  }
  return { fulfilled };
}

export async function ensureFreshSession(params: {
  roomId: string;
  generation: number;
  userId: string;
  device: DeviceKeyBundle;
  config?: AutoRotationConfig;
}): Promise<OutboundMegolmSession> {
  const { roomId, generation, userId, device, config } = params;
  const existing = await getOutboundSession(roomId, device.deviceId);
  if (existing && existing.generation === generation && !shouldRotateSession(existing, config)) {
    return existing;
  }
  return createAndDistributeSession({ roomId, generation, userId, device });
}

export function filterActiveCallMembers<
  T extends { left_at: string | null; last_seen_at: string },
>(members: T[], graceSeconds = HEARTBEAT_GRACE_SECONDS): T[] {
  const cutoff = Date.now() - graceSeconds * 1000;
  return members.filter((m) => {
    if (m.left_at !== null) return false;
    return Date.parse(m.last_seen_at) >= cutoff;
  });
}

/**
 * Deterministic rotator election (§6.3 of the design doc).
 *
 * Rule: lowest `(joined_at ASC, device_id ASC)` among currently-active
 * members. "Active" = left_at null AND last_seen_at within grace. Pure
 * computation — no coordination. If two nodes compute the same answer,
 * only one wins the `rotate_call_key` RPC thanks to the DB's
 * `new_gen = current + 1` check.
 */
export async function isDesignatedRotator(params: {
  callId: string;
  myDeviceId: string;
  graceSeconds?: number;
}): Promise<boolean> {
  const members = await listCallMembers(params.callId);
  const active = filterActiveCallMembers(members, params.graceSeconds).sort(
    (a, b) => {
      if (a.joined_at !== b.joined_at) return a.joined_at.localeCompare(b.joined_at);
      return a.device_id.localeCompare(b.device_id);
    },
  );
  return active.length > 0 && active[0].device_id === params.myDeviceId;
}

/**
 * Return the device_ids of call_members who have gone stale (past
 * `graceSeconds` since last heartbeat) but haven't formally left.
 * Used by the stale-sweep loop in the call UI: if any are present and
 * this client is the designated rotator, trigger a rotation that
 * excludes them.
 */
export async function listStaleCallDeviceIds(
  callId: string,
  graceSeconds = HEARTBEAT_GRACE_SECONDS,
): Promise<string[]> {
  const members = await listCallMembers(callId);
  const cutoff = Date.now() - graceSeconds * 1000;
  return members
    .filter((m) => m.left_at === null && Date.parse(m.last_seen_at) < cutoff)
    .map((m) => m.device_id);
}

/**
 * Start a new E2EE video call in a room. Generates a CallKey, wraps it to
 * every verified-active member device, signs each envelope with the acting
 * device's ed25519 priv, and atomically creates the call via the
 * `start_call` RPC. Returns the generated call_id and the CallKey so the
 * caller can hand both to the LiveKit adapter.
 */
export async function startCallInRoom(params: {
  roomId: string;
  userId: string;
  device: DeviceKeyBundle;
}): Promise<{ callId: string; callKey: CallKey }> {
  const { roomId, device } = params;
  const callId = crypto.randomUUID();
  const callKey = await generateCallKey(1);

  const targets = await verifiedMemberDevices(roomId);
  if (targets.length === 0) {
    throw new Error('room has no verified-active member devices — cannot start call');
  }

  const envelopes: CallEnvelopeInput[] = [];
  for (const { userId: targetUserId, device: targetDevice } of targets) {
    const env = await wrapAndSignCallEnvelope({
      callKey,
      callId,
      targetDeviceId: targetDevice.deviceId,
      targetX25519PublicKey: targetDevice.x25519PublicKey,
      senderDeviceId: device.deviceId,
      senderDeviceEd25519PrivateKey: device.ed25519PrivateKey,
    });
    envelopes.push({
      targetDeviceId: targetDevice.deviceId,
      targetUserId,
      ciphertext: env.ciphertext,
      signature: env.signature,
    });
  }

  await rpcStartCall({
    callId,
    roomId,
    signerDeviceId: device.deviceId,
    envelopes,
  });

  return { callId, callKey };
}

/**
 * Fetch the envelope addressed to this device at `generation`, verify the
 * sender's signature chain (sender's device cert → sender's UMK), and
 * unwrap the CallKey. Returns `null` if no envelope exists yet (the
 * rotator hasn't included us — caller waits for the next rotation).
 */
export async function fetchAndUnwrapCallKey(params: {
  callId: string;
  generation: number;
  device: DeviceKeyBundle;
}): Promise<CallKey | null> {
  const { callId, generation, device } = params;
  const row = await fetchCallKeyEnvelope({
    callId,
    generation,
    targetDeviceId: device.deviceId,
  });
  if (!row) return null;

  const ciphertext = await fromBase64(row.ciphertext);
  const signature = await fromBase64(row.signature);

  // Resolve + verify the sender device. We fetch the user's UMK pub via
  // the devices row's user_id, then chain-verify the device's issuance cert.
  const supabase = getSupabase();
  const { data: senderRow, error: senderErr } = await supabase
    .from('devices')
    .select('id, user_id, device_ed25519_pub, device_x25519_pub, issuance_created_at_ms, issuance_signature, revoked_at_ms, revocation_signature')
    .eq('id', row.sender_device_id)
    .maybeSingle();
  if (senderErr) throw senderErr;
  if (!senderRow) {
    throw new Error(`unknown sender device ${row.sender_device_id}`);
  }
  // Explicit revocation check before cert verification — defense-in-depth
  // against a future regression where verifyPublicDevice's revocation path
  // is accidentally weakened.
  if (senderRow.revoked_at_ms != null) {
    throw new Error(`sender device ${row.sender_device_id} is revoked`);
  }
  const senderUmk = await fetchUserMasterKeyPub(senderRow.user_id);
  if (!senderUmk) {
    throw new Error(`no UMK for sender user ${senderRow.user_id}`);
  }
  const senderPublicDevice: PublicDevice = {
    deviceId: senderRow.id,
    userId: senderRow.user_id,
    ed25519PublicKey: await fromBase64(senderRow.device_ed25519_pub),
    x25519PublicKey: await fromBase64(senderRow.device_x25519_pub),
    createdAtMs: senderRow.issuance_created_at_ms,
    issuanceSignature: await fromBase64(senderRow.issuance_signature),
    revocation:
      senderRow.revoked_at_ms != null && senderRow.revocation_signature != null
        ? {
            revokedAtMs: senderRow.revoked_at_ms,
            signature: await fromBase64(senderRow.revocation_signature),
          }
        : null,
  };
  // Verify SSK cross-sig for v2 cert dispatch.
  let senderSskPub: Uint8Array | undefined;
  if (senderUmk.sskPub && senderUmk.sskCrossSignature) {
    try {
      await verifySskCrossSignature(
        senderUmk.ed25519PublicKey,
        senderUmk.sskPub,
        senderUmk.sskCrossSignature,
      );
      senderSskPub = senderUmk.sskPub;
    } catch { /* fall back to MSK-only */ }
  }
  // verifyPublicDevice throws on CERT_INVALID or DEVICE_REVOKED — both are
  // "don't trust this envelope." Propagate and let the caller handle.
  await verifyPublicDevice(senderPublicDevice, senderUmk.ed25519PublicKey, senderSskPub);

  await verifyCallEnvelope(
    {
      callId,
      generation,
      targetDeviceId: device.deviceId,
      senderDeviceId: row.sender_device_id,
      ciphertext,
    },
    signature,
    senderPublicDevice.ed25519PublicKey,
  );

  return unwrapCallKey(
    ciphertext,
    generation,
    device.x25519PublicKey,
    device.x25519PrivateKey,
  );
}

/**
 * Rotator-only. Generates a fresh CallKey, wraps it for every active
 * member device (excluding any in `excludeDeviceIds`), and calls
 * `rotate_call_key` RPC. Concurrent rotators lose on the DB's
 * `p_new_gen = current + 1` check — caller should catch and re-read.
 */
export async function rotateCallKeyForCurrentMembers(params: {
  callId: string;
  device: DeviceKeyBundle;
  oldGeneration: number;
  excludeDeviceIds?: string[];
}): Promise<CallKey> {
  const { callId, device, oldGeneration, excludeDeviceIds = [] } = params;
  const newGeneration = oldGeneration + 1;
  const excluded = new Set(excludeDeviceIds);

  // Target set = current active call_members (left_at IS NULL), minus any
  // excluded devices (e.g. the device that just left or was revoked).
  const callMembers = await listCallMembers(callId);
  const activeMemberDeviceIds = new Set(
    callMembers.filter((m) => m.left_at === null).map((m) => m.device_id),
  );

  // Resolve device public material. We need x25519 pubs to wrap + UMK chain
  // to verify each is still trusted. Batch by user_id to avoid N+1 UMK fetches.
  const membersByUser = new Map<string, string[]>();
  for (const m of callMembers) {
    if (m.left_at !== null) continue;
    if (excluded.has(m.device_id)) continue;
    const arr = membersByUser.get(m.user_id) ?? [];
    arr.push(m.device_id);
    membersByUser.set(m.user_id, arr);
  }

  const callKey = await generateCallKey(newGeneration);
  const envelopes: CallEnvelopeInput[] = [];

  for (const [userId, wantedDeviceIds] of membersByUser) {
    const { devices: active } = await fetchAndVerifyDevices(userId);
    if (active.length === 0) continue;
    for (const d of active) {
      if (!wantedDeviceIds.includes(d.deviceId)) continue;
      if (!activeMemberDeviceIds.has(d.deviceId)) continue;
      const env = await wrapAndSignCallEnvelope({
        callKey,
        callId,
        targetDeviceId: d.deviceId,
        targetX25519PublicKey: d.x25519PublicKey,
        senderDeviceId: device.deviceId,
        senderDeviceEd25519PrivateKey: device.ed25519PrivateKey,
      });
      envelopes.push({
        targetDeviceId: d.deviceId,
        targetUserId: userId,
        ciphertext: env.ciphertext,
        signature: env.signature,
      });
    }
  }

  try {
    await rpcRotateCallKey({
      callId,
      signerDeviceId: device.deviceId,
      oldGeneration,
      newGeneration,
      envelopes,
    });
  } catch (err) {
    await zeroCallKey(callKey);
    throw err;
  }
  return callKey;
}

/**
 * Revocation cascade (§6.4 of the design doc).
 *
 * For every active call where the revoked device is still a member and the
 * acting device is ALSO a member, bump the generation and wrap the new
 * CallKey to everyone except the revoked device. Calls where the acting
 * device is not a participant are left alone — the other participants'
 * heartbeat-grace logic (§6.5) will eventually force a rotation once the
 * revoked device stops heartbeating.
 */
export async function cascadeRevocationIntoActiveCalls(params: {
  userId: string;
  revokedDeviceId: string;
  device: DeviceKeyBundle;
}): Promise<{ rotated: number; failures: Array<{ callId: string; error: string }> }> {
  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from('calls')
    .select('id, current_generation')
    .is('ended_at', null);
  if (error) throw error;
  const calls = (rows ?? []) as Array<{ id: string; current_generation: number }>;

  let rotated = 0;
  const failures: Array<{ callId: string; error: string }> = [];
  for (const call of calls) {
    try {
      const members = await listCallMembers(call.id);
      const revokedIsActive = members.some(
        (m) => m.device_id === params.revokedDeviceId && m.left_at === null,
      );
      if (!revokedIsActive) continue;
      const actingIsActive = members.some(
        (m) => m.device_id === params.device.deviceId && m.left_at === null,
      );
      if (!actingIsActive) continue;

      const newKey = await rotateCallKeyForCurrentMembers({
        callId: call.id,
        device: params.device,
        oldGeneration: call.current_generation,
        excludeDeviceIds: [params.revokedDeviceId],
      });
      await zeroCallKey(newKey);
      rotated++;
    } catch (err) {
      failures.push({ callId: call.id, error: errorMessage(err) });
    }
  }
  return { rotated, failures };
}

export { getDeviceRecord, verifyPublicDevice };

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
