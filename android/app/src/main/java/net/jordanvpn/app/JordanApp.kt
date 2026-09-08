package net.jordanvpn.app

import android.app.Application
import net.jordanvpn.app.data.ControlPlaneClient
import net.jordanvpn.app.data.SessionStore
import net.jordanvpn.app.data.SubscriptionRepository

/**
 * Jordan VPN — Android client.
 *
 * The app talks to the same control plane as the web storefront: it signs in
 * with the customer's email and password, reads their subscription, and runs
 * the tunnel locally. Buying is deliberately handled by the web storefront
 * (a store listing that sells VPN access for crypto inside the app runs into
 * both payment policy and review problems); the app opens it in a browser.
 */
class JordanApp : Application() {
    lateinit var session: SessionStore
        private set
    lateinit var api: ControlPlaneClient
        private set
    lateinit var subscriptions: SubscriptionRepository
        private set

    override fun onCreate() {
        super.onCreate()
        session = SessionStore(this)
        api = ControlPlaneClient(BuildConfig.CONTROL_PLANE_URL, session)
        subscriptions = SubscriptionRepository(api)
    }
}
