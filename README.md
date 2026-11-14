# Cena

Cena helps local restaurants sell meal kits for pickup during slower hours. Customers pay in Cena and pick up their kits during a same-day or scheduled window.

## Primary app colors

- Deep Maroon (`#5D100A`)
- Warm Off-White / Soft Ivory (`#FAF6F3`)

## Run locally

Install Node.js 24 and pnpm 11, then run `pnpm install`. Open separate terminals for each app or site.

| Surface | Start | Browser |
| --- | --- | --- |
| Cena customer app preview | `pnpm customer` | `http://localhost:8081` |
| Cena for Restaurants preview | `pnpm restaurant` | `http://localhost:8082` |
| Signup website | `pnpm site` | `http://127.0.0.1:4173` |

The Expo apps are browser and device previews of the customer and restaurant workflows. Both read restaurant, menu, profile, and order records from the configured Supabase database. Load `supabase/seed.sql` in a local sandbox for sample restaurant and pickup data. The website marks its browser-local signup preview. Use `pnpm typecheck` and `pnpm test` for the automated checks.

See [native iOS](native/ios/README.md) for the SwiftUI builds and [native Android](native/android/README.md) for the Kotlin builds. The native clients currently cover the core pickup flows. Their READMEs list remaining feature differences and build requirements.

The Go HTTP service runs with `go run ./cmd/cena-api` from `backend/go`. Configure its Supabase URL and public key as described in the [API README](backend/go/README.md). The Expo previews use the API when `EXPO_PUBLIC_CENA_API_URL` is set. `pnpm site:build` compiles the landing page TypeScript to its static hosting directory.

## Connect Supabase

1. Start Supabase CLI v3 with `supabase start`. This project uses local API port `54323` and Mailpit port `54324`. Use `supabase db reset` only to recreate local development data. For a hosted environment, link the project and run `supabase db push`. Load `supabase/seed.sql` only in a sandbox. It inserts illustrative menus and pickup slots.
2. Copy `.env.example` into `apps/customer/.env.local` and `apps/restaurant/.env.local`. Set the project URL and publishable or legacy anon key. For a physical phone or Android emulator, use a project URL the device can reach.
3. Configure the Supabase sign-in and signup email templates to send `{{ .Token }}`. Configure SMTP for hosted email OTP. Provision restaurant staff through Supabase Auth, then insert their memberships with the matching user and restaurant IDs. Restaurant staff use their provisioned credentials.
4. Set `CENA_SITE_SUPABASE_URL` and `CENA_SITE_SUPABASE_PUBLIC_KEY` for the signup site. The local server serves those values in `config.js`. On Vercel, set them for Production and use `apps/site` as the project root for a Git deployment. The build writes them into the static `config.js`. Use only a publishable or legacy anon key.
5. Add `OPENAI_API_KEY` to Supabase Edge Function secrets and deploy `generate-prep`. `OPENAI_PREP_MODEL` can select another compatible structured-output model. The function drafts from restaurant-provided steps, and a restaurant owner or manager reviews and publishes them.

Supabase stores orders and pickup timestamps, enforces stock and cutoff rules, and computes prices from the published catalog. Behavior analytics use an opt-in consent record. The restaurant app shows order and completed-sales summaries. A privileged `operator_analytics` RPC supplies aggregate counts for the operator role.

## In-app payments

Cena opens Stripe Checkout when a customer confirms a pickup window. The restaurant's connected Stripe account receives the sale. Stripe routes Cena's flat fee to Cena, with a default of **$1.75 per order** and a configurable $1.50–$2.00 range. Processor fees are separate. The customer pays the amount shown at checkout.

Configure the Go API for Stripe Connect in test mode, onboard a restaurant through its Payments screen, and verify a paid order reaches the restaurant before using live keys. See the [payment setup](backend/go/README.md#online-payments). Customer and restaurant builds need the Go API URL in addition to their Supabase settings.

Restaurant owners and managers can create a percentage code for their own restaurant and set its availability window and redemption cap. Cena shows an updated total before payment and revalidates that total before creating the Stripe Checkout Session. An expired unpaid reservation releases its promotion hold. A refunded paid order still counts toward the code's redemption cap.

## Automated app checks

Run `pnpm typecheck`, `pnpm test`, and `go test ./...` from `backend/go` for the SQL and API checks. The browser journey uses a local Supabase project with the current migrations, local Mailpit, and a simulated Stripe server. See the [browser test setup](scripts/e2e/README.md) for fresh-run commands and supported browsers.

Run the [Android emulator smoke checks](scripts/android-smoke.sh) and the [iOS simulator checks](native/ios/README.md#build-on-macos) locally. The [test coverage graph](docs/qa-scenarios.md) tracks the evidence for each workflow. Authenticated purchases, restaurant payment setup, and refunds also need device verification with a Stripe sandbox before public app release.

Customer discovery loads four cuisine rows at a time via `discover_pickup_feed`. Distance estimates are straight-line miles from the selected pickup area or an optional approximate device location. General discovery shows kitchens within 35 miles. Restaurants without coordinates can still appear in search and Recents. The request origin is used for ranking and is never written to the application database.

## Hosted waitlist

The public signup page is at [cena-xi.vercel.app](https://cena-xi.vercel.app). Signups are stored in `public.waitlist_entries` in the hosted Cena Supabase project. The optional note is stored in `clarification`. Review rows in Supabase Table Editor. Visitors can submit the form through `join_waitlist` and cannot read the list.

The hosted project contains the waitlist, privacy-request, account, and ordering tables. Migrations through `20261114000014` and the menu-options migration `20261114000016` were applied through the dashboard. Before a future CLI migration push, compare the live schema and reconcile migration history. The hosted preview currently contains three clearly labeled demo restaurants, four menu items, and sample pickup inventory. The demo restaurants have no connected payment accounts.

## Before launching the apps

- Fill in the operator identity, contacts, retention periods, and app terms in `docs/legal` and the matching pages in `apps/site/dist`.
- Configure hosted email delivery, restaurant memberships, and monitoring. Point the production app builds to the hosted project.
- Test each app on real iOS and Android devices and verify an order from customer reservation through restaurant pickup. Shipping requires the platform signing and store accounts.

## Photography

- Pasta by Nano Erdozain. [Pexels](https://www.pexels.com/photo/delicious-rigatoni-pasta-with-tomato-sauce-29039081/)
- Tacos by Viridiana Rivera. [Pexels](https://www.pexels.com/photo/close-up-of-tacos-and-a-lime-on-the-plate-25391589/)
- Salmon bowl by Cup of Couple. [Pexels](https://www.pexels.com/photo/person-holding-a-rice-bowl-with-toppings-7660475/)
- Hummus by Kübra Doğu. [Pexels](https://www.pexels.com/photo/a-dipping-sauce-in-a-bowl-9304931/)
- Restaurant kitchen. [Pexels](https://www.pexels.com/photo/man-cooking-food-375468/)
- Landing page steps. [Rigatoni](https://www.pexels.com/photo/a-plate-of-pasta-with-sauce-and-spaghetti-14930761/), [takeout kit](https://www.pexels.com/photo/gourmet-asian-style-noodles-in-takeout-box-38644446/), and [tacos](https://www.pexels.com/photo/scrumptious-tacos-on-a-plate-5848700/)
