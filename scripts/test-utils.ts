/**
 * Test harness utilities for E2EE integration tests.
 *
 * Usage:
 *   import { initCrypto, createTestUser, provisionDevice, cleanupUser } from './test-utils';
 *
 * Requires env vars:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  getSodium,
  generateUserMasterKey,
  generateDeviceKeyBundle,
  generateSigningKeys,
  signDeviceIssuanceV2,
  toBase64,
  type DeviceKeyBundle,
  type SelfSigningKey,
  type UserMasterKey,
  type UserSigningKey,
} from '../src/lib/e2ee-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestDevice {
  userId: string;
  deviceId: string;
  msk: UserMasterKey;
  ssk: SelfSigningKey;
  usk: UserSigningKey;
  bundle: DeviceKeyBundle;
}

export interface TestUser {
  supabase: SupabaseClient;
  userId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function makeAdminClient(): SupabaseClient {
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Returns a service-role Supabase client that bypasses RLS.
 * Use only for test fixture inserts where RLS would block cross-user setup
 * (e.g. Alice inserting Bob's room_members row). Do NOT use for assertions
 * that should be testing RLS-enforced access.
 */
export function makeServiceClient(): SupabaseClient {
  return makeAdminClient();
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Await libsodium WASM readiness. Call once at the top of each test file
 * (or in beforeAll) before invoking any crypto primitive.
 */
export async function initCrypto(): Promise<void> {
  await getSodium();
}

/**
 * Create a confirmed test user in Supabase auth and return an authenticated
 * client scoped to that user. The password is random and discarded; the user
 * is meant to be cleaned up with `cleanupUser` after the test.
 */
export async function createTestUser(email: string): Promise<TestUser> {
  const admin = makeAdminClient();
  const password = crypto.randomUUID();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createTestUser failed: ${error?.message ?? 'no user returned'}`);
  }
  const userId = data.user.id;

  const supabase = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`createTestUser sign-in failed: ${signInError.message}`);

  return { supabase, userId };
}

/**
 * Generate a full v3 identity (MSK + SSK + USK + device bundle), sign the
 * device issuance cert with the SSK, and write both the `identities` and
 * `devices` rows via the provided authenticated client.
 *
 * Returns all key material so tests can assert on signatures or simulate
 * further operations (room key wrapping, cert verification, etc.).
 */
export async function provisionDevice(
  supabase: SupabaseClient,
  userId: string,
): Promise<TestDevice> {
  const msk = await generateUserMasterKey();
  const { ssk, usk, sskCrossSignature, uskCrossSignature } = await generateSigningKeys(msk);

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

  const { error: identityErr } = await supabase.from('identities').upsert({
    user_id: userId,
    ed25519_pub: await toBase64(msk.ed25519PublicKey),
    x25519_pub: null,
    self_signature: null,
    ssk_pub: await toBase64(ssk.ed25519PublicKey),
    ssk_cross_signature: await toBase64(sskCrossSignature),
    usk_pub: await toBase64(usk.ed25519PublicKey),
    usk_cross_signature: await toBase64(uskCrossSignature),
    identity_epoch: 0,
  });
  if (identityErr) throw new Error(`provisionDevice: identities upsert: ${identityErr.message}`);

  const { error: deviceErr } = await supabase.from('devices').insert({
    id: deviceId,
    user_id: userId,
    device_ed25519_pub: await toBase64(bundle.ed25519PublicKey),
    device_x25519_pub: await toBase64(bundle.x25519PublicKey),
    issuance_created_at_ms: createdAtMs,
    issuance_signature: await toBase64(issuanceSignature),
    display_name: null,
    display_name_ciphertext: null,
  });
  if (deviceErr) throw new Error(`provisionDevice: devices insert: ${deviceErr.message}`);

  return { userId, deviceId, msk, ssk, usk, bundle };
}

/**
 * Provision an additional device for a user who already has an `identities` row.
 * Uses the existing SSK to sign the new issuance cert — the identities row is
 * NOT touched, so SSK/USK cross-signatures remain valid.
 *
 * Use this for multi-device tests where both devices share the same user identity.
 */
export async function provisionSecondDevice(
  supabase: SupabaseClient,
  userId: string,
  ssk: SelfSigningKey,
): Promise<{ userId: string; deviceId: string; bundle: DeviceKeyBundle }> {
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

  const { error } = await supabase.from('devices').insert({
    id: deviceId,
    user_id: userId,
    device_ed25519_pub: await toBase64(bundle.ed25519PublicKey),
    device_x25519_pub: await toBase64(bundle.x25519PublicKey),
    issuance_created_at_ms: createdAtMs,
    issuance_signature: await toBase64(issuanceSignature),
    display_name: null,
    display_name_ciphertext: null,
  });
  if (error) throw new Error(`provisionSecondDevice: ${error.message}`);

  return { userId, deviceId, bundle };
}

/**
 * Delete the auth user and all their data from Supabase.
 *
 * Rooms and room_members lack ON DELETE CASCADE on created_by/user_id, so we
 * must purge those rows with the service-role client before deleting the auth
 * user, otherwise Supabase returns "Database error deleting user".
 */
export async function cleanupUser(userId: string): Promise<void> {
  const admin = makeAdminClient();
  // Tables with NO ACTION FKs on auth.users must be cleared before deleteUser.
  // Order matters: children before parents where there are FK chains.
  await admin.from('sas_verification_sessions').delete().or(`initiator_user_id.eq.${userId},responder_user_id.eq.${userId}`);
  await admin.from('call_members').delete().eq('user_id', userId);
  await admin.from('calls').delete().eq('initiator_user_id', userId);
  // Megolm sessions: NO ACTION on sender_user_id; cascades to megolm_session_shares.
  await admin.from('megolm_sessions').delete().eq('sender_user_id', userId);
  // Blobs in rooms the user sent to but didn't create (sender_id NO ACTION).
  await admin.from('blobs').delete().eq('sender_id', userId);
  // Invites this user created in rooms they didn't own (created_by NO ACTION).
  await admin.from('room_invites').delete().eq('created_by', userId);
  // Rooms this user created: cascades to room_members, blobs, room_invites.
  await admin.from('rooms').delete().eq('created_by', userId);
  // Belt-and-suspenders for any residual membership rows.
  await admin.from('room_members').delete().eq('user_id', userId);
  // Best-effort: auth.admin.deleteUser has Supabase-internal guards that can
  // reject even after all public-schema FKs are cleared. The data above IS
  // fully purged; the orphaned auth row is harmless in a test DB and can be
  // cleared from the Supabase dashboard if needed.
  await admin.auth.admin.deleteUser(userId).catch(() => {});
}
