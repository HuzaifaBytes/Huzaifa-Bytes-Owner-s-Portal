create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  business_name text,
  phone text,
  email text,
  customer_id text not null unique,
  shop_id text not null unique,
  license_status text not null default 'pending' check (license_status in ('pending','active','expired','suspended','revoked')),
  registration_date timestamptz not null default now(),
  activated_at timestamptz,
  expiry_date timestamptz,
  last_status_updated_at timestamptz default now(),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  shop_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','active','expired','suspended','revoked')),
  activated_at timestamptz,
  expires_at timestamptz,
  activation_days integer,
  updated_at timestamptz not null default now(),
  activated_by uuid references auth.users(id),
  offline_grace_until timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.licenses add column if not exists deactivated_at timestamptz;
update public.licenses
set deactivated_at = updated_at
where status = 'suspended' and deactivated_at is null;

create table if not exists public.license_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  license_id uuid references public.licenses(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.license_settings (
  id smallint primary key default 1 check (id = 1),
  offline_grace_days integer not null default 3 check (offline_grace_days between 0 and 30),
  updated_at timestamptz not null default now()
);

insert into public.license_settings (id) values (1)
on conflict (id) do nothing;

create index if not exists idx_profiles_license_status on public.profiles (license_status);
create index if not exists idx_licenses_status on public.licenses (status);
create index if not exists idx_licenses_expires_at on public.licenses (expires_at);
create index if not exists idx_license_events_profile on public.license_events (profile_id, created_at desc);

create or replace function public.handle_customer_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_full_name text := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.phone), ''),
    split_part(coalesce(new.email, 'Customer'), '@', 1)
  );
  v_shop_name text := nullif(trim(new.raw_user_meta_data ->> 'shop_name'), '');
  v_business_name text := nullif(trim(new.raw_user_meta_data ->> 'business_name'), '');
  v_phone text := coalesce(nullif(trim(new.phone), ''), nullif(trim(new.raw_user_meta_data ->> 'phone'), ''));
  v_customer_id text := 'CUS-' || upper(replace(gen_random_uuid()::text, '-', ''));
  v_shop_code text := 'SHP-' || upper(replace(gen_random_uuid()::text, '-', ''));
  v_shop_id uuid;
begin
  if v_shop_name is null then
    v_shop_name := 'Shop ' || right(v_shop_code, 8);
  end if;

  insert into public.profiles (
    id, full_name, business_name, phone, email, customer_id, shop_id, license_status
  ) values (
    new.id, v_full_name, v_business_name, v_phone,
    new.email, v_customer_id, v_shop_code, 'pending'
  );

  insert into public.shops (profile_id, shop_name)
  values (new.id, v_shop_name)
  returning id into v_shop_id;

  insert into public.licenses (profile_id, shop_id, status)
  values (new.id, v_shop_id, 'pending');

  return new;
end;
$$;

drop trigger if exists on_customer_auth_user_created on auth.users;
create trigger on_customer_auth_user_created
after insert on auth.users
for each row execute function public.handle_customer_signup();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_admin from public.profiles where id = auth.uid()),
    false
  );
$$;

create or replace function public.preview_license_expiry(
  p_profile_id uuid,
  p_action text,
  p_days integer
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_license public.licenses%rowtype;
  v_now timestamptz := now();
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;
  if p_days is null or p_days not between 1 and 3650 then
    raise exception 'License duration must be between 1 and 3650 days';
  end if;

  select * into v_license from public.licenses where profile_id = p_profile_id;
  if not found then
    raise exception 'Customer license not found';
  end if;

  if p_action = 'activate' and v_license.status = 'pending' then
    return v_now + (p_days * interval '1 day');
  elsif p_action = 'extend'
    and v_license.status = 'active'
    and v_license.expires_at > v_now then
    return v_license.expires_at + (p_days * interval '1 day');
  elsif p_action = 'renew'
    and v_license.status <> 'revoked'
    and v_license.expires_at <= v_now then
    return v_now + (p_days * interval '1 day');
  elsif p_action = 'reactivate'
    and v_license.status = 'suspended'
    and v_license.expires_at > v_now then
    return v_license.expires_at;
  end if;

  raise exception 'This license action is not valid for the current state';
end;
$$;

create or replace function public.apply_license_action(
  p_profile_id uuid,
  p_action text,
  p_days integer default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_profile public.profiles%rowtype;
  v_license public.licenses%rowtype;
  v_status text;
  v_expires_at timestamptz;
  v_grace_days integer;
  v_action text := lower(p_action);
  v_now timestamptz := now();
begin
  v_is_admin := public.is_admin();
  if not v_is_admin then
    raise exception 'Admin access required';
  end if;

  if v_action not in ('activate', 'deactivate', 'extend', 'renew', 'suspend', 'reactivate', 'revoke') then
    raise exception 'Unsupported action';
  end if;

  select * into v_profile from public.profiles where id = p_profile_id;
  if not found then
    raise exception 'Customer profile not found';
  end if;

  if v_action in ('activate', 'extend', 'renew') and (p_days is null or p_days not between 1 and 3650) then
    raise exception 'License duration must be between 1 and 3650 days';
  end if;

  select * into v_license
  from public.licenses
  where profile_id = p_profile_id
  for update;

  if not found then
    raise exception 'Customer license not found';
  end if;

  select offline_grace_days into v_grace_days
  from public.license_settings
  where id = 1;
  v_grace_days := coalesce(v_grace_days, 3);

  if v_action = 'activate' then
    if v_license.status = 'active' and (v_license.expires_at is null or v_license.expires_at > v_now) then
      raise exception 'This account is already active';
    end if;
    v_status := 'active';
    v_expires_at := v_now + (p_days * interval '1 day');
    update public.licenses set
      status = v_status,
      activated_at = v_now,
      expires_at = v_expires_at,
      activation_days = p_days,
      activated_by = auth.uid(),
      updated_at = v_now,
      deactivated_at = null,
      offline_grace_until = v_now + (v_grace_days * interval '1 day')
    where id = v_license.id;
  elsif v_action = 'extend' then
    if v_license.status <> 'active' or (v_license.expires_at is not null and v_license.expires_at <= v_now) then
      raise exception 'Only unexpired active licenses can be extended';
    end if;
    v_expires_at := coalesce(v_license.expires_at, v_now) + (p_days * interval '1 day');
    update public.licenses
      set expires_at = v_expires_at,
          activation_days = coalesce(activation_days, 0) + p_days,
          updated_at = v_now,
          activated_by = auth.uid(),
          deactivated_at = null,
          offline_grace_until = v_now + (v_grace_days * interval '1 day')
    where id = v_license.id;
    v_status := 'active';
  elsif v_action = 'renew' then
    if v_license.status = 'revoked'
      or v_license.expires_at is null
      or v_license.expires_at > v_now then
      raise exception 'Only expired, non-revoked licenses can be renewed';
    end if;
    v_status := 'active';
    v_expires_at := v_now + (p_days * interval '1 day');
    update public.licenses set
      status = v_status,
      expires_at = v_expires_at,
      activation_days = p_days,
      activated_by = auth.uid(),
      updated_at = v_now,
      deactivated_at = null,
      offline_grace_until = v_now + (v_grace_days * interval '1 day')
    where id = v_license.id;
  elsif v_action = 'deactivate' then
    if v_license.status = 'suspended' then
      raise exception 'This account is already deactivated';
    end if;
    update public.licenses
      set status = 'suspended', updated_at = v_now, deactivated_at = v_now, offline_grace_until = v_now
    where id = v_license.id;
    v_status := 'suspended';
  elsif v_action = 'suspend' then
    if v_license.status in ('suspended', 'revoked') then
      raise exception 'This license cannot be suspended from its current state';
    end if;
    update public.licenses
      set status = 'suspended', updated_at = v_now, deactivated_at = v_now, offline_grace_until = v_now
    where id = v_license.id;
    v_status := 'suspended';
  elsif v_action = 'reactivate' then
    if v_license.status <> 'suspended' or v_license.expires_at is null or v_license.expires_at <= v_now then
      raise exception 'Only unexpired suspended licenses can be reactivated';
    end if;
    v_status := 'active';
    update public.licenses
      set status = v_status,
          updated_at = v_now,
          activated_by = auth.uid(),
          deactivated_at = null,
          offline_grace_until = v_now + (v_grace_days * interval '1 day')
    where id = v_license.id;
  elsif v_action = 'revoke' then
    if v_license.status = 'revoked' then
      raise exception 'License is already revoked';
    end if;
    update public.licenses
      set status = 'revoked', updated_at = v_now, deactivated_at = null, expires_at = v_now
    where id = v_license.id;
    v_status := 'revoked';
  end if;

  if v_action = 'activate' or v_action = 'extend' or v_action = 'renew' or v_action = 'reactivate' then
    update public.profiles
      set license_status = 'active',
          expiry_date = (select expires_at from public.licenses where profile_id = p_profile_id),
          activated_at = coalesce((select activated_at from public.licenses where profile_id = p_profile_id), activated_at),
          last_status_updated_at = v_now
    where id = p_profile_id;
  elsif v_action = 'deactivate' or v_action = 'suspend' then
    update public.profiles set license_status = 'suspended', last_status_updated_at = v_now where id = p_profile_id;
  elsif v_action = 'revoke' then
    update public.profiles set license_status = 'revoked', last_status_updated_at = v_now where id = p_profile_id;
  end if;

  select * into v_license from public.licenses where id = v_license.id;

  insert into public.license_events (
    profile_id,
    license_id,
    action,
    details,
    created_by
  )
  values (
    p_profile_id,
    v_license.id,
    v_action,
    jsonb_build_object(
      'status', v_status,
      'days', p_days,
      'reason', p_reason,
      'expires_at', v_license.expires_at,
      'updated_at', v_now
    ),
    auth.uid()
  );

  return jsonb_build_object(
    'profile_id', p_profile_id,
    'status', v_status,
    'expires_at', v_license.expires_at,
    'updated_at', v_now,
    'action', v_action
  );
end;
$$;

revoke execute on function public.apply_license_action(uuid, text, integer, text) from public, anon;
grant execute on function public.apply_license_action(uuid, text, integer, text) to authenticated;
revoke execute on function public.preview_license_expiry(uuid, text, integer) from public, anon;
grant execute on function public.preview_license_expiry(uuid, text, integer) to authenticated;
