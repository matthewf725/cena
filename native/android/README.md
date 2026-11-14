# Native Android apps

This Gradle project contains two standalone Kotlin Android apps:

- Customer: `com.cena.customer`
- Restaurant: `com.cena.restaurant`

Both use native Android views and share the Cena API contracts with the other clients. Configuration is read from Gradle properties; no secrets or service credentials belong in the APK.

## Build

Install Android Studio with Android SDK platform 36 and JDK 17 or newer. Set `ANDROID_HOME` to the SDK directory and `JAVA_HOME` to Android Studio's JBR (or another JDK 17+). From this directory:

```powershell
.\gradlew.bat :customer:assembleDebug :restaurant:assembleDebug
```

For live service integration, add these properties to `%USERPROFILE%\.gradle\gradle.properties`:

```properties
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-public-anon-key
CENA_API_URL=http://10.0.2.2:8080
```

Use only the public Supabase anon/publishable key. `10.0.2.2` reaches the host machine from the Android emulator; use a reachable HTTPS API origin on a physical device. Debug APKs are written to each module's `build/outputs/apk/debug/` directory.

## Customer app

The customer app includes email OTP sign-in, saved profile/equipment, restaurant and meal-kit discovery, recents, approximate location or address lookup, pickup day/time selection with a live cutoff timer, curbside vehicle details, a persistent bag, and order history. The discovery feed uses the paged `discover_pickup_feed` RPC. Checkout can request an optional promo quote, shows the server-calculated subtotal/discount/total for confirmation, and starts Stripe-hosted Checkout through the Cena API. A payment is only confirmed after the API reports `paid`; pending checkout state is persisted and scoped to its signed-in account. Checkout and onboarding deep links never establish payment success from URL parameters.

## Restaurant app

Restaurant staff sign in, select a restaurant membership, manage curbside availability and order status, view payment connection status, and start Stripe Connect onboarding. Returning through `cena-restaurant://connect/return` refreshes payment status from the authenticated API. Cancellable orders offer a confirmation step before requesting a refund; the UI reports the API's `refunded`, `pending`, or `failed` result and does not directly mark a refund successful.

## Verification and current limits

The native build is `:customer:assembleDebug :restaurant:assembleDebug`. CI can assemble both apps and launch their unauthenticated home/login screens in an API 36 emulator. Live auth, discovery, quoting, checkout, merchant onboarding, order operations, and refunds need a configured Supabase project and reachable Cena API; they were not exercised against production services here. Local Gradle builds require Android Studio's JDK and `ANDROID_HOME` to be set. The local emulator booted but became unresponsive (`System UI isn't responding`), so the on-device check was limited to confirming app launch/screenshots; use CI's clean emulator for a repeatable launch smoke.
