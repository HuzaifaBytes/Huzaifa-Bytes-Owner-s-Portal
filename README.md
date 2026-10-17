# POS License Admin

This folder is a standalone HTML, CSS, and vanilla JavaScript owner dashboard. It uses Supabase Auth and Postgres; it is not part of the React POS bundle.

## Project Architecture

The existing POS stores shop operations in local SQLite. Express owns POS authentication and protected sales, stock, and business APIs; FastAPI is a separate backup/settings service. A Supabase owner account gates the shop, while existing local admin and employee accounts remain in place after license approval.

New POS registrations use Supabase Auth. A database trigger creates the customer profile, shop, and pending license. The `validate-license` Edge Function checks the current Supabase license and signs a short-lived ES256 entitlement. Express verifies that signature before POS setup/login and every protected business API. It stores only the signed entitlement in SQLite, not a trusted editable expiry value.

## Security

- The admin site has no registration form. POS customers register with an email and password, confirm by email OTP, and receive a pending license with `is_admin = false`.
- The owner customer list exposes only full name, email, and activation status. The customer management view supports activation duration, extension, and deactivation through the admin-checked database function.
- RLS permits customer access only to their own profile, shop, and license. License changes use the admin-checked `apply_license_action` function.
- The browser uses only the Supabase publishable/anon key. The license flow does not require the service-role key.
- Keep the ES256 private signing key only in Supabase Function secrets. The POS receives only the public verification key.
- Serve the admin site over HTTPS and never commit credentials, private keys, or production `.env` files.

## Supabase Setup

1. In the existing Supabase project's SQL Editor, run `sql/schema.sql`, then `sql/rls-policies.sql`. Both scripts are safe to rerun; rerun them on an existing project to migrate the signup trigger, activation RPC, and profile update grants.
2. In Supabase Dashboard, enable **Authentication > Providers > Email** and turn on email confirmations. Configure custom SMTP under **Authentication > SMTP Settings** with a verified sender/domain and working delivery (SPF/DKIM recommended).
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

In Supabase Dashboard, add the contents of `license-signing-private.pem` as the Edge Function secret `LICENSE_SIGNING_PRIVATE_KEY`. The function uses the project's built-in `SUPABASE_URL` and `SUPABASE_ANON_KEY`; no service-role secret is needed. From this folder, link and deploy:

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy validate-license
```

For `scripts/Start-POS.ps1`, place `license-verification-public.pem` at the workspace root. For the packaged desktop app, place it in the Electron user-data directory beside `pos.db`. If the public key is missing or invalid, the POS fails closed.

## POS Configuration

The existing project URL and publishable key are already configured in the admin site and used as POS defaults. To override them for a build, copy the workspace `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. These values are public client configuration, not secrets. Never put the signing private key or service-role key in `.env` values prefixed with `VITE_`.

Build the POS after the database and Edge Function are configured:

```sh
pnpm run desktop:build:app
```

## Access Validation And Limits

The POS validates on startup when a customer Supabase session is present and refreshes its signed ES256 entitlement every 30 seconds. Each entitlement expires after 60 seconds; the API checks its signature and expiry for setup, login, and protected business APIs. Deactivation takes effect on the next successful validation, with at most the remaining 60-second lease available to an already-running/offline client. The tradeoff is that POS operations require periodic internet access; after an outage lasting 60 seconds, setup/login and protected APIs are blocked until validation succeeds again. Product, sale, inventory, and history rows are retained.

Editing the SQLite cache cannot forge a signature or extend the signed expiry. Online checks use Supabase server time, so changing the PC clock cannot extend an online-validated license. A machine owner can still inspect or patch locally installed software; the signed lease limits normal-app access after deactivation but is not DRM against a machine owner.

## Verification

From the workspace root:

```sh
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/pos-app run typecheck
pnpm --filter @workspace/api-server run build
node --test artifacts/api-server/tests/expenses-report.test.mjs artifacts/api-server/tests/license-api.test.mjs artifacts/api-server/tests/license-entitlement.test.mjs
```

The API tests use temporary databases and generated test keys. Complete the live acceptance flow only after applying both SQL files, configuring SMTP/email OTP, and deploying the Edge Function: register and verify an email OTP, confirm the customer appears pending with only name/email/status in the owner portal, activate and confirm POS access, deactivate and confirm access is blocked within the 60-second lease, then reactivate. Existing SQLite shop data is not migrated or deleted by the license schema.

## Files

- `index.html`, `login.html`, `customers.html`, `customer-details.html`
- `css/style.css`
- `js/supabase-client.js`, `js/auth.js`, `js/dashboard.js`, `js/customers.js`, `js/licenses.js`
- `sql/schema.sql`, `sql/rls-policies.sql`
- `supabase/functions/validate-license/index.ts`
