# Cena

Cena helps local restaurants sell meal kits for pickup during slower hours. Customers reserve same-day or scheduled pickup, then pay the restaurant when they collect their kit.

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

The Expo apps are browser and device previews of the customer and restaurant workflows. They start with demo data when Supabase is unconfigured. The website marks its browser-local signup preview. Use `pnpm typecheck` and `pnpm test` for the automated checks.

See [native iOS](native/ios/README.md) for the SwiftUI builds and [native Android](native/android/README.md) for the Kotlin builds. The native clients currently cover the core pickup flows. Their READMEs list remaining feature differences and build requirements.

The Go HTTP service runs with `go run ./cmd/cena-api` from `backend/go`. Configure its Supabase URL and public key as described in the [API README](backend/go/README.md). The Expo previews use the API when `EXPO_PUBLIC_CENA_API_URL` is set. `pnpm site:build` compiles the landing page TypeScript to its static hosting directory.

## Connect Supabase

1. Start Supabase CLI v3 with `supabase start`. This project uses local API port `54323` and Mailpit port `54324`. Use `supabase db reset` only to recreate local development data. For a hosted environment, link the project and run `supabase db push`. Load `supabase/seed.sql` only in a sandbox. It inserts illustrative menus and pickup slots.
2. Copy `.env.example` into `apps/customer/.env.local` and `apps/restaurant/.env.local`. Set the project URL and publishable or legacy anon key. For a physical phone or Android emulator, use a project URL the device can reach.
3. Configure the Supabase sign-in and signup email templates to send `{{ .Token }}`. Configure SMTP for hosted email OTP. Provision restaurant staff through Supabase Auth, then insert their memberships with the matching user and restaurant IDs. Restaurant staff use their provisioned credentials.
4. Set the same URL and public key in `apps/site/dist/config.js` to connect the hosted waitlist and privacy request form. For the local site server, set `CENA_SITE_SUPABASE_URL` and `CENA_SITE_SUPABASE_PUBLIC_KEY`. Keep service keys out of both apps and the website.
5. Add `OPENAI_API_KEY` to Supabase Edge Function secrets and deploy `generate-prep`. `OPENAI_PREP_MODEL` can select another compatible structured-output model. The function drafts from restaurant-provided steps, and a restaurant owner or manager reviews and publishes them.

Supabase stores orders and pickup timestamps, enforces stock and cutoff rules, and computes prices from the published catalog. Behavior analytics use an opt-in consent record. The restaurant app shows order and completed-sales summaries. A privileged `operator_analytics` RPC supplies aggregate counts for the operator role.

Customer discovery loads four cuisine rows at a time via `discover_pickup_feed`. Distance estimates are straight-line miles from the selected pickup area or an optional approximate device location. General discovery shows kitchens within 35 miles. Restaurants without coordinates can still appear in search and Recents. The request origin is used for ranking and is never written to the application database.

## Before public launch

- Fill in the operator identity, contacts, retention periods, and terms in `docs/legal` and the matching pages in `apps/site/dist`. Complete the policy and operating review before collecting live data.
- Configure production Supabase, email delivery, restaurant membership, and monitoring. Connect the signup site to the production project before opening access.
- Test each app on real iOS and Android devices and verify an order from customer reservation through restaurant pickup. Shipping requires the platform signing and store accounts.

## Photography

- Pasta by Nano Erdozain. [Pexels](https://www.pexels.com/photo/delicious-rigatoni-pasta-with-tomato-sauce-29039081/)
- Tacos by Viridiana Rivera. [Pexels](https://www.pexels.com/photo/close-up-of-tacos-and-a-lime-on-the-plate-25391589/)
- Salmon bowl by Cup of Couple. [Pexels](https://www.pexels.com/photo/person-holding-a-rice-bowl-with-toppings-7660475/)
- Hummus by Kübra Doğu. [Pexels](https://www.pexels.com/photo/a-dipping-sauce-in-a-bowl-9304931/)
- Kitchen photo. [Pexels](https://www.pexels.com/photo/chef-seen-by-the-glass-26575078/)
