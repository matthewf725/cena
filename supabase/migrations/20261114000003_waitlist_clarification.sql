alter table public.waitlist_entries
  add column if not exists clarification text
  check (clarification is null or char_length(clarification) <= 500);

drop function public.join_waitlist(text,text);

create function public.join_waitlist(
  p_email text,
  p_role text default 'customer',
  p_clarification text default null
) returns void
language plpgsql security definer set search_path=public,auth as $$
begin
  if length(trim(coalesce(p_email,''))) not between 5 and 320
    or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'valid email required';
  end if;
  if p_role not in ('customer','restaurant_owner','merchant') then raise exception 'invalid role'; end if;
  if p_clarification is not null and char_length(p_clarification)>500 then raise exception 'clarification is too long'; end if;

  insert into public.waitlist_entries(email,role,clarification)
  values(lower(trim(p_email)),p_role,nullif(trim(p_clarification),''))
  on conflict (lower(email)) do nothing;
end $$;

revoke all on function public.join_waitlist(text,text,text) from public;
grant execute on function public.join_waitlist(text,text,text) to anon,authenticated;

notify pgrst, 'reload schema';
