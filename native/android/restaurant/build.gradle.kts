plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android { namespace = "com.cena.restaurant"; compileSdk = 36
 defaultConfig { applicationId = "com.cena.restaurant"; minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "1.0"; buildConfigField("String", "SUPABASE_URL", "\"${project.findProperty("SUPABASE_URL") ?: ""}\""); buildConfigField("String", "SUPABASE_KEY", "\"${project.findProperty("SUPABASE_KEY") ?: ""}\"") }
 buildFeatures { buildConfig = true }
}
