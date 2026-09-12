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
  private var lastTempURL: URL?
  private var lastMicLevel = 0.0
  private var lastSystemLevel = 0.0
  private var lastMicBufferAt = Date.distantPast
  private var lastSystemBufferAt = Date.distantPast
  private var levelsTimer: DispatchSourceTimer?
  private var recording = false
  private var lastInputUID = ""
  private var lastInputName = ""
  private var lastOutputUID = ""
  private var lastOutputSampleRate = 0.0
  private var lastOutputChannels: UInt32 = 0
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
    try await commandLock.withLock {
      let session = withLock { state }
      if session == "listening" || session == "paused" {
        return withLock { (systemAudioEnabled, lastInputName) }
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
    try await commandLock.withLock {
      try await finishListening()
    }
  }

  private func finishListening() async throws -> (url: URL, duration: Double, systemAudioEnabled: Bool) {
    let current = withLock { state }
    CaptureLog.line("stop requested state=\(current)")
    guard current == "listening" || current == "paused" else {
      throw CaptureError.notListening
    }

    endRecording()

    let snapshot = withLock { (micSamples, systemSamples, systemAudioEnabled) }

    let mixed = AudioConvert.mix(snapshot.0, snapshot.1)
    let micPeak = snapshot.0.map { abs(Int32($0)) }.max() ?? 0
    let sysPeak = snapshot.1.map { abs(Int32($0)) }.max() ?? 0
    CaptureLog.line(
      "mix mic=\(snapshot.0.count) system=\(snapshot.1.count) mixed=\(mixed.count) micPeak=\(micPeak) sysPeak=\(sysPeak) micFmt=\(lastMicFormat) sysFmt=\(lastSystemFormat)"
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

    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("pith-\(UUID().uuidString).wav")
    try WavWriter.writeCanonical(samples: mixed, to: url)
    deleteLastTemp()
    lastTempURL = url
    resetBuffers()
    await teardownInputs()
    onLevels?(0, 0)
    CaptureLog.line("capture stopped; hardware released")
    return (url, duration, snapshot.2)
  }

  func cancel() async {
    await commandLock.withLock {
      endRecording()
      deleteLastTemp()
      resetBuffers()
      await teardownInputs()
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

  private func startMicrophone() throws {
    let preferred = AudioDevices.preferredInput()
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
      input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
        self?.append(buffer: buffer, system: false)
      }
      engine = audioEngine
      rememberInput(preferred)
    } catch {
      audioEngine.inputNode.removeTap(onBus: 0)
      audioEngine.stop()
      throw error
    }
  }

  private func startMicrophoneRetrying() async throws {
    var lastError: Error?
    for attempt in 1...10 {
      do {
        try startMicrophone()
        return
      } catch {
        lastError = error
        CaptureLog.line("mic start attempt \(attempt) failed: \(error.localizedDescription)")
        if let engine {
          engine.inputNode.removeTap(onBus: 0)
          engine.stop()
        }
        engine = nil
        try await Task.sleep(nanoseconds: 400_000_000)
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
    try tap.start(outputUID: nil)
    processTap = tap
    CaptureLog.line("system audio process tap started output=\(output?.name ?? "")")
  }

  private func stopProcessTap() {
    processTap?.stop()
    processTap = nil
  }

  private func append(buffer: AVAudioPCMBuffer, system: Bool) {
    let snapshot = withLock { (paused, recording) }
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
    let count = withLock { () -> Int in
      if system {
        lastSystemLevel = level
        lastSystemBufferAt = Date()
        lastSystemFormat = format
        systemBufferCount += 1
        if snapshot.1 {
          systemSamples.append(contentsOf: samples)
        }
        return systemBufferCount
      }
      lastMicLevel = level
      lastMicBufferAt = Date()
      lastMicFormat = format
      micBufferCount += 1
      if snapshot.1 {
        micSamples.append(contentsOf: samples)
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
    if snapshot.0 == "idle" {
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
      let counts = withLock { (micBufferCount, systemBufferCount, lastMicFormat, lastSystemFormat) }
      CaptureLog.line(
        "levels mic=\(String(format: "%.3f", mic)) sys=\(String(format: "%.3f", system)) micAgoMs=\(Int(now.timeIntervalSince(snapshot.4) * 1000)) sysAgoMs=\(Int(now.timeIntervalSince(snapshot.5) * 1000)) micN=\(counts.0) sysN=\(counts.1) micFmt=\(counts.2) sysFmt=\(counts.3)"
      )
    }
    pollCounter += 1
    if pollCounter >= 20 {
      pollCounter = 0
      pollDefaultInput()
    }
  }

  private func pollDefaultInput() {
    let next = AudioDevices.preferredInput()
    let (uid, hasEngine, hasTap, busy) = withLock {
      (lastInputUID, engine != nil, processTap != nil, reconnecting)
    }
    if busy {
      return
    }
    if !hasTap, Self.systemAudioSupported {
      scheduleReconnect(reason: "poll")
      return
    }
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
    if reconnectWork != nil || withLock({ reconnecting }) {
      withLock { pendingReconnectReason = reason }
      return
    }
    CaptureLog.line("reconnect scheduled reason=\(reason)")
    let work = DispatchWorkItem { [weak self] in
      Task { await self?.reconnectTaps(reason: reason) }
    }
    reconnectWork = work
    reconnectQueue.asyncAfter(deadline: .now() + 0.4, execute: work)
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
        guard let again else { return }
        let inputSame = (AudioDevices.preferredInput()?.uid ?? "") == self.withLock({ self.lastInputUID })
        if inputSame, again != "poll_none", self.processTap != nil {
          CaptureLog.line("drop pending \(again); preferred input unchanged")
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
    let session = withLock { state }
    if session != "listening", session != "paused" {
      CaptureLog.line("skip reconnect reason=\(reason) state=\(session)")
      return
    }

    let defaultInput = AudioDevices.defaultInput()
    let nextInput = AudioDevices.preferredInput()
    let nextOutput = AudioDevices.defaultOutput()
    let previousName = withLock { lastInputName }
    let previousInputUID = withLock { lastInputUID }
    let previousOutputUID = withLock { lastOutputUID }
    let previousOutputRate = withLock { lastOutputSampleRate }
    let previousOutputChannels = withLock { lastOutputChannels }
    let inputChanged = (nextInput?.uid ?? "") != previousInputUID
    let outputChanged = (nextOutput?.uid ?? "") != previousOutputUID
      || abs((nextOutput?.sampleRate ?? 0) - previousOutputRate) > 1
      || (nextOutput?.channels ?? 0) != previousOutputChannels
    let engineRunning = engine != nil

    CaptureLog.line(
      "reconnect run reason=\(reason) inputChanged=\(inputChanged) outputChanged=\(outputChanged) engine=\(engineRunning)"
    )
    CaptureLog.line("  defaultIn \(defaultInput?.summary ?? "none")")
    CaptureLog.line("  preferredIn \(nextInput?.summary ?? "none") lastIn=\(previousName) uid=\(previousInputUID)")
    CaptureLog.line("  defaultOut \(nextOutput?.summary ?? "none") lastOut=\(previousOutputUID)")

    if outputChanged {
      rememberOutput(nextOutput)
      CaptureLog.line("output change reason=\(reason) new=\(nextOutput?.name ?? "") — keep global tap")
    }

    if processTap == nil, Self.systemAudioSupported {
      await rebindSystemAudio()
    }

    if let nextInput, !nextInput.isUsableInput {
      CaptureLog.line("skip mic rebind; preferred is not a mic (\(nextInput.summary))")
      return
    }

    if !inputChanged, engineRunning, reason != "poll_none" {
      CaptureLog.line("skip mic rebind; preferred uid unchanged (\(previousInputUID))")
      return
    }

    CaptureLog.line(
      "device change reason=\(reason) old=\(previousName) new=\(nextInput?.name ?? "")"
    )

    guard let nextInput else {
      await dropMicrophone(keepSystem: true)
      return
    }

    rememberInput(nextInput)

    do {
      try await rebindMicrophone()
      CaptureLog.line("mic reconnect ok device=\(nextInput.name)")
    } catch {
      CaptureLog.line("mic reconnect failed after retries: \(error.localizedDescription)")
      withLock {
        lastMicLevel = 0
        lastMicBufferAt = Date.distantPast
      }
    }
  }

  private func rebindMicrophone() async throws {
    ignoreConfigUntil = Date().addingTimeInterval(4.0)
    CaptureLog.line("mic rebind start")
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
    CaptureLog.line("system audio rebind start")
    stopProcessTap()
    systemConverterCache.removeAll()
    systemBufferCount = 0
    guard Self.systemAudioSupported else { return }
    do {
      try await startSystemAudio()
      withLock { systemAudioEnabled = processTap != nil }
      CaptureLog.line("system audio reconnect ok tap=\(processTap != nil)")
    } catch {
      withLock { systemAudioEnabled = false }
      CaptureLog.line("system audio reconnect failed: \(error.localizedDescription)")
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
      stopProcessTap()
    }
  }

  private func rememberOutput(_ device: AudioInputDevice?) {
    withLock {
      lastOutputUID = device?.uid ?? ""
      lastOutputSampleRate = device?.sampleRate ?? 0
      lastOutputChannels = device?.channels ?? 0
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
