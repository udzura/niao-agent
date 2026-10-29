// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "NiaoCore", platforms: [.macOS(.v14)],
    targets: [
        .target(name: "NiaoCore", path: "Niao", exclude: ["NiaoApp.swift", "ChatView.swift", "ChatStore.swift", "Keychain.swift", "Assets.xcassets", "UsageView.swift", "ToolStatisticsView.swift", "ChatMarkdownView.swift"], sources: ["Models.swift", "Backend.swift", "ToolStatistics.swift", "ChatMarkdown.swift"]),
        .testTarget(name: "NiaoCoreTests", dependencies: ["NiaoCore"], path: "Tests")
    ]
)
