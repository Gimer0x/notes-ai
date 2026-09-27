import AVFoundation
import CoreAudio
import Foundation

/// JSON contract used by Electron. Do not rename commands or fields.
/// preview | start | pause | resume | stop | cancel | state
/// events: levels { mic, system }, device { inputName, lost }
/// WAV: 16-bit PCM, mono, 16 kHz. Samples survive a device handover.

enum CaptureError: String, Error {
  case notListening = "not_listening"
  case notPaused = "not_paused"
  case micDenied = "mic_denied"
  case empty = "empty"
  case tooShort = "too_short"
}

struct AudioDeviceInfo: Equatable {
  let id: AudioDeviceID
  let uid: String
  let name: String
  let transport: UInt32
  let sampleRate: Double
  let channels: UInt32

  var isBluetooth: Bool {
    transport == kAudioDeviceTransportTypeBluetooth
      || transport == kAudioDeviceTransportTypeBluetoothLE
  }

  var summary: String {
    "name=\(name) uid=\(uid) transport=\(transportName) sr=\(sampleRate) ch=\(channels)"
  }

  var transportName: String {
    switch transport {
    case kAudioDeviceTransportTypeBluetooth: return "bluetooth"
    case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth_le"
    case kAudioDeviceTransportTypeBuiltIn: return "builtin"
    case kAudioDeviceTransportTypeUSB: return "usb"
    default: return String(transport, radix: 16)
    }
  }
}

struct DeviceSnapshot: Equatable {
  var input: AudioDeviceInfo?
  var output: AudioDeviceInfo?
}

struct RouteChange {
  let previous: DeviceSnapshot
  let next: DeviceSnapshot

  var inputChanged: Bool { (previous.input?.uid ?? "") != (next.input?.uid ?? "") }
  var outputChanged: Bool { (previous.output?.uid ?? "") != (next.output?.uid ?? "") }

  /// Same device, new rate or channel count. AVAudioEngine can stop when this happens.
  var inputFormatChanged: Bool { Self.formatChanged(previous.input, next.input) }
  var outputFormatChanged: Bool { Self.formatChanged(previous.output, next.output) }

  private static func formatChanged(_ previous: AudioDeviceInfo?, _ next: AudioDeviceInfo?) -> Bool {
    guard let previous, let next, previous.uid == next.uid, !previous.uid.isEmpty else { return false }
    return abs(previous.sampleRate - next.sampleRate) > 1 || previous.channels != next.channels
  }
}

protocol DeviceRouting: AnyObject {
  var onRouteChange: ((RouteChange) -> Void)? { get set }
  func start()
  func stop()
  func rememberCurrent()
  func suppress(for seconds: TimeInterval)
}

protocol MicrophoneCapturing: AnyObject {
  var onBuffer: ((AVAudioPCMBuffer, UInt64) -> Void)? { get set }
  var onConfigurationChange: (() -> Void)? { get set }
  var isRunning: Bool { get }
  func start(device: AudioDeviceInfo) throws
  func stop()
}

protocol SystemAudioCapturing: AnyObject {
  var onBuffer: ((AVAudioPCMBuffer, UInt64) -> Void)? { get set }
  var isRunning: Bool { get }
  func start() throws
  func stop()
}

final class SerialGate: @unchecked Sendable {
  private let lock = NSLock()
  private var busy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func run<T>(_ body: () async throws -> T) async rethrows -> T {
    await acquire()
    defer { release() }
    return try await body()
  }

  private func acquire() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if !busy {
        busy = true
        lock.unlock()
        continuation.resume()
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }

  private func release() {
    lock.lock()
    if waiters.isEmpty {
      busy = false
      lock.unlock()
      return
    }
    let next = waiters.removeFirst()
    lock.unlock()
    next.resume()
  }
}

final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false

  func go() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if done { return false }
    done = true
    return true
  }
}
