package pro.sixvpn.app.core

/**
 * Base64, by hand, for the places this app meets it: a subscription blob and
 * the credential inside a `ss://` line.
 *
 * Written out rather than taken from a library because of where it has to run.
 * `java.util.Base64` is API 26 and this app runs from 24; `android.util.Base64`
 * exists on every version and cannot be called off a device, which would put
 * the parsing that decides what the tunnel connects to beyond the reach of a
 * test. Neither trade is worth it for twenty lines.
 *
 * Every form these strings arrive in is accepted — standard or URL-safe
 * alphabet, padded or not — because the subscription endpoints of the world
 * disagree about all three and the person pasting one has no idea which they
 * were handed.
 */
internal object Base64Text {

    private const val ALPHABET =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    /** The decoded text, or null when [text] is not base64 at all. */
    fun decode(text: String): String? {
        val normalised = text.replace('-', '+').replace('_', '/').trimEnd('=')
        if (normalised.isEmpty()) return null
        if (normalised.any { it !in ALPHABET }) return null

        val bytes = ArrayList<Byte>(normalised.length * 3 / 4 + 3)
        var buffer = 0
        var bits = 0
        for (character in normalised) {
            buffer = (buffer shl 6) or ALPHABET.indexOf(character)
            bits += 6
            if (bits >= 8) {
                bits -= 8
                bytes.add(((buffer shr bits) and 0xFF).toByte())
            }
        }
        if (bytes.isEmpty()) return null
        return String(bytes.toByteArray(), Charsets.UTF_8)
    }
}
