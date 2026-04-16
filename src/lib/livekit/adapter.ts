/**
 * LiveKit adapter — binds our per-device CallKey machinery to the LiveKit
 * client SDK.
 *
 * Responsibilities:
 *   1. Construct a LiveKit `Room` with E2EE enabled + QVGA capture defaults.
 *   2. Fetch + refresh short-lived LiveKit JWTs from our edge function.
 *   3. Hand the CallKey to `ExternalE2EEKeyProvider`; re-hand on rotation.
 *   4. Run the silent token-renewal loop (4-minute cadence, exponential
 *      backoff, visibility-change wake-up, revocation-detection).
 *
 * The callers in `bootstrap.ts` talk to THIS layer, not to livekit-client
 * directly. UI talks to bootstrap.
 *
 * See `docs/video-call-design.md` §7 for the design.
 */

import {
  ExternalE2EEKeyProvider,
  Room,
  RoomEvent,
  isLocalParticipant,
  type LocalParticipant,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';
import type { CallKey } from '@/lib/e2ee-core';

/** QVGA + retro defaults. Hardcoded per §8 of the design doc. */
export const QVGA_VIDEO_CONSTRAINTS = {
  resolution: { width: 320, height: 240, frameRate: 15 },
};

export const QVGA_PUBLISH_DEFAULTS = {
  videoEncoding: { maxBitrate: 200_000, maxFramerate: 15 },
  simulcast: false,
};

// ---------------------------------------------------------------------------
// Token fetcher — wraps our edge function.
// ---------------------------------------------------------------------------

export interface LiveKitTokenResponse {
  jwt: string;
  url: string;
  /** Epoch milliseconds. Used to schedule the next renewal. */
  expiresAt: number;
}

/**
 * Factory the caller provides. Typed separately so tests can stub it and so
 * the adapter stays agnostic to which Supabase client instance to use.
 *
 * Implementation calls POST /functions/v1/livekit-token with the caller's
 * auth header and `{call_id, device_id}` body.
 */
export type LiveKitTokenFetcher = (
  callId: string,
  deviceId: string,
) => Promise<LiveKitTokenResponse>;

// ---------------------------------------------------------------------------
// Adapter lifecycle events.
// ---------------------------------------------------------------------------

/**
 * E2EE state transitions surface as `encryption_state` events. The adapter
 * starts 'pending', flips 'active' iff `room.isE2EEEnabled` is true after
 * `setE2EEEnabled(true)` succeeds, and flips to 'failed' on any
 * `RoomEvent.EncryptionError` or a post-connect assertion miss. The call UI
 * must treat 'failed' or 'unsupported' as "DO NOT TRUST THIS CALL" — a
 * fallback to plain DTLS-SRTP means the SFU has plaintext access.
 */
export type EncryptionState = 'pending' | 'active' | 'failed' | 'unsupported';

export type LiveKitAdapterEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason: 'local' | 'remote' | 'revoked' | 'error'; detail?: string }
  | { type: 'participant_joined'; identity: string }
  | { type: 'participant_left'; identity: string }
  | { type: 'token_refreshed'; expiresAt: number }
  | { type: 'token_refresh_failed'; error: string }
  | { type: 'encryption_state'; state: EncryptionState; detail?: string };

/**
 * Does this browser actually support the insertable-streams API that
 * SFrame E2EE requires? Without it, LiveKit silently falls back to plain
 * SRTP and the SFU sees plaintext. We check at adapter construction.
 */
export function browserSupportsE2EE(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof Worker === 'undefined') return false;
  const w = window as typeof window & {
    RTCRtpScriptTransform?: unknown;
    RTCRtpSender?: { prototype?: { createEncodedStreams?: unknown } };
  };
  if (typeof w.RTCRtpScriptTransform !== 'undefined') return true;
  const proto = w.RTCRtpSender?.prototype;
  return typeof proto?.createEncodedStreams === 'function';
}

export type LiveKitAdapterListener = (ev: LiveKitAdapterEvent) => void;

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export interface LiveKitAdapterOptions {
  callId: string;
  deviceId: string;
  initialCallKey: CallKey;
  tokenFetcher: LiveKitTokenFetcher;
  /** Seconds before token exp to pre-fetch the next one. */
  renewalLeadSeconds?: number;
}

/**
 * Owns one LiveKit Room instance and the surrounding renewal loop.
 * Create one per call; dispose via `disconnect()` when the call ends.
 */
export class LiveKitAdapter {
  readonly callId: string;
  readonly deviceId: string;

  private room: Room;
  private keyProvider: ExternalE2EEKeyProvider;
  private tokenFetcher: LiveKitTokenFetcher;
  private renewalLeadMs: number;

  /** Most recent token. Used on any reconnect attempt. */
  private currentToken: LiveKitTokenResponse | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalBackoffMs = 1000;
  private visibilityHandler: (() => void) | null = null;
  private listeners = new Set<LiveKitAdapterListener>();
  private disposed = false;
  private _encryptionState: EncryptionState = 'pending';

  constructor(opts: LiveKitAdapterOptions) {
    this.callId = opts.callId;
    this.deviceId = opts.deviceId;
    this.tokenFetcher = opts.tokenFetcher;
    this.renewalLeadMs = (opts.renewalLeadSeconds ?? 60) * 1000;

    this.keyProvider = new ExternalE2EEKeyProvider();

    // E2EE worker URL — served from /public so Turbopack / webpack / Next.js
    // don't need to resolve a bare module specifier for the Worker
    // constructor (that path throws a minified `e.indexOf is not a function`
    // at runtime under Turbopack). `scripts/sync-livekit-worker.mjs` keeps
    // this file in sync with the installed livekit-client version.
    this.room = new Room({
      encryption: {
        keyProvider: this.keyProvider,
        worker: new Worker('/livekit-e2ee-worker.mjs', { type: 'module' }),
      },
      videoCaptureDefaults: QVGA_VIDEO_CONSTRAINTS,
      publishDefaults: QVGA_PUBLISH_DEFAULTS,
      adaptiveStream: false,
      dynacast: false,
    });

    this.room.on(RoomEvent.Connected, () => this.emit({ type: 'connected' }));
    this.room.on(RoomEvent.Disconnected, (reason) =>
      this.emit({
        type: 'disconnected',
        reason: 'remote',
        detail: reason != null ? String(reason) : undefined,
      }),
    );
    this.room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) =>
      this.emit({ type: 'participant_joined', identity: p.identity }),
    );
    this.room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) =>
      this.emit({ type: 'participant_left', identity: p.identity }),
    );

    // E2EE engine errors (e.g. key mismatch, decrypt failure, worker crash).
    // Any of these means SOMETHING about the encryption pipeline is broken
    // — we flip to 'failed' so the UI can demand the user bail out.
    this.room.on(RoomEvent.EncryptionError, (err) => {
      this.setEncryptionState('failed', err instanceof Error ? err.message : String(err));
    });

    // `room.isE2EEEnabled` is updated AFTER the E2EEManager reports a
    // successful cryptor setup for the local participant via this event —
    // which only fires once an encrypted track is published. Synchronous
    // assertion after `setE2EEEnabled(true)` is racy; this event is the
    // canonical "encryption is actually live" signal.
    this.room.on(
      RoomEvent.ParticipantEncryptionStatusChanged,
      (enabled: boolean, participant?: Participant) => {
        if (!participant || !isLocalParticipant(participant)) return;
        if (enabled) {
          this.setEncryptionState('active');
        } else {
          this.setEncryptionState(
            'failed',
            'local participant encryption went off mid-call',
          );
        }
      },
    );

    // Bail early if the browser can't do insertable streams at all. LiveKit
    // would silently fall back to plain SRTP in that case.
    if (!browserSupportsE2EE()) {
      this.setEncryptionState(
        'unsupported',
        'this browser does not expose insertable-streams — E2EE cannot be enforced',
      );
    }

    // Seed the first key before any connect attempt.
    void this.keyProvider.setKey(opts.initialCallKey.key.buffer as ArrayBuffer);
  }

  get encryptionState(): EncryptionState {
    return this._encryptionState;
  }

  private setEncryptionState(state: EncryptionState, detail?: string): void {
    if (this._encryptionState === state) return;
    this._encryptionState = state;
    this.emit({ type: 'encryption_state', state, detail });
  }

  /** Subscribe to adapter lifecycle events. */
  on(listener: LiveKitAdapterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The raw Room — reference-UX components use this to attach tracks. */
  get rawRoom(): Room {
    return this.room;
  }

  get localParticipant(): LocalParticipant {
    return this.room.localParticipant;
  }

  /** Connect to the SFU, enable E2EE, and start the renewal loop. */
  async connect(): Promise<void> {
    if (this.disposed) throw new Error('adapter disposed');
    if (this._encryptionState === 'unsupported') {
      throw new Error(
        'refusing to connect: this browser cannot enforce E2EE ' +
          '(insertable streams not available). The SFU would see plaintext.',
      );
    }
    const tok = await this.fetchToken();
    this.currentToken = tok;
    await this.room.connect(tok.url, tok.jwt);
    // Enable E2EE mode. With no tracks yet this only flips the flag — the
    // `ParticipantEncryptionStatusChanged` event (that flips us to
    // 'active') only fires once the first encrypted track is published.
    // `publishLocalMedia` handles the wait-for-active + timeout.
    await this.room.setE2EEEnabled(true);

    this.scheduleRenewal();
    this.installVisibilityHandler();
  }

  /**
   * Publish local camera + microphone tracks with QVGA constraints applied.
   * Must be called after `connect()`. Blocks until LiveKit confirms the
   * local participant's cryptor is live (encryptionState → 'active') or
   * `encryptionWaitMs` elapses (default 15s). On timeout, disconnects and
   * throws — we never stay connected with tracks in flight while
   * encryption is not confirmed.
   */
  async publishLocalMedia(encryptionWaitMs = 15_000): Promise<void> {
    await this.room.localParticipant.enableCameraAndMicrophone();
    await this.awaitEncryptionActive(encryptionWaitMs);
  }

  private async awaitEncryptionActive(timeoutMs: number): Promise<void> {
    if (this._encryptionState === 'active') return;
    if (this._encryptionState === 'failed' || this._encryptionState === 'unsupported') {
      throw new Error(`E2EE is in ${this._encryptionState} state — refusing to continue`);
    }
    await new Promise<void>((resolve, reject) => {
      const unlisten = this.on((ev) => {
        if (ev.type !== 'encryption_state') return;
        if (ev.state === 'active') {
          clearTimeout(timer);
          unlisten();
          resolve();
        } else if (ev.state === 'failed' || ev.state === 'unsupported') {
          clearTimeout(timer);
          unlisten();
          reject(
            new Error(
              `E2EE state flipped to ${ev.state} while awaiting activation: ${ev.detail ?? '(no detail)'}`,
            ),
          );
        }
      });
      const timer = setTimeout(() => {
        unlisten();
        this.setEncryptionState(
          'failed',
          `timed out after ${timeoutMs}ms waiting for ParticipantEncryptionStatusChanged(enabled=true). ` +
            `The SFU may be receiving plaintext frames — disconnecting.`,
        );
        void this.room.disconnect(true);
        reject(
          new Error(
            `refusing to stay connected: E2EE did not engage within ${timeoutMs}ms — ` +
              `the SFU would see plaintext frames`,
          ),
        );
      }, timeoutMs);
    });
  }

  /**
   * Re-key the E2EE layer. Called after a successful `rotate_call_key` RPC
   * and fresh envelope fetch. LiveKit SDK bumps its internal keyIndex per
   * call; the caller's `generation` value only shows up in the envelope
   * layer, not in the SFrame layer (which is opaque to generation numbers).
   */
  async rotateKey(nextCallKey: CallKey): Promise<void> {
    await this.keyProvider.setKey(nextCallKey.key.buffer as ArrayBuffer);
  }

  /** Graceful disconnect. Tears down the renewal loop + visibility handler. */
  async disconnect(reason: 'local' | 'error' | 'revoked' = 'local'): Promise<void> {
    this.disposed = true;
    this.clearRenewalTimer();
    this.removeVisibilityHandler();
    try {
      await this.room.disconnect(true);
    } catch {
      // Swallow — we're tearing down.
    }
    this.emit({ type: 'disconnected', reason });
  }

  // ---- Token renewal (§7.3) ----------------------------------------------

  private scheduleRenewal(): void {
    this.clearRenewalTimer();
    if (!this.currentToken || this.disposed) return;

    const now = Date.now();
    const fireAt = this.currentToken.expiresAt - this.renewalLeadMs;
    const delay = Math.max(0, fireAt - now);
    this.renewalTimer = setTimeout(() => {
      void this.renewNow();
    }, delay);
  }

  private clearRenewalTimer(): void {
    if (this.renewalTimer !== null) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private async renewNow(): Promise<void> {
    if (this.disposed) return;
    try {
      const tok = await this.fetchToken();
      this.currentToken = tok;
      this.renewalBackoffMs = 1000;
      this.emit({ type: 'token_refreshed', expiresAt: tok.expiresAt });
      this.scheduleRenewal();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'token_refresh_failed', error: msg });

      // 401/403 from the edge function => device no longer authorised.
      if (/\b(401|403)\b/.test(msg) || /revoked|unauthor/i.test(msg)) {
        void this.disconnect('revoked');
        return;
      }

      // Transient failure: exponential backoff up to 32s, bounded by the
      // current token's actual expiry (don't schedule past it).
      const delay = Math.min(this.renewalBackoffMs, 32_000);
      this.renewalBackoffMs *= 2;
      this.renewalTimer = setTimeout(() => {
        void this.renewNow();
      }, delay);
    }
  }

  private async fetchToken(): Promise<LiveKitTokenResponse> {
    return this.tokenFetcher(this.callId, this.deviceId);
  }

  // ---- Visibility handler -------------------------------------------------
  //
  // Browsers throttle setTimeout in background tabs. On tab foreground, check
  // whether we're past the renewal deadline; if so, renew immediately so we
  // don't drop on a reconnect attempt with a stale token.

  private installVisibilityHandler(): void {
    if (typeof document === 'undefined') return;
    this.visibilityHandler = () => {
      if (this.disposed || document.hidden) return;
      if (!this.currentToken) return;
      const now = Date.now();
      if (now >= this.currentToken.expiresAt - this.renewalLeadMs) {
        void this.renewNow();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private removeVisibilityHandler(): void {
    if (typeof document === 'undefined') return;
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  // ---- Event emitter ------------------------------------------------------

  private emit(ev: LiveKitAdapterEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (err) {
        console.error('LiveKitAdapter listener threw', err);
      }
    }
  }
}
