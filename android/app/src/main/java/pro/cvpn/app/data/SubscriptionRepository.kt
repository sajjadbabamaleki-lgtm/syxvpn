package pro.cvpn.app.data

import pro.cvpn.app.core.RouteState
import pro.cvpn.app.core.Server
import pro.cvpn.app.core.VlessProfile

/**
 * Turns a subscription into something the tunnel can run.
 *
 * Refresh order matters: the subscription URL is fetched first, because it is
 * the same source every other client uses and it reflects gateway changes and
 * failover immediately. The cached copy is only a fallback for when the control
 * plane cannot be reached at all — better a stale gateway than no connection.
 *
 * A cached server carries no route state. That is deliberate: health is a
 * statement about now, and a list from an hour ago cannot make it. Automatic
 * selection then falls back to what the phone can still measure itself.
 */
class SubscriptionRepository(private val api: ControlPlaneClient) {

    data class Servers(val servers: List<Server>, val stale: Boolean, val error: String?)

    suspend fun load(session: SessionStore): Servers {
        val url = session.subscriptionUrl
        if (url != null) {
            runCatching { api.refreshProfiles(url) }
                .onSuccess { fresh -> return Servers(convert(fresh), stale = false, error = null) }
                .onFailure { error ->
                    val cached = session.cachedProfiles?.lines().orEmpty()
                        .map { ControlPlaneClient.SubscriptionServer(it, null, null, null) }
                    val servers = convert(cached)
                    if (servers.isNotEmpty()) {
                        return Servers(servers, stale = true, error = error.message)
                    }
                }
        }
        if (!session.signedIn) {
            // Not signed in is not an error: it is the ordinary state of a fresh
            // install. Say what would change it, not what went wrong.
            return Servers(emptyList(), stale = false, error = "Buy a plan on the Premium tab to get servers")
        }
        val subscription = api.subscription()
            ?: return Servers(emptyList(), stale = false, error = "No subscription on this account yet")
        if (!subscription.active) {
            return Servers(emptyList(), stale = false, error = describe(subscription.state))
        }
        // The account API hands back plain profile lines, with no route state.
        return Servers(
            convert(subscription.profiles.map { ControlPlaneClient.SubscriptionServer(it, null, null, null) }),
            stale = false,
            error = null,
        )
    }

    private fun convert(servers: List<ControlPlaneClient.SubscriptionServer>): List<Server> =
        servers.mapNotNull { server ->
            val profile = VlessProfile.parse(server.uri) ?: return@mapNotNull null
            Server(
                profile = profile,
                routeState = RouteState.of(server.routeState),
                gatewayName = server.gatewayName,
                region = server.region,
            )
        }

    private fun describe(state: String) = when (state) {
        "expired" -> "Your subscription has expired"
        "quota-exhausted" -> "You have used all of your data"
        "disabled" -> "This subscription is disabled"
        else -> "Subscription is not active"
    }
}
