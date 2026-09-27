import Foundation

enum CaptureLog {
  static func line(_ message: String) {
    fputs("\(message)\n", stderr)
    fflush(stderr)
  }
}
