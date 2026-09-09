package net.jordanvpn.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Thin client for the Jordan storefront API (`/api/v1/shop/...`): sign in, the
 * customer's subscription, the plans on sale and the USDT orders that pay for
 * them.
 *
 * Deliberately built on HttpURLConnection: the app should stay small, and the
 * whole surface is a handful of endpoints returning `{ data }`.
 */
class ControlPlaneClient(
    private val baseUrl: String,
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
    )

    data class Plan(
        val id: String,
        val name: String,
        val description: String?,
        val quotaBytes: Long,
        val durationDays: Int,
        val priceMicro: Long,
    )

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
        val payment = data["payment"]?.jsonObject
        ShopConfig(
            paymentsConfigured = payment?.get("configured")?.jsonPrimitive?.content.toBoolean(),
            payAddress = payment?.get("address")?.jsonPrimitive?.contentOrNullSafe(),
            chain = payment?.get("chain")?.jsonPrimitive?.content ?: "tron",
            asset = payment?.get("asset")?.jsonPrimitive?.content ?: "USDT-TRC20",
            contract = payment?.get("contract")?.jsonPrimitive?.contentOrNullSafe(),
            confirmations = payment?.get("confirmations")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            windowMinutes = payment?.get("windowMinutes")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            supportContact = data["supportContact"]?.jsonPrimitive?.contentOrNullSafe(),
        )
    }

    suspend fun plans(): List<Plan> = withContext(Dispatchers.IO) {
        requestArray("GET", "/api/v1/shop/plans", null, authenticated = false).map { element ->
            val plan = element.jsonObject
            Plan(
                id = plan["id"]!!.jsonPrimitive.content,
                name = plan["name"]!!.jsonPrimitive.content,
                description = plan["description"]?.jsonPrimitive?.contentOrNullSafe(),
                quotaBytes = plan["quotaBytes"]!!.jsonPrimitive.content.toLong(),
                durationDays = plan["durationDays"]!!.jsonPrimitive.content.toInt(),
                priceMicro = plan["priceMicro"]!!.jsonPrimitive.content.toLong(),
            )
        }
    }

    suspend fun createOrder(planId: String): Order = withContext(Dispatchers.IO) {
        orderOf(request("POST", "/api/v1/shop/orders", "{\"planId\":" + quote(planId) + "}"))
    }

    suspend fun order(id: String): Order = withContext(Dispatchers.IO) {
        orderOf(request("GET", "/api/v1/shop/orders/" + encode(id), null))
    }

    /** The order the customer still has to pay, if there is one. */
    suspend fun openOrder(): Order? = withContext(Dispatchers.IO) {
        requestArray("GET", "/api/v1/shop/orders", null)
            .map { orderOf(it.jsonObject) }
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

    suspend fun signIn(email: String, password: String): String =
        authenticate("/api/v1/shop/login", email, password)

    /** Creates the account and signs it in; the API returns a session either way. */
    suspend fun register(email: String, password: String): String =
        authenticate("/api/v1/shop/register", email, password)

    private suspend fun authenticate(path: String, email: String, password: String): String =
        withContext(Dispatchers.IO) {
            val body = buildString {
                append("{\"email\":").append(quote(email))
                append(",\"password\":").append(quote(password)).append('}')
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
        val sub = me["subscription"]?.jsonObject ?: return@withContext null
        val profiles = sub["profiles"]?.jsonArray
            ?.map { it.jsonObject["uri"]!!.jsonPrimitive.content }
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
     * Jordan's own endpoint answers `?format=json` with the route state of each
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

    private fun withFormatJson(url: String) =
        if ('?' in url) "$url&format=json" else "$url?format=json"

    private fun fetchSubscription(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("User-Agent", "JordanVPN-Android/0.1")
        }
        connection.use {
            if (it.responseCode !in 200..299) {
                throw ApiException(it.responseCode, "SUBSCRIPTION", "Subscription unavailable")
            }
            return it.inputStream.bufferedReader().readText().trim()
        }
    }

    private fun parseJsonSubscription(text: String): List<SubscriptionServer>? {
        val profiles = runCatching {
            json.parseToJsonElement(text).jsonObject["data"]?.jsonObject?.get("profiles")?.jsonArray
        }.getOrNull() ?: return null
        val servers = profiles.mapNotNull { element ->
            val profile = element.jsonObject
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
            .filter { it.startsWith("vless://") }
            .map { SubscriptionServer(uri = it, routeState = null, gatewayName = null, region = null) }
        return servers.ifEmpty { null }
    }

    /** `{ data: {...} }` responses. */
    private fun request(
        method: String,
        path: String,
        body: String?,
        authenticated: Boolean = true,
    ): JsonObject = send(method, path, body, authenticated).jsonObject

    /** `{ data: [...] }` responses — plans and orders come back as lists. */
    private fun requestArray(
        method: String,
        path: String,
        body: String?,
        authenticated: Boolean = true,
    ): List<kotlinx.serialization.json.JsonElement> =
        send(method, path, body, authenticated).jsonArray

    private fun send(
        method: String,
        path: String,
        body: String?,
        authenticated: Boolean,
    ): kotlinx.serialization.json.JsonElement {
        val connection = (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("User-Agent", "JordanVPN-Android/0.1")
            if (authenticated) session.token?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) doOutput = true
        }
        connection.use {
            if (body != null) it.outputStream.write(body.toByteArray())
            val status = it.responseCode
            val text = (if (status in 200..299) it.inputStream else it.errorStream)
                ?.bufferedReader()?.readText().orEmpty()
            val payload = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            if (status == 401 && authenticated) {
                session.token = null
                expired.value = true
                throw ApiException(401, "UNAUTHORIZED", "Please sign in again")
            }
            if (status !in 200..299) {
                val error = payload?.get("error")?.jsonObject
                throw ApiException(
                    status,
                    error?.get("code")?.jsonPrimitive?.content ?: "ERROR",
                    error?.get("message")?.jsonPrimitive?.content ?: "Request failed ($status)",
                )
            }
            return payload?.get("data")
                ?: throw ApiException(status, "MALFORMED", "Unexpected response")
        }
    }

    private fun quote(value: String) = json.encodeToString(kotlinx.serialization.builtins.serializer(), value)

    private inline fun <T> HttpURLConnection.use(block: (HttpURLConnection) -> T): T =
        try { block(this) } finally { disconnect() }

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
        if (this is kotlinx.serialization.json.JsonNull) null else content
}
