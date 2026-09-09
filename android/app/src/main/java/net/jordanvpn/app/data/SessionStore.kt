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

    /** Whether there is a session at all. A fresh install has none, and that is fine. */
    val signedIn: Boolean get() = token != null

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

    /**
     * Servers the person chose to hide, as "host:port" entries.
     *
     * A subscription decides which servers exist, so hiding is local and
     * sticky: a refresh brings the server back from the control plane but it
     * stays out of the list until it is unhidden here.
     */
    var hiddenConfigs: Set<String>
        get() = prefs.getStringSet(KEY_HIDDEN, emptySet()) ?: emptySet()
        set(value) = prefs.edit().putStringSet(KEY_HIDDEN, value).apply()

    /**
     * Whether the tunnel chooses the server, rather than the person.
     *
     * On by default: someone who has just bought a plan has no way to know
     * which gateway is best for their network, and the tunnel can measure it.
     * Choosing a server by hand turns it off, and it stays off until they ask
     * for automatic again.
     */
    var automaticServer: Boolean
        get() = prefs.getBoolean(KEY_AUTOMATIC, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTOMATIC, value).apply()

    /**
     * ISO code of the country automatic selection is limited to, or null for
     * anywhere. Set from the VPN screen's country list.
     */
    var country: String?
        get() = prefs.getString(KEY_COUNTRY, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_COUNTRY) else putString(KEY_COUNTRY, value)
        }.apply()

    /**
     * What the person said they use the VPN for, as a [net.jordanvpn.app.core.Purpose]
     * name. It changes how automatic selection weighs its signals, and nothing
     * else; the Configs tab never reads it.
     */
    var purposeName: String?
        get() = prefs.getString(KEY_PURPOSE, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_PURPOSE) else putString(KEY_PURPOSE, value)
        }.apply()

    /**
     * What this phone has learned about each gateway, encoded by
     * [net.jordanvpn.app.core.ConnectionMemory].
     *
     * It holds host:port, counters and timings — no credential and no profile
     * line — but it lives in the encrypted store with everything else, because
     * which gateways a phone has been talking to is not public either.
     *
     * Both the tunnel and the Configs health sweep write it. They read, change
     * and write the whole blob, so two writes in the same instant can lose a
     * measurement. That is the intended trade: the cost is one sample, and the
     * alternative is a lock held across a file write on the connect path.
     */
    var connectionMemory: String?
        get() = prefs.getString(KEY_MEMORY, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_MEMORY) else putString(KEY_MEMORY, value)
        }.apply()

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val KEY_TOKEN = "token"
        const val KEY_EMAIL = "email"
        const val KEY_SUB_URL = "subscription_url"
        const val KEY_PROFILES = "profiles"
        const val KEY_HIDDEN = "hidden_configs"
        const val KEY_AUTOMATIC = "automatic_server"
        const val KEY_COUNTRY = "country"
        const val KEY_PURPOSE = "purpose"
        const val KEY_MEMORY = "connection_memory"
    }
}
