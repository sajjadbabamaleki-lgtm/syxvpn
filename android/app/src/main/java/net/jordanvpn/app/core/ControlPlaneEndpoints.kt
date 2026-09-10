package net.jordanvpn.app.core

/**
 * The addresses the control plane can be reached at, in the order to try them.
 *
 * One name was a single point of failure for every phone that had already
 * installed the app: the day it is filtered, no installation can sign in, fetch
 * a subscription or learn about a new gateway — and no fix can be delivered,
 * because delivering the fix needs the same name. DNS-over-HTTPS answers a
 * resolver that will not answer; it does nothing about a name that is blocked
 * outright. Only a second name does.
 *
 * The build supplies the list. This decides the order, remembers which one
 * worked so the cost of a dead first entry is paid once rather than on every
 * request, and moves on when one stops answering.
 *
 * @param configured the hosts from the build, most preferred first.
 * @param remembered reads the last host known to work, or null.
 * @param remember stores a host that has just worked, or clears it with null.
 */
class ControlPlaneEndpoints(
    configured: List<String>,
    private val remembered: () -> String?,
    private val remember: (String?) -> Unit,
) {
    /**
     * Cleaned at construction: blanks dropped, trailing slashes removed so
     * paths concatenate without doubling, and duplicates collapsed while
     * keeping the configured order.
     */
    private val all: List<String> = configured
        .map { it.trim().trimEnd('/') }
        .filter { it.isNotEmpty() }
        .distinct()

    init {
        require(all.isNotEmpty()) { "a control plane needs at least one address" }
    }

    /** Every address, preferred first: the remembered one, then the rest. */
    fun ordered(): List<String> {
        val preferred = remembered()?.trimEnd('/')?.takeIf { it in all } ?: return all
        return listOf(preferred) + all.filterNot { it == preferred }
    }

    /** The one to use first. */
    fun current(): String = ordered().first()

    /** Records that [base] answered, so the next launch starts there. */
    fun worked(base: String) {
        val cleaned = base.trimEnd('/')
        if (cleaned in all && cleaned != remembered()) remember(cleaned)
    }

    /**
     * Records that [base] could not be reached.
     *
     * Only the memory is cleared, never the list: an address that fails today
     * is the one that works tomorrow, and a censor's block is not a reason to
     * forget an address permanently.
     */
    fun failed(base: String) {
        if (base.trimEnd('/') == remembered()) remember(null)
    }

    /**
     * Rewrites [url] onto [base] when it points at one of the known hosts.
     *
     * A subscription link is absolute and was issued by whichever address was
     * reachable when it was made. If that one has since gone dark the link is
     * dead too, though the same path is served by every address — so the host
     * is swapped and the path kept. A link pointing somewhere else entirely is
     * left alone: someone else's subscription is not ours to redirect.
     */
    fun rebase(url: String, base: String): String {
        val host = all.firstOrNull { url.startsWith("$it/") || url == it } ?: return url
        return base.trimEnd('/') + url.removePrefix(host)
    }

    companion object {
        /** Splits the build's comma-separated list. */
        fun parse(value: String): List<String> = value.split(',')
    }
}
