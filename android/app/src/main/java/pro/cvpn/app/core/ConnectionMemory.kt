package pro.cvpn.app.core

import kotlin.math.abs

/**
 * What this phone has learned about each gateway, kept between sessions.
 *
 * Everything the tunnel decides in the moment comes from measurements taken in
 * the moment — but a gateway that refused to connect three times yesterday is a
 * fact worth carrying, and one that has never once failed is worth defending.
 * This is that memory, and it is the only part of selection that is not
 * recomputed from scratch on every connect.
 *
 * What is stored is deliberately thin: a `host:port`, counters, and timings.
 * No credential, no UUID, no profile line — nothing here would let anyone use
 * an account, and nothing here is ever logged.
 */
data class ServerStats(
    val key: String,
    val attempts: Int = 0,
    val successes: Int = 0,
    /** Failures since the last success. Reset by a success, not by time. */
    val consecutiveFailures: Int = 0,
    /** Smoothed round trip in milliseconds, or null when never measured. */
    val rttMs: Double? = null,
    /** Smoothed movement of that round trip: how steady the path has been. */
    val jitterMs: Double? = null,
    val lastSuccessAt: Long = 0L,
    val lastFailureAt: Long = 0L,
    /** When this entry was last touched, so the oldest can be dropped first. */
    val updatedAt: Long = 0L,
) {

    /**
     * How often connecting has worked, smoothed so that one attempt does not
     * read as certainty: a gateway with 1/1 is not proven better than one with
     * 40/45. Consecutive failures then divide it, because a gateway failing
     * *now* matters more than its record from a month ago.
     */
    val reliability: Double
        get() = ((successes + 1.0) / (attempts + 2.0)) / (1.0 + consecutiveFailures)

    /** A new round-trip sample, folded in. */
    fun withSample(sampleMs: Long, now: Long): ServerStats {
        val previous = rttMs
        val mean = if (previous == null) sampleMs.toDouble() else previous + ALPHA * (sampleMs - previous)
        val movement = if (previous == null) null else abs(sampleMs - previous)
        val newJitter = when {
            movement == null -> jitterMs
            jitterMs == null -> movement
            else -> jitterMs + ALPHA * (movement - jitterMs)
        }
        return copy(rttMs = mean, jitterMs = newJitter, updatedAt = now)
    }

    /** The outcome of an actual connection attempt. */
    fun withOutcome(success: Boolean, now: Long): ServerStats = copy(
        attempts = attempts + 1,
        successes = if (success) successes + 1 else successes,
        consecutiveFailures = if (success) 0 else consecutiveFailures + 1,
        lastSuccessAt = if (success) now else lastSuccessAt,
        lastFailureAt = if (success) lastFailureAt else now,
        updatedAt = now,
    )

    internal companion object {
        /** Weight of the newest sample. Low enough that one outlier cannot swing it. */
        const val ALPHA = 0.3
    }
}

/**
 * The whole memory, immutable: every change returns a new one, so the tunnel
 * thread and the screen cannot see it half-written.
 */
class ConnectionMemory private constructor(private val stats: Map<String, ServerStats>) {

    val size: Int get() = stats.size

    fun of(key: String): ServerStats? = stats[key]

    fun recordSample(key: String, rttMs: Long, now: Long): ConnectionMemory =
        replace(key, (stats[key] ?: ServerStats(key)).withSample(rttMs, now))

    fun recordOutcome(key: String, success: Boolean, now: Long): ConnectionMemory =
        replace(key, (stats[key] ?: ServerStats(key)).withOutcome(success, now))

    /** Drops everything not in [keys] — a subscription that no longer offers a
     *  gateway should not keep a record of it for ever. */
    fun keepOnly(keys: Set<String>): ConnectionMemory =
        ConnectionMemory(stats.filterKeys { it in keys })

    private fun replace(key: String, entry: ServerStats): ConnectionMemory {
        val next = HashMap(stats)
        next[key] = entry
        if (next.size > LIMIT) {
            // Bounded on purpose: this file is written on every connect, and an
            // unbounded one would grow with every gateway ever offered.
            val oldest = next.values.sortedBy { it.updatedAt }.take(next.size - LIMIT)
            oldest.forEach { next.remove(it.key) }
        }
        return ConnectionMemory(next)
    }

    /**
     * A compact text form, one gateway per line, with a version marker so an
     * older file can be recognised rather than misread.
     */
    fun encode(): String = buildString {
        append(VERSION).append('\n')
        stats.values.forEach { entry ->
            append(entry.key).append('|')
                .append(entry.attempts).append('|')
                .append(entry.successes).append('|')
                .append(entry.consecutiveFailures).append('|')
                .append(entry.rttMs?.toString() ?: "").append('|')
                .append(entry.jitterMs?.toString() ?: "").append('|')
                .append(entry.lastSuccessAt).append('|')
                .append(entry.lastFailureAt).append('|')
                .append(entry.updatedAt).append('\n')
        }
    }

    companion object {
        /** Enough for far more gateways than a subscription offers. */
        const val LIMIT = 64
        private const val VERSION = "v1"

        val EMPTY = ConnectionMemory(emptyMap())

        fun of(entries: List<ServerStats>) = ConnectionMemory(entries.associateBy { it.key })

        /**
         * Reads [encode]'s output back. Anything unreadable — a truncated write,
         * a file from a future version — is no memory rather than a crash: the
         * tunnel measures from scratch, which it can always do.
         */
        fun decode(text: String?): ConnectionMemory {
            val lines = text?.lines()?.filter { it.isNotBlank() } ?: return EMPTY
            if (lines.firstOrNull() != VERSION) return EMPTY
            val parsed = lines.drop(1).mapNotNull { line ->
                val parts = line.split('|')
                if (parts.size != 9) return@mapNotNull null
                runCatching {
                    ServerStats(
                        key = parts[0],
                        attempts = parts[1].toInt(),
                        successes = parts[2].toInt(),
                        consecutiveFailures = parts[3].toInt(),
                        rttMs = parts[4].takeIf { it.isNotEmpty() }?.toDouble(),
                        jitterMs = parts[5].takeIf { it.isNotEmpty() }?.toDouble(),
                        lastSuccessAt = parts[6].toLong(),
                        lastFailureAt = parts[7].toLong(),
                        updatedAt = parts[8].toLong(),
                    )
                }.getOrNull()
            }
            return ConnectionMemory(parsed.associateBy { it.key })
        }
    }
}
