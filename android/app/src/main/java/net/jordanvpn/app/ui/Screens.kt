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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
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
