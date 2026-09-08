package net.jordanvpn.app.ui

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableStateOf
import net.jordanvpn.app.JordanApp
import net.jordanvpn.app.vpn.JordanVpnService

/**
 * Single activity. The app has two screens — connect and account — matching the
 * web storefront, so a navigation library would cost more than it earns.
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as JordanApp
        setContent {
            JordanTheme {
                JordanRoot(
                    app = app,
                    onConnect = ::requestTunnel,
                    onDisconnect = ::stopTunnel,
                )
            }
        }
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

    private fun stopTunnel() {
        startService(
            Intent(this, JordanVpnService::class.java).setAction(JordanVpnService.ACTION_DISCONNECT),
        )
    }
}
