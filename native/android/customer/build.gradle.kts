plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android { namespace = "com.cena.customer"; compileSdk = 36
 defaultConfig { applicationId = "com.cena.customer"; minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "1.0"; buildConfigField("String", "SUPABASE_URL", "\"${project.findProperty("SUPABASE_URL") ?: ""}\""); buildConfigField("String", "SUPABASE_KEY", "\"${project.findProperty("SUPABASE_KEY") ?: ""}\""); buildConfigField("String", "CENA_API_URL", "\"${project.findProperty("CENA_API_URL") ?: "http://10.0.2.2:8080"}\"") }
 buildFeatures { buildConfig = true }
}
