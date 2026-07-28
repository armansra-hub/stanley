-- 0036: scoped, expiring upload tickets (2026-07-28).
--
-- Codex runs in a cloud session that cannot read AGENT_TOKEN, so it cannot call
-- /api/agent/documents directly. Rather than widen a long-lived secret, Claude —
-- which does hold the token — mints a ticket bound to the exact Internal IDs of a
-- released package, with an expiry and a use limit, and hands over only the ticket
-- URL. A leaked ticket can upload text for those IDs, until it expires, and nothing
-- else: it cannot read, cannot write grades, and cannot touch other leads.
--
-- The secret is never stored. Only its SHA-256 lives here, so a database read
-- cannot recover a usable ticket.

create table if not exists upload_tickets (
  id           uuid primary key default gen_random_uuid(),
  secret_sha256 text not null,
  scope_ids    text[] not null,                 -- exact NetSuite internal IDs this ticket may upload
  max_uses     integer not null default 50,
  uses         integer not null default 0,
  expires_at   timestamptz not null,
  created_by   text not null default 'claude',
  note         text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists upload_tickets_live_idx on upload_tickets (expires_at, revoked_at);
