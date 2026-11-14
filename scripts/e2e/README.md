# Local browser E2E

Run `pnpm test:e2e` after starting the local Supabase stack and applying the normal schema and seed. The runner never resets the database. It verifies that Supabase REST, Auth, and Mailpit are reachable, provisions unique disposable `@cena.test` accounts and a one-use promo, and uses a loopback-only fake Stripe processor. No real Stripe or external HTTP requests are used by the browser.

The runner starts a Go API on port 8180 and fresh customer and restaurant previews on ports 8081 and 8082. If any preview port is occupied, set `CENA_E2E_CUSTOMER_PORT` and `CENA_E2E_RESTAURANT_PORT` to unused ports; the runner fails rather than reuse a potentially stale bundle. It leaves external services running and only stops processes it started. Set `CENA_E2E_API_PORT` if the default Go port is occupied. Supabase API defaults to 54323 and Mailpit to 54324.

Chromium is the default. Set `CENA_E2E_BROWSERS=chromium,webkit` to run both installed engines. Install engines with `pnpm exec playwright install chromium webkit`. Use `CENA_E2E_HEADLESS=0` to view the browser. Screenshots and a redacted run report are written under `artifacts/e2e/` (ignored by Git). The Supabase CLI status output and credentials are kept in memory and are never printed.

Coverage includes merchant sign-in, fake Connect readiness and fee display, promo creation, customer email OTP/profile persistence, bag persistence, checkout OTP, invalid/valid promo quote cents, pending checkout visibility and idempotent replay, pending cancellation/release, fake payment with signed webhook, paid order state and fee/account snapshots, merchant accept/prepare/ready, payment-safe cancel guard, refund confirmation guard, fake refund, and customer history.
