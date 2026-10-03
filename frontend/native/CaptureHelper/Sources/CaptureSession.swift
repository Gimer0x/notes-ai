import AppKit
import AVFoundation
import CoreGraphics
import Foundation

/// Mic + global system tap. One handover at a time. Already-captured samples are kept.
final class CaptureSession: @unchecked Sendable {
  var onLevels: ((Double, Double) -> Void)?
  var onDevice: ((String, Bool) -> Void)?

  private let lock = NSLock()
  private let gate = SerialGate()
  private let router: DeviceRouting
  private let mic: MicrophoneCapturing
  private let tap: SystemAudioCapturing
  private let headsetGain = HeadsetMicGain()

  private var state = "idle"
  private var systemAudioEnabled = false
  private var paused = false
  private var recording = false
  private var noteActive = false
  private var stopRequested = false
  private var hardwareOn = false
  private var inputBluetooth = false
  private var inputUID = ""
  private var outputUID = ""
  private var inputRate = 0.0
  private var outputRate = 0.0
  private var sessionHost: UInt64 = 0
  private var micEndHost: UInt64 = 0
  private var systemEndHost: UInt64 = 0
  private var inputName = ""

  private var micConverter: AVAudioConverter?
  private var systemConverter: AVAudioConverter?
  private var micSamples: [Int16] = []
  private var systemSamples: [Int16] = []
  private var frozenMic: [Int16] = []
  private var frozenSystem: [Int16] = []
  private var frozen = false
  private var lastTemp: [URL] = []

  private var micLevel = 0.0
  private var systemLevel = 0.0
  private var micAt = Date.distantPast
  private var systemAt = Date.distantPast
  private var micEnd: Date?
  private var systemEnd: Date?
  private var micCount = 0
  private var systemCount = 0
  private var heartbeat = Date.distantPast
  private var dirtyRoute = false
  private var levelsTimer: DispatchSourceTimer?
  private let audioQueue = DispatchQueue(label: "dev.pith.audio.process")
  private var audioBacklog = 0
  private var droppedAudio = 0
  private var ignoreMicConfigUntil = Date.distantPast

  convenience init() {
    self.init(router: DeviceRouter(), mic: MicCapture(), tap: SystemTapCapture())
  }

  init(router: DeviceRouting, mic: MicrophoneCapturing, tap: SystemAudioCapturing) {
    self.router = router
    self.mic = mic
    self.tap = tap
    mic.onBuffer = { [weak self] buffer, host in self?.ingest(buffer, host: host, system: false) }
    tap.onBuffer = { [weak self] buffer, host in self?.ingest(buffer, host: host, system: true) }
    mic.onConfigurationChange = { [weak self] in self?.enqueueMicConfig() }
    router.onRouteChange = { [weak self] change in self?.enqueue(change) }
  }

  func currentState() -> String { withLock { state } }

  func preview() async throws -> (systemAudioEnabled: Bool, inputName: String) {
    try await gate.run {
      let busy = withLock { noteActive || recording || state == "listening" || state == "paused" }
      if busy { return withLock { (systemAudioEnabled, inputName) } }
      try await openHardware()
      withLock { recording = false; paused = false; state = "idle" }
      return withLock { (systemAudioEnabled, inputName) }
    }
  }

  func start() async throws -> (systemAudioEnabled: Bool, inputName: String) {
    try await gate.run {
      if withLock({ frozen }) { return withLock { (systemAudioEnabled, inputName) } }
      let continuing = withLock { noteActive || state == "listening" || state == "paused" }
      if !continuing {
        clearBuffers()
        headsetGain.reset()
      }
      let origin = mach_absolute_time()
      withLock {
        if sessionHost == 0 { sessionHost = origin }
        stopRequested = false
        noteActive = true
        recording = true
        if state != "paused" { state = "listening"; paused = false }
        if micEnd == nil { micEnd = Date() }
        if systemEnd == nil { systemEnd = Date() }
      }
      let warm = withLock { hardwareOn }
      if !warm { try await openHardware() }
      CaptureLog.line(continuing ? "continue note mix" : warm ? "new note mix hardware=kept" : "new note mix")
      return withLock { (systemAudioEnabled, inputName) }
    }
  }

  func pause() throws {
    try withLock {
      guard state == "listening" else { throw CaptureError.notListening }
      paused = true
      state = "paused"
      micLevel = 0
      systemLevel = 0
      micEnd = nil
      systemEnd = nil
    }
    onLevels?(0, 0)
  }

  func resume() throws {
    try withLock {
      guard state == "paused" else { throw CaptureError.notPaused }
      paused = false
      state = "listening"
      let now = Date()
      micEnd = now
      systemEnd = now
    }
  }

  func stop() async throws -> (
    url: URL, micURL: URL?, systemURL: URL?, duration: Double, systemAudioEnabled: Bool
  ) {
    withLock { stopRequested = true }
    await flushAudio()
    let nowHost = mach_absolute_time()
    withLock {
      if !frozen {
        pad(system: false, to: nowHost)
        pad(system: true, to: nowHost)
        frozenMic = micSamples
        frozenSystem = systemSamples
        frozen = true
      }
    }
    let counts = withLock { (frozenMic.count, frozenSystem.count) }
    CaptureLog.line("stop requested; freeze mic=\(counts.0) sys=\(counts.1)")
    return try await gate.run { try await finish() }
  }

  func cancel() async {
    await gate.run {
      clearSession()
      deleteTemps()
      clearBuffers()
      onLevels?(0, 0)
      if withLock({ hardwareOn }) {
        await closeHardware()
        CaptureLog.line("capture cancelled; hardware released")
      } else {
        CaptureLog.line("capture cancelled; hardware idle")
      }
    }
  }

  @MainActor
  private func requestMicrophonePermission() async -> Bool {
    NSApp.activate()
    return await AVAudioApplication.requestRecordPermission()
  }

  // MARK: Hardware

  private func openHardware() async throws {
    if !withLock({ hardwareOn }) {
      let granted = await requestMicrophonePermission()
      CaptureLog.line("mic permission granted=\(granted)")
      if !granted { throw CaptureError.micDenied }
    }
    _ = CGRequestScreenCaptureAccess()
    let intended = AudioDevices.snapshot()
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.startMic(intended.input ?? AudioDevices.preferredInput()) }
      group.addTask { await self.startTap() }
    }
    startLevels()
    router.start()
    router.rememberCurrent()
    let snap = AudioDevices.snapshot()
    withLock {
      inputUID = snap.input?.uid ?? inputUID
      outputUID = snap.output?.uid ?? ""
      inputRate = snap.input?.sampleRate ?? inputRate
      outputRate = snap.output?.sampleRate ?? outputRate
      hardwareOn = true
    }
    publish(snap.input)
  }

  private func startMic(_ device: AudioDeviceInfo?) async {
    guard let device else {
      CaptureLog.line("mic unavailable")
      publish(nil)
      withLock { inputUID = "" }
      return
    }
    for attempt in 1...4 {
      if withLock({ stopRequested }) { return }
      let live = AudioDevices.input(uid: device.uid) ?? device
      CaptureLog.line("mic start attempt=\(attempt) \(live.summary)")
      do {
        try await startMicTimed(live)
        ignoreMicConfigUntil = Date().addingTimeInterval(1)
        router.suppress(for: 0.8)
        withLock {
          inputUID = live.uid
          inputRate = live.sampleRate
        }
        publish(live)
        return
      } catch {
        CaptureLog.line("mic start failed: \(error.localizedDescription)")
        mic.stop()
        if await !sleep(400_000_000) { return }
      }
    }
    CaptureLog.line("mic start gave up")
    publish(nil)
  }

  private func startMicTimed(_ device: AudioDeviceInfo) async throws {
    let capture = mic
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
      let once = Once()
      Task.detached(priority: .userInitiated) {
        do {
          try capture.start(device: device)
          if once.go() { cont.resume() }
        } catch {
          if once.go() { cont.resume(throwing: error) }
        }
      }
      Task {
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        if once.go() {
          capture.stop()
          cont.resume(throwing: NSError(domain: "CaptureHelper", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "mic_start_timeout",
          ]))
        }
      }
    }
  }

  private func startTap() async {
    for attempt in 1...4 {
      if withLock({ stopRequested }) { return }
      let output = AudioDevices.defaultOutput()
      CaptureLog.line("system tap start attempt=\(attempt) output=\(output?.summary ?? "none") bindUID=global")
      do {
        try tap.start()
        let rate = AudioDevices.defaultOutput()?.sampleRate ?? 0
        withLock {
          systemAudioEnabled = true
          if rate > 0 { outputRate = rate }
        }
        CaptureLog.line("system audio process tap started output=\(output?.name ?? "")")
        return
      } catch {
        tap.stop()
        CaptureLog.line("system tap start failed: \(error.localizedDescription)")
        if await !sleep(350_000_000) { return }
      }
    }
    withLock { systemAudioEnabled = false }
    CaptureLog.line("system audio unavailable after retries")
  }

  private func closeHardware() async {
    router.stop()
    stopLevels()
    tap.stop()
    mic.stop()
    CaptureLog.line("mic engine released")
    audioQueue.sync {
      micConverter = nil
      systemConverter = nil
    }
    withLock {
      hardwareOn = false
      inputUID = ""
      outputUID = ""
      inputRate = 0
      outputRate = 0
      systemAudioEnabled = false
    }
  }

  // MARK: Bluetooth / default device

  private func enqueue(_ change: RouteChange) {
    withLock { dirtyRoute = true }
    Task { [weak self] in
      guard let self else { return }
      await self.gate.run { await self.reconcile(change) }
    }
  }

  /// Read the live defaults and recover only the source whose UID or format changed.
  /// Does not write macOS default devices. An output-only change does not rebind the mic.
  private func reconcile(_ first: RouteChange) async {
    for _ in 0..<3 {
      if withLock({ stopRequested || !hardwareOn }) {
        withLock { dirtyRoute = false }
        return
      }
      withLock { dirtyRoute = false }
      let fresh = AudioDevices.snapshot()
      let bound = withLock { (inputUID, outputUID, inputRate, outputRate) }
      let wantIn = fresh.input?.uid ?? ""
      let wantOut = fresh.output?.uid ?? ""
      let inputChanged = wantIn != bound.0
      let outputChanged = wantOut != bound.1
      let inputFormat = !inputChanged && abs((fresh.input?.sampleRate ?? 0) - bound.2) > 1 && fresh.input != nil
      let outputFormat = !outputChanged && abs((fresh.output?.sampleRate ?? 0) - bound.3) > 1 && fresh.output != nil
      CaptureLog.line(
        "route fresh in=\(wantIn.isEmpty ? "none" : wantIn) out=\(wantOut.isEmpty ? "none" : wantOut) eventIn=\(first.inputChanged) eventOut=\(first.outputChanged) formatIn=\(inputFormat) formatOut=\(outputFormat)"
      )
      guard inputChanged || outputChanged || inputFormat || outputFormat else {
        if !withLock({ dirtyRoute }) { return }
        continue
      }

      if inputChanged || inputFormat {
        if let device = fresh.input {
          CaptureLog.line("rebind mic uid=\(device.uid) sr=\(device.sampleRate)")
          mic.stop()
          CaptureLog.line("mic engine released")
          audioQueue.sync { micConverter = nil }
          headsetGain.reset()
          if await !sleep(100_000_000) { return }
          await startMic(device)
        } else {
          CaptureLog.line("mic keep uid=\(bound.0) wanted missing")
        }
      }
      if withLock({ stopRequested }) { return }

      let headsetMic = (inputChanged || inputFormat) && fresh.input?.isBluetooth == true
      if outputChanged || outputFormat || headsetMic || !tap.isRunning {
        CaptureLog.line("handover release tap out=\(outputChanged) format=\(outputFormat) headsetMic=\(headsetMic)")
        tap.stop()
        audioQueue.sync { systemConverter = nil }
        if await !sleep(150_000_000) { return }
        await startTap()
      }
      withLock {
        outputUID = wantOut
        outputRate = fresh.output?.sampleRate ?? outputRate
      }
      router.rememberCurrent()
      router.suppress(for: 0.8)
      if !withLock({ dirtyRoute }) { return }
      CaptureLog.line("route changed again during handover")
    }
  }

  private func enqueueMicConfig() {
    Task { [weak self] in
      guard let self else { return }
      await self.gate.run { await self.recoverMicConfiguration() }
    }
  }

  private func recoverMicConfiguration() async {
    if withLock({ stopRequested || !hardwareOn }) { return }
    if Date() < ignoreMicConfigUntil { return }
    let uid = withLock { inputUID }
    guard let device = AudioDevices.input(uid: uid) ?? AudioDevices.preferredInput() else { return }
    CaptureLog.line("mic engine configuration changed uid=\(device.uid) sr=\(device.sampleRate)")
    ignoreMicConfigUntil = Date().addingTimeInterval(1)
    mic.stop()
    CaptureLog.line("mic engine released")
    audioQueue.sync { micConverter = nil }
    headsetGain.reset()
    await startMic(device)
    if freshOutputNeedsTap() {
      tap.stop()
      audioQueue.sync { systemConverter = nil }
      await startTap()
    }
    router.suppress(for: 0.8)
  }

  private func freshOutputNeedsTap() -> Bool {
    let fresh = AudioDevices.snapshot()
    let bound = withLock { (outputUID, outputRate) }
    let uidChanged = (fresh.output?.uid ?? "") != bound.0
    let rateChanged = abs((fresh.output?.sampleRate ?? 0) - bound.1) > 1 && fresh.output != nil
    return uidChanged || rateChanged || !tap.isRunning
  }

  // MARK: Buffers

  private func ingest(_ buffer: AVAudioPCMBuffer, host: UInt64, system: Bool) {
    guard let copied = AudioConvert.copyMono(buffer) else { return }
    let accept = withLock { () -> Bool in
      if audioBacklog >= 48 {
        droppedAudio += 1
        return false
      }
      audioBacklog += 1
      return true
    }
    guard accept else { return }
    let frames = copied.floats.count
    let rate = copied.sampleRate
    audioQueue.async { [weak self] in
      self?.process(copied.floats, sampleRate: rate, frames: frames, host: host, system: system)
      self?.withLock { self?.audioBacklog -= 1 }
    }
  }

  private func process(_ floats: [Float], sampleRate: Double, frames: Int, host: UInt64, system: Bool) {
    var samples = system
      ? AudioConvert.int16Mono16k(floats, sampleRate: sampleRate, converter: &systemConverter)
      : AudioConvert.int16Mono16k(floats, sampleRate: sampleRate, converter: &micConverter)
    guard !samples.isEmpty else { return }
    let now = Date()
    let logged: (Int, Double, Int32, Int)? = withLock {
      if frozen { return nil }
      if !system, inputBluetooth { samples = headsetGain.process(samples) }
      let keep = (recording || noteActive) && !paused
      let peak = samples.map { abs(Int32($0)) }.max() ?? 0
      let shown = AudioConvert.level(samples)
      if system {
        systemLevel = shown
        systemAt = now
        systemCount += 1
        if keep {
          store(samples, system: true, host: host, frames: frames, rate: sampleRate)
        }
        return (systemCount, shown, peak, droppedAudio)
      }
      micLevel = shown
      micAt = now
      micCount += 1
      if keep {
        store(samples, system: false, host: host, frames: frames, rate: sampleRate)
      }
      return (micCount, shown, peak, droppedAudio)
    }
    guard let logged, logged.0 <= 3 || logged.0 % 200 == 0 else { return }
    CaptureLog.line(
      "\(system ? "system" : "mic") buffer n=\(logged.0) sr=\(sampleRate) frames=\(frames) level=\(String(format: "%.3f", logged.1)) peak=\(logged.2) dropped=\(logged.3)"
    )
  }

  /// Caller holds `lock`. Inserts silence only for a hole in host time, then appends this buffer.
  private func store(_ samples: [Int16], system: Bool, host: UInt64, frames: Int, rate: Double) {
    if host > 0 {
      pad(system: system, to: host)
      let end = host &+ hostTicks(frames: frames, rate: rate)
      if system { systemEndHost = end } else { micEndHost = end }
    }
    if system {
      systemSamples.append(contentsOf: samples)
      systemEnd = Date().addingTimeInterval(Double(samples.count) / Double(WavWriter.sampleRate))
    } else {
      micSamples.append(contentsOf: samples)
      micEnd = Date().addingTimeInterval(Double(samples.count) / Double(WavWriter.sampleRate))
    }
    if sessionHost > 0, (system ? systemCount : micCount) == 1 {
      let latency = HostClock.seconds(from: sessionHost, to: host > 0 ? host : mach_absolute_time())
      CaptureLog.line("first \(system ? "system" : "mic") latencyMs=\(Int(latency * 1000))")
    }
  }

  private func flushAudio() async {
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      audioQueue.async { cont.resume() }
    }
  }

  /// Caller holds `lock`.
  private func pad(system: Bool, to host: UInt64) {
    guard host > 0 else { return }
    let previous = system ? systemEndHost : micEndHost
    let start = previous > 0 ? previous : sessionHost
    guard start > 0, host > start else { return }
    let hole = HostClock.seconds(from: start, to: host)
    guard hole > 0.02 else { return }
    let frames = Int((hole * Double(WavWriter.sampleRate)).rounded())
    guard frames > 0, frames <= WavWriter.sampleRate * 300 else { return }
    if system {
      systemSamples.append(contentsOf: repeatElement(0, count: frames))
      systemEndHost = host
    } else {
      micSamples.append(contentsOf: repeatElement(0, count: frames))
      micEndHost = host
    }
    if hole >= 0.2 {
      CaptureLog.line("pad \(system ? "system" : "mic") gapMs=\(Int(hole * 1000)) frames=\(frames)")
    }
  }

  private func hostTicks(frames: Int, rate: Double) -> UInt64 {
    guard rate > 0, frames > 0 else { return 0 }
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    guard info.numer > 0 else { return 0 }
    let nanos = Double(frames) / rate * 1_000_000_000
    return UInt64(max(0, nanos * Double(info.denom) / Double(info.numer)))
  }

  private func finish() async throws -> (
    url: URL, micURL: URL?, systemURL: URL?, duration: Double, systemAudioEnabled: Bool
  ) {
    let counts = withLock { (state, micSamples.count, systemSamples.count, frozenMic.count, frozenSystem.count) }
    CaptureLog.line(
      "stop requested state=\(counts.0) micN=\(counts.1) sysN=\(counts.2) frozeMic=\(counts.3) frozeSys=\(counts.4)"
    )
    guard counts.0 == "listening" || counts.0 == "paused" || counts.1 + counts.2 + counts.3 + counts.4 > 0 else {
      withLock { stopRequested = false; frozen = false }
      throw CaptureError.notListening
    }
    clearSession()
    let tracks = withLock { () -> ([Int16], [Int16], Bool) in
      if frozen, frozenMic.count + frozenSystem.count > 0 {
        return (frozenMic, frozenSystem, systemAudioEnabled)
      }
      let nowHost = mach_absolute_time()
      pad(system: false, to: nowHost)
      pad(system: true, to: nowHost)
      return (micSamples, systemSamples, systemAudioEnabled)
    }
    await closeHardware()
    onLevels?(0, 0)
    CaptureLog.line("capture stopped; hardware released before transcribe")
    let mixed = AudioConvert.mix(tracks.0, tracks.1)
    CaptureLog.line("mix mic=\(tracks.0.count) system=\(tracks.1.count) mixed=\(mixed.count)")
    guard !mixed.isEmpty else {
      clearBuffers()
      withLock { stopRequested = false }
      throw CaptureError.empty
    }
    let duration = Double(mixed.count) / Double(WavWriter.sampleRate)
    guard duration >= 0.5 else {
      clearBuffers()
      withLock { stopRequested = false }
      throw CaptureError.tooShort
    }
    logTrack(tracks.0, "mic")
    logTrack(tracks.1, "system")
    logTrack(mixed, "mix")
    let stamp = UUID().uuidString
    let dir = FileManager.default.temporaryDirectory
    let mixURL = dir.appendingPathComponent("pith-\(stamp)-mix.wav")
    let micURL = tracks.0.isEmpty ? nil : dir.appendingPathComponent("pith-\(stamp)-mic.wav")
    let systemURL = tracks.1.isEmpty ? nil : dir.appendingPathComponent("pith-\(stamp)-sys.wav")
    try WavWriter.writeCanonical(samples: mixed, to: mixURL)
    if let micURL { try WavWriter.writeCanonical(samples: tracks.0, to: micURL) }
    if let systemURL { try WavWriter.writeCanonical(samples: tracks.1, to: systemURL) }
    deleteTemps()
    lastTemp = [mixURL, micURL, systemURL].compactMap { $0 }
    clearBuffers()
    CaptureLog.line("capture wav ready mix=\(mixURL.lastPathComponent)")
    return (mixURL, micURL, systemURL, duration, tracks.2)
  }

  private func clearSession() {
    withLock {
      noteActive = false
      recording = false
      paused = false
      state = "idle"
    }
  }

  private func clearBuffers() {
    withLock {
      micSamples.removeAll(keepingCapacity: true)
      systemSamples.removeAll(keepingCapacity: true)
      frozenMic.removeAll(keepingCapacity: false)
      frozenSystem.removeAll(keepingCapacity: false)
      frozen = false
      micEnd = nil
      systemEnd = nil
      micEndHost = 0
      systemEndHost = 0
      sessionHost = 0
      micCount = 0
      systemCount = 0
      droppedAudio = 0
    }
  }

  private func deleteTemps() {
    for url in lastTemp { try? FileManager.default.removeItem(at: url) }
    lastTemp = []
  }

  private func publish(_ device: AudioDeviceInfo?) {
    let name = device?.name ?? ""
    let bluetooth = device?.isBluetooth == true
    withLock {
      if bluetooth != inputBluetooth { headsetGain.reset() }
      inputBluetooth = bluetooth
      inputName = name
    }
    onDevice?(name, name.isEmpty)
  }

  private func startLevels() {
    stopLevels()
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInteractive))
    timer.schedule(deadline: .now(), repeating: .milliseconds(50))
    timer.setEventHandler { [weak self] in self?.emitLevels() }
    timer.resume()
    levelsTimer = timer
  }

  private func stopLevels() {
    levelsTimer?.cancel()
    levelsTimer = nil
  }

  private func emitLevels() {
    let snap = withLock { (state, paused, micLevel, systemLevel, micAt, systemAt) }
    if snap.0 == "paused" || snap.1 {
      onLevels?(0, 0)
      return
    }
    let now = Date()
    let micNow = now.timeIntervalSince(snap.4) < 0.15 ? snap.2 : 0
    let systemNow = now.timeIntervalSince(snap.5) < 0.15 ? snap.3 : 0
    onLevels?(micNow, systemNow)
    if now.timeIntervalSince(heartbeat) < 2 { return }
    heartbeat = now
    let counts = withLock { (micCount, systemCount, micSamples.count, systemSamples.count, noteActive, recording, state) }
    CaptureLog.line(
      "levels mic=\(String(format: "%.3f", micNow)) sys=\(String(format: "%.3f", systemNow)) micN=\(counts.0) sysN=\(counts.1) pcmMic=\(counts.2) pcmSys=\(counts.3) note=\(counts.4) rec=\(counts.5) state=\(counts.6)"
    )
  }

  private func sleep(_ nanoseconds: UInt64) async -> Bool {
    var left = nanoseconds
    while left > 0 {
      if withLock({ stopRequested }) { return false }
      let step = min(left, 100_000_000)
      try? await Task.sleep(nanoseconds: step)
      left -= step
    }
    return !withLock({ stopRequested })
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  private func logTrack(_ samples: [Int16], _ label: String) {
    let peak = samples.map { abs(Int32($0)) }.max() ?? 0
    var sum = 0.0
    for sample in samples {
      let value = Double(sample) / 32768
      sum += value * value
    }
    let rms = samples.isEmpty ? 0 : sqrt(sum / Double(samples.count))
    CaptureLog.line(
      "track \(label) samples=\(samples.count) sec=\(String(format: "%.2f", Double(samples.count) / Double(WavWriter.sampleRate))) peak=\(peak) rms=\(String(format: "%.4f", rms))"
    )
  }
}
