package net.jordanvpn.app.ui

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
import net.jordanvpn.app.JordanApp
import net.jordanvpn.app.core.Server
import net.jordanvpn.app.vpn.JordanVpnService

/**
 * Single activity. Four screens — connect, premium, support and account — swap
 * inside it, so a navigation library would cost more than it earns.
 */
class MainActivity : ComponentActivity() {

    /** The connection waiting for the VPN consent dialog to come back. */
    private val pendingServers = mutableStateOf<Pair<String, Boolean>?>(null)

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
        val app = application as JordanApp
        setContent {
            JordanTheme {
                JordanRoot(
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
     */
    private fun requestTunnel(servers: List<Server>, automatic: Boolean) {
        if (servers.isEmpty()) return
        val request = JordanVpnService.serversPayload(servers) to automatic
        val consentIntent = VpnService.prepare(this)
        if (consentIntent != null) {
            pendingServers.value = request
            vpnConsent.launch(consentIntent)
        } else {
            startTunnel(request)
        }
    }

    private fun startTunnel(request: Pair<String, Boolean>?) {
        if (request == null) return
        val (serversJson, automatic) = request
        val controlHost = runCatching {
            java.net.URL(net.jordanvpn.app.BuildConfig.CONTROL_PLANE_URL).host
        }.getOrNull()
        startService(
            Intent(this, JordanVpnService::class.java)
                .setAction(JordanVpnService.ACTION_CONNECT)
                .putExtra(JordanVpnService.EXTRA_SERVERS, serversJson)
                .putExtra(JordanVpnService.EXTRA_AUTOMATIC, automatic)
                .putExtra(JordanVpnService.EXTRA_CONTROL_HOST, controlHost),
        )
    }

    /**
     * Opens the web storefront. Only used by a build with `IN_APP_ORDERS` off
     * (see app/build.gradle.kts); otherwise the Premium tab opens the order
     * itself.
     */
    private fun openStore() {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(net.jordanvpn.app.BuildConfig.CONTROL_PLANE_URL)))
    }

    private fun stopTunnel() {
        startService(
            Intent(this, JordanVpnService::class.java).setAction(JordanVpnService.ACTION_DISCONNECT),
        )
    }
}
