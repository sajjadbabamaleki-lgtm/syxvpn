import XCTest
@testable import SyxVPNCore

final class ConnectionMemoryTests: XCTestCase {

    func testAFailureCountsAgainstAGatewayAndASuccessClearsTheStreak() {
        var stats = ServerStats(key: "gw:443")
        stats = stats.withOutcome(success: false, now: 1)
        stats = stats.withOutcome(success: false, now: 2)
        XCTAssertEqual(stats.consecutiveFailures, 2)
        let whileFailing = stats.reliability

        stats = stats.withOutcome(success: true, now: 3)
        XCTAssertEqual(stats.consecutiveFailures, 0)
        XCTAssertGreaterThan(stats.reliability, whileFailing, "a success must improve reliability")
    }

    func testOneAttemptIsNotTreatedAsCertainty() {
        let once = ServerStats(key: "a").withOutcome(success: true, now: 1)
        var many = ServerStats(key: "b")
        for i in 1...40 { many = many.withOutcome(success: true, now: Int64(i)) }
        XCTAssertGreaterThan(many.reliability, once.reliability, "40/40 must outrank 1/1")
        XCTAssertLessThan(once.reliability, 1.0, "1/1 is not 100%")
    }

    func testTheRoundTripIsSmoothedAndItsMovementIsRecorded() throws {
        var stats = ServerStats(key: "gw:443").withSample(100, now: 1)
        XCTAssertEqual(try XCTUnwrap(stats.rttMs), 100.0, accuracy: 1e-9)
        XCTAssertNil(stats.jitterMs, "one sample cannot show movement")

        stats = stats.withSample(200, now: 2)
        let mean = try XCTUnwrap(stats.rttMs)
        XCTAssertTrue((100.0...200.0).contains(mean), "the mean follows the new sample")
        let jitter = try XCTUnwrap(stats.jitterMs)
        XCTAssertGreaterThan(jitter, 50.0, "a 100 ms jump must register")
    }

    func testMemorySurvivesBeingWrittenAndReadBack() {
        let memory = ConnectionMemory.empty
            .recordSample("gw1:443", rttMs: 120, now: 10)
            .recordOutcome("gw1:443", success: true, now: 11)
            .recordOutcome("gw2:8443", success: false, now: 12)

        let restored = ConnectionMemory.decode(memory.encode())

        XCTAssertEqual(restored.size, memory.size)
        XCTAssertEqual(restored.of("gw1:443"), memory.of("gw1:443"))
        XCTAssertEqual(restored.of("gw2:8443"), memory.of("gw2:8443"))
    }

    func testAnUnreadableFileIsNoMemoryRatherThanACrash() {
        XCTAssertEqual(ConnectionMemory.decode(nil).size, 0)
        XCTAssertEqual(ConnectionMemory.decode("").size, 0)
        XCTAssertEqual(ConnectionMemory.decode("v9\nwhatever").size, 0)
        XCTAssertEqual(ConnectionMemory.decode("v1\nbroken|line").size, 0)
        // Nine fields, but the numbers are not numbers.
        XCTAssertEqual(ConnectionMemory.decode("v1\nk|a|b|c|d|e|f|g|h").size, 0)
    }

    func testMemoryStaysBounded() {
        var memory = ConnectionMemory.empty
        for i in 1...(ConnectionMemory.limit + 20) {
            memory = memory.recordSample("gw\(i):443", rttMs: Int64(i), now: Int64(i))
        }
        XCTAssertEqual(memory.size, ConnectionMemory.limit)
        XCTAssertNil(memory.of("gw1:443"), "the oldest entries are the ones dropped")
        XCTAssertNotNil(memory.of("gw\(ConnectionMemory.limit + 20):443"))
    }

    func testGatewaysNoLongerOfferedAreForgotten() {
        let memory = ConnectionMemory.empty
            .recordSample("keep:443", rttMs: 10, now: 1)
            .recordSample("gone:443", rttMs: 10, now: 1)
            .keepOnly(["keep:443"])
        XCTAssertEqual(memory.size, 1)
        XCTAssertNil(memory.of("gone:443"))
    }
}
