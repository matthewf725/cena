-- Private bearer-token scoped profiles for the public Cal Poly mobile preview.
-- This intentionally does not read or write public.profiles or Auth identities.
create table public.cal_poly_preview_profiles (
  token_hash bytea primary key check (octet_length(token_hash)=32),
  display_name text not null check (length(display_name) between 1 and 60),
  phone text not null default '' check (length(phone)<=32),
  equipment text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (equipment <@ array['Oven','Stovetop','Microwave','Air fryer','Toaster','Panini press']::text[])
);
alter table public.cal_poly_preview_profiles enable row level security;
revoke all on public.cal_poly_preview_profiles from public,anon,authenticated;

create or replace function public.get_cal_poly_preview_profile(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path=pg_catalog,public,extensions
as $$
declare
  v_profile public.cal_poly_preview_profiles%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'preview profile not found' using errcode='P0002';
  end if;
  select * into v_profile from public.cal_poly_preview_profiles
  where token_hash=extensions.digest(convert_to(p_token,'UTF8'),'sha256');
  if not found then raise exception 'preview profile not found' using errcode='P0002'; end if;
  return jsonb_build_object('profile',jsonb_build_object(
    'display_name',v_profile.display_name,'phone',v_profile.phone,'equipment',to_jsonb(v_profile.equipment)));
end;
$$;

create or replace function public.save_cal_poly_preview_profile(
  p_token text,p_display_name text,p_phone text,p_equipment text[]
) returns jsonb
language plpgsql volatile security definer
set search_path=pg_catalog,public,extensions
as $$
declare
  v_token text;
  v_hash bytea;
  v_name text:=trim(coalesce(p_display_name,''));
  v_phone text:=trim(coalesce(p_phone,''));
  v_equipment text[]:=coalesce(p_equipment,'{}'::text[]);
  v_profile public.cal_poly_preview_profiles%rowtype;
begin
  if length(v_name) not between 1 and 60 then
    raise exception 'display name must be 1 to 60 characters';
  end if;
  if length(v_phone)>32 or (v_phone<>'' and (v_phone !~ '^[0-9+(). -]+$' or
    length(regexp_replace(v_phone,'[^0-9]','','g')) not between 7 and 15)) then
    raise exception 'enter a valid phone number';
  end if;
  if cardinality(v_equipment)>6 or exists(
    select 1 from unnest(v_equipment) as equipment_values(label)
    where label<>all(array['Oven','Stovetop','Microwave','Air fryer','Toaster','Panini press']::text[])
  ) or cardinality(v_equipment)<>(select count(distinct label) from unnest(v_equipment) as equipment_values(label)) then
    raise exception 'invalid kitchen equipment';
  end if;

  if p_token is null then
    -- The raw 256-bit bearer token exists only in the response to this call.
    v_token:=encode(extensions.gen_random_bytes(32),'hex');
    v_hash:=extensions.digest(convert_to(v_token,'UTF8'),'sha256');
    insert into public.cal_poly_preview_profiles(token_hash,display_name,phone,equipment)
    values(v_hash,v_name,v_phone,v_equipment) returning * into v_profile;
  else
    if p_token !~ '^[0-9a-f]{64}$' then raise exception 'preview profile not found' using errcode='P0002'; end if;
    v_hash:=extensions.digest(convert_to(p_token,'UTF8'),'sha256');
    update public.cal_poly_preview_profiles set display_name=v_name,phone=v_phone,equipment=v_equipment,updated_at=now()
    where token_hash=v_hash returning * into v_profile;
    if not found then raise exception 'preview profile not found' using errcode='P0002'; end if;
    v_token:=p_token;
  end if;

  return jsonb_build_object('token',v_token,'profile',jsonb_build_object(
    'display_name',v_profile.display_name,'phone',v_profile.phone,'equipment',to_jsonb(v_profile.equipment)));
end;
$$;

revoke all on function public.get_cal_poly_preview_profile(text) from public,anon,authenticated;
revoke all on function public.save_cal_poly_preview_profile(text,text,text,text[]) from public,anon,authenticated;
grant execute on function public.get_cal_poly_preview_profile(text) to anon,authenticated;
grant execute on function public.save_cal_poly_preview_profile(text,text,text,text[]) to anon,authenticated;

notify pgrst, 'reload schema';
