package net.jordanvpn.app.data

import kotlinx.coroutines.Dispatchers
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
 * Thin client for the Jordan storefront API (`/api/v1/shop/...`).
 *
 * Deliberately built on HttpURLConnection: the app should stay small, and the
 * whole surface is four endpoints.
 */
class ControlPlaneClient(
    private val baseUrl: String,
    private val session: SessionStore,
) {
    private val json = Json { ignoreUnknownKeys = true }

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

    suspend fun signIn(email: String, password: String): String = withContext(Dispatchers.IO) {
        val body = buildString {
            append("{\"email\":").append(quote(email))
            append(",\"password\":").append(quote(password)).append('}')
        }
        val response = request("POST", "/api/v1/shop/login", body, authenticated = false)
        val token = response["token"]!!.jsonPrimitive.content
        session.token = token
        session.email = email
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
     * Fetches the subscription URL itself. Used on reconnect so the app picks up
     * a gateway change without needing the account API — the same base64 list
     * every other Xray client consumes.
     */
    suspend fun refreshProfiles(subscriptionUrl: String): List<String> = withContext(Dispatchers.IO) {
        val connection = (URL(subscriptionUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("User-Agent", "JordanVPN-Android/0.1")
        }
        connection.use {
            if (it.responseCode !in 200..299) {
                throw ApiException(it.responseCode, "SUBSCRIPTION", "Subscription unavailable")
            }
            val body = it.inputStream.bufferedReader().readText().trim()
            val decoded = runCatching {
                String(android.util.Base64.decode(body, android.util.Base64.DEFAULT))
            }.getOrElse { body }
            decoded.lines().map(String::trim).filter { line -> line.startsWith("vless://") }
                .also { profiles -> session.cachedProfiles = profiles.joinToString("\n") }
        }
    }

    private fun request(
        method: String,
        path: String,
        body: String?,
        authenticated: Boolean = true,
    ): JsonObject {
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
            if (status == 401) {
                session.token = null
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
            return payload?.get("data")?.jsonObject
                ?: throw ApiException(status, "MALFORMED", "Unexpected response")
        }
    }

    private fun quote(value: String) = json.encodeToString(kotlinx.serialization.builtins.serializer(), value)

    private inline fun <T> HttpURLConnection.use(block: (HttpURLConnection) -> T): T =
        try { block(this) } finally { disconnect() }

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
        if (this is kotlinx.serialization.json.JsonNull) null else content
}
