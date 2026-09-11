package pro.sixvpn.app.core

/**
 * Reading configs a person pasted in, from wherever they got them.
 *
 * A config bought from somebody else is theirs. It needs no plan, no account
 * and no subscription here — and supporting it is not a courtesy: somebody with
 * a working config from another provider will install the app that reads it,
 * and that is the app whose other tab they see when their config stops working.
 *
 * What people actually paste is not one shape. It is a line, or forty lines, or
 * the base64 blob a subscription URL answers with, or all of that with a
 * comment line and some blank ones through the middle. Every one of those is
 * accepted, because the alternative is a person who has the right thing in
 * their clipboard being told it is wrong.
 *
 * Nothing here touches Android, so it can be tested — which matters more here
 * than almost anywhere else in the app: what this returns becomes the tunnel.
 */
object ConfigImport {

    data class Result(
        /** Parsed and not already held, in the order they were pasted. */
        val added: List<TunnelProfile>,
        /** Lines that looked like configs and could not be read. */
        val rejected: Int,
        /** Lines that were already in the list. */
        val duplicates: Int,
    ) {
        val isEmpty: Boolean get() = added.isEmpty()

        /** What to tell the person, in their terms rather than the parser's. */
        fun summary(): String = when {
            added.isEmpty() && rejected == 0 && duplicates > 0 ->
                if (duplicates == 1) "You already have that one" else "You already have all $duplicates"
            added.isEmpty() && rejected > 0 ->
                if (rejected == 1) "That does not look like a config" else "None of those $rejected could be read"
            added.isEmpty() -> "Nothing to add"
            else -> buildString {
                append(if (added.size == 1) "Added 1 config" else "Added ${added.size} configs")
                if (duplicates > 0) append(", $duplicates already here")
                if (rejected > 0) append(", $rejected could not be read")
            }
        }
    }

    /**
     * @param existing URIs already held, so pasting the same list twice does not
     *   double it — which is what happens when somebody re-copies from a channel
     *   to get one new server.
     */
    fun parse(pasted: String, existing: Collection<String> = emptyList()): Result {
        val held = existing.toMutableSet()
        val added = mutableListOf<TunnelProfile>()
        var rejected = 0
        var duplicates = 0

        for (line in candidates(pasted)) {
            val profile = TunnelProfile.parse(line)
            if (profile == null) {
                rejected += 1
                continue
            }
            if (!held.add(profile.uri)) {
                duplicates += 1
                continue
            }
            added += profile
        }
        return Result(added, rejected, duplicates)
    }

    /**
     * The lines worth trying, from whatever was pasted.
     *
     * A subscription URL answers with base64 of the whole list, and people paste
     * that answer as often as they paste the links themselves — so a blob that
     * decodes into config lines is unwrapped once. Once, not repeatedly: base64
     * of base64 is not a format anybody produces, and following it forever is a
     * way to hang on a large paste.
     */
    private fun candidates(pasted: String): List<String> {
        val direct = lines(pasted)
        if (direct.any { TunnelProfile.looksLikeProfile(it) }) return direct

        val blob = pasted.filterNot { it.isWhitespace() }
        // Short strings decode into noise as readily as into a list, and a
        // subscription answer is never eight characters long.
        val decoded = if (blob.length < 8) null else Base64Text.decode(blob)
        val fromBlob = lines(decoded ?: return direct)
        return if (fromBlob.any { TunnelProfile.looksLikeProfile(it) }) fromBlob else direct
    }

    private fun lines(text: String): List<String> = text
        .split('\n', '\r')
        .map { it.trim() }
        // A '#' line is a comment in some lists, but a config's own label comes
        // after a '#' *within* the line, so only a leading one is a comment.
        .filter { it.isNotEmpty() && !it.startsWith("#") && !it.startsWith("//") }

}
