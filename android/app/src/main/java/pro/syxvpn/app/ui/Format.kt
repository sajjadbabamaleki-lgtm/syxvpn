package pro.syxvpn.app.ui

import java.util.Locale

fun formatBytes(value: Long): String {
    if (value < 1024) return "$value B"
    val units = listOf("KB", "MB", "GB", "TB")
    var size = value.toDouble() / 1024
    var unit = 0
    while (size >= 1024 && unit < units.lastIndex) {
        size /= 1024
        unit++
    }
    return if (size < 10) String.format(Locale.US, "%.1f %s", size, units[unit])
    else String.format(Locale.US, "%.0f %s", size, units[unit])
}

fun formatUptime(seconds: Long): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
    else String.format(Locale.US, "%02d:%02d", m, s)
}

/**
 * micro-USDT to a plain decimal string.
 *
 * The storefront keeps money as integers (1 USDT = 1_000_000 micro), which is
 * also TRC-20 USDT's on-chain precision, and the exact amount is what matches a
 * transfer to an order. Formatting through a Double could round that away, so
 * this splits the integer instead.
 */
fun formatUsdt(micro: Long): String {
    val whole = micro / 1_000_000
    val fraction = (micro % 1_000_000).toString().padStart(6, '0').trimEnd('0')
    return if (fraction.isEmpty()) whole.toString() else "$whole.$fraction"
}

/** Parses the ISO-8601 timestamps the API returns. Null if it is not one. */
fun parseIsoMillis(iso: String): Long? {
    val format = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    format.timeZone = java.util.TimeZone.getTimeZone("UTC")
    return runCatching { format.parse(iso)?.time }.getOrNull()
}

/** "22 days left" / "last day" / "expired", for a subscription's end date. */
fun formatDaysLeft(iso: String, now: Long = System.currentTimeMillis()): String? {
    val at = parseIsoMillis(iso) ?: return null
    val days = (at - now) / 86_400_000
    return when {
        at <= now -> "expired"
        days < 1 -> "last day"
        days == 1L -> "1 day left"
        else -> "$days days left"
    }
}

/** "in 42 min" / "in 2 h 5 min" / "expired", for an order deadline. */
fun formatRemaining(iso: String, now: Long = System.currentTimeMillis()): String {
    val at = parseIsoMillis(iso) ?: return iso.take(16).replace('T', ' ')
    val minutes = (at - now) / 60000
    return when {
        minutes <= 0 -> "expired"
        minutes < 60 -> "in $minutes min"
        else -> "in ${minutes / 60} h ${minutes % 60} min"
    }
}
