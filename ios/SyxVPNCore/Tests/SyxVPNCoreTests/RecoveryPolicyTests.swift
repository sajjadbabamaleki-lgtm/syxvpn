import XCTest
@testable import SyxVPNCore

final class RecoveryPolicyTests: XCTestCase {

    func testTheFirstRecoveryIsImmediateAndTheRestBackOff() {
        let policy = RecoveryPolicy()
        let first = policy.nextDelayMs(now: 0)
        let second = policy.nextDelayMs(now: 1_000)
        let third = policy.nextDelayMs(now: 5_000)
        XCTAssertEqual(first, 0, "a dropped tunnel comes back at once")
        XCTAssertGreaterThan(second, first, "the second attempt waits")
        XCTAssertGreaterThan(third, second, "the third waits longer than the second")
    }

    func testAGatewayThatIsSimplyDownIsNotHammered() {
        let policy = RecoveryPolicy()
        var clock: Int64 = 0
        for _ in 0..<RecoveryPolicy.maxAttemptsDefault {
            XCTAssertTrue(policy.canRetry(now: clock))
            clock += policy.nextDelayMs(now: clock) + 1_000
        }
        XCTAssertFalse(
            policy.canRetry(now: clock), "past the ceiling the tunnel must stop and say so"
        )
    }

    func testTheWindowMovesOn() {
        let policy = RecoveryPolicy()
        for _ in 0..<RecoveryPolicy.maxAttemptsDefault { _ = policy.nextDelayMs(now: 0) }
        XCTAssertFalse(policy.canRetry(now: 1_000))
        XCTAssertTrue(
            policy.canRetry(now: RecoveryPolicy.windowMsDefault + 1),
            "an hour later it may try again"
        )
    }

    func testASessionThatStaysUpClearsTheRecord() {
        let policy = RecoveryPolicy()
        for _ in 0..<RecoveryPolicy.maxAttemptsDefault { _ = policy.nextDelayMs(now: 0) }
        XCTAssertFalse(policy.canRetry(now: 1_000))
        policy.settled()
        XCTAssertTrue(policy.canRetry(now: 1_000))
        XCTAssertEqual(policy.recentAttempts(now: 1_000), 0)
    }
}
