import Foundation

/// A country, worked out from what the control plane already publishes.
///
/// Nothing here is invented. A gateway carries a free-text `region`, and the
/// convention this control plane uses is an ISO country code first — `de-fra`,
/// `nl-ams`, `tr-ist`. When that is what the region looks like, and the code is
/// a real ISO country, the phone can name it and show its flag. When it is not
/// — `eu`, `lab`, anything an operator typed — there is no country, and the row
/// says so by showing the gateway's own name instead of a flag it guessed.
public struct Country: Equatable {
    public let code: String
    public let name: String
    public let flag: String
}

/// The flag as regional-indicator letters, which is how every phone draws one
/// without shipping image assets.
public func flagEmoji(_ code: String) -> String? {
    let upper = code.uppercased()
    guard upper.count == 2 else { return nil }
    let base: UInt32 = 0x1F1E6
    var out = ""
    for character in upper.unicodeScalars {
        guard character.value >= 65, character.value <= 90 else { return nil }
        guard let scalar = Unicode.Scalar(base + (character.value - 65)) else { return nil }
        out.unicodeScalars.append(scalar)
    }
    return out
}

private let isoCountries: Set<String> = Set(Locale.isoRegionCodes)

/// Turns `de-fra`, `DE` or `de_fra` into Germany. Anything else returns nil.
public func countryOfRegion(_ region: String?) -> Country? {
    let trimmed = (region ?? "").trimmed
    guard trimmed.count >= 2 else { return nil }
    let characters = Array(trimmed)
    let head = String(characters[0...1]).uppercased()
    // Two letters, then either nothing or a separator: "de", "de-fra", "de_fra".
    guard head.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
    if characters.count > 2, characters[2] != "-", characters[2] != "_" { return nil }
    guard isoCountries.contains(head) else { return nil }
    guard let flag = flagEmoji(head) else { return nil }
    let name = Locale(identifier: "en_US").localizedString(forRegionCode: head) ?? head
    return Country(code: head, name: name.isEmpty ? head : name, flag: flag)
}

/// The same, but also willing to read the label the control plane writes into a
/// profile — `Frankfurt Edge · de-fra` — because a subscription fetched as a
/// plain base64 list carries no region field at all.
///
/// Every segment is tried, from the right, rather than only the last one. A
/// gateway that offers more than one protocol names which one at the end of the
/// label — `Frankfurt Edge · de-fra · shadowsocks` — and a reader that looked
/// only at the last segment filed all of those under "other servers", on exactly
/// the clients that have no region field to fall back on.
public func countryOf(_ server: Server) -> Country? {
    if let fromRegion = countryOfRegion(server.region) { return fromRegion }
    for segment in server.profile.label.split(separator: "·").reversed() {
        if let found = countryOfRegion(String(segment).trimmed) { return found }
    }
    return nil
}

/// One country, and the gateways in it.
public struct CountryGroup {
    public static let other = "other"

    public let country: Country?
    public let servers: [Server]

    /// Stable identity: the ISO code, or "other" for the unplaceable ones.
    public var key: String { country?.code ?? Self.other }

    public var name: String { country?.name ?? "Other servers" }

    /// The worst thing the control plane says about any route in this country.
    public var routeState: RouteState {
        servers.map(\.routeState).min(by: { $0.rank < $1.rank }) ?? .unknown
    }
}

/// Groups the subscription's servers by country, for the plain VPN screen.
///
/// Order is by name so the list does not jump around between refreshes, with the
/// unplaceable servers last — they are still offered, just not pretending to be
/// somewhere. A country keeps its servers in the order the control plane gave
/// them, which is its own priority.
public func groupByCountry(_ servers: [Server]) -> [CountryGroup] {
    var order: [String] = []
    var groups: [String: [Server]] = [:]
    var countries: [String: Country?] = [:]
    for server in servers {
        let country = countryOf(server)
        let key = country?.code ?? CountryGroup.other
        if groups[key] == nil { order.append(key) }
        countries[key] = country
        groups[key, default: []].append(server)
    }
    let built = order.map { key in
        CountryGroup(country: countries[key] ?? nil, servers: groups[key] ?? [])
    }
    return built.sorted { left, right in
        let leftLast = left.country == nil ? 1 : 0
        let rightLast = right.country == nil ? 1 : 0
        if leftLast != rightLast { return leftLast < rightLast }
        return left.name < right.name
    }
}
