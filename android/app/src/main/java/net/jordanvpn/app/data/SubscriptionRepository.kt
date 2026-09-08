package net.jordanvpn.app.data

import net.jordanvpn.app.core.VlessProfile

/**
 * Turns a subscription into something the tunnel can run.
 *
 * Refresh order matters: the subscription URL is fetched first, because it is
 * the same source every other client uses and it reflects gateway changes and
 * failover immediately. The cached copy is only a fallback for when the control
 * plane cannot be reached at all — better a stale gateway than no connection.
 */
class SubscriptionRepository(private val api: ControlPlaneClient) {

    data class Profiles(val profiles: List<VlessProfile>, val stale: Boolean, val error: String?)

    suspend fun load(session: SessionStore): Profiles {
        val url = session.subscriptionUrl
        if (url != null) {
            runCatching { api.refreshProfiles(url) }
                .onSuccess { uris -> return Profiles(parse(uris), stale = false, error = null) }
                .onFailure { error ->
                    val cached = session.cachedProfiles?.lines().orEmpty()
                    if (cached.isNotEmpty()) {
                        return Profiles(parse(cached), stale = true, error = error.message)
                    }
                }
        }
        val subscription = api.subscription()
            ?: return Profiles(emptyList(), stale = false, error = "No subscription on this account")
        if (!subscription.active) {
            return Profiles(emptyList(), stale = false, error = describe(subscription.state))
        }
        return Profiles(parse(subscription.profiles), stale = false, error = null)
    }

    private fun parse(uris: List<String>) = uris.mapNotNull(VlessProfile::parse)

    private fun describe(state: String) = when (state) {
        "expired" -> "Your subscription has expired"
        "quota-exhausted" -> "You have used all of your data"
        "disabled" -> "This subscription is disabled"
        else -> "Subscription is not active"
    }
}
