# POS License Admin

This folder is a standalone HTML, CSS, and vanilla JavaScript owner dashboard. It uses Supabase Auth and Postgres; it is not part of the React POS bundle.

## Project Architecture

The existing POS stores shop operations in local SQLite. Express owns POS authentication and protected sales, stock, and business APIs; FastAPI is a separate backup/settings service. A Supabase owner account gates the shop, while existing local admin and employee accounts remain in place after license approval. The Windows installer bundles the public verifier key matching the Supabase Edge Function signing key; an app-data copy can override it.

New POS registrations use Supabase Auth. A database trigger creates the customer profile, shop, and pending license. The `validate-license` Edge Function checks the current Supabase license and signs a short-lived ES256 entitlement. Express verifies that signature before POS setup/login and every protected business API. It stores only the signed entitlement in SQLite, not a trusted editable expiry value.

Each new server database gets one UUIDv4 LDI in `app_metadata`. Electron keeps the installation's P-256 private key encrypted with OS-protected storage beside (not in) the SQLite database. The API signs a fresh, one-use identity proof; `validate-license` checks it and binds the Supabase account on its first verified use. Signed entitlements include the LDI, and Express compares that claim with the local database identity on every protected request, including local POS login. A missing/corrupt identity is never silently replaced. Legacy databases enroll only after an authenticated owner sign-in; a different installation needs an explicit owner rebind in the portal. A clone without the original OS-protected key cannot prove possession.

## Security

- The admin site has no registration form. POS customers register with an email and password, confirm by email OTP, and receive a pending license with `is_admin = false`.
- The owner customer list exposes only full name, email, and activation status. The customer management view supports activation duration, extension, and deactivation through the admin-checked database function.
- RLS permits customer access only to their own profile, shop, and license. License changes use the admin-checked `apply_license_action` function.
- The browser uses only the Supabase publishable/anon key. The license flow does not require the service-role key.
- Keep the ES256 private signing key only in Supabase Function secrets. The POS receives only the public verification key.
- Serve the admin site over HTTPS and never commit credentials, private keys, or production `.env` files.

## Supabase Setup

1. In the existing Supabase project's SQL Editor, run `sql/schema.sql`, then `sql/rls-policies.sql`, then `sql/ldi-migration.sql`. These scripts are safe to rerun; the existing schema migration adds `licenses.deactivated_at` and backfills existing suspended licenses from their existing `updated_at` timestamp without changing shop records or sales data. The LDI migration adds owner-readable bindings, verification attempt/audit history, and service-role-only mutation functions; it does not alter POS business records.
2. In Supabase Dashboard, enable **Authentication > Providers > Email** and turn on email confirmations. Configure custom SMTP under **Authentication > SMTP Settings** with a verified sender/domain and working delivery (SPF/DKIM recommended). Supabase's built-in sender is rate limited and is not suitable for reliable customer OTP delivery; resend is client-throttled, but actual delivery must be confirmed through the configured SMTP provider and its logs.
3. The confirmation template is in `supabase/templates/confirmation.html` and referenced by `supabase/config.toml`. Supabase-hosted projects do not apply Auth email templates when deploying Edge Functions: paste this file's contents into **Authentication > Email Templates > Confirm signup**, save, and use the `{{ .Token }}` variable. Set an appropriate OTP expiry under **Authentication > Settings**. The POS verifies this token as a signup OTP; no SMS provider is needed.
4. The owner portal continues to use its existing email/password admin account. Customer registration is email/password and requires email confirmation before the account can sign in and check activation.
5. If creating the owner account from **Authentication > Users**, no signup metadata is required: the trigger supplies a fallback profile and generated internal shop label. Promote only that known owner account in the SQL Editor:

	 ```sql
	 update public.profiles
	 set is_admin = true
	 where id = (
		 select id from auth.users
		 where lower(email) = lower('owner@example.com')
	 );
	 ```

	 Do not expose an admin promotion route or let a browser write `is_admin`.

## Signing Key And Function

Generate an ES256 key pair on a trusted machine and keep both files outside the repository:

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out license-signing-private.pem
openssl pkey -in license-signing-private.pem -pubout -out license-verification-public.pem
```

In Supabase Dashboard, add the contents of the matching `license-signing-private.pem` as the Edge Function secret `LICENSE_SIGNING_PRIVATE_KEY`. For the current Windows release machine, the newly rotated private key is stored outside the repository at `%LOCALAPPDATA%\HuzaifaBytes\supabase-ldi-signing\license-signing-private.pem`; the matching public key is `license-verification-public.pem` at the workspace root and is bundled into the installer. Keep the private key in a secure secret manager and never commit it. Because the signing pair was rotated, previously released installers contain the old verifier and must be upgraded before they can validate newly signed entitlements.

`validate-license` also uses the Supabase Edge Function `SUPABASE_SERVICE_ROLE_KEY` server-side to atomically store binding/attempt records; the owner-only `manage-installation` function uses the same Edge Function secret to run authenticated rebind/block actions. These privileged keys must never be placed in POS build variables, the owner portal, or the desktop app. Set both secrets in Supabase Dashboard → Edge Functions → Secrets, authenticate the Supabase CLI, and from this folder deploy:

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy validate-license
supabase functions deploy manage-installation
```

For `scripts/Start-POS.ps1`, place `license-verification-public.pem` at the workspace root. Desktop packaging includes this file as a resource; an optional copy in the Electron user-data directory beside `pos.db` takes precedence. The public key must match `LICENSE_SIGNING_PRIVATE_KEY`; the POS fails closed if no matching public key is available.

## POS Configuration

The existing project URL and publishable key are already configured in the admin site and used as POS defaults. To override them for a build, copy the workspace `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. These values are public client configuration, not secrets. Never put the signing private key or service-role key in `.env` values prefixed with `VITE_`.

Build the POS after the database and Edge Function are configured:

```sh
pnpm run desktop:build:app
```

## Access Validation And Limits

The POS validates on startup when a customer Supabase session is present and refreshes its signed ES256 entitlement every 30 seconds. Unchanged license responses do not update React state, and failed polls preserve the current session and screen. Active entitlements last for `license_settings.offline_grace_days` (default 3 days, bounded to 30 days) and are capped at the actual license expiry. The signed lease continues across app and machine restarts while the system clock does not move backwards. On owner deactivation, Supabase persists the authoritative `deactivated_at` timestamp and signs it with a 12-hour grace deadline; only Point of Sale and History APIs are eligible during that interval, and existing local staff permissions still apply. Repeated validation cannot extend that deadline. The API denies protected operations after the deadline, including when the app restarts, and the grace token is not extended past that time. Product, sale, inventory, customer, and history rows are retained.

Editing the SQLite cache cannot forge a signature or extend the signed expiry. Local expiry evaluation advances from the signed server-time anchor using OS uptime and checks it against a persisted wall-time delta. After reboot, it advances from the signed wall-time anchor and rejects wall-clock rollback. Repeated app restarts do not reset either persisted anchor. A machine owner can still inspect or patch locally installed software; the signed lease limits normal-app access after deactivation but is not DRM against a machine owner.

## Verification

From the workspace root:

```sh
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/pos-app run typecheck
pnpm --filter @workspace/api-server run build
node --test artifacts/api-server/tests/expenses-report.test.mjs artifacts/api-server/tests/license-api.test.mjs artifacts/api-server/tests/license-entitlement.test.mjs
```

The API tests use temporary databases and generated test keys; they cover bounded offline leases, reboot continuity, grace API allowlists and expiry, staff permissions, identity persistence, independent identities, clone/key mismatch rejection, corrupted identity handling, and persistence across an API restart. Complete live acceptance only after applying the SQL migrations and deploying both Edge Functions. Verify initial registration binds the current LDI, the owner portal displays it, the same installation refreshes its license, a second installation is rejected and recorded, and an admin-approved rebind is audited. Also verify blocked/expired license behavior and offline access through the original signed license lease. A live Supabase/Owner Portal/SMTP test requires the configured project, sender, and owner credentials. Existing SQLite shop data is not migrated or deleted by the LDI migration.

## Files

- `index.html`, `login.html`, `customers.html`, `customer-details.html`
- `css/style.css`
- `js/supabase-client.js`, `js/auth.js`, `js/dashboard.js`, `js/customers.js`, `js/licenses.js`
- `sql/schema.sql`, `sql/rls-policies.sql`
- `supabase/functions/validate-license/index.ts`
