package net.jordanvpn.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import net.jordanvpn.app.JordanApp as JordanApplication
import net.jordanvpn.app.core.VlessProfile
import net.jordanvpn.app.core.XrayConfigBuilder
import net.jordanvpn.app.vpn.JordanVpnService

private val Background = Color(0xFF0A0C0F)
private val Surface = Color(0xFF12161C)
private val Accent = Color(0xFFC8F24A)
private val TextDim = Color(0xFF98A3B2)

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

/**
 * The connect screen.
 *
 * It shows the state the tunnel is actually in. There is no optimistic
 * "connected" while the bridge is not wired: the error is surfaced instead.
 */
@Composable
fun JordanRoot(
    app: JordanApplication,
    onConnect: (String) -> Unit,
    onDisconnect: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val tunnelState by JordanVpnService.state.collectAsState()
    val tunnelError by JordanVpnService.lastError.collectAsState()

    var email by remember { mutableStateOf(app.session.email ?: "") }
    var password by remember { mutableStateOf("") }
    var signedIn by remember { mutableStateOf(app.session.token != null) }
    var profiles by remember { mutableStateOf<List<VlessProfile>>(emptyList()) }
    var selected by remember { mutableStateOf<VlessProfile?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun refresh() {
        scope.launch {
            busy = true
            runCatching { app.subscriptions.load(app.session) }
                .onSuccess { result ->
                    profiles = result.profiles
                    selected = result.profiles.firstOrNull()
                    status = result.error ?: if (result.stale) "Showing the last known servers" else null
                }
                .onFailure { status = it.message }
            busy = false
        }
    }

    LaunchedEffect(signedIn) { if (signedIn) refresh() }

    Scaffold(containerColor = Background) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("JORDAN", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)

            if (!signedIn) {
                OutlinedTextField(
                    value = email, onValueChange = { email = it },
                    label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password, onValueChange = { password = it },
                    label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        scope.launch {
                            busy = true
                            runCatching { app.api.signIn(email.trim(), password) }
                                .onSuccess { signedIn = true; status = null }
                                .onFailure { status = it.message }
                            busy = false
                        }
                    },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) { Text("Sign in") }
                status?.let { Text(it, color = Color(0xFFF2665F), fontSize = 13.sp) }
                Text(
                    "Buy a plan on the website; this app connects with the subscription on your account.",
                    color = TextDim, fontSize = 12.sp,
                )
                return@Column
            }

            Spacer(Modifier.height(12.dp))

            val connected = tunnelState == JordanVpnService.State.CONNECTED
            val connecting = tunnelState == JordanVpnService.State.CONNECTING
            Box(
                modifier = Modifier
                    .size(160.dp)
                    .background(if (connected) Accent.copy(alpha = 0.15f) else Surface, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                IconButton(
                    onClick = {
                        val profile = selected
                        if (connected) onDisconnect()
                        else if (profile != null) {
                            onConnect(
                                XrayConfigBuilder.build(
                                    profile,
                                    app.session.subscriptionUrl?.let { runCatching { java.net.URL(it).host }.getOrNull() },
                                ),
                            )
                        }
                    },
                    enabled = selected != null || connected,
                    modifier = Modifier.size(96.dp),
                ) {
                    Text(
                        if (connected) "STOP" else "START",
                        color = if (connected) Accent else Color.White,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }

            Text(
                when (tunnelState) {
                    JordanVpnService.State.CONNECTED -> "CONNECTED"
                    JordanVpnService.State.CONNECTING -> "CONNECTING…"
                    JordanVpnService.State.FAILED -> "NOT CONNECTED"
                    else -> "NOT CONNECTED"
                },
                color = if (connected) Accent else TextDim,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
            )

            if (tunnelError != null && !connected && !connecting) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF2C1516)),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        tunnelError!!,
                        color = Color(0xFFF2665F),
                        fontSize = 12.sp,
                        modifier = Modifier.padding(14.dp),
                    )
                }
            }

            Card(
                colors = CardDefaults.cardColors(containerColor = Surface),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Active configuration", color = TextDim, fontSize = 12.sp)
                    Text(selected?.label ?: "No server available", color = Color.White, fontWeight = FontWeight.Medium)
                    selected?.let {
                        Text("${it.host}:${it.port}", color = TextDim, fontSize = 12.sp)
                    }
                    if (profiles.size > 1) {
                        Text("${profiles.size} servers in your subscription", color = TextDim, fontSize = 12.sp)
                    }
                }
            }

            status?.let { Text(it, color = TextDim, fontSize = 12.sp) }

            TextButton(onClick = { refresh() }, enabled = !busy) { Text("Refresh servers") }
            TextButton(onClick = {
                scope.launch { app.api.signOut(); signedIn = false; profiles = emptyList() }
            }) { Text("Sign out", color = TextDim) }
        }
    }
}
