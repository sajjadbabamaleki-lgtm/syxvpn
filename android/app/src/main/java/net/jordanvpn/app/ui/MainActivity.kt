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
import net.jordanvpn.app.vpn.JordanVpnService

/**
 * Single activity. Four screens — connect, premium, support and account — swap
 * inside it, so a navigation library would cost more than it earns.
 */
class MainActivity : ComponentActivity() {

    private val pendingConfig = mutableStateOf<String?>(null)

    /**
     * Android requires an explicit user consent dialog before an app may create
     * a VPN interface. The tunnel can only start after this returns OK.
     */
    private val vpnConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) startTunnel(pendingConfig.value)
        pendingConfig.value = null
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

    private fun requestTunnel(configJson: String) {
        val consentIntent = VpnService.prepare(this)
        if (consentIntent != null) {
            pendingConfig.value = configJson
            vpnConsent.launch(consentIntent)
        } else {
            startTunnel(configJson)
        }
    }

    private fun startTunnel(configJson: String?) {
        if (configJson == null) return
        startService(
            Intent(this, JordanVpnService::class.java)
                .setAction(JordanVpnService.ACTION_CONNECT)
                .putExtra(JordanVpnService.EXTRA_CONFIG, configJson),
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
