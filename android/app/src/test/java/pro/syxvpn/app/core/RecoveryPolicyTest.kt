package pro.syxvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryPolicyTest {

    @Test
    fun theFirstRecoveryIsImmediateAndTheRestBackOff() {
        val policy = RecoveryPolicy()
        val first = policy.nextDelayMs(0)
        val second = policy.nextDelayMs(1_000)
        val third = policy.nextDelayMs(5_000)
        assertEquals("a dropped tunnel comes back at once", 0L, first)
        assertTrue("the second attempt waits", second > first)
        assertTrue("the third waits longer than the second", third > second)
    }

    @Test
    fun aGatewayThatIsSimplyDownIsNotHammered() {
        val policy = RecoveryPolicy()
        var clock = 0L
        repeat(RecoveryPolicy.MAX_ATTEMPTS) {
            assertTrue(policy.canRetry(clock))
            clock += policy.nextDelayMs(clock) + 1_000
        }
        assertFalse("past the ceiling the tunnel must stop and say so", policy.canRetry(clock))
    }

    @Test
    fun theWindowMovesOn() {
        val policy = RecoveryPolicy()
        repeat(RecoveryPolicy.MAX_ATTEMPTS) { policy.nextDelayMs(0) }
        assertFalse(policy.canRetry(1_000))
        assertTrue("an hour later it may try again", policy.canRetry(RecoveryPolicy.WINDOW_MS + 1))
    }

    @Test
    fun aSessionThatStaysUpClearsTheRecord() {
        val policy = RecoveryPolicy()
        repeat(RecoveryPolicy.MAX_ATTEMPTS) { policy.nextDelayMs(0) }
        assertFalse(policy.canRetry(1_000))
        policy.settled()
        assertTrue(policy.canRetry(1_000))
        assertEquals(0, policy.recentAttempts(1_000))
    }
}
