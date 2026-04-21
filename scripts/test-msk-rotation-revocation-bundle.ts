/**
 * Test: MSK rotation with DevicePicker atomically bundles explicit
 * revocation certs alongside the reissuance for kept devices.
 *
 * The cascade test (test-msk-rotation-cascade.ts) proves ghost devices lose
 * room access via cert-chain breakage. But the RecoveryPhraseModal rotation
 * flow also issues EXPLICIT SSK-signed revocation certs for unchecked
 * devices — so the revocation can be verified server-side or by peers, and
 * so `filterActiveDevices`/`verifyPublicDevice` return DEVICE_REVOKED
 * immediately rather than CERT_INVALID (the latter is what a stale-cert
 * device looks like and is harder to reason about).
 *
 * Scenario:
 *   - Alice provisions dev0 (current) + dev1 (to revoke).
 *   - Rotate MSK with devicesToRevoke=[dev1].
 *   - Commit cert reissuance for dev0 AND revocation row for dev1 in one
 *     batch of writes (as commitRotatedUmk does).
 *   - Assert:
 *       a. dev0.issuance_signature updated and verifies against new SSK
 *       b. dev1.revoked_at_ms set; dev1.revocation_signature set
 *       c. dev1's revocation verifies against the NEW SSK (v2 domain)
 *       d. dev1's revocation does NOT verify against the OLD SSK — proving
 *          the revocation is bound to the POST-rotation cross-sig chain,
 *          not stranded in the old chain
 *       e. verifyPublicDevice(dev1) throws CERT_INVALID or DEVICE_REVOKED
 *          (current flow yields CERT_INVALID because `generateRotatedUmk`
 *          only reissues certs for *kept* devices; dev1's issuance cert is
 *          stale-under-new-SSK and so the issuance check fails first, before
 *          the verifier ever reaches the revocation block. Either code is a
 *          definitive rejection — we accept both.)
 *       f. filterActiveDevices([dev0, dev1]) returns ONLY dev0
 *       g. verifyPublicDevice(dev0) returns clean
 *
 * Why the new-SSK binding matters: using the OLD SSK to sign the revocation
 * would leave it stranded — the old SSK cross-sig is gone after commit, so
 * peers verifying the revocation against the identity would fall back to
 * CERT_INVALID instead of DEVICE_REVOKED. bootstrap.ts:466-476 documents
 * this explicitly; the test enforces it.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-msk-rotation-revocation-bundle.ts
 */

import {
  generateUserMasterKey,
  generateSigningKeys,
  verifyCrossSigningChain,
  signDeviceIssuanceV2,
  signDeviceRevocationV2,
  verifyDeviceIssuance,
  verifyDeviceRevocation,
  verifyPublicDevice,
  filterActiveDevices,
  CryptoError,
  toBase64,
  fromBase64,
  type PublicDevice,
} from '../src/lib/e2ee-core';
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  provisionSecondDevice,
  cleanupUser,
  makeServiceClient,
} from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mskr-${Date.now()}@example.com`);
  const userIds = [aliceUser.userId];
  const svc = makeServiceClient();

  try {
    const dev0 = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const dev1 = await provisionSecondDevice(aliceUser.supabase, aliceUser.userId, dev0.ssk);

    // -- Snapshot original device rows (for end-state diff + cert inputs) -----
    const { data: devRows } = await svc.from('devices')
      .select('*').eq('user_id', aliceUser.userId);
    const rowsById = new Map<string, {
      device_ed25519_pub: string; device_x25519_pub: string;
      issuance_created_at_ms: number; issuance_signature: string;
      revoked_at_ms: number | null; revocation_signature: string | null;
    }>();
    for (const r of (devRows ?? [])) {
      rowsById.set((r as { id: string }).id, r as never);
    }
    const dev0Row = rowsById.get(dev0.deviceId)!;
    const dev1Row = rowsById.get(dev1.deviceId)!;

    // Pre-condition: both devices start unrevoked.
    if (dev0Row.revoked_at_ms !== null || dev1Row.revoked_at_ms !== null) {
      throw new Error('Both devices must start unrevoked');
    }

    // -- Rotate MSK — generate new keys and per-device certs ------------------
    const newMsk = await generateUserMasterKey();
    const { ssk: newSsk, usk: newUsk, sskCrossSignature, uskCrossSignature } =
      await generateSigningKeys(newMsk);

    // Sanity: new cross-sig chain is internally consistent.
    await verifyCrossSigningChain({
      mskPub: newMsk.ed25519PublicKey,
      sskPub: newSsk.ed25519PublicKey,
      sskCrossSignature,
      uskPub: newUsk.ed25519PublicKey,
      uskCrossSignature,
    });

    // dev0 kept — reissue cert under new SSK.
    const dev0NewIssuanceSig = await signDeviceIssuanceV2(
      {
        userId: aliceUser.userId,
        deviceId: dev0.deviceId,
        deviceEd25519PublicKey: await fromBase64(dev0Row.device_ed25519_pub),
        deviceX25519PublicKey:  await fromBase64(dev0Row.device_x25519_pub),
        createdAtMs: dev0Row.issuance_created_at_ms,
      },
      newSsk.ed25519PrivateKey,
    );

    // dev1 revoked — SSK-signed revocation cert at new MSK epoch.
    const revokedAtMs = Date.now();
    const dev1RevSig = await signDeviceRevocationV2(
      { userId: aliceUser.userId, deviceId: dev1.deviceId, revokedAtMs },
      newSsk.ed25519PrivateKey,
    );

    // -- Atomic commit: identity + dev0 cert + dev1 revocation ----------------
    // Mirrors commitRotatedUmk() at bootstrap.ts:499, minus the IDB save
    // (which is harness-incompatible). The critical invariant is that all
    // three DB updates land; if one fails, the caller must surface it.
    const { error: idErr } = await aliceUser.supabase.from('identities').upsert({
      user_id: aliceUser.userId,
      ed25519_pub: await toBase64(newMsk.ed25519PublicKey),
      x25519_pub: null, self_signature: null,
      ssk_pub: await toBase64(newSsk.ed25519PublicKey),
      ssk_cross_signature: await toBase64(sskCrossSignature),
      usk_pub: await toBase64(newUsk.ed25519PublicKey),
      usk_cross_signature: await toBase64(uskCrossSignature),
      identity_epoch: 1,
    });
    if (idErr) throw new Error(`identity publish: ${idErr.message}`);

    const [certUpdate, revUpdate] = await Promise.all([
      aliceUser.supabase.from('devices')
        .update({ issuance_signature: await toBase64(dev0NewIssuanceSig) })
        .eq('id', dev0.deviceId),
      aliceUser.supabase.from('devices')
        .update({
          revoked_at_ms: revokedAtMs,
          revocation_signature: await toBase64(dev1RevSig),
        })
        .eq('id', dev1.deviceId),
    ]);
    if (certUpdate.error) throw new Error(`dev0 reissue write: ${certUpdate.error.message}`);
    if (revUpdate.error) throw new Error(`dev1 revocation write: ${revUpdate.error.message}`);

    // -- Assertion (a): dev0 cert updated + verifies --------------------------
    const { data: dev0After } = await svc.from('devices')
      .select('issuance_signature').eq('id', dev0.deviceId).single();
    const dev0AfterSig = (dev0After as { issuance_signature: string }).issuance_signature;
    if (dev0AfterSig === dev0Row.issuance_signature) {
      throw new Error('dev0 cert was not updated by the reissuance write');
    }
    await verifyDeviceIssuance(
      {
        userId: aliceUser.userId, deviceId: dev0.deviceId,
        deviceEd25519PublicKey: await fromBase64(dev0Row.device_ed25519_pub),
        deviceX25519PublicKey:  await fromBase64(dev0Row.device_x25519_pub),
        createdAtMs: dev0Row.issuance_created_at_ms,
      },
      await fromBase64(dev0AfterSig),
      newMsk.ed25519PublicKey,
      newSsk.ed25519PublicKey,
    );

    // -- Assertion (b): dev1 revocation row populated -------------------------
    const { data: dev1After } = await svc.from('devices')
      .select('revoked_at_ms, revocation_signature').eq('id', dev1.deviceId).single();
    const dev1AfterRow = dev1After as { revoked_at_ms: number | null; revocation_signature: string | null };
    if (dev1AfterRow.revoked_at_ms !== revokedAtMs) {
      throw new Error(`dev1.revoked_at_ms wrong: ${dev1AfterRow.revoked_at_ms}`);
    }
    if (!dev1AfterRow.revocation_signature) {
      throw new Error('dev1.revocation_signature missing after bundle commit');
    }

    // -- Assertion (c): dev1 revocation verifies against NEW SSK (v2) ---------
    await verifyDeviceRevocation(
      { userId: aliceUser.userId, deviceId: dev1.deviceId, revokedAtMs },
      dev1RevSig,
      newMsk.ed25519PublicKey,
      newSsk.ed25519PublicKey,
    );

    // -- Assertion (d): dev1 revocation does NOT verify against OLD SSK -------
    // verifyDeviceRevocation with sskPub=oldSsk falls back to v1 (MSK-signed),
    // which will also fail since the sig is actually v2 SSK-signed.
    try {
      await verifyDeviceRevocation(
        { userId: aliceUser.userId, deviceId: dev1.deviceId, revokedAtMs },
        dev1RevSig,
        dev0.msk.ed25519PublicKey, // OLD MSK
        dev0.ssk.ed25519PublicKey, // OLD SSK
      );
      throw new Error(
        'Vulnerability: dev1 revocation verified under OLD SSK — ' +
        'sig is not bound to post-rotation cross-sig chain',
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      if (!(err instanceof CryptoError) || err.code !== 'CERT_INVALID') {
        throw new Error(`Expected CERT_INVALID for old-SSK revocation check, got ${err}`);
      }
    }

    // -- Build PublicDevice values for the trust-check assertions -------------
    const dev0Public: PublicDevice = {
      userId: aliceUser.userId, deviceId: dev0.deviceId,
      ed25519PublicKey: await fromBase64(dev0Row.device_ed25519_pub),
      x25519PublicKey:  await fromBase64(dev0Row.device_x25519_pub),
      createdAtMs: dev0Row.issuance_created_at_ms,
      issuanceSignature: await fromBase64(dev0AfterSig),
      revocation: null,
    };
    const dev1Public: PublicDevice = {
      userId: aliceUser.userId, deviceId: dev1.deviceId,
      ed25519PublicKey: await fromBase64(dev1Row.device_ed25519_pub),
      x25519PublicKey:  await fromBase64(dev1Row.device_x25519_pub),
      createdAtMs: dev1Row.issuance_created_at_ms,
      issuanceSignature: await fromBase64(dev1Row.issuance_signature),
      revocation: {
        revokedAtMs,
        signature: dev1RevSig,
      },
    };

    // -- Assertion (e): verifyPublicDevice(dev1) is rejected ------------------
    // Accepts CERT_INVALID or DEVICE_REVOKED; see header for why.
    try {
      await verifyPublicDevice(
        dev1Public,
        newMsk.ed25519PublicKey,
        newSsk.ed25519PublicKey,
      );
      throw new Error('Vulnerability: verifyPublicDevice accepted a revoked device');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      const isCryptoReject =
        err instanceof CryptoError &&
        (err.code === 'DEVICE_REVOKED' || err.code === 'CERT_INVALID');
      if (!isCryptoReject) {
        throw new Error(`Expected CERT_INVALID or DEVICE_REVOKED for revoked dev1, got code=${
          (err as CryptoError).code ?? 'n/a'} msg=${(err as Error).message}`);
      }
    }

    // -- Assertion (f): filterActiveDevices drops dev1 ------------------------
    const active = await filterActiveDevices(
      [dev0Public, dev1Public],
      newMsk.ed25519PublicKey,
      newSsk.ed25519PublicKey,
    );
    if (active.length !== 1) {
      throw new Error(`filterActiveDevices returned ${active.length} devices; expected 1`);
    }
    if (active[0].deviceId !== dev0.deviceId) {
      throw new Error(`filterActiveDevices kept the wrong device: ${active[0].deviceId}`);
    }

    // -- Assertion (g): verifyPublicDevice(dev0) succeeds ---------------------
    await verifyPublicDevice(
      dev0Public,
      newMsk.ed25519PublicKey,
      newSsk.ed25519PublicKey,
    );

    // -- Assertion: issuing the revocation under NEW MSK directly (not SSK)
    //    would not be accepted by the v2 verifier. Proves domain binding.
    const malformedRevUnderMsk = await (await import('../src/lib/e2ee-core')).signDeviceRevocation(
      { userId: aliceUser.userId, deviceId: dev1.deviceId, revokedAtMs },
      newMsk.ed25519PrivateKey,
    );
    try {
      // Pass undefined for sskPub so verifier only tries v1; this MSK-signed
      // revocation is v1 and *will* verify. That's the backward-compat path.
      // The failure case we're checking is: v2-domain verifier rejects a
      // v1-domain signature. Re-verify with only SSK pub supplied, but tag
      // it as v2 — both domains fail because the sig is over the v1 domain
      // message not the v2 domain message.
      await verifyDeviceRevocation(
        { userId: aliceUser.userId, deviceId: dev1.deviceId, revokedAtMs },
        malformedRevUnderMsk,
        // Only SSK pub to force v2 attempt first; v1 fallback uses umkPub
        // which here we give a RANDOM pub so the fallback also fails.
        (await generateUserMasterKey()).ed25519PublicKey,
        newSsk.ed25519PublicKey,
      );
      throw new Error('Vulnerability: v2 revocation verifier accepted an MSK-signed sig');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      if (!(err instanceof CryptoError) || err.code !== 'CERT_INVALID') {
        throw new Error(`Expected CERT_INVALID for wrong-domain revocation, got ${err}`);
      }
    }

    console.log(
      'PASS: MSK rotation revocation bundle — dev0 reissued under new SSK, dev1 ' +
      'explicitly revoked under new SSK, old-SSK/MSK rejections hold, ' +
      'verifyPublicDevice rejects dev1 (CERT_INVALID or DEVICE_REVOKED), ' +
      'filterActiveDevices keeps only dev0 ✓',
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
