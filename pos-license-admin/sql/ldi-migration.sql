create table if not exists public.local_database_bindings (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  registered_email text not null,
  local_database_identity uuid,
  public_key text,
  status text not null default 'pending' check (status in ('pending', 'bound', 'blocked')),
  bound_at timestamptz,
  last_verified_at timestamptz,
  last_attempted_ldi uuid,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'bound' and local_database_identity is not null and public_key is not null and bound_at is not null)
    or status <> 'bound'
  )
);

create table if not exists public.local_database_binding_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('first_bound', 'verified', 'mismatch', 'owner_rebind_requested', 'owner_blocked', 'owner_rebind_completed', 'blocked_attempt')),
  previous_ldi uuid,
  requested_ldi uuid,
  details jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.local_database_proof_nonces (
  nonce uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_local_database_binding_events_profile
  on public.local_database_binding_events(profile_id, created_at desc);
create index if not exists idx_local_database_bindings_status
  on public.local_database_bindings(status);

alter table public.local_database_bindings enable row level security;
alter table public.local_database_binding_events enable row level security;
alter table public.local_database_proof_nonces enable row level security;

revoke all on public.local_database_bindings,
  public.local_database_binding_events,
  public.local_database_proof_nonces
  from anon, authenticated;
grant select on public.local_database_bindings,
  public.local_database_binding_events to authenticated;
grant all on public.local_database_bindings,
  public.local_database_binding_events,
  public.local_database_proof_nonces to service_role;

drop policy if exists "Customers and admins can view installation bindings" on public.local_database_bindings;
create policy "Customers and admins can view installation bindings"
on public.local_database_bindings
for select
to authenticated
using (auth.uid() = profile_id or public.is_admin());

drop policy if exists "Customers and admins can view installation binding history" on public.local_database_binding_events;
create policy "Customers and admins can view installation binding history"
on public.local_database_binding_events
for select
to authenticated
using (auth.uid() = profile_id or public.is_admin());

create or replace function public.verify_local_database_identity(
  p_profile_id uuid,
  p_email text,
  p_ldi uuid,
  p_public_key text,
  p_nonce uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_binding public.local_database_bindings%rowtype;
  v_profile_exists boolean;
  v_now timestamptz := now();
  v_action text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service authorization required';
  end if;
  if p_profile_id is null or p_ldi is null or p_nonce is null
    or p_email is null or length(p_email) > 254
    or p_public_key is null or length(p_public_key) > 2048 then
    raise exception 'Invalid installation identity request';
  end if;

  perform 1 from public.profiles where id = p_profile_id for update;
  v_profile_exists := found;
  if not v_profile_exists then
    raise exception 'Customer profile not found';
  end if;

  insert into public.local_database_proof_nonces(nonce, profile_id)
  values (p_nonce, p_profile_id);
  delete from public.local_database_proof_nonces where created_at < v_now - interval '1 day';

  select * into v_binding
  from public.local_database_bindings
  where profile_id = p_profile_id
  for update;

  if not found then
    insert into public.local_database_bindings(
      profile_id, registered_email, local_database_identity, public_key, status, bound_at, last_verified_at
    ) values (
      p_profile_id, lower(trim(p_email)), p_ldi, p_public_key, 'bound', v_now, v_now
    );
    insert into public.local_database_binding_events(
      profile_id, action, requested_ldi, details
    ) values (
      p_profile_id, 'first_bound', p_ldi, jsonb_build_object('email', lower(trim(p_email)))
    );
    return jsonb_build_object('allowed', true, 'status', 'bound');
  end if;

  if v_binding.status = 'pending' then
    update public.local_database_bindings
    set registered_email = lower(trim(p_email)),
        local_database_identity = p_ldi,
        public_key = p_public_key,
        status = 'bound',
        bound_at = v_now,
        last_verified_at = v_now,
        updated_at = v_now
    where profile_id = p_profile_id;
    insert into public.local_database_binding_events(
      profile_id, action, previous_ldi, requested_ldi
    ) values (
      p_profile_id, 'owner_rebind_completed', v_binding.local_database_identity, p_ldi
    );
    return jsonb_build_object('allowed', true, 'status', 'bound');
  end if;

  if v_binding.status = 'bound'
    and v_binding.local_database_identity = p_ldi
    and v_binding.public_key = p_public_key then
    update public.local_database_bindings
    set registered_email = lower(trim(p_email)),
        last_verified_at = v_now,
        updated_at = v_now
    where profile_id = p_profile_id;
    return jsonb_build_object('allowed', true, 'status', 'bound');
  end if;

  v_action := case when v_binding.status = 'blocked' then 'blocked_attempt' else 'mismatch' end;
  update public.local_database_bindings
  set last_attempted_ldi = p_ldi,
      last_attempt_at = v_now,
      updated_at = v_now
  where profile_id = p_profile_id;
  insert into public.local_database_binding_events(
    profile_id, action, previous_ldi, requested_ldi
  ) values (
    p_profile_id, v_action, v_binding.local_database_identity, p_ldi
  );
  return jsonb_build_object('allowed', false, 'status', v_binding.status);
end;
$$;

create or replace function public.update_local_database_binding(
  p_profile_id uuid,
  p_action text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_binding public.local_database_bindings%rowtype;
  v_previous_ldi uuid;
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service authorization required';
  end if;
  if p_action not in ('rebind', 'block') then
    raise exception 'Unsupported installation action';
  end if;
  if not exists(select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'Admin access required';
  end if;
  perform 1 from public.profiles where id = p_profile_id for update;
  if not found then
    raise exception 'Customer profile not found';
  end if;

  select * into v_binding
  from public.local_database_bindings
  where profile_id = p_profile_id
  for update;
  if not found then
    if p_action = 'block' then
      raise exception 'No installation is currently bound';
    end if;
    insert into public.local_database_bindings(
      profile_id, registered_email, status
    )
    select id, lower(coalesce(email, '')), 'pending'
    from public.profiles
    where id = p_profile_id;
    if not found then
      raise exception 'Customer profile not found';
    end if;
    v_previous_ldi := null;
  else
    v_previous_ldi := v_binding.local_database_identity;
    if p_action = 'rebind' then
      update public.local_database_bindings
      set local_database_identity = null,
          public_key = null,
          status = 'pending',
          bound_at = null,
          updated_at = v_now
      where profile_id = p_profile_id;
    else
      update public.local_database_bindings
      set status = 'blocked',
          updated_at = v_now
      where profile_id = p_profile_id;
    end if;
  end if;

  insert into public.local_database_binding_events(
    profile_id, action, previous_ldi, details, created_by
  ) values (
    p_profile_id,
    case when p_action = 'rebind' then 'owner_rebind_requested' else 'owner_blocked' end,
    v_previous_ldi,
    jsonb_build_object('status', case when p_action = 'rebind' then 'pending' else 'blocked' end),
    p_actor_id
  );
  return jsonb_build_object('profile_id', p_profile_id, 'status', case when p_action = 'rebind' then 'pending' else 'blocked' end);
end;
$$;

revoke all on function public.verify_local_database_identity(uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.verify_local_database_identity(uuid, text, uuid, text, uuid) to service_role;
revoke all on function public.update_local_database_binding(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.update_local_database_binding(uuid, text, uuid) to service_role;
