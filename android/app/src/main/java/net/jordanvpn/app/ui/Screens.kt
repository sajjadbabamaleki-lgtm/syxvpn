package net.jordanvpn.app.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import net.jordanvpn.app.JordanApp as JordanApplication
import net.jordanvpn.app.core.Latency
import net.jordanvpn.app.core.VlessProfile
import net.jordanvpn.app.core.XrayConfigBuilder
import net.jordanvpn.app.vpn.JordanVpnService

private val Background = Color(0xFF0A0C0F)
private val Surface = Color(0xFF12161C)
private val SurfaceHigh = Color(0xFF171C23)
private val Border = Color(0xFF232A34)
private val Accent = Color(0xFFC8F24A)
private val Ok = Color(0xFF5FD97A)
private val Warn = Color(0xFFF0B02E)
private val Bad = Color(0xFFF2665F)
private val TextDim = Color(0xFF98A3B2)
private val TextFaint = Color(0xFF6C7684)

@Composable
fun JordanTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Accent,
            background = Background,
            surface = Surface,
            onPrimary = Color(0xFF0B0F06),
        ),
        content = content,
    )
}

private enum class Tab { CONNECT, ACCOUNT }

/**
 * Two tabs, mirroring the web app: the tunnel, and the account behind it.
 *
 * Everything on screen reflects real state. The switch follows the VPN service,
 * the counters come from the Xray instance, and the latency figure is an actual
 * TCP handshake to the gateway. With no Xray runtime bundled yet, moving the
 * switch surfaces that error instead of showing a fake CONNECTED.
 */
@Composable
fun JordanRoot(
    app: JordanApplication,
    onConnect: (String) -> Unit,
    onDisconnect: () -> Unit,
    onOpenStore: () -> Unit = {},
) {
    var signedIn by remember { mutableStateOf(app.session.token != null) }
    var tab by remember { mutableStateOf(Tab.CONNECT) }

    if (!signedIn) {
        SignInScreen(app) { signedIn = true }
        return
    }

    Scaffold(
        containerColor = Background,
        bottomBar = { BottomBar(tab) { tab = it } },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                Tab.CONNECT -> ConnectScreen(app, onConnect, onDisconnect)
                Tab.ACCOUNT -> AccountScreen(app, onOpenStore) { signedIn = false }
            }
        }
    }
}

/**
 * The connect control: a sliding OFF/ON switch rather than a push button.
 *
 * A switch represents a state that is held, which is what a tunnel is, and it
 * is harder to trigger by accident than a large button in the middle of a
 * phone screen.
 *
 * While the tunnel is coming up the pill carries a pulsing green halo: the
 * switch has moved, but the connection is not established yet and the screen
 * must not imply that it is. Once connected the halo settles to a steady glow.
 */
@Composable
private fun ConnectSwitch(
    state: JordanVpnService.State,
    enabled: Boolean,
    onToggle: () -> Unit,
) {
    val width = 236.dp
    val height = 66.dp
    val padding = 6.dp
    val on = state == JordanVpnService.State.CONNECTED || state == JordanVpnService.State.CONNECTING

    val thumbFraction by animateFloatAsState(
        targetValue = if (on) 1f else 0f,
        animationSpec = tween(durationMillis = 320),
        label = "thumb",
    )
    val pulse = rememberInfiniteTransition(label = "halo")
    val pulseAlpha by pulse.animateFloat(
        initialValue = 0.20f,
        targetValue = 0.85f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
        label = "halo-alpha",
    )
    val haloAlpha = when (state) {
        JordanVpnService.State.CONNECTING -> pulseAlpha
        JordanVpnService.State.CONNECTED -> 0.55f
        else -> 0f
    }

    val density = LocalDensity.current
    val thumbWidth = width / 2 - padding
    val travel = width - thumbWidth - padding * 2

    Box(contentAlignment = Alignment.Center) {
        // Halo, drawn as widening rounded outlines so it needs no blur support
        // (Modifier.blur is API 31+, and this app supports 24).
        if (haloAlpha > 0f) {
            Canvas(Modifier.size(width + 44.dp, height + 44.dp)) {
                // Many thin rings at decreasing alpha read as a glow; a real
                // blur would need API 31.
                val ringCount = 9
                for (ring in 1..ringCount) {
                    val spread = with(density) { (ring * 2.4f).dp.toPx() }
                    val radius = with(density) { ((height / 2) + (ring * 2.4f).dp).toPx() }
                    val falloff = (1f - (ring - 1f) / ringCount)
                    drawRoundRect(
                        color = Ok.copy(alpha = haloAlpha * falloff * falloff * 0.55f),
                        topLeft = Offset(
                            (size.width - with(density) { width.toPx() }) / 2 - spread,
                            (size.height - with(density) { height.toPx() }) / 2 - spread,
                        ),
                        size = Size(
                            with(density) { width.toPx() } + spread * 2,
                            with(density) { height.toPx() } + spread * 2,
                        ),
                        cornerRadius = CornerRadius(radius, radius),
                        style = Stroke(width = with(density) { 2.4f.dp.toPx() }),
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .size(width, height)
                .clip(RoundedCornerShape(percent = 50))
                .background(if (on) Ok.copy(alpha = 0.10f) else SurfaceHigh)
                .border(1.dp, if (on) Ok.copy(alpha = 0.55f) else Border, RoundedCornerShape(percent = 50))
                .clickable(enabled = enabled, onClick = onToggle),
        ) {
            // The label on the side the thumb is not covering.
            Row(
                Modifier.fillMaxSize().padding(horizontal = 30.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    "OFF",
                    color = if (on) TextFaint else Color.Transparent,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                )
                Text(
                    "ON",
                    color = if (on) Color.Transparent else TextFaint,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                )
            }

            Box(
                modifier = Modifier
                    .padding(padding)
                    .offset(x = travel * thumbFraction)
                    .size(thumbWidth, height - padding * 2)
                    .clip(RoundedCornerShape(percent = 50))
                    .background(if (on) Ok else Color(0xFF2A323D)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (on) "ON" else "OFF",
                    color = if (on) Color(0xFF06210E) else Color(0xFFD6DCE5),
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                )
            }
        }
    }
}

/** One row in the config list that scrolls under the card. */
@Composable
private fun ConfigRow(
    profile: VlessProfile,
    selected: Boolean,
    connected: Boolean,
    onSelect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) SurfaceHigh else Surface)
            .border(1.dp, if (selected) Ok.copy(alpha = 0.45f) else Border, RoundedCornerShape(12.dp))
            .clickable(onClick = onSelect)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(
                    when {
                        selected && connected -> Ok
                        selected -> Accent
                        else -> Border
                    },
                ),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                profile.label,
                color = Color.White,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text("${profile.host}:${profile.port}", color = TextDim, fontSize = 11.sp)
        }
        Text(if (profile.tls) "tls" else "plain", color = TextFaint, fontSize = 11.sp)
    }
}

@Composable
private fun PowerIcon(size: androidx.compose.ui.unit.Dp, color: Color, strokeWidth: Float = 6f) {
    Canvas(Modifier.size(size)) {
        val inset = strokeWidth
        val arc = Size(this.size.width - inset * 2, this.size.height - inset * 2)
        drawArc(
            color = color,
            startAngle = -60f,
            sweepAngle = 300f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = arc,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
        drawLine(
            color = color,
            start = Offset(this.size.width / 2, this.size.height * 0.12f),
            end = Offset(this.size.width / 2, this.size.height * 0.46f),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun BottomBar(current: Tab, onSelect: (Tab) -> Unit) {
    NavigationBar(containerColor = Color(0xFF0E1116), tonalElevation = 0.dp) {
        NavigationBarItem(
            selected = current == Tab.CONNECT,
            onClick = { onSelect(Tab.CONNECT) },
            icon = { PowerIcon(22.dp, if (current == Tab.CONNECT) Accent else TextFaint, strokeWidth = 4f) },
            label = { Text("Connect") },
            colors = NavigationBarItemDefaults.colors(
                selectedIconColor = Accent, selectedTextColor = Color.White,
                unselectedIconColor = TextFaint, unselectedTextColor = TextFaint,
                indicatorColor = SurfaceHigh,
            ),
        )
        NavigationBarItem(
            selected = current == Tab.ACCOUNT,
            onClick = { onSelect(Tab.ACCOUNT) },
            icon = { Icon(Icons.Filled.Person, contentDescription = null) },
            label = { Text("Account") },
            colors = NavigationBarItemDefaults.colors(
                selectedIconColor = Accent, selectedTextColor = Color.White,
                unselectedIconColor = TextFaint, unselectedTextColor = TextFaint,
                indicatorColor = SurfaceHigh,
            ),
        )
    }
}

/**
 * The whole tunnel on one screen: switch, what it is connected through, and the
 * configs to choose between.
 *
 * The config list is deliberately here rather than on its own tab. Switching
 * server is the thing people do most often, and making it a separate screen
 * turns a one-tap action into navigation. Only the list scrolls; the switch and
 * the card stay put.
 */
@Composable
private fun ConnectScreen(
    app: JordanApplication,
    onConnect: (String) -> Unit,
    onDisconnect: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val tunnelState by JordanVpnService.state.collectAsState()
    val tunnelError by JordanVpnService.lastError.collectAsState()
    val traffic by JordanVpnService.traffic.collectAsState()
    val uptime by JordanVpnService.uptimeSeconds.collectAsState()

    var profiles by remember { mutableStateOf<List<VlessProfile>>(emptyList()) }
    var selected by remember { mutableStateOf<VlessProfile?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var pingMs by remember { mutableStateOf<Long?>(null) }
    var pinging by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    val connected = tunnelState == JordanVpnService.State.CONNECTED
    val connecting = tunnelState == JordanVpnService.State.CONNECTING

    fun configFor(profile: VlessProfile) = XrayConfigBuilder.build(
        profile,
        app.session.subscriptionUrl?.let { runCatching { java.net.URL(it).host }.getOrNull() },
    )

    fun refresh() {
        scope.launch {
            busy = true
            runCatching { app.subscriptions.load(app.session) }
                .onSuccess { result ->
                    profiles = result.profiles
                    // Keep the current choice if it is still offered.
                    selected = result.profiles.firstOrNull { it.host == selected?.host && it.port == selected?.port }
                        ?: result.profiles.firstOrNull()
                    status = result.error ?: if (result.stale) "Showing the last known servers" else null
                }
                .onFailure { status = it.message }
            busy = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        Spacer(Modifier.height(14.dp))
        Text(
            "Jordan VPN",
            color = Color.White,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )

        Spacer(Modifier.height(26.dp))
        Box(Modifier.align(Alignment.CenterHorizontally)) {
            ConnectSwitch(
                state = tunnelState,
                enabled = selected != null || connected || connecting,
                onToggle = {
                    if (connected || connecting) onDisconnect()
                    else selected?.let { onConnect(configFor(it)) }
                },
            )
        }

        Spacer(Modifier.height(16.dp))
        Text(
            when (tunnelState) {
                JordanVpnService.State.CONNECTED -> "CONNECTED"
                JordanVpnService.State.CONNECTING -> "CONNECTING…"
                else -> "NOT CONNECTED"
            },
            color = when (tunnelState) {
                JordanVpnService.State.CONNECTED -> Ok
                JordanVpnService.State.CONNECTING -> Warn
                else -> TextDim
            },
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 2.sp,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        if (connected) {
            Spacer(Modifier.height(3.dp))
            Text(
                formatUptime(uptime),
                color = TextFaint,
                fontSize = 12.sp,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
        }

        Spacer(Modifier.height(18.dp))

        Card(
            colors = CardDefaults.cardColors(containerColor = Surface),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth().border(1.dp, Border, RoundedCornerShape(14.dp)),
        ) {
            Column(Modifier.padding(16.dp)) {
                Text("ACTIVE CONFIGURATION", color = TextFaint, fontSize = 10.sp, letterSpacing = 1.sp)
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            selected?.label ?: "No server available",
                            color = Color.White,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.height(2.dp))
                        Text(
                            selected?.let { "${it.host}:${it.port}" } ?: "buy a plan or refresh",
                            color = TextDim,
                            fontSize = 12.sp,
                        )
                    }
                    Text(
                        if (selected?.tls == true) "vless · ws · tls" else "vless · ws",
                        color = TextFaint,
                        fontSize = 11.sp,
                    )
                }

                Spacer(Modifier.height(10.dp))
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(
                        onClick = {
                            val profile = selected ?: return@TextButton
                            scope.launch {
                                pinging = true
                                pingMs = Latency.measure(profile.host, profile.port)
                                pinging = false
                            }
                        },
                        enabled = selected != null && !pinging,
                        contentPadding = PaddingValues(horizontal = 4.dp),
                    ) {
                        Text(if (pinging) "PINGING…" else "PING", color = Warn, fontSize = 12.sp, letterSpacing = 1.sp)
                    }
                    Text(
                        when {
                            pinging -> ""
                            pingMs != null -> "$pingMs ms"
                            else -> "not measured"
                        },
                        color = if (pingMs != null) Ok else TextFaint,
                        fontSize = 12.sp,
                        modifier = Modifier.weight(1f),
                    )
                }

                HorizontalDivider(color = Border)
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth()) {
                    TrafficColumn("Downlink", "↓", traffic.second, Modifier.weight(1f))
                    TrafficColumn("Uplink", "↑", traffic.first, Modifier.weight(1f))
                }
            }
        }

        if (tunnelError != null && !connected && !connecting) {
            Spacer(Modifier.height(10.dp))
            Card(
                colors = CardDefaults.cardColors(containerColor = Color(0xFF2C1516)),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    tunnelError!!,
                    color = Bad,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    modifier = Modifier.padding(14.dp),
                )
            }
        }

        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (profiles.isEmpty()) "YOUR CONFIGS" else "YOUR CONFIGS · ${profiles.size}",
                color = TextFaint,
                fontSize = 10.sp,
                letterSpacing = 1.sp,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { refresh() }, enabled = !busy, contentPadding = PaddingValues(horizontal = 4.dp)) {
                Text(if (busy) "REFRESHING…" else "REFRESH", color = TextDim, fontSize = 11.sp, letterSpacing = 1.sp)
            }
        }
        Spacer(Modifier.height(6.dp))

        // Only this list scrolls: the switch and the card above it stay in place.
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(bottom = 12.dp),
        ) {
            if (profiles.isEmpty()) {
                item {
                    Text(
                        status ?: "No configs yet. Buy a plan on the Account tab.",
                        color = TextDim,
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                    )
                }
            } else {
                items(profiles, key = { "${it.host}:${it.port}:${it.uuid}" }) { profile ->
                    val isSelected = profile.host == selected?.host && profile.port == selected?.port
                    ConfigRow(
                        profile = profile,
                        selected = isSelected,
                        connected = connected,
                        onSelect = {
                            if (isSelected) return@ConfigRow
                            selected = profile
                            pingMs = null
                            // Switching server while connected re-establishes the
                            // tunnel on the new one rather than silently keeping
                            // traffic on the old.
                            if (connected || connecting) onConnect(configFor(profile))
                        },
                    )
                }
                if (status != null) {
                    item {
                        Text(
                            status!!,
                            color = TextDim,
                            fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TrafficColumn(label: String, arrow: String, bytes: Long, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, color = TextDim, fontSize = 12.sp)
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(arrow, color = if (bytes > 0) Ok else TextFaint, fontSize = 14.sp)
            Spacer(Modifier.width(6.dp))
            Text(formatBytes(bytes), color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun AccountScreen(
    app: JordanApplication,
    onOpenStore: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var subscription by remember { mutableStateOf<net.jordanvpn.app.data.ControlPlaneClient.Subscription?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { app.api.subscription() }
            .onSuccess { subscription = it }
            .onFailure { error = it.message }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Account", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(app.session.email ?: "", color = TextDim, fontSize = 13.sp)

        val sub = subscription
        if (sub == null) {
            Text(
                error ?: "No subscription on this account yet.",
                color = if (error != null) Bad else TextDim,
                fontSize = 13.sp,
            )
        } else {
            Card(
                colors = CardDefaults.cardColors(containerColor = Surface),
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().border(1.dp, Border, RoundedCornerShape(14.dp)),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    LabelledRow("Status", if (sub.active) "active" else sub.state, if (sub.active) Ok else Bad)
                    LabelledRow("Used", formatBytes(sub.usedBytes), Color.White)
                    LabelledRow(
                        "Included",
                        if (sub.quotaBytes > 0) formatBytes(sub.quotaBytes) else "unmetered",
                        Color.White,
                    )
                    if (sub.quotaBytes > 0) {
                        LinearProgressIndicator(
                            progress = { (sub.usedBytes.toFloat() / sub.quotaBytes).coerceIn(0f, 1f) },
                            color = Accent,
                            trackColor = Border,
                            modifier = Modifier.fillMaxWidth().height(4.dp),
                        )
                    }
                    LabelledRow("Expires", sub.expiresAt.take(10), Color.White)
                }
            }
        }

        Button(
            onClick = onOpenStore,
            colors = ButtonDefaults.buttonColors(containerColor = Accent),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) { Text("Add data or time", fontWeight = FontWeight.SemiBold) }

        Text(
            "Plans are bought on the website; the app picks the new balance up automatically.",
            color = TextFaint,
            fontSize = 12.sp,
        )

        TextButton(onClick = {
            scope.launch { app.api.signOut(); onSignedOut() }
        }) { Text("Sign out", color = TextDim) }
    }
}

@Composable
private fun LabelledRow(label: String, value: String, valueColor: Color) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = TextFaint, fontSize = 13.sp)
        Text(value, color = valueColor, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SignInScreen(app: JordanApplication, onSignedIn: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf(app.session.email ?: "") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().background(Background).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("JORDAN", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp)
        Text("Sign in with your account", color = TextDim, fontSize = 13.sp)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                scope.launch {
                    busy = true
                    runCatching { app.api.signIn(email.trim(), password) }
                        .onSuccess { onSignedIn() }
                        .onFailure { error = it.message }
                    busy = false
                }
            },
            enabled = !busy,
            colors = ButtonDefaults.buttonColors(containerColor = Accent),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) { Text(if (busy) "Signing in…" else "Sign in", fontWeight = FontWeight.SemiBold) }
        error?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = Bad, fontSize = 13.sp)
        }
    }
}
