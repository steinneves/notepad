-- =====================================================================
-- Private notepad: database setup
--
-- HOW TO USE: In Supabase, open "SQL Editor", click "New query",
-- paste this ENTIRE file, and click "Run".
-- It is safe to run more than once; it never deletes your notepad text
-- or your password.
--
-- The password itself is NOT in this file (this file is public on
-- GitHub). You set it separately; see "Setting or changing the
-- password" in README.md.
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
-- 2. History table: snapshots for restoring old text.
-- ---------------------------------------------------------------------
create table if not exists public.notepad_history (
  id       bigint      generated always as identity primary key,
  content  text        not null,
  saved_at timestamptz not null default now()
);

create index if not exists notepad_history_saved_at_idx
  on public.notepad_history (saved_at desc);


-- ---------------------------------------------------------------------
-- 3. Password storage, in a "private" schema the website API can't see.
--    Only a scrambled (bcrypt) form of the password is stored.
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.notepad_auth (
  id            smallint    primary key default 1 check (id = 1),
  password_hash text,
  failed_count  integer     not null default 0,
  window_start  timestamptz not null default now(),
  locked_until  timestamptz
);

insert into private.notepad_auth (id) values (1) on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 4. Triggers on the notepad table
-- ---------------------------------------------------------------------

-- Before every update: the server sets version and updated_at itself.
create or replace function public.notepad_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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

-- After every update: save the PREVIOUS text to history, at most once a
-- minute. Snapshots older than 14 days are removed.
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


-- ---------------------------------------------------------------------
-- 5. Password check (internal; the website can't call it directly)
--    Returns 'ok', 'wrong', 'locked' or 'not_set'.
--    A WRONG password erases the notepad text immediately (a copy is
--    kept in history first). 10 wrong passwords within an hour lock
--    the notepad for an hour, even for the right password.
-- ---------------------------------------------------------------------
create or replace function private.notepad_check_password(pw text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a private.notepad_auth%rowtype;
  current_text text;
begin
  select * into a from private.notepad_auth where id = 1 for update;

  if a.password_hash is null then
    return 'not_set';
  end if;
  if a.locked_until is not null and a.locked_until > now() then
    return 'locked';
  end if;
  if pw is not null and pw <> ''
     and extensions.crypt(pw, a.password_hash) = a.password_hash then
    return 'ok';
  end if;

  -- Wrong password: keep a copy in history, then erase the text.
  select content into current_text from public.notepad where id = 1 for update;
  if current_text <> '' then
    insert into public.notepad_history (content) values (current_text);
    update public.notepad set content = '' where id = 1;
  end if;

  -- Count the attempt; lock after 10 within an hour.
  if a.window_start < now() - interval '1 hour' then
    a.failed_count := 0;
    a.window_start := now();
  end if;
  update private.notepad_auth
     set failed_count = a.failed_count + 1,
         window_start = a.window_start,
         locked_until = case when a.failed_count + 1 >= 10
                             then now() + interval '1 hour'
                             else locked_until end
   where id = 1;
  return 'wrong';
end;
$$;


-- ---------------------------------------------------------------------
-- 6. The only three things the website is allowed to do
-- ---------------------------------------------------------------------

-- Read the notepad (requires the password). If known_version is given
-- and nothing changed, the text is left out to keep responses small.
create or replace function public.notepad_read(pw text, known_version bigint default null)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  status text;
  r public.notepad%rowtype;
begin
  status := private.notepad_check_password(pw);
  if status <> 'ok' then
    return json_build_object('status', status);
  end if;
  select * into r from public.notepad where id = 1;
  if known_version is not null and r.version = known_version then
    return json_build_object('status', 'ok', 'version', r.version);
  end if;
  return json_build_object('status', 'ok', 'version', r.version, 'content', r.content);
end;
$$;

-- Save new text (requires the password). Only saves if nobody else saved
-- since base_version; otherwise returns the newer text so the page can
-- merge. At most one save per second.
create or replace function public.notepad_save(pw text, new_content text, base_version bigint)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  status text;
  r public.notepad%rowtype;
  new_version bigint;
begin
  status := private.notepad_check_password(pw);
  if status <> 'ok' then
    return json_build_object('status', status);
  end if;
  if char_length(coalesce(new_content, '')) > 10000 then
    return json_build_object('status', 'too_long');
  end if;
  select * into r from public.notepad where id = 1 for update;
  if r.version is distinct from base_version then
    return json_build_object('status', 'conflict', 'version', r.version, 'content', r.content);
  end if;
  if r.updated_at > now() - interval '1 second' then
    return json_build_object('status', 'rate_limited');
  end if;
  update public.notepad set content = coalesce(new_content, '') where id = 1
    returning version into new_version;
  return json_build_object('status', 'saved', 'version', new_version);
end;
$$;

-- Used by the daily keep-alive job. Needs no password and reveals nothing.
create or replace function public.notepad_ping()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from public.notepad);
$$;


-- ---------------------------------------------------------------------
-- 7. Permissions: the public can ONLY call the three functions above.
--    No direct access to any table.
-- ---------------------------------------------------------------------
revoke all on table public.notepad         from anon, authenticated;
revoke all on table public.notepad_history from anon, authenticated;
revoke all on table private.notepad_auth   from anon, authenticated;

alter table public.notepad         enable row level security;
alter table public.notepad_history enable row level security;
alter table private.notepad_auth   enable row level security;

-- Remove the public policies from the earlier, password-less version.
drop policy if exists "public can read the notepad"   on public.notepad;
drop policy if exists "public can update the notepad" on public.notepad;

revoke all on function public.notepad_before_update()                from public, anon, authenticated;
revoke all on function public.notepad_snapshot()                     from public, anon, authenticated;
revoke all on function private.notepad_check_password(text)          from public, anon, authenticated;
revoke all on function public.notepad_read(text, bigint)             from public, anon, authenticated;
revoke all on function public.notepad_save(text, text, bigint)       from public, anon, authenticated;
revoke all on function public.notepad_ping()                         from public, anon, authenticated;

grant execute on function public.notepad_read(text, bigint)       to anon, authenticated;
grant execute on function public.notepad_save(text, text, bigint) to anon, authenticated;
grant execute on function public.notepad_ping()                   to anon, authenticated;


-- ---------------------------------------------------------------------
-- 8. Realtime is no longer used (it can't check a password), so make
--    sure the notepad isn't broadcast.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'notepad'
  ) then
    alter publication supabase_realtime drop table public.notepad;
  end if;
end;
$$;


-- Done. You should see "Success. No rows returned".
