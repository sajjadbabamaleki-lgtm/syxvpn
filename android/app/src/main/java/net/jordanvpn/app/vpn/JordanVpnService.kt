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
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import net.jordanvpn.app.R
import net.jordanvpn.app.core.ConnectionMemory
import net.jordanvpn.app.core.Latency
import net.jordanvpn.app.core.Probe
import net.jordanvpn.app.core.Purpose
import net.jordanvpn.app.core.RecoveryPolicy
import net.jordanvpn.app.core.RouteState
import net.jordanvpn.app.core.Server
import net.jordanvpn.app.core.ServerPicker
import net.jordanvpn.app.core.SmartConnect
import net.jordanvpn.app.core.VlessProfile
import net.jordanvpn.app.core.XrayConfigBuilder
import org.json.JSONArray
import org.json.JSONObject
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


    /** Which of the app's two sections asked for the tunnel that is running. */

    enum class Source { NONE, AUTOMATIC, MANUAL }

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

    /**
     * What the last connect was asked to do, kept so a dropped tunnel can be
     * rebuilt without the app being in the foreground to ask again.
     */
    private var candidates: List<Server> = emptyList()
    private var automaticMode: Boolean = false
    private var controlHost: String? = null
    private var purpose: Purpose = Purpose.AUTO
    private val recovery = RecoveryPolicy()

    /** What this phone has learned about these gateways. Worker thread only. */
    private var memory: ConnectionMemory = ConnectionMemory.EMPTY

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> { disconnect(); return START_NOT_STICKY }
            else -> connect(
                intent?.getStringExtra(EXTRA_SERVERS),
                intent?.getBooleanExtra(EXTRA_AUTOMATIC, false) ?: false,
                intent?.getStringExtra(EXTRA_CONTROL_HOST),
                Purpose.of(intent?.getStringExtra(EXTRA_PURPOSE)),
            )
        }
        return START_STICKY
    }

    /**
     * @param serversJson the servers to consider, as
     *   `[{"uri": "vless://…", "routeState": "healthy"}, …]`. In manual mode
     *   the list holds the one the person chose.
     * @param automatic when true the tunnel measures the candidates and decides;
     *   when false it uses the first entry and does not wander off it.
     */
    private fun connect(
        serversJson: String?,
        automatic: Boolean,
        controlPlaneHost: String?,
        wanted: Purpose,
    ) {
        val servers = parseServers(serversJson)
        if (servers.isEmpty()) {
            fail("No server was selected")
            return
        }
        candidates = servers
        automaticMode = automatic
        // Set here rather than at CONNECTED, so a screen watching this knows
        // whose connection attempt is in flight and not only whose succeeded.
        source.value = if (automatic) Source.AUTOMATIC else Source.MANUAL
        controlHost = controlPlaneHost
        purpose = wanted
        // A fresh request from the app is not a recovery attempt: someone is
        // holding the phone, so the budget for automatic retries starts again.
        recovery.settled()
        attempt()
    }

    /**
     * One pass at bringing the tunnel up on the candidates already stored.
     *
     * Recovery re-enters here rather than through [connect]: the decision of
     * what to connect to was made when the person pressed ON, and a dropped
     * tunnel does not get to widen it.
     */
    private fun attempt() {
        val servers = candidates
        val automatic = automaticMode
        val controlPlaneHost = controlHost

        state.value = State.CONNECTING
        startForeground(NOTIFICATION_ID, notification("Connecting…"))

        // Starting the core opens sockets and builds a network stack; that does
        // not belong on the main thread. The switch already shows CONNECTING,
        // and it stays grey until this succeeds.
        scope.launch {
            // Switching server while connected: tear the old tunnel down first,
            // so traffic cannot keep flowing through the server just left.
            tearDown()
            memory = ConnectionMemory.decode(session()?.connectionMemory)
                .keepOnly(servers.map { it.key }.toSet())
            try {
                val metricsPort = freeLoopbackPort()
                val runtime = createXrayBridge({ fd -> protect(fd) }, metricsPort)
                bridge = runtime

                // Measuring happens before the interface exists. Once the TUN is
                // up it carries everything, and a probe would be measuring the
                // tunnel it is trying to choose.
                val order = if (automatic) chooseOrder(servers, runtime) else servers

                val descriptor = establish() ?: return@launch
                tun = descriptor

                var lastFailure: Throwable? = null
                for (server in order) {
                    activity.value = "Connecting to ${server.label}"
                    updateNotification("Connecting to ${server.label}")
                    try {
                        runtime.start(
                            XrayConfigBuilder.build(
                                profile = server.profile,
                                controlPlaneHost = controlPlaneHost,
                                tunFd = descriptor.fd,
                                metricsPort = metricsPort,
                            ),
                        )
                    } catch (failure: Throwable) {
                        // One server refusing is not the end of the attempt; the
                        // next candidate gets the same descriptor — and the
                        // refusal is remembered, so tomorrow's ranking knows.
                        lastFailure = failure
                        memory = memory.recordOutcome(server.key, success = false, now = System.currentTimeMillis())
                        runCatching { runtime.stop() }
                        continue
                    }
                    memory = memory.recordOutcome(server.key, success = true, now = System.currentTimeMillis())
                    rememberMeasurements()
                    runtimeVersion.value = runtime.version()
                    activeServer.value = server.key
                    activeLabel.value = server.label
                    activity.value = null
                    connectedAt = System.currentTimeMillis()
                    state.value = State.CONNECTED
                    lastError.value = null
                    startStatsLoop()
                    updateNotification("Connected · ${server.label}")
                    return@launch
                }
                rememberMeasurements()
                fail(
                    lastFailure?.message
                        ?: "No server accepted the connection (${order.size} tried)",
                )
            } catch (error: Throwable) {
                fail(error.message ?: "Could not start the tunnel")
            }
        }
    }

    /**
     * Decides which server to use, and in what order to fall back.
     *
     * Two measurements, in the order of how much they prove:
     *
     *  1. a TCP handshake to every gateway, from this phone. It says the first
     *     hop is reachable on this network — and nothing at all about whether
     *     the gateway can still reach the internet.
     *  2. a real request *through* the best few, made by the core itself. That
     *     is the only evidence the far half of the path works, and it is why a
     *     gateway that answers in 20 ms but has a dead egress loses to one that
     *     answers in 400 ms and works.
     *
     * Everything the control plane already knows — its own view of each
     * gateway's ingress and egress — outranks both, because it watches all of
     * them continuously and the phone gets one look.
     */
    private suspend fun chooseOrder(servers: List<Server>, runtime: XrayBridge): List<Server> {
        activity.value = "Measuring ${servers.size} servers…"
        val probes = measure(servers)
        val now = System.currentTimeMillis()
        probes.values.forEach { probe ->
            probe.rttMs?.let { memory = memory.recordSample(probe.key, it, now) }
        }

        val shortlist = ServerPicker.rank(servers, probes).take(PROBE_SHORTLIST)
        val endToEnd = if (shortlist.isEmpty()) {
            emptyMap()
        } else {
            activity.value = "Testing ${shortlist.size} of them end to end…"
            val delays = runCatching {
                runtime.probe(shortlist.map { XrayConfigBuilder.outboundOnly(it.profile) })
            }.getOrElse { emptyList() }
            // No runtime, or a refused batch: no evidence rather than bad
            // evidence. The handshake ranking then decides on its own.
            shortlist.indices.filter { it < delays.size }
                .associate { shortlist[it].key to delays[it] }
        }

        return SmartConnect.connectOrder(
            servers = servers,
            probes = probes,
            endToEnd = endToEnd,
            memory = memory,
            purpose = purpose,
            current = activeServer.value,
        )
    }

    /** The app's own store, when the service is running inside the app's process. */
    private fun session(): net.jordanvpn.app.data.SessionStore? =
        (application as? net.jordanvpn.app.JordanApp)?.session

    /**
     * Writes what was learned this attempt.
     *
     * Once per attempt rather than per measurement: this is an encrypted file
     * write, and it has no business on the path between pressing ON and the
     * tunnel coming up.
     */
    private fun rememberMeasurements() {
        runCatching { session()?.connectionMemory = memory.encode() }
    }

    /** Real handshakes, in parallel, with a short ceiling on each. */
    private suspend fun measure(servers: List<Server>): Map<String, Probe> = coroutineScope {
        servers.map { server ->
            async {
                val rtt = Latency.measure(server.profile.host, server.profile.port, HANDSHAKE_TIMEOUT_MS)
                server.key to Probe(server.key, rttMs = rtt, attempted = true)
            }
        }.associate { it.await() }
    }

    private fun parseServers(json: String?): List<Server> {
        if (json.isNullOrBlank()) return emptyList()
        val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val entry = array.optJSONObject(index) ?: return@mapNotNull null
            val profile = VlessProfile.parse(entry.optString("uri")) ?: return@mapNotNull null
            Server(
                profile = profile,
                routeState = RouteState.of(entry.optString("routeState").takeIf { it.isNotEmpty() }),
                gatewayName = entry.optString("gatewayName").takeIf { it.isNotEmpty() },
                region = entry.optString("region").takeIf { it.isNotEmpty() },
            )
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
        source.value = Source.NONE
        traffic.value = 0L to 0L
        uptimeSeconds.value = 0L
        activity.value = null
        scope.launch { tearDown() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun disconnect() {
        state.value = State.DISCONNECTED
        source.value = Source.NONE
        traffic.value = 0L to 0L
        uptimeSeconds.value = 0L
        activity.value = null
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
            var silentChecks = 0
            while (isActive) {
                // Off the lifecycle thread: this is an HTTP call to the core's
                // metrics server, and it must not delay a disconnect.
                traffic.value = withContext(Dispatchers.IO) {
                    runCatching { bridge?.trafficStats() }.getOrNull()
                } ?: (0L to 0L)
                uptimeSeconds.value = (System.currentTimeMillis() - connectedAt) / 1000

                // The watchdog. A tunnel can stop being a tunnel without anyone
                // asking it to — the core exits, the network underneath changes,
                // the gateway goes away — and until now the app would have gone
                // on showing CONNECTED over nothing. A few consecutive checks
                // rather than one, because a single reading is not an outage.
                val running = withContext(Dispatchers.IO) {
                    runCatching { bridge?.isRunning() }.getOrNull()
                }
                silentChecks = if (running == false) silentChecks + 1 else 0
                if (silentChecks >= WATCHDOG_STRIKES) {
                    scope.launch { reconnect() }
                    return@launch
                }
                // A session that has held this long is not a recovery in
                // progress; the budget for automatic retries starts again.
                if (uptimeSeconds.value * 1000 >= RecoveryPolicy.SETTLED_AFTER_MS) recovery.settled()
                // The VPN screen deliberately shows no counters, so the
                // session's real traffic lives here, where a glance at the
                // notification shade finds it.
                val (up, down) = traffic.value
                updateNotification(
                    "Connected · ${activeLabel.value ?: "tunnel"}   ↓ ${shortBytes(down)}   ↑ ${shortBytes(up)}",
                )
                delay(1000)
            }
        }
    }

    /**
     * Brings the tunnel back after it dropped on its own.
     *
     * The failure is recorded against the gateway that was carrying it, so the
     * next ranking already knows; then the same candidate list is tried again,
     * after a delay that grows with each attempt in the window. When the budget
     * is spent the tunnel stops and says so — an app that retries for ever
     * without telling anyone is worse than one that admits it is beaten.
     */
    private suspend fun reconnect() {
        val now = System.currentTimeMillis()
        activeServer.value?.let { memory = memory.recordOutcome(it, success = false, now = now) }
        rememberMeasurements()

        if (!recovery.canRetry(now)) {
            fail("The connection kept dropping. Switch it on again, or choose another server.")
            return
        }
        val wait = recovery.nextDelayMs(now)
        state.value = State.CONNECTING
        activity.value = "Reconnecting…"
        updateNotification("Reconnecting…")
        if (wait > 0) delay(wait)
        attempt()
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
            // The platform's own VPN glyph is a private resource, so this is ours.
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()
    }

    /** Short enough for one line of a notification. */
    private fun shortBytes(value: Long): String {
        if (value < 1024) return "$value B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var size = value.toDouble() / 1024
        var unit = 0
        while (size >= 1024 && unit < units.lastIndex) {
            size /= 1024
            unit += 1
        }
        return if (size < 10) String.format(java.util.Locale.US, "%.1f %s", size, units[unit])
        else String.format(java.util.Locale.US, "%.0f %s", size, units[unit])
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    companion object {
        const val ACTION_CONNECT = "net.jordanvpn.app.CONNECT"
        const val ACTION_DISCONNECT = "net.jordanvpn.app.DISCONNECT"

        /** The candidate servers, as JSON; see [serversPayload]. */
        const val EXTRA_SERVERS = "servers"

        /** True to let the tunnel measure and choose; false to use the first entry. */
        const val EXTRA_AUTOMATIC = "automatic"

        /** Hostname of the control plane, kept off the tunnel. */
        const val EXTRA_CONTROL_HOST = "controlHost"

        /** What the connection is for; changes how candidates are weighed. */
        const val EXTRA_PURPOSE = "purpose"

        /** How many of the best candidates are worth an end-to-end test. */
        private const val PROBE_SHORTLIST = 3

        /** A handshake that has not answered by now is not the one to pick. */
        private const val HANDSHAKE_TIMEOUT_MS = 2500

        /** Consecutive one-second checks reporting a stopped core before the
         *  watchdog treats the tunnel as gone. */
        private const val WATCHDOG_STRIKES = 3

        /** The JSON the app hands over, built where the servers are known. */
        fun serversPayload(servers: List<Server>): String = JSONArray().apply {
            servers.forEach { server ->
                put(
                    JSONObject()
                        .put("uri", server.profile.uri)
                        .put("routeState", server.routeState.name.lowercase())
                        .put("gatewayName", server.gatewayName ?: "")
                        .put("region", server.region ?: ""),
                )
            }
        }.toString()

        private const val CHANNEL_ID = "tunnel"
        private const val NOTIFICATION_ID = 1

        val state = MutableStateFlow(State.DISCONNECTED)

        /**
         * Which part of the app the running tunnel belongs to.
         *
         * A phone has one tunnel — Android permits a single VpnService
         * interface — but the app sells two things through it: servers a plan
         * provides and picks for you, and configs a person brought themselves.
         * Without this the screens cannot tell those apart: one tunnel state
         * drawn on both made turning either switch on look like turning both
         * on, which is not what either section is.
         */
        val source = MutableStateFlow(Source.NONE)

        val lastError = MutableStateFlow<String?>(null)
        /** uplink to downlink bytes, cumulative for the current session. */
        val traffic = MutableStateFlow(0L to 0L)
        val uptimeSeconds = MutableStateFlow(0L)

        /** The server the tunnel actually settled on, as host:port. */
        val activeServer = MutableStateFlow<String?>(null)
        val activeLabel = MutableStateFlow<String?>(null)

        /** What the tunnel is doing while it is not yet connected. */
        val activity = MutableStateFlow<String?>(null)
        /** Xray-core's version, once a session has started it. */
        val runtimeVersion = MutableStateFlow<String?>(null)
        val observableState: StateFlow<State> get() = state
    }
}
