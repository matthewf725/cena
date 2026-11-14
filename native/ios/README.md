# Native iOS apps

This folder contains two native SwiftUI apps, built independently from the existing Expo targets:

- `CenaCustomer`: live discovery, recents, pickup inventory, email OTP, editable account profile, one-kitchen bag, counter or curbside checkout, Stripe-hosted in-Cena payment, payment confirmation, and order history.
- `CenaRestaurant`: staff email/password sign-in, restaurant membership selection, order operations, menu visibility, curbside setting, and Stripe Connect onboarding.

Both apps call Supabase Auth, PostgREST, SQL RPCs, and the Go API using a shared `URLSession` client in `Shared/CenaBackend.swift`. They do not show fixture orders or menus as though they came from the backend. A missing/failed backend is shown as an actionable error. Customer payment opens only HTTPS `checkout.stripe.com`; the app retains the pending order and bag and shows success only after the Go API reports `paid`. The restaurant app opens only HTTPS `connect.stripe.com` for onboarding.

## Build on macOS

Requires Xcode 15 or newer and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```sh
cd native/ios
xcodegen generate
xcodebuild -project Cena.xcodeproj -scheme CenaCustomer -destination 'generic/platform=iOS Simulator' -configuration Debug SUPABASE_URL='https://YOUR_PROJECT.supabase.co' SUPABASE_ANON_KEY='YOUR_PUBLIC_ANON_KEY' CENA_API_URL='http://127.0.0.1:8080' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Cena.xcodeproj -scheme CenaRestaurant -destination 'generic/platform=iOS Simulator' -configuration Debug SUPABASE_URL='https://YOUR_PROJECT.supabase.co' SUPABASE_ANON_KEY='YOUR_PUBLIC_ANON_KEY' CENA_API_URL='http://127.0.0.1:8080' CODE_SIGNING_ALLOWED=NO build
```

`CENA_API_URL` is required for customer payment and merchant Stripe onboarding; other authenticated data operations can still use Supabase directly. For a physical device, point it at a reachable HTTPS Go API host rather than `127.0.0.1`. Only the public Supabase anon key belongs in the app. Never put a service role key in either target. Set Supabase Auth email OTP and staff password providers in the project dashboard. Apply the repository migrations and seed data before connecting the apps.

The generated targets support iPhone and iPad (iOS 17+). Main content is capped at 760 points in regular-width layouts. Card corners use a `GeometryReader` width measurement and progressively increase below the 390pt baseline.

## Current native scope

The customer app shows upcoming windows and supports payment resume/status confirmation; device-local checkout state persists while payment is pending. Native profile name, phone, and equipment are stored in the Supabase profile row. The restaurant target currently supports live order operations, Stripe onboarding, location-level curbside toggling, and menu visibility review; draft editing, prep-step generation/review/publishing, inventory editing, slot creation, Insights, and richer analytics remain in the Expo restaurant target. Auth token refresh and multi-provider login are not implemented in this first native pass; an expired session requires sign-in again. Card entry remains on Stripe-hosted Checkout; the app does not collect card numbers.
