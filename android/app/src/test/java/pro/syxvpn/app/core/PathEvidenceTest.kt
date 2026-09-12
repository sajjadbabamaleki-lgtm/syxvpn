package pro.syxvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PathEvidenceTest {

    @Test
    fun aRoundTripThatCameBackIsProof() {
        val evidence = PathEvidence.of(mapOf("gw1" to 152L), "gw1")
        assertEquals(PathEvidence.WORKS, evidence)
        assertTrue(evidence.usable)
    }

    @Test
    fun aRequestThatDidNotComeBackIsDisproof() {
        val evidence = PathEvidence.of(mapOf("gw1" to null), "gw1")
        assertEquals(PathEvidence.FAILS, evidence)
        assertFalse("a gateway that answered nothing must not be started", evidence.usable)
    }

    @Test
    fun aGatewayNobodyMeasuredIsNotAFailure() {
        val evidence = PathEvidence.of(mapOf("gw1" to 152L), "gw2")
        assertEquals(PathEvidence.UNKNOWN, evidence)
        assertTrue("no measurement must not strand a phone", evidence.usable)
    }

    @Test
    fun anEmptyBatchLeavesEveryGatewayUsable() {
        // What a build with no runtime, or a refused measurement, produces.
        assertTrue(PathEvidence.of(emptyMap(), "gw1").usable)
        assertEquals(PathEvidence.UNKNOWN, PathEvidence.of(emptyMap(), "gw1"))
    }

    @Test
    fun measuredAndUnmeasuredDoNotCollapseIntoEachOther() {
        // The bug this exists to prevent: treating "not measured" and
        // "measured, no answer" as one thing. One must connect, one must not.
        val measured = mapOf("dead" to null)
        assertFalse(PathEvidence.of(measured, "dead").usable)
        assertTrue(PathEvidence.of(measured, "unmeasured").usable)
    }
}
