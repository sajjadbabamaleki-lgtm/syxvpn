package pro.syxvpn.app.data

import pro.syxvpn.app.core.RouteState
import pro.syxvpn.app.core.Server
import pro.syxvpn.app.core.TunnelProfile

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

    /**
     * What this phone already holds, with nothing asked of the network.
     *
     * `load` goes to the control plane first, and it is right to: that answer
     * reflects gateway changes and failover. But when the control plane cannot
     * be reached the request does not fail quickly — it fails when the socket
     * gives up — and for the whole of that wait the list was empty, on an app
     * that had a perfectly good copy of it on disk. Whoever opened the app read
     * that as having lost their configs, and pulled to refresh to get them
     * back.
     *
     * This is that copy, and it is free.
     */
    fun cached(session: SessionStore): List<Server> {
        val imported = session.importedLines.mapNotNull { line ->
            TunnelProfile.parse(line)?.let { Server(profile = it, imported = true) }
        }
        val fromPlan = session.cachedProfiles?.lines().orEmpty().mapNotNull { line ->
            TunnelProfile.parse(line)?.let { Server(profile = it) }
        }
        return imported + fromPlan
    }

    suspend fun load(session: SessionStore): Servers {
        // Pasted in by the person, and theirs whatever the account says. They
        // are added to every answer below rather than being an answer of their
        // own, because a person with both should see both.
        val imported = session.importedLines.mapNotNull { line ->
            TunnelProfile.parse(line)?.let { Server(profile = it, imported = true) }
        }

        val url = session.subscriptionUrl
        if (url != null) {
            runCatching { api.refreshProfiles(url) }
                .onSuccess { fresh -> return Servers(imported + convert(fresh), stale = false, error = null) }
                .onFailure { error ->
                    val cached = session.cachedProfiles?.lines().orEmpty()
                        .map { ControlPlaneClient.SubscriptionServer(it, null, null, null) }
                    val servers = convert(cached)
                    if (servers.isNotEmpty()) {
                        return Servers(imported + servers, stale = true, error = error.message)
                    }
                }
        }
        if (!session.signedIn) {
            // Not signed in is not an error: it is the ordinary state of a fresh
            // install. Say what would change it, not what went wrong — and say
            // nothing at all to somebody who pasted their own configs in and is
            // using the app exactly as intended.
            return Servers(imported, stale = false, error = noAccount(imported))
        }
        val subscription = api.subscription()
            ?: return Servers(imported, stale = false, error = unlessImported(imported, "No subscription on this account yet"))
        if (!subscription.active) {
            return Servers(imported, stale = false, error = unlessImported(imported, describe(subscription.state)))
        }
        // The account API hands back plain profile lines, with no route state.
        return Servers(
            imported + convert(subscription.profiles.map { ControlPlaneClient.SubscriptionServer(it, null, null, null) }),
            stale = false,
            error = null,
        )
    }

    /**
     * A person using their own configs is not in an error state.
     *
     * Telling them to buy a plan on every refresh, while the app is doing the
     * thing they installed it for, is how a working app reads as a broken one.
     */
    private fun noAccount(imported: List<Server>): String? =
        if (imported.isEmpty()) "Add a config, or buy a plan on the Premium tab" else null

    private fun unlessImported(imported: List<Server>, message: String): String? =
        if (imported.isEmpty()) message else null

    /**
     * The servers a free session is served through, for somebody with no
     * account at all.
     *
     * Nothing is cached and nothing is written to the session store. These
     * configs stop working within minutes by the control plane's own doing, and
     * a copy left on disk would only be a list of dead servers the next time
     * the app opened with nothing better to show.
     */
    suspend fun guest(): Guest {
        val session = api.guestSession()
        return Guest(
            servers = convert(session.profiles),
            secondsLeft = session.secondsLeft,
            sessionsLeft = session.sessionsLeft,
        )
    }

    data class Guest(val servers: List<Server>, val secondsLeft: Int, val sessionsLeft: Int)

    private fun convert(servers: List<ControlPlaneClient.SubscriptionServer>): List<Server> =
        servers.mapNotNull { server ->
            val profile = TunnelProfile.parse(server.uri) ?: return@mapNotNull null
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
