// swift-tools-version: 5.9
import PackageDescription

/// The half of the app that has no platform in it.
///
/// Profile parsing, configuration building, server choice: the code that
/// decides what the tunnel connects to, and the code most worth being sure
/// about. It is a package rather than a folder in the app target so that it
/// builds and tests on its own — including on a machine with no Xcode, which
/// is where most of it was written.
let package = Package(
    name: "SyxVPNCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "SyxVPNCore", targets: ["SyxVPNCore"]),
    ],
    targets: [
        .target(name: "SyxVPNCore"),
        .testTarget(name: "SyxVPNCoreTests", dependencies: ["SyxVPNCore"]),
    ]
)
