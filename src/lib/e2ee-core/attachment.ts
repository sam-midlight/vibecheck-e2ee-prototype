/**
 * Image attachment encrypt/decrypt.
 *
 * Attachments live in Supabase Storage (bucket `room-attachments`, path
 * `{roomId}/{blobId}.bin`). Bytes on the wire are:
 *
 *   crypto_aead_xchacha20poly1305_ietf_encrypt(
 *     plaintext    = re-encoded WebP/JPEG bytes,
 *     ad           = uuid(roomId) || uuid(blobId) || u32be(generation) || "vibecheck:attachment:v1",
 *     key          = roomKey.key
 *   )
 *
 * Including `blobId` in AD binds each ciphertext to its own storage path —
 * a server swapping two attachments within the same room will fail AEAD.
 * The distinct AD tag also prevents swap between an attachment and a text
 * blob (whose AD is just `uuid(roomId) || u32be(gen)`).
 *
 * The small metadata header (mime/dimensions/placeholder) travels inside
 * the regular encrypted blob row's JSON payload — no schema change.
 */

import {
  CryptoError,
  type Bytes,
  type RoomKey,
} from './types';
import {
  concatBytes,
  fromHex,
  getSodium,
  randomBytes,
  stringToBytes,
} from './sodium';

const NONCE_BYTES = 24;
const AD_TAG = stringToBytes('vibecheck:attachment:v1');

export const DEFAULT_MAX_DIMENSION = 1600;
export const DEFAULT_QUALITY = 0.82;
export const DEFAULT_PLACEHOLDER_DIMENSION = 24;
export const DEFAULT_PLACEHOLDER_QUALITY = 0.5;
/** Hard cap on the source file *before* re-encode. Sanity limit to avoid OOM on decode. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** The metadata header that lives inside the encrypted blob-row JSON payload. */
export interface ImageAttachmentHeader {
  type: 'image';
  /** MIME of the re-encoded bytes in Storage. Usually `image/webp`. */
  mime: 'image/webp' | 'image/jpeg';
  /** Width of the re-encoded image in px. */
  w: number;
  /** Height of the re-encoded image in px. */
  h: number;
  /** Size of the ciphertext in Storage (for progress UX). */
  byteLen: number;
  /** Tiny inline blurred thumbnail, as a full `data:` URL ready for `<img src>`. */
  placeholder: string;
}

export interface PrepareImageParams {
  /** The original picked file. Accepts anything `createImageBitmap` can decode. */
  file: Blob;
  /** Room key used to encrypt the bytes. */
  roomKey: RoomKey;
  /** Room ID (UUID string) — bound into AD. */
  roomId: string;
  /** Blob ID (UUID string) — also the second path segment in Storage. Bound into AD. */
  blobId: string;

  maxDimension?: number;
  quality?: number;
  placeholderDimension?: number;
  placeholderQuality?: number;
}

export interface PrepareImageResult {
  encryptedBytes: Bytes;
  header: ImageAttachmentHeader;
}

/**
 * Decode → resize → re-encode → strip EXIF → encrypt. Returns the encrypted
 * bytes ready for Storage upload and the plaintext header ready for the
 * outer blob row.
 */
export async function prepareImageForUpload(
  params: PrepareImageParams,
): Promise<PrepareImageResult> {
  const {
    file,
    roomKey,
    roomId,
    blobId,
    maxDimension = DEFAULT_MAX_DIMENSION,
    quality = DEFAULT_QUALITY,
    placeholderDimension = DEFAULT_PLACEHOLDER_DIMENSION,
    placeholderQuality = DEFAULT_PLACEHOLDER_QUALITY,
  } = params;

  if (file.size > MAX_SOURCE_BYTES) {
    throw new CryptoError(
      `image is ${Math.round(file.size / 1024 / 1024)} MB; hard cap is ${MAX_SOURCE_BYTES / 1024 / 1024} MB`,
      'BAD_INPUT',
    );
  }

  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image', // honor EXIF orientation without us parsing it
    resizeWidth: maxDimension,
    resizeQuality: 'high',
  });

  let encoded: Blob;
  let placeholder: string;
  let width: number;
  let height: number;

  try {
    width = bitmap.width;
    height = bitmap.height;

    encoded = await encodeBitmap(bitmap, width, height, quality);

    // Separate tiny re-encode for the placeholder (drawn at placeholderDimension max).
    const placeholderBlob = await encodeBitmap(
      bitmap,
      Math.max(1, Math.round((width / Math.max(width, height)) * placeholderDimension)),
      Math.max(1, Math.round((height / Math.max(width, height)) * placeholderDimension)),
      placeholderQuality,
    );
    placeholder = await blobToDataUrl(placeholderBlob);
  } finally {
    bitmap.close();
  }

  const plaintext = new Uint8Array(await encoded.arrayBuffer());

  const sodium = await getSodium();
  const nonce = await randomBytes(NONCE_BYTES);
  const ad = await buildAttachmentAd(roomId, blobId, roomKey.generation);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    nonce,
    roomKey.key,
  );
  sodium.memzero(plaintext);

  // Wire format: nonce || ciphertext. Storage holds this single opaque blob.
  const encryptedBytes = concatBytes(nonce, ciphertext);

  const header: ImageAttachmentHeader = {
    type: 'image',
    mime: encoded.type === 'image/webp' ? 'image/webp' : 'image/jpeg',
    w: width,
    h: height,
    byteLen: encryptedBytes.byteLength,
    placeholder,
  };

  return { encryptedBytes, header };
}

export interface DecryptImageParams {
  /** Raw bytes downloaded from Storage (nonce || ciphertext). */
  encryptedBytes: Bytes;
  /** Room key at the generation the blob was posted under. */
  roomKey: RoomKey;
  /** Room ID (same UUID string used on upload). */
  roomId: string;
  /** Blob ID (same UUID string used on upload). */
  blobId: string;
  /** Generation the blob was posted under — normally `roomKey.generation`. */
  generation: number;
}

/** Decrypt bytes fetched from Storage. Returns raw image bytes ready for `new Blob`. */
export async function decryptImageAttachment(
  params: DecryptImageParams,
): Promise<Bytes> {
  const { encryptedBytes, roomKey, roomId, blobId, generation } = params;
  if (encryptedBytes.byteLength <= NONCE_BYTES) {
    throw new CryptoError('attachment ciphertext is too short', 'BAD_INPUT');
  }
  if (roomKey.generation !== generation) {
    throw new CryptoError(
      `roomKey generation ${roomKey.generation} does not match blob generation ${generation}`,
      'BAD_GENERATION',
    );
  }
  const nonce = encryptedBytes.subarray(0, NONCE_BYTES);
  const ciphertext = encryptedBytes.subarray(NONCE_BYTES);
  const sodium = await getSodium();
  const ad = await buildAttachmentAd(roomId, blobId, generation);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      ad,
      nonce,
      roomKey.key,
    );
  } catch {
    throw new CryptoError(
      'attachment decryption failed (tampered, wrong room, or wrong generation)',
      'DECRYPT_FAILED',
    );
  }
}

/** Build the AD blob used for attachment AEAD. Distinct tag vs. text blobs. */
async function buildAttachmentAd(
  roomId: string,
  blobId: string,
  generation: number,
): Promise<Bytes> {
  const roomBytes = await fromHex(roomId.replaceAll('-', ''));
  const blobBytes = await fromHex(blobId.replaceAll('-', ''));
  const gen = new Uint8Array(4);
  new DataView(gen.buffer).setUint32(0, generation, false);
  return concatBytes(roomBytes, blobBytes, gen, AD_TAG);
}

/** Storage path for a given (room, blob). The path is server-visible; the bytes at it are not. */
export function attachmentStorageKey(roomId: string, blobId: string): string {
  return `${roomId}/${blobId}.bin`;
}

// ---------------------------------------------------------------------------
// Canvas helpers (browser-only). Kept private — callers use the public API above.
// ---------------------------------------------------------------------------

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  if (typeof document === 'undefined') {
    throw new CryptoError('no canvas implementation available', 'BAD_INPUT');
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function canvasToBlob(
  canvas: AnyCanvas,
  type: string,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  const html = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    html.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`canvas.toBlob returned null for ${type}`))),
      type,
      quality,
    );
  });
}

async function encodeBitmap(
  bitmap: ImageBitmap,
  targetWidth: number,
  targetHeight: number,
  quality: number,
): Promise<Blob> {
  const canvas = createCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) {
    throw new CryptoError('2d canvas context unavailable', 'BAD_INPUT');
  }
  // Cast to any because OffscreenCanvasRenderingContext2D and
  // CanvasRenderingContext2D both accept ImageBitmap as a drawImage source,
  // but TS's union of the two doesn't infer the overload cleanly.
  (ctx as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, targetWidth, targetHeight);

  // Try WebP first (smaller at comparable quality); if the browser silently
  // substitutes (rare but spec-allowed), fall back to JPEG.
  let encoded = await canvasToBlob(canvas, 'image/webp', quality);
  if (encoded.type !== 'image/webp') {
    encoded = await canvasToBlob(canvas, 'image/jpeg', quality);
  }
  return encoded;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}
