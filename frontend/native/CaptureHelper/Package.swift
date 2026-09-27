// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "CaptureHelper",
  platforms: [.macOS("14.2")],
  targets: [
    .target(
      name: "ExceptionCatcher",
      path: "ExceptionCatcher",
      publicHeadersPath: "include"
    ),
    .executableTarget(
      name: "CaptureHelper",
      dependencies: ["ExceptionCatcher"],
      path: "Sources"
    ),
  ]
)
