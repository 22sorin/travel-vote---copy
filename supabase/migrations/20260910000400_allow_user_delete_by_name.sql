-- Lets a voter remove their newest matching vote with their public name and vote password.
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

revoke all on function public.delete_vote_by_name_and_password(text, text) from public, anon, authenticated;
grant execute on function public.delete_vote_by_name_and_password(text, text) to service_role;
