package pro.syxvpn.app.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import pro.syxvpn.app.BuildConfig
import pro.syxvpn.app.core.PrivateDns

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
        "cvpn.session",
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
     * Configs the person pasted in themselves, newline separated.
     *
     * These are not a subscription and are nobody's to revoke: a config bought
     * from another provider belongs to whoever bought it, so it survives
     * signing out, an expired plan, and never having had one. Only removing it
     * here removes it.
     */
    var importedConfigs: String?
        get() = prefs.getString(KEY_IMPORTED, null)
        set(value) = prefs.edit().putString(KEY_IMPORTED, value).apply()

    /** The pasted configs as lines, in the order they were added. */
    val importedLines: List<String>
        get() = importedConfigs.orEmpty().split('\n').map { it.trim() }.filter { it.isNotEmpty() }

    fun addImported(uris: List<String>) {
        if (uris.isEmpty()) return
        importedConfigs = (importedLines + uris).joinToString("\n")
    }

    fun removeImported(uri: String) {
        importedConfigs = importedLines.filterNot { it == uri }.joinToString("\n").ifEmpty { null }
    }

    /**
     * Configs the person chose to hide, as the config lines themselves.
     *
     * A subscription decides which configs exist, so hiding is local and
     * sticky: a refresh brings one back from the control plane but it stays out
     * of the list until it is unhidden here.
     *
     * By the line, not by "host:port", which is what this held before. Two
     * configs into one gateway share an address, so hiding either of them hid
     * both — and on a subscription whose configs all point at one gateway, that
     * emptied the list.
     *
     * Stored as one string rather than a string set. The set went through
     * `putStringSet`, whose returned instance is the one the preferences hold,
     * and it did not reliably survive a restart; the pasted configs beside it
     * have always been a newline-joined string and have never lost anything.
     * The key is new, so nothing reads the old address-shaped entries: they
     * cannot be matched against a config line, and a config hidden under the
     * old scheme comes back once rather than staying hidden by an entry
     * nothing can ever clear.
     */
    var hiddenConfigs: Set<String>
        get() = prefs.getString(KEY_HIDDEN_LINES, null).orEmpty()
            .split('\n').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        set(value) = prefs.edit()
            .putString(KEY_HIDDEN_LINES, value.joinToString("\n").ifEmpty { null })
            .apply()

    /**
     * Whether the tunnel chooses the config, rather than the person.
     *
     * The Configs tab's setting. The VPN tab has no manual mode to store — it
     * never names a server — so nothing there reads or writes this.
     *
     * On by default: someone who has just bought a plan has no way to know
     * which gateway is best for their network, and the tunnel can measure it.
     * Choosing a config by hand turns it off, and it stays off until they pick
     * the Automatic row again.
     */
    /**
     * Which resolver the tunnel uses.
     *
     * Stored by name, read back through [PrivateDns.of], so a name this build
     * does not know reads as the default rather than as no resolver at all.
     *
     * `PRIVATE_DNS` gates it outright rather than only setting the default: a
     * build with the flag off has to behave exactly like the build before the
     * feature, including for the phone of somebody who had already picked an
     * encrypted mode. That is what makes it a switch that can be thrown back.
     */
    var dnsMode: PrivateDns
        get() = if (!BuildConfig.PRIVATE_DNS) {
            PrivateDns.STANDARD
        } else {
            PrivateDns.of(prefs.getString(KEY_DNS, null))
        }
        set(value) = prefs.edit().putString(KEY_DNS, value.name).apply()

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
     * What the person said they use the VPN for, as a [pro.syxvpn.app.core.Purpose]
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
     * [pro.syxvpn.app.core.ConnectionMemory].
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

    /**
     * The control-plane address that last answered.
     *
     * Kept so a first entry that has gone dark costs one failed connection at
     * launch rather than one on every request. It is a hint, not a setting:
     * the build's list decides what may be used, and this only reorders it.
     */
    var controlPlaneBase: String?
        get() = prefs.getString(KEY_CONTROL_BASE, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_CONTROL_BASE) else putString(KEY_CONTROL_BASE, value)
        }.apply()

    /**
     * Signs the account out.
     *
     * Everything the account owns goes; the configs the person pasted in stay.
     * Those were bought from somebody else, or handed over in a channel, and
     * signing out of this app is not a reason to lose them — a person who had
     * to re-paste forty configs to log back in would not log back in.
     */
    fun clear() {
        val keepImported = importedConfigs
        prefs.edit().clear().apply()
        importedConfigs = keepImported
    }

    private companion object {
        const val KEY_TOKEN = "token"
        const val KEY_EMAIL = "email"
        const val KEY_SUB_URL = "subscription_url"
        const val KEY_PROFILES = "profiles"
        const val KEY_HIDDEN_LINES = "hidden_config_lines"
        const val KEY_IMPORTED = "imported_configs"
        const val KEY_AUTOMATIC = "automatic_server"
        const val KEY_COUNTRY = "country"
        const val KEY_PURPOSE = "purpose"
        const val KEY_MEMORY = "connection_memory"
        const val KEY_CONTROL_BASE = "control_plane_base"
        const val KEY_DNS = "dns_mode"
    }
}
