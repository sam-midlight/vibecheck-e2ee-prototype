-- 0005_tighten_handoff_rls.sql
--
-- The initial policy on `device_link_handoffs` was
--   `for all to authenticated using (true) with check (true)`
-- on the theory that the 256-bit `link_nonce` (primary key) was the real gate.
-- That works for confidentiality of a *specific* row, but it also lets any
-- authenticated user:
--   - `SELECT *` and enumerate which users are currently linking a device
--     (leaks `inviting_user_id` + timing),
--   - `DELETE` anyone's pending handoff row — cheap DoS against the QR /
--     approval-code linking flow.
--
-- Tighter model: the device-linking flow always happens within a single
-- `auth.uid()`. Device B signs in with a magic link to the *same account* as
-- device A, so `auth.uid()` is identical on both sides of the handoff. Scope
-- every op to rows where `inviting_user_id = auth.uid()`.
--
-- The `link_nonce` still acts as the confidentiality gate *within* one
-- account (A can't hand its identity to the wrong pending B), but now cross-
-- account enumeration and DoS are blocked.

drop policy if exists handoffs_any_authed on device_link_handoffs;

create policy handoffs_owner_all on device_link_handoffs
  for all to authenticated
  using (inviting_user_id = auth.uid())
  with check (inviting_user_id = auth.uid());
