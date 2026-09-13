-- Run this once only if the first travel-vote migration was already applied.
-- It changes the server-side password minimum from 8 bytes to 4 bytes.
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
