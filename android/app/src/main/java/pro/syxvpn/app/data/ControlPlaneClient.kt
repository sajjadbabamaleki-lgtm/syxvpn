package pro.syxvpn.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import pro.syxvpn.app.core.ControlPlaneEndpoints
import pro.syxvpn.app.core.TunnelProfile
import pro.syxvpn.app.core.XrayConfigBuilder
import java.io.IOException

/**
 * Thin client for the cVPN storefront API (`/api/v1/shop/...`): sign in, the
 * customer's subscription, the plans on sale and the USDT orders that pay for
 * them.
 *
 * Built on the platform's own client: the app should stay small, and the whole
 * surface is a handful of endpoints returning `{ data }`. It reaches them
 * through Transport, which adds exactly one thing — a second attempt over
 * DNS-over-HTTPS when the phone cannot resolve the host at all.
 */
class ControlPlaneClient(
    private val endpoints: ControlPlaneEndpoints,
    private val session: SessionStore,
) {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Flips when the control plane rejects the stored session (401).
     *
     * The token is cleared at the same moment, so without this the app would sit
     * on a signed-in-looking screen failing every call. The UI watches it and
     * goes back to the sign-in screen.
     */
    private val expired = MutableStateFlow(false)
    val sessionExpired: StateFlow<Boolean> get() = expired

    class ApiException(val status: Int, val code: String, message: String) : IOException(message)

    data class Subscription(
        val active: Boolean,
        val state: String,
        val usedBytes: Long,
        val quotaBytes: Long,
        val expiresAt: String,
        val subscriptionUrl: String?,
        val profiles: List<String>,
    )

    /** What the deployment sells and how it takes payment. Public: no session. */
    data class ShopConfig(
        val paymentsConfigured: Boolean,
        val payAddress: String?,
        val chain: String,
        val asset: String,
        /** TRC-20 contract of the asset, for the wallet deep link. */
        val contract: String?,
        val confirmations: Int,
        val windowMinutes: Int,
        val supportContact: String?,
        /**
         * Whether this deployment can send the six-digit code at all.
         *
         * False when no mail relay is configured, and then the sign-in screen
         * must not ask for a code: the control plane skips the check in that
         * state, and a screen that asked anyway would be a field nobody can
         * fill standing between every customer and their account.
         */
        val emailCodes: Boolean,
    )

    data class Plan(
        val id: String,
        val name: String,
        val description: String?,
        val quotaBytes: Long,
        val durationDays: Int,
        val priceMicro: Long,
        /**
         * Which of the two things this plan buys: "vpn", the managed servers
         * behind the switch, or "configs", the list to use here or carry to
         * another client. They are sold separately and the Premium tab shows
         * one at a time, so a card can never be ambiguous about what it is.
         *
         * Anything else — "all", from before the split — reads as vpn, which is
         * the side that grant already covers.
         */
        val product: String,
        /** "duration", sold by time, or "volume", sold by the gigabyte. */
        val billing: String,
    ) {
        val isConfigs: Boolean get() = product == "configs"
    }

    /**
     * An order. Amounts stay in micro-USDT (1 USDT = 1_000_000) — the same
     * integer precision as TRC-20 USDT on chain, so the amount the app shows is
     * exactly the amount the watcher matches against.
     */
    data class Order(
        val id: String,
        val planName: String,
        val status: String,
        val quotaBytes: Long,
        val durationDays: Int,
        val payAmountMicro: Long,
        val payAddress: String?,
        val chain: String?,
        val asset: String?,
        val confirmations: Int,
        val txHash: String?,
        val expiresAt: String,
    )

    suspend fun shopConfig(): ShopConfig = withContext(Dispatchers.IO) {
        val data = request("GET", "/api/v1/shop/config", null, authenticated = false)
        val payment = data["payment"].objectOrNull
        ShopConfig(
            paymentsConfigured = payment?.get("configured")?.jsonPrimitive?.content.toBoolean(),
            payAddress = payment?.get("address")?.jsonPrimitive?.contentOrNullSafe(),
            chain = payment?.get("chain")?.jsonPrimitive?.content ?: "tron",
            asset = payment?.get("asset")?.jsonPrimitive?.content ?: "USDT-TRC20",
            contract = payment?.get("contract")?.jsonPrimitive?.contentOrNullSafe(),
            confirmations = payment?.get("confirmations")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            windowMinutes = payment?.get("windowMinutes")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            supportContact = data["supportContact"]?.jsonPrimitive?.contentOrNullSafe(),
            emailCodes = data["emailCodes"]?.jsonPrimitive?.content.toBoolean(),
        )
    }

    suspend fun plans(): List<Plan> = withContext(Dispatchers.IO) {
        requestArray("GET", "/api/v1/shop/plans", null, authenticated = false).mapNotNull { element ->
            val plan = element.objectOrNull ?: return@mapNotNull null
            Plan(
                id = plan["id"]!!.jsonPrimitive.content,
                name = plan["name"]!!.jsonPrimitive.content,
                description = plan["description"]?.jsonPrimitive?.contentOrNullSafe(),
                quotaBytes = plan["quotaBytes"]!!.jsonPrimitive.content.toLong(),
                durationDays = plan["durationDays"]!!.jsonPrimitive.content.toInt(),
                priceMicro = plan["priceMicro"]!!.jsonPrimitive.content.toLong(),
                product = plan["product"]?.jsonPrimitive?.contentOrNullSafe() ?: "vpn",
                billing = plan["billing"]?.jsonPrimitive?.contentOrNullSafe() ?: "duration",
            )
        }
    }

    /**
     * Open an order.
     *
     * `units` is how many of the plan to buy at once, and only a plan sold by
     * the gigabyte has a unit to multiply. The price is the published plan's,
     * multiplied by the control plane rather than by this app: what the app
     * shows while someone is picking a size is an estimate of the same sum, and
     * the amount that has to be paid is the one the order comes back with.
     */
    suspend fun createOrder(planId: String, units: Int = 1): Order = withContext(Dispatchers.IO) {
        orderOf(
            request(
                "POST",
                "/api/v1/shop/orders",
                "{\"planId\":" + quote(planId) + ",\"units\":" + units + "}",
            ),
        )
    }

    suspend fun order(id: String): Order = withContext(Dispatchers.IO) {
        orderOf(request("GET", "/api/v1/shop/orders/" + encode(id), null))
    }

    /** The order the customer still has to pay, if there is one. */
    suspend fun openOrder(): Order? = withContext(Dispatchers.IO) {
        requestArray("GET", "/api/v1/shop/orders", null)
            .mapNotNull { it.objectOrNull?.let(::orderOf) }
            .firstOrNull { it.status == "pending" || it.status == "paid" }
    }

    suspend fun cancelOrder(id: String) = withContext(Dispatchers.IO) {
        request("POST", "/api/v1/shop/orders/" + encode(id) + "/cancel", "{}")
        Unit
    }

    private fun orderOf(order: JsonObject) = Order(
        id = order["id"]!!.jsonPrimitive.content,
        planName = order["planName"]!!.jsonPrimitive.content,
        status = order["status"]!!.jsonPrimitive.content,
        quotaBytes = order["quotaBytes"]!!.jsonPrimitive.content.toLong(),
        durationDays = order["durationDays"]!!.jsonPrimitive.content.toInt(),
        payAmountMicro = order["payAmountMicro"]!!.jsonPrimitive.content.toLong(),
        payAddress = order["payAddress"]?.jsonPrimitive?.contentOrNullSafe(),
        chain = order["chain"]?.jsonPrimitive?.contentOrNullSafe(),
        asset = order["asset"]?.jsonPrimitive?.contentOrNullSafe(),
        confirmations = order["confirmations"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        txHash = order["txHash"]?.jsonPrimitive?.contentOrNullSafe(),
        expiresAt = order["expiresAt"]!!.jsonPrimitive.content,
    )

    private fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8")

    /**
     * Asks the control plane to send the six-digit code to an address.
     *
     * It says nothing about whether the address has an account — the reply is
     * the same either way, deliberately — only whether the message went.
     */
    suspend fun sendCode(email: String) = withContext(Dispatchers.IO) {
        val body = buildString { append("{\"email\":").append(quote(email)).append('}') }
        request("POST", "/api/v1/shop/auth/code", body, authenticated = false)
        Unit
    }

    /**
     * One call for both ways in.
     *
     * Whether this address is new is the control plane's to work out, and the
     * code is what makes working it out safe. Two calls — sign in, and register
     * when that failed — would spend the code on the first of them.
     *
     * The code is omitted where the deployment has no relay to send one with.
     * The control plane skips the check in exactly that state, so this is the
     * same one call either way rather than a second way in.
     */
    suspend fun authenticate(email: String, password: String, code: String? = null): String =
        authenticate("/api/v1/shop/auth/session", email, password, code)

    suspend fun signIn(email: String, password: String): String =
        authenticate("/api/v1/shop/login", email, password, null)

    /** Creates the account and signs it in; the API returns a session either way. */
    suspend fun register(email: String, password: String): String =
        authenticate("/api/v1/shop/register", email, password, null)

    private suspend fun authenticate(
        path: String,
        email: String,
        password: String,
        code: String?,
    ): String =
        withContext(Dispatchers.IO) {
            val body = buildString {
                append("{\"email\":").append(quote(email))
                append(",\"password\":").append(quote(password))
                if (code != null) append(",\"code\":").append(quote(code))
                append('}')
            }
            val response = request("POST", path, body, authenticated = false)
            val token = response["token"]!!.jsonPrimitive.content
            session.token = token
            session.email = email
            expired.value = false
            token
        }

    suspend fun signOut() = withContext(Dispatchers.IO) {
        runCatching { request("POST", "/api/v1/shop/logout", "{}") }
        session.clear()
    }

    /** The customer's subscription, or null when they have not bought one yet. */
    suspend fun subscription(): Subscription? = withContext(Dispatchers.IO) {
        val me = request("GET", "/api/v1/shop/me", null)
        // An account with no plan comes back as `"subscription": null`, which is
        // an element rather than a missing key — so this is a type check, not a
        // null check, and `?.jsonObject` here threw instead of returning null.
        val sub = me["subscription"].objectOrNull ?: return@withContext null
        val profiles = sub["profiles"].arrayOrNull
            ?.mapNotNull { it.objectOrNull?.get("uri")?.jsonPrimitive?.contentOrNullSafe() }
            .orEmpty()
        Subscription(
            active = sub["active"]!!.jsonPrimitive.content.toBoolean(),
            state = sub["state"]!!.jsonPrimitive.content,
            usedBytes = sub["usedBytes"]!!.jsonPrimitive.content.toLong(),
            quotaBytes = sub["quotaBytes"]!!.jsonPrimitive.content.toLong(),
            expiresAt = sub["expiresAt"]!!.jsonPrimitive.content,
            subscriptionUrl = sub["subscriptionUrl"]?.jsonPrimitive?.contentOrNullSafe(),
            profiles = profiles,
        ).also {
            session.subscriptionUrl = it.subscriptionUrl
            session.cachedProfiles = it.profiles.joinToString("\n")
        }
    }

    /**
     * One gateway as the subscription describes it.
     *
     * `routeState` is the control plane's verdict on the whole path — ingress
     * and egress — which is the half the phone cannot measure for itself.
     */
    data class SubscriptionServer(
        val uri: String,
        val routeState: String?,
        val gatewayName: String?,
        val region: String?,
    )

    /**
     * Fetches the subscription itself, which is the same source every other
     * Xray client consumes, so the app picks up a gateway change or a failover
     * without going through the account API.
     *
     * cVPN's own endpoint answers `?format=json` with the route state of each
     * gateway. A subscription hosted anywhere else answers with the ordinary
     * base64 list, and that is the fallback: the servers are still usable, the
     * app just knows less about them.
     */
    suspend fun refreshProfiles(subscriptionUrl: String): List<SubscriptionServer> =
        withContext(Dispatchers.IO) {
            val text = fetchSubscription(withFormatJson(subscriptionUrl))
            val servers = parseJsonSubscription(text) ?: parseBase64Subscription(text)
                ?: parseBase64Subscription(fetchSubscription(subscriptionUrl))
                ?: throw ApiException(502, "SUBSCRIPTION", "The subscription returned nothing usable")
            session.cachedProfiles = servers.joinToString("\n") { it.uri }
            servers
        }

    /**
     * Asks for JSON, and says which protocols this build can actually dial.
     *
     * The protocol list is the whole of the compatibility contract in the other
     * direction: a control plane that knows about these answers with them, one
     * that does not ignores an unknown query parameter, and a *client* that
     * never asks — every version of this app already on a phone — keeps being
     * answered with vless alone. Nobody is handed a line they cannot use.
     */
    private fun withFormatJson(url: String): String {
        val query = "format=json&protocols=" + XrayConfigBuilder.PROTOCOLS.joinToString(",")
        return if ('?' in url) "$url&$query" else "$url?$query"
    }

    private fun fetchSubscription(url: String): String {
        // The link is absolute and carries whichever address issued it. Every
        // address serves the same path, so a link made when one was reachable
        // is still good through another.
        val reply = overAnyAddress(headers = mapOf("User-Agent" to USER_AGENT)) { base ->
            endpoints.rebase(url, base)
        }
        if (reply.status !in 200..299) {
            throw ApiException(reply.status, "SUBSCRIPTION", "Subscription unavailable")
        }
        return reply.body.trim()
    }

    private fun parseJsonSubscription(text: String): List<SubscriptionServer>? {
        val profiles = runCatching {
            json.parseToJsonElement(text).objectOrNull?.get("data").objectOrNull?.get("profiles").arrayOrNull
        }.getOrNull() ?: return null
        val servers = profiles.mapNotNull { element ->
            val profile = element.objectOrNull ?: return@mapNotNull null
            val uri = profile["uri"]?.jsonPrimitive?.contentOrNullSafe() ?: return@mapNotNull null
            SubscriptionServer(
                uri = uri,
                routeState = profile["routeState"]?.jsonPrimitive?.contentOrNullSafe(),
                gatewayName = profile["gatewayName"]?.jsonPrimitive?.contentOrNullSafe(),
                region = profile["region"]?.jsonPrimitive?.contentOrNullSafe(),
            )
        }
        return servers.ifEmpty { null }
    }

    private fun parseBase64Subscription(text: String): List<SubscriptionServer>? {
        val decoded = runCatching {
            String(android.util.Base64.decode(text, android.util.Base64.DEFAULT))
        }.getOrElse { text }
        val servers = decoded.lines().map(String::trim)
            // Every scheme the app can dial. A filter that names one protocol
            // would throw away the other doors of a subscription served as a
            // plain list — the form used by every client that is not this one.
            .filter { TunnelProfile.looksLikeProfile(it) }
            .map { SubscriptionServer(uri = it, routeState = null, gatewayName = null, region = null) }
        return servers.ifEmpty { null }
    }

    /** `{ data: {...} }` responses. */
    private fun request(
        method: String,
        path: String,
        body: String?,
        authenticated: Boolean = true,
    ): JsonObject = send(method, path, body, authenticated).objectOrNull
        ?: throw ApiException(200, "MALFORMED", "Unexpected response")

    /** `{ data: [...] }` responses — plans and orders come back as lists. */
    private fun requestArray(
        method: String,
        path: String,
        body: String?,
        authenticated: Boolean = true,
    ): List<kotlinx.serialization.json.JsonElement> =
        send(method, path, body, authenticated).arrayOrNull
            ?: throw ApiException(200, "MALFORMED", "Unexpected response")

    private fun send(
        method: String,
        path: String,
        body: String?,
        authenticated: Boolean,
    ): kotlinx.serialization.json.JsonElement {
        // No account, no call. A fresh install has no token, and sending the
        // request anyway would come back 401 and be read as a session that
        // expired — telling someone who never had an account to sign in again.
        // Not signed in is a different thing from signed out by the server.
        if (authenticated && session.token == null) {
            throw ApiException(401, "NO_SESSION", "Not signed in")
        }
        val headers = buildMap {
            put("Content-Type", "application/json")
            put("User-Agent", USER_AGENT)
            if (authenticated) session.token?.let { put("Authorization", "Bearer $it") }
        }
        val reply = overAnyAddress(method, headers, body) { base -> base + path }
        val payload = runCatching { json.parseToJsonElement(reply.body).objectOrNull }.getOrNull()
        if (reply.status == 401 && authenticated) {
            session.token = null
            expired.value = true
            throw ApiException(401, "UNAUTHORIZED", "Please sign in again")
        }
        if (reply.status !in 200..299) {
            val error = payload?.get("error").objectOrNull
            throw ApiException(
                reply.status,
                error?.get("code")?.jsonPrimitive?.contentOrNullSafe() ?: "ERROR",
                error?.get("message")?.jsonPrimitive?.contentOrNullSafe()
                    ?: "Request failed (${reply.status})",
            )
        }
        return payload?.get("data")
            ?: throw ApiException(reply.status, "MALFORMED", "Unexpected response")
    }

    /** A JSON string literal, escaped by the library rather than by hand. */
    private fun quote(value: String) = JsonPrimitive(value).toString()

    /**
     * The platform's client, with DNS-over-HTTPS behind it.
     *
     * Every request goes out the ordinary way. Only a name the phone cannot
     * resolve — another VPN holding the resolver, an ISP answering "no such
     * host" for this domain — falls through to the resolver that does not need
     * the phone's, which is the difference between an app that says it cannot
     * reach its own control plane and one that reaches it.
     */
    private val transport: Transport =
        ResilientTransport(SystemTransport(), DohTransport(systemDohResolver()))

    /**
     * The same request against each address until one answers.
     *
     * Only a network failure moves to the next: an HTTP status is an answer,
     * and a 401 from the first address must not be retried as a 401 from all
     * of them. The address that answered is remembered, so a dead first entry
     * costs one failed connection rather than one on every request after it.
     */
    private fun overAnyAddress(
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: String? = null,
        url: (base: String) -> String,
    ): HttpReply {
        var last: IOException? = null
        for (base in endpoints.ordered()) {
            try {
                val reply = transport.exchange(method, url(base), headers, body)
                endpoints.worked(base)
                return reply
            } catch (unreachable: IOException) {
                endpoints.failed(base)
                last = unreachable
            }
        }
        throw last ?: IOException("no control plane address configured")
    }

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
        if (this is kotlinx.serialization.json.JsonNull) null else content

    /**
     * JSON `null` is an element, not the absence of one.
     *
     * `element?.jsonObject` reads like a null check and is not one: on a `null`
     * the safe call passes straight through and `jsonObject` throws
     * "JsonNull is not a JsonObject" — which is what an account with no
     * subscription showed instead of being told it had no subscription. These
     * two are total: a wrong type or a JSON null both give back Kotlin null.
     */
    private val JsonElement?.objectOrNull: JsonObject? get() = this as? JsonObject

    private val JsonElement?.arrayOrNull: JsonArray? get() = this as? JsonArray

    private companion object {
        const val USER_AGENT = "cVPNVPN-Android/0.1"
    }
}
