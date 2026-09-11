package pro.sixvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionMemoryTest {

    @Test
    fun aFailureCountsAgainstAGatewayAndASuccessClearsTheStreak() {
        var stats = ServerStats(key = "gw:443")
        stats = stats.withOutcome(success = false, now = 1)
        stats = stats.withOutcome(success = false, now = 2)
        assertEquals(2, stats.consecutiveFailures)
        val whileFailing = stats.reliability

        stats = stats.withOutcome(success = true, now = 3)
        assertEquals(0, stats.consecutiveFailures)
        assertTrue("a success must improve reliability", stats.reliability > whileFailing)
    }

    @Test
    fun oneAttemptIsNotTreatedAsCertainty() {
        val once = ServerStats("a").withOutcome(success = true, now = 1)
        val many = ServerStats("b").let { start ->
            (1..40).fold(start) { acc, i -> acc.withOutcome(success = true, now = i.toLong()) }
        }
        assertTrue("40/40 must outrank 1/1", many.reliability > once.reliability)
        assertTrue("1/1 is not 100%", once.reliability < 1.0)
    }

    @Test
    fun theRoundTripIsSmoothedAndItsMovementIsRecorded() {
        var stats = ServerStats("gw:443").withSample(100, now = 1)
        assertEquals(100.0, stats.rttMs!!, 1e-9)
        assertNull("one sample cannot show movement", stats.jitterMs)

        stats = stats.withSample(200, now = 2)
        assertTrue("the mean follows the new sample", stats.rttMs!! in 100.0..200.0)
        assertNotNull(stats.jitterMs)
        assertTrue("a 100 ms jump must register", stats.jitterMs!! > 50.0)
    }

    @Test
    fun memorySurvivesBeingWrittenAndReadBack() {
        val memory = ConnectionMemory.EMPTY
            .recordSample("gw1:443", 120, now = 10)
            .recordOutcome("gw1:443", success = true, now = 11)
            .recordOutcome("gw2:8443", success = false, now = 12)

        val restored = ConnectionMemory.decode(memory.encode())

        assertEquals(memory.size, restored.size)
        assertEquals(memory.of("gw1:443"), restored.of("gw1:443"))
        assertEquals(memory.of("gw2:8443"), restored.of("gw2:8443"))
    }

    @Test
    fun anUnreadableFileIsNoMemoryRatherThanACrash() {
        assertEquals(0, ConnectionMemory.decode(null).size)
        assertEquals(0, ConnectionMemory.decode("").size)
        assertEquals(0, ConnectionMemory.decode("v9\nwhatever").size)
        assertEquals(0, ConnectionMemory.decode("v1\nbroken|line").size)
    }

    @Test
    fun memoryStaysBounded() {
        val memory = (1..ConnectionMemory.LIMIT + 20).fold(ConnectionMemory.EMPTY) { acc, i ->
            acc.recordSample("gw$i:443", i.toLong(), now = i.toLong())
        }
        assertEquals(ConnectionMemory.LIMIT, memory.size)
        assertNull("the oldest entries are the ones dropped", memory.of("gw1:443"))
        assertNotNull(memory.of("gw${ConnectionMemory.LIMIT + 20}:443"))
    }

    @Test
    fun gatewaysNoLongerOfferedAreForgotten() {
        val memory = ConnectionMemory.EMPTY
            .recordSample("keep:443", 10, now = 1)
            .recordSample("gone:443", 10, now = 1)
            .keepOnly(setOf("keep:443"))
        assertEquals(1, memory.size)
        assertNull(memory.of("gone:443"))
    }
}
