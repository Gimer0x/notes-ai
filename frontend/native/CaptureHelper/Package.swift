// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "CaptureHelper",
  platforms: [.macOS("14.2")],
  targets: [
    .executableTarget(
      name: "CaptureHelper",
      path: "Sources"
    ),
  ]
)
