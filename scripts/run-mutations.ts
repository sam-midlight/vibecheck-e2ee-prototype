/**
 * Mutation runner — scripts/run-mutations.ts
 *
 * For each mutation: apply weakening change → confirm kill-list tests exit 1
 * → restore file → confirm kill-list tests exit 0.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/run-mutations.ts
 *   npx tsx --env-file=.env.local scripts/run-mutations.ts --only M01
 *   npx tsx --env-file=.env.local scripts/run-mutations.ts --dry-run
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');

interface MutationStep {
  file: string;
  find: string;
  replace: string;
}

interface Mutation {
  id: string;
  description: string;
  steps: MutationStep[];
  kills: string[];
  survives?: string[];
}

// ---------------------------------------------------------------------------
// Mutation definitions
// ---------------------------------------------------------------------------

const MUTATIONS: Mutation[] = [
  // ── M01 ────────────────────────────────────────────────────────────────────
  {
    id: 'M01',
    description: 'Retrograde guard disabled in deriveMessageKeyAtIndex',
    steps: [{
      file: 'src/lib/e2ee-core/megolm.ts',
      find:
`  if (targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      \`cannot derive key at index \${targetIndex} — snapshot starts at \${snapshot.startIndex}\`,
      'BAD_GENERATION',
    );
  }
  const sodium = await getSodium();
  // Advance chain key from startIndex to targetIndex`,
      replace:
`  /* M01: retrograde guard disabled */
  if (false && targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      \`cannot derive key at index \${targetIndex} — snapshot starts at \${snapshot.startIndex}\`,
      'BAD_GENERATION',
    );
  }
  const sodium = await getSodium();
  // Advance chain key from startIndex to targetIndex`,
    }],
    kills: [
      'test-forward-secrecy.ts',
      'test-megolm-index-gap.ts',
      'test-out-of-order.ts',
    ],
    survives: ['test-happy-path.ts'],
  },

  // ── M02 ────────────────────────────────────────────────────────────────────
  {
    id: 'M02',
    description: 'Retrograde guard disabled in deriveMessageKeyAtIndexAndAdvance',
    steps: [{
      file: 'src/lib/e2ee-core/megolm.ts',
      find:
`  if (targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      \`cannot derive key at index \${targetIndex} — snapshot starts at \${snapshot.startIndex}\`,
      'BAD_GENERATION',
    );
  }
  const sodium = await getSodium();
  let chain: Uint8Array = new Uint8Array(snapshot.chainKeyAtIndex);`,
      replace:
`  /* M02: retrograde guard disabled in AndAdvance variant */
  if (false && targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      \`cannot derive key at index \${targetIndex} — snapshot starts at \${snapshot.startIndex}\`,
      'BAD_GENERATION',
    );
  }
  const sodium = await getSodium();
  let chain: Uint8Array = new Uint8Array(snapshot.chainKeyAtIndex);`,
    }],
    kills: [
      'test-advance-cursor-efficiency.ts',
      'test-megolm-snapshot-fastpath.ts',
    ],
    survives: ['test-out-of-order.ts'],
  },

  // ── M03 ────────────────────────────────────────────────────────────────────
  {
    id: 'M03',
    description: 'Megolm hard cap removed',
    steps: [{
      file: 'src/lib/e2ee-core/megolm.ts',
      find:
`  if (session.messageIndex >= MEGOLM_HARD_CAP) {
    throw new CryptoError(
      \`Megolm session exhausted at index \${session.messageIndex} (cap \${MEGOLM_HARD_CAP}). Rotate before sending.\`,
      'BAD_INPUT',
    );
  }`,
      replace: `  /* M03: hard cap check removed */`,
    }],
    kills: ['test-megolm-hard-cap.ts'],
    survives: ['test-stampede.ts'],
  },

  // ── M04 ────────────────────────────────────────────────────────────────────
  {
    id: 'M04',
    description: 'Auto-rotation message count threshold raised to never fire',
    steps: [{
      file: 'src/lib/e2ee-core/megolm.ts',
      find:
`export const DEFAULT_AUTO_ROTATION: AutoRotationConfig = {
  maxMessages: 100,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};`,
      replace:
`export const DEFAULT_AUTO_ROTATION: AutoRotationConfig = {
  maxMessages: 100_000, /* M04: threshold raised — count trigger never fires */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};`,
    }],
    kills: ['test-session-auto-rotation.ts'],
    survives: ['test-age-based-rotation.ts'],
  },

  // ── M05 ────────────────────────────────────────────────────────────────────
  {
    id: 'M05',
    description: 'Auto-rotation age threshold raised to never fire',
    steps: [{
      file: 'src/lib/e2ee-core/megolm.ts',
      find: `  maxAgeMs: 7 * 24 * 60 * 60 * 1000,`,
      replace: `  maxAgeMs: 9_999 * 365 * 24 * 60 * 60 * 1000, /* M05: age trigger never fires */`,
    }],
    kills: ['test-age-based-rotation.ts'],
    survives: ['test-session-auto-rotation.ts'],
  },

  // ── M06 ────────────────────────────────────────────────────────────────────
  {
    id: 'M06',
    description: 'Session share signature silently accepted',
    steps: [{
      file: 'src/lib/e2ee-core/megolm.ts',
      find:
`  try {
    await verifyMessageOrThrow(msg, params.signature, params.signerEd25519Pub);
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('session share signature invalid', 'CERT_INVALID');
    }
    throw err;
  }`,
      replace:
`  try {
    await verifyMessageOrThrow(msg, params.signature, params.signerEd25519Pub);
  } catch {
    /* M06: bad session share signature silently accepted */
  }`,
    }],
    kills: [
      'test-share-sig-tamper.ts',
      'test-wrong-recipient-unseal.ts',
    ],
    survives: ['test-stale-key-forward.ts'],
  },

  // ── M07 ────────────────────────────────────────────────────────────────────
  {
    id: 'M07',
    description: 'Device revocation check bypassed in verifyPublicDevice',
    steps: [{
      file: 'src/lib/e2ee-core/device.ts',
      find:
`  if (device.revocation) {
    await verifyDeviceRevocation(
      {
        userId: device.userId,
        deviceId: device.deviceId,
        revokedAtMs: device.revocation.revokedAtMs,
      },
      device.revocation.signature,
      umkPublicKey,
      sskPublicKey,
    );
    throw new CryptoError(
      \`device \${device.deviceId} is revoked (since \${new Date(device.revocation.revokedAtMs).toISOString()})\`,
      'DEVICE_REVOKED',
    );
  }`,
      replace: `  /* M07: revocation check bypassed — revoked devices accepted */`,
    }],
    kills: ['test-revoked-device-cert.ts', 'test-cert-chain-verification.ts'],
  },

  // ── M08 ────────────────────────────────────────────────────────────────────
  {
    id: 'M08',
    description: 'Sender device signature check skipped in decryptBlob (v4 + v3)',
    steps: [
      {
        file: 'src/lib/e2ee-core/blob.ts',
        find:
`        if (!sigOk) {
          throw new CryptoError('v4 sender device signature invalid', 'SIGNATURE_INVALID');
        }`,
        replace:
`        if (!sigOk) {
          /* M08: v4 sender signature check disabled */
          void sigOk;
        }`,
      },
      {
        file: 'src/lib/e2ee-core/blob.ts',
        find:
`        if (!sigOk) {
          throw new CryptoError('sender device signature invalid', 'SIGNATURE_INVALID');
        }`,
        replace:
`        if (!sigOk) {
          /* M08: v3 sender signature check disabled */
          void sigOk;
        }`,
      },
    ],
    kills: ['test-blob-sender-verification.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M09 ────────────────────────────────────────────────────────────────────
  {
    id: 'M09',
    description: 'Device issuance certificate verification bypassed',
    steps: [{
      file: 'src/lib/e2ee-core/device.ts',
      find:
`  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('device issuance cert did not verify', 'CERT_INVALID');
    }
    throw err;
  }
}`,
      replace:
`  } catch {
    /* M09: issuance cert signature check bypassed */
  }
}`,
    }],
    kills: ['test-spoofed-identity.ts'],
    survives: ['test-device-approval.ts'],
  },

  // ── M10 ────────────────────────────────────────────────────────────────────
  {
    id: 'M10',
    description: 'Minimum passphrase length check removed',
    steps: [{
      file: 'src/lib/e2ee-core/pin-lock.ts',
      find:
`  if (!passphrase || passphrase.length < 4) {
    throw new CryptoError('passphrase must be at least 4 characters', 'BAD_INPUT');
  }`,
      replace: `  /* M10: passphrase length guard removed */`,
    }],
    kills: ['test-pin-lock-roundtrip.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M11 ────────────────────────────────────────────────────────────────────
  {
    id: 'M11',
    description: 'userId stripped from PIN lock AD tag (encrypt + decrypt paths)',
    steps: [
      {
        file: 'src/lib/e2ee-core/pin-lock.ts',
        find: `      adTag = \`vibecheck:pinlock:v3:\${userId}\`;`,
        replace: `      adTag = \`vibecheck:pinlock:v3:\`; /* M11: userId removed from AD — wrong userId accepted */`,
      },
      {
        file: 'src/lib/e2ee-core/pin-lock.ts',
        find: `    const adV3 = stringToBytes(\`vibecheck:pinlock:v3:\${userId}\`);`,
        replace: `    const adV3 = stringToBytes(\`vibecheck:pinlock:v3:\`); /* M11: userId removed from AD */`,
      },
    ],
    kills: ['test-pin-lock-roundtrip.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M12 ────────────────────────────────────────────────────────────────────
  {
    id: 'M12',
    description: 'Cross-signing chain verification bypassed',
    steps: [{
      file: 'src/lib/e2ee-core/cross-signing.ts',
      find:
`export async function verifyCrossSigningChain(params: {
  mskPub: Bytes;
  sskPub: Bytes;
  sskCrossSignature: Bytes;
  uskPub: Bytes;
  uskCrossSignature: Bytes;
}): Promise<void> {
  await verifySskCrossSignature(
    params.mskPub,
    params.sskPub,
    params.sskCrossSignature,
  );
  await verifyUskCrossSignature(
    params.mskPub,
    params.uskPub,
    params.uskCrossSignature,
  );
}`,
      replace:
`export async function verifyCrossSigningChain(params: {
  mskPub: Bytes;
  sskPub: Bytes;
  sskCrossSignature: Bytes;
  uskPub: Bytes;
  uskCrossSignature: Bytes;
}): Promise<void> {
  /* M12: cross-signing chain verification bypassed */
  void params;
}`,
    }],
    kills: ['test-cert-chain-verification.ts'],
    survives: ['test-usk-cross-sign.ts'],
  },

  // ── M13 ────────────────────────────────────────────────────────────────────
  {
    id: 'M13',
    description: 'AppShell mandatory-PIN guard removed entirely',
    steps: [{
      file: 'src/components/AppShell.tsx',
      find:
`      const hasPin = await hasWrappedIdentity(data.user.id).catch(() => false);
      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }`,
      replace: `      /* M13: AppShell mandatory-PIN guard removed */`,
    }],
    kills: ['test-appshell-pin-gate.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M14 ────────────────────────────────────────────────────────────────────
  {
    id: 'M14',
    description: 'AppShell renders before PIN guard (guard moved after setChecking)',
    steps: [{
      file: 'src/components/AppShell.tsx',
      find:
`      const hasPin = await hasWrappedIdentity(data.user.id).catch(() => false);
      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }`,
      replace:
`      setChecking(false); /* M14: renders before PIN guard — plaintext visible for one frame */
      const hasPin = await hasWrappedIdentity(data.user.id).catch(() => false);
      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }`,
    }],
    kills: ['test-appshell-pin-gate.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M15 ────────────────────────────────────────────────────────────────────
  {
    id: 'M15',
    description: 'AppShell PIN-guard redirect target changed to /rooms (bypass)',
    steps: [{
      file: 'src/components/AppShell.tsx',
      find:
`      if (!hasPin) {
        router.replace('/auth/callback');
        return;
      }`,
      replace:
`      if (!hasPin) {
        router.replace('/rooms'); /* M15: redirect target changed — bypass */
        return;
      }`,
    }],
    kills: ['test-appshell-pin-gate.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M16 ────────────────────────────────────────────────────────────────────
  {
    id: 'M16',
    description: 'v3 sender attribution block bypassed — forged sender accepted',
    steps: [{
      file: 'src/lib/e2ee-core/blob.ts',
      find:
`      const devicePub = await resolveSenderDeviceEd25519Pub(parsed.s, parsed.sd);
      if (!devicePub) {
        throw new CryptoError(
          \`sender device \${parsed.sd} not found (or not trusted)\`,
          'SIGNATURE_INVALID',
        );
      }
      const innerPayloadBytes = stringToBytes(JSON.stringify(parsed.p));
      try {
        const sigOk = await verifyMessage(
          await buildInnerSigMessage(
            BLOB_DOMAIN_V3,
            roomId,
            blob.generation,
            blob.nonce,
            innerPayloadBytes,
          ),
          await fromBase64(parsed.sig),
          devicePub,
        );
        if (!sigOk) {
          throw new CryptoError('sender device signature invalid', 'SIGNATURE_INVALID');
        }
      } finally {
        sodium.memzero(innerPayloadBytes);
      }`,
      replace:
`      /* M16: v3 sender attribution checks bypassed entirely.
         Resolver still called for side-effect parity, but neither the
         device-lookup nor the signature is enforced — any forged sender
         flows through. */
      void (await resolveSenderDeviceEd25519Pub(parsed.s, parsed.sd));`,
    }],
    kills: [
      'test-lovetank-author-attribution.ts',
      'test-gratitude-author-attribution.ts',
      'test-mindreader-author-attribution.ts',
      'test-bribe-author-attribution.ts',
      'test-wishlist-author-attribution.ts',
      // Also kills the impostor-pub case in test-blob-sender-verification.ts
      // (overlap with M08 — both mutations independently catch this).
      'test-blob-sender-verification.ts',
    ],
    survives: ['test-happy-path.ts'],
  },

  // ── M17 ────────────────────────────────────────────────────────────────────
  {
    id: 'M17',
    description: 'v1 blob outer signature check bypassed (legacy read-path)',
    steps: [{
      file: 'src/lib/e2ee-core/blob.ts',
      find:
`    const sigOk = await verifyMessage(
      concatBytes(blob.nonce, blob.ciphertext),
      blob.signature,
      senderEd25519PublicKey,
    );
    if (!sigOk) {
      throw new CryptoError('sender signature invalid', 'SIGNATURE_INVALID');
    }`,
      replace:
`    const sigOk = await verifyMessage(
      concatBytes(blob.nonce, blob.ciphertext),
      blob.signature,
      senderEd25519PublicKey,
    );
    if (!sigOk) {
      /* M17: v1 outer signature check disabled */
      void sigOk;
    }`,
    }],
    kills: ['test-blob-sender-verification-v1.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M18 ────────────────────────────────────────────────────────────────────
  {
    id: 'M18',
    description: 'v2 blob inner signature check bypassed (legacy read-path)',
    steps: [{
      file: 'src/lib/e2ee-core/blob.ts',
      find:
`        if (!sigOk) {
          throw new CryptoError('sender signature invalid', 'SIGNATURE_INVALID');
        }`,
      replace:
`        if (!sigOk) {
          /* M18: v2 inner signature check disabled */
          void sigOk;
        }`,
    }],
    kills: ['test-blob-sender-verification-v2.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M19 ────────────────────────────────────────────────────────────────────
  {
    id: 'M19',
    description: 'Invite envelope signature verification bypassed entirely',
    steps: [{
      file: 'src/lib/e2ee-core/membership.ts',
      find:
`export async function verifyInviteEnvelope(
  fields: InviteEnvelopeFields,
  signature: Bytes,
  inviterDeviceEd25519PublicKey: Bytes,
): Promise<void> {
  const msg = await canonicalInviteMessage(fields);
  await verifyMessageOrThrow(msg, signature, inviterDeviceEd25519PublicKey);
}`,
      replace:
`export async function verifyInviteEnvelope(
  fields: InviteEnvelopeFields,
  signature: Bytes,
  inviterDeviceEd25519PublicKey: Bytes,
): Promise<void> {
  /* M19: invite envelope signature verification bypassed */
  void fields; void signature; void inviterDeviceEd25519PublicKey;
}`,
    }],
    kills: ['test-invite-signature-injection.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M20 ────────────────────────────────────────────────────────────────────
  {
    id: 'M20',
    description: 'roomId dropped from canonical invite message (per-branch: room replay)',
    steps: [{
      file: 'src/lib/e2ee-core/membership.ts',
      find:
`  return concatBytes(
    INVITE_DOMAIN,
    await uuidBytes(f.roomId),
    u32BE(f.generation),`,
      replace:
`  return concatBytes(
    INVITE_DOMAIN,
    /* M20: f.roomId removed from canonical — cross-room sig replay works */
    u32BE(f.generation),`,
    }],
    kills: ['test-invite-signature-injection.ts'],
    survives: ['test-happy-path.ts'],
  },

  // ── M21 ────────────────────────────────────────────────────────────────────
  {
    id: 'M21',
    description: 'expiresAtMs dropped from canonical invite message (per-branch: tampered exp)',
    steps: [{
      file: 'src/lib/e2ee-core/membership.ts',
      find:
`    await uuidBytes(f.inviterUserId),
    await uuidBytes(f.inviterDeviceId),
    u64BE(f.expiresAtMs),
  );
}`,
      replace:
`    await uuidBytes(f.inviterUserId),
    await uuidBytes(f.inviterDeviceId),
    /* M21: f.expiresAtMs removed from canonical — post-sign exp tampering accepted */
  );
}`,
    }],
    kills: ['test-invite-signature-injection.ts'],
    survives: ['test-happy-path.ts'],
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function readNormalized(filePath: string): string {
  return readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function applySteps(mutation: Mutation): Map<string, string> {
  // Group steps by resolved file path (a single mutation may touch the same
  // file multiple times — apply all changes in one write)
  const byFile = new Map<string, { original: string; content: string }>();

  for (const step of mutation.steps) {
    const filePath = resolve(ROOT, step.file);
    if (!byFile.has(filePath)) {
      const original = readNormalized(filePath);
      byFile.set(filePath, { original, content: original });
    }
    const state = byFile.get(filePath)!;
    if (!state.content.includes(step.find)) {
      // Revert everything touched so far before throwing
      for (const [p, { original }] of byFile) writeFileSync(p, original, 'utf8');
      throw new Error(
        `[${mutation.id}] find string not found in ${step.file}:\n  "${step.find.slice(0, 120).replace(/\n/g, '\\n')}..."`,
      );
    }
    state.content = state.content.replace(step.find, step.replace);
  }

  const originals = new Map<string, string>();
  for (const [filePath, { original, content }] of byFile) {
    originals.set(filePath, original);
    writeFileSync(filePath, content, 'utf8');
  }
  return originals;
}

function revertAll(originals: Map<string, string>): void {
  for (const [filePath, original] of originals) {
    writeFileSync(filePath, original, 'utf8');
  }
}

function runTest(testFile: string): { exitCode: number; output: string } {
  const cmd = `npx tsx --env-file=.env.local scripts/${testFile}`;
  try {
    const out = execSync(cmd, {
      cwd: ROOT,
      timeout: 120_000,
      shell: true,
      encoding: 'utf8',
    });
    return { exitCode: 0, output: out.trim() };
  } catch (e: any) {
    const output = [e.stdout?.toString(), e.stderr?.toString()]
      .filter(Boolean).join('\n').trim();
    return { exitCode: e.status ?? 1, output };
  }
}

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

function pass(msg: string)  { console.log(`${GREEN}  ✓${RESET} ${msg}`); }
function fail(msg: string)  { console.log(`${RED}  ✗${RESET} ${msg}`); }
function info(msg: string)  { console.log(`    ${msg}`); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyIdx = args.indexOf('--only');
  const onlyId  = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  const selected = onlyId
    ? MUTATIONS.filter(m => m.id === onlyId)
    : MUTATIONS;

  if (onlyId && selected.length === 0) {
    console.error(`No mutation with id "${onlyId}". Valid ids: ${MUTATIONS.map(m => m.id).join(', ')}`);
    process.exit(1);
  }

  const results: Array<{ id: string; passed: boolean; failures: string[] }> = [];

  for (const mutation of selected) {
    console.log(`\n${BOLD}${mutation.id}${RESET} — ${mutation.description}`);

    if (dryRun) {
      for (const step of mutation.steps) {
        info(`  [dry] would mutate ${step.file}`);
        info(`        find: "${step.find.slice(0, 80).replace(/\n/g, '\\n')}..."`);
      }
      info(`  kills: ${mutation.kills.join(', ')}`);
      continue;
    }

    const failures: string[] = [];
    let originals: Map<string, string> | null = null;

    try {
      originals = applySteps(mutation);

      // Phase 1: kill-list must exit non-zero under mutation
      for (const testFile of mutation.kills) {
        const { exitCode, output } = runTest(testFile);
        if (exitCode !== 0) {
          pass(`${testFile.padEnd(42)} KILLED  (exit ${exitCode})`);
        } else {
          fail(`${testFile.padEnd(42)} NOT KILLED (exit 0 — mutation escaped)`);
          if (output) info(`    last line: ${output.split('\n').pop()}`);
          failures.push(`${testFile} not killed`);
        }
      }

      // Phase 2: survives-list must still exit zero under mutation
      for (const testFile of mutation.survives ?? []) {
        const { exitCode, output } = runTest(testFile);
        if (exitCode === 0) {
          pass(`${testFile.padEnd(42)} SURVIVED (exit 0 as expected)`);
        } else {
          fail(`${testFile.padEnd(42)} BROKEN   (exit ${exitCode} — mutation broke unrelated test)`);
          if (output) info(`    last line: ${output.split('\n').pop()}`);
          failures.push(`${testFile} broken by mutation`);
        }
      }

    } finally {
      if (originals) revertAll(originals);
    }

    // Phase 3: after restore, kill-list must exit zero again
    let restoredOk = true;
    for (const testFile of mutation.kills) {
      const { exitCode } = runTest(testFile);
      if (exitCode === 0) {
        pass(`${testFile.padEnd(42)} RESTORED (exit 0 after revert)`);
      } else {
        fail(`${testFile.padEnd(42)} STILL FAILING after revert`);
        failures.push(`${testFile} still failing after revert`);
        restoredOk = false;
      }
    }

    const passed = failures.length === 0 && restoredOk;
    results.push({ id: mutation.id, passed, failures });
    console.log(passed
      ? `${GREEN}${BOLD}  RESULT: PASS — mutation fully caught${RESET}`
      : `${RED}${BOLD}  RESULT: FAIL — ${failures.join('; ')}${RESET}`);
  }

  // Summary
  if (!dryRun && selected.length > 1) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${BOLD}Summary${RESET}`);
    let allPass = true;
    for (const r of results) {
      const icon = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      console.log(`  ${r.id}  ${icon}`);
      if (!r.passed) {
        allPass = false;
        for (const f of r.failures) console.log(`       ${YELLOW}→ ${f}${RESET}`);
      }
    }
    console.log('');
    if (!allPass) process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
