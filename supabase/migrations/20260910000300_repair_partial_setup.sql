-- Safe recovery for a partially applied manual setup.
-- This does not delete votes. It creates missing objects and refreshes the public feed/statistics.
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'vote_gender'
  ) then
    create type public.vote_gender as enum ('lover', 'cd', 'mtf', 'tg');
  end if;
end;
$$;

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  voter_name text not null check (char_length(voter_name) between 1 and 40),
  gender public.vote_gender not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.vote_feed (
  id uuid primary key references public.votes(id) on delete cascade,
  voter_name text not null,
  gender public.vote_gender not null,
  created_at timestamptz not null
);

create table if not exists public.vote_stats (
  id smallint primary key default 1 check (id = 1),
  lover_count integer not null default 0 check (lover_count >= 0),
  other_count integer not null default 0 check (other_count >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.vote_rate_limits (
  bucket text not null check (bucket in ('create', 'delete')),
  identifier_hash text not null check (char_length(identifier_hash) = 64),
  window_started_at timestamptz not null default now(),
  attempts integer not null default 1 check (attempts >= 1),
  primary key (bucket, identifier_hash)
);

insert into public.vote_stats (id) values (1) on conflict (id) do nothing;

create or replace function public.add_vote_feed_and_stats()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  insert into public.vote_feed (id, voter_name, gender, created_at)
  values (new.id, new.voter_name, new.gender, new.created_at)
  on conflict (id) do nothing;

  update public.vote_stats
  set lover_count = lover_count + case when new.gender = 'lover' then 1 else 0 end,
      other_count = other_count + case when new.gender = 'lover' then 0 else 1 end,
      updated_at = now()
  where id = 1;
  return new;
end;
$$;

create or replace function public.subtract_vote_stats()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  update public.vote_stats
  set lover_count = greatest(0, lover_count - case when old.gender = 'lover' then 1 else 0 end),
      other_count = greatest(0, other_count - case when old.gender = 'lover' then 0 else 1 end),
      updated_at = now()
  where id = 1;
  return old;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.votes'::regclass and tgname = 'after_vote_insert' and not tgisinternal
  ) then
    create trigger after_vote_insert
    after insert on public.votes
    for each row execute function public.add_vote_feed_and_stats();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.votes'::regclass and tgname = 'after_vote_delete' and not tgisinternal
  ) then
    create trigger after_vote_delete
    after delete on public.votes
    for each row execute function public.subtract_vote_stats();
  end if;
end;
$$;

create or replace function public.submit_vote(
  p_name text,
  p_gender public.vote_gender,
  p_password text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog, pg_temp
as $$
declare
  new_vote_id uuid;
  cleaned_name text := btrim(p_name);
begin
  if cleaned_name is null or char_length(cleaned_name) not between 1 and 40
     or cleaned_name ~ '[[:cntrl:]]' then
    raise exception '이름은 1~40자의 일반 문자로 입력해 주세요.' using errcode = '22023';
  end if;
  if p_gender is null then
    raise exception '성별 분류를 선택해 주세요.' using errcode = '22023';
  end if;
  if p_password is null or octet_length(p_password) not between 4 and 72 then
    raise exception '비밀번호는 4~72바이트여야 합니다.' using errcode = '22023';
  end if;

  insert into public.votes (voter_name, gender, password_hash)
  values (cleaned_name, p_gender, extensions.crypt(p_password, extensions.gen_salt('bf', 12)))
  returning id into new_vote_id;
  return new_vote_id;
end;
$$;

create or replace function public.delete_vote_by_password(p_vote_id uuid, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_catalog, pg_temp
as $$
declare
  deleted_id uuid;
begin
  if p_password is null or octet_length(p_password) not between 4 and 72 then
    return false;
  end if;
  delete from public.votes
  where id = p_vote_id
    and password_hash = extensions.crypt(p_password, password_hash)
  returning id into deleted_id;
  return deleted_id is not null;
end;
$$;

create or replace function public.delete_vote_by_name_and_password(p_name text, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_catalog, pg_temp
as $$
declare
  deleted_id uuid;
  cleaned_name text := btrim(p_name);
begin
  if cleaned_name is null or char_length(cleaned_name) not between 1 and 40
     or p_password is null or octet_length(p_password) not between 4 and 72 then
    return false;
  end if;
  delete from public.votes
  where id = (
    select v.id from public.votes v
    where v.voter_name = cleaned_name
      and v.password_hash = extensions.crypt(p_password, v.password_hash)
    order by v.created_at desc
    limit 1
  )
  returning id into deleted_id;
  return deleted_id is not null;
end;
$$;

create or replace function public.admin_delete_vote(p_vote_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  deleted_id uuid;
begin
  delete from public.votes where id = p_vote_id returning id into deleted_id;
  return deleted_id is not null;
end;
$$;

create or replace function public.consume_vote_rate_limit(p_bucket text, p_identifier_hash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  current_limit integer := case when p_bucket = 'create' then 10 else 20 end;
  existing public.vote_rate_limits%rowtype;
begin
  if p_bucket not in ('create', 'delete') or char_length(p_identifier_hash) <> 64 then
    return false;
  end if;

  select * into existing from public.vote_rate_limits
  where bucket = p_bucket and identifier_hash = p_identifier_hash for update;
  if not found then
    insert into public.vote_rate_limits (bucket, identifier_hash) values (p_bucket, p_identifier_hash);
    return true;
  end if;
  if now() - existing.window_started_at >= interval '1 hour' then
    update public.vote_rate_limits set window_started_at = now(), attempts = 1
    where bucket = p_bucket and identifier_hash = p_identifier_hash;
    return true;
  end if;
  if existing.attempts >= current_limit then return false; end if;
  update public.vote_rate_limits set attempts = attempts + 1
  where bucket = p_bucket and identifier_hash = p_identifier_hash;
  return true;
end;
$$;

-- Populate any data that was created before feed/statistics triggers existed.
insert into public.vote_feed (id, voter_name, gender, created_at)
select id, voter_name, gender, created_at from public.votes
on conflict (id) do nothing;

update public.vote_stats
set lover_count = (select count(*) from public.votes where gender = 'lover'),
    other_count = (select count(*) from public.votes where gender <> 'lover'),
    updated_at = now()
where id = 1;

alter table public.votes enable row level security;
alter table public.vote_feed enable row level security;
alter table public.vote_stats enable row level security;
alter table public.vote_rate_limits enable row level security;

revoke all on table public.votes, public.vote_feed, public.vote_stats, public.vote_rate_limits from anon, authenticated;
grant select on public.vote_feed, public.vote_stats to anon, authenticated;

drop policy if exists "public may read the public participant feed" on public.vote_feed;
drop policy if exists "public may read aggregate vote stats" on public.vote_stats;
create policy "public may read the public participant feed"
on public.vote_feed for select to anon, authenticated using (true);
create policy "public may read aggregate vote stats"
on public.vote_stats for select to anon, authenticated using (true);

revoke all on function public.submit_vote(text, public.vote_gender, text) from public, anon, authenticated;
revoke all on function public.delete_vote_by_password(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_vote_by_name_and_password(text, text) from public, anon, authenticated;
revoke all on function public.admin_delete_vote(uuid) from public, anon, authenticated;
revoke all on function public.consume_vote_rate_limit(text, text) from public, anon, authenticated;
grant execute on function public.submit_vote(text, public.vote_gender, text) to service_role;
grant execute on function public.delete_vote_by_password(uuid, text) to service_role;
grant execute on function public.delete_vote_by_name_and_password(text, text) to service_role;
grant execute on function public.admin_delete_vote(uuid) to service_role;
grant execute on function public.consume_vote_rate_limit(text, text) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vote_feed'
  ) then
    alter publication supabase_realtime add table public.vote_feed;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vote_stats'
  ) then
    alter publication supabase_realtime add table public.vote_stats;
  end if;
end;
$$;
