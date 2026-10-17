alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.licenses enable row level security;
alter table public.license_events enable row level security;
alter table public.license_settings enable row level security;

revoke insert, update, delete on public.profiles, public.shops, public.licenses, public.license_events, public.license_settings
	from anon, authenticated;
grant select on public.profiles, public.shops, public.licenses, public.license_events, public.license_settings to authenticated;
revoke update (business_name, phone, email) on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

drop policy if exists "Customers can view their own profile" on public.profiles;
create policy "Customers can view their own profile"
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists "Customers can update their own profile" on public.profiles;
create policy "Customers can update their own profile"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "Admins can manage all profiles" on public.profiles;
drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
on public.profiles
for select
using (public.is_admin());

drop policy if exists "Customers can view their own shop" on public.shops;
create policy "Customers can view their own shop"
on public.shops
for select
using (auth.uid() = profile_id);

drop policy if exists "Admins can manage all shops" on public.shops;
drop policy if exists "Admins can view all shops" on public.shops;
create policy "Admins can view all shops"
on public.shops
for select
using (public.is_admin());

drop policy if exists "Customers can view their own license" on public.licenses;
create policy "Customers can view their own license"
on public.licenses
for select
using (auth.uid() = profile_id);

drop policy if exists "Admins can manage all licenses" on public.licenses;
drop policy if exists "Admins can view all licenses" on public.licenses;
create policy "Admins can view all licenses"
on public.licenses
for select
using (public.is_admin());

drop policy if exists "Customers can view their own audit trail" on public.license_events;
create policy "Customers can view their own audit trail"
on public.license_events
for select
using (auth.uid() = profile_id);

drop policy if exists "Admins can manage all audit events" on public.license_events;
drop policy if exists "Admins can view all audit events" on public.license_events;
create policy "Admins can view all audit events"
on public.license_events
for select
using (public.is_admin());

drop policy if exists "Admins can view license settings" on public.license_settings;
create policy "Admins can view license settings"
on public.license_settings
for select
using (public.is_admin());

drop policy if exists "Customers can read offline grace setting" on public.license_settings;
create policy "Customers can read offline grace setting"
on public.license_settings
for select
using (auth.uid() is not null);
