import Foundation

/// One HTTP exchange, as this app needs it: a status and a body.
public struct HttpReply: Equatable {
    public let status: Int
    public let body: String

    public init(status: Int, body: String) {
        self.status = status
        self.body = body
    }
}

/// The network, behind a protocol.
///
/// Every test of the client below turns on *which* address was called and what
/// happened when one did not answer. None of that can be written against a real
/// URLSession, and all of it is where the bugs are.
public protocol HttpTransport: Sendable {
    func exchange(
        method: String, url: String, headers: [String: String], body: String?
    ) async throws -> HttpReply
}

/// The error a transport throws when it could not reach the host at all.
///
/// Distinct from an HTTP status on purpose: a status is an answer, and a 401
/// from the first address must not send the client looking for a second one.
public struct TransportUnreachable: Error {
    public let url: String
    public let reason: String

    public init(url: String, reason: String) {
        self.url = url
        self.reason = reason
    }
}

/// URLSession, with the failures translated into the one error the client cares
/// about.
public final class URLSessionTransport: HttpTransport {
    private let session: URLSession
    private let timeout: TimeInterval

    public init(session: URLSession = .shared, timeout: TimeInterval = 20) {
        self.session = session
        self.timeout = timeout
    }

    public func exchange(
        method: String, url: String, headers: [String: String], body: String?
    ) async throws -> HttpReply {
        guard let target = URL(string: url) else {
            throw TransportUnreachable(url: url, reason: "not a usable address")
        }
        var request = URLRequest(url: target, timeoutInterval: timeout)
        request.httpMethod = method
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let body { request.httpBody = Data(body.utf8) }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw TransportUnreachable(url: url, reason: "not an HTTP response")
            }
            return HttpReply(status: http.statusCode, body: String(decoding: data, as: UTF8.self))
        } catch let unreachable as TransportUnreachable {
            throw unreachable
        } catch {
            // Everything URLSession throws is a failure to get an answer —
            // DNS, TLS, a refused connection, a timeout. They are all the same
            // thing to the caller: try the next address.
            throw TransportUnreachable(url: url, reason: error.localizedDescription)
        }
    }
}
