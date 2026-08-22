// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "CaptureHelper",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "CaptureHelper",
      path: "Sources"
    ),
  ]
)
