package pro.sixvpn.app.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableStateOf
import pro.sixvpn.app.SixVpnApp
import pro.sixvpn.app.core.Server
import pro.sixvpn.app.vpn.TunnelService

/**
 * Single activity. Five screens — VPN, configs, premium, support and account —
 * swap inside it, so a navigation library would cost more than it earns.
 */
class MainActivity : ComponentActivity() {

    /**
     * The connection waiting for the VPN consent dialog to come back.
     *
     * @param serversJson the candidates, already encoded.
     * @param automatic whether the tunnel may choose among them.
     * @param source which section asked; it owns whatever comes up.
     */
    private data class PendingConnect(
        val serversJson: String,
        val automatic: Boolean,
        val source: TunnelService.Source,
    )

    private val pendingServers = mutableStateOf<PendingConnect?>(null)

    /**
     * Android requires an explicit user consent dialog before an app may create
     * a VPN interface. The tunnel can only start after this returns OK.
     */
    private val vpnConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) startTunnel(pendingServers.value)
        pendingServers.value = null
    }

    /**
     * Android 13 made the notification a permission rather than a given.
     *
     * The tunnel does not depend on it: the foreground service still runs if it
     * is refused, the ongoing notification is simply not shown. So the answer is
     * not acted on — it is asked once and the app carries on either way.
     */
    private val notificationConsent =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        askForNotifications()
        val app = application as SixVpnApp
        setContent {
            cVPNTheme {
                cVPNRoot(
                    app = app,
                    onConnect = ::requestTunnel,
                    onDisconnect = ::stopTunnel,
                    onOpenStore = ::openStore,
                )
            }
        }
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) notificationConsent.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /**
     * The app hands the service the candidate servers, not a finished Xray
     * config: the config has to carry the TUN descriptor, and that only exists
     * once the service has established the interface.
     *
     * @param automatic true to let the tunnel measure the candidates and
     *   decide; false when the person chose one and it is not to wander off it.
     * @param source the section that asked. Not the same question as
     *   [automatic]: either section may hand over a list to be chosen from, and
     *   the tunnel still belongs to the one that asked.
     */
    private fun requestTunnel(
        servers: List<Server>,
        automatic: Boolean,
        source: TunnelService.Source,
    ) {
        if (servers.isEmpty()) return
        val request = PendingConnect(TunnelService.serversPayload(servers), automatic, source)
        val consentIntent = VpnService.prepare(this)
        if (consentIntent != null) {
            pendingServers.value = request
            vpnConsent.launch(consentIntent)
        } else {
            startTunnel(request)
        }
    }

    private fun startTunnel(request: PendingConnect?) {
        if (request == null) return
        val (serversJson, automatic, source) = request
        // Every address, not only the one in use: the routing rule that keeps
        // the control plane off the tunnel has to cover the spare too, or the
        // fallback is routed into the tunnel it exists to survive.
        val controlHosts = (application as SixVpnApp).endpoints.ordered()
            .mapNotNull { runCatching { java.net.URL(it).host }.getOrNull() }
            .toTypedArray()
        startService(
            Intent(this, TunnelService::class.java)
                .setAction(TunnelService.ACTION_CONNECT)
                .putExtra(TunnelService.EXTRA_SERVERS, serversJson)
                .putExtra(TunnelService.EXTRA_AUTOMATIC, automatic)
                .putExtra(TunnelService.EXTRA_SOURCE, source.name)
                .putExtra(TunnelService.EXTRA_CONTROL_HOST, controlHosts)
                // What the app is set to. The tunnel weighs its candidates by
                // it whenever it is the one choosing -- on either tab, since
                // the config list has an Automatic row of its own now. With one
                // candidate there is nothing to weigh and it changes nothing.
                .putExtra(
                    TunnelService.EXTRA_PURPOSE,
                    (application as SixVpnApp).session.purposeName,
                )
                // Which resolver to answer with. Read at connect time rather
                // than held by the service, so a change on the Account tab
                // applies to the next connection without an app restart.
                .putExtra(
                    TunnelService.EXTRA_DNS,
                    (application as SixVpnApp).session.dnsMode.name,
                ),
        )
    }

    /**
     * Opens the web storefront. Only used by a build with `IN_APP_ORDERS` off
     * (see app/build.gradle.kts); otherwise the Premium tab opens the order
     * itself.
     */
    private fun openStore() {
        startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse((application as SixVpnApp).endpoints.current())),
        )
    }

    private fun stopTunnel() {
        startService(
            Intent(this, TunnelService::class.java).setAction(TunnelService.ACTION_DISCONNECT),
        )
    }
}
