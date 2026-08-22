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
  private var lastMicLevel = 0.0
  private var lastSystemLevel = 0.0
  private var lastMicBufferAt = Date.distantPast
  private var lastSystemBufferAt = Date.distantPast
  private var levelsTimer: DispatchSourceTimer?
  private var recording = false
  private var lastInputUID = ""
  private var lastInputName = ""
  private var ignoreConfigUntil = Date.distantPast
  private var reconnecting = false
  private var pendingReconnectReason: String?
  private var reconnectWork: DispatchWorkItem?
  private var pollCounter = 0
  private var cancelHardwareWatch: (() -> Void)?
  private var configObserver: NSObjectProtocol?
  private let reconnectQueue = DispatchQueue(label: "dev.pith.capture.reconnect")

  var onLevels: ((Double, Double) -> Void)?
  var onDevice: ((String, Bool) -> Void)?

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  func currentState() -> String {
    withLock { state }
  }

  func currentInputName() -> String {
    withLock { lastInputName }
  }

  func preview() async throws -> (systemAudioEnabled: Bool, inputName: String) {
    let session = withLock { state }
    if session == "listening" || session == "paused" {
      return withLock { (systemAudioEnabled, lastInputName) }
    }
    try await ensureInputs()
    withLock {
      recording = false
      paused = false
      state = "idle"
    }
    return withLock { (systemAudioEnabled, lastInputName) }
  }

  func start() async throws -> (systemAudioEnabled: Bool, inputName: String) {
    let busy = withLock { state != "idle" }
    if busy {
      throw CaptureError.alreadyRunning
    }

    try await ensureInputs()
    resetBuffers()
    withLock {
      recording = true
      paused = false
      state = "listening"
    }
    return withLock { (systemAudioEnabled, lastInputName) }
  }

  func pause() throws {
    try withLock {
      guard state == "listening" else { throw CaptureError.notListening }
      paused = true
      state = "paused"
      lastMicLevel = 0
      lastSystemLevel = 0
    }
    onLevels?(0, 0)
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

    endRecording()

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
    resetBuffers()
    return (url, duration, snapshot.2)
  }

  func cancel() async {
    endRecording()
    deleteLastTemp()
    resetBuffers()
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

  private func ensureInputs() async throws {
    for _ in 0..<30 {
      if !withLock({ reconnecting }) {
        break
      }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    if engine == nil {
      try await requestMicrophone()
      try await startMicrophoneRetrying()
    }
    if stream == nil, Self.systemAudioSupported {
      do {
        try await startSystemAudio()
        withLock { systemAudioEnabled = true }
      } catch {
        withLock { systemAudioEnabled = false }
        fputs("system audio unavailable: \(error.localizedDescription)\n", stderr)
      }
    }
    startLevelsTimer()
    rememberInput(AudioDevices.defaultInput())
    startDeviceWatch()
  }

  private func startMicrophone() throws {
    ignoreConfigUntil = Date().addingTimeInterval(1.0)
    let audioEngine = AVAudioEngine()
    let input = audioEngine.inputNode
    do {
      try input.setVoiceProcessingEnabled(false)
    } catch {
      // Some devices do not support voice processing; ignore.
    }
    audioEngine.prepare()
    do {
      try audioEngine.start()
      let format = input.inputFormat(forBus: 0)
      fputs(
        "mic format sampleRate=\(format.sampleRate) channels=\(format.channelCount)\n",
        stderr
      )
      if format.sampleRate <= 0 || format.channelCount <= 0 {
        throw NSError(domain: "CaptureHelper", code: 2, userInfo: [
          NSLocalizedDescriptionKey: "mic_format",
        ])
      }
      input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
        self?.append(buffer: buffer, system: false)
      }
      engine = audioEngine
    } catch {
      audioEngine.inputNode.removeTap(onBus: 0)
      audioEngine.stop()
      throw error
    }
  }

  private func startMicrophoneRetrying() async throws {
    var lastError: Error?
    for attempt in 1...6 {
      do {
        try startMicrophone()
        return
      } catch {
        lastError = error
        fputs("mic start attempt \(attempt) failed: \(error.localizedDescription)\n", stderr)
        if let engine {
          engine.inputNode.removeTap(onBus: 0)
          engine.stop()
        }
        engine = nil
        try await Task.sleep(nanoseconds: 300_000_000)
      }
    }
    throw lastError ?? NSError(domain: "CaptureHelper", code: 2, userInfo: [
      NSLocalizedDescriptionKey: "mic_format",
    ])
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
    scheduleReconnect(reason: "sck_stop")
  }

  private func append(buffer: AVAudioPCMBuffer, system: Bool) {
    let snapshot = withLock { (paused, recording) }
    if snapshot.0 {
      return
    }
    let samples: [Int16]
    if system {
      samples = AudioConvert.int16Mono16k(buffer, converterCache: &systemConverterCache)
    } else {
      samples = AudioConvert.int16Mono16k(buffer, converterCache: &micConverterCache)
    }
    guard !samples.isEmpty else { return }
    let level = AudioConvert.displayLevel(samples)
    withLock {
      if system {
        lastSystemLevel = level
        lastSystemBufferAt = Date()
        if snapshot.1 {
          systemSamples.append(contentsOf: samples)
        }
      } else {
        lastMicLevel = level
        lastMicBufferAt = Date()
        if snapshot.1 {
          micSamples.append(contentsOf: samples)
        }
      }
    }
  }

  private func teardownInputs() async {
    stopDeviceWatch()
    stopLevelsTimer()
    onLevels?(0, 0)
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
    withLock { recording = false }
  }

  private func startLevelsTimer() {
    stopLevelsTimer()
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInteractive))
    timer.schedule(deadline: .now(), repeating: .milliseconds(50))
    timer.setEventHandler { [weak self] in
      self?.emitLevels()
    }
    timer.resume()
    levelsTimer = timer
  }

  private func stopLevelsTimer() {
    levelsTimer?.cancel()
    levelsTimer = nil
  }

  private func emitLevels() {
    let snapshot = withLock { () -> (String, Bool, Double, Double, Date, Date) in
      (
        state,
        paused,
        lastMicLevel,
        lastSystemLevel,
        lastMicBufferAt,
        lastSystemBufferAt
      )
    }
    if snapshot.0 == "paused" || snapshot.1 {
      onLevels?(0, 0)
      return
    }
    let now = Date()
    let mic = now.timeIntervalSince(snapshot.4) < 0.15 ? snapshot.2 : 0
    let system = now.timeIntervalSince(snapshot.5) < 0.15 ? snapshot.3 : 0
    onLevels?(mic, system)
    pollCounter += 1
    if pollCounter >= 20 {
      pollCounter = 0
      pollDefaultInput()
    }
  }

  private func pollDefaultInput() {
    if withLock({ reconnecting }) {
      return
    }
    let next = AudioDevices.defaultInput()
    let (uid, hasEngine) = withLock { (lastInputUID, engine != nil) }
    if next == nil {
      if hasEngine || !uid.isEmpty {
        scheduleReconnect(reason: "poll_none")
      }
      return
    }
    if next?.uid != uid || !hasEngine {
      scheduleReconnect(reason: "poll")
    }
  }

  private func resetBuffers() {
    withLock {
      micSamples.removeAll(keepingCapacity: true)
      systemSamples.removeAll(keepingCapacity: true)
    }
  }

  private func endRecording() {
    withLock {
      recording = false
      paused = false
      state = "idle"
    }
  }

  private func setIdle() {
    endRecording()
  }

  private func deleteLastTemp() {
    if let lastTempURL {
      try? FileManager.default.removeItem(at: lastTempURL)
    }
    lastTempURL = nil
  }

  // MARK: - Device change

  private func startDeviceWatch() {
    if cancelHardwareWatch == nil {
      cancelHardwareWatch = AudioDevices.observeDefaults(queue: reconnectQueue) { [weak self] reason in
        self?.scheduleReconnect(reason: reason)
      }
    }
    if configObserver == nil {
      configObserver = NotificationCenter.default.addObserver(
        forName: .AVAudioEngineConfigurationChange,
        object: nil,
        queue: .main
      ) { [weak self] notification in
        guard let self else { return }
        guard notification.object as AnyObject? === self.engine else { return }
        if Date() < self.ignoreConfigUntil {
          return
        }
        self.scheduleReconnect(reason: "engine_config")
      }
    }
  }

  private func stopDeviceWatch() {
    reconnectWork?.cancel()
    reconnectWork = nil
    cancelHardwareWatch?()
    cancelHardwareWatch = nil
    if let configObserver {
      NotificationCenter.default.removeObserver(configObserver)
    }
    configObserver = nil
  }

  private func scheduleReconnect(reason: String) {
    reconnectWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      Task { await self?.reconnectTaps(reason: reason) }
    }
    reconnectWork = work
    reconnectQueue.asyncAfter(deadline: .now() + 0.5, execute: work)
  }

  private func reconnectTaps(reason: String) async {
    if withLock({ reconnecting }) {
      withLock { pendingReconnectReason = reason }
      return
    }
    withLock {
      reconnecting = true
      pendingReconnectReason = nil
    }
    defer {
      let again = withLock { () -> String? in
        reconnecting = false
        let pending = pendingReconnectReason
        pendingReconnectReason = nil
        return pending
      }
      if let again {
        scheduleReconnect(reason: again)
      }
    }

    let next = AudioDevices.defaultInput()
    let previousName = withLock { lastInputName }
    let previousUID = withLock { lastInputUID }

    if reason == "default_output",
       let next, next.uid == previousUID, engine != nil
    {
      await rebindSystemAudio()
      return
    }

    if reason != "engine_config", reason != "sck_stop", reason != "poll",
       reason != "poll_none",
       let next, next.uid == previousUID, engine != nil
    {
      if next.name != previousName {
        rememberInput(next)
      }
      return
    }

    fputs(
      "device change reason=\(reason) old=\(previousName) new=\(next?.name ?? "")\n",
      stderr
    )

    guard let next else {
      await dropMicrophone(keepSystem: true)
      return
    }

    rememberInput(next)

    do {
      try await rebindMicrophone()
      fputs("mic reconnect ok device=\(next.name)\n", stderr)
    } catch {
      fputs("mic reconnect failed after retries: \(error.localizedDescription)\n", stderr)
      withLock {
        lastMicLevel = 0
        lastMicBufferAt = Date.distantPast
      }
    }

    if withLock({ systemAudioEnabled }) || stream != nil {
      await rebindSystemAudio()
    }
  }

  private func rebindMicrophone() async throws {
    ignoreConfigUntil = Date().addingTimeInterval(1.0)
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      engine.reset()
    }
    engine = nil
    micConverterCache.removeAll()
    try await startMicrophoneRetrying()
  }

  private func rebindSystemAudio() async {
    if let stream {
      try? await stream.stopCapture()
    }
    stream = nil
    systemConverterCache.removeAll()
    guard Self.systemAudioSupported else { return }
    do {
      try await startSystemAudio()
      withLock { systemAudioEnabled = true }
      fputs("system audio reconnect ok\n", stderr)
    } catch {
      withLock { systemAudioEnabled = false }
      fputs("system audio reconnect failed: \(error.localizedDescription)\n", stderr)
    }
  }

  private func dropMicrophone(keepSystem: Bool) async {
    ignoreConfigUntil = Date().addingTimeInterval(0.6)
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    engine = nil
    micConverterCache.removeAll()
    withLock {
      lastMicLevel = 0
      lastMicBufferAt = Date.distantPast
      lastInputUID = ""
      lastInputName = ""
    }
    onDevice?("", true)
    if !keepSystem {
      if let stream {
        try? await stream.stopCapture()
      }
      stream = nil
    }
  }

  private func rememberInput(_ device: AudioInputDevice?) {
    let name = device?.name ?? ""
    let uid = device?.uid ?? ""
    withLock {
      lastInputName = name
      lastInputUID = uid
    }
    onDevice?(name, name.isEmpty)
  }
}
