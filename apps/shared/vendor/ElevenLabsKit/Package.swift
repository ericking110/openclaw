// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "ElevenLabsKit",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "ElevenLabsKit", targets: ["ElevenLabsKit"]),
    ],
    targets: [
        .target(
            name: "ElevenLabsKit",
            dependencies: []),
    ])
