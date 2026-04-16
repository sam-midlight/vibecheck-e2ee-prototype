/**
 * LiveKit integration layer. Portable peer module alongside `e2ee-core/`
 * and `supabase/` — lift this directory verbatim into V2.
 */

export {
  browserSupportsE2EE,
  LiveKitAdapter,
  QVGA_VIDEO_CONSTRAINTS,
  QVGA_PUBLISH_DEFAULTS,
  type EncryptionState,
  type LiveKitAdapterEvent,
  type LiveKitAdapterListener,
  type LiveKitAdapterOptions,
  type LiveKitTokenFetcher,
  type LiveKitTokenResponse,
} from './adapter';

export { makeDefaultTokenFetcher } from './token-fetcher';
