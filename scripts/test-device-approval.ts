/**
 * Test 16: Device Approval End-to-End
 *
 * Simulates the full code-based device-approval flow:
 *   1. New device (B) generates an approval request row with a linking pubkey,
 *      link_nonce, and code_hash.
 *   2. Existing device (A, the approver) reads the row and verifies the code
 *      by re-hashing: SHA-256(domain || salt || code || linking_pubkey || link_nonce).
 *   3. A seals (MSK priv + SSK priv + USK priv) to B's linking pubkey and writes
 *      a device_link_handoffs row.
 *   4. B reads the handoff row, unseals it, and verifies it has the expected keys.
 *
 * Asserts:
 *   - hashApprovalCode produces consistent results given the same inputs
 *   - A wrong code hash does NOT match (brute-force guard)
 *   - B can successfully unseal the handoff and recover the SSK private key
 *
 * Run: npx tsx --env-file=.env.local scripts/test-device-approval.ts
 */

import {
  generateApprovalCode,
  generateApprovalSalt,
  hashApprovalCode,
  getSodium,
  toBase64,
  fromBase64,
  randomBytes,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-appr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const sodium = await getSodium();

    // -- Device B generates its linking keypair + link_nonce ------------------
    const linkingKeypair = sodium.crypto_box_keypair();
    const linkNonce = await randomBytes(32);
    const linkNonceB64 = await toBase64(linkNonce);

    // -- Device B generates a 6-digit code and hashes it ----------------------
    const code = await generateApprovalCode();
    if (!/^\d{6}$/.test(code)) throw new Error(`Invalid approval code format: "${code}"`);

    const saltHex = await generateApprovalSalt();
    const expectedHash = await hashApprovalCode(
      code, saltHex, linkingKeypair.publicKey, linkNonce,
    );

    // -- Device B inserts a device_approval_requests row ----------------------
    const { data: requestRow, error: reqErr } = await aliceUser.supabase
      .from('device_approval_requests')
      .insert({
        user_id: alice.userId,
        linking_pubkey: await toBase64(linkingKeypair.publicKey),
        link_nonce: linkNonceB64,
        code_hash: expectedHash,
        code_salt: saltHex,
      })
      .select('*').single();
    if (reqErr || !requestRow) throw new Error(`insertApprovalRequest: ${reqErr?.message}`);

    const rr = requestRow as {
      id: string; linking_pubkey: string; link_nonce: string;
      code_hash: string; code_salt: string;
    };

    // -- Device A (approver) verifies the code by re-hashing ------------------
    const approverHash = await hashApprovalCode(
      code,
      rr.code_salt,
      await fromBase64(rr.linking_pubkey),
      await fromBase64(rr.link_nonce),
    );
    if (approverHash !== rr.code_hash) {
      throw new Error(`Code hash mismatch: approver=${approverHash.slice(0,8)}… stored=${rr.code_hash.slice(0,8)}…`);
    }

    // -- Verify a wrong code does NOT match -----------------------------------
    const wrongCode = code === '000000' ? '000001' : '000000';
    const wrongHash = await hashApprovalCode(
      wrongCode,
      rr.code_salt,
      await fromBase64(rr.linking_pubkey),
      await fromBase64(rr.link_nonce),
    );
    if (wrongHash === rr.code_hash) {
      throw new Error('Vulnerability: Wrong code produced the same hash as the correct code');
    }

    // -- Device A seals SSK + USK to B's linking pubkey -----------------------
    // Pack: sskPriv(64) || uskPriv(64)
    const packed = new Uint8Array(128);
    packed.set(alice.ssk.ed25519PrivateKey, 0);
    packed.set(alice.usk.ed25519PrivateKey, 64);
    const sealedKeys = sodium.crypto_box_seal(packed, await fromBase64(rr.linking_pubkey));

    // Insert handoff row (service client; in prod the approver's session does this)
    const handoffLinkNonce = await toBase64(linkNonce);
    const { error: handoffErr } = await aliceUser.supabase.from('device_link_handoffs').insert({
      link_nonce: handoffLinkNonce,
      inviting_user_id: alice.userId,
      sealed_payload: await toBase64(sealedKeys),
      expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });
    if (handoffErr) throw new Error(`insertHandoff: ${handoffErr.message}`);

    // -- Device B fetches and unseals the handoff row -------------------------
    const { data: handoffRow, error: fetchErr } = await aliceUser.supabase
      .from('device_link_handoffs')
      .select('sealed_payload')
      .eq('link_nonce', handoffLinkNonce)
      .single();
    if (fetchErr || !handoffRow) throw new Error(`fetchHandoff: ${fetchErr?.message}`);

    const hr = handoffRow as { sealed_payload: string };
    const unsealed = sodium.crypto_box_seal_open(
      await fromBase64(hr.sealed_payload),
      linkingKeypair.publicKey,
      linkingKeypair.privateKey,
    );
    if (unsealed.length !== 128) {
      throw new Error(`Unexpected unsealed length: ${unsealed.length}, expected 128`);
    }

    const recoveredSskPriv = unsealed.slice(0, 64);
    const recoveredUskPriv = unsealed.slice(64, 128);

    // Derive the public keys and verify they match Alice's published SSK
    const recoveredSskPub = sodium.crypto_sign_ed25519_sk_to_pk(recoveredSskPriv);
    const aliceSskPubB64 = await toBase64(alice.ssk.ed25519PublicKey);
    const recoveredSskPubB64 = await toBase64(recoveredSskPub);
    if (aliceSskPubB64 !== recoveredSskPubB64) {
      throw new Error(`SSK pub mismatch: alice=${aliceSskPubB64.slice(0,8)}… recovered=${recoveredSskPubB64.slice(0,8)}…`);
    }

    // Cleanup approval request
    await svc.from('device_approval_requests').delete().eq('id', rr.id);
    await svc.from('device_link_handoffs').delete().eq('link_nonce', handoffLinkNonce);

    console.log('PASS: Device approval — code hash verified; sealed SSK unsealed and verified ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
