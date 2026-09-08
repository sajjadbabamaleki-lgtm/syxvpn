@file:Suppress("unused", "UNUSED_PARAMETER")

package libXray

/**
 * The libXray API as gomobile exports it, declared so the bridge can be
 * compiled without the AAR.
 *
 * NOT SHIPPED — this lives outside `app/src` and is never part of a build of
 * the app. It exists so `LibXrayBridge.kt` can be type-checked on a machine
 * with no Android SDK and no AAR, which catches the mistakes that matter here:
 * a misspelled method, a wrong arity, an Int where gomobile expects a Long.
 *
 * Derived from the Go source of libXray (android_wrapper.go, invoke.go) and
 * gomobile's mapping rules: exported Go functions become static methods on a
 * class named after the package with a lower-cased first letter on each method,
 * Go `int` becomes Java `long`, Go `bool` becomes `boolean`, and a Go function
 * returning `error` throws.
 *
 * Compiling against this proves the call sites agree with the documented API.
 * It cannot prove the AAR you build exports exactly this — libXray states
 * plainly that it does not guarantee API stability — so check the release you
 * build against before shipping.
 */
interface DialerController {
    /** Go: ProtectFd(int) bool. */
    fun protectFd(fd: Long): Boolean
}

interface ProcessFinder {
    /** Go: FindProcessByConnection(network, srcIP string, srcPort int, destIP string, destPort int) int. */
    fun findProcessByConnection(
        network: String,
        srcIP: String,
        srcPort: Long,
        destIP: String,
        destPort: Long,
    ): Long
}

object LibXray {
    /** Go: Invoke(requestJSON string) string. */
    @JvmStatic
    fun invoke(requestJSON: String): String = error("stub")

    /** Go: SetDNS(controller DialerController, server string) error. */
    @JvmStatic
    @Throws(Exception::class)
    fun setDNS(controller: DialerController, server: String): Unit = error("stub")

    /** Go: ResetDNS(). */
    @JvmStatic
    fun resetDNS(): Unit = error("stub")

    /** Go: RegisterDialerController(controller DialerController). */
    @JvmStatic
    fun registerDialerController(controller: DialerController): Unit = error("stub")

    /** Go: RegisterListenerController(controller DialerController). */
    @JvmStatic
    fun registerListenerController(controller: DialerController): Unit = error("stub")

    /** Go: RegisterProcessFinder(finder ProcessFinder, sdkVersion int). */
    @JvmStatic
    fun registerProcessFinder(finder: ProcessFinder?, sdkVersion: Long): Unit = error("stub")
}
