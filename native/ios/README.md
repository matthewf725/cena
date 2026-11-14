# Native iOS apps

This folder contains two native SwiftUI apps, built independently from the existing Expo targets:

- `CenaCustomer`: live restaurants and published items, pickup slot inventory with same-day cutoff countdown, email OTP sign-in, counter or curbside checkout with required vehicle details, `create_order`, order confirmation, and signed-in order history.
- `CenaRestaurant`: staff email/password sign-in, restaurant membership selection, today's orders and legal status transitions, menu visibility, and curbside setting.

Both apps call Supabase Auth, PostgREST, and the existing SQL RPCs using a shared `URLSession` client in `Shared/CenaBackend.swift`. They do not show fixture orders or menus as though they came from the backend. A missing/failed backend is shown as an actionable error. Checkout is pay-at-pickup per the existing backend contract.

## Build on macOS

Requires Xcode 15 or newer and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```sh
cd native/ios
xcodegen generate
xcodebuild -project Cena.xcodeproj -scheme CenaCustomer -destination 'generic/platform=iOS Simulator' -configuration Debug SUPABASE_URL='https://YOUR_PROJECT.supabase.co' SUPABASE_ANON_KEY='YOUR_PUBLIC_ANON_KEY' CENA_API_URL='http://127.0.0.1:8080' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Cena.xcodeproj -scheme CenaRestaurant -destination 'generic/platform=iOS Simulator' -configuration Debug SUPABASE_URL='https://YOUR_PROJECT.supabase.co' SUPABASE_ANON_KEY='YOUR_PUBLIC_ANON_KEY' CENA_API_URL='http://127.0.0.1:8080' CODE_SIGNING_ALLOWED=NO build
```

`CENA_API_URL` is optional; when set, order creation and merchant status transitions go through the Go API routes in `backend/go`. Otherwise both operations call the same protected Supabase RPCs directly. For a physical device, point it at a reachable HTTPS Go API host rather than `127.0.0.1`. Only the public Supabase anon key belongs in the app. Never put a service role key in either target. Set Supabase Auth email OTP and staff password providers in the project dashboard. Apply the repository migrations and seed data before connecting the apps.

The generated targets support iPhone and iPad (iOS 17+). Main content is capped at 760 points in regular-width layouts and uses rounded item/order cards for compact widths.

## Current native scope

The customer app shows the upcoming windows for a kitchen and lets the customer choose one. Profile editing, saved preferences, search, and analytics consent still live in the Expo app. The restaurant target currently supports live order operations, location-level curbside toggling, and menu visibility review; draft editing, prep-step generation/review/publishing, inventory editing, slot creation, Insights, and richer analytics remain in the Expo restaurant target. Auth token refresh and multi-provider login are not implemented in this first native pass; an expired session requires sign-in again. There is no payment processing in either target.
