package net.jordanvpn.app.vpn

/**
 * What is compiled when `app/libs` holds no libXray AAR.
 *
 * It fails loudly on start rather than pretending: the switch surfaces the
 * message below, the counters stay at zero, and nothing on screen claims a
 * tunnel that does not exist.
 */
class NotWiredXrayBridge : XrayBridge {

    override fun start(configJson: String): Unit = throw IllegalStateException(
        "No Xray runtime in this build. Build libXray with gomobile, put the .aar " +
            "in android/app/libs/, and rebuild — see android/README.md.",
    )

    override fun stop() = Unit

    override fun isRunning() = false

    override fun trafficStats() = 0L to 0L

    override fun version(): String? = null
}

/** The build with no AAR has only one possible runtime. */
@Suppress("UNUSED_PARAMETER")
fun createXrayBridge(protector: SocketProtector, metricsPort: Int): XrayBridge =
    NotWiredXrayBridge()
