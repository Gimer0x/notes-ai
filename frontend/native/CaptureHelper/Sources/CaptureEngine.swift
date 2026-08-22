import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

enum CaptureError: String, Error {
  case alreadyRunning = "already_running"
  case notListening = "not_listening"
  case notPaused = "not_paused"
  case micDenied = "mic_denied"
  case empty = "empty"
  case tooShort = "too_short"
}

final class CaptureEngine: NSObject, SCStreamOutput, SCStreamDelegate {
  private let lock = NSLock()
  private var state: String = "idle"
  private var systemAudioEnabled = false
  private var paused = false

  private var engine: AVAudioEngine?
  private var stream: SCStream?
  private var micConverterCache: [String: AVAudioConverter] = [:]
  private var systemConverterCache: [String: AVAudioConverter] = [:]
  private var micSamples: [Int16] = []
  private var systemSamples: [Int16] = []
  private var lastTempURL: URL?

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  func currentState() -> String {
    withLock { state }
  }

  func start() async throws -> Bool {
    let busy = withLock { state != "idle" }
    if busy {
      throw CaptureError.alreadyRunning
    }

    resetBuffers()
    try await requestMicrophone()
    try startMicrophone()

    var enabled = false
    if Self.systemAudioSupported {
      do {
        try await startSystemAudio()
        enabled = true
      } catch {
        enabled = false
        fputs("system audio unavailable: \(error.localizedDescription)\n", stderr)
      }
    }

    withLock {
      systemAudioEnabled = enabled
      paused = false
      state = "listening"
    }
    return enabled
  }

  func pause() throws {
    try withLock {
      guard state == "listening" else { throw CaptureError.notListening }
      paused = true
      state = "paused"
    }
  }

  func resume() throws {
    try withLock {
      guard state == "paused" else { throw CaptureError.notPaused }
      paused = false
      state = "listening"
    }
  }

  func stop() async throws -> (url: URL, duration: Double, systemAudioEnabled: Bool) {
    let current = withLock { state }
    guard current == "listening" || current == "paused" else {
      throw CaptureError.notListening
    }

    await teardownInputs()

    let snapshot = withLock { (micSamples, systemSamples, systemAudioEnabled) }

    let mixed = AudioConvert.mix(snapshot.0, snapshot.1)
    let micPeak = snapshot.0.map { abs(Int32($0)) }.max() ?? 0
    let sysPeak = snapshot.1.map { abs(Int32($0)) }.max() ?? 0
    fputs(
      "mix mic=\(snapshot.0.count) system=\(snapshot.1.count) mixed=\(mixed.count) micPeak=\(micPeak) sysPeak=\(sysPeak)\n",
      stderr
    )
    guard !mixed.isEmpty else {
      setIdle()
      throw CaptureError.empty
    }
    let duration = Double(mixed.count) / Double(WavWriter.sampleRate)
    guard duration >= 0.5 else {
      setIdle()
      throw CaptureError.tooShort
    }

    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("pith-\(UUID().uuidString).wav")
    try WavWriter.writeCanonical(samples: mixed, to: url)
    deleteLastTemp()
    lastTempURL = url
    setIdle()
    return (url, duration, snapshot.2)
  }

  func cancel() async {
    await teardownInputs()
    deleteLastTemp()
    resetBuffers()
    setIdle()
  }

  // MARK: - Permissions and sources

  private static var systemAudioSupported: Bool {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return version.majorVersion > 14
      || (version.majorVersion == 14 && version.minorVersion >= 2)
  }

  private func requestMicrophone() async throws {
    let granted = await AVAudioApplication.requestRecordPermission()
    fputs("mic permission granted=\(granted)\n", stderr)
    if !granted {
      throw CaptureError.micDenied
    }
  }

  private func startMicrophone() throws {
    let audioEngine = AVAudioEngine()
    let input = audioEngine.inputNode
    do {
      try input.setVoiceProcessingEnabled(false)
    } catch {
      // Some devices do not support voice processing; ignore.
    }
    input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
      self?.append(buffer: buffer, system: false)
    }
    audioEngine.prepare()
    try audioEngine.start()
    let format = input.inputFormat(forBus: 0)
    fputs(
      "mic format sampleRate=\(format.sampleRate) channels=\(format.channelCount)\n",
      stderr
    )
    engine = audioEngine
  }

  private func startSystemAudio() async throws {
    _ = CGRequestScreenCaptureAccess()
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else {
      throw NSError(domain: "CaptureHelper", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "no_display",
      ])
    }

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 48_000
    config.channelCount = 2
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.showsCursor = false
    config.queueDepth = 3

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    let audioQueue = DispatchQueue(label: "dev.pith.capture.audio")
    let videoQueue = DispatchQueue(label: "dev.pith.capture.video")
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
    try await stream.startCapture()
    self.stream = stream
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    if type == .screen {
      return
    }
    if type == .audio, let buffer = AudioConvert.pcmBuffer(from: sampleBuffer) {
      append(buffer: buffer, system: true)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fputs("sck stream stopped: \(error.localizedDescription)\n", stderr)
  }

  private func append(buffer: AVAudioPCMBuffer, system: Bool) {
    let isPaused = withLock { paused || state == "idle" }
    if isPaused {
      return
    }
    let samples: [Int16]
    if system {
      samples = AudioConvert.int16Mono16k(buffer, converterCache: &systemConverterCache)
    } else {
      samples = AudioConvert.int16Mono16k(buffer, converterCache: &micConverterCache)
    }
    guard !samples.isEmpty else { return }
    withLock {
      if system {
        systemSamples.append(contentsOf: samples)
      } else {
        micSamples.append(contentsOf: samples)
      }
    }
  }

  private func teardownInputs() async {
    if let stream {
      try? await stream.stopCapture()
    }
    stream = nil
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    engine = nil
    micConverterCache.removeAll()
    systemConverterCache.removeAll()
  }

  private func resetBuffers() {
    withLock {
      micSamples.removeAll(keepingCapacity: true)
      systemSamples.removeAll(keepingCapacity: true)
    }
  }

  private func setIdle() {
    withLock {
      state = "idle"
      paused = false
      systemAudioEnabled = false
    }
  }

  private func deleteLastTemp() {
    if let lastTempURL {
      try? FileManager.default.removeItem(at: lastTempURL)
    }
    lastTempURL = nil
  }
}
