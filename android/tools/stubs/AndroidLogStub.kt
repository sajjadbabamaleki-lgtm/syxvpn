@file:Suppress("unused", "UNUSED_PARAMETER")

package android.util

/**
 * NOT SHIPPED. Enough of android.util.Log to type-check the bridge off-device;
 * see stubs/LibXrayApi.kt for why these stubs exist at all.
 */
object Log {
    @JvmStatic fun w(tag: String, message: String): Int = 0
    @JvmStatic fun i(tag: String, message: String): Int = 0
    @JvmStatic fun e(tag: String, message: String): Int = 0
}
