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
SUPABASE_URL=http://10.0.2.2:54323
SUPABASE_KEY=your-public-anon-key
CENA_API_URL=http://10.0.2.2:8080
```

These local defaults are for development and are never accepted for a distribution build. Ordinary `assembleRelease` remains available as an unsigned local artifact. A `bundleRelease` task, or any release build invoked with `-PcenaDistribution=true`, requires production endpoints and a locally owned release keystore. Distribution configuration is read from the current process environment:

```text
CENA_SUPABASE_URL                 Production Supabase HTTPS URL
CENA_SUPABASE_ANON_KEY            Public/publishable anon key only (service-role keys are rejected)
CENA_API_URL                      Production Cena API HTTPS URL
CENA_ANDROID_KEYSTORE_FILE        Absolute path to your existing release keystore
CENA_ANDROID_KEYSTORE_PASSWORD    Keystore password
CENA_ANDROID_KEY_ALIAS            Existing release key alias
CENA_ANDROID_KEY_PASSWORD         Key password
```

The production URLs must use HTTPS and a public hostname; localhost, emulator, private IP, `.local`, `.internal`, and `.test` hosts are rejected. Signing credentials are passed to Gradle from the process environment, are not printed by the build, and must never be committed or placed in `gradle.properties`. Read passwords into environment variables interactively in the current PowerShell session rather than typing them into a command or saving them in a script. The key must be the existing key owned by the app publisher; do not use the Android debug key or create a replacement for an app already published.

Build Android App Bundles for local review (this does not submit them):

```powershell
.\gradlew.bat :customer:bundleRelease :restaurant:bundleRelease
```

Or build signed APKs for local installation with the same validation:

```powershell
.\gradlew.bat -PcenaDistribution=true :customer:assembleRelease :restaurant:assembleRelease
```

The first distribution build fails before compilation if a required endpoint, public key, keystore, alias, or password is missing. Bump each app's `versionCode` before preparing a subsequent store release. These commands only create local artifacts; store enrollment, store credentials, review, and publication are separate actions.

For local development, the Supabase CLI API is exposed on port `54323` and the Cena Go API on port `8080`; `10.0.2.2` reaches the host machine from the Android emulator. The checked-in sample URL is for local development only. Use the project's HTTPS Supabase and API origins for production, and never package service-role credentials. Debug builds allow cleartext only to `10.0.2.2`, `127.0.0.1`, and `localhost`; release builds retain Android's default cleartext blocking. For a physical device, use reachable HTTPS service origins. Debug APKs are written to each module's `build/outputs/apk/debug/` directory.

## Customer app

The customer app includes email OTP sign-in, saved profile/equipment, restaurant and meal-kit discovery, recents, approximate location or address lookup, pickup day/time selection with a live cutoff timer, curbside vehicle details, a persistent bag, and order history. The discovery feed uses the paged `discover_pickup_feed` RPC. Checkout can request an optional promo quote, shows the server-calculated subtotal/discount/total for confirmation, and starts Stripe-hosted Checkout through the Cena API. A payment is only confirmed after the API reports `paid`; pending checkout state is persisted and scoped to its signed-in account. Checkout and onboarding deep links never establish payment success from URL parameters.

## Restaurant app

Restaurant staff sign in, select a restaurant membership, manage curbside availability and order status, view payment connection status, and start Stripe Connect onboarding. Restaurant owners and managers can list, create, edit, pause, and enable restaurant-funded promo codes through the existing role-authorized Supabase RPCs. Returning through `cena-restaurant://connect/return` refreshes payment status from the authenticated API. Cancellable orders offer a confirmation step before requesting a refund; the UI reports the API's `refunded`, `pending`, or `failed` result and does not directly mark a refund successful. Verified refunded orders remain visible with a refund-confirmed label.

## Verification and current limits

The native build is `:customer:assembleDebug :restaurant:assembleDebug`. CI can assemble both apps and launch their unauthenticated home/login screens in an API 36 emulator. Live auth, discovery, quoting, checkout, merchant onboarding, order operations, and refunds need a configured Supabase project and reachable Cena API; they were not exercised against production services here. Local Gradle builds require Android Studio's JDK and `ANDROID_HOME` to be set. The local emulator booted but became unresponsive (`System UI isn't responding`), so the on-device check was limited to confirming app launch/screenshots; use CI's clean emulator for a repeatable launch smoke.
