-- ============================================================================
-- 0034_tos_acceptances.sql — record ToS acceptance per user.
--
-- One row per user. `version` is the ToS date string (e.g. '2026-04-18').
-- When the ToS text changes, bump TOS_CURRENT_VERSION in TosModal.tsx and
-- users will be prompted again on next login.
-- ============================================================================

create table tos_acceptances (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  version     text not null,
  accepted_at timestamptz not null default now()
);

alter table tos_acceptances enable row level security;

create policy tos_self on tos_acceptances
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
