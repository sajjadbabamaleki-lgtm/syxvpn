package net.jordanvpn.app.ui

import android.content.Intent
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
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import net.jordanvpn.app.BuildConfig
import net.jordanvpn.app.JordanApp as JordanApplication
import net.jordanvpn.app.core.Latency
import net.jordanvpn.app.core.supportLink
import net.jordanvpn.app.core.VlessProfile
import net.jordanvpn.app.core.XrayConfigBuilder
import net.jordanvpn.app.data.ControlPlaneClient
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

private enum class Tab { CONNECT, PREMIUM, SUPPORT, ACCOUNT }

/**
 * Four tabs: the tunnel, what is for sale, how to reach a human, and the
 * account behind it — the same four things the web app offers.
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
                Tab.PREMIUM -> PremiumScreen(app, onOpenStore)
                Tab.SUPPORT -> SupportScreen(app)
                Tab.ACCOUNT -> AccountScreen(
                    app,
                    onOpenPremium = { tab = Tab.PREMIUM },
                    onSignedOut = { signedIn = false },
                )
            }
        }
    }
}

/**
 * The connect control: a two-segment switch, OFF and ON.
 *
 * Geometry follows one rule — the thumb is inset from the pill by the same
 * amount on all four sides, and both are stadiums, so their curves stay
 * concentric and the gap reads as even everywhere:
 *
 *     pill    208 x 72,  radius 36 (half its height)
 *     inset    12 on every side
 *     thumb    92 x 48,  radius 24 (half its height)
 *
 * The inset equals the difference between the two radii (36 - 24), which is
 * what makes the curves concentric rather than merely close.
 *
 * Both labels stay visible, as on a segmented control; the thumb slides over
 * the active one. A switch also represents a state that is held, which is what
 * a tunnel is, and it is harder to trigger by accident than a large button.
 *
 * The thumb turns green only when the tunnel is actually up. While it is coming
 * up the thumb stays grey and a green light travels around it: the switch has
 * moved, the connection has not happened yet, and the colour should not say
 * otherwise.
 */
@Composable
private fun ConnectSwitch(
    state: JordanVpnService.State,
    enabled: Boolean,
    onToggle: () -> Unit,
) {
    val pillWidth = 208.dp
    val pillHeight = 72.dp
    val inset = 12.dp
    val thumbWidth = (pillWidth - inset * 2) / 2
    val thumbHeight = pillHeight - inset * 2

    val connected = state == JordanVpnService.State.CONNECTED
    val connecting = state == JordanVpnService.State.CONNECTING
    val on = connected || connecting

    val thumbFraction by animateFloatAsState(
        targetValue = if (on) 1f else 0f,
        animationSpec = tween(durationMillis = 300),
        label = "thumb",
    )

    Box(
        modifier = Modifier
            .size(pillWidth, pillHeight)
            .clip(RoundedCornerShape(percent = 50))
            .background(if (connected) Ok.copy(alpha = 0.10f) else SurfaceHigh)
            .border(
                1.dp,
                if (connected) Ok.copy(alpha = 0.50f) else Border,
                RoundedCornerShape(percent = 50),
            )
            .clickable(enabled = enabled, onClick = onToggle),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier.offset(x = inset + thumbWidth * thumbFraction),
            contentAlignment = Alignment.Center,
        ) {
            // Sits inside the pill with 2dp to spare, so the light never
            // touches the outer edge.
            OrbitLight(
                width = thumbWidth + 8.dp,
                height = thumbHeight + 8.dp,
                spinning = connecting,
            )
            Box(
                modifier = Modifier
                    .size(thumbWidth, thumbHeight)
                    .clip(RoundedCornerShape(percent = 50))
                    // Grey while connecting; green only once the tunnel is up.
                    .background(if (connected) Ok else Color(0xFF2A323D)),
            )
        }

        // Both labels stay in place; the thumb slides under them.
        //
        // The row is inset by the same amount as the thumb, so each half is
        // exactly the thumb's width and the labels land on the thumb's centre.
        // Splitting the full pill width instead would centre them 6dp off.
        Row(
            Modifier.fillMaxSize().padding(horizontal = inset),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SwitchLabel("OFF", active = !on, onGreen = false, modifier = Modifier.weight(1f))
            SwitchLabel("ON", active = on, onGreen = connected, modifier = Modifier.weight(1f))
        }
    }
}

/**
 * A switch label, centred on the glyphs rather than on the text box.
 *
 * Two things push centred text off centre and both are corrected here:
 * letter spacing is applied after the last glyph as well, which drags the ink
 * half a space left, and Android's default font padding plus line leading adds
 * room for descenders that all-caps labels never use, which lifts the ink.
 */
@Composable
private fun SwitchLabel(text: String, active: Boolean, onGreen: Boolean, modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Text(
            text,
            modifier = Modifier.padding(start = 2.dp),
            color = when {
                active && onGreen -> Color(0xFF06210E)
                active -> Color(0xFFE7ECF3)
                else -> TextFaint
            },
            fontWeight = FontWeight.ExtraBold,
            fontSize = 17.sp,
            lineHeight = 17.sp,
            letterSpacing = 2.sp,
            style = LocalTextStyle.current.copy(
                platformStyle = PlatformTextStyle(includeFontPadding = false),
                lineHeightStyle = LineHeightStyle(
                    alignment = LineHeightStyle.Alignment.Center,
                    trim = LineHeightStyle.Trim.Both,
                ),
            ),
        )
    }
}

/**
 * A green light travelling around the thumb while the tunnel comes up.
 *
 * It exists only in that waiting state: once connected the thumb itself turns
 * green and the light is gone, so the two states cannot be confused.
 *
 * Drawn as a rotating sweep gradient stroked along a stadium outline, which
 * needs no blur support (Modifier.blur is API 31; this app supports 24).
 */
@Composable
private fun OrbitLight(
    width: androidx.compose.ui.unit.Dp,
    height: androidx.compose.ui.unit.Dp,
    spinning: Boolean,
) {
    val transition = rememberInfiniteTransition(label = "orbit")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(1200, easing = LinearEasing)),
        label = "orbit-angle",
    )

    Canvas(Modifier.size(width, height)) {
        if (!spinning) return@Canvas
        val radius = size.height / 2
        val stroke = Stroke(width = 2.5f.dp.toPx())

        // Most of the sweep is transparent, so a single bright arc chases the
        // outline instead of the whole ring glowing.
        val brush = Brush.sweepGradient(
            0.00f to Color.Transparent,
            0.55f to Color.Transparent,
            0.78f to Ok.copy(alpha = 0.25f),
            0.94f to Ok,
            1.00f to Color.Transparent,
            center = center,
        )
        rotate(degrees = angle) {
            drawRoundRect(brush = brush, cornerRadius = CornerRadius(radius, radius), style = stroke)
        }
    }
}

// Icon outlines, in a 24x24 box. The same path data as the web app's icon set,
// so the two clients look like one product.
private const val ICON_COPY = "M9 9h10v10H9zM5 15V5h10"
private const val ICON_SHARE =
    "M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6z" +
        "M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"
private const val ICON_TRASH = "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"
private const val ICON_POWER = "M18.4 6.6a9 9 0 11-12.8 0M12 2.5v8"
private const val ICON_CROWN = "M3 8l4.6 3.4L12 4.6l4.4 6.8L21 8l-1.7 10.4H4.7L3 8z"
private const val ICON_CHAT = "M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7a2.5 2.5 0 01-2.5 2.5H10l-6 4.5v-14z"
private const val ICON_USER = "M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20.5v-1a4.5 4.5 0 014.5-4.5h6a4.5 4.5 0 014.5 4.5v1"
private const val ICON_WALLET = "M3 8a2 2 0 012-2h13a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8zM3 9h18M16.5 13.5h.01"

/** Draws one of the outlines above, scaled into the given size. */
@Composable
private fun PathIcon(pathData: String, size: androidx.compose.ui.unit.Dp, color: Color) {
    val path = remember(pathData) { PathParser().parsePathString(pathData).toPath() }
    Canvas(Modifier.size(size)) {
        val factor = this.size.width / 24f
        scale(factor, factor, pivot = Offset.Zero) {
            drawPath(
                path,
                color,
                style = Stroke(width = 1.8f, cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
    }
}

/** An icon button sized for a thumb, not for a mouse. */
@Composable
private fun RowAction(pathData: String, description: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(12.dp))
            // onClickLabel is what a screen reader announces for the action.
            .clickable(onClickLabel = description, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        PathIcon(pathData, 19.dp, TextDim)
    }
}

// A fixed row height, so the list can be capped at a whole number of rows
// instead of ending on a half-visible one.
private val ConfigRowHeight = 62.dp
private val ConfigRowGap = 13.dp
private const val VISIBLE_CONFIG_ROWS = 4
private val ConfigListHeight =
    ConfigRowHeight * VISIBLE_CONFIG_ROWS + ConfigRowGap * (VISIBLE_CONFIG_ROWS - 1)

/**
 * One row in the config list.
 *
 * Copy and share hand out the profile itself. Delete hides the server locally:
 * the subscription decides which servers exist, so the app cannot really remove
 * one — it can only stop showing it, and it keeps it hidden across refreshes.
 */
@Composable
private fun ConfigRow(
    profile: VlessProfile,
    selected: Boolean,
    connected: Boolean,
    onSelect: () -> Unit,
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onHide: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(ConfigRowHeight)
            .clip(RoundedCornerShape(24.dp))
            .background(if (selected) SurfaceHigh else Surface)
            .border(1.dp, if (selected) Ok.copy(alpha = 0.45f) else Border, RoundedCornerShape(24.dp))
            .clickable(onClick = onSelect)
            .padding(start = 16.dp, end = 6.dp),
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
            Text(
                "${profile.host}:${profile.port}",
                color = TextDim,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        RowAction(ICON_COPY, "Copy this config", onCopy)
        RowAction(ICON_SHARE, "Share this config", onShare)
        RowAction(ICON_TRASH, "Hide this config", onHide)
    }
}

/**
 * The bottom bar.
 *
 * Hand-drawn rather than a Material NavigationBar: the default one puts a wide
 * indicator capsule behind the selected icon and mixes its own metrics with
 * this app's, and the four icons here are one stroked set at one weight. The
 * bar is a floating rounded slab in the same language as the cards above it,
 * with a small accent block marking the selected tab.
 */
@Composable
private fun BottomBar(current: Tab, onSelect: (Tab) -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(66.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(Surface)
                .border(1.dp, Border, RoundedCornerShape(28.dp))
                .padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BottomBarItem(ICON_POWER, "Connect", current == Tab.CONNECT, Modifier.weight(1f)) { onSelect(Tab.CONNECT) }
            BottomBarItem(ICON_CROWN, "Premium", current == Tab.PREMIUM, Modifier.weight(1f)) { onSelect(Tab.PREMIUM) }
            BottomBarItem(ICON_CHAT, "Support", current == Tab.SUPPORT, Modifier.weight(1f)) { onSelect(Tab.SUPPORT) }
            BottomBarItem(ICON_USER, "Account", current == Tab.ACCOUNT, Modifier.weight(1f)) { onSelect(Tab.ACCOUNT) }
        }
    }
}

@Composable
private fun BottomBarItem(
    pathData: String,
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier
            .height(54.dp)
            .clip(RoundedCornerShape(22.dp))
            // The tint marks the selected tab without an indicator capsule that
            // would be wider than the icon it is meant to point at.
            .background(if (selected) Accent.copy(alpha = 0.12f) else Color.Transparent)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        PathIcon(pathData, 21.dp, if (selected) Accent else TextFaint)
        Spacer(Modifier.height(4.dp))
        Text(
            label,
            color = if (selected) Color.White else TextFaint,
            fontSize = 10.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
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
@OptIn(ExperimentalMaterial3Api::class)
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

    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    var profiles by remember { mutableStateOf<List<VlessProfile>>(emptyList()) }
    var hidden by remember { mutableStateOf(app.session.hiddenConfigs) }
    var selected by remember { mutableStateOf<VlessProfile?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var pingMs by remember { mutableStateOf<Long?>(null) }
    var pinging by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    val connected = tunnelState == JordanVpnService.State.CONNECTED
    val connecting = tunnelState == JordanVpnService.State.CONNECTING

    val key = { profile: VlessProfile -> "${profile.host}:${profile.port}" }
    val visible = profiles.filterNot { hidden.contains(key(it)) }

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
                    val offered = result.profiles.filterNot { hidden.contains(key(it)) }
                    // Keep the current choice if it is still offered.
                    selected = offered.firstOrNull { it.host == selected?.host && it.port == selected?.port }
                        ?: offered.firstOrNull()
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
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth().border(1.dp, Border, RoundedCornerShape(28.dp)),
        ) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            selected?.label ?: "No server available",
                            color = Color.White,
                            fontWeight = FontWeight.Medium,
                            fontSize = 15.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            selected?.let { "${it.host}:${it.port}" } ?: "buy a plan to get one",
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

                Spacer(Modifier.height(12.dp))

                // Down, ping and up as three tiles across the card. Keeping them
                // on one line is what lets the card stay this short.
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    StatTile(Modifier.weight(1f)) {
                        TileValue("\u2193", formatBytes(traffic.second), traffic.second > 0)
                    }
                    StatTile(
                        Modifier.weight(1f),
                        onClick = if (selected != null && !pinging) {
                            {
                                val profile = selected
                                if (profile != null) {
                                    scope.launch {
                                        pinging = true
                                        pingMs = Latency.measure(profile.host, profile.port)
                                        pinging = false
                                    }
                                }
                            }
                        } else {
                            null
                        },
                    ) {
                        Text(
                            when {
                                pinging -> "…"
                                pingMs != null -> "$pingMs ms"
                                else -> "PING"
                            },
                            color = if (pingMs != null && !pinging) Ok else Warn,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = if (pingMs == null) 1.sp else 0.sp,
                        )
                    }
                    StatTile(Modifier.weight(1f)) {
                        TileValue("\u2191", formatBytes(traffic.first), traffic.first > 0)
                    }
                }
            }
        }

        if (tunnelError != null && !connected && !connecting) {
            Spacer(Modifier.height(10.dp))
            Card(
                colors = CardDefaults.cardColors(containerColor = Color(0xFF2C1516)),
                shape = RoundedCornerShape(24.dp),
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

        Spacer(Modifier.height(14.dp))

        // Only this list scrolls: the switch and the card above it stay in
        // place. There is no header and no refresh button — the list is
        // self-evident, and pulling it down refreshes it, which is the gesture
        // people already reach for.
        // The list is capped at four whole rows: a partly visible fifth row
        // reads as a rendering accident rather than as "there is more below".
        Box(Modifier.weight(1f).fillMaxWidth()) {
            PullToRefreshBox(
                isRefreshing = busy,
                onRefresh = { refresh() },
                modifier = Modifier.fillMaxWidth().heightIn(max = ConfigListHeight),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(ConfigRowGap),
                ) {
                    if (visible.isEmpty()) {
                        item {
                            Column(
                                Modifier.fillMaxWidth().padding(vertical = 24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Text(
                                    when {
                                        profiles.isNotEmpty() -> "Every server is hidden."
                                        else -> status ?: "No configs yet. Buy a plan on the Account tab."
                                    },
                                    color = TextDim,
                                    fontSize = 13.sp,
                                    textAlign = TextAlign.Center,
                                )
                                if (profiles.isNotEmpty()) {
                                    TextButton(onClick = {
                                        hidden = emptySet()
                                        app.session.hiddenConfigs = hidden
                                        selected = profiles.firstOrNull()
                                    }) {
                                        Text("Show them again", color = Accent, fontSize = 13.sp)
                                    }
                                }
                            }
                        }
                    } else {
                        items(visible, key = { "${it.host}:${it.port}:${it.uuid}" }) { profile ->
                            val isSelected = profile.host == selected?.host && profile.port == selected?.port
                            ConfigRow(
                                profile = profile,
                                selected = isSelected,
                                connected = connected,
                                onSelect = {
                                    if (!isSelected) {
                                        selected = profile
                                        pingMs = null
                                        // Switching server while connected re-establishes
                                        // the tunnel on the new one rather than silently
                                        // keeping traffic on the old.
                                        if (connected || connecting) onConnect(configFor(profile))
                                    }
                                },
                                onCopy = {
                                    clipboard.setText(AnnotatedString(profile.uri))
                                    status = "Config copied"
                                },
                                onShare = {
                                    context.startActivity(
                                        Intent.createChooser(
                                            Intent(Intent.ACTION_SEND).apply {
                                                type = "text/plain"
                                                putExtra(Intent.EXTRA_TEXT, profile.uri)
                                            },
                                            null,
                                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                    )
                                },
                                onHide = {
                                    hidden = hidden + key(profile)
                                    app.session.hiddenConfigs = hidden
                                    if (isSelected) {
                                        selected = profiles.firstOrNull { !hidden.contains(key(it)) }
                                    }
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
    }
}

/** A tile inside the card: down, ping, up. Optionally tappable. */
@Composable
private fun StatTile(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Box(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(SurfaceHigh)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
        content = { content() },
    )
}

@Composable
private fun TileValue(arrow: String, value: String, live: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(arrow, color = if (live) Ok else TextFaint, fontSize = 13.sp)
        Spacer(Modifier.width(5.dp))
        Text(value, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

/**
 * Premium: what is on sale, and the USDT order that pays for it.
 *
 * Everything here is the storefront's own state. Plans come from
 * `/api/v1/shop/plans`, an order is opened through `/api/v1/shop/orders`, and
 * the screen then polls that order: settlement happens on chain, so the app
 * waits for the control plane to see the transfer rather than claiming anything
 * itself. Nothing is unlocked before the order says fulfilled.
 */
@Composable
private fun PremiumScreen(app: JordanApplication, onOpenStore: () -> Unit) {
    val scope = rememberCoroutineScope()

    var shopConfig by remember { mutableStateOf<ControlPlaneClient.ShopConfig?>(null) }
    var plans by remember { mutableStateOf<List<ControlPlaneClient.Plan>>(emptyList()) }
    var order by remember { mutableStateOf<ControlPlaneClient.Order?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busyPlan by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching {
            shopConfig = app.api.shopConfig()
            plans = app.api.plans()
            order = app.api.openOrder()
        }.onFailure { error = it.message }
        loading = false
    }

    // While an order is outstanding the only thing that can change it is a
    // transfer arriving on chain, so the screen asks the control plane.
    LaunchedEffect(order?.id, order?.status) {
        val open = order ?: return@LaunchedEffect
        if (open.status != "pending" && open.status != "paid") return@LaunchedEffect
        while (true) {
            delay(10_000)
            runCatching { app.api.order(open.id) }.onSuccess { order = it }
        }
    }

    val payments = shopConfig
    val canOrder = payments?.paymentsConfigured == true && BuildConfig.IN_APP_ORDERS

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Premium", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)

        val current = order
        if (current != null) {
            OrderPanel(
                order = current,
                contract = payments?.contract,
                onCancel = {
                    scope.launch {
                        runCatching { app.api.cancelOrder(current.id) }
                            .onSuccess { order = null }
                            .onFailure { error = it.message }
                    }
                },
                onDone = { order = null },
            )
        } else {
            if (loading) {
                Text("Loading plans…", color = TextDim, fontSize = 13.sp)
            }
            if (payments != null && !payments.paymentsConfigured) {
                NoticeCard(
                    "Payments are not set up yet",
                    "This deployment has no USDT address configured, so an order cannot be opened." +
                        (payments.supportContact?.let { " Contact $it." } ?: ""),
                )
            }
            if (!BuildConfig.IN_APP_ORDERS) {
                NoticeCard("Buying happens on the website", "This build opens the storefront in a browser to pay.")
            }
            plans.forEach { plan ->
                PlanCard(
                    plan = plan,
                    busy = busyPlan == plan.id,
                    canOrder = canOrder,
                    onBuy = {
                        if (!BuildConfig.IN_APP_ORDERS) {
                            onOpenStore()
                            return@PlanCard
                        }
                        scope.launch {
                            busyPlan = plan.id
                            error = null
                            runCatching { app.api.createOrder(plan.id) }
                                .onSuccess { order = it }
                                .onFailure { error = it.message }
                            busyPlan = null
                        }
                    },
                )
            }
            if (!loading && plans.isEmpty() && error == null) {
                Text("No plans have been published yet.", color = TextDim, fontSize = 13.sp)
            }
            if (plans.isNotEmpty() && payments != null) {
                Text(
                    "Payment is ${payments.asset} on ${payments.chain.uppercase(java.util.Locale.US)}. " +
                        "You send the exact amount shown on the next screen; the order settles by " +
                        "itself after ${payments.confirmations} confirmations. Nothing is unlocked before that.",
                    color = TextFaint,
                    fontSize = 12.sp,
                )
            }
        }

        error?.let { Text(it, color = Bad, fontSize = 13.sp) }
    }
}

@Composable
private fun PlanCard(
    plan: ControlPlaneClient.Plan,
    busy: Boolean,
    canOrder: Boolean,
    onBuy: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(28.dp))
            .background(Surface)
            .border(1.dp, Border, RoundedCornerShape(28.dp))
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(plan.name, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                plan.description?.let { Text(it, color = TextDim, fontSize = 12.sp) }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Text(formatUsdt(plan.priceMicro), color = Accent, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(4.dp))
                Text("USDT", color = TextFaint, fontSize = 11.sp, modifier = Modifier.padding(bottom = 3.dp))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(
                if (plan.quotaBytes > 0) formatBytes(plan.quotaBytes) else "Unmetered",
                color = TextDim,
                fontSize = 13.sp,
            )
            Text("${plan.durationDays} days", color = TextDim, fontSize = 13.sp)
        }
        Button(
            onClick = onBuy,
            enabled = (canOrder && !busy) || !BuildConfig.IN_APP_ORDERS,
            colors = ButtonDefaults.buttonColors(containerColor = Accent, disabledContainerColor = Border),
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) {
            Text(
                when {
                    !BuildConfig.IN_APP_ORDERS -> "Buy on the website"
                    busy -> "Opening order…"
                    canOrder -> "Buy with USDT"
                    else -> "Payments unavailable"
                },
                fontWeight = FontWeight.SemiBold,
                color = if (canOrder || !BuildConfig.IN_APP_ORDERS) Color(0xFF0B0F06) else TextFaint,
            )
        }
    }
}

/**
 * An open order: the exact amount, the address, and what the control plane has
 * seen so far. The amount is the identifier — the watcher matches a transfer to
 * an order by it — so it is shown exactly as the API returned it and is
 * copyable rather than retyped.
 */
@Composable
private fun OrderPanel(
    order: ControlPlaneClient.Order,
    contract: String?,
    onCancel: () -> Unit,
    onDone: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var note by remember { mutableStateOf<String?>(null) }

    val amount = formatUsdt(order.payAmountMicro)
    val open = order.status == "pending" || order.status == "paid"

    val title = when (order.status) {
        "pending" -> "Waiting for your payment"
        "paid" -> "Payment seen on chain"
        "fulfilled" -> "Paid and activated"
        "expired" -> "Order expired"
        "cancelled" -> "Order cancelled"
        else -> order.status
    }
    val body = when (order.status) {
        "pending" -> "Send the exact amount below. The order settles by itself once the transfer is confirmed."
        "paid" -> "The transfer was found and is waiting for confirmations (${order.confirmations} so far). Nothing else to do."
        "fulfilled" -> "Your servers are on the Connect tab."
        "expired" -> "No payment arrived in time. Nothing was charged — start a new order."
        "cancelled" -> "This order was cancelled."
        else -> ""
    }
    val tone = when (order.status) {
        "fulfilled" -> Ok
        "expired" -> Bad
        "pending", "paid" -> Warn
        else -> TextDim
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(28.dp))
            .background(Surface)
            .border(1.dp, Border, RoundedCornerShape(28.dp))
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(order.planName, color = TextFaint, fontSize = 11.sp, letterSpacing = 1.sp)
        Text(title, color = tone, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Text(body, color = TextDim, fontSize = 12.sp)

        if (open && order.payAddress != null) {
            Spacer(Modifier.height(2.dp))
            Text("SEND EXACTLY", color = TextFaint, fontSize = 10.sp, letterSpacing = 1.sp)
            Row(verticalAlignment = Alignment.Bottom) {
                Text(amount, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(5.dp))
                Text(order.asset ?: "USDT", color = TextDim, fontSize = 12.sp, modifier = Modifier.padding(bottom = 5.dp))
            }
            Text(
                "The exact amount is how your payment is matched to this order. A different amount will not settle it automatically.",
                color = TextFaint,
                fontSize = 11.sp,
            )
            Text("TO THIS ADDRESS", color = TextFaint, fontSize = 10.sp, letterSpacing = 1.sp)
            Text(
                order.payAddress,
                color = Color.White,
                fontSize = 13.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(SurfaceHigh)
                    .padding(12.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                SmallAction("Copy amount", Modifier.weight(1f)) {
                    clipboard.setText(AnnotatedString(amount))
                    note = "Amount copied"
                }
                SmallAction("Copy address", Modifier.weight(1f)) {
                    clipboard.setText(AnnotatedString(order.payAddress))
                    note = "Address copied"
                }
            }
            SmallAction("Open in a wallet app", Modifier.fillMaxWidth()) {
                // TRON wallets understand this URI; the amount and asset are
                // prefilled, and the customer still confirms in their wallet.
                val uri = android.net.Uri.parse(
                    "tron:${order.payAddress}?amount=$amount" +
                        (contract?.let { "&contractAddress=$it" } ?: ""),
                )
                val opened = runCatching {
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }.isSuccess
                if (!opened) note = "No wallet app answered that link — copy the address instead."
            }
            LabelledRow("Status", if (order.status == "paid") "seen, ${order.confirmations} confirmations" else "waiting", tone)
            LabelledRow("Order expires", formatRemaining(order.expiresAt), Color.White)
            LabelledRow(
                "Plan",
                "${if (order.quotaBytes > 0) formatBytes(order.quotaBytes) else "Unmetered"} · ${order.durationDays} days",
                Color.White,
            )
        }

        if (order.status == "fulfilled") {
            order.txHash?.let { LabelledRow("Transaction", it.take(12) + "…", TextDim) }
        }

        note?.let { Text(it, color = TextDim, fontSize = 12.sp) }

        if (order.status == "pending") {
            TextButton(onClick = onCancel) { Text("Cancel this order", color = TextDim, fontSize = 13.sp) }
        } else if (!open) {
            TextButton(onClick = onDone) { Text("Back to plans", color = Accent, fontSize = 13.sp) }
        }
    }
}

@Composable
private fun SmallAction(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .height(44.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(SurfaceHigh)
            .border(1.dp, Border, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium) }
}

@Composable
private fun NoticeCard(title: String, body: String) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(Color(0xFF2A2213))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, color = Warn, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Text(body, color = TextDim, fontSize = 12.sp)
    }
}

/**
 * Support: how to reach a human, and the facts that make the answer quick.
 *
 * The contact comes from the deployment (`SUPPORT_CONTACT`), so the operator
 * can change it without shipping a new APK, and when none is set the screen
 * says exactly that instead of showing a dead button.
 *
 * The diagnostics block deliberately carries no secrets: no session token, no
 * subscription URL, no UUID — the subscription URL alone is enough to use the
 * account, and support does not need it.
 */
@Composable
private fun SupportScreen(app: JordanApplication) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val tunnelState by JordanVpnService.state.collectAsState()
    val tunnelError by JordanVpnService.lastError.collectAsState()

    var contact by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { app.api.shopConfig() }
            .onSuccess { contact = it.supportContact?.takeIf(String::isNotBlank) }
            .onFailure { error = it.message }
        loading = false
    }

    val host = runCatching { java.net.URL(BuildConfig.CONTROL_PLANE_URL).host }.getOrNull()
        ?: BuildConfig.CONTROL_PLANE_URL

    val diagnostics = buildString {
        appendLine("Jordan VPN ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        appendLine("Android ${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT})")
        appendLine("Device ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
        appendLine("Control plane $host")
        appendLine("Account ${app.session.email ?: "not signed in"}")
        appendLine("Tunnel ${tunnelState.name.lowercase(java.util.Locale.US)}")
        tunnelError?.let { appendLine("Last error $it") }
    }.trim()

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Support", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)

        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(28.dp))
                .background(Surface)
                .border(1.dp, Border, RoundedCornerShape(28.dp))
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val current = contact
            when {
                loading -> Text("Loading…", color = TextDim, fontSize = 13.sp)
                current == null -> Text(
                    error ?: "This deployment has not published a support channel.",
                    color = if (error != null) Bad else TextDim,
                    fontSize = 13.sp,
                )
                else -> {
                    Text("Talk to us", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text(current, color = TextDim, fontSize = 13.sp)
                    val link = supportLink(current)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        if (link != null) {
                            SmallAction("Open", Modifier.weight(1f)) {
                                val opened = runCatching {
                                    context.startActivity(
                                        Intent(Intent.ACTION_VIEW, android.net.Uri.parse(link))
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                    )
                                }.isSuccess
                                if (!opened) note = "No app on this phone can open that link."
                            }
                        }
                        SmallAction("Copy", Modifier.weight(1f)) {
                            clipboard.setText(AnnotatedString(current))
                            note = "Contact copied"
                        }
                    }
                }
            }
        }

        Text("Before you write", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            SupportTip("A server that will not connect is usually one gateway, not the account — switch server on the Connect tab.")
            SupportTip("If everything fails at once, check the Account tab: an exhausted quota or an expired subscription stops every server.")
            SupportTip("Nothing to connect to? A new subscription appears after the order says fulfilled on the Premium tab.")
        }

        Text("Diagnostics", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Text(
            diagnostics,
            color = TextDim,
            fontSize = 12.sp,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(20.dp))
                .background(Surface)
                .border(1.dp, Border, RoundedCornerShape(20.dp))
                .padding(14.dp),
        )
        SmallAction("Copy diagnostics", Modifier.fillMaxWidth()) {
            clipboard.setText(AnnotatedString(diagnostics))
            note = "Diagnostics copied — paste them in your message"
        }
        Text(
            "No password, token or subscription link is in that text.",
            color = TextFaint,
            fontSize = 11.sp,
        )

        note?.let { Text(it, color = TextDim, fontSize = 12.sp) }
    }
}

@Composable
private fun SupportTip(text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Text("·", color = Accent, fontSize = 13.sp)
        Spacer(Modifier.width(8.dp))
        Text(text, color = TextDim, fontSize = 12.sp)
    }
}


@Composable
private fun AccountScreen(
    app: JordanApplication,
    onOpenPremium: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var subscription by remember { mutableStateOf<ControlPlaneClient.Subscription?>(null) }
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
                shape = RoundedCornerShape(28.dp),
                modifier = Modifier.fillMaxWidth().border(1.dp, Border, RoundedCornerShape(28.dp)),
            ) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
            onClick = onOpenPremium,
            colors = ButtonDefaults.buttonColors(containerColor = Accent),
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) { Text("Add data or time", fontWeight = FontWeight.SemiBold) }

        Text(
            "Data and days are added to this same account once an order settles.",
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
