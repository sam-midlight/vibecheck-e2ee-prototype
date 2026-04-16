-- ============================================================================
-- 0026_signing_key_wrap.sql — SSK+USK secret sharing during device approval
--
-- When device A approves device B, A seals its SSK+USK privs to B's X25519
-- pub via crypto_box_seal and writes the ciphertext here. B unseals on
-- enrollment, becoming a co-primary that can approve further devices.
-- MSK never travels — only SSK+USK.
-- ============================================================================

ALTER TABLE devices
  ADD COLUMN signing_key_wrap text;

COMMENT ON COLUMN devices.signing_key_wrap IS
  'crypto_box_seal(ssk_priv(64) || usk_priv(64), device.x25519_pub). Written by the approving device. Null for bootstrapping devices (they generate SSK/USK locally).';
