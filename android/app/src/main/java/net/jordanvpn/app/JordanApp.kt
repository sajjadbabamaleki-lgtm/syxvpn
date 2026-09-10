package net.jordanvpn.app

import android.app.Application
import net.jordanvpn.app.core.ControlPlaneEndpoints
import net.jordanvpn.app.data.ControlPlaneClient
import net.jordanvpn.app.data.SessionStore
import net.jordanvpn.app.data.SubscriptionRepository

/**
 * Jordan VPN — Android client.
 *
 * The app talks to the same control plane as the web storefront: it signs in
 * with the customer's email and password, reads their subscription, opens USDT
 * orders, and runs the tunnel locally.
 *
 * In-app ordering is right for a directly distributed APK and wrong for Google
 * Play, whose payments policy does not allow selling digital goods for crypto
 * in-app, so it sits behind the `IN_APP_ORDERS` build flag: with it off the
 * Premium tab lists the plans and sends the customer to the web storefront.
 */
class JordanApp : Application() {
    lateinit var session: SessionStore
        private set
    lateinit var api: ControlPlaneClient
        private set
    lateinit var subscriptions: SubscriptionRepository
        private set

    /** The control-plane addresses, in the order to try them. */
    lateinit var endpoints: ControlPlaneEndpoints
        private set

    override fun onCreate() {
        super.onCreate()
        session = SessionStore(this)
        endpoints = ControlPlaneEndpoints(
            configured = ControlPlaneEndpoints.parse(BuildConfig.CONTROL_PLANE_URLS),
            remembered = { session.controlPlaneBase },
            remember = { session.controlPlaneBase = it },
        )
        api = ControlPlaneClient(endpoints, session)
        subscriptions = SubscriptionRepository(api)
    }
}
