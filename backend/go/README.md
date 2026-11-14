# Cena Go API

HTTP service for Supabase-backed discovery, restaurant operations, and Stripe-hosted online checkout. User-scoped calls forward the caller's Supabase access token. Stripe webhook and payment-state RPCs use a server-only Supabase service credential; it is never returned to clients.

## Run

Requires Go 1.22+.

```sh
cd backend/go
SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
SUPABASE_ANON_KEY=YOUR_PUBLIC_KEY \
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_KEY \
STRIPE_SECRET_KEY=sk_test_... \
STRIPE_WEBHOOK_SECRET=whsec_... \
CENA_WEB_BASE_URL=https://cena.example go run ./cmd/cena-api
```

`PORT` defaults to `8080`. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are required for general API routes. Payment routes also require `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `CENA_WEB_BASE_URL`; the service-role/Stripe secrets belong only in the server environment. `CENA_WEB_BASE_URL` is the configured trusted base used for the fixed `/checkout/success`, `/checkout/cancel`, `/restaurant/connect/return`, and `/restaurant/connect/refresh` redirects. Browser CORS allows the exact origins `http://localhost:8081`, `http://localhost:8082`, `http://127.0.0.1:8081`, and `http://127.0.0.1:8082` by default. Override them with comma-separated `CORS_ALLOWED_ORIGINS`. Preflight permits GET, POST, PATCH, DELETE, OPTIONS and Authorization, Content-Type. `STRIPE_APPLICATION_FEE_CENTS` defaults to 175 cents for newly connected restaurants and is constrained to 150–200; existing restaurant fee mappings are authoritative. `STRIPE_API_BASE_URL` is only accepted for loopback hosts with an `sk_test_` key, for local fake-Stripe integration tests; production calls default to `https://api.stripe.com`. Supabase and Stripe requests have bounded timeouts and response bodies. `/healthz` is a liveness response and does not depend on either service.

Build the Linux container from the repository root with `docker build -t cena-api ./backend/go`. Supply the same environment variables at runtime through the host's configuration or secrets settings. Route public HTTPS traffic to the container's `PORT` and keep at least one instance running for checkout recovery. The image runs as a non-root user and works with a read-only filesystem.

## Routes

- `GET /healthz` returns `{"status":"ok"}`.
- `GET /v1/geocode?address=...` sends a full US street address to the US Census Geocoder and returns only `{"label","latitude","longitude"}` for California matches. It is public, has a 4 second timeout, and does not log the submitted address. Invalid input returns 400, no match 404, and non-California matches 422.
- `GET /v1/catalog` returns `{restaurants,items,slots,inventory}` from fixed, read-only PostgREST queries. Supabase RLS limits every read; caller query params are ignored.
- `POST /v1/discovery` calls the `discover_pickup_feed` RPC. Body keys mirror its arguments: `p_latitude`, `p_longitude`, `p_after`, `p_query`, `p_cuisine`, `p_recent_ids`. Coordinates must be provided together and fall within latitude/longitude ranges. Authentication is optional; if present, the Supabase JWT is forwarded. The response is the database feed object `{recent,explore,nearby,categories,next_cursor}`.
- `POST /v1/orders` returns 410; use online checkout instead.
- `PATCH /v1/orders/{id}/status` body: `{"status":"accepted"}`. Calls `update_order_status` and leaves membership and transition rules to the database.
- `POST /v1/checkout/quote` requires the Supabase access token and `{p_restaurant_id,p_slot_id,p_items,promo_code?}`. It returns database-priced `{restaurant_id,slot_id,subtotal_cents,discount_cents,amount_cents,currency,promo_code,discount_percent}`; null promo fields represent no promotion. The quote is display-only and should be refreshed if stale.
- `POST /v1/checkout` requires `Authorization: Bearer <Supabase access token>` and `{p_restaurant_id,p_slot_id,p_idempotency_key,p_pickup_mode,p_vehicle?,p_items,promo_code?,expected_amount_cents}`. Send `promo_code` and `expected_amount_cents` from the latest quote; the amount is only a freshness check. Go verifies the JWT through Supabase Auth and the reservation RPC recalculates/locks promo redemption and amount server-side before Stripe Checkout. Stripe Checkout is card-only, uses a direct charge (`Stripe-Account`) plus the authoritative application fee, a stable order idempotency key, and fixed server redirects. A new or resumed payment returns `order_id`, `checkout_url`, and the authoritative subtotal/discount/total receipt fields. A previously paid idempotent order returns `status:"paid"` with the same receipt. Stale price returns HTTP 409; terminal expired/failed replay returns HTTP 409 with its status. Retry ambiguous provider errors using the same idempotency key.
- `GET /v1/checkout/{id}` verifies the caller and returns only `{"status":"pending|paid|expired|failed|refunded"}`. It retrieves the Stripe session under the stored connected account and releases expired reservations idempotently. For a completed session, Go verifies the PaymentIntent amount, application fee, status, currency, and charge timestamp before finalizing. The app confirms the order after `paid`.
- `DELETE /v1/checkout/{id}` requests Checkout Session expiry. It returns `{"status":"expired"}` only after Stripe confirms expiry and DB cleanup commits, or `{"status":"paid"}` if the payment already completed. A transient Stripe/DB failure returns an error and the client should keep the checkout pending.
- `POST /v1/stripe/webhook` verifies the raw request body with Stripe's `Stripe-Signature` HMAC and five-minute timestamp tolerance. It processes signed `account.updated`, `account.application.deauthorized`, `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `refund.created`, and `refund.updated` events. Unrelated connected-account Checkout Sessions without Cena's server-written metadata marker are acknowledged and ignored. Webhook processing failures return 503 for Stripe retry. An independently verified refund event can settle a pending attempt even when the API request ended before saving the Stripe refund ID.
- `GET /v1/restaurants/{id}/payments` and `POST /v1/restaurants/{id}/stripe-onboarding` are for authenticated restaurant owners/managers. The latter returns a Stripe-hosted Connect onboarding URL.
- `POST /v1/orders/{id}/refund` lets an authorized restaurant owner/manager request a full Stripe refund for a paid order; it uses the stored connected account and verified PaymentIntent, and the signed refund webhook updates order state.
- `POST /v1/analytics/events` body: `{"event_type":"menu_view","restaurant_id":"UUID or null","payload":{}}`. Calls `track_event`; consent and supported event validation remain in SQL.

User-scoped reads and writes require `Authorization: Bearer <Supabase access token>` and remain under user/RLS controls. Payment endpoints verify identity before using restricted service-only RPCs. Stripe webhook handlers never trust client return URLs, supplied prices, account IDs, or unsigned payment state. Upstream errors are intentionally mapped to generic HTTP errors to avoid exposing database details.

Run unit tests with `go test ./...`.

### Stripe sandbox checkout verification

`TestStripeSandboxCheckoutExpiryIntegration` is opt-in. Run it only against a dedicated non-production Supabase project and a pre-onboarded Stripe test connected account. It requires an active promo code that discounts at least one item, a ready restaurant mapping with a 175-cent application fee, and a pickup slot more than 32 minutes away with inventory available. It creates an unpaid test Checkout Session, verifies the reduced amount and PaymentIntent fee/state, then expires the session through the API. It never opens the hosted URL or submits a payment method. A successful payment confirmation remains a separate manual sandbox-browser check. Deferred cleanup retries by idempotency key and expires any recorded session. If the provider outcome is ambiguous and expiry cannot be confirmed, inspect the sandbox order before rerunning; the API will not release a recorded reservation without Stripe confirmation.

PowerShell example (replace placeholders with sandbox-only values):

```powershell
$env:CENA_STRIPE_SANDBOX_INTEGRATION = '1'
$env:CENA_STRIPE_SANDBOX_CONFIRMATION = 'NONPRODUCTION_SANDBOX_ONLY'
$env:CENA_STRIPE_SANDBOX_PROJECT_REF = '<your-nonprod-project-ref>'
$env:SUPABASE_URL = 'https://<your-nonprod-project-ref>.supabase.co'
$env:SUPABASE_ANON_KEY = '<sandbox-anon-key>'
$env:SUPABASE_SERVICE_ROLE_KEY = '<sandbox-service-role-key>'
$env:CENA_TEST_USER_JWT = '<sandbox-buyer-access-token>'
$env:CENA_TEST_RESTAURANT_ID = '<restaurant-uuid>'
$env:CENA_TEST_SLOT_ID = '<slot-uuid-more-than-32-minutes-away>'
$env:CENA_TEST_ITEM_ID = '<available-item-uuid>'
$env:CENA_TEST_PROMO_CODE = '<active-sandbox-promo-code>'
$env:CENA_TEST_STRIPE_ACCOUNT_ID = 'acct_<sandbox-connected-account>'
$env:STRIPE_SECRET_KEY = 'sk_test_<sandbox-secret-key>'
$env:STRIPE_WEBHOOK_SECRET = '<sandbox-webhook-secret>'
$env:CENA_WEB_BASE_URL = 'https://<sandbox-return-site>'
$env:STRIPE_API_BASE_URL = $null
go test -run '^TestStripeSandboxCheckoutExpiryIntegration$' -count=1 ./internal/api
```

The test refuses live Stripe keys, noncanonical Stripe API hosts, and runs without the explicit project confirmation. It does not print keys, tokens, or Checkout URLs. The integration test is skipped during ordinary `go test ./...` unless `CENA_STRIPE_SANDBOX_INTEGRATION=1` is set.

## Online payments

1. Apply the online payment migrations to the same Supabase project the apps use. Configure the Go API and both app builds for that project.
2. Enable Stripe Connect in a Stripe sandbox. Configure a webhook for **events on connected accounts**, using `/v1/stripe/webhook` at the Go API's public HTTPS address. Select the event types listed above and set `STRIPE_WEBHOOK_SECRET` to that endpoint's signing secret.
3. Set `CENA_WEB_BASE_URL` to the HTTPS site that serves the payment return pages. In Cena for Restaurants, open Payments and complete Stripe onboarding. Refresh until both payments and payouts are enabled.
4. Use Stripe test cards to check a successful order, expired checkout, and merchant refund. Verify the direct charge and the application fee on the Stripe test dashboard before replacing sandbox credentials with production settings.

The Go process starts checkout reconciliation when payment environment variables are present. Migration `20261114000014` supplies the worker's leases and retry schedule. The worker checks recorded sessions that have reached their expiry time. It restores inventory and pickup capacity after Stripe confirms an unpaid expiry, and settles a paid order after verifying the PaymentIntent. Open sessions and temporary provider failures keep their reservations while the worker retries. Run the Go service continuously for recovery when there is no incoming request.
