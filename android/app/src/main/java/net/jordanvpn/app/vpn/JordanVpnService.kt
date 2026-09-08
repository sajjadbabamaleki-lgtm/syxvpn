package net.jordanvpn.app.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import net.jordanvpn.app.R

/**
 * The tunnel.
 *
 * VpnService is the only supported way for an Android app to carry another
 * app's traffic. The service builds a TUN interface, hands the file descriptor
 * to the Xray bridge, and stays in the foreground for as long as the tunnel is
 * up (Android kills background VPNs).
 */
class JordanVpnService : VpnService() {

    enum class State { DISCONNECTED, CONNECTING, CONNECTED, FAILED }

    private val scope = CoroutineScope(SupervisorJob())
    private var tun: ParcelFileDescriptor? = null

    // Replace with the real implementation once the AAR is in place.
    private val bridge: XrayBridge = NotWiredXrayBridge()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> { disconnect(); return START_NOT_STICKY }
            else -> connect(intent?.getStringExtra(EXTRA_CONFIG))
        }
        return START_STICKY
    }

    private fun connect(configJson: String?) {
        if (configJson == null) {
            fail("No configuration supplied")
            return
        }
        state.value = State.CONNECTING
        startForeground(NOTIFICATION_ID, notification("Connecting…"))

        try {
            val builder = Builder()
                .setSession(getString(R.string.app_name))
                .setMtu(1500)
                .addAddress("10.99.0.2", 30)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
                // Default route: everything goes through the tunnel.
                .addRoute("0.0.0.0", 0)
                .addRoute("::", 0)
            // Never route this app's own traffic into its own tunnel.
            builder.addDisallowedApplication(packageName)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)

            val descriptor = builder.establish() ?: run {
                fail("VPN permission was revoked")
                return
            }
            tun = descriptor
            bridge.start(configJson, descriptor, net.jordanvpn.app.core.XrayConfigBuilder.SOCKS_PORT)
            state.value = State.CONNECTED
            updateNotification("Connected")
        } catch (error: Throwable) {
            fail(error.message ?: "Could not start the tunnel")
        }
    }

    private fun fail(message: String) {
        lastError.value = message
        state.value = State.FAILED
        cleanUp()
        stopSelf()
    }

    private fun disconnect() {
        state.value = State.DISCONNECTED
        cleanUp()
        stopSelf()
    }

    private fun cleanUp() {
        runCatching { bridge.stop() }
        runCatching { tun?.close() }
        tun = null
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onRevoke() {
        // The user switched to another VPN or revoked permission.
        disconnect()
        super.onRevoke()
    }

    override fun onDestroy() {
        cleanUp()
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_vpn_ic)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    companion object {
        const val ACTION_CONNECT = "net.jordanvpn.app.CONNECT"
        const val ACTION_DISCONNECT = "net.jordanvpn.app.DISCONNECT"
        const val EXTRA_CONFIG = "config"
        private const val CHANNEL_ID = "tunnel"
        private const val NOTIFICATION_ID = 1

        val state = MutableStateFlow(State.DISCONNECTED)
        val lastError = MutableStateFlow<String?>(null)
        val observableState: StateFlow<State> get() = state
    }
}
