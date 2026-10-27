// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "NiaoCore", platforms: [.macOS(.v14)],
    targets: [
        .target(name: "NiaoCore", path: "Niao", exclude: ["NiaoApp.swift", "ChatView.swift", "ChatStore.swift", "Keychain.swift", "Assets.xcassets", "UsageView.swift"], sources: ["Models.swift", "Backend.swift"]),
        .testTarget(name: "NiaoCoreTests", dependencies: ["NiaoCore"], path: "Tests")
    ]
)
