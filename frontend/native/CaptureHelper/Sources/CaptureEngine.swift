import AVFoundation
import CoreAudio
import CoreGraphics
import Foundation

enum CaptureError: String, Error {
  case alreadyRunning = "already_running"
  case notListening = "not_listening"
  case notPaused = "not_paused"
  case micDenied = "mic_denied"
  case empty = "empty"
  case tooShort = "too_short"
}

private final class Slot<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: T?
  func set(_ next: T) {
    lock.lock()
    value = next
    lock.unlock()
  }
  func get() -> T? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

private final class AsyncLock: @unchecked Sendable {
  private let lock = NSLock()
  private var busy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func withLock<T>(_ body: () async throws -> T) async rethrows -> T {
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

/// Audio-only capture: AVAudioEngine mic + Core Audio process tap (system playback).
/// Device switches never discard already-captured samples.
final class CaptureEngine: NSObject, @unchecked Sendable {
  private let lock = NSLock()
  private var state: String = "idle"
  private var systemAudioEnabled = false
  private var paused = false

  private var engine: AVAudioEngine?
  private var processTap: SystemAudioTap?
  private var micConverterCache: [String: AVAudioConverter] = [:]
  private var systemConverterCache: [String: AVAudioConverter] = [:]
  private var micSamples: [Int16] = []
  private var systemSamples: [Int16] = []
  private var lastTempURLs: [URL] = []
  private var lastMicLevel = 0.0
  private var lastSystemLevel = 0.0
  private var lastMicBufferAt = Date.distantPast
  private var lastSystemBufferAt = Date.distantPast
  private var lastMicSampleEnd: Date?
  private var lastSystemSampleEnd: Date?
  private var lastMicRebindAt = Date.distantPast
  private var lastSystemRebindAt = Date.distantPast
  private var consecutiveMicStale = 0
  private var consecutiveSystemStale = 0
  private var levelsTimer: DispatchSourceTimer?
  private var recording = false
  private var noteActive = false
  private var stopRequested = false
  private var lastInputUID = ""
  private var lastInputName = ""
  private var lastInputBluetooth = false
  private var lastOutputUID = ""
  private var lastOutputSampleRate = 0.0
  private var lastOutputChannels: UInt32 = 0
  private var lastOutputBluetooth = false
  private var ignoreConfigUntil = Date.distantPast
  private var reconnecting = false
  private var pendingReconnectReason: String?
  private var reconnectWork: DispatchWorkItem?
  private var pollCounter = 0
  private var micBufferCount = 0
  private var systemBufferCount = 0
  private var lastHeartbeatAt = Date.distantPast
  private var lastMicFormat = ""
  private var lastSystemFormat = ""
  private var micStartGeneration = 0
  private var frozenMic: [Int16] = []
  private var frozenSystem: [Int16] = []
  private var hasFrozenStop = false
  private var cancelHardwareWatch: (() -> Void)?
  private var configObserver: NSObjectProtocol?
  private let reconnectQueue = DispatchQueue(label: "dev.pith.capture.reconnect")
  private let commandLock = AsyncLock()

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
    try await commandLock.withLock {
      let live = withLock {
        (
          state,
          noteActive,
          recording,
          micSamples.count + systemSamples.count,
          hasFrozenStop
        )
      }
      if live.0 == "listening" || live.0 == "paused" || live.1 || live.2 || live.3 > 0 || live.4 {
        CaptureLog.line(
          "preview skipped; note still active state=\(live.0) note=\(live.1) rec=\(live.2) samples=\(live.3)"
        )
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
  }

  func start() async throws -> (systemAudioEnabled: Bool, inputName: String) {
    try await commandLock.withLock {
      let session = withLock { (state, noteActive, hasFrozenStop) }
      if session.2 {
        return withLock { (systemAudioEnabled, lastInputName) }
      }
      if session.0 == "listening" || session.0 == "paused" || session.1 {
        if engine == nil {
          try await ensureInputs()
        }
        withLock {
          stopRequested = false
          noteActive = true
          recording = true
          if state == "idle" {
            state = "listening"
          }
        }
        return withLock { (systemAudioEnabled, lastInputName) }
      }
      withLock {
        stopRequested = false
        noteActive = true
        recording = true
        paused = false
        state = "listening"
        let now = Date()
        lastMicSampleEnd = now
        lastSystemSampleEnd = now
      }
      try await ensureInputs()
      let counts = withLock { (micSamples.count, systemSamples.count) }
      if counts.0 + counts.1 > 0 {
        CaptureLog.line("continue note mix; keeping mic=\(counts.0) system=\(counts.1)")
      } else {
        CaptureLog.line("new note mix")
      }
      return withLock { (systemAudioEnabled, lastInputName) }
    }
  }

  func pause() throws {
    try withLock {
      guard state == "listening" || (noteActive && state != "paused") else {
        throw CaptureError.notListening
      }
      paused = true
      state = "paused"
      lastMicLevel = 0
      lastSystemLevel = 0
      lastMicSampleEnd = nil
      lastSystemSampleEnd = nil
    }
    onLevels?(0, 0)
  }

  func resume() throws {
    try withLock {
      guard state == "paused" else { throw CaptureError.notPaused }
      paused = false
      state = "listening"
      let now = Date()
      lastMicSampleEnd = now
      lastSystemSampleEnd = now
    }
  }

  func stop() async throws -> (
    url: URL,
    micURL: URL?,
    systemURL: URL?,
    duration: Double,
    systemAudioEnabled: Bool
  ) {
    let frozen = withLock { () -> (Int, Int, String, Bool, Bool) in
      stopRequested = true
      micStartGeneration += 1
      if !hasFrozenStop {
        alignTracksLocked(to: Date())
        frozenMic = micSamples
        frozenSystem = systemSamples
        hasFrozenStop = true
      }
      return (frozenMic.count, frozenSystem.count, state, noteActive, recording)
    }
    CaptureLog.line(
      "stop requested; aborting reconnect if in progress froze mic=\(frozen.0) sys=\(frozen.1) state=\(frozen.2) note=\(frozen.3) rec=\(frozen.4)"
    )
    return try await commandLock.withLock {
      try await finishListening()
    }
  }

  private func finishListening() async throws -> (
    url: URL,
    micURL: URL?,
    systemURL: URL?,
    duration: Double,
    systemAudioEnabled: Bool
  ) {
    let snapshot = withLock { () -> (String, Bool, Bool, Int, Int, Int, Int) in
      (
        state,
        noteActive,
        recording,
        micSamples.count,
        systemSamples.count,
        frozenMic.count,
        frozenSystem.count
      )
    }
    CaptureLog.line(
      "stop requested state=\(snapshot.0) note=\(snapshot.1) recording=\(snapshot.2) micN=\(snapshot.3) sysN=\(snapshot.4) frozeMic=\(snapshot.5) frozeSys=\(snapshot.6)"
    )
    guard
      snapshot.0 == "listening"
        || snapshot.0 == "paused"
        || snapshot.1
        || snapshot.2
        || snapshot.3 + snapshot.4 > 0
        || snapshot.5 + snapshot.6 > 0
    else {
      withLock {
        stopRequested = false
        hasFrozenStop = false
        frozenMic.removeAll(keepingCapacity: false)
        frozenSystem.removeAll(keepingCapacity: false)
      }
      throw CaptureError.notListening
    }

    endRecording()

    let tracks = withLock { () -> ([Int16], [Int16], Bool) in
      if hasFrozenStop, frozenMic.count + frozenSystem.count > 0 {
        return (frozenMic, frozenSystem, systemAudioEnabled)
      }
      alignTracksLocked(to: Date())
      return (micSamples, systemSamples, systemAudioEnabled)
    }

    let mixed = AudioConvert.mix(tracks.0, tracks.1)
    let micPeak = tracks.0.map { abs(Int32($0)) }.max() ?? 0
    let sysPeak = tracks.1.map { abs(Int32($0)) }.max() ?? 0
    CaptureLog.line(
      "mix mic=\(tracks.0.count) system=\(tracks.1.count) mixed=\(mixed.count) micPeak=\(micPeak) sysPeak=\(sysPeak) micFmt=\(lastMicFormat) sysFmt=\(lastSystemFormat)"
    )
    guard !mixed.isEmpty else {
      setIdle()
      await teardownInputs()
      onLevels?(0, 0)
      throw CaptureError.empty
    }
    let duration = Double(mixed.count) / Double(WavWriter.sampleRate)
    guard duration >= 0.5 else {
      setIdle()
      await teardownInputs()
      onLevels?(0, 0)
      throw CaptureError.tooShort
    }

    logPcmStats(tracks.0, label: "mic")
    logPcmStats(tracks.1, label: "system")
    logPcmStats(mixed, label: "mix")
    logEnergyTimeline(mic: tracks.0, system: tracks.1)

    let stamp = UUID().uuidString
    let dir = FileManager.default.temporaryDirectory
    let mixURL = dir.appendingPathComponent("pith-\(stamp)-mix.wav")
    let micURL = tracks.0.isEmpty ? nil : dir.appendingPathComponent("pith-\(stamp)-mic.wav")
    let systemURL = tracks.1.isEmpty ? nil : dir.appendingPathComponent("pith-\(stamp)-sys.wav")
    try WavWriter.writeCanonical(samples: mixed, to: mixURL)
    if let micURL {
      try WavWriter.writeCanonical(samples: tracks.0, to: micURL)
    }
    if let systemURL {
      try WavWriter.writeCanonical(samples: tracks.1, to: systemURL)
    }
    deleteLastTemp()
    lastTempURLs = [mixURL, micURL, systemURL].compactMap { $0 }
    resetBuffers()
    await teardownInputs()
    onLevels?(0, 0)
    CaptureLog.line(
      "capture stopped; hardware released mix=\(mixURL.lastPathComponent) mic=\(micURL?.lastPathComponent ?? "none") sys=\(systemURL?.lastPathComponent ?? "none")"
    )
    return (mixURL, micURL, systemURL, duration, tracks.2)
  }

  func cancel() async {
    withLock {
      stopRequested = true
      micStartGeneration += 1
    }
    await commandLock.withLock {
      endRecording()
      deleteLastTemp()
      resetBuffers()
      await teardownInputs()
      withLock { stopRequested = false }
      onLevels?(0, 0)
      CaptureLog.line("capture cancelled; hardware released")
    }
  }

  // MARK: - Permissions and sources

  private static var systemAudioSupported: Bool {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return version.majorVersion > 14
      || (version.majorVersion == 14 && version.minorVersion >= 2)
  }

  private func requestMicrophone() async throws {
    let granted = await AVAudioApplication.requestRecordPermission()
    CaptureLog.line("mic permission granted=\(granted)")
    if !granted {
      throw CaptureError.micDenied
    }
  }

  private func ensureInputs() async throws {
    if engine == nil {
      try await requestMicrophone()
      try await startMicrophoneRetrying()
    }
    if processTap == nil, Self.systemAudioSupported {
      do {
        try await startSystemAudio()
        withLock { systemAudioEnabled = processTap != nil }
      } catch {
        withLock { systemAudioEnabled = false }
        CaptureLog.line("system audio unavailable: \(error.localizedDescription)")
      }
    }
    startLevelsTimer()
    rememberInput(AudioDevices.preferredInput())
    startDeviceWatch()
  }

  private func sleepUnlessStop(nanoseconds: UInt64) async -> Bool {
    var remaining = nanoseconds
    let slice: UInt64 = 100_000_000
    while remaining > 0 {
      if withLock({ stopRequested }) {
        return false
      }
      let step = min(slice, remaining)
      try? await Task.sleep(nanoseconds: step)
      remaining -= step
    }
    return !withLock({ stopRequested })
  }

  private func startMicrophone(device: AudioInputDevice? = nil) async throws {
    let preferred = device ?? AudioDevices.preferredInput()
    guard let preferred, preferred.isUsableInput else {
      CaptureLog.line("mic start aborted; no usable input preferred=\(preferred?.summary ?? "none")")
      throw NSError(domain: "CaptureHelper", code: 2, userInfo: [
        NSLocalizedDescriptionKey: "mic_format",
      ])
    }
    ignoreConfigUntil = Date().addingTimeInterval(preferred.isBluetooth ? 4.0 : 2.0)
    CaptureLog.line(
      "mic start preferred=\(preferred.summary) default=\(AudioDevices.defaultInput()?.summary ?? "none")"
    )
    let generation = withLock { () -> Int in
      micStartGeneration += 1
      return micStartGeneration
    }
    let outcome = Slot<Result<Void, Error>>()
    Task.detached(priority: .userInitiated) { [weak self] in
      let result: Result<Void, Error>
      do {
        guard let self else { return }
        try self.startMicrophoneBlocking(preferred: preferred, generation: generation)
        result = .success(())
      } catch {
        result = .failure(error)
      }
      outcome.set(result)
    }
    var seen: Result<Void, Error>?
    for _ in 0..<50 {
      if withLock({ stopRequested || micStartGeneration != generation }) {
        CaptureLog.line("mic start aborted; stop requested")
        throw NSError(domain: "CaptureHelper", code: 4, userInfo: [
          NSLocalizedDescriptionKey: "mic_start_aborted",
        ])
      }
      seen = outcome.get()
      if seen != nil {
        break
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    if let seen {
      try seen.get()
    } else {
      CaptureLog.line("mic start timed out device=\(preferred.summary)")
      throw NSError(domain: "CaptureHelper", code: 4, userInfo: [
        NSLocalizedDescriptionKey: "mic_start_timeout",
      ])
    }
    if preferred.isBluetooth, withLock({ engine != nil && micStartGeneration == generation && !stopRequested }) {
      _ = await sleepUnlessStop(nanoseconds: 400_000_000)
    }
  }

  private func startMicrophoneBlocking(preferred: AudioInputDevice, generation: Int) throws {
    let audioEngine = AVAudioEngine()
    let input = audioEngine.inputNode
    do {
      try input.setVoiceProcessingEnabled(false)
    } catch {
      CaptureLog.line("mic voice processing off failed: \(error.localizedDescription)")
    }
    if let audioUnit = input.audioUnit {
      var deviceID = preferred.id
      let status = AudioUnitSetProperty(
        audioUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &deviceID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
      )
      CaptureLog.line("mic pin device status=\(status) id=\(preferred.id) uid=\(preferred.uid)")
      if status != noErr {
        throw NSError(domain: "CaptureHelper", code: Int(status), userInfo: [
          NSLocalizedDescriptionKey: "mic_pin \(status)",
        ])
      }
    } else {
      CaptureLog.line("mic pin skipped; no audioUnit")
    }
    audioEngine.prepare()
    if let audioUnit = input.audioUnit {
      var deviceID = preferred.id
      let status = AudioUnitSetProperty(
        audioUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &deviceID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
      )
      CaptureLog.line("mic pin after prepare status=\(status)")
      if status != noErr {
        audioEngine.stop()
        throw NSError(domain: "CaptureHelper", code: Int(status), userInfo: [
          NSLocalizedDescriptionKey: "mic_pin_prepare \(status)",
        ])
      }
    }
    do {
      try audioEngine.start()
      let format = input.inputFormat(forBus: 0)
      lastMicFormat = "sr=\(format.sampleRate) ch=\(format.channelCount)"
      CaptureLog.line("mic format \(lastMicFormat)")
      if preferred.isBluetooth {
        CaptureLog.line("mic using headphones input (headset mode is expected in conferences)")
      }
      if format.sampleRate <= 0 || format.channelCount <= 0 {
        throw NSError(domain: "CaptureHelper", code: 2, userInfo: [
          NSLocalizedDescriptionKey: "mic_format",
        ])
      }
      guard withLock({ micStartGeneration == generation && !stopRequested }) else {
        audioEngine.stop()
        throw NSError(domain: "CaptureHelper", code: 4, userInfo: [
          NSLocalizedDescriptionKey: "mic_start_aborted",
        ])
      }
      input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
        self?.append(buffer: buffer, system: false)
      }
      engine = audioEngine
      lastMicRebindAt = Date()
      lastMicBufferAt = Date()
      rememberInput(preferred)
    } catch {
      audioEngine.inputNode.removeTap(onBus: 0)
      audioEngine.stop()
      throw error
    }
  }

  private func stopMicrophoneEngine() async {
    guard let engine else { return }
    withLock { micStartGeneration += 1 }
    self.engine = nil
    let toStop = engine
    do {
      try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
          await Task.detached(priority: .userInitiated) {
            toStop.inputNode.removeTap(onBus: 0)
            toStop.stop()
            toStop.reset()
          }.value
        }
        group.addTask {
          try await Task.sleep(nanoseconds: 2_000_000_000)
          throw NSError(domain: "CaptureHelper", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "mic_stop_timeout",
          ])
        }
        try await group.next()!
        group.cancelAll()
      }
    } catch {
      CaptureLog.line("mic engine stop: \(error.localizedDescription)")
    }
  }

  private func startMicrophoneRetrying(preferred: AudioInputDevice? = nil) async throws {
    var lastError: Error?
    var failedUID = ""
    for attempt in 1...10 {
      let live = AudioDevices.preferredInput()
      let builtIn = AudioDevices.builtInInput()
      let device: AudioInputDevice?
      if attempt == 1 {
        device = preferred ?? live
      } else if let live, live.uid != failedUID {
        device = live
      } else if let builtIn, builtIn.uid != failedUID {
        CaptureLog.line("mic fallback to built-in after \(failedUID) failed")
        device = builtIn
      } else {
        device = live ?? builtIn
      }
      do {
        if withLock({ stopRequested }) {
          CaptureLog.line("mic start skipped; stop requested")
          throw NSError(domain: "CaptureHelper", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "mic_start_aborted",
          ])
        }
        try await startMicrophone(device: device)
        return
      } catch {
        lastError = error
        failedUID = device?.uid ?? failedUID
        CaptureLog.line(
          "mic start attempt \(attempt) failed: \(error.localizedDescription) tried=\(device?.summary ?? "none") live=\(live?.summary ?? "none")"
        )
        let aborted = error.localizedDescription.contains("mic_start_timeout")
          || error.localizedDescription.contains("mic_start_aborted")
        if aborted {
          withLock { ignoreConfigUntil = Date().addingTimeInterval(3.0) }
          throw error
        }
        if let engine {
          engine.inputNode.removeTap(onBus: 0)
          engine.stop()
        }
        engine = nil
        if await !sleepUnlessStop(nanoseconds: 400_000_000) {
          throw NSError(domain: "CaptureHelper", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "mic_start_aborted",
          ])
        }
      }
    }
    throw lastError ?? NSError(domain: "CaptureHelper", code: 2, userInfo: [
      NSLocalizedDescriptionKey: "mic_format",
    ])
  }

  private func startSystemAudio() async throws {
    _ = CGRequestScreenCaptureAccess()
    try startProcessTap()
  }

  private func startProcessTap() throws {
    let output = AudioDevices.defaultOutput()
    rememberOutput(output)
    let tap = SystemAudioTap()
    tap.onBuffer = { [weak self] buffer in
      self?.append(buffer: buffer, system: true)
    }
    CaptureLog.line("system tap start output=\(output?.summary ?? "none") bindUID=global")
    try tap.start()
    processTap = tap
    lastSystemRebindAt = Date()
    lastSystemBufferAt = Date()
    consecutiveSystemStale = 0
    CaptureLog.line("system audio process tap started output=\(output?.name ?? "")")
  }

  private func stopProcessTap() {
    processTap?.stop()
    processTap = nil
  }

  private func append(buffer: AVAudioPCMBuffer, system: Bool) {
    let snapshot = withLock { (paused, recording || noteActive) }
    if snapshot.0 {
      return
    }
    let format = "sr=\(buffer.format.sampleRate) ch=\(buffer.format.channelCount) frames=\(buffer.frameLength)"
    let samples: [Int16]
    if system {
      samples = AudioConvert.int16Mono16k(buffer, converterCache: &systemConverterCache)
    } else {
      samples = AudioConvert.int16Mono16k(buffer, converterCache: &micConverterCache)
    }
    guard !samples.isEmpty else { return }
    let level = AudioConvert.displayLevel(samples)
    let peak = samples.map { abs(Int32($0)) }.max() ?? 0
    let now = Date()
    let count = withLock { () -> Int in
      if system {
        lastSystemLevel = level
        lastSystemBufferAt = now
        lastSystemFormat = format
        systemBufferCount += 1
        consecutiveSystemStale = 0
        if snapshot.1 {
          padToLocked(system: true, target: now)
          systemSamples.append(contentsOf: samples)
          lastSystemSampleEnd = now.addingTimeInterval(
            Double(samples.count) / Double(WavWriter.sampleRate)
          )
        }
        return systemBufferCount
      }
      lastMicLevel = level
      lastMicBufferAt = now
      lastMicFormat = format
      micBufferCount += 1
      consecutiveMicStale = 0
      if snapshot.1 {
        padToLocked(system: false, target: now)
        micSamples.append(contentsOf: samples)
        lastMicSampleEnd = now.addingTimeInterval(
          Double(samples.count) / Double(WavWriter.sampleRate)
        )
      }
      return micBufferCount
    }
    if count <= 3 || count % 200 == 0 {
      CaptureLog.line(
        "\(system ? "system" : "mic") buffer n=\(count) \(format) level=\(String(format: "%.3f", level)) peak=\(peak)"
      )
    }
  }

  private func teardownInputs() async {
    stopDeviceWatch()
    stopLevelsTimer()
    onLevels?(0, 0)
    stopProcessTap()
    await stopMicrophoneEngine()
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
    let nowHeartbeat = Date()
    if nowHeartbeat.timeIntervalSince(lastHeartbeatAt) >= 2 {
      lastHeartbeatAt = nowHeartbeat
      let counts = withLock {
        (
          micBufferCount,
          systemBufferCount,
          micSamples.count,
          systemSamples.count,
          lastMicFormat,
          lastSystemFormat,
          noteActive,
          recording,
          state
        )
      }
      CaptureLog.line(
        "levels mic=\(String(format: "%.3f", mic)) sys=\(String(format: "%.3f", system)) micAgoMs=\(Int(now.timeIntervalSince(snapshot.4) * 1000)) sysAgoMs=\(Int(now.timeIntervalSince(snapshot.5) * 1000)) micN=\(counts.0) sysN=\(counts.1) pcmMic=\(counts.2) pcmSys=\(counts.3) note=\(counts.6) rec=\(counts.7) state=\(counts.8) micFmt=\(counts.4) sysFmt=\(counts.5)"
      )
    }
    pollCounter += 1
    if pollCounter >= 20 {
      pollCounter = 0
      pollDefaultRoute()
      if snapshot.0 == "listening" || snapshot.0 == "idle" {
        watchMicTap(now: now)
        watchSystemTap(now: now)
      }
    }
  }

  private func micTapLooksDead(now: Date) -> Bool {
    now.timeIntervalSince(lastMicRebindAt) > 1.5
      && now.timeIntervalSince(lastMicBufferAt) > 1.5
  }

  private func systemTapLooksDead(now: Date) -> Bool {
    now.timeIntervalSince(lastSystemRebindAt) > 1.5
      && now.timeIntervalSince(lastSystemBufferAt) > 1.5
  }

  private func watchMicTap(now: Date) {
    let (busy, engineRunning, staleCount, dead) = withLock {
      (reconnecting, engine != nil, consecutiveMicStale, micTapLooksDead(now: now))
    }
    if busy || !engineRunning || staleCount >= 4 || !dead {
      return
    }
    CaptureLog.line("mic tap stale micAgoMs=\(Int(now.timeIntervalSince(lastMicBufferAt) * 1000))")
    scheduleReconnect(reason: "mic_stale")
  }

  private func watchSystemTap(now: Date) {
    let (busy, hasTap, staleCount, dead) = withLock {
      (reconnecting, processTap != nil, consecutiveSystemStale, systemTapLooksDead(now: now))
    }
    if busy || !hasTap || staleCount >= 4 || !dead {
      return
    }
    CaptureLog.line("system tap stale sysAgoMs=\(Int(now.timeIntervalSince(lastSystemBufferAt) * 1000))")
    scheduleReconnect(reason: "system_stale")
  }

  private func pollDefaultRoute() {
    let nextIn = AudioDevices.preferredInput()
    let nextOut = AudioDevices.defaultOutput()
    let (inUID, outUID, hasEngine, hasTap, busy, quiet) = withLock {
      (
        lastInputUID,
        lastOutputUID,
        engine != nil,
        processTap != nil,
        reconnecting,
        Date() < ignoreConfigUntil
      )
    }
    if busy || quiet {
      return
    }
    if !hasTap, Self.systemAudioSupported {
      scheduleReconnect(reason: "poll")
      return
    }
    if nextIn == nil {
      if hasEngine || !inUID.isEmpty {
        scheduleReconnect(reason: "poll_none")
      }
      return
    }
    if nextIn?.uid != inUID || nextOut?.uid != outUID || !hasEngine {
      scheduleReconnect(reason: "poll")
    }
  }

  private func alignTracksLocked(to target: Date) {
    padToLocked(system: false, target: target)
    padToLocked(system: true, target: target)
  }

  private func padToLocked(system: Bool, target: Date) {
    let last = system ? lastSystemSampleEnd : lastMicSampleEnd
    guard let last else { return }
    let hole = target.timeIntervalSince(last)
    guard hole > 0.05 else { return }
    let frames = Int((hole * Double(WavWriter.sampleRate)).rounded())
    let maxFrames = Int(WavWriter.sampleRate) * 300
    guard frames > 0, frames <= maxFrames else { return }
    if system {
      systemSamples.append(contentsOf: repeatElement(Int16(0), count: frames))
      lastSystemSampleEnd = target
    } else {
      micSamples.append(contentsOf: repeatElement(Int16(0), count: frames))
      lastMicSampleEnd = target
    }
    if hole >= 0.2 {
      CaptureLog.line(
        "pad \(system ? "system" : "mic") gapMs=\(Int(hole * 1000)) frames=\(frames)"
      )
    }
  }

  private func resetBuffers() {
    withLock {
      micSamples.removeAll(keepingCapacity: true)
      systemSamples.removeAll(keepingCapacity: true)
      frozenMic.removeAll(keepingCapacity: false)
      frozenSystem.removeAll(keepingCapacity: false)
      hasFrozenStop = false
      lastMicSampleEnd = nil
      lastSystemSampleEnd = nil
      micBufferCount = 0
      systemBufferCount = 0
    }
  }

  private func endRecording() {
    withLock {
      CaptureLog.line(
        "end recording state=\(state) note=\(noteActive) rec=\(recording) pcmMic=\(micSamples.count) pcmSys=\(systemSamples.count) froze=\(hasFrozenStop)"
      )
      noteActive = false
      recording = false
      paused = false
      state = "idle"
    }
  }

  private func setIdle() {
    endRecording()
  }

  private func deleteLastTemp() {
    for url in lastTempURLs {
      try? FileManager.default.removeItem(at: url)
    }
    lastTempURLs = []
  }

  private func logPcmStats(_ samples: [Int16], label: String) {
    let rate = Double(WavWriter.sampleRate)
    let duration = Double(samples.count) / rate
    let peak = samples.map { abs(Int32($0)) }.max() ?? 0
    var sumSq = 0.0
    var loudFrames = 0
    var firstLoud: Double?
    var lastLoud: Double?
    let frame = max(1, WavWriter.sampleRate / 50)
    var index = 0
    while index < samples.count {
      let end = min(index + frame, samples.count)
      var frameSum = 0.0
      for sampleIndex in index..<end {
        let normalized = Double(samples[sampleIndex]) / 32768.0
        frameSum += normalized * normalized
        sumSq += normalized * normalized
      }
      let rms = sqrt(frameSum / Double(end - index))
      if rms >= 0.01 {
        loudFrames += 1
        let started = Double(index) / rate
        if firstLoud == nil {
          firstLoud = started
        }
        lastLoud = Double(end) / rate
      }
      index = end
    }
    let rms = samples.isEmpty ? 0 : sqrt(sumSq / Double(samples.count))
    CaptureLog.line(
      "track \(label) samples=\(samples.count) sec=\(String(format: "%.2f", duration)) peak=\(peak) rms=\(String(format: "%.4f", rms)) loudFrames=\(loudFrames) firstLoud=\(firstLoud.map { String(format: "%.2f", $0) } ?? "none") lastLoud=\(lastLoud.map { String(format: "%.2f", $0) } ?? "none")"
    )
  }

  private func logEnergyTimeline(mic: [Int16], system: [Int16]) {
    let rate = WavWriter.sampleRate
    let total = max(mic.count, system.count)
    guard total > 0 else { return }
    let windows = Int(ceil(Double(total) / Double(rate)))
    var parts: [String] = []
    for window in 0..<windows {
      let start = window * rate
      func peak(_ samples: [Int16]) -> Int {
        guard start < samples.count else { return 0 }
        let end = min(start + rate, samples.count)
        var value = 0
        for index in start..<end {
          value = max(value, Int(abs(samples[index])))
        }
        return value
      }
      parts.append("t=\(window)s micP=\(peak(mic)) sysP=\(peak(system))")
    }
    var offset = 0
    while offset < parts.count {
      let end = min(offset + 8, parts.count)
      CaptureLog.line("energy " + parts[offset..<end].joined(separator: " | "))
      offset = end
    }
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
        let now = Date()
        let micDead = self.withLock { self.micTapLooksDead(now: now) }
        if now < self.ignoreConfigUntil, !micDead {
          CaptureLog.line("engine_config ignored (rebind quiet period)")
          return
        }
        CaptureLog.line("engine_config received")
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
    reconnectQueue.async { [weak self] in
      self?.enqueueReconnect(reason: reason)
    }
  }

  private func enqueueReconnect(reason: String) {
    if withLock({ stopRequested }) {
      CaptureLog.line("reconnect skipped; stop requested")
      return
    }
    if reconnectWork != nil || withLock({ reconnecting }) {
      withLock { pendingReconnectReason = reason }
      return
    }
    CaptureLog.line("reconnect scheduled reason=\(reason)")
    let work = DispatchWorkItem { [weak self] in
      Task { await self?.reconnectTaps(reason: reason) }
    }
    reconnectWork = work
    let delay: TimeInterval
    switch reason {
    case "default_input", "default_output", "devices":
      delay = 0.75
    default:
      delay = 0.4
    }
    reconnectQueue.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func reconnectTaps(reason: String) async {
    if withLock({ reconnecting }) {
      CaptureLog.line("reconnect busy, pending=\(reason)")
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
      reconnectQueue.async { [weak self] in
        guard let self else { return }
        self.reconnectWork = nil
        if self.withLock({ self.stopRequested }) {
          return
        }
        guard let again else { return }
        let inputSame = (AudioDevices.preferredInput()?.uid ?? "") == self.withLock({ self.lastInputUID })
        let outputSame = (AudioDevices.defaultOutput()?.uid ?? "") == self.withLock({ self.lastOutputUID })
        let keepPending = again == "poll_none" || again == "mic_stale" || again == "system_stale"
          || again == "devices" || again == "default_input" || again == "default_output"
        if inputSame, outputSame, !keepPending, self.processTap != nil {
          CaptureLog.line("drop pending \(again); route unchanged")
          return
        }
        self.enqueueReconnect(reason: again)
      }
    }

    await commandLock.withLock {
      await self.applyReconnect(reason: reason)
    }
  }

  private func applyReconnect(reason: String) async {
    if withLock({ stopRequested }) {
      CaptureLog.line("skip reconnect reason=\(reason) stop requested")
      return
    }
    let (session, hasHardware, note) = withLock {
      (state, engine != nil || processTap != nil, noteActive)
    }
    if session != "listening", session != "paused", !hasHardware, !note {
      CaptureLog.line("skip reconnect reason=\(reason) state=\(session)")
      return
    }
    withLock {
      if noteActive, state == "idle" {
        CaptureLog.line("restore listening; note still active")
        state = "listening"
        recording = true
      }
    }

    if reason == "devices" {
      let sameRoute = withLock {
        (AudioDevices.preferredInput()?.uid ?? "") == lastInputUID
          && (AudioDevices.defaultOutput()?.uid ?? "") == lastOutputUID
          && engine != nil
          && processTap != nil
          && !micTapLooksDead(now: Date())
          && !systemTapLooksDead(now: Date())
      }
      if sameRoute {
        CaptureLog.line("devices event; route unchanged")
        return
      }
    }

    let routeChange = reason == "default_input" || reason == "default_output" || reason == "devices"
    if routeChange {
      let liveIn = AudioDevices.preferredInput()?.uid ?? ""
      let liveOut = AudioDevices.defaultOutput()?.uid ?? ""
      let lastIn = withLock { lastInputUID }
      let lastOut = withLock { lastOutputUID }
      let leavingBluetooth = withLock { lastInputBluetooth || lastOutputBluetooth }
      if liveIn != lastIn, engine != nil {
        CaptureLog.line("release mic engine for input handover from \(lastIn) to \(liveIn)")
        await stopMicrophoneEngine()
        if withLock({ stopRequested }) {
          CaptureLog.line("abort reconnect after mic release; stop requested")
          return
        }
      }
      if liveOut != lastOut {
        CaptureLog.line("release system tap for output handover from \(lastOut) to \(liveOut)")
        stopProcessTap()
        systemConverterCache.removeAll()
      }
      CaptureLog.line("wait for audio route to settle reason=\(reason)")
      let settle: UInt64 = leavingBluetooth ? 1_200_000_000 : 800_000_000
      if await !sleepUnlessStop(nanoseconds: settle) {
        CaptureLog.line("abort reconnect after settle; stop requested")
        return
      }
    }

    let defaultInput = AudioDevices.defaultInput()
    let nextInput = AudioDevices.preferredInput()
    let nextOutput = AudioDevices.defaultOutput()
    let bluetoothMics = AudioDevices.bluetoothInputs()
    let previousName = withLock { lastInputName }
    let previousInputUID = withLock { lastInputUID }
    let previousInputBluetooth = withLock { lastInputBluetooth }
    let previousOutputUID = withLock { lastOutputUID }
    let previousOutputRate = withLock { lastOutputSampleRate }
    let previousOutputChannels = withLock { lastOutputChannels }
    let previousOutputBluetooth = withLock { lastOutputBluetooth }
    let inputChanged = (nextInput?.uid ?? "") != previousInputUID
    let outputChanged = (nextOutput?.uid ?? "") != previousOutputUID
      || abs((nextOutput?.sampleRate ?? 0) - previousOutputRate) > 1
      || (nextOutput?.channels ?? 0) != previousOutputChannels
    let engineRunning = engine != nil
    let now = Date()
    let systemDead = withLock { processTap == nil || systemTapLooksDead(now: now) }
    let micDead = withLock { micTapLooksDead(now: now) }

    CaptureLog.line(
      "reconnect run reason=\(reason) inputChanged=\(inputChanged) outputChanged=\(outputChanged) engine=\(engineRunning)"
    )
    CaptureLog.line("  defaultIn \(defaultInput?.summary ?? "none")")
    CaptureLog.line("  preferredIn \(nextInput?.summary ?? "none") lastIn=\(previousName) uid=\(previousInputUID)")
    CaptureLog.line("  defaultOut \(nextOutput?.summary ?? "none") lastOut=\(previousOutputUID)")
    if !bluetoothMics.isEmpty {
      CaptureLog.line("  bluetooth mics=\(bluetoothMics.map(\.name).joined(separator: ","))")
    }

    if !previousInputBluetooth, nextInput?.isBluetooth == true {
      CaptureLog.line("bluetooth connected mic=\(nextInput?.summary ?? "none")")
    } else if previousInputBluetooth, nextInput?.isBluetooth != true {
      CaptureLog.line("bluetooth disconnected mic=\(nextInput?.summary ?? "none")")
    }
    if !previousOutputBluetooth, nextOutput?.isBluetooth == true {
      CaptureLog.line("bluetooth connected output=\(nextOutput?.summary ?? "none")")
    } else if previousOutputBluetooth, nextOutput?.isBluetooth != true {
      CaptureLog.line("bluetooth disconnected output=\(nextOutput?.summary ?? "none")")
    }

    rememberOutput(nextOutput)

    if withLock({ stopRequested }) {
      CaptureLog.line("abort reconnect before tap rebind; stop requested")
      return
    }

    let recreateTap = outputChanged || processTap == nil || reason == "system_stale" || systemDead
    if recreateTap, Self.systemAudioSupported {
      if reason == "system_stale" {
        withLock { consecutiveSystemStale += 1 }
      }
      if reason == "system_stale", withLock({ consecutiveSystemStale }) >= 4 {
        CaptureLog.line("system tap stale backoff")
      } else {
        if outputChanged {
          CaptureLog.line(
            "output change new=\(nextOutput?.name ?? "") — recreate global tap after handover (never bind to the output device)"
          )
        } else if processTap == nil {
          CaptureLog.line("system tap missing — recreate global tap")
        } else {
          CaptureLog.line("system tap dead — recreate global tap (buffers already kept)")
        }
        await rebindSystemAudio()
      }
    }

    if let nextInput, !nextInput.isUsableInput {
      CaptureLog.line("skip mic rebind; preferred is not a mic (\(nextInput.summary))")
      return
    }

    let forceMic = reason == "poll_none" || reason == "mic_stale" || micDead
    if reason == "mic_stale", withLock({ consecutiveMicStale }) >= 4 {
      CaptureLog.line("mic tap stale backoff")
      return
    }
    if !inputChanged, engineRunning, !forceMic {
      CaptureLog.line("skip mic rebind; preferred uid unchanged (\(previousInputUID))")
      return
    }

    if reason == "mic_stale" {
      withLock { consecutiveMicStale += 1 }
    } else if inputChanged {
      withLock { consecutiveMicStale = 0 }
    }

    CaptureLog.line(
      "device change reason=\(reason) old=\(previousName) new=\(nextInput?.name ?? "")"
    )

    guard let nextInput else {
      await dropMicrophone(keepSystem: true)
      return
    }

    if withLock({ stopRequested }) {
      CaptureLog.line("abort reconnect before mic rebind; stop requested")
      return
    }

    do {
      try await rebindMicrophone(preferred: nextInput)
      if withLock({ stopRequested }) {
        CaptureLog.line("mic rebind ended; stop requested")
      } else {
        CaptureLog.line("mic reconnect ok device=\(currentInputName()) reason=\(reason)")
      }
    } catch {
      CaptureLog.line("mic reconnect failed after retries: \(error.localizedDescription)")
      withLock {
        lastMicLevel = 0
        lastMicBufferAt = Date.distantPast
      }
    }
  }

  private func rebindMicrophone(preferred: AudioInputDevice? = nil) async throws {
    ignoreConfigUntil = Date().addingTimeInterval(4.0)
    CaptureLog.line("mic rebind start")
    let wasBluetooth = withLock { lastInputBluetooth }
    await stopMicrophoneEngine()
    micConverterCache.removeAll()
    if wasBluetooth {
      CaptureLog.line("wait for bluetooth HFP to drop before starting the next mic")
      if await !sleepUnlessStop(nanoseconds: 1_200_000_000) {
        CaptureLog.line("abort mic rebind; stop requested")
        return
      }
    }
    if withLock({ stopRequested }) {
      CaptureLog.line("abort mic rebind; stop requested")
      return
    }
    try await startMicrophoneRetrying(preferred: preferred)
  }

  private func rebindSystemAudio() async {
    CaptureLog.line("system audio rebind start")
    stopProcessTap()
    systemConverterCache.removeAll()
    guard Self.systemAudioSupported else { return }
    var lastError: Error?
    for attempt in 1...5 {
      if withLock({ stopRequested }) {
        CaptureLog.line("abort system rebind; stop requested")
        return
      }
      do {
        try await startSystemAudio()
        withLock { systemAudioEnabled = processTap != nil }
        CaptureLog.line("system audio reconnect ok tap=\(processTap != nil) attempt=\(attempt)")
        return
      } catch {
        lastError = error
        stopProcessTap()
        CaptureLog.line(
          "system audio reconnect attempt \(attempt) failed: \(error.localizedDescription)"
        )
        try? await Task.sleep(nanoseconds: 300_000_000)
        if withLock({ stopRequested }) {
          CaptureLog.line("abort system rebind; stop requested")
          return
        }
      }
    }
    withLock { systemAudioEnabled = false }
    CaptureLog.line(
      "system audio reconnect failed: \(lastError?.localizedDescription ?? "unknown")"
    )
  }

  private func dropMicrophone(keepSystem: Bool) async {
    ignoreConfigUntil = Date().addingTimeInterval(0.6)
    await stopMicrophoneEngine()
    micConverterCache.removeAll()
    withLock {
      lastMicLevel = 0
      lastMicBufferAt = Date.distantPast
      lastInputUID = ""
      lastInputName = ""
      lastInputBluetooth = false
    }
    onDevice?("", true)
    if !keepSystem {
      stopProcessTap()
    }
  }

  private func rememberOutput(_ device: AudioInputDevice?) {
    withLock {
      lastOutputUID = device?.uid ?? ""
      lastOutputSampleRate = device?.sampleRate ?? 0
      lastOutputChannels = device?.channels ?? 0
      lastOutputBluetooth = device?.isBluetooth ?? false
    }
  }

  private func rememberInput(_ device: AudioInputDevice?) {
    let name = device?.name ?? ""
    let uid = device?.uid ?? ""
    withLock {
      lastInputName = name
      lastInputUID = uid
      lastInputBluetooth = device?.isBluetooth ?? false
    }
    onDevice?(name, name.isEmpty)
  }
}
