package com.cena.customer

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import java.net.URI

/** Opens a validated Stripe-hosted checkout without collecting card data in Cena. */
object CheckoutBrowser {
    enum class OpenResult {
        CUSTOM_TAB,
        DEFAULT_BROWSER,
        INVALID_URL,
        NO_BROWSER_AVAILABLE,
    }

    /**
     * Open only HTTPS Stripe Checkout URLs. Prefer a system Custom Tab and fall back to the
     * user's default browser if no Custom Tabs activity is installed or available.
     */
    fun open(activity: Activity, checkoutUrl: String): OpenResult {
        val uri = trustedCheckoutUri(checkoutUrl) ?: return OpenResult.INVALID_URL
        val providerPackage = CustomTabsClient.getPackageName(activity, null)
            ?: return openDefaultBrowser(activity, uri)

        return try {
            val tabs = CustomTabsIntent.Builder()
                .setToolbarColor(Color.rgb(93, 16, 10))
                .setShowTitle(true)
                .build()
            tabs.intent.setPackage(providerPackage)
            tabs.launchUrl(activity, uri)
            OpenResult.CUSTOM_TAB
        } catch (_: ActivityNotFoundException) {
            openDefaultBrowser(activity, uri)
        } catch (_: SecurityException) {
            openDefaultBrowser(activity, uri)
        }
    }

    private fun trustedCheckoutUri(value: String): Uri? {
        val parsed = runCatching { URI(value) }.getOrNull() ?: return null
        if (!parsed.scheme.equals("https", ignoreCase = true)) return null
        val host = parsed.host ?: return null
        if (!host.equals("checkout.stripe.com", ignoreCase = true)) return null
        if (parsed.rawUserInfo != null || parsed.port !in listOf(-1, 443)) return null
        return runCatching { Uri.parse(value) }.getOrNull()
    }

    private fun openDefaultBrowser(activity: Activity, uri: Uri): OpenResult {
        val intent = Intent(Intent.ACTION_VIEW, uri)
        return try {
            activity.startActivity(intent)
            OpenResult.DEFAULT_BROWSER
        } catch (_: ActivityNotFoundException) {
            OpenResult.NO_BROWSER_AVAILABLE
        } catch (_: SecurityException) {
            OpenResult.NO_BROWSER_AVAILABLE
        }
    }
}
