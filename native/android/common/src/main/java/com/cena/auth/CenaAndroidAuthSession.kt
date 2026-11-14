package com.cena.auth

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CenaAuthSession internal constructor(
    val accessToken: String,
    val refreshToken: String?,
    val expiresAtEpochSeconds: Long?,
    val userId: String?,
    val email: String?,
    val generation: Long,
) {
    override fun toString(): String =
        "CenaAuthSession(accessToken=[redacted], refreshToken=[redacted], expiresAtEpochSeconds=$expiresAtEpochSeconds, userId=[redacted], email=[redacted], generation=$generation)"
}

class CenaSessionExpiredException : IOException("Your Cena sign-in expired. Sign in again to continue.")

class CenaSessionStorageException : IOException("Cena could not securely save your sign-in. Sign in again to continue.")

class CenaSessionRefreshException : IOException("Cena could not refresh your sign-in. Check your connection and try again.")

/**
 * Shared synchronous Supabase auth-session storage and refresh logic for Android.
 *
 * `restore()` only reads/decrypts or migrates local state and never performs network I/O,
 * so it is safe during activity creation. Call `accessTokenForRequest()` and
 * `refreshAfterUnauthorized()` from an existing background executor; both may block on
 * the Supabase refresh endpoint. The encrypted session file lives under noBackupFilesDir.
 */
class CenaAndroidAuthSession(
    context: Context,
    supabaseUrl: String,
    private val supabaseAnonKey: String,
    private val legacyPreferencesName: String,
    private val legacyRefreshTokenKey: String? = "refresh",
    private val legacyAccessTokenKey: String = "token",
    private val legacyUserIdKey: String = "user_id",
    private val legacyEmailKey: String = "email",
) {
    private val appContext = context.applicationContext
    private val normalizedSupabaseUrl = supabaseUrl.trim().trimEnd('/')
    private val packageName = appContext.packageName
    private val sessionFile = AtomicFile(File(appContext.noBackupFilesDir, "cena-auth-session-v1.json"))
    private val legacyPreferences: SharedPreferences =
        appContext.getSharedPreferences(legacyPreferencesName, Context.MODE_PRIVATE)
    private val metadata: SharedPreferences =
        appContext.getSharedPreferences(METADATA_PREFERENCES, Context.MODE_PRIVATE)
    private val lock = lockFor(packageName)

    /** Local-only restore/migration. Does not refresh and never makes a network request. */
    fun restore(): CenaAuthSession? = synchronized(lock) { loadOrMigrateLocked() }

    /** Save an OTP/password-grant response and invalidate in-flight work from the old account. */
    @Throws(CenaSessionStorageException::class)
    fun acceptAuthResponse(responseJson: String, expectedGeneration: Long, fallbackEmail: String? = null): CenaAuthSession {
        val response = try {
            JSONObject(responseJson)
        } catch (_: Exception) {
            throw CenaSessionStorageException()
        }
        val access = response.nonBlankString("access_token")
            ?: throw CenaSessionStorageException()
        val refresh = response.nonBlankString("refresh_token")
        val user = response.optJSONObject("user")
        val nowSeconds = System.currentTimeMillis() / 1000L
        val expiry = responseEpochSeconds(response, "expires_at")
            ?: responseEpochSeconds(response, "expires_in")?.let { nowSeconds + it }
            ?: jwtExpiry(access)
        val email = user?.nonBlankString("email") ?: fallbackEmail
        val userId = user?.nonBlankString("id")

        synchronized(lock) {
            if (metadata.getLong(GENERATION_KEY, 0L) != expectedGeneration) throw CenaSessionExpiredException()
            val generation = nextGenerationLocked()
            val session = CenaAuthSession(access, refresh, expiry, userId, email, generation)
            try {
                writeEncryptedLocked(session)
            } catch (_: Exception) {
                throw CenaSessionStorageException()
            }
            removeLegacyTokensLocked()
            return session
        }
    }

    fun generationSnapshot(): Long = synchronized(lock) { metadata.getLong(GENERATION_KEY, 0L) }

    fun assertCurrentGeneration(expectedGeneration: Long) {
        if (generationSnapshot() != expectedGeneration) throw CenaSessionExpiredException()
    }

    /** Return an access token, refreshing it when it is expired or within 90 seconds of expiry. */
    @Throws(CenaSessionExpiredException::class, CenaSessionStorageException::class, CenaSessionRefreshException::class)
    fun accessTokenForRequest(expectedGeneration: Long? = null): String? {
        val current = restore() ?: run {
            if (expectedGeneration != null && generationSnapshot() != expectedGeneration) throw CenaSessionExpiredException()
            return null
        }
        if (expectedGeneration != null && current.generation != expectedGeneration) throw CenaSessionExpiredException()
        val expiry = current.expiresAtEpochSeconds
        if (expiry == null || expiry - System.currentTimeMillis() / 1000L > REFRESH_EARLY_SECONDS) {
            return current.accessToken
        }
        return try { refresh(current, force = false) } catch (error: CenaSessionRefreshException) {
            if (expiry > System.currentTimeMillis() / 1000L) {
                assertCurrentGeneration(current.generation)
                current.accessToken
            } else {
                throw error
            }
        }
    }

    /**
     * Retry helper for one authenticated HTTP 401. If another request already refreshed,
     * reuse that newer token. Otherwise refresh once; invalid refresh grants clear this
     * generation, while transient network/5xx failures preserve it.
     */
    @Throws(CenaSessionExpiredException::class, CenaSessionStorageException::class, CenaSessionRefreshException::class)
    fun refreshAfterUnauthorized(usedAccessToken: String, expectedGeneration: Long): String {
        val current = restore() ?: throw CenaSessionExpiredException()
        if (current.generation != expectedGeneration) throw CenaSessionExpiredException()
        if (current.accessToken != usedAccessToken) return current.accessToken
        return refresh(current, force = true)
    }

    /** Local sign-out. Increments generation before deleting so late refreshes cannot restore it. */
    @Throws(CenaSessionStorageException::class)
    fun signOut() {
        synchronized(lock) {
            nextGenerationLocked()
            sessionFile.delete()
            removeLegacyTokensLocked()
        }
    }

    /** Clear only the session associated with a failed request; safe after an account switch. */
    fun signOutIfCurrent(expectedGeneration: Long): Boolean = synchronized(lock) {
        val latest = try { readEncryptedLocked() } catch (_: Exception) { null }
        if (metadata.getLong(GENERATION_KEY, 0L) != expectedGeneration || latest?.generation != expectedGeneration) {
            return@synchronized false
        }
        nextGenerationLocked()
        sessionFile.delete()
        removeLegacyTokensLocked()
        true
    }

    private fun refresh(snapshot: CenaAuthSession, force: Boolean): String =
        synchronized(refreshLockFor(packageName)) {
            val current = restore() ?: throw CenaSessionExpiredException()
            if (current.generation != snapshot.generation) throw CenaSessionExpiredException()
            if (current.accessToken != snapshot.accessToken) return@synchronized current.accessToken
            if (!force && current.expiresAtEpochSeconds?.minus(System.currentTimeMillis() / 1000L)
                    ?.let { it <= REFRESH_EARLY_SECONDS } != true) {
                return@synchronized current.accessToken
            }
            val refreshToken = current.refreshToken?.takeIf(String::isNotBlank)
                ?: run {
                    clearIfCurrent(current)
                    throw CenaSessionExpiredException()
                }
            val response = requestRefresh(refreshToken, current)
            val rotatedAccess = response.nonBlankString("access_token")
                ?: throw CenaSessionRefreshException()
            val rotatedRefresh = response.nonBlankString("refresh_token") ?: refreshToken
            val user = response.optJSONObject("user")
            val returnedUserId = user?.nonBlankString("id")
            if (current.userId != null && returnedUserId != null && returnedUserId != current.userId) {
                clearIfCurrent(current)
                throw CenaSessionExpiredException()
            }
            val nowSeconds = System.currentTimeMillis() / 1000L
            val expiry = responseEpochSeconds(response, "expires_at")
                ?: responseEpochSeconds(response, "expires_in")?.let { nowSeconds + it }
                ?: jwtExpiry(rotatedAccess)
                ?: current.expiresAtEpochSeconds
            val renewed = CenaAuthSession(
                accessToken = rotatedAccess,
                refreshToken = rotatedRefresh,
                expiresAtEpochSeconds = expiry,
                userId = returnedUserId ?: current.userId,
                email = user?.nonBlankString("email") ?: current.email,
                generation = current.generation,
            )
            synchronized(lock) {
                val latest = try { readEncryptedLocked() } catch (_: Exception) { null }
                val latestGeneration = metadata.getLong(GENERATION_KEY, 0L)
                if (latestGeneration != current.generation) throw CenaSessionExpiredException()
                if (latest != null && latest.accessToken != current.accessToken) {
                    return@synchronized latest.accessToken
                }
                try {
                    writeEncryptedLocked(renewed)
                } catch (_: Exception) {
                    throw CenaSessionStorageException()
                }
                rotatedAccess
            }
        }

    private fun requestRefresh(refreshToken: String, expectedSession: CenaAuthSession): JSONObject {
        if (normalizedSupabaseUrl.isBlank() || supabaseAnonKey.isBlank()) throw CenaSessionRefreshException()
        val connection = try {
            URL("$normalizedSupabaseUrl/auth/v1/token?grant_type=refresh_token")
                .openConnection() as HttpURLConnection
        } catch (_: Exception) {
            throw CenaSessionRefreshException()
        }
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = REQUEST_TIMEOUT_MILLIS
            connection.readTimeout = REQUEST_TIMEOUT_MILLIS
            connection.setRequestProperty("apikey", supabaseAnonKey)
            connection.setRequestProperty("Authorization", "Bearer $supabaseAnonKey")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            val body = JSONObject().put("refresh_token", refreshToken).toString()
            connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val status = connection.responseCode
            if (status == 400 || status == 401) {
                clearIfCurrent(expectedSession)
                throw CenaSessionExpiredException()
            }
            if (status !in 200..299) throw CenaSessionRefreshException()
            val response = connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
            return try { JSONObject(response) } catch (_: Exception) { throw CenaSessionRefreshException() }
        } catch (expired: CenaSessionExpiredException) {
            throw expired
        } catch (storage: CenaSessionStorageException) {
            throw storage
        } catch (refresh: CenaSessionRefreshException) {
            throw refresh
        } catch (_: Exception) {
            throw CenaSessionRefreshException()
        } finally {
            connection.disconnect()
        }
    }

    private fun loadOrMigrateLocked(): CenaAuthSession? {
        if (sessionFile.baseFile.exists()) {
            val stored = try { readEncryptedLocked() } catch (_: Exception) { null }
            val currentGeneration = metadata.getLong(GENERATION_KEY, 0L)
            if (stored == null || stored.generation != currentGeneration) {
                sessionFile.delete()
                removeLegacyTokensLocked()
                return null
            }
            removeLegacyTokensLocked()
            return stored
        }

        val oldAccess = legacyPreferences.getString(legacyAccessTokenKey, null)?.takeIf(String::isNotBlank)
            ?: return null
        val oldRefresh = legacyRefreshTokenKey?.let { legacyPreferences.getString(it, null) }?.takeIf(String::isNotBlank)
        val nextGeneration = nextGenerationLocked()
        val migrated = CenaAuthSession(
            accessToken = oldAccess,
            refreshToken = oldRefresh,
            expiresAtEpochSeconds = jwtExpiry(oldAccess),
            userId = legacyPreferences.getString(legacyUserIdKey, null)?.takeIf(String::isNotBlank),
            email = legacyPreferences.getString(legacyEmailKey, null)?.takeIf(String::isNotBlank),
            generation = nextGeneration,
        )
        try {
            writeEncryptedLocked(migrated)
        } catch (_: Exception) {
            // Crucially, leave the legacy token in place until the secure write succeeds.
            throw CenaSessionStorageException()
        }
        removeLegacyTokensLocked()
        return migrated
    }

    private fun clearIfCurrent(expected: CenaAuthSession) {
        synchronized(lock) {
            val latest = try { readEncryptedLocked() } catch (_: Exception) { null }
            if (latest == null || latest.generation != expected.generation || latest.accessToken != expected.accessToken) return
            nextGenerationLocked()
            sessionFile.delete()
            removeLegacyTokensLocked()
        }
    }

    private fun removeLegacyTokensLocked() {
        val edit = legacyPreferences.edit().remove(legacyAccessTokenKey)
        legacyRefreshTokenKey?.let(edit::remove)
        if (!edit.commit()) throw CenaSessionStorageException()
    }

    private fun nextGenerationLocked(): Long {
        val next = metadata.getLong(GENERATION_KEY, 0L) + 1L
        if (!metadata.edit().putLong(GENERATION_KEY, next).commit()) throw CenaSessionStorageException()
        return next
    }

    private fun writeEncryptedLocked(session: CenaAuthSession) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        cipher.updateAAD(associatedData())
        val encrypted = cipher.doFinal(serialize(session).toByteArray(StandardCharsets.UTF_8))
        val envelope = JSONObject()
            .put("version", FORMAT_VERSION)
            .put("iv", Base64.getEncoder().encodeToString(cipher.iv))
            .put("ciphertext", Base64.getEncoder().encodeToString(encrypted))
            .toString()
        val stream = sessionFile.startWrite()
        try {
            stream.write(envelope.toByteArray(StandardCharsets.UTF_8))
            stream.fd.sync()
            sessionFile.finishWrite(stream)
        } catch (error: Exception) {
            sessionFile.failWrite(stream)
            throw error
        }
    }

    private fun readEncryptedLocked(): CenaAuthSession? {
        val envelopeText = sessionFile.openRead().bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        val envelope = JSONObject(envelopeText)
        if (envelope.optInt("version") != FORMAT_VERSION) throw IOException("Unsupported session format")
        val iv = Base64.getDecoder().decode(envelope.getString("iv"))
        val ciphertext = Base64.getDecoder().decode(envelope.getString("ciphertext"))
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        cipher.updateAAD(associatedData())
        return deserialize(String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8))
    }

    private fun keystoreKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(keyAlias(), null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias(),
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun serialize(session: CenaAuthSession): String = JSONObject()
        .put("access_token", session.accessToken)
        .put("refresh_token", session.refreshToken ?: JSONObject.NULL)
        .put("expires_at", session.expiresAtEpochSeconds ?: JSONObject.NULL)
        .put("user_id", session.userId ?: JSONObject.NULL)
        .put("email", session.email ?: JSONObject.NULL)
        .put("generation", session.generation)
        .toString()

    private fun deserialize(json: String): CenaAuthSession {
        val obj = JSONObject(json)
        val access = obj.nonBlankString("access_token")
            ?: throw IOException("Missing access token")
        return CenaAuthSession(
            accessToken = access,
            refreshToken = obj.nonBlankString("refresh_token"),
            expiresAtEpochSeconds = obj.optLongOrNull("expires_at"),
            userId = obj.nonBlankString("user_id"),
            email = obj.nonBlankString("email"),
            generation = obj.optLong("generation", -1L).takeIf { it >= 0L }
                ?: throw IOException("Missing session generation"),
        )
    }

    private fun responseEpochSeconds(obj: JSONObject, key: String): Long? {
        if (!obj.has(key) || obj.isNull(key)) return null
        val value = obj.opt(key)
        return when (value) {
            is Number -> value.toLong()
            is String -> value.toLongOrNull()
            else -> null
        }?.takeIf { it > 0L }
    }

    private fun jwtExpiry(token: String): Long? = runCatching {
        val payload = token.split('.').getOrNull(1) ?: return null
        val decoded = Base64.getUrlDecoder().decode(payload)
        JSONObject(String(decoded, StandardCharsets.UTF_8)).optLongOrNull("exp")
    }.getOrNull()

    private fun associatedData(): ByteArray = "cena-auth-session-v$FORMAT_VERSION:$packageName".toByteArray(StandardCharsets.UTF_8)

    private fun keyAlias(): String = "com.cena.auth.session.v1.$packageName"

    private fun JSONObject.optLongOrNull(key: String): Long? {
        if (!has(key) || isNull(key)) return null
        return when (val value = opt(key)) {
            is Number -> value.toLong().takeIf { it > 0L }
            is String -> value.toLongOrNull()?.takeIf { it > 0L }
            else -> null
        }
    }

    private fun JSONObject.nonBlankString(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return optString(key).takeIf { it.isNotBlank() }
    }

    companion object {
        private const val METADATA_PREFERENCES = "cena_auth_session_metadata_v1"
        private const val GENERATION_KEY = "session_generation"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val FORMAT_VERSION = 1
        private const val REFRESH_EARLY_SECONDS = 90L
        private const val REQUEST_TIMEOUT_MILLIS = 9_000
        private val locks = ConcurrentHashMap<String, Any>()
        private val refreshLocks = ConcurrentHashMap<String, Any>()
        private fun lockFor(packageName: String): Any = locks.computeIfAbsent(packageName) { Any() }
        private fun refreshLockFor(packageName: String): Any = refreshLocks.computeIfAbsent(packageName) { Any() }
    }
}
