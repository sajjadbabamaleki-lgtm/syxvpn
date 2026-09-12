import Foundation

/// Thin client for the storefront API (`/api/v1/shop/...`): sign in, the
/// customer's subscription, and the subscription list itself.
///
/// The whole surface is a handful of endpoints returning `{ data }`. What is
/// worth care here is not the endpoints but the plumbing around them: which
/// address is tried, what counts as "no answer", and what a 401 means.
public actor ControlPlaneClient {

    /// The control plane said something, and it was not success.
    public struct ApiError: Error, Equatable {
        public let status: Int
        public let code: String
        public let message: String
    }

    public struct Subscription: Equatable {
        public let active: Bool
        public let state: String
        public let usedBytes: Int64
        public let quotaBytes: Int64
        public let expiresAt: String
        public let subscriptionUrl: String?
        public let profiles: [String]
    }

    /// What the deployment sells and how it takes payment. Public: no session.
    public struct ShopConfig: Equatable {
        public let paymentsConfigured: Bool
        public let payAddress: String?
        public let chain: String
        public let asset: String
        /// TRC-20 contract of the asset, for the wallet deep link.
        public let contract: String?
        public let confirmations: Int
        public let windowMinutes: Int
        public let supportContact: String?
        /// Whether this deployment can send the six-digit code at all. False
        /// when no mail relay is configured, and then the sign-in screen must
        /// not ask for a code: the control plane skips the check in that state,
        /// and a screen that asked anyway would be a field nobody can fill
        /// standing between every customer and their account.
        public let emailCodes: Bool
    }

    public struct Plan: Equatable {
        public let id: String
        public let name: String
        public let description: String?
        public let quotaBytes: Int64
        public let durationDays: Int
        public let priceMicro: Int64
        /// Which of the two things this plan buys: "vpn", the managed servers
        /// behind the switch, or "configs", the list to use here or carry to
        /// another client. They are sold separately and the Premium tab shows
        /// one at a time, so a card can never be ambiguous about what it is.
        ///
        /// Anything else — "all", from before the split — reads as vpn, which
        /// is the side that grant already covers.
        public let product: String
        /// "duration", sold by time, or "volume", sold by the gigabyte.
        public let billing: String

        public var isConfigs: Bool { product == "configs" }
    }

    /// An order. Amounts stay in micro-USDT (1 USDT = 1_000_000) — the same
    /// integer precision as TRC-20 USDT on chain, so the amount the app shows
    /// is exactly the amount the watcher matches against. A Double would round
    /// it, and a rounded amount is one the watcher never sees arrive.
    public struct Order: Equatable {
        public let id: String
        public let planName: String
        public let status: String
        public let quotaBytes: Int64
        public let durationDays: Int
        public let payAmountMicro: Int64
        public let payAddress: String?
        public let chain: String?
        public let asset: String?
        public let confirmations: Int
        public let txHash: String?
        public let expiresAt: String

        /// Still waiting on the customer. The two the storefront treats as one
        /// thing: "pending" has had nothing sent, "paid" is sent and not yet
        /// confirmed deeply enough to credit.
        public var awaitingCustomer: Bool { status == "pending" || status == "paid" }
    }

    /// One gateway as the subscription describes it.
    ///
    /// `routeState` is the control plane's verdict on the whole path — ingress
    /// and egress — which is the half the phone cannot measure for itself.
    public struct SubscriptionServer: Equatable {
        public let uri: String
        public let routeState: String?
        public let gatewayName: String?
        public let region: String?
    }

    private let endpoints: ControlPlaneEndpoints
    private let session: SessionStore
    private let transport: HttpTransport
    private let userAgent: String

    /// Set when the control plane rejects the stored session (401).
    ///
    /// The token is cleared at the same moment, so without this the app would
    /// sit on a signed-in-looking screen failing every call.
    public private(set) var sessionExpired = false

    public init(
        endpoints: ControlPlaneEndpoints,
        session: SessionStore,
        transport: HttpTransport,
        userAgent: String = "SyxVPN-iOS"
    ) {
        self.endpoints = endpoints
        self.session = session
        self.transport = transport
        self.userAgent = userAgent
    }

    public func clearExpired() { sessionExpired = false }

    // MARK: - endpoints

    public func shopConfig() async throws -> ShopConfig {
        let data = try await request("GET", "/api/v1/shop/config", body: nil, authenticated: false)
        let payment = data["payment"] as? [String: Any]
        return ShopConfig(
            paymentsConfigured: (payment?["configured"] as? Bool) ?? false,
            payAddress: payment?["address"] as? String,
            chain: (payment?["chain"] as? String) ?? "tron",
            asset: (payment?["asset"] as? String) ?? "USDT-TRC20",
            contract: payment?["contract"] as? String,
            confirmations: Int(number(payment?["confirmations"])),
            windowMinutes: Int(number(payment?["windowMinutes"])),
            supportContact: data["supportContact"] as? String,
            emailCodes: (data["emailCodes"] as? Bool) ?? false
        )
    }

    public func sendCode(email: String) async throws {
        let body = try jsonBody(["email": email])
        _ = try await request("POST", "/api/v1/shop/auth/code", body: body, authenticated: false)
    }

    /// One call for both ways in.
    ///
    /// Whether this address is new is the control plane's to work out. The code
    /// is omitted where the deployment has no relay to send one with — the
    /// control plane skips the check in exactly that state, so this is the same
    /// one call either way rather than a second way in.
    @discardableResult
    public func authenticate(
        email: String, password: String, code: String? = nil
    ) async throws -> String {
        var fields: [String: String] = ["email": email, "password": password]
        if let code { fields["code"] = code }
        let data = try await request(
            "POST", "/api/v1/shop/auth/session", body: try jsonBody(fields), authenticated: false
        )
        guard let token = data["token"] as? String else {
            throw ApiError(status: 200, code: "MALFORMED", message: "Unexpected response")
        }
        session.token = token
        session.email = email
        sessionExpired = false
        return token
    }

    public func signOut() async {
        _ = try? await request("POST", "/api/v1/shop/logout", body: "{}", authenticated: true)
        session.clear()
        sessionExpired = false
    }

    public func subscription() async throws -> Subscription? {
        let me = try await request("GET", "/api/v1/shop/me", body: nil, authenticated: true)
        // An account with no plan comes back as `"subscription": null`, which is
        // a value rather than a missing key — so this is a type check, not a
        // nil check.
        guard let sub = me["subscription"] as? [String: Any] else { return nil }
        let profiles = (sub["profiles"] as? [[String: Any]])?
            .compactMap { $0["uri"] as? String } ?? []
        let result = Subscription(
            active: (sub["active"] as? Bool) ?? false,
            state: (sub["state"] as? String) ?? "unknown",
            usedBytes: number(sub["usedBytes"]),
            quotaBytes: number(sub["quotaBytes"]),
            expiresAt: (sub["expiresAt"] as? String) ?? "",
            subscriptionUrl: sub["subscriptionUrl"] as? String,
            profiles: profiles
        )
        session.subscriptionUrl = result.subscriptionUrl
        session.cachedProfiles = result.profiles.joined(separator: "\n")
        return result
    }

    // MARK: - the store

    public func plans() async throws -> [Plan] {
        let rows = try await requestArray(
            "GET", "/api/v1/shop/plans", body: nil, authenticated: false
        )
        return rows.map { plan in
            Plan(
                id: (plan["id"] as? String) ?? "",
                name: (plan["name"] as? String) ?? "",
                description: plan["description"] as? String,
                quotaBytes: number(plan["quotaBytes"]),
                durationDays: Int(number(plan["durationDays"])),
                priceMicro: number(plan["priceMicro"]),
                product: (plan["product"] as? String) ?? "vpn",
                billing: (plan["billing"] as? String) ?? "duration"
            )
        }.filter { !$0.id.isEmpty }
    }

    /// Open an order.
    ///
    /// `units` is how many of the plan to buy at once, and only a plan sold by
    /// the gigabyte has a unit to multiply. The price is the published plan's,
    /// multiplied by the control plane rather than by this app: what the app
    /// shows while somebody is picking a size is an estimate of the same sum,
    /// and the amount that has to be paid is the one the order comes back with.
    public func createOrder(planId: String, units: Int = 1) async throws -> Order {
        let body = try JSONSerialization.data(
            withJSONObject: ["planId": planId, "units": units], options: [.sortedKeys]
        )
        return orderOf(try await request(
            "POST", "/api/v1/shop/orders",
            body: String(decoding: body, as: UTF8.self), authenticated: true
        ))
    }

    public func order(id: String) async throws -> Order {
        orderOf(try await request(
            "GET", "/api/v1/shop/orders/" + escape(id), body: nil, authenticated: true
        ))
    }

    /// The order the customer still has to pay, if there is one.
    public func openOrder() async throws -> Order? {
        let rows = try await requestArray(
            "GET", "/api/v1/shop/orders", body: nil, authenticated: true
        )
        return rows.map(orderOf).first { $0.awaitingCustomer }
    }

    public func cancelOrder(id: String) async throws {
        _ = try await request(
            "POST", "/api/v1/shop/orders/" + escape(id) + "/cancel",
            body: "{}", authenticated: true
        )
    }

    private func orderOf(_ order: [String: Any]) -> Order {
        Order(
            id: (order["id"] as? String) ?? "",
            planName: (order["planName"] as? String) ?? "",
            status: (order["status"] as? String) ?? "unknown",
            quotaBytes: number(order["quotaBytes"]),
            durationDays: Int(number(order["durationDays"])),
            payAmountMicro: number(order["payAmountMicro"]),
            payAddress: order["payAddress"] as? String,
            chain: order["chain"] as? String,
            asset: order["asset"] as? String,
            confirmations: Int(number(order["confirmations"])),
            txHash: order["txHash"] as? String,
            expiresAt: (order["expiresAt"] as? String) ?? ""
        )
    }

    /// An id in a path. Order ids are generated here and carry nothing exotic,
    /// but a value from the server going into a URL is escaped on principle.
    private func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    // MARK: - plumbing

    private func request(
        _ method: String, _ path: String, body: String?, authenticated: Bool
    ) async throws -> [String: Any] {
        let reply = try await send(method, path, body: body, authenticated: authenticated)
        guard let object = reply as? [String: Any] else {
            throw ApiError(status: 200, code: "MALFORMED", message: "Unexpected response")
        }
        return object
    }

    /// The request, and what each kind of failure means.
    private func send(
        _ method: String, _ path: String, body: String?, authenticated: Bool
    ) async throws -> Any {
        // No account, no call. A fresh install has no token, and sending the
        // request anyway would come back 401 and be read as a session that
        // expired — telling somebody who never had an account to sign in again.
        // Not signed in is a different thing from signed out by the server.
        if authenticated && session.token == nil {
            throw ApiError(status: 401, code: "NO_SESSION", message: "Not signed in")
        }

        var headers = [
            "Content-Type": "application/json",
            "User-Agent": userAgent,
        ]
        if authenticated, let token = session.token {
            headers["Authorization"] = "Bearer \(token)"
        }

        let reply = try await overAnyAddress(method: method, headers: headers, body: body) {
            $0 + path
        }
        let payload = (try? JSONSerialization.jsonObject(with: Data(reply.body.utf8)))
            as? [String: Any]

        if reply.status == 401 && authenticated {
            session.token = nil
            sessionExpired = true
            throw ApiError(status: 401, code: "UNAUTHORIZED", message: "Please sign in again")
        }
        if !(200...299).contains(reply.status) {
            let error = payload?["error"] as? [String: Any]
            throw ApiError(
                status: reply.status,
                code: (error?["code"] as? String) ?? "ERROR",
                message: (error?["message"] as? String)
                    ?? "Request failed (\(reply.status))"
            )
        }
        guard let data = payload?["data"] else {
            throw ApiError(status: reply.status, code: "MALFORMED", message: "Unexpected response")
        }
        return data
    }

    /// `{ data: [...] }` responses — plans and orders come back as lists.
    private func requestArray(
        _ method: String, _ path: String, body: String?, authenticated: Bool
    ) async throws -> [[String: Any]] {
        let reply = try await send(method, path, body: body, authenticated: authenticated)
        guard let rows = reply as? [[String: Any]] else {
            throw ApiError(status: 200, code: "MALFORMED", message: "Unexpected response")
        }
        return rows
    }

    /// The same request against each address until one answers.
    ///
    /// Only a network failure moves to the next: an HTTP status is an answer,
    /// and a 401 from the first address must not be retried as a 401 from all
    /// of them. The address that answered is remembered, so a dead first entry
    /// costs one failed connection rather than one on every request after it.
    private func overAnyAddress(
        method: String, headers: [String: String], body: String?, url: (String) -> String
    ) async throws -> HttpReply {
        var last: Error?
        for base in endpoints.ordered() {
            do {
                let reply = try await transport.exchange(
                    method: method, url: url(base), headers: headers, body: body
                )
                endpoints.worked(base)
                return reply
            } catch let unreachable as TransportUnreachable {
                endpoints.failed(base)
                last = unreachable
            }
        }
        throw ApiError(
            status: 0,
            code: "UNREACHABLE",
            message: (last as? TransportUnreachable).map {
                "Could not reach the control plane: \($0.reason)"
            } ?? "Could not reach the control plane"
        )
    }

    /// A JSON body, escaped by the serializer rather than by hand.
    private func jsonBody(_ fields: [String: String]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    /// Numbers arrive as numbers or as strings depending on how far they are
    /// past what JSON can hold exactly, and a quota in bytes is well past it.
    private func number(_ value: Any?) -> Int64 {
        if let n = value as? Int64 { return n }
        if let n = value as? Int { return Int64(n) }
        if let n = value as? Double { return Int64(n) }
        if let s = value as? String, let n = Int64(s) { return n }
        return 0
    }
}
