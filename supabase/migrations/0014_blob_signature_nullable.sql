-- ============================================================================
-- 0014_blob_signature_nullable.sql
--
-- Sealed-Sender-lite (stepping stone): move the Ed25519 sender signature
-- INSIDE the AEAD ciphertext, so the server no longer stores a plaintext
-- per-user fingerprint linkable across blobs. Requires the outer
-- `blobs.signature` column to become nullable; new blobs leave it null.
--
-- Legacy blobs inserted before this change still carry an outer signature
-- and are verified via the legacy code path. The column remains in the
-- schema for backward-compat reads.
--
-- A full "Sealed Sender" implementation additionally hides `sender_id` —
-- that requires an Edge-Function insert path (direct PostgREST insert cannot
-- NULL sender_id under current RLS). Deferred; see docs/port-to-v2.md.
-- ============================================================================

alter table blobs
  alter column signature drop not null;
