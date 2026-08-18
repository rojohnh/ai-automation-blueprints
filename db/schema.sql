-- ============================================================================
--  ai-automation-blueprints — Postgres / Supabase schema
--
--  Apply with:
--    psql "$DATABASE_URL" -f db/schema.sql
--
--  Design notes worth reading before you change anything:
--
--  * Every table that user data touches carries tenant_id, and RLS is enabled
--    on all of them. The workflows connect with a role that RLS applies to; the
--    approval-gateway Worker connects with the service role, which BYPASSES RLS
--    — so its queries filter tenant_id explicitly in src/db.ts. Two mechanisms,
--    one invariant. See docs/security.md.
--
--  * Idempotency keys are UNIQUE, not just indexed. A replayed webhook has to
--    collide at the database level, because "we check first" loses the race.
--
--  * Money is numeric(12,2), never float. Ask anyone who has debugged a
--    1-cent reconciliation break.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ── 01 · inbound quote requests ─────────────────────────────────────────────

create table if not exists leads (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           text        not null default 'default',
  idempotency_key     text        not null,
  source              text        not null,
  contact             jsonb       not null,
  enquiry             text        not null,
  extraction          jsonb       not null,
  estimated_value_aud numeric(12, 2),
  confidence          numeric(4, 3),
  status              text        not null
                        check (status in ('awaiting_approval', 'auto_accepted', 'quoted', 'lost')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- The replay guard. ON CONFLICT in workflow 01 depends on this constraint.
  constraint leads_idempotency_key_unique unique (idempotency_key)
);

create index if not exists leads_status_created_idx on leads (status, created_at desc);
create index if not exists leads_tenant_idx on leads (tenant_id);

create table if not exists manual_review_queue (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       text        not null default 'default',
  idempotency_key text        not null,
  source          text        not null,
  payload         jsonb       not null,
  reason          text        not null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint manual_review_idempotency_key_unique unique (idempotency_key)
);

-- Partial index: the queue is only ever queried for unresolved rows.
create index if not exists manual_review_open_idx
  on manual_review_queue (created_at)
  where resolved_at is null;

-- ── 02 · supplier invoice extraction ────────────────────────────────────────

create table if not exists inbound_documents (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      text        not null default 'default',
  storage_key    text        not null,
  status         text        not null default 'pending'
                   check (status in ('pending', 'posted', 'needs_review', 'failed')),
  extraction     jsonb,
  review_reasons text[],
  attempts       int         not null default 0,
  last_error     text,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,

  constraint inbound_documents_storage_key_unique unique (tenant_id, storage_key)
);

-- Matches the exact predicate in workflow 02's fetch query, so the poll stays
-- an index scan as the table grows.
create index if not exists inbound_documents_pending_idx
  on inbound_documents (received_at)
  where status = 'pending' and attempts < 3;

-- ── 03 · knowledge assistant (pgvector) ─────────────────────────────────────

create table if not exists kb_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text        not null default 'default',
  title       text        not null,
  source_url  text,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text        not null default 'default',
  document_id uuid        not null references kb_documents (id) on delete cascade,
  chunk_index int         not null,
  chunk_text  text        not null,
  -- 1536 dims = OpenAI text-embedding-3-small. Changing the embedding model
  -- means a new column and a backfill, not an in-place edit.
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now(),

  constraint kb_chunks_document_chunk_unique unique (document_id, chunk_index)
);

-- IVFFlat needs ANALYZE and a populated table before it helps; on a small
-- corpus a sequential scan is genuinely faster. Build it once you have volume.
create index if not exists kb_chunks_embedding_idx
  on kb_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists kb_chunks_tenant_idx on kb_chunks (tenant_id);

create table if not exists kb_interactions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             text        not null default 'default',
  asked_by              text,
  question              text        not null,
  answer                text        not null,
  cited_sources         int[]       not null default '{}',
  -- Non-empty means the model cited a source we never supplied. Alert on this;
  -- it is the single most useful quality signal a RAG system produces.
  fabricated_citations  int[]       not null default '{}',
  grounded              boolean     not null,
  abstained             boolean     not null,
  usage                 jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists kb_interactions_ungrounded_idx
  on kb_interactions (created_at desc)
  where grounded = false;

-- ── 04 · automation health ──────────────────────────────────────────────────

create table if not exists automation_health (
  id                 bigserial primary key,
  checked_at         timestamptz not null,
  window_minutes     int         not null,
  total_failures     int         not null,
  affected_workflows int         not null,
  detail             jsonb       not null default '{}'
);

create index if not exists automation_health_checked_idx
  on automation_health (checked_at desc);

-- ── approval gateway ────────────────────────────────────────────────────────

create table if not exists agent_runs (
  id              uuid primary key,
  tenant_id       text        not null,
  status          text        not null default 'running'
                    check (status in ('running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  objective       text        not null,

  -- The full Anthropic message history. This is what makes a run resumable:
  -- on resume we replay it rather than reconstructing intent from a summary.
  messages        jsonb       not null default '[]',

  -- Results of safe tool calls already executed in the current turn, held here
  -- while a sibling call waits on a human. The API requires one tool_result per
  -- tool_use in a single user turn, so partial answers cannot be sent — and
  -- without this column, a resume would re-execute them.
  pending_results jsonb       not null default '{}',

  result          text,
  error           text,
  iterations      int         not null default 0,
  input_tokens    int         not null default 0,
  output_tokens   int         not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists agent_runs_tenant_status_idx on agent_runs (tenant_id, status);
create index if not exists agent_runs_parked_idx
  on agent_runs (updated_at)
  where status = 'awaiting_approval';

create table if not exists approvals (
  id          uuid primary key,
  run_id      uuid        not null references agent_runs (id) on delete cascade,
  tenant_id   text        not null,
  tool_name   text        not null,
  tool_use_id text        not null,
  tool_input  jsonb       not null,
  summary     text        not null,
  status      text        not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_by  text,
  decided_at  timestamptz,
  reason      text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),

  -- One approval per tool call. Without this, a retried park could create a
  -- second approval for the same action and it could be approved twice.
  constraint approvals_tool_use_unique unique (run_id, tool_use_id),

  -- A decision must record who made it and when; a rejection must say why.
  constraint approvals_decision_complete check (
    (status = 'pending' and decided_by is null and decided_at is null)
    or (status = 'expired')
    or (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null)
  ),
  constraint approvals_rejection_has_reason check (
    status <> 'rejected' or reason is not null
  )
);

create index if not exists approvals_pending_idx
  on approvals (expires_at)
  where status = 'pending';

create table if not exists audit_log (
  id         bigserial primary key,
  run_id     uuid        not null,
  tenant_id  text        not null,
  event      text        not null,
  detail     jsonb       not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists audit_log_run_idx on audit_log (run_id, created_at);

-- Append-only by policy: no UPDATE or DELETE grant is issued below. An audit
-- trail you can edit is not an audit trail.

-- ── expiry sweep ────────────────────────────────────────────────────────────

-- A pending approval nobody answers must not hold a run open forever. Call this
-- from a scheduled workflow (or pg_cron) every few minutes.
create or replace function expire_stale_approvals()
returns table (expired_approvals int, failed_runs int)
language plpgsql
as $$
declare
  approvals_expired int;
  runs_failed       int;
begin
  with bumped as (
    update approvals
       set status = 'expired'
     where status = 'pending'
       and expires_at < now()
    returning run_id
  )
  select count(*)::int into approvals_expired from bumped;

  with stalled as (
    update agent_runs r
       set status = 'failed',
           error  = 'approval expired without a decision',
           updated_at = now()
     where r.status = 'awaiting_approval'
       and not exists (
         select 1 from approvals a
          where a.run_id = r.id and a.status = 'pending'
       )
       and exists (
         select 1 from approvals a
          where a.run_id = r.id and a.status = 'expired'
       )
    returning 1
  )
  select count(*)::int into runs_failed from stalled;

  return query select approvals_expired, runs_failed;
end;
$$;

-- ── row-level security ──────────────────────────────────────────────────────
--
-- Enabled on every tenant-scoped table. The policies below assume Supabase's
-- convention of a `tenant_id` claim in the JWT. The service role bypasses all
-- of this, which is exactly why the Worker filters tenant_id in every query.

alter table leads                enable row level security;
alter table manual_review_queue  enable row level security;
alter table inbound_documents    enable row level security;
alter table kb_documents         enable row level security;
alter table kb_chunks            enable row level security;
alter table kb_interactions      enable row level security;
alter table agent_runs           enable row level security;
alter table approvals            enable row level security;
alter table audit_log            enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'leads', 'manual_review_queue', 'inbound_documents',
    'kb_documents', 'kb_chunks', 'kb_interactions',
    'agent_runs', 'approvals', 'audit_log'
  ]
  loop
    execute format(
      'drop policy if exists tenant_isolation on %I', t
    );
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = coalesce(current_setting(''request.jwt.claims'', true)::jsonb ->> ''tenant_id'', ''default''))',
      t
    );
  end loop;
end;
$$;
