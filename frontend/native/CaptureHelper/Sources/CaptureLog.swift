import Foundation

enum CaptureLog {
  /// Buffer, level, and device traces. Off so a recording does not fill the terminal.
  static let enabled = false

  static func line(_ message: String) {
    guard enabled else { return }
    fputs("\(message)\n", stderr)
    fflush(stderr)
  }
}
