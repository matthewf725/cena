import java.io.File
import java.net.URI
import java.util.Base64

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val distributionRequested = providers.gradleProperty("cenaDistribution").orNull.equals("true", ignoreCase = true) ||
    gradle.startParameter.taskNames.any { it.substringAfterLast(':').lowercase() in setOf("bundle", "bundlerelease") }

fun javaStringLiteral(value: String): String = "\"" + value
    .replace("\\", "\\\\")
    .replace("\"", "\\\"")
    .replace("\n", "\\n")
    .replace("\r", "\\r") + "\""

data class CenaDistributionSigning(
    val keystore: File,
    val storePassword: String,
    val keyAlias: String,
    val keyPassword: String,
)

fun requireProductionHttps(name: String, value: String): String {
    val uri = runCatching { URI(value) }.getOrNull()
    val host = uri?.host?.lowercase()?.trimEnd('.')
    val ipLiteral = host != null && (host.contains(':') || host.matches(Regex("^[0-9.]+$")))
    val invalidHost = host == null || host.isBlank() || host == "localhost" ||
        host == "localhost.localdomain" || host.endsWith(".localhost") ||
        host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") ||
        ipLiteral || !host.contains('.')
    require(uri != null && uri.scheme.equals("https", ignoreCase = true) &&
        uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && !invalidHost) {
        "$name must be a production HTTPS URL with a public hostname (no localhost, emulator, private IP, or URL credentials)."
    }
    return value.trim().trimEnd('/')
}

val supabaseUrl = if (distributionRequested) {
    requireProductionHttps("CENA_SUPABASE_URL", System.getenv("CENA_SUPABASE_URL").orEmpty())
} else {
    (project.findProperty("SUPABASE_URL") as String?) ?: System.getenv("SUPABASE_URL").orEmpty()
}
val supabaseKey = if (distributionRequested) {
    System.getenv("CENA_SUPABASE_ANON_KEY").orEmpty().also { key ->
        require(key.isNotBlank()) { "CENA_SUPABASE_ANON_KEY is required for distribution builds." }
        val jwtPayload = key.split('.').getOrNull(1)?.let { segment ->
            runCatching {
                val padded = segment + "=".repeat((4 - segment.length % 4) % 4)
                String(Base64.getUrlDecoder().decode(padded), Charsets.UTF_8)
            }.getOrNull()
        }
        require(!key.startsWith("sb_secret_", ignoreCase = true) &&
            jwtPayload?.contains(Regex("\"role\"\\s*:\\s*\"service_role\"", RegexOption.IGNORE_CASE)) != true) {
            "CENA_SUPABASE_ANON_KEY must be a publishable/anon key, never a service-role secret."
        }
    }
} else {
    (project.findProperty("SUPABASE_KEY") as String?) ?: System.getenv("SUPABASE_KEY").orEmpty()
}
val cenaApiUrl = if (distributionRequested) {
    requireProductionHttps("CENA_API_URL", System.getenv("CENA_API_URL").orEmpty())
} else {
    (project.findProperty("CENA_API_URL") as String?) ?:
        System.getenv("CENA_API_URL") ?: "http://10.0.2.2:8080"
}

val distributionSigning = if (distributionRequested) {
    val filePath = System.getenv("CENA_ANDROID_KEYSTORE_FILE").orEmpty()
    val keystore = filePath.takeIf(String::isNotBlank)?.let(::File)
    require(keystore != null && keystore.isAbsolute && keystore.isFile) {
        "CENA_ANDROID_KEYSTORE_FILE must point to an existing absolute path to your release keystore."
    }
    val storePassword = System.getenv("CENA_ANDROID_KEYSTORE_PASSWORD").orEmpty()
    val keyAlias = System.getenv("CENA_ANDROID_KEY_ALIAS").orEmpty()
    val keyPassword = System.getenv("CENA_ANDROID_KEY_PASSWORD").orEmpty()
    require(storePassword.isNotBlank() && keyAlias.isNotBlank() && keyPassword.isNotBlank()) {
        "Set CENA_ANDROID_KEYSTORE_PASSWORD, CENA_ANDROID_KEY_ALIAS, and CENA_ANDROID_KEY_PASSWORD for distribution builds."
    }
    CenaDistributionSigning(keystore, storePassword, keyAlias, keyPassword)
} else null

android { namespace = "com.cena.restaurant"; compileSdk = 36
 defaultConfig { applicationId = "com.cena.restaurant"; minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "1.0"; buildConfigField("String", "SUPABASE_URL", javaStringLiteral(supabaseUrl)); buildConfigField("String", "SUPABASE_KEY", javaStringLiteral(supabaseKey)); buildConfigField("String", "CENA_API_URL", javaStringLiteral(cenaApiUrl)) }
 signingConfigs { distributionSigning?.let { signing -> create("cenaDistribution") { storeFile = signing.keystore; storePassword = signing.storePassword; keyAlias = signing.keyAlias; keyPassword = signing.keyPassword } } }
 buildTypes { getByName("release") { distributionSigning?.let { signingConfig = signingConfigs.getByName("cenaDistribution") } } }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget = "17" }
 buildFeatures { buildConfig = true }
}
