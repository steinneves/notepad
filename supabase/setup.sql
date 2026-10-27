-- =====================================================================
-- Public notepad: database setup
--
-- HOW TO USE: In Supabase, open "SQL Editor", click "New query",
-- paste this ENTIRE file, and click "Run".
-- It is safe to run more than once; it never deletes your notepad text.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. The notepad table: exactly one row (id is forced to be 1)
-- ---------------------------------------------------------------------
create table if not exists public.notepad (
  id         smallint    primary key default 1 check (id = 1),
  content    text        not null default '',
  version    bigint      not null default 0,
  updated_at timestamptz not null default now(),
  constraint notepad_content_max_length check (char_length(content) <= 10000)
);

insert into public.notepad (id) values (1) on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 2. History table: snapshots for restoring after vandalism.
--    The public has NO access to this table.
-- ---------------------------------------------------------------------
create table if not exists public.notepad_history (
  id       bigint      generated always as identity primary key,
  content  text        not null,
  saved_at timestamptz not null default now()
);

create index if not exists notepad_history_saved_at_idx
  on public.notepad_history (saved_at desc);


-- ---------------------------------------------------------------------
-- 3. Trigger: before every update
--    - rejects updates that come less than 1 second after the last one
--    - sets updated_at and version on the server (visitors can't fake them)
-- ---------------------------------------------------------------------
create or replace function public.notepad_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.updated_at > now() - interval '1 second' then
    raise exception 'rate_limited: notepad was updated less than a second ago'
      using errcode = 'P0001';
  end if;
  new.id         := old.id;
  new.version    := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists notepad_before_update on public.notepad;
create trigger notepad_before_update
  before update on public.notepad
  for each row execute function public.notepad_before_update();


-- ---------------------------------------------------------------------
-- 4. Trigger: after every update, save the PREVIOUS text to history,
--    at most once per minute. Saving the previous text means that if
--    someone wipes the notepad, the good version just before it is kept.
--    Snapshots older than 14 days are removed to stay within the free
--    tier's storage.
--    "security definer" lets this run with the owner's rights, because
--    the public itself is not allowed to touch the history table.
-- ---------------------------------------------------------------------
create or replace function public.notepad_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.content is distinct from new.content
     and old.content <> ''
     and not exists (
       select 1 from public.notepad_history
       where saved_at > now() - interval '1 minute'
     )
  then
    insert into public.notepad_history (content) values (old.content);
    delete from public.notepad_history where saved_at < now() - interval '14 days';
  end if;
  return null;
end;
$$;

drop trigger if exists notepad_snapshot on public.notepad;
create trigger notepad_snapshot
  after update on public.notepad
  for each row execute function public.notepad_snapshot();

-- Nobody can call these functions directly; they only run as triggers.
revoke all on function public.notepad_before_update() from public, anon, authenticated;
revoke all on function public.notepad_snapshot()      from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. Permissions + Row Level Security
--    Public visitors ("anon"; "authenticated" too, in case someone signs
--    up through Supabase Auth) may only:
--      - read the notepad row
--      - change the "content" column of that row
--    No insert, no delete, no access to history.
-- ---------------------------------------------------------------------
revoke all on table public.notepad         from anon, authenticated;
revoke all on table public.notepad_history from anon, authenticated;

grant select           on table public.notepad to anon, authenticated;
grant update (content) on table public.notepad to anon, authenticated;

alter table public.notepad         enable row level security;
alter table public.notepad_history enable row level security;

drop policy if exists "public can read the notepad"   on public.notepad;
drop policy if exists "public can update the notepad" on public.notepad;

create policy "public can read the notepad"
  on public.notepad for select
  to anon, authenticated
  using (id = 1);

create policy "public can update the notepad"
  on public.notepad for update
  to anon, authenticated
  using (id = 1)
  with check (id = 1);

-- (notepad_history has RLS on and no policies = no public access at all)


-- ---------------------------------------------------------------------
-- 6. Turn on Realtime for the notepad table
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'notepad'
  ) then
    alter publication supabase_realtime add table public.notepad;
  end if;
end;
$$;


-- Done. You should see "Success. No rows returned".
