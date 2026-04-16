-- ============================================================================
-- 0025_cross_signing_keys.sql — Matrix-aligned cross-signing key hierarchy
--
-- Splits the monolithic UMK (User Master Key) into three keys:
--   MSK (Master Signing Key): signs SSK and USK cross-sigs. Stays cold.
--   SSK (Self-Signing Key): signs device issuance + revocation certs.
--   USK (User-Signing Key): signs other users' MSK pubs (SAS verification).
--
-- identities.ed25519_pub remains the MSK pub (= old UMK pub). No TOFU break.
-- New columns are nullable: old clients ignore them, new clients populate
-- them on bootstrap or rotation. Verifiers that see ssk_pub present verify
-- the cross-sig chain MSK→SSK before trusting SSK-signed device certs.
-- ============================================================================

ALTER TABLE identities
  ADD COLUMN ssk_pub              text,
  ADD COLUMN ssk_cross_signature  text,
  ADD COLUMN usk_pub              text,
  ADD COLUMN usk_cross_signature  text;

COMMENT ON COLUMN identities.ssk_pub IS
  'Self-Signing Key Ed25519 pub. Signs device issuance + revocation certs. Cross-signed by MSK.';
COMMENT ON COLUMN identities.ssk_cross_signature IS
  'Ed25519 sig by MSK over canonical("vibecheck:crosssig:ssk:v1" || msk_pub || ssk_pub).';
COMMENT ON COLUMN identities.usk_pub IS
  'User-Signing Key Ed25519 pub. Signs other users MSK pubs after SAS verification. Cross-signed by MSK.';
COMMENT ON COLUMN identities.usk_cross_signature IS
  'Ed25519 sig by MSK over canonical("vibecheck:crosssig:usk:v1" || msk_pub || usk_pub).';

-- Update the epoch-bump trigger to also fire on SSK/USK rotation.
CREATE OR REPLACE FUNCTION bump_identity_epoch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.ed25519_pub IS DISTINCT FROM OLD.ed25519_pub
     OR NEW.ssk_pub IS DISTINCT FROM OLD.ssk_pub
     OR NEW.usk_pub IS DISTINCT FROM OLD.usk_pub THEN
    NEW.identity_epoch := COALESCE(OLD.identity_epoch, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$;
