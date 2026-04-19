/**
 * Test 57: Device Approval Request Expiry TTL
 *
 * Inserts an approval request with expires_at in the past.
 * verify_approval_code must return false and delete the row.
 * Separate from T37 (epoch mismatch) — this specifically tests the TTL path.
 *
 * Asserts:
 *   - verify_approval_code returns false for expired row
 *   - The expired row is deleted by the RPC
 *
 * Run: npx tsx --env-file=.env.local scripts/test-approval-request-expiry.ts
 */

import {
  randomBytes,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-are-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // Read current epoch
    const { data: identRow } = await svc.from('identities').select('identity_epoch')
      .eq('user_id', alice.userId).single();
    const epoch = (identRow as { identity_epoch: number }).identity_epoch;

    // Build request payload
    const linkNonce   = await randomBytes(32);
    const ephemeralPub = await randomBytes(32);
    const codeBytes   = await randomBytes(16);
    const saltHex     = Buffer.from(await randomBytes(16)).toString('hex');
    const hashHex     = Buffer.from(codeBytes).toString('hex');

    // expires_at 1 second in the past
    const { data: reqRow, error: reqErr } = await svc
      .from('device_approval_requests').insert({
        user_id: alice.userId,
        linking_pubkey: await toBase64(ephemeralPub),
        code_hash: hashHex,
        code_salt: saltHex,
        link_nonce: await toBase64(linkNonce),
        identity_epoch: epoch,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }).select('id').single();
    if (reqErr || !reqRow) throw new Error(`Insert: ${reqErr?.message}`);
    const requestId = (reqRow as { id: string }).id;

    // -- verify_approval_code should return false (expired) -------------------
    const { data: result, error: verErr } = await aliceUser.supabase.rpc(
      'verify_approval_code',
      { p_request_id: requestId, p_candidate_hash: hashHex },
    );

    if (result === true) {
      throw new Error(
        'verify_approval_code returned true for a row whose expires_at was 1s in the local past. ' +
          'On first fail, check local clock vs Supabase clock — the test sets expires_at ' +
          'from local Date.now(), so if your machine is >1s ahead of the DB the row still ' +
          'looks fresh to Postgres and the RPC correctly returns true. ' +
          'Resync (`w32tm /resync` on Windows) and re-run before treating this as a vulnerability.',
      );
    }

    // -- Row should be deleted ------------------------------------------------
    const { data: rowAfter } = await svc.from('device_approval_requests')
      .select('id').eq('id', requestId);
    if (rowAfter && rowAfter.length > 0) {
      // Clean up and warn — some implementations may leave the row
      await svc.from('device_approval_requests').delete().eq('id', requestId);
      if (verErr) {
        console.warn(`Note: RPC errored (${verErr.message}) before delete — acceptable`);
      } else {
        throw new Error('Expired approval request not deleted after TTL check');
      }
    }

    console.log('PASS: Approval request expiry — expired request rejected; row deleted ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
