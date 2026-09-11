package pro.sixvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ConfigHealthTest {

    private val now = 1_000_000L

    @Test
    fun neverMeasuredIsNotAVerdict() {
        assertEquals(ConfigHealth.UNKNOWN, ConfigHealth.of(probe = null, stats = null, now = now))
    }

    @Test
    fun triedAndSilentIsOffline() {
        val probe = Probe("gw:443", rttMs = null, attempted = true)
        assertEquals(ConfigHealth.OFFLINE, ConfigHealth.of(probe, null, now))
    }

    @Test
    fun promptAndSteadyIsGood() {
        val probe = Probe("gw:443", rttMs = 80, attempted = true)
        val stats = ServerStats("gw:443", rttMs = 80.0, jitterMs = 5.0, updatedAt = now)
        assertEquals(ConfigHealth.GOOD, ConfigHealth.of(probe, stats, now))
    }

    @Test
    fun slowIsUnstableEvenWhenItAnswers() {
        val probe = Probe("gw:443", rttMs = 900, attempted = true)
        assertEquals(ConfigHealth.UNSTABLE, ConfigHealth.of(probe, null, now))
    }

    @Test
    fun aRoundTripThatMovesAboutIsUnstable() {
        val probe = Probe("gw:443", rttMs = 90, attempted = true)
        val stats = ServerStats("gw:443", rttMs = 90.0, jitterMs = 300.0, updatedAt = now)
        assertEquals(ConfigHealth.UNSTABLE, ConfigHealth.of(probe, stats, now))
    }

    @Test
    fun aRecentFailureKeepsItOffGreen() {
        val probe = Probe("gw:443", rttMs = 60, attempted = true)
        val stats = ServerStats("gw:443", consecutiveFailures = 1, rttMs = 60.0, jitterMs = 4.0, updatedAt = now)
        assertEquals(ConfigHealth.UNSTABLE, ConfigHealth.of(probe, stats, now))
    }

    @Test
    fun anOldMeasurementNoLongerSpeaksForTheConfig() {
        val stale = ServerStats("gw:443", rttMs = 50.0, updatedAt = now - ConfigHealth.STALE_AFTER_MS - 1)
        assertEquals(ConfigHealth.UNKNOWN, ConfigHealth.of(probe = null, stats = stale, now = now))

        val fresh = stale.copy(updatedAt = now - 1000)
        assertEquals(ConfigHealth.GOOD, ConfigHealth.of(probe = null, stats = fresh, now = now))
    }
}
