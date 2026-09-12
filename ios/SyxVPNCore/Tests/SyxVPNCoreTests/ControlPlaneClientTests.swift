import XCTest
@testable import SyxVPNCore

/// A transport that answers from a script and records what it was asked.
private final class FakeTransport: HttpTransport, @unchecked Sendable {
    /// Keyed by the base address, so a test can make one host silent and
    /// another answer.
    var replies: [String: Result<HttpReply, TransportUnreachable>] = [:]
    private(set) var calls: [(method: String, url: String, headers: [String: String])] = []

    func exchange(
        method: String, url: String, headers: [String: String], body: String?
    ) async throws -> HttpReply {
        calls.append((method, url, headers))
        for (base, outcome) in replies where url.hasPrefix(base) {
            switch outcome {
            case .success(let reply): return reply
            case .failure(let error): throw error
            }
        }
        throw TransportUnreachable(url: url, reason: "no script for this address")
    }
}

/// The endpoints, the statuses, and what each failure means. None of this can
/// be written against a real URLSession, and all of it is where the bugs are.
final class ControlPlaneClientTests: XCTestCase {

    private let first = "https://a.example"
    private let second = "https://b.example"

    private func makeClient(
        _ transport: FakeTransport, storage: InMemorySessionStorage = InMemorySessionStorage()
    ) -> (ControlPlaneClient, SessionStore) {
        let session = SessionStore(storage: storage)
        let endpoints = ControlPlaneEndpoints(
            configured: [first, second],
            remembered: { session.controlPlaneBase },
            remember: { session.controlPlaneBase = $0 }
        )
        return (
            ControlPlaneClient(endpoints: endpoints, session: session, transport: transport),
            session
        )
    }

    private func ok(_ json: String) -> Result<HttpReply, TransportUnreachable> {
        .success(HttpReply(status: 200, body: json))
    }

    // MARK: not signed in is not the same as signed out

    func testAnAuthenticatedCallWithNoTokenNeverLeavesThePhone() async {
        // A fresh install has no token. Sending the request anyway would come
        // back 401 and be read as a session that expired, telling somebody who
        // never had an account to sign in again.
        let transport = FakeTransport()
        let (client, _) = makeClient(transport)

        do {
            _ = try await client.subscription()
            XCTFail("should have refused before making a request")
        } catch let error as ControlPlaneClient.ApiError {
            XCTAssertEqual(error.code, "NO_SESSION")
        } catch {
            XCTFail("wrong error: \(error)")
        }
        XCTAssertTrue(transport.calls.isEmpty, "nothing should have been sent")
    }

    func testA401FromTheServerClearsTheTokenAndSaysTheSessionExpired() async throws {
        let transport = FakeTransport()
        transport.replies[first] = .success(HttpReply(status: 401, body: "{}"))
        let (client, session) = makeClient(transport)
        session.token = "sess_old"

        do {
            _ = try await client.subscription()
            XCTFail("should have thrown")
        } catch let error as ControlPlaneClient.ApiError {
            XCTAssertEqual(error.code, "UNAUTHORIZED")
        }
        XCTAssertNil(session.token, "a rejected token must not stay on the phone")
        let expired = await client.sessionExpired
        XCTAssertTrue(expired)
    }

    // MARK: an HTTP status is an answer

    func testAStatusFromTheFirstAddressIsNotRetriedAgainstTheSecond() async throws {
        // A 402 from one address is a 402 from all of them. Retrying would turn
        // one refusal into two, and could double a side effect.
        let transport = FakeTransport()
        transport.replies[first] = .success(HttpReply(
            status: 402,
            body: #"{"error":{"code":"PAYMENT","message":"Pay first"}}"#
        ))
        transport.replies[second] = ok(#"{"data":{}}"#)
        let (client, _) = makeClient(transport)

        do {
            _ = try await client.shopConfig()
            XCTFail("should have thrown")
        } catch let error as ControlPlaneClient.ApiError {
            XCTAssertEqual(error.status, 402)
            XCTAssertEqual(error.code, "PAYMENT")
            XCTAssertEqual(error.message, "Pay first")
        }
        XCTAssertEqual(transport.calls.count, 1, "the second address must not have been tried")
    }

    func testAnUnreachableAddressMovesOnToTheNext() async throws {
        let transport = FakeTransport()
        transport.replies[first] = .failure(
            TransportUnreachable(url: first, reason: "no such host")
        )
        transport.replies[second] = ok(#"{"data":{"emailCodes":true}}"#)
        let (client, session) = makeClient(transport)

        let config = try await client.shopConfig()
        XCTAssertTrue(config.emailCodes)
        XCTAssertEqual(transport.calls.count, 2)
        XCTAssertEqual(
            session.controlPlaneBase, second,
            "the one that answered is remembered, so the dead first entry costs one attempt"
        )
    }

    func testEveryAddressSilentIsOneClearFailureRatherThanAStatus() async {
        let transport = FakeTransport()
        for base in [first, second] {
            transport.replies[base] = .failure(
                TransportUnreachable(url: base, reason: "no such host")
            )
        }
        let (client, _) = makeClient(transport)

        do {
            _ = try await client.shopConfig()
            XCTFail("should have thrown")
        } catch let error as ControlPlaneClient.ApiError {
            XCTAssertEqual(error.code, "UNREACHABLE")
            XCTAssertEqual(error.status, 0, "there was no status: nobody answered")
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    // MARK: what the endpoints return

    func testSigningInStoresTheTokenAndTheAddress() async throws {
        let transport = FakeTransport()
        transport.replies[first] = ok(#"{"data":{"token":"sess_new"}}"#)
        let (client, session) = makeClient(transport)

        let token = try await client.authenticate(
            email: "someone@example.net", password: "hunter2pass"
        )
        XCTAssertEqual(token, "sess_new")
        XCTAssertEqual(session.token, "sess_new")
        XCTAssertEqual(session.email, "someone@example.net")
        XCTAssertTrue(
            transport.calls[0].url.hasSuffix("/api/v1/shop/auth/session"),
            "one call for both ways in"
        )
    }

    func testAnAccountWithNoPlanIsNilRatherThanAnError() async throws {
        // It comes back as "subscription": null, which is a value and not a
        // missing key.
        let transport = FakeTransport()
        transport.replies[first] = ok(#"{"data":{"subscription":null}}"#)
        let (client, session) = makeClient(transport)
        session.token = "sess_abc"

        let subscription = try await client.subscription()
        XCTAssertNil(subscription)
    }

    func testASubscriptionIsReadAndItsProfilesAreCached() async throws {
        let transport = FakeTransport()
        transport.replies[first] = ok("""
        {"data":{"subscription":{"active":true,"state":"active","usedBytes":"350000",
        "quotaBytes":0,"expiresAt":"2027-09-12T00:00:00.000Z",
        "subscriptionUrl":"https://a.example/sub/tok3n",
        "profiles":[{"uri":"vless://uuid@gw1.example:443?type=ws"}]}}}
        """)
        let (client, session) = makeClient(transport)
        session.token = "sess_abc"

        let subscription = try await XCTUnwrapAsync(try await client.subscription())
        XCTAssertTrue(subscription.active)
        // Byte counts arrive as strings once they are past what JSON holds
        // exactly, and a quota is well past it.
        XCTAssertEqual(subscription.usedBytes, 350_000)
        XCTAssertEqual(subscription.quotaBytes, 0, "0 is unmetered, not missing")
        XCTAssertEqual(subscription.profiles.count, 1)
        XCTAssertEqual(session.subscriptionUrl, "https://a.example/sub/tok3n")
        XCTAssertEqual(session.cachedProfiles, "vless://uuid@gw1.example:443?type=ws")
    }

    func testSigningOutClearsTheSessionEvenIfTheServerNeverAnswers() async throws {
        let transport = FakeTransport()
        for base in [first, second] {
            transport.replies[base] = .failure(TransportUnreachable(url: base, reason: "offline"))
        }
        let (client, session) = makeClient(transport)
        session.token = "sess_abc"
        session.addImported(["vless://uuid@mine.example:443?type=ws"])

        await client.signOut()

        XCTAssertNil(session.token, "the phone signs out whether or not the server hears about it")
        XCTAssertEqual(session.importedLines.count, 1, "the pasted configs are not the account's")
    }

    func testTheTokenIsSentOnAnAuthenticatedCallAndNotOnAPublicOne() async throws {
        let transport = FakeTransport()
        transport.replies[first] = ok(#"{"data":{"subscription":null}}"#)
        let (client, session) = makeClient(transport)
        session.token = "sess_abc"

        _ = try await client.subscription()
        XCTAssertEqual(transport.calls[0].headers["Authorization"], "Bearer sess_abc")

        _ = try await client.shopConfig()
        XCTAssertNil(
            transport.calls[1].headers["Authorization"],
            "a public endpoint must not carry the session"
        )
    }
}

/// XCTUnwrap does not accept an async autoclosure.
private func XCTUnwrapAsync<T>(
    _ value: T?, file: StaticString = #filePath, line: UInt = #line
) throws -> T {
    try XCTUnwrap(value, file: file, line: line)
}
