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
  type LocalParticipant,
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

export type LiveKitAdapterEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason: 'local' | 'remote' | 'revoked' | 'error'; detail?: string }
  | { type: 'participant_joined'; identity: string }
  | { type: 'participant_left'; identity: string }
  | { type: 'token_refreshed'; expiresAt: number }
  | { type: 'token_refresh_failed'; error: string };

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

    // Seed the first key before any connect attempt.
    void this.keyProvider.setKey(opts.initialCallKey.key.buffer as ArrayBuffer);
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
    const tok = await this.fetchToken();
    this.currentToken = tok;
    await this.room.connect(tok.url, tok.jwt);
    await this.room.setE2EEEnabled(true);
    this.scheduleRenewal();
    this.installVisibilityHandler();
  }

  /**
   * Publish local camera + microphone tracks with QVGA constraints applied.
   * Callers can call this after `connect()` to start broadcasting.
   */
  async publishLocalMedia(): Promise<void> {
    await this.room.localParticipant.enableCameraAndMicrophone();
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
