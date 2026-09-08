package net.jordanvpn.app.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.jordanvpn.app.R
import net.jordanvpn.app.core.VlessProfile
import net.jordanvpn.app.core.XrayConfigBuilder
import java.net.ServerSocket
import java.util.concurrent.Executors

/**
 * The tunnel.
 *
 * VpnService is the only supported way for an Android app to carry another
 * app's traffic. The service builds a TUN interface, hands its file descriptor
 * to Xray-core — which has its own layer-3 stack, so nothing forwards packets
 * in between — and stays in the foreground for as long as the tunnel is up
 * (Android kills background VPNs).
 *
 * The descriptor is passed by number, inside the config's root `env`, because
 * that is how Xray's Android TUN reads it. This service keeps the
 * ParcelFileDescriptor open for the whole session and closes it after the core
 * has stopped: the core never takes ownership of it.
 */
class JordanVpnService : VpnService() {

    enum class State { DISCONNECTED, CONNECTING, CONNECTED, FAILED }

    /**
     * One thread owns the tunnel's lifecycle.
     *
     * Starting the core, stopping it and closing the descriptor must never
     * overlap — switching server twice quickly would otherwise leave a second
     * instance starting while the first is still shutting down, and Xray
     * refuses a second instance outright. A single-threaded dispatcher makes
     * the ordering a property of the code rather than of the timing.
     */
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "jordan-tunnel")
    }.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + worker)
    private var tun: ParcelFileDescriptor? = null
    private var statsJob: Job? = null
    private var bridge: XrayBridge? = null
    private var connectedAt: Long = 0L

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> { disconnect(); return START_NOT_STICKY }
            else -> connect(
                intent?.getStringExtra(EXTRA_PROFILE),
                intent?.getStringExtra(EXTRA_CONTROL_HOST),
            )
        }
        return START_STICKY
    }

    private fun connect(profileUri: String?, controlPlaneHost: String?) {
        val profile = profileUri?.let(VlessProfile::parse)
        if (profile == null) {
            fail("No server was selected")
            return
        }

        state.value = State.CONNECTING
        startForeground(NOTIFICATION_ID, notification("Connecting…"))

        // Starting the core opens sockets and builds a network stack; that does
        // not belong on the main thread. The switch already shows CONNECTING,
        // and it stays grey until this succeeds.
        scope.launch {
            // Switching server while connected: tear the old tunnel down first,
            // so traffic cannot keep flowing through the server just left.
            tearDown()
            try {
                val descriptor = establish() ?: return@launch
                tun = descriptor
                val metricsPort = freeLoopbackPort()
                val runtime = createXrayBridge({ fd -> protect(fd) }, metricsPort)
                bridge = runtime
                runtime.start(
                    XrayConfigBuilder.build(
                        profile = profile,
                        controlPlaneHost = controlPlaneHost,
                        tunFd = descriptor.fd,
                        metricsPort = metricsPort,
                    ),
                )
                // The core's own version string, for the support screen. Null
                // means no runtime is bundled in this build.
                runtimeVersion.value = runtime.version()
                connectedAt = System.currentTimeMillis()
                state.value = State.CONNECTED
                lastError.value = null
                startStatsLoop()
                updateNotification("Connected · ${profile.label}")
            } catch (error: Throwable) {
                fail(error.message ?: "Could not start the tunnel")
            }
        }
    }

    private fun establish(): ParcelFileDescriptor? {
        val builder = Builder()
            .setSession(getString(R.string.app_name))
            .setMtu(XrayConfigBuilder.MTU)
            .addAddress("10.99.0.2", 30)
            // Default route: everything goes through the tunnel.
            .addRoute("0.0.0.0", 0)
            .addRoute("::", 0)
        XrayConfigBuilder.DNS_SERVERS.forEach(builder::addDnsServer)
        // Never route this app's own traffic into its own tunnel: the account
        // and the subscription have to stay reachable when the tunnel does not.
        builder.addDisallowedApplication(packageName)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)

        val descriptor = builder.establish()
        if (descriptor == null) fail("VPN permission was revoked")
        return descriptor
    }

    /**
     * A loopback port for Xray's metrics server.
     *
     * Binding zero and closing again is the ordinary way to be handed a port
     * nothing else is using; the window between closing and Xray binding it is
     * the same one every program that does this accepts.
     */
    private fun freeLoopbackPort(): Int = ServerSocket(0).use { it.localPort }

    private fun fail(message: String) {
        lastError.value = message
        state.value = State.FAILED
        traffic.value = 0L to 0L
        uptimeSeconds.value = 0L
        scope.launch { tearDown() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun disconnect() {
        state.value = State.DISCONNECTED
        traffic.value = 0L to 0L
        uptimeSeconds.value = 0L
        // Queued behind whatever the worker is doing, so a disconnect during a
        // connect tears down what that connect finished building.
        scope.launch { tearDown() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /**
     * Publishes the counters the connect screen shows. They are Xray's own
     * counters for the proxy outbound, so with no runtime bundled they stay at
     * zero rather than being animated to look alive.
     */
    private fun startStatsLoop() {
        statsJob?.cancel()
        statsJob = scope.launch {
            while (isActive) {
                // Off the lifecycle thread: this is an HTTP call to the core's
                // metrics server, and it must not delay a disconnect.
                traffic.value = withContext(Dispatchers.IO) {
                    runCatching { bridge?.trafficStats() }.getOrNull()
                } ?: (0L to 0L)
                uptimeSeconds.value = (System.currentTimeMillis() - connectedAt) / 1000
                delay(1000)
            }
        }
    }

    /** Stops the core and releases the interface, in that order. */
    private fun tearDown() {
        statsJob?.cancel()
        statsJob = null
        bridge?.let { runtime -> runCatching { runtime.stop() } }
        bridge = null
        // Only after the core has let go: it works on this descriptor by
        // number, and closing it first would pull the floor out from under it.
        runCatching { tun?.close() }
        tun = null
    }

    override fun onRevoke() {
        // The user switched to another VPN or revoked permission.
        disconnect()
        super.onRevoke()
    }

    override fun onDestroy() {
        // Last chance to let go of the descriptor, so this one is synchronous:
        // after this returns the process may be gone.
        tearDown()
        traffic.value = 0L to 0L
        uptimeSeconds.value = 0L
        scope.cancel()
        worker.close()
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

        /** The `vless://` line to connect through. */
        const val EXTRA_PROFILE = "profile"

        /** Hostname of the control plane, kept off the tunnel. */
        const val EXTRA_CONTROL_HOST = "controlHost"

        private const val CHANNEL_ID = "tunnel"
        private const val NOTIFICATION_ID = 1

        val state = MutableStateFlow(State.DISCONNECTED)
        val lastError = MutableStateFlow<String?>(null)
        /** uplink to downlink bytes, cumulative for the current session. */
        val traffic = MutableStateFlow(0L to 0L)
        val uptimeSeconds = MutableStateFlow(0L)
        /** Xray-core's version, once a session has started it. */
        val runtimeVersion = MutableStateFlow<String?>(null)
        val observableState: StateFlow<State> get() = state
    }
}
