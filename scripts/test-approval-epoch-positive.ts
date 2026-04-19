/**
 * Test 46: Device Approval Request — Positive Epoch Case
 *
 * Counterpart to T37 (epoch staleness). After Alice's key rotation bumps her
 * epoch, she inserts a FRESH approval request capturing the NEW epoch. Calling
 * verify_approval_code with the correct hash must return true.
 *
 * Also verifies:
 *   - Correct hash + current epoch → true
 *   - Incorrect hash + current epoch → false (no crash, just a miss)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-approval-epoch-positive.ts
 */

import {
  generateUserMasterKey,
  randomBytes,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-aep-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Bump epoch by updating ssk_pub ---------------------------------------
    const newSsk = await generateUserMasterKey();
    await aliceUser.supabase.from('identities').update({
      ssk_pub: await toBase64(newSsk.ed25519PublicKey),
    }).eq('user_id', alice.userId);

    // Read current epoch after bump
    const { data: identRow } = await svc.from('identities').select('identity_epoch')
      .eq('user_id', alice.userId).single();
    const currentEpoch = (identRow as { identity_epoch: number }).identity_epoch;

    // -- Insert approval request at currentEpoch --------------------------------
    const linkNonce     = await randomBytes(32);
    const linkNonceB64  = await toBase64(linkNonce);
    const ephemeralPub  = await randomBytes(32);
    const codeBytes     = await randomBytes(16);
    const codeSaltHex   = Buffer.from(await randomBytes(16)).toString('hex');
    // Hash must match what verify_approval_code checks: v_row.code_hash = p_candidate_hash
    const codeHashHex   = Buffer.from(codeBytes).toString('hex'); // deterministic for test

    const { data: reqRow, error: reqErr } = await svc
      .from('device_approval_requests').insert({
        user_id: alice.userId,
        linking_pubkey: await toBase64(ephemeralPub),
        code_hash: codeHashHex,
        code_salt: codeSaltHex,
        link_nonce: linkNonceB64,
        identity_epoch: currentEpoch,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }).select('id').single();
    if (reqErr || !reqRow) throw new Error(`Insert: ${reqErr?.message}`);
    const requestId = (reqRow as { id: string }).id;

    // -- Correct hash → true --------------------------------------------------
    const { data: result, error: verErr } = await aliceUser.supabase.rpc(
      'verify_approval_code',
      { p_request_id: requestId, p_candidate_hash: codeHashHex },
    );
    if (result !== true) {
      throw new Error(`Expected true for correct hash+epoch, got ${result} (${verErr?.message})`);
    }

    // Row should be gone (consumed by the RPC on success? depends on impl)
    // or still present — either is fine; just clean up
    await svc.from('device_approval_requests').delete().eq('id', requestId);

    // -- New request, wrong hash → false (no crash) ---------------------------
    const linkNonce2    = await randomBytes(32);
    const { data: reqRow2, error: reqErr2 } = await svc
      .from('device_approval_requests').insert({
        user_id: alice.userId,
        linking_pubkey: await toBase64(ephemeralPub),
        code_hash: codeHashHex,
        code_salt: codeSaltHex,
        link_nonce: await toBase64(linkNonce2),
        identity_epoch: currentEpoch,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }).select('id').single();
    if (reqErr2 || !reqRow2) throw new Error(`Insert2: ${reqErr2?.message}`);
    const requestId2 = (reqRow2 as { id: string }).id;

    const wrongHash = Buffer.from(await randomBytes(16)).toString('hex');
    const { data: result2 } = await aliceUser.supabase.rpc(
      'verify_approval_code',
      { p_request_id: requestId2, p_candidate_hash: wrongHash },
    );
    if (result2 === true) {
      throw new Error('Vulnerability: wrong hash returned true');
    }

    await svc.from('device_approval_requests').delete().eq('id', requestId2);

    console.log('PASS: Approval epoch positive — correct hash+epoch returns true; wrong hash returns false ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
