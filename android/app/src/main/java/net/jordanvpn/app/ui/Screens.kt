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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.Stable
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import net.jordanvpn.app.BuildConfig
import net.jordanvpn.app.JordanApp as JordanApplication
import net.jordanvpn.app.core.CountryGroup
import net.jordanvpn.app.core.countryOf
import net.jordanvpn.app.core.groupByCountry
import net.jordanvpn.app.core.RouteState
import net.jordanvpn.app.core.Server
import net.jordanvpn.app.core.supportLink
import net.jordanvpn.app.data.ControlPlaneClient
import net.jordanvpn.app.data.SessionStore
import net.jordanvpn.app.data.SubscriptionRepository
import net.jordanvpn.app.vpn.JordanVpnService

private val Background = Color(0xFF0A0C0F)
private val Surface = Color(0xFF12161C)
private val SurfaceHigh = Color(0xFF171C23)
private val Border = Color(0xFF232A34)
// One accent, and it is the green of the switch: green means the tunnel is up,
// and the same green marks anything the product wants you to press. There is
// deliberately no amber — a state that is merely being attempted is shown in
// neutral grey, so colour never implies a connection that does not exist yet.
private val Accent = Color(0xFF5FD97A)
private val Ok = Accent
private val OnAccent = Color(0xFF06210E)
private val Pending = Color(0xFF98A3B2)
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
            onPrimary = OnAccent,
        ),
        content = content,
    )
}

private enum class Tab { VPN, CONFIGS, PREMIUM, SUPPORT, ACCOUNT }

/**
 * Five tabs. The first two are the two ways people actually use this app: a
 * switch that needs no configuration at all, and the configs for someone who
 * wants to see and handle the servers themselves. They are separate screens
 * because they are separate jobs, and they share one state so neither can show
 * a different answer to "which server is this".
 *
 * Everything on screen reflects real state. The switch follows the VPN service,
 * the counters come from the Xray instance, and the latency figure is an actual
 * TCP handshake to the gateway. With no Xray runtime bundled yet, moving the
 * switch surfaces that error instead of showing a fake CONNECTED.
 */
@Composable
fun JordanRoot(
    app: JordanApplication,
    onConnect: (List<Server>, Boolean) -> Unit,
    onDisconnect: () -> Unit,
    onOpenStore: () -> Unit = {},
) {
    var signedIn by remember { mutableStateOf(app.session.token != null) }
    var tab by remember { mutableStateOf(Tab.VPN) }
    // Set when the Account tab was reached from a Buy button: that person is
    // here to open an order, so the form starts on "create", not on "sign in".
    var buying by remember { mutableStateOf(false) }
    val servers = remember(app) { ServerListState(app.session) }

    // Refreshed signed in or not: a subscription link saved on this phone still
    // works without an account, and when there is neither the refresh is what
    // puts "buy a plan to get servers" on the screen instead of an empty list.
    LaunchedEffect(signedIn) { servers.refresh(app.subscriptions) }
    // A 401 clears the token; without watching for it the app would sit on a
    // signed-in-looking screen failing every call.
    val expired by app.api.sessionExpired.collectAsState()
    LaunchedEffect(expired) { if (expired) signedIn = false }

    // No sign-in wall. The app opens on the tunnel, because that is what it is
    // for; an account is only needed to buy a plan, and it is asked for at that
    // moment, on the Account tab.
    Scaffold(
        containerColor = Background,
        // Choosing a tab by hand clears the "came here to buy" intent, so the
        // account form is only pre-set to create right after a Buy button.
        bottomBar = { BottomBar(tab) { chosen -> tab = chosen; if (chosen != Tab.ACCOUNT) buying = false } },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                Tab.VPN -> VpnScreen(
                    app = app,
                    state = servers,
                    onConnect = onConnect,
                    onDisconnect = onDisconnect,
                    onOpenConfigs = { tab = Tab.CONFIGS },
                    onOpenPremium = { tab = Tab.PREMIUM },
                )
                Tab.CONFIGS -> ConfigsScreen(
                    app = app,
                    state = servers,
                    onConnect = onConnect,
                    onDisconnect = onDisconnect,
                    onOpenPremium = { tab = Tab.PREMIUM },
                )
                Tab.PREMIUM -> PremiumScreen(
                    app = app,
                    signedIn = signedIn,
                    onOpenStore = onOpenStore,
                    onNeedsAccount = { buying = true; tab = Tab.ACCOUNT },
                )
                Tab.SUPPORT -> SupportScreen(app)
                Tab.ACCOUNT -> if (signedIn) {
                    AccountScreen(
                        app,
                        onOpenPremium = { tab = Tab.PREMIUM },
                        onSignedOut = { signedIn = false },
                    )
                } else {
                    SignInScreen(app, expired, startCreating = buying) {
                        signedIn = true
                        // Back where the account was asked for, so the order can
                        // be finished; otherwise stay on the account itself.
                        if (buying) tab = Tab.PREMIUM
                        buying = false
                    }
                }
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
//
// Every arc is written with its two flags spaced out — `a9 9 0 1 1 -12.8 0`,
// not the compact `a9 9 0 11-12.8 0` that a browser accepts. Compose reads path
// data as a run of numbers and does not treat the flags as single digits, so the
// compact form loses a parameter: the arc silently disappears or lands somewhere
// it was never meant to. That is what turned the power icon into a bare vertical
// line on the first build that reached a phone.
private const val ICON_COPY = "M9 9h10v10H9zM5 15V5h10"
private const val ICON_SHARE =
    "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" +
        "M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4"
private const val ICON_TRASH = "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"
private const val ICON_POWER = "M18.4 6.6a9 9 0 1 1 -12.8 0M12 2.5v8"
private const val ICON_CROWN = "M3 8l4.6 3.4L12 4.6l4.4 6.8L21 8l-1.7 10.4H4.7L3 8z"
private const val ICON_GLOBE =
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"
private const val ICON_SERVERS = "M4 5h16v6H4zM4 15h16v4H4zM8 8h.01M8 17h.01"
private const val ICON_CHEVRON = "M9 5l7 7-7 7"
private const val ICON_CHAT =
    "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1 -2.5 2.5H10l-6 4.5v-14z"
private const val ICON_USER =
    "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5v-1a4.5 4.5 0 0 1 4.5-4.5h6a4.5 4.5 0 0 1 4.5 4.5v1"
private const val ICON_WALLET =
    "M3 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2-2V8zM3 9h18M16.5 13.5h.01"

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
private val CountryRowHeight = 60.dp
private val CountryRowGap = 10.dp

/**
 * Both lists end on the third row, and everything left over goes to the banner
 * slot above. A list that filled the screen would leave nowhere to put one.
 */
private const val VISIBLE_ROWS = 3
private val ConfigListHeight =
    ConfigRowHeight * VISIBLE_ROWS + ConfigRowGap * (VISIBLE_ROWS - 1)
private val CountryListHeight =
    CountryRowHeight * VISIBLE_ROWS + CountryRowGap * (VISIBLE_ROWS - 1)

/**
 * Room kept for a banner, on both screens.
 *
 * It draws nothing. An empty rectangle with the word "Ad" in it would be an
 * advertisement for nothing, and a placeholder is a promise the app has not
 * kept yet — so the space is simply there, and whatever goes in it later gets
 * a real composable.
 */
@Composable
private fun BannerSlot(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth())
}

/**
 * One row in the config list.
 *
 * Copy and share hand out the profile itself. Delete hides the server locally:
 * the subscription decides which servers exist, so the app cannot really remove
 * one — it can only stop showing it, and it keeps it hidden across refreshes.
 */
@Composable
private fun ConfigRow(
    server: Server,
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
                        selected -> Pending
                        else -> Border
                    },
                ),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                server.label,
                color = Color.White,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                buildString {
                    append("${server.profile.host}:${server.profile.port}")
                    // The control plane's verdict on the far half of the path.
                    // "healthy" is the ordinary case and needs no label.
                    when (server.routeState) {
                        RouteState.DEGRADED -> append("  ·  degraded")
                        RouteState.UNVERIFIED -> append("  ·  unverified")
                        else -> Unit
                    }
                },
                color = if (server.routeState == RouteState.HEALTHY || server.routeState == RouteState.UNKNOWN) {
                    TextDim
                } else {
                    Pending
                },
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
            BottomBarItem(ICON_POWER, "VPN", current == Tab.VPN, Modifier.weight(1f)) { onSelect(Tab.VPN) }
            BottomBarItem(ICON_SERVERS, "Configs", current == Tab.CONFIGS, Modifier.weight(1f)) { onSelect(Tab.CONFIGS) }
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
            .clip(RoundedCornerShape(20.dp))
            // The tint marks the selected tab without an indicator capsule that
            // would be wider than the icon it is meant to point at.
            .background(if (selected) Accent.copy(alpha = 0.12f) else Color.Transparent)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        PathIcon(pathData, 20.dp, if (selected) Accent else TextFaint)
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
 * Everything both halves of the app need to agree on.
 *
 * The tunnel and the list of servers live on two tabs now, so this is hoisted
 * out of either of them: which servers the subscription offers, which one the
 * person chose, whether the tunnel is choosing instead, and what is hidden.
 * Two screens reading two copies of that would drift apart within a tap.
 */
@Stable
private class ServerListState(private val session: SessionStore) {
    var servers by mutableStateOf<List<Server>>(emptyList())
        private set
    var hidden by mutableStateOf(session.hiddenConfigs)
        private set
    var automatic by mutableStateOf(session.automaticServer)
        private set

    /** ISO code of the country the tunnel may choose from; null means anywhere. */
    var country by mutableStateOf(session.country)
        private set
    var chosen by mutableStateOf<Server?>(null)
    var status by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
        private set

    val visible: List<Server> get() = servers.filterNot { hidden.contains(it.key) }

    /**
     * Narrows automatic selection to one country, or opens it up again.
     *
     * Named `use…` rather than `set…`: `var country` already compiles to a
     * `setCountry` on the JVM, and two methods cannot share one signature.
     */
    fun useCountry(code: String?) {
        country = code
        session.country = code
        automatic = true
        session.automaticServer = true
    }

    /** The servers automatic selection may use right now. */
    val pool: List<Server>
        get() = country?.let { code ->
            visible.filter { (countryOf(it)?.code ?: CountryGroup.OTHER) == code }
        } ?: visible

    fun useAutomatic(value: Boolean) {
        automatic = value
        session.automaticServer = value
        if (!value && chosen == null) chosen = visible.firstOrNull()
    }

    fun hide(server: Server) {
        hidden = hidden + server.key
        session.hiddenConfigs = hidden
        if (chosen?.key == server.key) chosen = visible.firstOrNull()
    }

    fun unhideAll() {
        hidden = emptySet()
        session.hiddenConfigs = hidden
        if (chosen == null) chosen = servers.firstOrNull()
    }

    suspend fun refresh(repository: SubscriptionRepository) {
        busy = true
        runCatching { repository.load(session) }
            .onSuccess { result ->
                servers = result.servers
                val offered = result.servers.filterNot { hidden.contains(it.key) }
                // Keep the current choice if it is still offered.
                chosen = offered.firstOrNull { it.key == chosen?.key } ?: offered.firstOrNull()
                status = result.error ?: if (result.stale) "Showing the last known servers" else null
            }
            .onFailure { status = it.message }
        busy = false
    }
}

/**
 * The VPN screen: a switch, and what it is connected through.
 *
 * This is the whole app for someone who never wants to see a config. It carries
 * no list — the servers are one tab away — but it never hides which server is
 * carrying the traffic, and the card is a button into that tab, so choosing a
 * different one is two taps rather than a hunt.
 */
/**
 * The half of the screen that is the same on both tabs: the banner slot, the
 * switch, what state it is in, and the card that names the server and the plan.
 *
 * Both tabs carry it because both are ways of doing the same thing — the VPN
 * tab lists countries under it, the Configs tab lists the configs themselves —
 * and a switch that appears on one screen and not the other would make the
 * second one feel like a settings page rather than a way to connect.
 */
@Composable
private fun ColumnScope.TunnelPanel(
    app: JordanApplication,
    state: ServerListState,
    onConnect: (List<Server>, Boolean) -> Unit,
    onDisconnect: () -> Unit,
    onOpenConfigs: () -> Unit,
    onOpenPremium: () -> Unit,
) {
    val tunnelState by JordanVpnService.state.collectAsState()
    val tunnelError by JordanVpnService.lastError.collectAsState()
    val uptime by JordanVpnService.uptimeSeconds.collectAsState()
    val activity by JordanVpnService.activity.collectAsState()
    val activeServer by JordanVpnService.activeServer.collectAsState()
    val activeLabel by JordanVpnService.activeLabel.collectAsState()

    // What is left of the plan. Real figures or nothing: the line is drawn only
    // once the control plane has answered, and a failed call leaves the offer's
    // ordinary wording rather than a number nobody measured.
    var subscription by remember { mutableStateOf<ControlPlaneClient.Subscription?>(null) }
    LaunchedEffect(Unit) {
        // Only an account has a plan to report. Without one the card keeps the
        // plain offer, which is the truth for someone who has not bought yet.
        if (app.session.signedIn) {
            runCatching { app.api.subscription() }.onSuccess { subscription = it }
        }
    }

    val connected = tunnelState == JordanVpnService.State.CONNECTED
    val connecting = tunnelState == JordanVpnService.State.CONNECTING

    // In automatic mode the tunnel decides, so the screen follows it rather
    // than showing a choice nobody made.
    val current = if (state.automatic) {
        state.visible.firstOrNull { it.key == activeServer } ?: state.chosen
    } else {
        state.chosen
    }
    val selected = current?.profile

        // Above the switch: nothing of the app's own. The screen's spare height
        // collects here, which is where a banner goes.
        BannerSlot(Modifier.weight(1f))

        Box(Modifier.align(Alignment.CenterHorizontally)) {
            ConnectSwitch(
                state = tunnelState,
                enabled = state.visible.isNotEmpty() || connected || connecting,
                onToggle = {
                    if (connected || connecting) {
                        onDisconnect()
                    } else if (state.automatic) {
                        // Every server in the chosen country goes over — or all
                        // of them under Automatic. The tunnel measures them,
                        // decides, and falls back through the rest if the first
                        // one refuses.
                        if (state.pool.isNotEmpty()) onConnect(state.pool, true)
                    } else {
                        current?.let { onConnect(listOf(it), false) }
                    }
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
                JordanVpnService.State.CONNECTING -> Pending
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

        Spacer(Modifier.height(20.dp))

        // Two halves, and both of them go somewhere: the server in use opens
        // the config list, the line under it opens the plans. There are no
        // traffic counters here — the tunnel's ongoing notification carries
        // them, and this screen is for the one decision a person makes.
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(28.dp))
                .background(Surface)
                .border(1.dp, Border, RoundedCornerShape(28.dp)),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onOpenConfigs)
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        when {
                            state.automatic && connected && activeLabel != null -> activeLabel!!
                            state.automatic && current == null -> "Automatic"
                            else -> current?.label ?: "No server available"
                        },
                        color = Color.White,
                        fontWeight = FontWeight.Medium,
                        fontSize = 15.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        when {
                            activity != null -> activity!!
                            selected != null -> "${selected.host}:${selected.port}"
                            state.servers.isEmpty() -> "buy a plan to get one"
                            else -> "the tunnel will choose when you switch on"
                        },
                        color = TextDim,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    if (state.automatic) "AUTO" else "MANUAL",
                    color = if (state.automatic) Accent else TextFaint,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp,
                )
                Spacer(Modifier.width(8.dp))
                PathIcon(ICON_CHEVRON, 16.dp, TextFaint)
            }

            HorizontalDivider(color = Border, thickness = 1.dp)

            // The offer is what a plan actually buys: data, days, and a tunnel
            // that does not stop mid-month when the data runs out. It does not
            // claim a faster network, because every subscriber uses the same
            // gateways — that would be a promise the system cannot keep.
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onOpenPremium)
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    val plan = subscription
                    Text(
                        if (plan != null && plan.quotaBytes > 0) {
                            val left = plan.quotaBytes - plan.usedBytes.coerceAtMost(plan.quotaBytes)
                            "${formatBytes(left)} left · ${formatDaysLeft(plan.expiresAt) ?: plan.expiresAt.take(10)}"
                        } else {
                            "Want it faster and steadier?"
                        },
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        "More data, and no cut-off mid-month.",
                        color = TextDim,
                        fontSize = 12.sp,
                        maxLines = 2,
                    )
                }
                Spacer(Modifier.width(10.dp))
                Text(
                    "PLANS",
                    color = Accent,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp,
                )
                Spacer(Modifier.width(6.dp))
                PathIcon(ICON_CHEVRON, 16.dp, Accent)
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

}

@Composable
private fun VpnScreen(
    app: JordanApplication,
    state: ServerListState,
    onConnect: (List<Server>, Boolean) -> Unit,
    onDisconnect: () -> Unit,
    onOpenConfigs: () -> Unit,
    onOpenPremium: () -> Unit,
) {
    val tunnelState by JordanVpnService.state.collectAsState()
    val connected = tunnelState == JordanVpnService.State.CONNECTED
    val connecting = tunnelState == JordanVpnService.State.CONNECTING

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        TunnelPanel(app, state, onConnect, onDisconnect, onOpenConfigs, onOpenPremium)

        Spacer(Modifier.height(14.dp))

        // Countries, not configs. This is the screen for someone who has never
        // seen a `vless://` line and does not want to: the control plane's
        // region is an ISO code first, so a gateway can be placed, named and
        // flagged. One that cannot be placed is still offered — under "Other
        // servers", rather than under a flag the app made up.
        val groups = remember(state.visible) { groupByCountry(state.visible) }
        LazyColumn(
            modifier = Modifier.fillMaxWidth().height(CountryListHeight),
            verticalArrangement = Arrangement.spacedBy(CountryRowGap),
        ) {
            item {
                CountryRow(
                    emoji = null,
                    icon = ICON_GLOBE,
                    name = "Automatic",
                    detail = when {
                        state.visible.isEmpty() -> "no servers yet"
                        else -> "the fastest of ${state.visible.size} servers"
                    },
                    selected = state.country == null,
                    connected = connected && state.country == null,
                    onClick = {
                        state.useCountry(null)
                        if (connected || connecting) onConnect(state.visible, true)
                    },
                )
            }
            items(groups, key = { it.key }) { group ->
                val isSelected = state.country == group.key
                CountryRow(
                    emoji = group.country?.flag,
                    icon = if (group.country == null) ICON_SERVERS else null,
                    name = group.name,
                    detail = buildString {
                        append(if (group.servers.size == 1) "1 server" else "${group.servers.size} servers")
                        when (group.routeState) {
                            RouteState.DEGRADED -> append("  ·  degraded")
                            RouteState.UNVERIFIED -> append("  ·  unverified")
                            else -> Unit
                        }
                    },
                    selected = isSelected,
                    connected = connected && isSelected,
                    onClick = {
                        state.useCountry(group.key)
                        // Already up: move onto this country now rather than
                        // waiting for the next time someone flips the switch.
                        if (connected || connecting) onConnect(group.servers, true)
                    },
                )
            }
            if (groups.isEmpty()) {
                item {
                    Text(
                        state.status ?: "No servers yet. Buy a plan on the Premium tab.",
                        color = TextDim,
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
                    )
                }
            }
        }

        Spacer(Modifier.height(14.dp))
    }
}

/**
 * One country in the list: a flag in a circle, the country's name, and what is
 * behind it.
 *
 * The circle is the app's own, not an image: the flag is drawn as regional
 * indicator letters, which every phone already has, so the list needs no assets
 * and cannot ship a flag for a place the operator never claimed.
 */
@Composable
private fun CountryRow(
    emoji: String?,
    icon: String?,
    name: String,
    detail: String,
    selected: Boolean,
    connected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(60.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(if (selected) SurfaceHigh else Surface)
            .border(
                1.dp,
                if (selected) Accent.copy(alpha = 0.45f) else Border,
                RoundedCornerShape(20.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(SurfaceHigh)
                .border(1.dp, Border, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            when {
                emoji != null -> Text(emoji, fontSize = 19.sp)
                icon != null -> PathIcon(icon, 18.dp, TextDim)
                else -> Text(name.take(1).uppercase(), color = TextDim, fontSize = 14.sp)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                name,
                color = Color.White,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(detail, color = TextDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (selected) {
            Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(if (connected) Ok else Pending),
            )
        }
    }
}

/**
 * The configs: every server the subscription offers, and what to do with them.
 *
 * It is a separate tab from the switch because the two are different jobs — one
 * is "give me a connection", the other is "let me see and handle the servers" —
 * but it is not a dead end: selecting a row while the tunnel is up moves the
 * tunnel onto that server there and then, rather than waiting for a trip back.
 */
// PullToRefreshBox is still experimental in Material3.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConfigsScreen(
    app: JordanApplication,
    state: ServerListState,
    onConnect: (List<Server>, Boolean) -> Unit,
    onDisconnect: () -> Unit,
    onOpenPremium: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val tunnelState by JordanVpnService.state.collectAsState()
    val activeServer by JordanVpnService.activeServer.collectAsState()

    val connected = tunnelState == JordanVpnService.State.CONNECTED
    val connecting = tunnelState == JordanVpnService.State.CONNECTING
    val current = if (state.automatic) {
        state.visible.firstOrNull { it.key == activeServer } ?: state.chosen
    } else {
        state.chosen
    }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        TunnelPanel(app, state, onConnect, onDisconnect, onOpenConfigs = {}, onOpenPremium = onOpenPremium)

        Spacer(Modifier.height(14.dp))

        // Three rows, ending on a whole one, and the rest scrolls. Pulling it
        // down refreshes it, which is the gesture people already reach for.
        PullToRefreshBox(
            isRefreshing = state.busy,
            onRefresh = { scope.launch { state.refresh(app.subscriptions) } },
            modifier = Modifier.fillMaxWidth().height(ConfigListHeight),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(ConfigRowGap),
            ) {
                if (state.visible.isEmpty()) {
                    item {
                        Column(
                            Modifier.fillMaxWidth().padding(vertical = 24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                when {
                                    state.servers.isNotEmpty() -> "Every server is hidden."
                                    else -> state.status
                                        ?: "No configs yet. Buy a plan on the Premium tab."
                                },
                                color = TextDim,
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                            )
                            if (state.servers.isNotEmpty()) {
                                TextButton(onClick = { state.unhideAll() }) {
                                    Text("Show them again", color = Accent, fontSize = 13.sp)
                                }
                            }
                        }
                    }
                } else {
                    items(state.visible, key = { "${it.key}:${it.profile.uuid}" }) { server ->
                        val profile = server.profile
                        val isSelected = server.key == current?.key
                        ConfigRow(
                            server = server,
                            selected = isSelected,
                            connected = connected,
                            onSelect = {
                                // Choosing a row by hand is a statement:
                                // automatic mode ends here rather than quietly
                                // overriding the choice on the next connection.
                                state.useAutomatic(false)
                                if (!isSelected) {
                                    state.chosen = server
                                    // Switching server while connected
                                    // re-establishes the tunnel on the new one
                                    // rather than silently keeping traffic on
                                    // the old.
                                    if (connected || connecting) onConnect(listOf(server), false)
                                }
                            },
                            onCopy = {
                                clipboard.setText(AnnotatedString(profile.uri))
                                state.status = "Config copied"
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
                            onHide = { state.hide(server) },
                        )
                    }
                    if (state.status != null) {
                        item {
                            Text(
                                state.status!!,
                                color = TextDim,
                                fontSize = 12.sp,
                                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(14.dp))
    }
}


@Composable
private fun PremiumScreen(
    app: JordanApplication,
    signedIn: Boolean,
    onOpenStore: () -> Unit,
    onNeedsAccount: () -> Unit,
) {
    val scope = rememberCoroutineScope()

    var shopConfig by remember { mutableStateOf<ControlPlaneClient.ShopConfig?>(null) }
    var plans by remember { mutableStateOf<List<ControlPlaneClient.Plan>>(emptyList()) }
    var order by remember { mutableStateOf<ControlPlaneClient.Order?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busyPlan by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(signedIn) {
        // Plans and payment settings are public; an open order belongs to an
        // account, so it is only asked for when there is one.
        runCatching {
            shopConfig = app.api.shopConfig()
            plans = app.api.plans()
        }.onFailure { error = it.message }
        if (signedIn) {
            runCatching { order = app.api.openOrder() }.onFailure { error = it.message }
        }
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
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 20.dp),
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
                    signedIn = signedIn,
                    onBuy = {
                        if (!BuildConfig.IN_APP_ORDERS) {
                            onOpenStore()
                            return@PlanCard
                        }
                        // The one moment an account is actually needed: an order
                        // has to belong to someone.
                        if (!signedIn) {
                            onNeedsAccount()
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
    signedIn: Boolean,
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
            // Signed out the button still works: it asks for the account first.
            enabled = ((canOrder || !signedIn) && !busy) || !BuildConfig.IN_APP_ORDERS,
            colors = ButtonDefaults.buttonColors(containerColor = Accent, disabledContainerColor = Border),
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) {
            Text(
                when {
                    !BuildConfig.IN_APP_ORDERS -> "Buy on the website"
                    busy -> "Opening order…"
                    !signedIn -> "Buy with USDT"
                    canOrder -> "Buy with USDT"
                    else -> "Payments unavailable"
                },
                fontWeight = FontWeight.SemiBold,
                color = if (canOrder || !signedIn || !BuildConfig.IN_APP_ORDERS) OnAccent else TextFaint,
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
        "pending", "paid" -> Pending
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
            .background(SurfaceHigh)
            .border(1.dp, Border, RoundedCornerShape(24.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
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
    val runtimeVersion by JordanVpnService.runtimeVersion.collectAsState()

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
        appendLine("Core ${runtimeVersion ?: "not started yet"}")
        tunnelError?.let { appendLine("Last error $it") }
    }.trim()

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 20.dp),
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
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 20.dp),
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

/**
 * Sign in, or create the account.
 *
 * Registration is here rather than web-only because the first thing a new
 * customer does is install the app; sending them to a browser to type the same
 * two fields loses people. The API returns a session from either endpoint, so
 * the screen is the same form with a different verb.
 */
@Composable
private fun SignInScreen(
    app: JordanApplication,
    expired: Boolean,
    startCreating: Boolean = false,
    onSignedIn: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf(app.session.email ?: "") }
    var password by remember { mutableStateOf("") }
    var reveal by remember { mutableStateOf(false) }
    var creating by remember(startCreating) { mutableStateOf(startCreating) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    val canSubmit = email.contains('@') && password.length >= 8 && !busy

    fun submit() {
        if (!canSubmit) return
        scope.launch {
            busy = true
            error = null
            val address = email.trim()
            runCatching {
                if (creating) app.api.register(address, password) else app.api.signIn(address, password)
            }
                .onSuccess { onSignedIn() }
                .onFailure { error = it.message }
            busy = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Background)
            .verticalScroll(rememberScrollState())
            // The keyboard must not cover the button that submits the form.
            .imePadding()
            .padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("JORDAN", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp)
        Text(
            if (creating) "Create an account" else "Sign in with your account",
            color = TextDim,
            fontSize = 13.sp,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            "An account is only needed to buy a plan and to carry it between " +
                "devices. The tunnel itself does not ask for one.",
            color = TextFaint,
            fontSize = 12.sp,
            lineHeight = 17.sp,
        )
        if (expired && !creating) {
            Spacer(Modifier.height(10.dp))
            Text("Your session ended. Sign in again.", color = Pending, fontSize = 13.sp)
        }
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Next,
            ),
            colors = fieldColors(),
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            // Without this the password stands on screen in clear text — in a
            // café, on a bus, over someone's shoulder.
            visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            trailingIcon = {
                TextButton(onClick = { reveal = !reveal }) {
                    Text(if (reveal) "Hide" else "Show", color = TextDim, fontSize = 12.sp)
                }
            },
            colors = fieldColors(),
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        if (creating) {
            Spacer(Modifier.height(6.dp))
            Text("At least 8 characters.", color = TextFaint, fontSize = 11.sp)
        }
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { submit() },
            enabled = canSubmit,
            colors = ButtonDefaults.buttonColors(
                containerColor = Accent,
                contentColor = OnAccent,
                disabledContainerColor = Border,
                disabledContentColor = TextFaint,
            ),
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text(
                when {
                    busy && creating -> "Creating…"
                    busy -> "Signing in…"
                    creating -> "Create account"
                    else -> "Sign in"
                },
                fontWeight = FontWeight.SemiBold,
            )
        }
        TextButton(onClick = { creating = !creating; error = null }) {
            Text(
                if (creating) "I already have an account" else "Create an account",
                color = Accent,
                fontSize = 13.sp,
            )
        }
        error?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, color = Bad, fontSize = 13.sp)
        }
        Text(
            "An account on its own carries no data — a plan is bought on the Premium tab.",
            color = TextFaint,
            fontSize = 11.sp,
            modifier = Modifier.padding(top = 14.dp),
        )
    }
}

/** One field style for the whole app, in the app's own colours. */
@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Accent,
    unfocusedBorderColor = Border,
    focusedLabelColor = Accent,
    unfocusedLabelColor = TextDim,
    focusedTextColor = Color.White,
    unfocusedTextColor = Color.White,
    cursorColor = Accent,
)
