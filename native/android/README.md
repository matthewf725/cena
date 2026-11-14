# Native Android apps

Two Kotlin Android apps live here: `com.cena.customer` and `com.cena.restaurant`. They use native Android views, inline status/errors, local session storage, and Supabase Auth/PostgREST/RPC directly. No Expo modules are required.

## Build

Install Android Studio with SDK platforms/build tools 35 or 36 and JDK 17+. Set `sdk.dir` in `local.properties` if Android Studio does not find the SDK. For live data, add `SUPABASE_URL=https://...`, `SUPABASE_KEY=...`, and `CENA_API_URL=http://10.0.2.2:8080` to your user Gradle properties (`%USERPROFILE%\.gradle\gradle.properties`); use only the public anon/publishable key. Override `CENA_API_URL` with a reachable Go API URL when using a device or hosted service. From this directory run `gradlew.bat :customer:assembleDebug :restaurant:assembleDebug` or open it in Android Studio and sync Gradle. Debug APKs land under each module's `build/outputs/apk/debug/`.

Customer: email OTP, public kitchen/menu/slot browsing, authenticated create_order reservation, order history. The map card opens the device's geo intent with a nearby pickup search. Restaurant: password sign-in, membership selection, curbside toggle, today's orders and status updates.

Live builds require network access and a configured Supabase project, email OTP delivery, and provisioned merchant membership. The restaurant app currently focuses on order operations; native catalog editing and slot creation are not included. Customer map results are delegated to an installed maps app rather than embedding a map SDK.
