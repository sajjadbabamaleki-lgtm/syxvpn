package net.jordanvpn.app.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Holds the customer session token and the last known subscription URL.
 *
 * Both are bearer secrets, so they live in EncryptedSharedPreferences rather
 * than plain preferences: on a rooted or backed-up device a plain file is
 * readable, and the subscription URL alone is enough to use the account.
 */
class SessionStore(context: Context) {

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "jordan.session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
        }.apply()

    var email: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(value) = prefs.edit().putString(KEY_EMAIL, value).apply()

    var subscriptionUrl: String?
        get() = prefs.getString(KEY_SUB_URL, null)
        set(value) = prefs.edit().putString(KEY_SUB_URL, value).apply()

    /** Last profile list fetched from the subscription, newline separated. */
    var cachedProfiles: String?
        get() = prefs.getString(KEY_PROFILES, null)
        set(value) = prefs.edit().putString(KEY_PROFILES, value).apply()

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val KEY_TOKEN = "token"
        const val KEY_EMAIL = "email"
        const val KEY_SUB_URL = "subscription_url"
        const val KEY_PROFILES = "profiles"
    }
}
