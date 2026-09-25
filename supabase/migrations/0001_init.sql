-- Tubelight: initial schema.
-- App tables live in `public` behind RLS (owner_id = auth.uid()).
-- LangGraph's checkpointer + store live in the `langgraph` schema, which PostgREST never exposes.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto;
create schema if not exists langgraph;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  webhook_token text not null unique default encode(gen_random_bytes(18), 'hex'),
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users who signed up before this migration.
insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data->>'display_name', split_part(email, '@', 1)) from auth.users
on conflict do nothing;

-- ---------------------------------------------------------------- teammates
create table public.teammates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  handle text not null check (handle ~ '^[a-z0-9][a-z0-9_-]{0,23}$'),
  role text not null,
  bio text not null default '',
  system_prompt text not null,
  model text not null,
  allowed_toolkits text[] not null default '{}',
  avatar_shape text not null default 'circle',
  color text not null default '#8b9cf7',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, handle)
);

-- ---------------------------------------------------------------- projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  description text not null default '',
  repo_url text,
  color text not null default '#8b9cf7',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects on delete cascade,
  teammate_id uuid not null references public.teammates on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  added_at timestamptz not null default now(),
  primary key (project_id, teammate_id)
);

-- ---------------------------------------------------------------- threads + messages
-- id is 'dm:<teammate_id>' or 'proj:<project_id>'; also the LangGraph checkpoint thread_id.
create table public.threads (
  id text primary key,
  owner_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('dm', 'project')),
  teammate_id uuid references public.teammates on delete cascade,
  project_id uuid references public.projects on delete cascade,
  last_message_at timestamptz,
  last_read_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create function public.create_dm_thread() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.threads (id, owner_id, kind, teammate_id)
  values ('dm:' || new.id, new.owner_id, 'dm', new.id) on conflict do nothing;
  return new;
end $$;
create trigger teammate_dm_thread after insert on public.teammates
  for each row execute function public.create_dm_thread();

create function public.create_project_thread() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.threads (id, owner_id, kind, project_id)
  values ('proj:' || new.id, new.owner_id, 'project', new.id) on conflict do nothing;
  return new;
end $$;
create trigger project_thread after insert on public.projects
  for each row execute function public.create_project_thread();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id text not null references public.threads on delete cascade,
  owner_id uuid not null references auth.users on delete cascade,
  sender_type text not null check (sender_type in ('user', 'teammate', 'system')),
  teammate_id uuid references public.teammates on delete set null,
  text text not null default '',
  mentions uuid[] not null default '{}',
  kind text not null default 'text'
    check (kind in ('text', 'approval', 'handoff', 'error', 'event')),
  meta jsonb not null default '{}',
  proactive boolean not null default false,
  run_id uuid,
  created_at timestamptz not null default now()
);
create index messages_thread_created on public.messages (thread_id, created_at);

create function public.bump_thread() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.threads set last_message_at = new.created_at where id = new.thread_id;
  return new;
end $$;
create trigger message_bump_thread after insert on public.messages
  for each row execute function public.bump_thread();

-- ---------------------------------------------------------------- runs, approvals, activity
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  thread_id text not null references public.threads on delete cascade,
  teammate_id uuid references public.teammates on delete set null,
  trigger text not null default 'message' check (trigger in ('message', 'event', 'schedule', 'approval')),
  status text not null default 'running'
    check (status in ('running', 'waiting_approval', 'done', 'error', 'cancelled')),
  error text,
  handoffs int not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  thread_id text not null references public.threads on delete cascade,
  teammate_id uuid references public.teammates on delete set null,
  run_id uuid references public.runs on delete set null,
  message_id uuid references public.messages on delete set null,
  tool_name text not null,
  toolkit text,
  title text not null,
  draft jsonb not null default '{}',
  final_args jsonb,
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index approvals_pending on public.approvals (owner_id, status, created_at desc);

create table public.activity (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  run_id uuid references public.runs on delete cascade,
  thread_id text references public.threads on delete cascade,
  teammate_id uuid references public.teammates on delete set null,
  type text not null check (type in (
    'run_start', 'run_end', 'tool_call', 'handoff', 'approval_request', 'approval_decision',
    'memory_write', 'sandbox', 'subagent', 'compaction', 'event', 'error')),
  name text not null default '',
  input jsonb,
  output jsonb,
  status text not null default 'ok' check (status in ('ok', 'error', 'pending')),
  duration_ms int,
  created_at timestamptz not null default now()
);
create index activity_owner_created on public.activity (owner_id, created_at desc);

-- ---------------------------------------------------------------- events + push
create table public.event_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  event_type text not null,            -- e.g. 'error', 'email', 'github_issue', 'schedule'
  match jsonb not null default '{}',   -- equality filters on payload keys; schedule rules use {"cron": "0 9 * * *"}
  project_id uuid references public.projects on delete cascade,
  teammate_id uuid not null references public.teammates on delete cascade,
  instructions text not null default '',
  enabled boolean not null default true,
  max_per_hour int not null default 6,
  created_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  type text not null,
  source text not null default 'webhook',
  payload jsonb not null default '{}',
  rule_id uuid references public.event_rules on delete set null,
  run_id uuid references public.runs on delete set null,
  status text not null default 'received' check (status in ('received', 'routed', 'ignored', 'rate_limited', 'error')),
  created_at timestamptz not null default now()
);

-- Expo push tokens, one per device.
create table public.push_tokens (
  token text primary key,
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  platform text not null default 'unknown',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS: owner-only everywhere
do $$
declare t text;
begin
  foreach t in array array['teammates','projects','project_members','threads','messages','runs',
                           'approvals','activity','event_rules','events','push_tokens'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated
                    using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

alter table public.profiles enable row level security;
create policy own_profile on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table
  public.messages, public.threads, public.approvals, public.activity, public.runs;

-- Private broadcast channel 'thread:<thread_id>' carries typing + token deltas.
create policy thread_broadcast_read on realtime.messages for select to authenticated
  using (exists (
    select 1 from public.threads t
    where t.owner_id = (select auth.uid()) and realtime.topic() = 'thread:' || t.id
  ));
