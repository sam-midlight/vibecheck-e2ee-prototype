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
  getBackupKey,
  generateDeviceKeyBundle,
  generateUserMasterKey,
  getDeviceBundle,
  getDeviceRecord,
  getUserMasterKey,
  putDeviceBundle,
  putDeviceRecord,
  putUserMasterKey,
  rotateRoomKey,
  signDeviceIssuance,
  signInviteEnvelope,
  signMembershipWrap,
  toBase64,
  unwrapRoomKey,
  verifyPublicDevice,
  wrapRoomKeyFor,
  type DeviceKeyBundle,
  type PublicDevice,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { getSupabase } from '@/lib/supabase/client';
import { errorMessage } from '@/lib/errors';
import {
  addRoomMember,
  createInvite,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  getMyWrappedRoomKey,
  kickAndRotate,
  listRoomMembers,
  publishUserMasterKey,
  registerDevice,
  upsertKeyBackup,
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
/** Result of the generate-only half of UMK rotation. */
export interface RotatedUmkResult {
  newUmk: UserMasterKey;
  reissuedCerts: Array<{ deviceId: string; issuanceSignature: Uint8Array }>;
}

/**
 * Generate a fresh UMK and re-sign all active device issuance certs in
 * memory. This is the PURE-COMPUTATION half of UMK rotation — no server
 * writes, no local saves. Callers use it with `commitRotatedUmk` to
 * control the exact ordering of escrow → save → publish (SSSS pattern).
 */
export async function generateRotatedUmk(
  userId: string,
  oldUmk: UserMasterKey,
): Promise<RotatedUmkResult> {
  const publishedOld = await fetchUserMasterKeyPub(userId);
  if (!publishedOld) throw new Error('no published UMK — nothing to rotate');
  if (!bytesEq(publishedOld.ed25519PublicKey, oldUmk.ed25519PublicKey)) {
    throw new Error(
      'local UMK does not match published UMK — refusing to rotate from a stale copy',
    );
  }

  const activeDevices = await filterActiveDevices(
    await fetchPublicDevices(userId),
    oldUmk.ed25519PublicKey,
  );
  if (activeDevices.length === 0) {
    throw new Error('no active devices to re-sign — rotation aborted');
  }

  const newUmk = await generateUserMasterKey();

  const reissuedCerts = await Promise.all(
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

  return { newUmk, reissuedCerts };
}

/**
 * Publish a previously-generated UMK: update the identities row (which
 * triggers identity_epoch bump), write re-issued device certs, and save
 * the new UMK to local IDB.
 *
 * MUST be called AFTER the recovery blob has been committed (SSSS
 * pattern: escrow before publish). Otherwise a crash between publish
 * and save leaves the user locked out.
 */
export async function commitRotatedUmk(
  userId: string,
  newUmk: UserMasterKey,
  reissuedCerts: Array<{ deviceId: string; issuanceSignature: Uint8Array }>,
): Promise<void> {
  await publishUserMasterKey(userId, {
    ed25519PublicKey: newUmk.ed25519PublicKey,
  });

  const supabase = getSupabase();
  await Promise.all(
    reissuedCerts.map(async ({ deviceId, issuanceSignature }) => {
      const { error } = await supabase
        .from('devices')
        .update({ issuance_signature: await toBase64(issuanceSignature) })
        .eq('id', deviceId);
      if (error) throw error;
    }),
  );

  await putUserMasterKey(userId, newUmk);
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
  const { newUmk, reissuedCerts } = await generateRotatedUmk(userId, oldUmk);
  await putUserMasterKey(userId, newUmk);
  await commitRotatedUmk(userId, newUmk, reissuedCerts);
  return newUmk;
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

  const myWrapped = await getMyWrappedRoomKey({
    roomId: room.id,
    deviceId: device.deviceId,
    generation: room.current_generation,
  });
  if (!myWrapped) {
    throw new Error(
      `no current-gen wrapped key on this device for room ${room.id.slice(0, 8)}`,
    );
  }
  const roomKey = await unwrapRoomKey(
    { wrapped: myWrapped, generation: room.current_generation },
    device.x25519PublicKey,
    device.x25519PrivateKey,
  );

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
    const umk = await fetchUserMasterKeyPub(uid);
    if (!umk) throw new Error(`no published UMK for keeper ${uid.slice(0, 8)}`);
    const activeKeeperDevs = await filterActiveDevices(
      await fetchPublicDevices(uid),
      umk.ed25519PublicKey,
    );
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

  const umkPub = await fetchUserMasterKeyPub(userId);
  if (!umkPub) return;

  const allDevices = await fetchPublicDevices(userId);
  const active = await filterActiveDevices(allDevices, umkPub.ed25519PublicKey);

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

export { getDeviceRecord, verifyPublicDevice };

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
