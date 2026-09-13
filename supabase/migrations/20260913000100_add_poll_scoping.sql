-- Keeps votes for separate trips in the same Supabase project without mixing
-- the public feed or real-time totals. Existing rows remain the Jeju poll.
alter table public.votes
  add column if not exists poll_slug text not null default 'jeju-2027'
  check (poll_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$');

alter table public.vote_feed
  add column if not exists poll_slug text not null default 'jeju-2027'
  check (poll_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$');

alter table public.vote_stats
  add column if not exists poll_slug text not null default 'jeju-2027'
  check (poll_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$');

alter table public.vote_stats drop constraint if exists vote_stats_pkey;
alter table public.vote_stats drop constraint if exists vote_stats_id_check;
alter table public.vote_stats add primary key (poll_slug);
alter table public.vote_stats alter column poll_slug drop default;

create index if not exists votes_poll_slug_created_at_idx
  on public.votes (poll_slug, created_at desc);
create index if not exists vote_feed_poll_slug_created_at_idx
  on public.vote_feed (poll_slug, created_at desc);

-- Backfill the public feed and rebuild every poll's totals before replacing
-- the triggers. This is safe to run when the previous Jeju site has data.
update public.vote_feed as feed
set poll_slug = votes.poll_slug
from public.votes as votes
where votes.id = feed.id and feed.poll_slug is distinct from votes.poll_slug;

insert into public.vote_stats (poll_slug, lover_count, other_count, updated_at)
select poll_slug,
       count(*) filter (where gender = 'lover'),
       count(*) filter (where gender <> 'lover'),
       now()
from public.votes
group by poll_slug
on conflict (poll_slug) do update
set lover_count = excluded.lover_count,
    other_count = excluded.other_count,
    updated_at = excluded.updated_at;

insert into public.vote_stats (poll_slug, lover_count, other_count)
values ('daebudo-2026-autumn', 0, 0)
on conflict (poll_slug) do nothing;

create or replace function public.add_vote_feed_and_stats()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  insert into public.vote_feed (id, poll_slug, voter_name, gender, created_at)
  values (new.id, new.poll_slug, new.voter_name, new.gender, new.created_at)
  on conflict (id) do nothing;

  insert into public.vote_stats (poll_slug, lover_count, other_count, updated_at)
  values (
    new.poll_slug,
    case when new.gender = 'lover' then 1 else 0 end,
    case when new.gender = 'lover' then 0 else 1 end,
    now()
  )
  on conflict (poll_slug) do update
  set lover_count = public.vote_stats.lover_count + excluded.lover_count,
      other_count = public.vote_stats.other_count + excluded.other_count,
      updated_at = now();
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
  where poll_slug = old.poll_slug;
  return old;
end;
$$;

create or replace function public.submit_vote(
  p_name text,
  p_gender public.vote_gender,
  p_password text,
  p_poll_slug text
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
  if p_poll_slug is null or p_poll_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
    raise exception '여행 투표 정보가 올바르지 않습니다.' using errcode = '22023';
  end if;

  insert into public.votes (poll_slug, voter_name, gender, password_hash)
  values (p_poll_slug, cleaned_name, p_gender, extensions.crypt(p_password, extensions.gen_salt('bf', 12)))
  returning id into new_vote_id;
  return new_vote_id;
end;
$$;

create or replace function public.delete_vote_by_name_and_password(
  p_name text,
  p_password text,
  p_poll_slug text
)
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
     or p_password is null or octet_length(p_password) not between 4 and 72
     or p_poll_slug is null or p_poll_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
    return false;
  end if;
  delete from public.votes
  where id = (
    select v.id from public.votes v
    where v.poll_slug = p_poll_slug
      and v.voter_name = cleaned_name
      and v.password_hash = extensions.crypt(p_password, v.password_hash)
    order by v.created_at desc
    limit 1
  )
  returning id into deleted_id;
  return deleted_id is not null;
end;
$$;

create or replace function public.admin_delete_vote(p_vote_id uuid, p_poll_slug text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  deleted_id uuid;
begin
  if p_poll_slug is null or p_poll_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
    return false;
  end if;
  delete from public.votes
  where id = p_vote_id and poll_slug = p_poll_slug
  returning id into deleted_id;
  return deleted_id is not null;
end;
$$;

-- No caller should be able to silently create an unscoped vote after this point.
drop function if exists public.submit_vote(text, public.vote_gender, text);
drop function if exists public.delete_vote_by_name_and_password(text, text);
drop function if exists public.admin_delete_vote(uuid);

revoke all on function public.submit_vote(text, public.vote_gender, text, text) from public, anon, authenticated;
revoke all on function public.delete_vote_by_name_and_password(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_delete_vote(uuid, text) from public, anon, authenticated;
grant execute on function public.submit_vote(text, public.vote_gender, text, text) to service_role;
grant execute on function public.delete_vote_by_name_and_password(text, text, text) to service_role;
grant execute on function public.admin_delete_vote(uuid, text) to service_role;

-- Delete events need the previous poll_slug for Supabase Realtime filtering.
alter table public.vote_feed replica identity full;
