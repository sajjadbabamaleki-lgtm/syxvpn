package net.jordanvpn.app.core

/**
 * Turns the deployment's support contact into something a phone can open.
 *
 * The operator sets `SUPPORT_CONTACT` on the control plane and it reaches the
 * app through `/api/v1/shop/config`, so it can be a Telegram handle, a link or
 * an email address depending on how that operator works. Anything this cannot
 * make sense of returns null and the support screen shows it as plain text
 * rather than offering a button that goes nowhere.
 */
fun supportLink(contact: String): String? {
    val value = contact.trim()
    return when {
        value.isEmpty() -> null
        value.startsWith("http://") || value.startsWith("https://") || value.startsWith("tg://") -> value
        value.startsWith("@") && !value.contains(' ') -> "https://t.me/" + value.removePrefix("@")
        value.startsWith("t.me/") -> "https://$value"
        value.contains('@') && value.contains('.') && !value.contains(' ') -> "mailto:$value"
        else -> null
    }
}
